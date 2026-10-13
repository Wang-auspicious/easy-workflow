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
    }
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

  *read(since = 0, run?: string): Generator<Stamped> {
    const stmt = run
      ? this.db.prepare("SELECT seq, at, run, body FROM events WHERE seq > ? AND run = ? ORDER BY seq")
      : this.db.prepare("SELECT seq, at, run, body FROM events WHERE seq > ? ORDER BY seq");
    const rows = (run ? stmt.iterate(since, run) : stmt.iterate(since)) as Iterable<{ seq: number; at: number; run: string; body: string }>;
    for (const r of rows) yield { ...JSON.parse(r.body), seq: r.seq, at: r.at, run: r.run } as Stamped;
  }

  runs(): { run: string; first: number; last: number; events: number }[] {
    return this.db.prepare("SELECT run, MIN(at) AS first, MAX(at) AS last, COUNT(*) AS events FROM events WHERE run != '' GROUP BY run ORDER BY first DESC").all() as never;
  }

  close() { this.db.close(); }
}
