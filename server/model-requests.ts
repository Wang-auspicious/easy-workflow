import { AsyncLocalStorage } from 'node:async_hooks';
const admission = new AsyncLocalStorage<() => string | null>();
export const withModelAdmission = <T>(blocked: () => string | null, run: () => Promise<T>) => admission.run(blocked, run);
export function checkModelAdmission() {
  const reason = admission.getStore()?.();
  if (reason) throw new Error(`MODEL_CIRCUIT_OPEN: ${reason}`);
}

/** All model users, including program helpers and chat, share request capacity.
 * A station may retain its worker while doing tools; it must not retain an HTTP slot. */
export class ModelRequests {
  active = 0;
  private waiting: (() => void)[] = [];
  readonly limit: number;
  constructor(limit = 2) { this.limit = limit; }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active >= this.limit || this.waiting.length) await new Promise<void>((resolve, reject) => {
      const abort = () => { this.waiting = this.waiting.filter(w => w !== wake); reject(signal!.reason); };
      const wake = () => { signal?.removeEventListener('abort', abort); this.active++; resolve(); };
      this.waiting.push(wake);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    else this.active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true; this.active--;
      this.waiting.shift()?.();
    };
    if (signal?.aborted) { release(); signal.throwIfAborted(); }
    return release;
  }
  get queued() { return this.waiting.length; }
}
