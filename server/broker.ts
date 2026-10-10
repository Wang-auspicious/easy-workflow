// Resource broker (Spec §6.3): one set of global quotas shared by every line, so two or
// three lines running together never open more than three browser pages. Leases are
// handed out by line priority; the last model slot is kept for reviewers so production
// stations cannot starve review; browser leases stop while free memory is low.
import os from "node:os";
import type { ResourceClass } from "../shared/types.ts";

export interface Lease { cls: ResourceClass; id: number; release: () => void }

const PRIORITY = { high: 0, mid: 1, low: 2 } as const;

export class Broker {
  limits: Record<string, number>;
  used: Record<string, number> = { browser: 0, model: 0, cpu: 0, http: 0 };
  memoryFloorMB: number;
  private next = 1;
  onRelease: () => void = () => {};

  constructor(limits: Record<string, number>, memoryFloorMB = 1024) {
    this.limits = { ...limits };
    this.memoryFloorMB = memoryFloorMB;
  }

  freeMemMB() { return Math.round(os.freemem() / 1048576); }

  /** Why a lease cannot be granted right now, or null when it can. */
  blocked(cls: ResourceClass, opts: { review?: boolean } = {}): string | null {
    if (cls === "none") return null;
    const limit = this.limits[cls] ?? 1;
    const used = this.used[cls] ?? 0;
    if (used >= limit) return `${cls} ${used}/${limit}`;
    if (cls === "model" && !opts.review && used >= limit - 1 && limit > 1) return `model ${used}/${limit}（最后一个位置留给审查）`;
    if (cls === "browser" && this.freeMemMB() < this.memoryFloorMB) return `空闲内存 ${this.freeMemMB()}MB < ${this.memoryFloorMB}MB`;
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

  sample() { return { used: { ...this.used }, limits: { ...this.limits }, freeMemMB: this.freeMemMB() }; }
}
