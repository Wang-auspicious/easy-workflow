import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-model-circuit-'));
process.env.FACTORY_VAR = dir; process.env.FACTORY_PREFLIGHT = '0'; process.env.FACTORY_HTTP_CACHE = '0';
process.env.VISLEXICON_ROOT = path.join(dir, 'unconnected');
const { Factory } = await import('../server/factory.ts');
const { batchSummary } = await import('../shared/batch.ts');
const { classifyFailure } = await import('../shared/failures.ts');
import type { StationResult } from '../server/runtime.ts';

const close = async (factory: InstanceType<typeof Factory>) => {
  factory.channels?.close(); await factory.runtime.close(); factory.docs.flush(); factory.lessons.close(); factory.journal.close();
};
const cleanup = () => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); };
const transport = (): StationResult => ({ ok: false, summary: 'Model request timed out', failure: classifyFailure('Request timed out.', { stage: 'model' }) });
const ready = async () => {
  const factory = new Factory(); await factory.boot(); factory.broker.memoryFloorMB = 0;
  Object.assign(factory.broker.limits, { model: 1, browser: 2, cpu: 2 });
  for (const key of ['curation/classify', 'curation/classify-review']) factory.runtime.setScopePaused({ scope: 'station', key, paused: true, reason: 'Isolate the fixture model station from parallel business branches' });
  factory.catalog = Array.from({ length: 4 }, (_, i) => ({ id: `site-${i}`, name: `Site ${i}`, canonicalUrl: `https://fixture-${i}.example/` }));
  return factory;
};
const start = (factory: InstanceType<typeof Factory>, target = 2) => {
  factory.runtime.start('Single real model trial');
  factory.runtime.create('curation/scout', { item: 'checkpoint-site', url: 'https://checkpoint.example/', source: 'manual' });
  factory.batch.configure({ target, maxInFlight: 1, intakeWindow: 1 });
};

test('an hour-long model outage sends one trial per deadline and reopens intake only after its real station succeeds', async t => {
  const began = Date.now(); t.mock.timers.enable({ apis: ['Date'], now: began });
  const factory = await ready(); let calls = 0, scouts = 0, healthy = false, release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), trialEntered = new Promise<void>(resolve => { entered = resolve; });
  factory.runtime.executors = node => async ctx => {
    if (node.key === 'curation/scout') { scouts++; return { ok: true, summary: 'Persisted upstream evidence', data: { canonical: ctx.token.url, retained: 'original evidence' } }; }
    if (node.key === 'curation/reader') {
      calls++; assert.equal(ctx.token.data.retained, 'original evidence');
      if (!healthy) return transport(); entered(); await held;
    }
    return { ok: true, summary: 'Accepted station result', finish: { status: 'published', reason: 'Fixture publication' } };
  };
  try {
    start(factory); await factory.runtime.settle();
    for (const delay of [30000, 60000, 120000, 900000, 900000, 900000, 900000]) {
      const due = factory.state.batch!.modelCircuit!.nextAt, prior = calls;
      assert.equal(due - Date.now(), delay);
      t.mock.timers.tick(delay - 1); factory.batch.pump(); await factory.runtime.settle(); assert.equal(calls, prior);
      t.mock.timers.tick(1); for (let i = 0; i < 5; i++) factory.batch.pump(); await factory.runtime.settle();
      assert.equal(calls, prior + 1); assert.equal(batchSummary(factory.state)!.admitted, 1);
      assert.equal(scouts, 1); assert.ok(factory.broker.modelHold);
    }
    assert.ok(Date.now() - began > 3600000); assert.equal(calls, 8);
    assert.ok(Object.values(factory.state.tokens).every(token => !token.data.batchRecovery));
    healthy = true; t.mock.timers.tick(factory.state.batch!.modelCircuit!.nextAt - Date.now()); factory.batch.pump();
    await trialEntered; assert.equal(factory.state.batch!.modelCircuit!.state, 'trial');
    assert.equal(batchSummary(factory.state)!.admitted, 1, 'an in-flight probe does not reopen bulk admission');
    release(); await factory.runtime.settle();
    assert.equal(factory.state.batch!.modelCircuit, undefined); assert.equal(factory.broker.modelHold, null);
    assert.equal(batchSummary(factory.state)!.completed, 2); assert.equal(scouts, 1);
  } finally { release(); await close(factory); cleanup(); }
});

test('global pause, station pause and stopped admission do not send overdue probes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); const factory = await ready(); let calls = 0;
  factory.runtime.executors = node => async ctx => node.key === 'curation/scout'
    ? { ok: true, summary: 'Evidence', data: { canonical: ctx.token.url } } : (calls++, transport());
  try {
    start(factory); await factory.runtime.settle(); assert.equal(calls, 1);
    factory.runtime.pause(); t.mock.timers.tick(3600000); factory.batch.pump(); await factory.runtime.settle(); assert.equal(calls, 1);
    factory.runtime.setScopePaused({ scope: 'station', key: 'curation/reader', paused: true, reason: 'Inspect the real model station' });
    factory.runtime.resume(); factory.batch.pump(); await factory.runtime.settle(); assert.equal(calls, 1);
    factory.batch.setMode('stopped'); factory.runtime.setScopePaused({ scope: 'station', key: 'curation/reader', paused: false, reason: 'Inspection done' });
    t.mock.timers.tick(3600000); factory.batch.pump(); await factory.runtime.settle(); assert.equal(calls, 1);
  } finally { await close(factory); cleanup(); }
});

test('restart preserves an existing long deadline and migrates a legacy permanent transport hold once', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); let factory = await ready();
  factory.runtime.executors = node => async ctx => node.key === 'curation/scout' ? { ok: true, summary: 'Evidence', data: { canonical: ctx.token.url } } : transport();
  try {
    start(factory); await factory.runtime.settle(); factory.runtime.pause();
    const deadline = Date.now() + 900000;
    factory.journal.append({ kind: 'batch.configured', batch: { ...factory.state.batch!, modelCircuit: { state: 'open', failures: 4, nextAt: deadline } } });
    await close(factory); t.mock.timers.tick(300000); factory = await ready();
    assert.equal(factory.state.batch!.modelCircuit!.nextAt, deadline); assert.equal(factory.runtime.paused, true);
    const count = factory.runtime.tokens.size; t.mock.timers.tick(3600000); factory.batch.pump(); await factory.runtime.settle(); assert.equal(factory.runtime.tokens.size, count);
    factory.journal.append({ kind: 'batch.configured', batch: { ...factory.state.batch!, modelCircuit: { state: 'open', failures: 4, nextAt: 0 } } });
    await close(factory); factory = await ready(); const migrated = factory.state.batch!.modelCircuit!.nextAt;
    assert.equal(migrated, Date.now() + 900000);
    await close(factory); t.mock.timers.tick(60000); factory = await ready(); assert.equal(factory.state.batch!.modelCircuit!.nextAt, migrated);
  } finally { await close(factory); cleanup(); }
});

test('an interrupted trial resumes the same saved token after cooling down, without creating duplicate work', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); let factory = await ready(); let probing = false, entered!: () => void;
  const trialEntered = new Promise<void>(resolve => { entered = resolve; });
  factory.runtime.executors = node => async ctx => {
    if (node.key === 'curation/scout') return { ok: true, summary: 'Evidence', data: { canonical: ctx.token.url, retained: 'original evidence' } };
    if (!probing) return transport(); entered();
    await new Promise<void>((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }));
    return transport();
  };
  try {
    start(factory, 1); await factory.runtime.settle(); probing = true;
    t.mock.timers.tick(factory.state.batch!.modelCircuit!.nextAt - Date.now()); factory.batch.pump(); await trialEntered;
    const token = factory.state.batch!.modelCircuit!.trialToken!, count = factory.runtime.tokens.size;
    factory.runtime.pause(); await close(factory); factory = await ready();
    assert.equal(factory.state.batch!.modelCircuit!.trialToken, token); assert.equal(factory.state.batch!.modelCircuit!.state, 'open');
    assert.equal(factory.runtime.tokens.size, count);
    let calls = 0; factory.runtime.executors = node => async ctx => {
      calls++; assert.equal(node.key, 'curation/reader'); assert.equal(ctx.token.id, token); assert.equal(ctx.token.data.retained, 'original evidence');
      return { ok: true, summary: 'Recovered real station', finish: { status: 'published', reason: 'Fixture publication' } };
    };
    t.mock.timers.tick(factory.state.batch!.modelCircuit!.nextAt - Date.now()); factory.batch.pump(); await factory.runtime.settle(); assert.equal(calls, 0);
    factory.runtime.resume(); factory.batch.pump(); await factory.runtime.settle();
    assert.equal(calls, 1); assert.equal(factory.runtime.tokens.size, count); assert.equal(factory.state.tokens[token].status, 'published');
    assert.equal(factory.state.batch!.modelCircuit, undefined);
  } finally { await close(factory); cleanup(); }
});

test('model certificate, authentication and balance failures retain a manual hold instead of slow automatic probes', async t => {
  for (const [error, status] of [['CERT_HAS_EXPIRED', undefined], ['self signed certificate', undefined], ['Unauthorized', 401], ['Payment required', 402], ['Forbidden', 403], ['insufficient balance', undefined]] as const) {
    const failure = classifyFailure(error, { stage: 'model', status }); assert.equal(failure.tag, 'model_unavailable'); assert.equal(failure.owner, 'user');
  }
  assert.equal(classifyFailure('Client network socket disconnected before secure TLS connection was established', { stage: 'model' }).tag, 'model_transport');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); const factory = await ready(); let calls = 0, credentialFailure = false;
  factory.runtime.executors = node => async ctx => node.key === 'curation/scout' ? { ok: true, summary: 'Evidence', data: { canonical: ctx.token.url } } : (calls++, credentialFailure
    ? { ok: false, summary: 'Model credentials rejected', failure: classifyFailure('Unauthorized', { stage: 'model', status: 401 }) } : transport());
  try {
    start(factory); await factory.runtime.settle(); credentialFailure = true;
    t.mock.timers.tick(factory.state.batch!.modelCircuit!.nextAt - Date.now()); factory.batch.pump(); await factory.runtime.settle(); assert.equal(calls, 2);
    for (let i = 0; i < 4; i++) { t.mock.timers.tick(3600000); factory.batch.pump(); await factory.runtime.settle(); }
    assert.equal(calls, 2); assert.ok(factory.state.alerts.model); assert.ok(factory.broker.modelHold); assert.equal(batchSummary(factory.state)!.admitted, 1);
  } finally { await close(factory); cleanup(); }
});
