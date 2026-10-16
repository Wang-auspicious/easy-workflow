import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {PROJECTION_VERSION} from '../shared/project.ts';
import type {Stamped} from '../shared/types.ts';
import type {Journal} from './journal.ts';

export interface Snapshottable {
  readonly snapshotName: string;
  serialize(): string;
  /** Validate the complete decoded cache before assigning any live fields. */
  restore(body: string): void;
  observe(event: Stamped): void;
}

export function snapshotVersion(digest: string): string {
  return createHash('sha256').update(`${PROJECTION_VERSION}:${digest}`).digest('hex').slice(0, 16);
}

/** All components share one bounded tail read, even when their snapshots differ. */
export function restoreSnapshots(journal: Journal, components: readonly Snapshottable[], version: string): {
  replayed: number; fullReplay: boolean; through: number;
} {
  const through = journal.seq;
  let fullReplay = false;
  const cursors = components.map(component => {
    const started = performance.now();
    const snapshot = journal.latestSnapshot(component.snapshotName, version);
    let from = 1;
    if (snapshot) {
      try {
        if (!Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0 || snapshot.seq > through) {
          throw new TypeError('Invalid snapshot sequence');
        }
        component.restore(snapshot.body);
        from = snapshot.seq + 1;
      } catch {
        // A JSON exception can include private payloads. Only report cache identity.
        console.warn(`boot.snapshot.invalid name=${component.snapshotName} fallback=full-replay`);
      }
    }
    if (from === 1) fullReplay = true;
    console.log(`BOOT_STAGE restore-${component.snapshotName} ${Math.round(performance.now() - started)}`);
    return {component, from};
  });
  let replayed = 0;
  if (cursors.length) {
    const from = Math.min(...cursors.map(cursor => cursor.from));
    const started = performance.now();
    for (const event of journal.read(from - 1, undefined, through)) {
      for (const cursor of cursors) if (event.seq >= cursor.from) cursor.component.observe(event);
      replayed++;
    }
    console.log(`BOOT_STAGE replay ${Math.round(performance.now() - started)}`);
  }
  return {replayed, fullReplay, through};
}

/** The caller schedules this synchronous capture with setImmediate. */
export function saveSnapshots(journal: Journal, components: readonly Snapshottable[], version: string): void {
  if (journal.inTransaction) throw new Error('Cannot capture snapshots during Journal.atomic');
  const through = journal.seq;
  for (const component of components) {
    const started = performance.now();
    const body = component.serialize();
    journal.writeSnapshot(component.snapshotName, through, version, body);
    console.log(`boot.snapshot name=${component.snapshotName} ms=${Math.round(performance.now() - started)} bytes=${Buffer.byteLength(body)}`);
  }
}
