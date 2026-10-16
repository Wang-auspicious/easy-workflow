// Resource broker (Spec §6.3, §30.6): one set of global quotas shared by every line.
// Browser pages shrink with physical RAM and system commit headroom. Verified
// commit permits one controlled page below the ordinary RAM floor, but cannot
// bypass the physical emergency floor. Model workers hold lifecycle
// leases; ModelRequests independently limits actual calls. The last model worker
// is kept for reviewers so production stations cannot starve review.
import os from 'node:os';
import type {ModelCircuit, ModelDependency, ResourceClass} from '../shared/types.ts';
import {ModelRequests} from './model-requests.ts';
import {MEMORY_MAX_AGE_MS, physicalMemorySnapshot, readSystemMemory, refreshSystemMemory,
  type MemorySnapshot} from './memory.ts';

export interface Lease { cls: ResourceClass; id: number; release: () => void }

const PRIORITY = { high: 0, mid: 1, low: 2 } as const;
export const PAGE_MB = 250;
export const PAGE_COMMIT_MB = 512;
export const COMMIT_RESERVE_MB = 1024;
export const PHYSICAL_EMERGENCY_MB = 512;

export class Broker {
  limits: Record<string, number>;
  used: Record<string, number> = { browser: 0, model: 0, cpu: 0, http: 0 };
  memoryFloorMB: number;
  /** Model leases are refused while a quota/credential alert is open. */
  modelHold: string | null = null;
  /** A recovering provider gets one real task before normal scheduling resumes. */
  recoveryToken: string | null = null;
  modelCircuits: Record<string, ModelCircuit> = {};
  readonly modelRequests: ModelRequests;
  private next = 1;
  private waiters = new Set<() => void>();
  onRelease: () => void = () => {};
  private readonly systemFreeMem = () => Math.round(os.freemem() / 1048576);
  freeMem: () => number = this.systemFreeMem;
  memorySnapshot: () => MemorySnapshot = () => this.freeMem === this.systemFreeMem ?
    readSystemMemory() : {...physicalMemorySnapshot(), physicalAvailableMB: this.freeMem()};

  constructor(limits: Record<string, number>, memoryFloorMB = 1024) {
    this.limits = { ...limits };
    this.memoryFloorMB = memoryFloorMB;
    this.modelRequests = new ModelRequests(() => this.limits.model ?? 1);
  }

  freeMemMB() { return this.memorySnapshot().physicalAvailableMB; }

  async refreshMemory(): Promise<void> {
    if (this.freeMem === this.systemFreeMem) await refreshSystemMemory();
  }

  memoryStatus() {
    const memory = this.memorySnapshot();
    const used = this.used.browser ?? 0;
    const cap = Math.max(0, this.limits.browser ?? 1);
    const physicalFloorMB = Math.max(0, this.memoryFloorMB);
    const emergencyFloorMB = PHYSICAL_EMERGENCY_MB;
    const commitKnown = memory.commitAvailableMB !== null && memory.commitLimitMB !== null &&
      Date.now() - memory.checkedAt <= MEMORY_MAX_AGE_MS;
    const commitAvailableMB = commitKnown ? memory.commitAvailableMB! : null;
    let browserCapacity = cap;
    let reason: string | null = null;
    let mode: 'normal' | 'pressure' | 'blocked' = 'normal';
    if (memory.physicalAvailableMB < emergencyFloorMB) {
      browserCapacity = Math.min(cap, used);
      mode = 'blocked';
      reason = `物理可用内存 ${memory.physicalAvailableMB}MB < 紧急底线 ${emergencyFloorMB}MB`;
    } else if (commitKnown && commitAvailableMB! < COMMIT_RESERVE_MB + PAGE_COMMIT_MB) {
      browserCapacity = Math.min(cap, used);
      mode = 'blocked';
      reason = `系统提交余量 ${commitAvailableMB}MB < ${COMMIT_RESERVE_MB + PAGE_COMMIT_MB}MB`;
    } else if (memory.physicalAvailableMB < physicalFloorMB) {
      if (commitKnown) {
        browserCapacity = Math.min(cap, 1);
        mode = 'pressure';
      } else {
        browserCapacity = Math.min(cap, used);
        mode = 'blocked';
        reason = `空闲内存 ${memory.physicalAvailableMB}MB < ${physicalFloorMB}MB（物理 RAM），系统提交余量尚未验证`;
      }
    } else {
      const sparePhysicalMB = memory.physicalAvailableMB - physicalFloorMB;
      const physicalPages = Math.floor(Math.max(0, sparePhysicalMB) / PAGE_MB);
      browserCapacity = Math.min(cap, sparePhysicalMB > 0 ? Math.max(1, used + physicalPages) : used);
      if (commitKnown) {
        const commitPages = Math.floor((commitAvailableMB! - COMMIT_RESERVE_MB) / PAGE_COMMIT_MB);
        browserCapacity = Math.min(browserCapacity, used + commitPages);
      }
      if (browserCapacity <= used && cap > used) {
        reason = `内存不足，物理可用 ${memory.physicalAvailableMB}MB 尚不足再分配一页`;
      }
    }
    return {...memory, commitAvailableMB, commitLimitMB: commitKnown ? memory.commitLimitMB : null,
      browserCapacity, mode, reason, physicalFloorMB, emergencyFloorMB,
      commitReserveMB: COMMIT_RESERVE_MB, pageCommitMB: PAGE_COMMIT_MB};
  }

  /** Browser pages allowed right now: the configured cap, shrunk while memory is short. */
  effectiveBrowser() {
    return this.memoryStatus().browserCapacity;
  }

  /** Capacity for station lifecycles, distinct from concurrent model requests. */
  capacity(resource: ResourceClass): number {
    if (resource === 'none') return Infinity;
    if (resource === 'browser') return this.effectiveBrowser();
    if (resource === 'model') return this.limits.modelWorkers ?? this.limits.model ?? 1;
    return this.limits[resource] ?? 1;
  }

  /** Why a lease cannot be granted right now, or null when it can. */
  modelBlocked(dependency?: ModelDependency, token?: string): string | null {
    if (this.modelHold) return `模型暂停：${this.modelHold}`;
    if (this.recoveryToken && token !== this.recoveryToken) return '正在用一个工位验证未归属的模型故障';
    const circuit = dependency ? this.modelCircuits[dependency.key] : Object.values(this.modelCircuits)[0];
    if (!circuit) return null;
    if (dependency && circuit.state === 'trial' && circuit.trialToken === token) return null;
    return `${circuit.dependency.adapter} ${circuit.dependency.model} 暂停：${circuit.reason}`;
  }

  blocked(cls: ResourceClass, opts: {review?: boolean; dependency?: ModelDependency; token?: string} = {}): string | null {
    if (cls === "none") return null;
    if (cls === 'model') {
      const reason = this.modelBlocked(opts.dependency, opts.token);
      if (reason) return reason;
    }
    const limit = this.capacity(cls);
    const used = this.used[cls] ?? 0;
    if (cls === 'browser') {
      const memory = this.memoryStatus();
      if (memory.reason && memory.browserCapacity <= used) return memory.reason;
    }
    if (used >= limit) return cls === "browser" && limit < (this.limits.browser ?? 1) ? `browser ${used}/${limit}（内存不足，上限暂降自 ${this.limits.browser}）` : `${cls} ${used}/${limit}`;
    if (cls === "model" && !opts.review && used >= limit - 1 && limit > 1) return `model ${used}/${limit}（最后一个位置留给审查）`;
    return null;
  }

  tryAcquire(cls: ResourceClass, opts: {review?: boolean; dependency?: ModelDependency; token?: string} = {}): Lease | null {
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
        // Existing callers waiting for capacity get the released slot before the
        // scheduler admits more work. Each waiter still checks the live limit.
        for (const wake of this.waiters) wake();
        queueMicrotask(this.onRelease);
      },
    };
  }

  /** Wait for capacity without conflating resource saturation with a site error.
   * Null means this bounded wait expired; cancellation rejects immediately. The
   * timer also observes memory recovery, which need not release an existing lease. */
  async acquire(cls: ResourceClass, opts: {review?: boolean; dependency?: ModelDependency; token?: string; signal?: AbortSignal; timeoutMs?: number} = {}): Promise<Lease | null> {
    opts.signal?.throwIfAborted();
    if (cls === 'browser') void this.refreshMemory();
    const immediate = this.tryAcquire(cls, opts);
    if (immediate) return immediate;
    const timeout = opts.timeoutMs ?? 20000;
    if (timeout <= 0) return null;
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      let timer: ReturnType<typeof setTimeout> | undefined, done = false;
      const finish = (lease: Lease | null, error?: unknown) => {
        if (done) return;
        done = true; clearTimeout(timer); this.waiters.delete(check);
        opts.signal?.removeEventListener("abort", aborted);
        error === undefined ? resolve(lease) : reject(error);
      };
      const aborted = () => finish(null, opts.signal!.reason);
      const check = () => {
        if (done) return;
        clearTimeout(timer);
        if (opts.signal?.aborted) { aborted(); return; }
        const remaining = deadline - Date.now();
        if (remaining <= 0) { finish(null); return; }
        const lease = this.tryAcquire(cls, opts);
        if (lease) { finish(lease); return; }
        timer = setTimeout(check, Math.min(250, remaining));
      };
      this.waiters.add(check); opts.signal?.addEventListener("abort", aborted, { once: true });
      check();
    });
  }

  static order(p: keyof typeof PRIORITY) { return PRIORITY[p]; }

  sample() { return { used: { ...this.used }, limits: { ...this.limits, browserEffective: this.effectiveBrowser(), modelWorkers: this.capacity('model') }, freeMemMB: this.freeMemMB(), memory: this.memoryStatus(),
    modelRequests: {active: this.modelRequests.active, queued: this.modelRequests.queued, limit: this.modelRequests.limit} }; }
}
