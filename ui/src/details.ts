import {useCallback, useSyncExternalStore} from 'react';
import type {AttemptState} from '../../shared/project.ts';
import type {EvidenceRef, Stamped} from '../../shared/types.ts';
import {isUiState} from '../../shared/client-view.ts';
import {getState, onEvent, subscribe, useStore} from './store.ts';

export interface DetailTarget {
  readonly kind: 'attempt' | 'token' | 'evidence';
  readonly id: string;
}

export interface TokenDetail {
  readonly id: string;
  readonly data: Record<string, unknown>;
  readonly attempts: AttemptState[];
  readonly evidence: EvidenceRef[];
}

interface DetailReceipt {
  readonly seq: number;
  readonly result: unknown;
  readonly bytes: number;
}

export interface DetailSnapshot<T = unknown> {
  readonly data?: T;
  readonly seq?: number;
  readonly loading: boolean;
  readonly error?: string;
}

interface CacheEntry {
  readonly target: DetailTarget;
  readonly listeners: Set<() => void>;
  minimumSeq: number;
  snapshot: DetailSnapshot;
  bytes: number;
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

type DetailReader = (target: DetailTarget, signal: AbortSignal) => Promise<DetailReceipt>;
const EMPTY: DetailSnapshot = Object.freeze({loading: false});
const keyOf = (target: DetailTarget) => `${target.kind}:${target.id}`;

/** Full records stay outside the projection. The budget measures serialized bytes. */
export class DetailCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly read: DetailReader;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(read: DetailReader, maxEntries = 24, maxBytes = 16 * 1024 * 1024) {
    this.read = read;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  snapshot(target: DetailTarget): DetailSnapshot {
    return this.entries.get(keyOf(target))?.snapshot ?? EMPTY;
  }

  watch(target: DetailTarget, minimumSeq: number, listener: () => void) {
    const key = keyOf(target);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {target, minimumSeq, snapshot: EMPTY, bytes: 0, listeners: new Set()};
      this.entries.set(key, entry);
    } else {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    entry.listeners.add(listener);
    if (entry.snapshot.seq === undefined || entry.snapshot.seq < entry.minimumSeq) {
      this.load(entry);
    }
    this.trim();
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size) {
        entry.controller?.abort();
        entry.controller = undefined;
        clearTimeout(entry.timer);
        entry.timer = undefined;
        entry.snapshot = {...entry.snapshot, loading: false};
        if (!entry.snapshot.data && this.entries.get(key) === entry) this.entries.delete(key);
      }
    };
  }

  invalidate(target: DetailTarget, seq: number) {
    const entry = this.entries.get(keyOf(target));
    if (!entry || seq <= (entry.snapshot.seq ?? -1) || seq <= entry.minimumSeq) return;
    entry.minimumSeq = seq;
    if (entry.listeners.size) {
      this.publish(entry, {...entry.snapshot, loading: true, error: undefined});
      this.schedule(entry);
    }
  }

  retry(target: DetailTarget) {
    const entry = this.entries.get(keyOf(target));
    if (entry) this.load(entry);
  }

  clear() {
    const previous = [...this.entries.values()];
    this.entries.clear();
    for (const entry of previous) {
      entry.controller?.abort();
      clearTimeout(entry.timer);
      for (const listener of entry.listeners) listener();
    }
  }

  private publish(entry: CacheEntry, snapshot: DetailSnapshot) {
    entry.snapshot = snapshot;
    for (const listener of entry.listeners) listener();
  }

  private schedule(entry: CacheEntry) {
    if (entry.timer || entry.controller || !entry.listeners.size) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      this.load(entry);
    }, 200);
  }

  private load(entry: CacheEntry) {
    if (entry.controller || !entry.listeners.size) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const controller = new AbortController();
    entry.controller = controller;
    this.publish(entry, {...entry.snapshot, loading: true, error: undefined});
    void this.read(entry.target, controller.signal).then(receipt => {
      if (controller.signal.aborted || entry.controller !== controller || this.entries.get(keyOf(entry.target)) !== entry) return;
      entry.controller = undefined;
      if (receipt.seq < entry.minimumSeq) {
        this.schedule(entry);
        return;
      }
      if (receipt.bytes > this.maxBytes) throw new Error('详情超过缓存上限，请通过日志读取原始记录。');
      this.trim(receipt.bytes - entry.bytes, entry);
      const retained = [...this.entries.values()].filter(value => value !== entry && value.snapshot.data !== undefined).length;
      if (retained >= this.maxEntries) throw new Error('已打开的详情数量达到上限，请关闭其他详情后重试。');
      const occupied = [...this.entries.values()].reduce((sum, value) => sum + value.bytes, 0);
      if (occupied - entry.bytes + receipt.bytes > this.maxBytes) {
        throw new Error('已打开的详情超过缓存上限，请关闭其他详情后重试。');
      }
      entry.bytes = receipt.bytes;
      this.publish(entry, {data: receipt.result, seq: receipt.seq, loading: false});
      this.trim();
    }).catch(error => {
      if (controller.signal.aborted || this.entries.get(keyOf(entry.target)) !== entry) return;
      entry.controller = undefined;
      this.publish(entry, {...entry.snapshot, loading: false,
        error: error instanceof Error ? error.message : '详情读取失败'});
    });
  }

  private trim(additionalBytes = 0, protectedEntry?: CacheEntry) {
    let bytes = additionalBytes + [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && bytes <= this.maxBytes) break;
      if (entry.listeners.size || entry === protectedEntry) continue;
      entry.controller?.abort();
      clearTimeout(entry.timer);
      this.entries.delete(key);
      bytes -= entry.bytes;
    }
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

async function readDetail(target: DetailTarget, signal: AbortSignal): Promise<DetailReceipt> {
  const response = await fetch('/api/tools/inspect', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({[target.kind]: target.id}),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  const maximumBytes = 16 * 1024 * 1024;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('详情响应没有正文，请重试。');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new Error('详情超过显示上限，请通过日志读取原始记录。');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const decoder = new TextDecoder();
  const text = chunks.map(chunk => decoder.decode(chunk, {stream: true})).join('') + decoder.decode();
  const body: unknown = JSON.parse(text);
  if (!object(body) || !response.ok || body.ok !== true) {
    throw new Error(object(body) && typeof body.error === 'string' ? body.error : `详情读取失败（HTTP ${response.status}）`);
  }
  const result = body.result;
  if (!Number.isSafeInteger(body.seq) || (body.seq as number) < 0 || !object(result) || result.id !== target.id ||
      target.kind === 'attempt' && !Array.isArray(result.steps) ||
      target.kind === 'token' && (!object(result.data) || !Array.isArray(result.attempts) || !Array.isArray(result.evidence))) {
    throw new Error('详情回执不完整，请重新读取。');
  }
  return {seq: body.seq as number, result, bytes};
}

const details = new DetailCache(readDetail);
let projection = getState().fs;
subscribe(() => {
  if (projection !== getState().fs) {
    projection = getState().fs;
    details.clear();
  }
});

function invalidateDetail(event: Stamped) {
  if ('token' in event && typeof event.token === 'string') {
    details.invalidate({kind: 'token', id: event.token}, event.seq);
  }
  if ('attempt' in event && typeof event.attempt === 'string') {
    details.invalidate({kind: 'attempt', id: event.attempt}, event.seq);
    const token = getState().fs.attempts[event.attempt]?.token;
    if (token) details.invalidate({kind: 'token', id: token}, event.seq);
  }
  if (event.kind === 'evidence.added') {
    details.invalidate({kind: 'evidence', id: event.evidence.id}, event.seq);
    details.invalidate({kind: 'token', id: event.evidence.token}, event.seq);
  }
}
onEvent(invalidateDetail);

export function useDetail<T>(target: DetailTarget, local: T | undefined, enabled = true) {
  const summarized = useStore(state => isUiState(state.fs) && !state.replay);
  const currentProjection = useStore(state => state.fs);
  const remote = summarized && enabled;
  const watch = useCallback((listener: () => void) => remote
    ? details.watch(target, getState().fs.seq, listener) : () => {},
  [target.kind, target.id, remote, currentProjection]);
  const snapshot = useCallback(() => remote ? details.snapshot(target) : EMPTY,
    [target.kind, target.id, remote]);
  const value = useSyncExternalStore(watch, snapshot) as DetailSnapshot<T>;
  return {
    ...value,
    data: remote ? value.data : local,
    loading: remote && (value.loading || !value.data && !value.error),
    retry: () => details.retry(target),
  };
}
