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
const { SourceSupervisor } = await import('../server/sources.ts');
const { OperationUnknownError } = await import('../server/operations.ts');
import type { StationResult } from '../server/runtime.ts';

const close = async (factory: InstanceType<typeof Factory>) => {
  factory.recovery.close(); await factory.sources.close();
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
    return node.key === 'curation/reader' ? reportedReply()
      : {ok: true, summary: 'Accepted program result', finish: {status: 'published', reason: 'Fixture publication'}};
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
      return reportedReply();
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

const reportedReply = (): StationResult => ({
  ok: true, summary: 'Fixture real-station receipt', finish: {status: 'published', reason: 'fixture'},
  metrics: {usageReported: true, execution: {adapter: 'fixture', model: 'local-fixture'},
    time: {firstTokenMs: 1, outputMs: 1, toolMs: 0, programMs: 0, modelCalls: 1, toolCalls: 0}},
});
const recoveryPlan = (factory: InstanceType<typeof Factory>) => {
  const token = Object.values(factory.state.tokens).findLast(value => !value.data.retriedBy && value.data.__runtimeRecovery);
  assert.ok(token, 'a durable recovery plan is required');
  return {token, plan: token.data.__runtimeRecovery as {state: string; nextAt: number; modelFailures: number; networkAttempts: number}};
};
const settleRecovery = async (factory: InstanceType<typeof Factory>) => {
  await new Promise<void>(resolve => setImmediate(resolve));
  await factory.runtime.settle();
  await new Promise<void>(resolve => setImmediate(resolve));
};

test('unmanaged manual work uses hour-scale single-station probes without inventing a batch goal', {timeout: 30000}, async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  const factory = await ready();
  let calls = 0;
  let scouts = 0;
  let healthy = false;
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  const trialEntered = new Promise<void>(resolve => {entered = resolve;});
  factory.runtime.executors = node => async ctx => {
    if (node.key === 'curation/scout') {
      scouts++;
      ctx.addEvidence({id: 'unmanaged-evidence', kind: 'text', label: 'Existing paid preparation'});
      return {ok: true, summary: 'Saved preparation', data: {canonical: ctx.token.url, retained: 'original evidence'}};
    }
    assert.equal(node.key, 'curation/reader');
    assert.equal(ctx.token.data.retained, 'original evidence');
    calls++;
    if (!healthy) return transport();
    entered();
    await held;
    return reportedReply();
  };
  try {
    factory.runtime.start('Unmanaged model continuity');
    factory.runtime.create('curation/scout', {item: 'manual-model', url: 'https://fixture.example/', source: 'manual'});
    await settleRecovery(factory);
    assert.equal(factory.state.batch, undefined);
    for (const delay of [30000, 60000, 120000, 900000, 900000, 900000, 900000]) {
      const {plan} = recoveryPlan(factory);
      assert.equal(plan.nextAt - Date.now(), delay);
      const before = calls;
      t.mock.timers.tick(delay - 1);
      factory.recovery.pump();
      await settleRecovery(factory);
      assert.equal(calls, before);
      t.mock.timers.tick(1);
      for (let i = 0; i < 4; i++) factory.recovery.pump();
      await settleRecovery(factory);
      assert.equal(calls, before + 1);
      assert.equal(scouts, 1);
      assert.ok(factory.broker.modelHold);
    }
    healthy = true;
    t.mock.timers.tick(recoveryPlan(factory).plan.nextAt - Date.now());
    factory.recovery.pump();
    await trialEntered;
    const trial = recoveryPlan(factory);
    assert.equal(trial.plan.state, 'trial');
    assert.equal(factory.broker.recoveryToken, trial.token.id);
    factory.runtime.create('curation/reader', {
      item: 'waiting-manual', url: 'https://waiting.example/', source: 'manual', data: {retained: 'original evidence'},
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 9, 'the next manual task cannot run during the recovery trial');
    release();
    await settleRecovery(factory);
    assert.equal(calls, 10);
    assert.equal(factory.broker.recoveryToken, null);
    assert.equal(factory.broker.modelHold, null);
    assert.equal(factory.state.alerts['model-transport'], undefined);
    assert.equal(factory.state.batch, undefined);
    assert.ok(factory.state.tokens[trial.token.id].evidence.some(id => factory.state.evidence[id].meta?.reusedFrom));
  } finally {
    release();
    await close(factory);
    cleanup();
  }
});

test('unmanaged paused and interrupted trials retain their deadline and resume the same token', {timeout: 30000}, async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  let factory = await ready();
  let calls = 0;
  let interrupted!: () => void;
  const entered = new Promise<void>(resolve => {interrupted = resolve;});
  try {
    factory.runtime.executors = () => async () => {calls++; return transport();};
    factory.runtime.start('Unmanaged restart');
    factory.runtime.create('curation/reader', {item: 'restart-model', url: 'https://fixture.example/', source: 'manual', data: {retained: 'saved'}});
    await settleRecovery(factory);
    const deadline = recoveryPlan(factory).plan.nextAt;
    factory.runtime.pause();
    t.mock.timers.tick(3600000);
    factory.recovery.pump();
    await settleRecovery(factory);
    assert.equal(calls, 1);
    await close(factory);
    factory = await ready();
    assert.equal(recoveryPlan(factory).plan.nextAt, deadline);
    factory.runtime.setScopePaused({scope: 'station', key: 'curation/reader', paused: true, reason: 'Inspect fixture'});
    factory.runtime.resume();
    factory.recovery.pump();
    await settleRecovery(factory);
    assert.equal(calls, 1);
    factory.runtime.executors = () => async ctx => {
      calls++;
      interrupted();
      await new Promise<void>((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), {once: true}));
      return transport();
    };
    factory.runtime.setScopePaused({scope: 'station', key: 'curation/reader', paused: false, reason: 'Continue fixture'});
    factory.recovery.pump();
    await entered;
    const trial = recoveryPlan(factory).token.id;
    const count = factory.runtime.tokens.size;
    factory.runtime.pause();
    await close(factory);
    factory = await ready();
    assert.equal(recoveryPlan(factory).token.id, trial);
    assert.equal(recoveryPlan(factory).plan.state, 'waiting');
    assert.ok(recoveryPlan(factory).plan.nextAt >= Date.now() + 30000);
    factory.runtime.executors = () => async ctx => {
      calls++;
      assert.equal(ctx.token.id, trial);
      assert.equal(ctx.token.data.retained, 'saved');
      return reportedReply();
    };
    t.mock.timers.tick(recoveryPlan(factory).plan.nextAt - Date.now());
    factory.recovery.pump();
    await settleRecovery(factory);
    assert.equal(calls, 2);
    factory.runtime.resume();
    factory.recovery.pump();
    await settleRecovery(factory);
    assert.equal(calls, 3);
    assert.equal(factory.runtime.tokens.size, count);
    assert.equal(factory.state.tokens[trial].status, 'published');
    assert.equal(factory.broker.modelHold, null);
  } finally {
    await close(factory);
    cleanup();
  }
});

test('unmanaged recovery cannot clear model hold without a receipt or retry user and uncertain failures', {timeout: 30000}, async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  for (const boundary of ['no-receipt', 'credentials', 'tls', 'uncertain', 'cancel', 'read-only'] as const) {
    const factory = await ready();
    const priorReadOnly = process.env.FACTORY_READONLY;
    let calls = 0;
    try {
      factory.runtime.executors = () => async () => {
        calls++;
        if (boundary === 'uncertain') return {ok: false, summary: 'Unknown external write',
          failure: new OperationUnknownError('fixture-operation').failure};
        if (boundary === 'credentials') return {ok: false, summary: 'Credentials rejected', failure: classifyFailure('Unauthorized', {stage: 'model', status: 401})};
        if (boundary === 'tls') return {ok: false, summary: 'Certificate rejected', failure: classifyFailure('CERT_HAS_EXPIRED', {stage: 'model'})};
        return calls === 1 ? transport() : {ok: true, summary: 'Only program output', finish: {status: 'published', reason: 'fixture'}};
      };
      factory.runtime.start('Unmanaged boundary ' + boundary);
      factory.runtime.create('curation/reader', {item: boundary, url: 'https://fixture.example/', source: 'manual'});
      await settleRecovery(factory);
      if (boundary === 'cancel') factory.runtime.end();
      if (boundary === 'read-only') process.env.FACTORY_READONLY = '1';
      for (let i = 0; i < 3; i++) {
        t.mock.timers.tick(3600000);
        factory.recovery.pump();
        await settleRecovery(factory);
      }
      assert.equal(calls, boundary === 'no-receipt' ? 2 : 1, boundary);
      if (boundary === 'no-receipt') {
        assert.equal(recoveryPlan(factory).plan.state, 'blocked');
        assert.ok(factory.broker.modelHold);
        assert.ok(factory.state.alerts['model-transport']);
      }
      if (boundary === 'uncertain') assert.equal(Object.values(factory.state.tokens)[0].status, 'manual');
    } finally {
      if (priorReadOnly === undefined) delete process.env.FACTORY_READONLY;
      else process.env.FACTORY_READONLY = priorReadOnly;
      await close(factory);
      cleanup();
    }
  }
});

test('source and channel model failures each restore their own checkpoint and release fresh source intake', {timeout: 30000}, async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  for (const origin of ['source', 'channel'] as const) {
    const factory = await ready();
    const item = `${origin}-model`;
    const station = origin === 'source' ? 'curation/reader' : 'components/describe';
    const prepare = origin === 'source' ? 'curation/scout' : 'components/adapter';
    let calls = 0;
    let prepared = 0;
    let fresh = 0;
    factory.runtime.executors = node => async ctx => {
      if (ctx.token.item === 'fresh-next') {
        fresh++;
        return {ok: true, summary: 'Next source progressed', finish: {status: 'published', reason: 'fixture'}};
      }
      if (node.key === prepare) {
        prepared++;
        return {ok: true, summary: 'Preserved upstream work', data: {retained: 'paid artifact', canonical: ctx.token.url}};
      }
      if (node.key === station) {
        calls++;
        assert.equal(ctx.token.data.retained, 'paid artifact');
        return calls === 1 ? transport() : reportedReply();
      }
      return {ok: true, summary: 'Fixture program'};
    };
    try {
      await factory.sources.close();
      factory.sources = new SourceSupervisor(factory);
      factory.sources.configure({id: 'fixture', name: 'Fixture source', url: 'https://feed.example/items',
        platform: 'fixture', format: 'json', target: 'candidates/tidy', intervalMs: 86400000, enabled: true});
      const candidate = (id: string) => ({id, source: 'fixture', platform: 'fixture', sourceUrl: 'https://feed.example/items',
        url: `https://${id}.example/`, title: id, discoveredAt: Date.now(), status: 'pending' as const});
      factory.runtime.start('Unmanaged model ' + origin);
      if (origin === 'source') factory.journal.append({kind: 'source.candidate', candidate: candidate(item)});
      else {
        const parent = factory.runtime.create('curation/published', {item, url: 'https://parent.example/', source: 'manual'});
        factory.journal.append({kind: 'channel.emitted', channel: 'curation.component-source.confirmed',
          token: parent.id, item, inventory: 'consumer'});
      }
      await settleRecovery(factory);
      const failed = recoveryPlan(factory).token;
      assert.equal(calls, 1);
      factory.journal.append({kind: 'source.candidate', candidate: candidate('fresh-next')});
      await settleRecovery(factory);
      assert.equal(fresh, 0, 'a provider outage holds fresh intake even when the failed task is a channel child');
      t.mock.timers.tick(recoveryPlan(factory).plan.nextAt - Date.now());
      factory.recovery.pump();
      await settleRecovery(factory);
      assert.equal(calls, 2);
      assert.equal(prepared, 1);
      assert.equal(fresh, 1);
      assert.equal(factory.broker.modelHold, null);
      const retry = Object.values(factory.state.tokens).find(token => token.data.retryOf === failed.id)!;
      assert.equal(retry.status, 'published');
      assert.equal(retry.data.retained, 'paid artifact');
      if (origin === 'channel') {
        assert.equal(retry.data.channelDelivery, failed.data.channelDelivery);
        assert.equal(factory.channels!.status()[0].status, 'acknowledged');
      } else assert.equal(factory.sources.list()[0].counts.acknowledged, 2);
    } finally {
      await close(factory);
      cleanup();
    }
  }
});

test('a recoverable tool failure before model verification retains its probe and bounded tool budget', {timeout: 30000}, async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  for (const tag of ['network_timeout', 'tool_error'] as const) {
    const factory = await ready();
    let calls = 0;
    factory.runtime.executors = () => async () => {
      calls++;
      if (calls === 1) return transport();
      if (calls === 2) return {ok: false, summary: 'Input tool temporarily failed before prompting', failure: {
        tag, category: 'system', owner: 'system', retryable: true, message: 'Fixture local input preparation failed',
      }};
      return reportedReply();
    };
    try {
      factory.runtime.start('Probe input preparation');
      factory.runtime.create('curation/reader', {item: tag, url: 'https://fixture.example/', source: 'manual'});
      await settleRecovery(factory);
      t.mock.timers.tick(recoveryPlan(factory).plan.nextAt - Date.now());
      factory.recovery.pump();
      await settleRecovery(factory);
      assert.equal(calls, 2);
      assert.equal(recoveryPlan(factory).plan.state, 'waiting');
      assert.ok(factory.broker.modelHold);
      t.mock.timers.tick(recoveryPlan(factory).plan.nextAt - Date.now());
      factory.recovery.pump();
      await settleRecovery(factory);
      assert.equal(calls, 3);
      assert.equal(recoveryPlan(factory).plan.networkAttempts, 1);
      assert.equal(recoveryPlan(factory).plan.modelFailures, 1);
      assert.equal(factory.broker.modelHold, null);
      assert.equal(recoveryPlan(factory).plan.state, 'completed');
    } finally {
      await close(factory);
      cleanup();
    }
  }
});

test('an ended unmanaged run does not retain its old model hold after a new-run connection check', {timeout: 30000}, async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  const factory = await ready();
  const {FactoryControl} = await import('../server/control.ts');
  let calls = 0;
  factory.runtime.executors = () => async () => {calls++; return calls === 1 ? transport() : reportedReply();};
  try {
    factory.runtime.start('Old unmanaged outage');
    factory.runtime.create('curation/reader', {item: 'old-outage', url: 'https://old.example/', source: 'manual'});
    await settleRecovery(factory);
    const oldRun = factory.state.run.id;
    factory.runtime.pause();
    assert.equal(factory.recovery.permitModelTrial(), true, 'an explicit check of the paused live run still requires its real station receipt');
    assert.ok(factory.broker.modelHold);
    factory.runtime.end();
    const retained = factory.recovery.permitModelTrial();
    assert.equal(retained, false, 'the ended run cannot own the next run model circuit');
    // Exercise the exact hand-off used by a successful connectivity receipt in
    // Factory.ensureReady. This fixture does not call an external model probe.
    if (!retained) factory.clearAlert('model-transport', 'Local connection fixture passed before a new run');
    t.mock.timers.tick(1);
    await new FactoryControl(factory).execute('run_control', {action: 'start', title: 'New unmanaged work'}, 'user');
    assert.notEqual(factory.state.run.id, oldRun);
    factory.runtime.create('curation/reader', {item: 'new-work', url: 'https://new.example/', source: 'manual'});
    await settleRecovery(factory);
    assert.equal(calls, 2);
    assert.equal(factory.broker.modelHold, null);
    assert.equal(Object.values(factory.state.tokens).find(token => token.item === 'new-work')?.status, 'published');
    factory.raiseAlert({id: 'model-transport', level: 'red', kind: 'model', message: 'Still-running run requires verification'});
    factory.runtime.ending = true;
    assert.equal(factory.recovery.permitModelTrial(), false, 'ending cannot release another trial');
    factory.runtime.ending = false;
    assert.equal(factory.recovery.permitModelTrial(), true, 'a running run without a usable receipt must retain its hold');
    assert.ok(factory.broker.modelHold);
  } finally {
    factory.runtime.ending = false;
    await close(factory);
    cleanup();
  }
});

test('an explicit retry rearms one exhausted model checkpoint and preserves provider backoff for manual and source work', {timeout: 30000}, async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  for (const origin of ['manual', 'source'] as const) {
    const factory = await ready();
    const item = `${origin}-explicit`;
    let calls = 0;
    let prepared = 0;
    let phase: 'exhaust' | 'model-fails' | 'healthy' = 'exhaust';
    factory.runtime.executors = node => async ctx => {
      if (node.key === 'curation/scout') {
        prepared++;
        ctx.addEvidence({id: `${origin}-preparation`, kind: 'text', label: 'Paid preparation kept'});
        return {ok: true, summary: 'Prepared once', data: {canonical: ctx.token.url, retained: 'saved artifact'}};
      }
      if (node.key !== 'curation/reader') return {ok: true, summary: 'Fixture step'};
      calls++;
      assert.equal(ctx.token.data.retained, 'saved artifact');
      if (calls <= 2 || phase === 'model-fails') return transport();
      if (phase === 'healthy') return reportedReply();
      return {ok: false, summary: 'Input tool is still unavailable', failure: {
        tag: 'tool_error', category: 'system', owner: 'system', retryable: true, message: 'Fixture local tool unavailable',
      }};
    };
    try {
      factory.runtime.start('Explicit retry ' + origin);
      if (origin === 'source') {
        await factory.sources.close();
        factory.sources = new SourceSupervisor(factory);
        factory.sources.configure({id: 'fixture', name: 'Fixture source', url: 'https://feed.example/items',
          platform: 'fixture', format: 'json', target: 'candidates/tidy', intervalMs: 86400000, enabled: true});
        factory.journal.append({kind: 'source.candidate', candidate: {id: item, source: 'fixture', platform: 'fixture',
          sourceUrl: 'https://feed.example/items', url: `https://${item}.example/`, title: item, discoveredAt: Date.now(), status: 'pending'}});
      } else factory.runtime.create('curation/scout', {item, url: 'https://fixture.example/', source: 'manual'});
      await settleRecovery(factory);
      for (let i = 0; i < 6 && recoveryPlan(factory).plan.state !== 'exhausted'; i++) {
        t.mock.timers.tick(recoveryPlan(factory).plan.nextAt - Date.now());
        factory.recovery.pump();
        await settleRecovery(factory);
      }
      assert.equal(calls, 5);
      assert.equal(recoveryPlan(factory).plan.networkAttempts, 2);
      assert.equal(recoveryPlan(factory).plan.modelFailures, 2);
      assert.equal(recoveryPlan(factory).plan.state, 'exhausted');
      for (let i = 0; i < 3; i++) {t.mock.timers.tick(3600000); factory.recovery.pump(); await settleRecovery(factory);}
      assert.equal(calls, 5, 'waiting loops cannot reset exhausted automatic budgets');
      if (origin === 'source') factory.sources.setEnabled('fixture', false);
      factory.runtime.setScopePaused({scope: 'station', key: 'curation/reader', paused: true, reason: 'Inspect explicit retry before releasing it'});
      const old = recoveryPlan(factory).token;
      const count = factory.runtime.tokens.size;
      const [requested] = factory.retryCandidates({items: [item], count: 1});
      assert.equal(factory.runtime.tokens.size, count + 1);
      assert.equal(requested.data.retryOf, old.id);
      assert.equal(recoveryPlan(factory).plan.networkAttempts, 0);
      assert.equal(recoveryPlan(factory).plan.modelFailures, 2);
      assert.equal(recoveryPlan(factory).plan.state, 'waiting');
      assert.deepEqual(factory.retryCandidates({items: [item], count: 1}), [], 'duplicate explicit requests cannot clone a claimed task');
      factory.recovery.pump();
      await settleRecovery(factory);
      assert.equal(calls, 5, 'local pause remains in force');
      factory.runtime.pause();
      factory.runtime.setScopePaused({scope: 'station', key: 'curation/reader', paused: false, reason: 'Local inspection finished'});
      factory.recovery.pump();
      await settleRecovery(factory);
      assert.equal(calls, 5, 'global pause remains in force');
      phase = 'model-fails';
      factory.runtime.resume();
      factory.recovery.pump();
      await settleRecovery(factory);
      assert.equal(calls, 6);
      assert.equal(factory.runtime.tokens.size, count + 1, 'the explicit token itself is the trial');
      assert.equal(recoveryPlan(factory).plan.modelFailures, 3);
      assert.equal(recoveryPlan(factory).plan.nextAt - Date.now(), 120000);
      assert.ok(factory.broker.modelHold, 'another provider failure cannot reopen intake');
      phase = 'healthy';
      if (origin === 'source') {
        factory.recovery.pump(recoveryPlan(factory).plan.nextAt);
        await settleRecovery(factory);
        assert.equal(calls, 6, 'parked automatic retries still respect a disabled source');
        const [again] = factory.retryCandidates({items: [item], count: 1});
        assert.equal(again.data.retryOf, requested.id);
      } else t.mock.timers.tick(recoveryPlan(factory).plan.nextAt - Date.now());
      factory.recovery.pump();
      await settleRecovery(factory);
      assert.equal(calls, 7);
      assert.equal(prepared, 1);
      assert.equal(recoveryPlan(factory).token.status, 'published');
      assert.equal(factory.broker.modelHold, null);
      assert.ok(recoveryPlan(factory).token.evidence.length > 0);
      if (origin === 'source') {
        assert.equal(factory.sources.list()[0].enabled, false, 'retrying accepted work does not reactivate collection');
        assert.equal(factory.sources.list()[0].counts.acknowledged, 1);
      }
    } finally {
      await close(factory);
      cleanup();
    }
  }
});

test('explicit retry of a failed source entry retains its input and evidence without creating a model hold', {timeout: 30000}, async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  const factory = await ready();
  let calls = 0;
  let healthy = false;
  factory.runtime.executors = node => async ctx => {
    calls++;
    assert.equal(node.key, 'candidates/tidy');
    assert.deepEqual(ctx.token.data.input, {url: 'https://source-entry.example/', selector: 'original-input'});
    if (!ctx.token.data.retryOf) ctx.addEvidence({id: 'entry-observation', kind: 'text', label: 'Original source observation'});
    return healthy ? {ok: true, summary: 'Entry recovered', finish: {status: 'published', reason: 'fixture'}}
      : {ok: false, summary: 'Entry request timed out', data: {partialResult: 'preserve failed-step output'}, failure: {
        tag: 'network_timeout', category: 'network', owner: 'system', retryable: true, message: 'Fixture timeout',
      }};
  };
  try {
    await factory.sources.close();
    factory.sources = new SourceSupervisor(factory);
    factory.sources.configure({id: 'fixture', name: 'Fixture source', url: 'https://feed.example/items', platform: 'fixture',
      format: 'json', target: 'candidates/tidy', input: {url: 'url'}, constants: {selector: 'original-input'}, intervalMs: 86400000, enabled: true});
    factory.runtime.start('Explicit source entry retry');
    factory.journal.append({kind: 'source.candidate', candidate: {id: 'entry-source', source: 'fixture', platform: 'fixture',
      sourceUrl: 'https://feed.example/items', url: 'https://source-entry.example/', title: 'Entry source', discoveredAt: Date.now(), status: 'pending'}});
    await settleRecovery(factory);
    for (let i = 0; i < 2; i++) {
      t.mock.timers.tick(recoveryPlan(factory).plan.nextAt - Date.now());
      factory.recovery.pump();
      await settleRecovery(factory);
    }
    assert.equal(recoveryPlan(factory).plan.state, 'exhausted');
    assert.equal(calls, 3);
    const previous = recoveryPlan(factory).token;
    factory.sources.setEnabled('fixture', false);
    healthy = true;
    const [retry] = factory.retryCandidates({items: ['entry-source'], count: 1});
    assert.equal(retry.source, 'source:fixture');
    assert.equal(retry.data.sourceCandidate, 'entry-source');
    assert.equal(retry.data.partialResult, 'preserve failed-step output');
    assert.equal(factory.state.tokens[previous.id].data.retriedBy, retry.id);
    assert.equal((retry.data.__runtimeRecovery as {networkAttempts: number}).networkAttempts, 0);
    assert.equal(factory.broker.modelHold, null);
    assert.equal(factory.broker.recoveryToken, null);
    await settleRecovery(factory);
    assert.equal(calls, 4);
    assert.equal(factory.state.tokens[retry.id].status, 'published');
    assert.ok(factory.state.tokens[retry.id].evidence.some(id => previous.evidence.includes(String(factory.state.evidence[id].meta?.reusedFrom))));
    assert.equal(factory.sources.list()[0].counts.acknowledged, 1);
    assert.equal(factory.sources.list()[0].enabled, false);
    assert.equal(factory.broker.modelHold, null);
  } finally {
    await close(factory);
    cleanup();
  }
});

test('an explicit new-run retry resumes every unfinished branch without replaying completed work', {timeout: 30000}, async () => {
  for (const source of ['candidates/pool', 'manual']) {
    const factory = await ready();
    const calls = new Map<string, number>();
    const branches = ['curation/reader', 'curation/classify', 'curation/classify-review'];
    factory.runtime.executors = node => async ctx => {
      calls.set(node.key, (calls.get(node.key) ?? 0) + 1);
      if (node.key === 'curation/scout') {
        ctx.addEvidence({id: 'paid-preparation', kind: 'text', label: 'Original preparation'});
        return {ok: true, summary: 'Prepared once', data: {
          canonical: ctx.token.url, kindAgreed: true, mode: 'shots', needsProof: true, retained: 'original result',
        }};
      }
      assert.equal(ctx.token.data.retained, 'original result');
      return {ok: true, summary: 'Fixture continuation', data: node.key === 'curation/gate' ? {gate: 'pass'} : undefined};
    };
    try {
      factory.runtime.start('Interrupted parallel work');
      factory.runtime.setScopePaused({scope: 'station', key: 'curation/reader', paused: true, reason: 'End with all branches queued'});
      const original = factory.runtime.create('curation/scout', {item: 'ended-parallel', url: 'https://fixture.example/', source});
      await settleRecovery(factory);
      assert.deepEqual([...original.done], ['curation/scout']);
      original.rounds['curation/proof'] = 1;
      original.notes.set('curation/reader', {reason: 'Keep the original reading contract', byHuman: true});
      factory.runtime.checkpoint(original);
      const priorRun = factory.runtime.end();
      await settleRecovery(factory);
      assert.equal(factory.state.recoveries[original.item].failure?.tag, 'run_ended');
      const [retry] = factory.retryCandidates({items: [original.item], count: 1});
      assert.notEqual(factory.state.run.id, priorRun);
      assert.equal(retry.entry, original.entry);
      assert.equal(retry.source, original.source);
      assert.equal(retry.rounds['curation/proof'], 1);
      assert.deepEqual(retry.notes.get('curation/reader'), original.notes.get('curation/reader'));
      assert.deepEqual([...retry.done], ['curation/scout']);
      for (const key of branches) {
        assert.ok(factory.runtime.queues.get(key)?.includes(retry.id), `the complete unfinished frontier includes ${key}`);
        assert.equal(factory.runtime.scopePaused(key), true, 'explicit retry cannot clear local pause');
      }
      assert.equal(factory.runtime.tokens.size, 2);
      assert.deepEqual(factory.retryCandidates({items: [original.item], count: 1}), []);
      for (const key of branches) factory.runtime.setScopePaused({scope: 'station', key, paused: false, reason: 'Resume saved work'});
      await settleRecovery(factory);
      assert.equal(factory.state.tokens[retry.id].status, 'published');
      assert.equal(calls.get('curation/scout'), 1, 'paid preparation is reused');
      for (const key of branches) assert.equal(calls.get(key), 1);
      assert.equal(calls.get('curation/gate'), 1);
      assert.equal([...factory.journal.read()].filter(event => event.kind === 'token.finished' && event.status === 'published').length, 1);
      assert.ok(factory.state.tokens[retry.id].evidence.some(id => factory.state.evidence[id].meta?.reusedFrom === 'paid-preparation'));
    } finally {
      await close(factory);
      cleanup();
    }
  }
});

test('an ended checkpoint with no runnable frontier cannot republish a completed terminal station', async () => {
  const factory = await ready();
  let calls = 0;
  factory.runtime.executors = () => async () => ({ok: true, summary: `Gate result ${++calls}`, data: {gate: 'pass'}});
  try {
    factory.runtime.start('Completed terminal checkpoint');
    const original = factory.runtime.create('curation/gate', {item: 'completed-terminal', url: 'https://fixture.example/', source: 'candidates/pool'});
    await settleRecovery(factory);
    assert.equal(factory.state.tokens[original.id].status, 'published');
    factory.runtime.end();
    // A stale recovery record may outlive the terminal station's successful
    // checkpoint. It must not turn that paid, completed station into a retry.
    factory.journal.append({kind: 'candidate.disposition', candidate: {
      item: original.item, token: original.id, url: original.url, title: original.item,
      source: original.source, disposition: 'retry', failure: {
        tag: 'run_ended', category: 'system', message: 'Legacy unfinished record', retryable: true,
      },
    }});
    const count = factory.runtime.tokens.size;
    assert.throws(() => factory.retryCandidates({items: [original.item], count: 1}),
      error => error instanceof Error && 'status' in error && error.status === 409);
    assert.equal(factory.runtime.tokens.size, count);
    assert.equal(calls, 1);
    assert.equal([...factory.journal.read()].filter(event => event.kind === 'token.finished' && event.status === 'published').length, 1);
    factory.runtime.start('Validation failure did not corrupt storage');
    assert.equal(factory.runtime.running, true);
  } finally {
    await close(factory);
    cleanup();
  }
});

test('network recovery shares an empty slot only outside the paused task and full saved entry closure', {timeout: 30000}, async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  for (const entry of ['curation/scout', 'candidates/route']) {
    const factory = await ready();
    let calls = 0;
    factory.runtime.executors = node => async ctx => {
      if (ctx.token.item === 'paused-skill') return {ok: true, summary: 'Released paused task', finish: {status: 'published', reason: 'fixture'}};
      if (node.key !== 'curation/reader') return {ok: true, summary: 'Saved preparation', data: {canonical: ctx.token.url}};
      calls++;
      return calls === 1 ? {ok: false, summary: 'Temporary network failure', failure: {
        tag: 'network_timeout', category: 'network', owner: 'system', retryable: true, message: 'Fixture timeout',
      }} : {ok: true, summary: 'Saved checkpoint recovered', finish: {status: 'published', reason: 'fixture'}};
    };
    try {
      factory.runtime.start('Independent paused work and network retry');
      factory.runtime.setScopePaused({scope: 'line', key: 'skills', paused: true, reason: 'Inspect another workflow'});
      const paused = factory.runtime.create('skills/fetch-file', {item: 'paused-skill', url: 'https://skill.example/', source: 'manual'});
      factory.runtime.create(entry, {item: 'network-retry', url: 'https://fixture.example/', source: 'manual', data: {route: 'curation', express: true}});
      await settleRecovery(factory);
      assert.equal(calls, 1);
      const due = recoveryPlan(factory).plan.nextAt;
      t.mock.timers.tick(due - Date.now());
      factory.recovery.pump();
      await settleRecovery(factory);
      assert.equal(factory.state.tokens[paused.id].status, 'active');
      if (entry === 'candidates/route') {
        assert.equal(calls, 1, 'the original intake closure includes Skills, even when the failed station does not');
        factory.runtime.setScopePaused({scope: 'line', key: 'skills', paused: false, reason: 'Resume the shared bottleneck'});
        await settleRecovery(factory);
        factory.recovery.pump();
        await settleRecovery(factory);
      }
      assert.equal(calls, 2, 'a paused unrelated workflow cannot starve this due recovery');
      assert.equal(recoveryPlan(factory).token.status, 'published');
      assert.equal(recoveryPlan(factory).plan.networkAttempts, 1);
    } finally {
      await close(factory);
      cleanup();
    }
  }
});
