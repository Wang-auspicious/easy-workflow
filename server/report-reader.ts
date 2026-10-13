import {Worker} from 'node:worker_threads';
import type {Factory} from './factory.ts';

interface ReportJson {
  body: Buffer;
  seq: number;
}

interface Waiter {
  resolve: (result: ReportJson) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}

interface Job {
  key: string;
  runId: string;
  through: number;
  waiters: Set<Waiter>;
  worker?: Worker;
  timer?: ReturnType<typeof setTimeout>;
  done: boolean;
}

interface CachedReport {
  value: ReportJson;
  at: number;
  ended: boolean;
}

interface WorkerReply {
  body?: ArrayBuffer;
  seq?: number;
  status?: string;
  error?: string;
}

const LIVE_CACHE_MS = 10_000;
const WORKER_TIMEOUT_MS = 30_000;
const MAX_CACHED_REPORTS = 3;

class ReportReader {
  private readonly factory: Factory;
  private readonly jobs = new Map<string, Job>();
  private readonly cache = new Map<string, CachedReport>();
  private active?: Job;
  private closed = false;

  constructor(factory: Factory) {
    this.factory = factory;
  }

  read(runId: string, signal?: AbortSignal, minimumSeq?: number): Promise<ReportJson> {
    signal?.throwIfAborted();
    if (this.closed) {
      return Promise.reject(new Error('Report reader closed'));
    }
    const key = `${this.factory.compiled.digest}:${runId}`;
    const cached = this.cache.get(key);
    const freshEnough = cached && (
      cached.ended || cached.value.seq === this.factory.journal.seq ||
      Date.now() - cached.at < LIVE_CACHE_MS);
    if (cached && freshEnough && (minimumSeq === undefined || cached.value.seq >= minimumSeq)) {
      return Promise.resolve(cached.value);
    }

    let job = this.jobs.get(key);
    // Run completion must wait for a snapshot including the final durable event.
    if (job && minimumSeq !== undefined && job.through < minimumSeq) {
      return this.wait(job, signal).then(() => this.read(runId, signal, minimumSeq));
    }
    if (!job) {
      job = {key, runId, through: this.factory.journal.seq, waiters: new Set(), done: false};
      this.jobs.set(key, job);
    }
    return this.wait(job, signal);
  }

  private wait(target: Job, signal?: AbortSignal): Promise<ReportJson> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        target.waiters.delete(waiter);
        waiter.cleanup();
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        if (!target.waiters.size) {
          this.finish(target);
        }
      };
      const waiter: Waiter = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', abort),
      };
      target.waiters.add(waiter);
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) {
        abort();
      } else {
        this.pump();
      }
    });
  }

  private pump(): void {
    if (this.closed || this.active) return;
    const job = [...this.jobs.values()].find(candidate => !candidate.done && candidate.waiters.size);
    if (!job) return;
    this.active = job;
    try {
      const worker = new Worker(new URL('./report-worker.ts', import.meta.url), {
        workerData: {
          projectDir: this.factory.project?.dir ?? process.env.FACTORY_VAR,
          compiled: this.factory.compiled,
          runId: job.runId,
          through: job.through,
        },
        execArgv: [],
      });
      job.worker = worker;
      job.timer = setTimeout(() => {
        this.finish(job, new Error('报告读取超过30秒，请重试；流水线仍在运行'));
      }, WORKER_TIMEOUT_MS);
      job.timer.unref();
      worker.once('message', (message: WorkerReply) => {
        if (job.done) return;
        if (message.error || !message.body) {
          this.finish(job, new Error(message.error ?? 'Report worker returned no data'));
          return;
        }
        const value = {body: Buffer.from(message.body), seq: message.seq ?? job.through};
        this.cache.delete(job.key);
        this.cache.set(job.key, {value, at: Date.now(), ended: message.status === 'ended'});
        while (this.cache.size > MAX_CACHED_REPORTS) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) this.cache.delete(oldest);
        }
        this.finish(job, undefined, value);
      });
      worker.once('error', error => this.finish(job, error));
      worker.once('exit', code => {
        if (!job.done) {
          this.finish(job, new Error(`Report worker exited before completion (${code})`));
        }
      });
    } catch (error) {
      this.finish(job, error);
    }
  }

  private finish(job: Job, error?: unknown, value?: ReportJson): void {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    this.jobs.delete(job.key);
    if (job.worker) void job.worker.terminate();
    if (this.active === job) this.active = undefined;
    for (const waiter of job.waiters) {
      waiter.cleanup();
      if (value) {
        waiter.resolve(value);
      } else {
        waiter.reject(error ?? new DOMException('Aborted', 'AbortError'));
      }
    }
    job.waiters.clear();
    queueMicrotask(() => this.pump());
  }

  close(): void {
    this.closed = true;
    for (const job of [...this.jobs.values()]) {
      this.finish(job, new Error('Report reader closed'));
    }
    this.cache.clear();
  }
}

const readers = new WeakMap<Factory, ReportReader>();
const allReaders = new Set<ReportReader>();

export function readReportJson(
    factory: Factory, runId: string, signal?: AbortSignal,
    minimumSeq?: number): Promise<ReportJson> {
  let reader = readers.get(factory);
  if (!reader) {
    reader = new ReportReader(factory);
    readers.set(factory, reader);
    allReaders.add(reader);
  }
  return reader.read(runId, signal, minimumSeq);
}

export function closeReportReaders(): void {
  for (const reader of allReaders) reader.close();
  allReaders.clear();
}
