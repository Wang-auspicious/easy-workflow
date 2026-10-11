import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-batch-'));
process.env.FACTORY_VAR = dir;
process.env.FACTORY_PREFLIGHT = '0';
process.env.FACTORY_HTTP_CACHE = '0';
process.env.VISLEXICON_ROOT = path.join(dir, 'unconnected');
const { Factory } = await import('../server/factory.ts');
const { FactoryControl } = await import('../server/control.ts');
const { batchSummary } = await import('../shared/batch.ts');
const close = async (factory: InstanceType<typeof Factory>) => {
  await factory.runtime.close(); factory.docs.flush(); factory.lessons.close(); factory.journal.close();
};
const catalog = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `site-${i}`, name: `Site ${i}`, canonicalUrl: `https://site-${i}.example/` }));

test('a durable 100-site goal replenishes a bounded pipeline without a chat polling loop', async () => {
  const factory = new Factory();
  try {
    await factory.boot();
    factory.catalog = Array.from({ length: 120 }, (_, i) => ({ id: `site-${i}`, name: `Site ${i}`, canonicalUrl: `https://site-${i}.example/` }));
    let peak = 0;
    factory.runtime.executors = () => async () => {
      peak = Math.max(peak, [...factory.runtime.tokens.values()].filter(t => !t.finished).length);
      return { ok: true, summary: 'fixture publication', finish: { status: 'published', reason: 'fixture' } };
    };
    const control = new FactoryControl(factory);
    await control.execute('run_batch', { action: 'start', target: 100, maxInFlight: 6, intakeWindow: 3 }, 'user');
    await factory.runtime.settle();
    const result = (await control.execute('run_batch', { action: 'status' }, 'user')).result;
    assert.equal(result.target, 100);
    assert.equal(result.admitted, 100, 'a title saying 100 must not stop after the first 20');
    assert.equal(result.completed, 100);
    assert.equal(result.status, 'completed');
    assert.ok(peak <= 6, `in-flight peak ${peak} exceeds window`);
    assert.equal(new Set([...factory.runtime.tokens.values()].map(t => t.item)).size, 100);
  } finally {
    await factory.runtime.close(); factory.docs.flush(); factory.lessons.close(); factory.journal.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pause and process restart retain the total goal, original run and exact remaining admission', async () => {
  let factory = new Factory();
  try {
    await factory.boot(); factory.catalog = catalog(20);
    factory.batch.configure({ target: 9, maxInFlight: 4, intakeWindow: 2 });
    factory.runtime.pause();
    const runId = factory.state.run.id;
    assert.equal(batchSummary(factory.state)?.admitted, 2);
    await close(factory);
    factory = new Factory(); await factory.boot(); factory.catalog = catalog(20);
    assert.equal(factory.state.run.id, runId);
    assert.equal(factory.state.batch?.target, 9);
    assert.equal(batchSummary(factory.state)?.status, 'paused');
    assert.equal(batchSummary(factory.state)?.admitted, 2);
    factory.runtime.executors = () => async () => ({ ok: true, summary: 'fixture', finish: { status: 'published', reason: 'fixture' } });
    factory.batch.setMode('running');
    await factory.runtime.settle();
    assert.equal(batchSummary(factory.state)?.admitted, 9);
    assert.equal(batchSummary(factory.state)?.completed, 9);
    assert.equal(factory.state.run.id, runId);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('transient failures resume automatically, reuse checkpoints and never count retries as more sites', async () => {
  const factory = new Factory();
  try {
    await factory.boot(); factory.catalog = catalog(10);
    factory.runtime.executors = () => async ctx => ctx.token.data.retryOf
      ? { ok: true, summary: 'fixture', finish: { status: 'published', reason: 'fixture' } }
      : { ok: false, summary: 'fixture connection timeout', failure: { tag: 'network_timeout', category: 'network', message: 'timeout', retryable: true, owner: 'system' } };
    factory.batch.configure({ target: 4, maxInFlight: 4, intakeWindow: 2 });
    await factory.runtime.settle();
    assert.equal(batchSummary(factory.state)?.retrying, 4);
    assert.equal(batchSummary(factory.state)?.completed, 0);
    factory.batch.pump(Date.now() + 60000);
    await factory.runtime.settle();
    assert.equal(batchSummary(factory.state)?.admitted, 4);
    assert.equal(batchSummary(factory.state)?.completed, 4);
    assert.equal(factory.runtime.tokens.size, 8);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('persistent failures exhaust a durable retry budget without becoming success or asking for login', async () => {
  const factory = new Factory();
  try {
    await factory.boot(); factory.catalog = catalog(2);
    factory.runtime.executors = () => async () => ({ ok: false, summary: 'timeout', failure: { tag: 'network_timeout', category: 'network', message: 'timeout', retryable: true, owner: 'system' } });
    factory.batch.configure({ target: 2, maxInFlight: 2, intakeWindow: 2 });
    await factory.runtime.settle();
    for (let pass = 0; pass < 4; pass++) { factory.batch.pump(Date.now() + 120000); await factory.runtime.settle(); }
    assert.equal(factory.runtime.tokens.size, 6, 'initial plus exactly two recovery attempts per site');
    assert.equal(batchSummary(factory.state)?.status, 'blocked');
    assert.equal(batchSummary(factory.state)?.completed, 0);
    assert.equal(batchSummary(factory.state)?.blocked, 2);
    assert.deepEqual(Object.values(factory.state.alerts), []);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed page selection goes to the reader with prior failures, not directly to the user', async () => {
  const factory = new Factory();
  try {
    await factory.boot(); factory.catalog = catalog(1);
    const stations: string[] = [];
    factory.runtime.executors = node => async ctx => {
      stations.push(node.key);
      if (ctx.token.data.retryOf) {
        assert.ok(ctx.token.data.repairContext);
        return { ok: true, summary: 'fixture repair', finish: { status: 'published', reason: 'fixture' } };
      }
      return { ok: false, summary: 'no public page selected', failure: { tag: 'needs_selection', category: 'system', message: 'candidate list was insufficient', retryable: true, owner: 'agent' } };
    };
    factory.batch.configure({ target: 1 }); await factory.runtime.settle();
    factory.batch.pump(Date.now() + 60000); await factory.runtime.settle();
    assert.deepEqual(stations, ['candidates/route', 'curation/reader']);
    assert.equal(batchSummary(factory.state)?.completed, 1);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy network login alerts are removed without dropping the failure or incrementing attempts', async () => {
  let factory = new Factory();
  try {
    await factory.boot(); factory.catalog = catalog(1);
    factory.runtime.executors = () => async () => ({ ok: false, summary: 'ECONNRESET', failure: { tag: 'network_connection', category: 'network', message: 'ECONNRESET', retryable: true, owner: 'user' } });
    const [token] = factory.pull(1); await factory.runtime.settle();
    assert.deepEqual(Object.values(factory.state.alerts), [], 'a network failure must not get a login alert even if its old owner is user');
    factory.journal.append({ kind: 'alert.raised', alert: { id: `auth:${token.item}`, kind: 'auth', level: 'red', item: token.item, token: token.id, message: 'legacy wrong login', url: token.url } });
    await close(factory);
    factory = new Factory(); await factory.boot();
    assert.deepEqual(Object.values(factory.state.alerts), []);
    assert.equal(factory.state.recoveries[token.item].failure?.tag, 'network_connection');
    assert.equal(factory.state.recoveries[token.item].failure?.owner, 'system');
    assert.equal(factory.state.recoveries[token.item].attempts, 1);
    assert.ok([...factory.journal.read()].some(event => event.kind === 'alert.cleared'));
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('desktop restart resumes an explicitly managed running goal, while a ended run cannot be resumed', async () => {
  let factory = new Factory();
  const saved = { FACTORY_START_PAUSED: process.env.FACTORY_START_PAUSED, FACTORY_RESUME_MANAGED: process.env.FACTORY_RESUME_MANAGED };
  try {
    await factory.boot();
    factory.batch.configure({ target: 4, maxInFlight: 3, intakeWindow: 2 });
    const run = factory.state.run.id;
    await close(factory);
    process.env.FACTORY_START_PAUSED = '1'; process.env.FACTORY_RESUME_MANAGED = '1';
    factory = new Factory(); await factory.boot();
    assert.equal(factory.runtime.paused, false);
    assert.equal(factory.state.run.id, run);
    factory.catalog = catalog(4);
    factory.runtime.executors = () => async () => ({ ok: true, summary: 'fixture', finish: { status: 'published', reason: 'fixture' } });
    factory.batch.pump(); await factory.runtime.settle();
    assert.equal(batchSummary(factory.state)?.completed, 4);
    factory.runtime.end();
    assert.throws(() => factory.batch.setMode('running'), /本轮已经结束/);
  } finally {
    await close(factory); fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('late review recovery gets the available slot before another early reading attempt', async () => {
  const factory = new Factory();
  try {
    await factory.boot(); factory.runtime.start('prioritize completed evidence');
    factory.runtime.executors = () => async () => ({ ok: false, summary: 'timeout', failure: { tag: 'network_timeout', category: 'network', message: 'timeout', retryable: true, owner: 'system' } });
    for (const [item, node] of [['early', 'curation/reader'], ['late', 'curation/copy-review']]) factory.runtime.create(node, { item, url: `https://${item}.example/`, source: 'manual', data: { canonical: `https://${item}.example/` } });
    await factory.runtime.settle();
    const resumed: string[] = [];
    factory.runtime.executors = node => async () => { resumed.push(node.key); return { ok: true, summary: 'fixture', finish: { status: 'published', reason: 'fixture' } }; };
    factory.batch.configure({ target: 2, maxInFlight: 1, intakeWindow: 1 });
    factory.batch.pump(Date.now() + 60000); await factory.runtime.settle();
    assert.deepEqual(resumed, ['curation/copy-review']);
    assert.equal(batchSummary(factory.state)?.admitted, 2);
    assert.equal(batchSummary(factory.state)?.completed, 1);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});
