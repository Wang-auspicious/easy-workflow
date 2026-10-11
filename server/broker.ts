// Resource broker (Spec §6.3, §30.6): one set of global quotas shared by every line.
// Browser pages default to 8 and shrink with free memory (≈250MB per page above the
// floor), then grow back when memory recovers. The last model slot is kept for
// reviewers so production stations cannot starve review.
import os from "node:os";
import type { ResourceClass } from "../shared/types.ts";

export interface Lease { cls: ResourceClass; id: number; release: () => void }

const PRIORITY = { high: 0, mid: 1, low: 2 } as const;
export const PAGE_MB = 250;

export class Broker {
  limits: Record<string, number>;
  used: Record<string, number> = { browser: 0, model: 0, cpu: 0, http: 0 };
  memoryFloorMB: number;
  /** Model leases are refused while a quota/credential alert is open. */
  modelHold: string | null = null;
  private next = 1;
  onRelease: () => void = () => {};
  freeMem: () => number = () => Math.round(os.freemem() / 1048576);

  constructor(limits: Record<string, number>, memoryFloorMB = 1024) {
    this.limits = { ...limits };
    this.memoryFloorMB = memoryFloorMB;
  }

  freeMemMB() { return this.freeMem(); }

  /** Browser pages allowed right now: the configured cap, shrunk while memory is short. */
  effectiveBrowser() {
    const cap = this.limits.browser ?? 1;
    const spare = this.freeMemMB() - this.memoryFloorMB;
    if (spare <= 0) return Math.min(cap, this.used.browser ?? 0);
    return Math.max(1, Math.min(cap, (this.used.browser ?? 0) + Math.floor(spare / PAGE_MB)));
  }

  /** Why a lease cannot be granted right now, or null when it can. */
  blocked(cls: ResourceClass, opts: { review?: boolean } = {}): string | null {
    if (cls === "none") return null;
    if (cls === "model" && this.modelHold) return `模型暂停：${this.modelHold}`;
    const limit = cls === "browser" ? this.effectiveBrowser() : this.limits[cls] ?? 1;
    const used = this.used[cls] ?? 0;
    if (cls === "browser" && this.freeMemMB() < this.memoryFloorMB) return `空闲内存 ${this.freeMemMB()}MB < ${this.memoryFloorMB}MB`;
    if (used >= limit) return cls === "browser" && limit < (this.limits.browser ?? 1) ? `browser ${used}/${limit}（内存不足，上限暂降自 ${this.limits.browser}）` : `${cls} ${used}/${limit}`;
    if (cls === "model" && !opts.review && used >= limit - 1 && limit > 1) return `model ${used}/${limit}（最后一个位置留给审查）`;
    return null;
  }

  tryAcquire(cls: ResourceClass, opts: { review?: boolean } = {}): Lease | null {
    if (this.blocked(cls, opts)) return null;
    if (cls !== "none") this.used[cls] = (this.used[cls] ?? 0) + 1;
    const id = this.next++;
    let done = false;
    return {
      cls, id,
      release: () => {
        if (done) return;
        done = true;
        if (cls !== "none") this.used[cls] = Math.max(0, (this.used[cls] ?? 1) - 1);
        queueMicrotask(this.onRelease);
      },
    };
  }

  static order(p: keyof typeof PRIORITY) { return PRIORITY[p]; }

  sample() { return { used: { ...this.used }, limits: { ...this.limits, browserEffective: this.effectiveBrowser() }, freeMemMB: this.freeMemMB() }; }
}
