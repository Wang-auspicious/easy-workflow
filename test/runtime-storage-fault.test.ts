import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Stamped } from '../shared/types.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-storage-fault-'));
process.env.FACTORY_VAR = root;
process.env.FACTORY_PREFLIGHT = '0';
process.env.FACTORY_START_PAUSED = '1';
process.env.FACTORY_RESUME_MANAGED = '0';
process.env.VISLEXICON_ROOT = path.join(root, 'unconnected');
const { Factory } = await import('../server/factory.ts');

const close = async (factory: InstanceType<typeof Factory>) => {
  await factory.runtime.close(); factory.docs.flush(); factory.lessons.close(); factory.journal.close();
};

async function exerciseStorageFailure(t: TestContext, boundary: 'result checkpoint' | 'attempt start') {
  let factory = new Factory(), isClosed = false, injected = false, cancelledSibling = false, mainAttempt = '', failedId = '';
  let baseline: Stamped[] = [], mainCalls = 0;
  let siblingReady!: () => void;
  const started = new Promise<void>(resolve => { siblingReady = resolve; });
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  const fault = (error: unknown) => {
    const result = error as { status?: number; code?: string; message?: string };
    return result.status === 503 && result.code === 'journal_commit_failed' && /重启/.test(result.message ?? '');
  };
  const mainRows = () => [...factory.journal.read()].filter(event =>
    ('token' in event && event.token === failedId) || ('attempt' in event && event.attempt === mainAttempt));
  try {
    await factory.boot(); factory.broker.memoryFloorMB = 0;
    factory.runtime.executors = node => async ctx => {
      if (node.key === 'curation/identity') {
        siblingReady();
        await new Promise<void>(resolve => { ctx.signal.addEventListener('abort', () => { cancelledSibling = true; resolve(); }, { once: true }); });
        return { ok: true, summary: 'late sibling result', data: { mustNotCommitSibling: true }, finish: { status: 'published', reason: 'must be ignored after cancellation' } };
      }
      assert.equal(node.key, 'curation/facts');
      mainCalls++; mainAttempt = ctx.attempt;
      await started;
      baseline = mainRows();
      return { ok: true, summary: 'uncommitted result', data: { uncommittedOutput: 'must disappear after rollback' } };
    };
    const append = factory.journal.append.bind(factory.journal);
    factory.journal.append = event => {
      const resultCheckpoint = boundary === 'result checkpoint' && event.kind === 'token.data'
        && (event.patch.runtimeCheckpoint as { done?: string[] } | undefined)?.done?.includes('curation/facts');
      const attemptStart = boundary === 'attempt start' && event.kind === 'attempt.started' && event.node === 'curation/facts';
      if (!injected && (resultCheckpoint || attemptStart)) {
        if (event.kind === 'attempt.started') {
          mainAttempt = event.attempt;
          // A read on this connection also sees pending SQL writes. Only the
          // committed projection watermark belongs to the durable baseline.
          baseline = mainRows().filter(row => row.seq <= factory.state.seq);
        }
        injected = true; throw new Error(`fixture storage failure at ${boundary}`);
      }
      return append(event);
    };
    factory.runtime.start(`storage failure at ${boundary}`);
    const sibling = factory.runtime.create('curation/identity', { item: 'sibling', url: 'https://fixture.test/sibling', source: 'manual' });
    const failed = factory.runtime.create('curation/facts', { item: 'failed', url: 'https://fixture.test/failed', source: 'manual', data: { keptInput: 'durable' } });
    failedId = failed.id;
    await factory.runtime.settle();
    assert.equal(injected, true);
    assert.equal(cancelledSibling, true, 'storage failure cancels other in-flight work');
    assert.equal(factory.runtime.running, false); assert.equal(factory.runtime.paused, true);
    assert.ok(Object.values(factory.broker.used).every(value => value === 0), 'all resource leases are reclaimed');
    assert.deepEqual(mainRows(), baseline, 'the failed transition leaves no partial token data, receipt or decision');
    assert.equal(factory.state.tokens[failed.id].data.uncommittedOutput, undefined);
    assert.equal(factory.state.tokens[sibling.id].data.mustNotCommitSibling, undefined);
    assert.equal(factory.state.tokens[sibling.id].status, 'active', 'late sibling publication is ignored');
    assert.equal(mainCalls, boundary === 'result checkpoint' ? 1 : 0);
    assert.throws(() => factory.runtime.resume(), fault);
    assert.throws(() => factory.runtime.start('unsafe restart'), fault);
    assert.throws(() => factory.runtime.end(), fault);
    assert.throws(() => factory.runtime.create('curation/facts', { item: 'unsafe intake', url: 'https://fixture.test/unsafe', source: 'manual' }), fault);
    assert.ok(errors.some(args => String(args[1]).includes('fixture storage failure')));

    await close(factory); isClosed = true;
    factory = new Factory(); isClosed = false; await factory.boot(); factory.broker.memoryFloorMB = 0;
    const restored = factory.runtime.tokens.get(failed.id)!;
    assert.equal(restored.data.keptInput, 'durable');
    assert.equal(restored.data.uncommittedOutput, undefined);
    assert.equal(restored.done.has('curation/facts'), false, 'only committed checkpoints survive process recovery');
    assert.ok(factory.runtime.queues.get('curation/facts')!.includes(failed.id));
    const resumed: string[] = [];
    factory.runtime.executors = node => async ctx => {
      resumed.push(`${ctx.token.id}:${node.key}`);
      return { ok: true, summary: 'recovered from durable input', data: { recovered: true }, finish: { status: 'published', reason: 'fixture recovery' } };
    };
    factory.runtime.resume(); await factory.runtime.settle();
    assert.equal(resumed.filter(call => call === `${failed.id}:curation/facts`).length, 1);
    assert.equal(factory.state.tokens[failed.id].status, 'published');
    assert.equal([...factory.journal.read()].filter(event => event.kind === 'token.finished' && event.token === failed.id && event.status === 'published').length, 1);
  } finally {
    if (!isClosed) await close(factory);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

test('result commit failure blocks the polluted runtime and restarts from durable checkpoints', { timeout: 15000 }, t => exerciseStorageFailure(t, 'result checkpoint'));
test('attempt-start storage failure releases capacity and preserves queued work for restart', { timeout: 15000 }, t => exerciseStorageFailure(t, 'attempt start'));

test('failed manual intake never leaves a durable task without its input or queue checkpoint', {timeout: 15000}, async () => {
  for (const boundary of ['input', 'queue'] as const) {
    let factory = new Factory();
    try {
      await factory.boot();
      factory.broker.memoryFloorMB = 0;
      factory.runtime.start(`Intake failure at ${boundary}`);
      factory.runtime.pause();
      const before = [...factory.journal.read()];
      const tokens = Object.keys(factory.state.tokens);
      const append = factory.journal.append.bind(factory.journal);
      let rejectedToken = '';
      factory.journal.append = event => {
        if (event.kind === 'token.created') rejectedToken = event.token;
        if (boundary === 'input' && event.kind === 'token.data' ||
            boundary === 'queue' && event.kind === 'token.queued') {
          throw new Error(`fixture intake failure at ${boundary}`);
        }
        return append(event);
      };
      assert.throws(() => factory.runtime.create('curation/facts', {
        item: `missing-${boundary}`, url: 'https://fixture.test/', source: 'manual',
        data: {paidArtifact: 'must accompany the durable task'},
      }), /fixture intake failure/);
      assert.equal(factory.runtime.running, false);
      assert.equal(factory.runtime.paused, true);
      assert.deepEqual([...factory.journal.read()], before);
      assert.deepEqual(Object.keys(factory.state.tokens), tokens);
      assert.throws(() => factory.runtime.resume(), /日志提交失败/);
      factory.journal.append = append;
      await close(factory);
      factory = new Factory();
      await factory.boot();
      assert.equal(factory.runtime.tokens.has(rejectedToken), false);
      assert.deepEqual(Object.keys(factory.state.tokens), tokens);
    } finally {
      await close(factory);
    }
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
});

test('a failed resume receipt keeps queued work stopped until durable restart', {timeout: 15000}, async () => {
  let factory = new Factory();
  let calls = 0;
  try {
    await factory.boot();
    factory.broker.memoryFloorMB = 0;
    factory.runtime.start('Resume receipt failure');
    factory.runtime.pause();
    const token = factory.runtime.create('curation/facts', {
      item: 'paused-intake', url: 'https://fixture.test/', source: 'manual', data: {kept: true},
    });
    factory.runtime.executors = () => async () => {
      calls++;
      return {ok: true, summary: 'fixture completed', finish: {status: 'published', reason: 'fixture'}};
    };
    const append = factory.journal.append.bind(factory.journal);
    factory.journal.append = event => {
      if (event.kind === 'run.resumed') throw new Error('fixture resume write failure');
      return append(event);
    };
    assert.throws(() => factory.runtime.resume(), /fixture resume write failure/);
    factory.runtime.schedule();
    await factory.runtime.settle();
    assert.equal(calls, 0);
    assert.equal(factory.state.run.status, 'paused');
    assert.equal(factory.runtime.running, false);
    assert.throws(() => factory.runtime.resume(), /日志提交失败/);
    factory.journal.append = append;
    await close(factory);
    factory = new Factory();
    await factory.boot();
    factory.broker.memoryFloorMB = 0;
    factory.runtime.executors = () => async () => {
      calls++;
      return {ok: true, summary: 'fixture resumed', finish: {status: 'published', reason: 'fixture'}};
    };
    assert.equal(factory.state.tokens[token.id].data.kept, true);
    assert.equal(factory.runtime.paused, true);
    factory.runtime.resume();
    await factory.runtime.settle();
    assert.equal(calls, 1);
    assert.equal(factory.state.tokens[token.id].status, 'published');
  } finally {
    await close(factory);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
  }
});
