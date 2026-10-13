import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-control-persistence-'));
process.env.FACTORY_VAR = dir; process.env.FACTORY_PREFLIGHT = '0'; process.env.VISLEXICON_ROOT = path.join(dir, 'unconnected');
const { Factory } = await import('../server/factory.ts');
const close = async (factory: InstanceType<typeof Factory>) => { await factory.runtime?.close(); factory.docs?.flush(); factory.lessons?.close(); factory.journal.close(); };
const useFixture = (factory: InstanceType<typeof Factory>) => {
  factory.broker.memoryFloorMB = 0;
  factory.runtime.executors = node => async () => ({ ok: true, summary: 'fixture result', data: node.key === 'curation/gate' ? { gate: 'pass' } : undefined });
};

test('an unexecuted correction can be undone after restart, restoring its publication inventory and checkpoints', async () => {
  let factory = new Factory();
  try {
    await factory.boot(); useFixture(factory); factory.runtime.start('undo correction');
    const token = factory.runtime.create('curation/facts', { item: 'undo', url: 'https://fixture.example', source: 'manual', data: { kept: 'original evidence' } });
    await factory.runtime.settle(); assert.equal(factory.state.tokens[token.id].status, 'published');
    factory.runtime.pause(); const originalDone = [...token.done], attempts = factory.state.tokens[token.id].attempts.length;
    const correction = factory.runtime.correct({ token: token.id, node: 'curation/facts' }, 'Verify a detail again', 'check the original source');
    assert.equal(correction.ok, true); assert.ok(correction.correction); assert.equal(factory.state.nodes['curation/published'].stock, 0);
    await close(factory); factory = new Factory(); await factory.boot(); useFixture(factory);
    factory.runtime.undoCorrection(correction.correction!);
    assert.equal(factory.state.tokens[token.id].status, 'published');
    assert.equal(factory.state.nodes['curation/published'].stock, 1);
    assert.deepEqual([...factory.runtime.tokens.get(token.id)!.done], originalDone);
    assert.equal(factory.state.tokens[token.id].attempts.length, attempts);
    assert.equal(factory.state.tokens[token.id].data.kept, 'original evidence');
    assert.equal(factory.runtime.queues.get('curation/facts')!.includes(token.id), false);
    assert.throws(() => factory.runtime.undoCorrection(correction.correction!), /已有工位执行/);
    const executed = factory.runtime.correct({ token: token.id, node: 'curation/facts' }, 'Perform the correction');
    factory.runtime.resume(); await factory.runtime.settle();
    assert.throws(() => factory.runtime.undoCorrection(executed.correction!), /已有工位执行/);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('line and station pauses survive process restart independently', async () => {
  let factory = new Factory();
  try {
    await factory.boot(); useFixture(factory); factory.runtime.start('scoped pause');
    factory.runtime.setScopePaused({ scope: 'line', key: 'curation', paused: true, reason: 'inspect line' });
    factory.runtime.setScopePaused({ scope: 'station', key: 'curation/facts', paused: true, reason: 'inspect station' });
    const token = factory.runtime.create('curation/facts', { item: 'paused', url: 'https://fixture.example', source: 'manual' });
    await factory.runtime.settle(); factory.runtime.pause();
    await close(factory); factory = new Factory(); await factory.boot(); useFixture(factory);
    assert.equal(factory.runtime.pausedLines.has('curation'), true); assert.equal(factory.runtime.pausedStations.has('curation/facts'), true);
    factory.runtime.resume(); factory.runtime.setScopePaused({ scope: 'line', key: 'curation', paused: false, reason: 'line ready' }); await factory.runtime.settle();
    assert.equal(factory.state.tokens[token.id].attempts.length, 0);
    factory.runtime.setScopePaused({ scope: 'station', key: 'curation/facts', paused: false, reason: 'station ready' }); await factory.runtime.settle();
    assert.equal(factory.state.tokens[token.id].status, 'published');
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('measured service history and the pending ten-item proposal survive restart without duplicate proposals', async () => {
  let factory = new Factory();
  try {
    await factory.boot(); useFixture(factory); factory.runtime.start('durable measurement');
    factory.runtime.executors = () => async () => ({ ok: true, summary: 'fixture complete', finish: { status: 'published', reason: 'fixture' } });
    for (let i = 0; i < 10; i++) factory.runtime.create('candidates/route', { item: `item-${i}`, url: 'https://fixture.example', source: 'fixture' });
    await factory.runtime.settle(); factory.runtime.pause();
    const id = factory.runtime.measurementProposal()!.id;
    await close(factory); factory = new Factory(); await factory.boot();
    assert.equal(factory.runtime.measurementProposal()?.id, id);
    assert.equal(factory.runtime.stationNumbers('candidates/route').measured, true);
    assert.equal(factory.runtime.sampleItems.size, 10);
    assert.equal([...factory.journal.read()].filter(event => event.kind === 'measurement.proposed').length, 1);
    factory.runtime.decideMeasurement(id, false);
    assert.equal(factory.state.measurement?.status, 'rejected');
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});
