import {deserializeSnapshot, serializeSnapshot} from '../../shared/project.ts';
import type {Journal} from '../journal.ts';
import {validateItem, type ItemState, type ItemStatus} from './item.ts';

export type AttemptStatus = 'running' | 'ok' | 'failed' | 'interrupted' | 'handoff' | 'cancelled';
export interface AttemptRecord {
  id: string;
  item: string;
  node: string;
  startedAt: number;
  endedAt?: number;
  status: AttemptStatus;
  body: Record<string, unknown>;
}

interface ItemRow {body: string; admitted_at: number | null}
interface AttemptRow {
  id: string; item: string; node: string; started_at: number; ended_at: number | null;
  status: AttemptStatus; body: string;
}

/** The same SQLite connection makes rows and their UI events one transaction. */
export class KernelStore {
  private readonly journal: Journal;
  private readonly hasItems: boolean;
  private readonly hasAttempts: boolean;

  constructor(journal: Journal) {
    this.journal = journal;
    if (!journal.readOnly) journal.database.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, run TEXT NOT NULL, line TEXT NOT NULL, status TEXT NOT NULL,
        admitted_at INTEGER, updated_at INTEGER NOT NULL, body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS items_status ON items(status, admitted_at);
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, item TEXT NOT NULL, node TEXT NOT NULL, started_at INTEGER NOT NULL,
        ended_at INTEGER, status TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attempts_node ON attempts(node, ended_at);
    `);
    const exists = journal.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
    this.hasItems = Boolean(exists.get('items'));
    this.hasAttempts = Boolean(exists.get('attempts'));
  }

  private assertTransaction(): void {
    if (this.journal.readOnly) throw new Error('Kernel storage is read-only');
    if (!this.journal.inTransaction) throw new Error('Kernel changes require Journal.atomic');
  }

  get(id: string): ItemState | undefined {
    if (!this.hasItems) return undefined;
    const row = this.journal.database.prepare('SELECT body FROM items WHERE id = ?').get(id) as ItemRow | undefined;
    return row ? validateItem(deserializeSnapshot(row.body)) : undefined;
  }

  list(statuses?: ItemStatus[]): ItemState[] {
    if (!this.hasItems || statuses?.length === 0) return [];
    const rows = (statuses
      ? this.journal.database.prepare(`SELECT body FROM items WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY rowid`).all(...statuses)
      : this.journal.database.prepare('SELECT body FROM items ORDER BY rowid').all()) as unknown as ItemRow[];
    // SQLite preserves rowid on our upserts; stable sorting keeps that original
    // insertion order when millisecond creation timestamps are equal.
    return rows.map(row => validateItem(deserializeSnapshot(row.body)))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  admittedAt(id: string): number | undefined {
    if (!this.hasItems) return undefined;
    const row = this.journal.database.prepare('SELECT admitted_at FROM items WHERE id = ?').get(id) as ItemRow | undefined;
    return row?.admitted_at ?? undefined;
  }

  save(item: ItemState, admittedAt?: number): void {
    this.assertTransaction();
    validateItem(item);
    if (admittedAt !== undefined && (!Number.isSafeInteger(admittedAt) || admittedAt < 0)) throw new TypeError('Invalid admission timestamp');
    const admission = admittedAt ?? this.admittedAt(item.id) ?? (item.status === 'active' ? item.updatedAt : null);
    this.journal.database.prepare(`INSERT INTO items (id, run, line, status, admitted_at, updated_at, body)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET run = excluded.run, line = excluded.line, status = excluded.status,
        admitted_at = excluded.admitted_at, updated_at = excluded.updated_at, body = excluded.body`
    ).run(item.id, item.run, item.line, item.status, admission, item.updatedAt, serializeSnapshot(item));
  }

  /** A real progress receipt updates only the fixed item envelope. Nested
   * snapshot encodings remain untouched, and both timestamp copies agree. */
  touch(id: string, at: number): void {
    this.assertTransaction();
    if (!Number.isSafeInteger(at) || at < 0) throw new TypeError('Invalid item progress timestamp');
    this.journal.database.prepare(`UPDATE items SET updated_at = MAX(updated_at, ?),
      body = json_set(body, '$.updatedAt', MAX(updated_at, ?)) WHERE id = ?`).run(at, at, id);
  }

  saveAttempt(attempt: AttemptRecord): void {
    this.assertTransaction();
    if (![attempt.id, attempt.item, attempt.node].every(value => typeof value === 'string' && value.length > 0) ||
        !Number.isSafeInteger(attempt.startedAt) || attempt.startedAt < 0 ||
        attempt.endedAt !== undefined && (!Number.isSafeInteger(attempt.endedAt) || attempt.endedAt < attempt.startedAt) ||
        !['running', 'ok', 'failed', 'interrupted', 'handoff', 'cancelled'].includes(attempt.status) ||
        !attempt.body || typeof attempt.body !== 'object' || Array.isArray(attempt.body)) {
      throw new TypeError('Invalid kernel attempt');
    }
    const prior = this.attempt(attempt.id);
    if (prior && (prior.item !== attempt.item || prior.node !== attempt.node || prior.startedAt !== attempt.startedAt)) {
      throw new Error('Attempt identity cannot change');
    }
    this.journal.database.prepare(`INSERT INTO attempts (id, item, node, started_at, ended_at, status, body)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, status = excluded.status, body = excluded.body`
    ).run(attempt.id, attempt.item, attempt.node, attempt.startedAt, attempt.endedAt ?? null, attempt.status, serializeSnapshot(attempt.body));
  }

  private decodeAttempt(row: AttemptRow): AttemptRecord {
    const body = deserializeSnapshot(row.body);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Invalid attempt body');
    return {id: row.id, item: row.item, node: row.node, startedAt: row.started_at,
      ...(row.ended_at === null ? {} : {endedAt: row.ended_at}), status: row.status, body: body as Record<string, unknown>};
  }

  attempt(id: string): AttemptRecord | undefined {
    if (!this.hasAttempts) return undefined;
    const row = this.journal.database.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as AttemptRow | undefined;
    return row ? this.decodeAttempt(row) : undefined;
  }

  attempts(item?: string): AttemptRecord[] {
    if (!this.hasAttempts) return [];
    const rows = (item === undefined
      ? this.journal.database.prepare('SELECT * FROM attempts ORDER BY started_at, id').all()
      : this.journal.database.prepare('SELECT * FROM attempts WHERE item = ? ORDER BY started_at, id').all(item)) as unknown as AttemptRow[];
    return rows.map(row => this.decodeAttempt(row));
  }
}

export {KernelStore as Store};
