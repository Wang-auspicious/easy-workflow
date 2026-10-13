import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../server/journal.ts';

test('journal rollback preserves durable rows, sequence, run and all subscriber visibility', () => {
  const journal = new Journal(':memory:');
  const projection: number[] = [], observed: number[] = [], effects: string[] = [];
  journal.subscribeProjection(event => projection.push(event.seq));
  journal.subscribe(event => observed.push(event.seq));
  try {
    journal.append({ kind: 'run.started', runId: 'original', title: 'original' });
    assert.throws(() => journal.atomic(() => {
      journal.append({ kind: 'run.started', runId: 'rolled-back', title: 'rolled-back' });
      journal.afterCommit(() => effects.push('must not run'));
      assert.deepEqual(projection, [1]); assert.deepEqual(observed, [1]);
      throw new Error('fixture write failure');
    }), /fixture write failure/);
    assert.equal(journal.seq, 1); assert.equal(journal.run, 'original');
    assert.deepEqual([...journal.read()].map(event => event.seq), [1]);
    assert.deepEqual(projection, [1]); assert.deepEqual(observed, [1]); assert.deepEqual(effects, []);
    const next = journal.append({ kind: 'dispatch.note', tone: 'info', text: 'after rollback' });
    assert.equal(next.seq, 2); assert.equal(next.run, 'original');
  } finally { journal.close(); }
});

test('committed projections precede notifications and nested writes preserve subscriber sequence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-journal-atomic-'));
  const file = path.join(dir, 'journal.db');
  const journal = new Journal(file), reader = new Journal(file, true);
  const projected: number[] = [], first: number[] = [], second: number[] = [];
  const committedEffects: number[][] = [];
  let visibleAtNotification: number[] = [], projectedAtNotification: number[] = [], projectedAfterWrite: number[] = [];
  journal.subscribeProjection(event => projected.push(event.seq));
  journal.subscribe(event => {
    first.push(event.seq);
    if (event.seq === 1) {
      visibleAtNotification = [...reader.read()].map(e => e.seq);
      projectedAtNotification = [...projected];
      journal.append({ kind: 'dispatch.note', tone: 'info', text: 'listener follow-up' });
      projectedAfterWrite = [...projected];
    }
  });
  journal.subscribe(event => second.push(event.seq));
  try {
    journal.atomic(() => {
      journal.append({ kind: 'run.started', runId: 'atomic', title: 'atomic' });
      journal.atomic(() => journal.append({ kind: 'run.paused', runId: 'atomic' }));
      journal.afterCommit(() => committedEffects.push([...reader.read()].map(event => event.seq)));
      assert.deepEqual([...reader.read()], []);
      assert.deepEqual(projected, []); assert.deepEqual(first, []);
    });
    assert.deepEqual(visibleAtNotification, [1, 2], 'the full transition is already visible in another connection');
    assert.deepEqual(projectedAtNotification, [1, 2], 'consumers see the committed state before reacting');
    assert.deepEqual(projectedAfterWrite, [1, 2, 3], 'synchronous commands see their own committed write');
    assert.deepEqual(first, [1, 2, 3]); assert.deepEqual(second, [1, 2, 3]);
    assert.deepEqual(committedEffects, [[1, 2, 3]]);
    assert.equal(journal.seq, 3);
  } finally {
    reader.close(); journal.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('async transaction callbacks are rejected before their body can run', () => {
  const journal = new Journal(':memory:');
  let invoked = false;
  try {
    assert.throws(() => journal.atomic(async () => { invoked = true; }), /synchronous/);
    assert.equal(invoked, false); assert.equal(journal.seq, 0);
  } finally { journal.close(); }
});
