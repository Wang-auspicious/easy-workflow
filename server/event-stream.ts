import type {ServerResponse} from 'node:http';
import {setImmediate as yieldLoop} from 'node:timers/promises';
import type {Journal} from './journal.ts';

const PAGE_SIZE = 100;
const DRAIN_TIMEOUT_MS = 15_000;

/** A slow reader resumes from SQLite, never from an unbounded in-memory queue. */
export class JournalEventStream {
  private readonly journal: Journal;
  private readonly response: ServerResponse;
  private readonly snapshot: () => unknown[];
  private readonly unsubscribe: () => void;
  private readonly lifetime = new AbortController();
  private readonly drainTimeoutMs: number;
  private cursor: number;
  private pumping = false;
  private needsSnapshot = true;

  constructor(
      journal: Journal, response: ServerResponse, since: number,
      snapshot: () => unknown[], drainTimeoutMs = DRAIN_TIMEOUT_MS) {
    this.journal = journal;
    this.response = response;
    this.cursor = since;
    this.snapshot = snapshot;
    this.drainTimeoutMs = drainTimeoutMs;
    this.unsubscribe = journal.subscribe(() => this.schedule());
    response.once('close', () => this.close());
    response.once('error', () => this.close());
    this.schedule();
  }

  sendLive(event: unknown): void {
    if (this.lifetime.signal.aborted) return;
    // Ephemeral deltas are replaced by an authoritative snapshot after catch-up.
    if (this.pumping || this.response.writableNeedDrain || this.cursor < this.journal.seq) {
      this.needsSnapshot = true;
      this.schedule();
      return;
    }
    if (!this.response.write(`event: live\ndata: ${JSON.stringify(event)}\n\n`)) {
      this.schedule();
    }
  }

  ping(): void {
    if (this.lifetime.signal.aborted || this.response.writableNeedDrain) return;
    if (!this.response.write(': ping\n\n')) this.schedule();
  }

  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.unsubscribe();
    this.response.destroy();
  }

  private schedule(): void {
    if (this.pumping || this.lifetime.signal.aborted) return;
    this.pumping = true;
    // Coalesce journal notifications from a transaction before reading one page.
    setImmediate(() => {
      void this.pump().catch(() => this.close()).finally(() => {
        this.pumping = false;
        if (this.cursor < this.journal.seq || this.needsSnapshot) this.schedule();
      });
    });
  }

  private async pump(): Promise<void> {
    while (!this.lifetime.signal.aborted) {
      await this.drain();
      if (this.lifetime.signal.aborted) return;
      const through = this.journal.seq;
      if (this.cursor < through) {
        const page = this.journal.readPage({since: this.cursor, through, limit: PAGE_SIZE});
        if (!page.events.length) throw new Error('Event stream cursor did not advance');
        for (const event of page.events) {
          if (this.lifetime.signal.aborted) return;
          const writable = this.response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
          this.cursor = event.seq;
          if (!writable) await this.drain();
        }
        await yieldLoop();
        continue;
      }
      if (!this.needsSnapshot) return;
      this.needsSnapshot = false;
      for (const event of this.snapshot()) {
        if (this.lifetime.signal.aborted) return;
        if (!this.response.write(`event: live\ndata: ${JSON.stringify(event)}\n\n`)) {
          await this.drain();
        }
      }
    }
  }

  private drain(): Promise<void> {
    if (!this.response.writableNeedDrain || this.lifetime.signal.aborted) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.response.off('drain', done);
        this.lifetime.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(() => this.close(), this.drainTimeoutMs);
      timer.unref();
      this.response.once('drain', done);
      this.lifetime.signal.addEventListener('abort', done, {once: true});
    });
  }
}
