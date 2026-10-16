import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {Journal} from './journal.ts';
import type {Stamped} from '../shared/types.ts';
import {readExternalIntake} from './external-intake.ts';

type JsonObject = Record<string, unknown>;

export interface PublicationOutboxItem {
  readonly entryId: string;
  readonly sourceToken: string;
  readonly sourceEventSeq: number;
  readonly runId: string;
  readonly contentDigest: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly sourcePath: string;
  readonly recordPath: string;
  readonly acceptedAt: number;
}

export interface PublicationBatch {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly status: 'prepared';
  readonly remotePublished: false;
  readonly createdAt: number;
  readonly reason: 'size' | 'timeout' | 'manual';
  readonly items: readonly PublicationOutboxItem[];
  readonly manifestPath: string;
}

interface PendingToken {
  readonly item: string;
  readonly line: string;
  readonly source: string;
  readonly data: JsonObject;
}

interface BlockedPublication {
  readonly sourceToken: string;
  readonly sourceEventSeq: number;
  readonly runId: string;
  readonly at: number;
  readonly error: string;
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid publication outbox object');
  }
  return value as JsonObject;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function hash(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function atomicJson(file: string, value: unknown): void {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx');
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, {force: true});
  }
}

function parseItem(value: unknown): PublicationOutboxItem {
  const item = object(value);
  if (!text(item.entryId) || !text(item.sourceToken) ||
      !/^[a-f0-9]{64}$/.test(text(item.contentDigest)) ||
      !/^[a-f0-9]{64}$/.test(text(item.sha256)) ||
      !Number.isSafeInteger(item.sourceEventSeq) || !Number.isSafeInteger(item.bytes) ||
      typeof item.acceptedAt !== 'number' || !text(item.recordPath) || !text(item.sourcePath)) {
    throw new Error('Invalid publication outbox item');
  }
  return item as unknown as PublicationOutboxItem;
}

/** Durable local preparation only. A prepared batch is never a remote receipt. */
export class PublicationOutbox {
  private readonly projectDir: string;
  private readonly directory: string;
  private readonly recordsDir: string;
  private readonly indexPath: string;
  private readonly batchSize: number;
  private readonly maxWaitMs: number;
  private readonly tokens = new Map<string, PendingToken>();
  private readonly knownDigests = new Set<string>();
  private readonly batches: PublicationBatch[] = [];
  private readonly blocked = new Map<string, BlockedPublication>();
  private unsubscribe: () => void = () => {};
  private pending: PublicationOutboxItem[] = [];
  private cursor: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private issue: string | null = null;

  constructor(projectDir: string, journal: Journal,
      options: {readonly batchSize?: number; readonly maxWaitMs?: number} = {}) {
    this.projectDir = path.resolve(projectDir);
    this.directory = path.join(this.projectDir, 'work', 'publication-batches');
    this.recordsDir = path.join(this.directory, 'records');
    this.indexPath = path.join(this.directory, 'outbox.json');
    this.batchSize = options.batchSize ?? 5;
    this.maxWaitMs = options.maxWaitMs ?? 120_000;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 100 ||
        !Number.isSafeInteger(this.maxWaitMs) || this.maxWaitMs < 1) {
      throw new Error('Invalid publication batch limits');
    }
    // The first installation does not relabel historical publications as new work.
    this.cursor = journal.seq;
    try {
      this.restore(journal);
    } catch (error) {
      this.suspend(error);
    }
  }

  private restore(journal: Journal): void {
    fs.mkdirSync(this.recordsDir, {recursive: true});
    if (fs.existsSync(this.indexPath)) {
      const saved = object(JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as unknown);
      if (saved.schemaVersion !== 1 || !Number.isSafeInteger(saved.cursor) ||
          Number(saved.cursor) < 0 ||
          !Array.isArray(saved.pending) || !Array.isArray(saved.blocked)) {
        throw new Error('Invalid publication outbox checkpoint');
      }
      this.cursor = Number(saved.cursor);
      if (this.cursor > journal.seq) {
        throw new Error(`Publication checkpoint sequence ${this.cursor} exceeds journal sequence ${journal.seq}; retained files require reconciliation`);
      }
      this.pending = saved.pending.map(parseItem);
      for (const value of saved.blocked) {
        const failure = object(value);
        if (!text(failure.sourceToken) || !Number.isSafeInteger(failure.sourceEventSeq) ||
            typeof failure.at !== 'number' || !text(failure.error)) {
          throw new Error('Invalid blocked publication checkpoint');
        }
        this.blocked.set(text(failure.sourceToken), failure as unknown as BlockedPublication);
      }
    }
    for (const name of fs.readdirSync(this.directory).filter(name => /^batch-[a-f0-9]{32}\.json$/.test(name))) {
      const manifestPath = path.join(this.directory, name);
      const saved = object(JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown);
      if (saved.schemaVersion !== 1 || saved.status !== 'prepared' || saved.remotePublished !== false ||
          !Array.isArray(saved.items) || !saved.items.length) {
        throw new Error('Invalid prepared publication manifest');
      }
      const items = saved.items.map(parseItem);
      for (const item of items) this.verifySnapshot(item);
      this.batches.push({...saved, items, manifestPath} as unknown as PublicationBatch);
      for (const item of items) this.knownDigests.add(item.contentDigest);
    }
    // A crash after manifest rename but before index rename must not emit it twice.
    this.pending = this.pending.filter(item => !this.knownDigests.has(item.contentDigest));
    for (const item of this.pending) this.knownDigests.add(item.contentDigest);
    for (const event of journal.readKinds(['token.created', 'token.data', 'token.finished'])) this.observe(event);
    this.persist();
    this.unsubscribe = journal.subscribe(event => {
      try {
        this.observe(event);
        if (event.kind === 'token.finished' && event.status === 'published') {
          this.flushFullBatches();
          this.schedule();
        }
      } catch (error) {
        this.suspend(error);
      }
    });
    this.flushFullBatches();
    this.schedule();
  }

  status() {
    return {
      batchSize: this.batchSize, maxWaitMs: this.maxWaitMs, cursor: this.cursor,
      pending: this.pending.map(item => ({...item})),
      batches: this.batches.map(batch => ({...batch, items: batch.items.map(item => ({...item}))})),
      blocked: [...this.blocked.values()].map(failure => ({...failure})),
      suspended: this.issue !== null, issue: this.issue,
      remotePublished: false as const,
    };
  }

  /** Explicitly prepare the current remainder, without building, pushing or sending. */
  flush(): PublicationBatch | null {
    if (this.closed) throw new Error('Publication outbox is closed');
    if (this.issue) throw new Error(this.issue);
    for (const failure of [...this.blocked.values()]) {
      this.accept(failure.sourceToken, failure.sourceEventSeq, failure.runId, failure.at);
    }
    let latest: PublicationBatch | null = null;
    while (this.pending.length) latest = this.prepare('manual');
    this.persist();
    this.schedule();
    return latest;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.issue) this.persist();
  }

  /** Optional preparation must never take down the workflow or overwrite its evidence. */
  private suspend(error: unknown): void {
    this.issue = error instanceof Error ? error.message : 'Publication outbox recovery failed';
    this.unsubscribe();
    this.unsubscribe = () => {};
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    this.batches.length = 0;
    this.blocked.clear();
    this.knownDigests.clear();
  }

  private observe(event: Stamped): void {
    if (event.kind === 'token.created') {
      this.tokens.set(event.token, {item: event.item, line: event.line,
        source: event.source, data: {}});
    } else if (event.kind === 'token.data') {
      const token = this.tokens.get(event.token);
      if (token) {
        for (const key of ['key', 'host', 'gate', 'digest', 'importSource', 'externalResearch']) {
          if (key in event.patch) token.data[key] = event.patch[key];
        }
      }
    } else if (event.kind === 'token.finished' && event.status === 'published' && event.seq > this.cursor) {
      if (event.node === 'curation/published') {
        this.accept(event.token, event.seq, event.run, event.at);
      }
      this.cursor = event.seq;
      this.persist();
    }
  }

  private accept(sourceToken: string, sourceEventSeq: number, runId: string, at: number): void {
    try {
      const token = this.tokens.get(sourceToken);
      if (!token || !['candidates', 'curation'].includes(token.line) ||
          token.source.startsWith('channel:') || token.data.importSource) {
        this.blocked.delete(sourceToken);
        return;
      }
      const digest = text(token.data.digest);
      if (this.knownDigests.has(digest)) {
        this.blocked.delete(sourceToken);
        return;
      }
      if (token.data.gate !== 'pass' || !/^[a-f0-9]{64}$/.test(digest)) {
        throw new Error('Published event has no matching passed gate');
      }
      const key = text(token.data.key) || text(token.data.host);
      if (!key) throw new Error('Published event has no local record identity');
      const sourcePath = path.join(this.projectDir, 'published', `${key.replace(/[\\/:*?"<>|]+/g, '~')}.json`);
      const bytes = fs.readFileSync(sourcePath);
      const record = object(JSON.parse(bytes.toString('utf8')) as unknown);
      const h2 = object(record.h2);
      const entryId = text(record.entryId);
      if (!entryId || record.status !== 'APPROVED' || h2.token !== sourceToken || h2.digest !== digest) {
        throw new Error('Published record is not bound to its source gate');
      }
      const {digest: ignoredDigest, publishedAt: ignoredTime, ...reviewedH2} = h2;
      const reviewedDigest = hash(JSON.stringify({...record,
        official: {...object(record.official), checkedAt: ''},
        classification: {...object(record.classification), confirmedAt: ''},
        editorialVoice: null, h2: reviewedH2}));
      if (reviewedDigest !== digest) throw new Error('Published record changed after gate approval');
      const external = readExternalIntake(this.projectDir);
      const research = token.data.externalResearch;
      const externalEntryId = research && typeof research === 'object' && !Array.isArray(research) ?
        text((research as JsonObject).entryId) : '';
      if (external?.candidates.some(candidate => candidate.disposition === 'published' &&
          [entryId, token.item, externalEntryId].includes(candidate.entryId))) {
        this.blocked.delete(sourceToken);
        return;
      }
      const sha256 = hash(bytes);
      const recordPath = path.join(this.recordsDir, `${sha256}.json`);
      try {
        fs.writeFileSync(recordPath, bytes, {flag: 'wx'});
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || hash(fs.readFileSync(recordPath)) !== sha256) {
          throw error;
        }
      }
      this.pending.push({entryId, sourceToken, sourceEventSeq, runId, contentDigest: digest,
        sha256, bytes: bytes.length, sourcePath, recordPath, acceptedAt: at});
      this.knownDigests.add(digest);
      this.blocked.delete(sourceToken);
    } catch (error) {
      this.blocked.set(sourceToken, {sourceToken, sourceEventSeq, runId, at,
        error: error instanceof Error ? error.message : 'Publication preparation failed'});
    }
  }

  private flushFullBatches(): void {
    while (this.pending.length >= this.batchSize) this.prepare('size');
  }

  private prepare(reason: PublicationBatch['reason']): PublicationBatch | null {
    const proposed = this.pending.slice(0, this.batchSize);
    const items = proposed.filter(item => {
      try {
        this.verifySnapshot(item);
        return true;
      } catch (error) {
        this.knownDigests.delete(item.contentDigest);
        this.blocked.set(item.sourceToken, {sourceToken: item.sourceToken,
          sourceEventSeq: item.sourceEventSeq, runId: item.runId, at: item.acceptedAt,
          error: error instanceof Error ? error.message : 'Publication snapshot unavailable'});
        return false;
      }
    });
    if (!items.length) {
      this.pending = this.pending.slice(proposed.length);
      this.persist();
      return null;
    }
    const id = `batch-${hash(JSON.stringify(items.map(item => [item.entryId, item.contentDigest]))).slice(0, 32)}`;
    const manifestPath = path.join(this.directory, `${id}.json`);
    const batch: PublicationBatch = {schemaVersion: 1, id, status: 'prepared',
      remotePublished: false, createdAt: Date.now(), reason, items, manifestPath};
    atomicJson(manifestPath, batch);
    this.batches.push(batch);
    this.pending = this.pending.slice(proposed.length);
    this.persist();
    return batch;
  }

  private verifySnapshot(item: PublicationOutboxItem): void {
    const resolved = fs.realpathSync(item.recordPath);
    if (path.dirname(resolved) !== fs.realpathSync(this.recordsDir) ||
        path.basename(resolved) !== `${item.sha256}.json`) {
      throw new Error('Publication snapshot is outside its immutable record store');
    }
    const bytes = fs.readFileSync(resolved);
    if (bytes.length !== item.bytes || hash(bytes) !== item.sha256) {
      throw new Error('Publication snapshot integrity failure');
    }
  }

  private persist(): void {
    atomicJson(this.indexPath, {schemaVersion: 1, cursor: this.cursor,
      pending: this.pending, blocked: [...this.blocked.values()]});
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || this.issue || !this.pending.length) return;
    const delay = Math.max(1, this.pending[0].acceptedAt + this.maxWaitMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        if (!this.closed && this.pending.length) this.prepare('timeout');
        this.schedule();
      } catch (error) {
        this.suspend(error);
      }
    }, delay);
    this.timer.unref();
  }
}
