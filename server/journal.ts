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
    for (const l of this.listeners) {
      try { l(stamped); } catch (err) { console.error("journal listener", err); }
    }
    return stamped;
  }

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
