// Journal (Spec §11): an append-only SQLite (WAL) event table, the system's only source
// of truth. Every state change is written here first and only then takes effect; the
// in-memory projection, the dashboard and the run report are all derived from it.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JournalEvent, Stamped } from "../shared/types.ts";

export type Listener = (e: Stamped) => void;

export class Journal {
  private db: DatabaseSync;
  private insert;
  private listeners = new Set<Listener>();
  private projections = new Set<Listener>();
  private transaction: { events: Stamped[]; afterCommit: (() => void)[] } | null = null;
  private notifications: Stamped[] = [];
  private notifying = false;
  private readonly hasSnapshots: boolean;
  seq = 0;
  run = "";

  constructor(file: string, readOnly = false) {
    if (!readOnly) fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { readOnly });
    if (!readOnly) {
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      this.db.exec(`CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, run TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL)`);
      this.db.exec("CREATE INDEX IF NOT EXISTS events_run ON events(run, seq)");
      this.db.exec('CREATE INDEX IF NOT EXISTS events_kind ON events(kind, seq)');
      this.db.exec(`CREATE TABLE IF NOT EXISTS snapshots (
        name TEXT NOT NULL, seq INTEGER NOT NULL, version TEXT NOT NULL,
        at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (name, seq))`);
    }
    this.hasSnapshots = Boolean(this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'snapshots'"
    ).get());
    this.insert = this.db.prepare("INSERT INTO events (seq, at, run, kind, body) VALUES (?, ?, ?, ?, ?)");
    const last = this.db.prepare("SELECT seq, run FROM events ORDER BY seq DESC LIMIT 1").get() as { seq: number; run: string } | undefined;
    if (last) { this.seq = last.seq; this.run = last.run; }
  }

  append<E extends JournalEvent>(event: E): Stamped<E> {
    const stamped = { ...event, seq: this.seq + 1, at: Date.now(), run: event.kind === "run.started" ? event.runId : this.run } as Stamped<E>;
    this.insert.run(stamped.seq, stamped.at, stamped.run, stamped.kind, JSON.stringify(event));
    this.seq = stamped.seq;
    if (event.kind === "run.started") this.run = event.runId;
    if (this.transaction) this.transaction.events.push(stamped);
    else this.publish([stamped]);
    return stamped;
  }

  /** One synchronous state transition is either entirely durable or invisible.
   * Model calls and external I/O must finish before entering this transaction. */
  atomic(action: () => void) {
    if (action.constructor.name === 'AsyncFunction') throw new TypeError('Journal.atomic requires a synchronous action');
    if (this.transaction) { action(); return; }
    const before = { seq: this.seq, run: this.run };
    const pending = { events: [] as Stamped[], afterCommit: [] as (() => void)[] };
    this.db.exec('BEGIN IMMEDIATE');
    this.transaction = pending;
    try {
      const result: unknown = action();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new TypeError('Journal.atomic requires a synchronous action');
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (rollbackError) { console.error('journal rollback', rollbackError); }
      this.seq = before.seq; this.run = before.run;
      throw error;
    } finally { this.transaction = null; }
    this.publish(pending.events);
    for (const effect of pending.afterCommit) effect();
  }

  afterCommit(action: () => void) {
    if (this.transaction) this.transaction.afterCommit.push(action);
    else action();
  }

  get inTransaction(): boolean { return this.transaction !== null; }

  /** Snapshots are replaceable caches, and must never capture an open transition. */
  writeSnapshot(name: string, seq: number, version: string, body: string): void {
    if (this.inTransaction) throw new Error('Cannot write a snapshot during Journal.atomic');
    if (!name || !version || !Number.isSafeInteger(seq) || seq < 0 || seq > this.seq) {
      throw new RangeError('Invalid snapshot name, version or sequence');
    }
    this.atomic(() => {
      this.db.prepare(`INSERT INTO snapshots (name, seq, version, at, body) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name, seq) DO UPDATE SET version = excluded.version, at = excluded.at, body = excluded.body`
      ).run(name, seq, version, Date.now(), body);
      this.db.prepare(`DELETE FROM snapshots WHERE name = ? AND seq NOT IN
        (SELECT seq FROM snapshots WHERE name = ? ORDER BY seq DESC LIMIT 3)`
      ).run(name, name);
    });
  }

  latestSnapshot(name: string, version: string): {seq: number; body: string} | null {
    if (!this.hasSnapshots) return null;
    const row = this.db.prepare(
      'SELECT seq, body FROM snapshots WHERE name = ? AND version = ? ORDER BY seq DESC LIMIT 1'
    ).get(name, version) as {seq: number; body: string} | undefined;
    return row ? {seq: row.seq, body: row.body} : null;
  }

  completedRuns(): Set<string> {
    const rows = this.db.prepare("SELECT DISTINCT run FROM events WHERE kind = 'run.ended'")
      .all() as {run: string}[];
    return new Set(rows.map(row => row.run));
  }

  latestEvent<K extends Stamped['kind']>(kind: K): Extract<Stamped, {kind: K}> | null {
    const row = this.db.prepare(
      'SELECT seq, at, run, body FROM events WHERE kind = ? ORDER BY seq DESC LIMIT 1'
    ).get(kind) as {seq: number; at: number; run: string; body: string} | undefined;
    return row ? {...JSON.parse(row.body), seq: row.seq, at: row.at, run: row.run} : null;
  }

  private publish(events: Stamped[]) {
    // Materialize the committed batch before consumers react. A listener may
    // append more events; its projections update synchronously, while broadcasts
    // stay in sequence after the batch already waiting to be delivered.
    for (const event of events) for (const projection of this.projections) {
      try { projection(event); } catch (error) { console.error('journal projection', error); }
    }
    this.notifications.push(...events);
    if (this.notifying) return;
    this.notifying = true;
    try {
      while (this.notifications.length) {
        const event = this.notifications.shift()!;
        for (const listener of this.listeners) {
          try { listener(event); } catch (error) { console.error('journal listener', error); }
        }
      }
    } finally { this.notifying = false; }
  }

  subscribeProjection(l: Listener) { this.projections.add(l); return () => this.projections.delete(l); }

  subscribe(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }

  *read(since = 0, run?: string, through = Number.MAX_SAFE_INTEGER): Generator<Stamped> {
    const stmt = run
      ? this.db.prepare("SELECT seq, at, run, body FROM events WHERE seq > ? AND seq <= ? AND run = ? ORDER BY seq")
      : this.db.prepare("SELECT seq, at, run, body FROM events WHERE seq > ? AND seq <= ? ORDER BY seq");
    const rows = (run ? stmt.iterate(since, through, run) : stmt.iterate(since, through)) as Iterable<{ seq: number; at: number; run: string; body: string }>;
    for (const r of rows) yield { ...JSON.parse(r.body), seq: r.seq, at: r.at, run: r.run } as Stamped;
  }

  /** Rebuild a projection without decoding unrelated, potentially large payloads. */
  *readKinds(kinds: readonly Stamped['kind'][], since = 0, through = this.seq): Generator<Stamped> {
    if (!kinds.length) return;
    const selected = [...new Set(kinds)];
    const placeholders = selected.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT seq, at, run, body FROM events WHERE seq > ? AND seq <= ? AND kind IN (${placeholders}) ORDER BY seq`
    ).iterate(since, through, ...selected) as Iterable<{seq: number; at: number; run: string; body: string}>;
    for (const row of rows) yield {...JSON.parse(row.body), seq: row.seq, at: row.at, run: row.run} as Stamped;
  }

  lastSequence(run: string, through = this.seq): number {
    const row = this.db.prepare(
      'SELECT MAX(seq) seq FROM events WHERE run = ? AND seq <= ?'
    ).get(run, through) as {seq: number | null};
    return row.seq ?? 0;
  }

  /** Rehydrate a lightweight event index without retaining every event body. */
  *readSequences(sequences: readonly number[]): Generator<Stamped> {
    let previous = 0;
    for (const seq of sequences) {
      if (!Number.isSafeInteger(seq) || seq <= previous) {
        throw new RangeError('Journal sequences must be positive and strictly increasing');
      }
      previous = seq;
    }
    for (let start = 0; start < sequences.length; start += 400) {
      const page = sequences.slice(start, start + 400);
      const placeholders = page.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT seq, at, run, body FROM events WHERE seq IN (${placeholders}) ORDER BY seq`
      ).all(...page) as {seq: number; at: number; run: string; body: string}[];
      if (rows.length !== page.length) throw new Error('Referenced journal event is missing');
      for (const row of rows) {
        yield {...JSON.parse(row.body), seq: row.seq, at: row.at, run: row.run} as Stamped;
      }
    }
  }

  /** A bounded immutable cursor for replay. New events never extend an in-flight export. */
  readPage(options: {since?: number; run?: string; limit?: number; through?: number} = {}) {
    const since = options.since ?? 0;
    const limit = options.limit ?? 200;
    const through = options.through ?? this.seq;
    if (!Number.isSafeInteger(since) || since < 0 ||
        !Number.isSafeInteger(through) || through < since ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError('Invalid journal cursor or page size');
    }
    const stmt = options.run
      ? this.db.prepare('SELECT seq,at,run,body FROM events WHERE seq > ? AND seq <= ? AND run = ? ORDER BY seq LIMIT ?')
      : this.db.prepare('SELECT seq,at,run,body FROM events WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?');
    const rows = (options.run
      ? stmt.all(since, through, options.run, limit + 1)
      : stmt.all(since, through, limit + 1)) as {seq: number; at: number; run: string; body: string}[];
    const events = rows.slice(0, limit).map(row => ({
      ...JSON.parse(row.body), seq: row.seq, at: row.at, run: row.run,
    }) as Stamped);
    return {events, nextSeq: events.at(-1)?.seq ?? since, through, done: rows.length <= limit};
  }

  runs(): { run: string; first: number; last: number; events: number }[] {
    return this.db.prepare("SELECT run, MIN(at) AS first, MAX(at) AS last, COUNT(*) AS events FROM events WHERE run != '' GROUP BY run ORDER BY first DESC").all() as never;
  }

  close() { this.db.close(); }
}
