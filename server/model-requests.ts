import { AsyncLocalStorage } from 'node:async_hooks';
import type {ModelDependency, ModelResponse} from '../shared/types.ts';
import type {Failure} from '../shared/failures.ts';

export type ModelAdmission = (dependency?: ModelDependency, request?: boolean) => string | null;
export type ModelAcquisition = (dependency?: ModelDependency, signal?: AbortSignal) => Promise<() => void>;
interface RequestWait {dependency?: ModelDependency; reason: string}
interface AdmissionScope {
  blocked: ModelAdmission;
  acquire?: ModelAcquisition;
  response?: (value: ModelResponse) => void;
  waiting: {current?: RequestWait};
}
const admission = new AsyncLocalStorage<AdmissionScope>();
const leasePools = new WeakMap<() => void, ModelRequests>();
const toolOwners = new AsyncLocalStorage<ReadonlyMap<ModelRequests, (failure: Failure) => void>>();

/** A CLI can keep its request open while it waits for one of our tools. */
export function withModelTool<T>(release: () => void, run: () => Promise<T>, rejected: (failure: Failure) => void): Promise<T> {
  const pool = leasePools.get(release);
  if (!pool) return run();
  return toolOwners.run(new Map([...(toolOwners.getStore() ?? []), [pool, rejected]]), run);
}

export function withModelAdmission<T>(blocked: ModelAdmission, run: () => Promise<T>, acquire?: ModelAcquisition,
  response?: (value: ModelResponse) => void): Promise<T> {
  return admission.run({blocked, acquire: acquire ?? admission.getStore()?.acquire,
    response: response ?? admission.getStore()?.response,
    waiting: {}}, run);
}

export function reportModelResponse(value: ModelResponse) {
  admission.getStore()?.response?.(value);
}

export function observeModelRequests<T>(observe: (dependency?: ModelDependency) => void, run: () => Promise<T>): Promise<T> {
  const owner = admission.getStore();
  return admission.run({blocked: (dependency, request) => {
    observe(dependency);
    return owner?.blocked(dependency, request) ?? null;
  }, acquire: owner?.acquire, response: owner?.response, waiting: owner?.waiting ?? {}}, run);
}

export function checkModelAdmission(dependency?: ModelDependency, request = false) {
  const scope = admission.getStore();
  const reason = scope?.blocked(dependency, request);
  if (reason) {
    if (request && scope) scope.waiting.current ??= {dependency, reason};
    throw Object.assign(new Error(`MODEL_CIRCUIT_OPEN: ${reason}`), {code: 'MODEL_CIRCUIT_OPEN', dependency});
  }
}

/** A tool may report its failure as data; preserve the host's denied request. */
export function modelRequestWait(): RequestWait | undefined {
  return admission.getStore()?.waiting.current;
}

export async function acquireModelRequest(dependency: ModelDependency | undefined, signal?: AbortSignal,
  fallback?: () => Promise<() => void>): Promise<() => void> {
  checkModelAdmission(dependency, true);
  const release = await (admission.getStore()?.acquire?.(dependency, signal) ?? fallback?.() ?? (() => {}));
  try { checkModelAdmission(dependency, true); }
  catch (error) { release(); throw error; }
  return release;
}

/** All model users, including program helpers and chat, share request capacity.
 * A station may retain its worker while doing tools; it must not retain an HTTP slot. */
export class ModelRequests {
  active = 0;
  private waiting: (() => void)[] = [];
  private readonly configuredLimit: number | (() => number);
  constructor(limit: number | (() => number) = 2) { this.configuredLimit = limit; }
  get limit() {
    return Math.max(1, typeof this.configuredLimit === 'function' ? this.configuredLimit() : this.configuredLimit);
  }

  /** Configuration can create capacity without completing an existing request. */
  notifyCapacityChanged() {
    while (this.active < this.limit && this.waiting.length) this.waiting.shift()!();
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if ((this.active >= this.limit || this.waiting.length) && toolOwners.getStore()?.has(this)) {
      const message = 'MODEL_CAPACITY_REENTRANT: 当前客户端占用模型名额并等待本工位工具；工具里的嵌套模型请求没有空位，已立即停止，不能扩大额度或互相等待。';
      const failure: Failure = {
        tag: 'tool_error', category: 'system', code: 'MODEL_CAPACITY_REENTRANT',
        message, retryable: false, owner: 'agent',
        nextAction: '将需要另一模型的程序操作拆为独立工位，或显式配置足够的模型请求容量；当前工位不会自动付费重试。',
      };
      toolOwners.getStore()!.get(this)!(failure);
      throw Object.assign(new Error(message), {code: 'MODEL_CAPACITY_REENTRANT', failure});
    }
    if (this.active >= this.limit || this.waiting.length) await new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.waiting = this.waiting.filter(waiter => waiter !== wake);
        reject(signal!.reason);
        this.notifyCapacityChanged();
      };
      const wake = () => { signal?.removeEventListener('abort', abort); this.active++; resolve(); };
      this.waiting.push(wake);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else this.notifyCapacityChanged();
    });
    else this.active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true; this.active--;
      this.notifyCapacityChanged();
    };
    if (signal?.aborted) { release(); signal.throwIfAborted(); }
    leasePools.set(release, this);
    return release;
  }
  get queued() { return this.waiting.length; }
}
