import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allocateResource } from '../server/allocation.ts';
import { Runtime } from '../server/runtime.ts';
import { Journal } from '../server/journal.ts';
import { Broker } from '../server/broker.ts';
import { compile } from '../server/spec/compile.ts';
import { line, station, type Pack } from '../server/spec/dsl.ts';
import { apply, initialState } from '../shared/project.ts';
import {checkModelAdmission} from '../server/model-requests.ts';
import {flowWindow, intakeFrontier} from '../shared/batch.ts';

const pack: Pack = { id: 'test-allocation', name: 'Allocation fixture', blurb: 'Fixture work', version: '1', resources: { browser: 0, model: 0, http: 0, cpu: 4 }, lines: ['fast', 'slow'].map((id, index) => line({ id, name: id, layer: 3, priority: 'mid', wired: true, blurb: 'Fixture work',
  stations: [station({ id: 'work', name: id, role: 'process', kind: 'program', resource: 'cpu', accept: ['Fixture result exists'], estimateSeconds: index ? 3 : 1, workers: { min: 1, max: 4, initial: 4, policy: 'auto' } }), station({ id: 'published', name: 'done', role: 'store', kind: 'store' })], edges: [['work', 'published']] })), channels: [], links: [], conditions: {}, order: ['fast', 'slow'], collapsed: [], hints: {} };
function setup(fixturePack = pack, limits: Record<string, number> = {cpu: 4}) {
  const compiled = compile([fixturePack]); assert.deepEqual(compiled.issues, []);
  const journal = new Journal(':memory:'), broker = new Broker(limits, 0);
  const state = initialState(compiled); journal.subscribeProjection(event => apply(state, event));
  const runtime = new Runtime(compiled, journal, broker, {}, () => async () => ({ ok: true, summary: 'fixture' }));
  runtime.roleResolver = key => ({ station: key, path: `fixture/${key}/ROLE.md`, revision: 'fixture', content: 'Complete the fixture work.' });
  runtime.ensureWorkers([]); runtime.start('allocation fixture');
  return { runtime, broker, journal, state };
}

test('scarce quotas follow lambda times service time, caps, and the review reserve', () => {
  assert.deepEqual(Object.fromEntries(allocateResource(4, [{ key: 'fast', work: 1, max: 4 }, { key: 'slow', work: 3, max: 4 }])), { fast: 1, slow: 3 });
  assert.deepEqual(Object.fromEntries(allocateResource(4, [{ key: 'capped', work: 100, max: 1 }, { key: 'other', work: 1, max: 4 }])), { capped: 1, other: 3 });
  assert.equal(allocateResource(2, [{ key: 'production', work: 100, max: 2 }, { key: 'review', work: 1, max: 2, review: true }], true).get('review'), 1);
});

test('model worker capacity is independent of real request capacity and keeps the review reserve', async () => {
  const broker = new Broker({model: 1, modelWorkers: 3, cpu: 2}, 0);
  assert.equal(broker.capacity('model'), 3);
  assert.equal(broker.capacity('cpu'), 2);
  assert.equal(broker.modelRequests.limit, 1);
  const first = broker.tryAcquire('model');
  const second = broker.tryAcquire('model');
  assert.ok(first);
  assert.ok(second);
  assert.equal(broker.tryAcquire('model'), null, 'the third worker remains available to reviewers');
  const review = broker.tryAcquire('model', {review: true});
  assert.ok(review);
  assert.equal(broker.tryAcquire('model', {review: true}), null);
  const request = await broker.modelRequests.acquire();
  assert.equal(broker.modelRequests.active, 1);
  assert.equal(broker.sample().limits.modelWorkers, 3);
  assert.equal(broker.sample().modelRequests.limit, 1);
  request();
  first.release();
  second.release();
  review.release();
  broker.limits.modelWorkers = 1;
  const explicitSingle = broker.tryAcquire('model');
  assert.ok(explicitSingle);
  assert.equal(broker.tryAcquire('model', {review: true}), null, 'an explicit one-worker limit stays one');
  explicitSingle.release();
  assert.equal(new Broker({model: 2}, 0).capacity('model'), 2, 'direct legacy Broker callers retain their limit');
});

test('allocation uses model worker capacity without changing actual request capacity', async () => {
  const modelPack: Pack = {...pack, lines: pack.lines.map(entry => ({...entry, stations: entry.stations.map(node =>
    node.kind === 'store' ? node : {...node, kind: 'agent' as const, resource: 'model' as const})}))};
  const {runtime, broker, journal, state} = setup(modelPack, {model: 1, modelWorkers: 3});
  const started: string[] = [];
  const releases: (() => void)[] = [];
  runtime.executors = node => async () => {
    started.push(node.key);
    await new Promise<void>(resolve => releases.push(resolve));
    return {ok: true, summary: 'independent lifecycle completed'};
  };
  try {
    const first = runtime.create('fast/work', {item: 'first', url: '', source: 'fixture'});
    const second = runtime.create('slow/work', {item: 'second', url: '', source: 'fixture'});
    await Promise.resolve();
    assert.deepEqual(started.sort(), ['fast/work', 'slow/work']);
    assert.equal(broker.used.model, 2);
    assert.equal(broker.modelRequests.limit, 1);
    releases.forEach(release => release());
    await runtime.settle();
    assert.deepEqual([state.tokens[first.id].status, state.tokens[second.id].status], ['published', 'published']);
  } finally {
    releases.forEach(release => release());
    await runtime.close();
    journal.close();
  }
});

test('Factory migrates model workers once, preserves explicit limits and never writes a read-only project', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-worker-limits-'));
  const file = path.join(directory, 'settings.json');
  const previous = process.env.FACTORY_READONLY;
  delete process.env.FACTORY_READONLY;
  const saved = {model: 1, browser: 2, browserCapV2: true, cpu: 2, http: 2, retained: 'unrelated setting'};
  fs.writeFileSync(file, JSON.stringify(saved));
  const {Factory} = await import('../server/factory.ts');
  try {
    const migrated = new Factory(directory);
    try {
      assert.equal(migrated.settings.modelWorkers, 3);
      assert.equal(migrated.settings.model, 1);
      assert.equal(migrated.settings.browser, 2);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {...saved, modelWorkers: 3});
    } finally {
      migrated.journal.close();
    }
    fs.writeFileSync(file, JSON.stringify({...saved, model: 6, modelWorkers: 3}));
    const restarted = new Factory(directory);
    try {
      assert.equal(restarted.settings.modelWorkers, 3, 'later request-quota changes do not silently change the worker limit');
      assert.equal(restarted.settings.model, 6);
    } finally {
      restarted.journal.close();
    }
    const explicit = JSON.stringify({...saved, modelWorkers: 1});
    fs.writeFileSync(file, explicit);
    const single = new Factory(directory);
    try {
      assert.equal(single.settings.modelWorkers, 1);
      assert.equal(fs.readFileSync(file, 'utf8'), explicit);
    } finally {
      single.journal.close();
    }
    const legacy = JSON.stringify(saved);
    fs.writeFileSync(file, legacy);
    process.env.FACTORY_READONLY = '1';
    const readOnly = new Factory(directory);
    try {
      assert.equal(readOnly.settings.modelWorkers, 3);
      assert.equal(fs.readFileSync(file, 'utf8'), legacy);
    } finally {
      readOnly.journal.close();
    }
  } finally {
    if (previous === undefined) delete process.env.FACTORY_READONLY;
    else process.env.FACTORY_READONLY = previous;
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
  }
});

test('flow windows use the graph and observations while respecting zero capacity and explicit ceilings', () => {
  const compiled = compile([pack]);
  const estimates = flowWindow(compiled, 'fast/work', {cpu: 4}, new Map());
  assert.ok(estimates.maxInFlight >= 2 && estimates.maxInFlight <= 6);
  assert.ok(estimates.intakeWindow >= 1 && estimates.intakeWindow <= 2);
  assert.deepEqual(intakeFrontier(compiled, 'fast/work'), ['fast/work']);
  assert.deepEqual(flowWindow(compiled, 'fast/published', {cpu: 4}, new Map()), {maxInFlight: 1, intakeWindow: 1});
  assert.deepEqual(flowWindow(compiled, 'fast/work', {cpu: 0}, new Map()), {maxInFlight: 1, intakeWindow: 1});
  assert.deepEqual(flowWindow(compiled, 'fast/work', {cpu: 4}, new Map(),
    {maxInFlightLimit: 1, intakeWindowLimit: 1}), {maxInFlight: 1, intakeWindow: 1});
  const observed = new Map([['fast/work', {serviceSeconds: 10, workers: 2, samples: 10}]]);
  assert.ok(flowWindow(compiled, 'fast/work', {cpu: 2}, observed).maxInFlight <= 6);
  assert.deepEqual(flowWindow(compiled, 'missing/entry', {cpu: 4}, new Map()), {maxInFlight: 1, intakeWindow: 1});
  const serial = compile([{...pack, lines: [line({...pack.lines[0], stations: [
    station({...pack.lines[0].stations[0], workers: {min: 1, max: 1, initial: 1, policy: 'fixed'}}),
    station({id: 'slow', name: 'Slow', role: 'process', kind: 'program', resource: 'cpu',
      estimateSeconds: 10, accept: ['Local receipt exists'], workers: {min: 1, max: 3, initial: 2, policy: 'auto'}}),
    pack.lines[0].stations[1],
  ], edges: [['work', 'slow'], ['slow', 'published']]})], order: ['fast']}]);
  assert.deepEqual(serial.issues, []);
  const samples = new Map([['fast/slow', {serviceSeconds: 0.1, workers: 2, samples: 9}]]);
  assert.equal(flowWindow(serial, 'fast/work', {cpu: 4}, samples).maxInFlight, 4,
    'fewer than ten observations retain the declared slow-stage estimate');
  samples.get('fast/slow')!.samples = 10;
  assert.equal(flowWindow(serial, 'fast/work', {cpu: 4}, samples).maxInFlight, 3,
    'the measured bottleneck changes the bounded window without raising CPU quota');
});

test('the actual scheduler admits one fast and three slow jobs within four shared CPU leases', async () => {
  const { runtime, broker, journal } = setup();
  const started: string[] = [], release: (() => void)[] = [];
  let hold = true;
  runtime.executors = node => async () => { started.push(node.key); if (hold) await new Promise<void>(resolve => release.push(resolve)); return { ok: true, summary: 'fixture' }; };
  try {
    for (const line of ['fast', 'slow']) for (let i = 0; i < 4; i++) runtime.create(`${line}/work`, { item: `${line}-${i}`, url: '', source: 'fixture' });
    await Promise.resolve();
    assert.equal(started.filter(key => key === 'fast/work').length, 1);
    assert.equal(started.filter(key => key === 'slow/work').length, 3);
    assert.equal(broker.used.cpu, 4);
    hold = false; release.forEach(resolve => resolve()); await runtime.settle();
    assert.equal([...runtime.tokens.values()].filter(token => token.finished).length, 8);
    assert.equal(broker.used.cpu, 0);
  } finally { hold = false; release.forEach(resolve => resolve()); await runtime.close(); journal.close(); }
});

test('browser memory protection explains a zero allocation and resumes queued work without changing the floor', async () => {
  const browserPack: Pack = {...pack, lines: [line({...pack.lines[0], stations: [
    station({...pack.lines[0].stations[0], resource: 'browser',
      workers: {min: 1, max: 1, initial: 1, policy: 'fixed'}}),
    pack.lines[0].stations[1],
  ]})], order: ['fast']};
  const {runtime, broker, journal, state} = setup(browserPack, {browser: 1});
  let freeMemMB = 2475;
  broker.memoryFloorMB = 3072;
  broker.freeMem = () => freeMemMB;
  const calls: string[] = [];
  runtime.executors = () => async context => {
    calls.push(context.token.id);
    return {ok: true, summary: 'Browser fixture completed'};
  };
  try {
    const first = runtime.create('fast/work', {item: 'memory-wait', url: '', source: 'fixture'});
    await runtime.settle();
    assert.equal(broker.effectiveBrowser(), 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(runtime.queues.get('fast/work'), [first.id]);
    assert.equal(state.tokens[first.id].attempts.length, 0, 'resource waiting is not a failed attempt');
    assert.match(runtime.waiting['fast/work'], /空闲内存 2475MB < 3072MB/);
    assert.doesNotMatch(runtime.waiting['fast/work'], /到达率/);

    freeMemMB = 3305;
    runtime.balance();
    await runtime.settle();
    assert.deepEqual(calls, [first.id], 'the regular balance tick observes recovery without a released lease');
    assert.equal(state.tokens[first.id].status, 'published');
    assert.equal(broker.used.browser, 0);

    freeMemMB = 2400;
    const second = runtime.create('fast/work', {item: 'paused-memory-wait', url: '', source: 'fixture'});
    await runtime.settle();
    runtime.pause();
    freeMemMB = 4096;
    runtime.balance();
    await runtime.settle();
    assert.deepEqual(calls, [first.id], 'memory recovery cannot override a user pause');
    assert.deepEqual(runtime.queues.get('fast/work'), [second.id]);
    runtime.resume();
    await runtime.settle();
    runtime.balance();
    await runtime.settle();
    assert.deepEqual(calls, [first.id, second.id], 'each retained input executes exactly once');
    assert.equal(state.tokens[second.id].status, 'published');
    assert.equal(broker.memoryFloorMB, 3072);
    assert.equal(broker.limits.browser, 1);
  } finally {
    await runtime.close();
    journal.close();
  }
});

test('station and line pauses preserve queued inputs while unrelated lines continue', async () => {
  const { runtime, journal, state } = setup(); const calls: string[] = [];
  runtime.executors = node => async () => { calls.push(node.key); return { ok: true, summary: 'fixture' }; };
  try {
    runtime.setScopePaused({ scope: 'station', key: 'fast/work', paused: true, reason: 'inspect work' });
    const fast = runtime.create('fast/work', { item: 'paused', url: '', source: 'fixture' });
    runtime.create('slow/work', { item: 'unrelated', url: '', source: 'fixture' }); await runtime.settle();
    assert.deepEqual(calls, ['slow/work']); assert.equal(fast.finished, false); assert.deepEqual(state.pausedScopes?.stations, ['fast/work']);
    runtime.setScopePaused({ scope: 'line', key: 'fast', paused: true, reason: 'inspect line' });
    runtime.setScopePaused({ scope: 'station', key: 'fast/work', paused: false, reason: 'station inspected' }); await runtime.settle();
    assert.equal(fast.finished, false, 'a line pause remains independent of station resume');
    runtime.setScopePaused({ scope: 'line', key: 'fast', paused: false, reason: 'continue' }); await runtime.settle();
    assert.equal(fast.finished, true); assert.deepEqual(calls, ['slow/work', 'fast/work']);
  } finally { await runtime.close(); journal.close(); }
});

test('admission distinguishes a fully paused frontier from resource waits, inflight work and missing queues', async () => {
  const fixturePack: Pack = {...pack, lines: [line({
    id: 'parallel', name: 'Parallel work', layer: 3, priority: 'mid', wired: true, blurb: 'Admission fixture',
    stations: [
      station({id: 'start', name: 'Start', role: 'process', kind: 'program', resource: 'none',
        accept: ['Both branches are queued'], workers: {min: 1, max: 1, initial: 1, policy: 'fixed'}}),
      ...['left', 'right'].map(id => station({id, name: id, role: 'process', kind: 'program', resource: 'cpu',
        accept: ['Branch is complete'], workers: {min: 1, max: 1, initial: 1, policy: 'fixed'}})),
      station({id: 'published', name: 'Done', role: 'store', kind: 'store'}),
    ],
    edges: [['start', 'left'], ['start', 'right'], ['left', 'published'], ['right', 'published']],
  }), pack.lines[1]], order: ['parallel', 'slow']};
  const {runtime, broker, journal, state} = setup(fixturePack, {cpu: 0});
  let release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  runtime.executors = node => async () => {
    if (node.key === 'slow/work') await held;
    return {ok: true, summary: 'Fixture work completed'};
  };
  try {
    runtime.setScopePaused({scope: 'station', key: 'parallel/left', paused: true, reason: 'Inspect left branch'});
    const parallel = runtime.create('parallel/start', {item: 'parallel', url: '', source: 'fixture'});
    await runtime.settle();
    assert.deepEqual(runtime.queues.get('parallel/left'), [parallel.id]);
    assert.deepEqual(runtime.queues.get('parallel/right'), [parallel.id]);
    assert.equal(broker.used.cpu, 0);
    assert.equal(runtime.occupiesAdmission(parallel, 'slow/work'), true,
      'an unpaused branch waiting for CPU still owns its admission slot');
    runtime.setScopePaused({scope: 'station', key: 'parallel/right', paused: true, reason: 'Inspect right branch'});
    assert.equal(runtime.occupiesAdmission(parallel, 'slow/work'), false,
      'a fully paused frontier releases an unrelated target');
    assert.equal(runtime.occupiesAdmission(parallel, 'parallel/start'), true,
      'the original entry includes both paused downstream branches');
    runtime.pause();
    assert.equal(runtime.occupiesAdmission(parallel, 'slow/work'), true, 'global pause cannot release intake');
    runtime.resume();

    const leftQueue = runtime.queues.get('parallel/left')!;
    const rightQueue = runtime.queues.get('parallel/right')!;
    runtime.queues.set('parallel/left', []);
    runtime.queues.set('parallel/right', []);
    assert.equal(runtime.occupiesAdmission(parallel, 'slow/work'), true,
      'an active task with only stale queuedAt entries is not proven locally paused');
    runtime.queues.set('parallel/left', leftQueue);
    runtime.queues.set('parallel/right', rightQueue);

    broker.limits.cpu = 1;
    const active = runtime.create('slow/work', {item: 'active', url: '', source: 'fixture'});
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(active.inflight.size, 1);
    runtime.setScopePaused({scope: 'line', key: 'slow', paused: true, reason: 'Pause while execution drains'});
    assert.equal(runtime.occupiesAdmission(active, 'parallel/start'), true,
      'pausing a line cannot discount an execution that has not stopped');
    release();
    await runtime.settle();
    assert.equal(state.tokens[active.id].status, 'published');
    assert.equal(runtime.occupiesAdmission(active, 'parallel/start'), false);
    runtime.setScopePaused({scope: 'station', key: 'parallel/left', paused: false, reason: 'Continue left branch'});
    runtime.setScopePaused({scope: 'station', key: 'parallel/right', paused: false, reason: 'Continue right branch'});
    await runtime.settle();
    assert.equal(state.tokens[parallel.id].status, 'published', 'resuming preserves both original branches');
    assert.equal(state.tokens[parallel.id].attempts.length, 3);
  } finally {
    release();
    await runtime.close();
    journal.close();
  }
});

test('ten independent completed items produce one durable proposal without changing staff before confirmation', async () => {
  const { runtime, journal, state } = setup();
  try {
    for (let i = 0; i < 9; i++) runtime.create('fast/work', { item: `item-${i}`, url: '', source: 'fixture' });
    await runtime.settle(); assert.equal(runtime.measurementProposal(), null); assert.equal(runtime.stationNumbers('fast/work').measured, false);
    runtime.create('fast/work', { item: 'item-9', url: '', source: 'fixture' }); await runtime.settle();
    const proposal = runtime.measurementProposal()!;
    assert.equal(proposal.sampleItems, 10); assert.equal(runtime.stationNumbers('fast/work').measured, true);
    assert.equal(runtime.workers.get('fast/work')!.length, 4, 'measurement alone cannot change the staffing plan');
    assert.equal(state.measurement?.status, 'proposed');
    runtime.decideMeasurement(proposal.id, true);
    assert.equal(runtime.workers.get('fast/work')!.length, 1); assert.equal(state.measurement?.status, 'accepted');
    assert.equal([...journal.read()].filter(event => event.kind === 'measurement.proposed').length, 1);
    assert.throws(() => runtime.decideMeasurement(proposal.id, true), /待确认/);
  } finally { await runtime.close(); journal.close(); }
});

test('a model recovery trial keeps unrelated local work flowing and still honors global pause', async () => {
  const resources = ['model', 'cpu', 'http'] as const;
  const fixturePack: Pack = {...pack, lines: resources.map(resource => line({
    id: resource, name: resource, layer: 3, priority: 'mid', wired: true, blurb: 'Independent resource work',
    stations: [station({id: 'work', name: 'Work', role: 'process',
      kind: resource === 'model' ? 'agent' : 'program', resource, accept: ['Fixture receipt exists'],
      workers: {min: 1, max: 1, initial: 1, policy: 'fixed'}}),
    station({id: 'published', name: 'Done', role: 'store', kind: 'store'})],
    edges: [['work', 'published']],
  })), order: [...resources]};
  const {runtime, broker, journal, state} = setup(fixturePack, {model: 2, cpu: 1, http: 1});
  const modelCalls: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  runtime.executors = node => async ctx => {
    if (node.resource === 'model') {
      modelCalls.push(ctx.token.id);
      await held;
    } else {
      assert.throws(checkModelAdmission, /MODEL_CIRCUIT_OPEN/,
        'local work cannot bypass the model trial by calling a model helper');
    }
    return {ok: true, summary: 'Fixture finished'};
  };
  try {
    runtime.pause();
    const waiting = runtime.create('model/work', {item: 'waiting', url: '', source: 'fixture'});
    const trial = runtime.create('model/work', {item: 'trial', url: '', source: 'fixture'});
    const local = ['cpu', 'http'].map(resource => runtime.create(`${resource}/work`, {
      item: resource, url: '', source: 'fixture',
    }));
    broker.recoveryToken = trial.id;
    runtime.resume();
    for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(modelCalls, [trial.id], 'only the selected model task may probe recovery');
    assert.deepEqual(local.map(token => state.tokens[token.id].status), ['published', 'published']);
    assert.equal(state.tokens[waiting.id].status, 'active');
    assert.equal(broker.used.model, 1);
    runtime.pause();
    release();
    await runtime.settle();
    broker.recoveryToken = null;
    runtime.schedule();
    await runtime.settle();
    assert.deepEqual(modelCalls, [trial.id], 'global pause still holds work after the trial finishes');
    runtime.resume();
    await runtime.settle();
    assert.equal(state.tokens[waiting.id].status, 'published');
    assert.deepEqual(modelCalls, [trial.id, waiting.id]);
  } finally {
    release();
    await runtime.close();
    journal.close();
  }
});

test('an attempt captures its executor and dependency before observers can change the next binding', async () => {
  const {runtime, journal, state} = setup();
  const first = {key: 'fixture-a', adapter: 'pi' as const, provider: 'fixture', model: 'model-a'};
  const second = {...first, key: 'fixture-b', model: 'model-b'};
  let selected = first;
  let preparations = 0;
  const executed: string[] = [];
  runtime.executors = () => ({prepare: () => {
    preparations++;
    const captured = selected;
    return {dependency: captured, execute: async () => {
      executed.push(captured.key);
      return {ok: true, summary: 'Captured fixture execution'};
    }};
  }});
  const unsubscribe = journal.subscribe(event => {
    if (event.kind === 'attempt.started') selected = second;
  });
  try {
    assert.ok(runtime.executors(runtime.nodes.get('fast/work')!));
    assert.equal(preparations, 0, 'capability checks must not prepare model configuration');
    const initial = runtime.create('fast/work', {item: 'first', url: '', source: 'fixture'});
    await runtime.settle();
    const next = runtime.create('fast/work', {item: 'next', url: '', source: 'fixture'});
    await runtime.settle();
    const initialAttempt = state.attempts[state.tokens[initial.id].attempts[0]];
    const nextAttempt = state.attempts[state.tokens[next.id].attempts[0]];
    assert.deepEqual(executed, [first.key, second.key]);
    assert.deepEqual(initialAttempt.dependency, first);
    assert.deepEqual(nextAttempt.dependency, second);
    assert.equal(preparations, 2);
    assert.ok(initial.finished && next.finished);
  } finally {
    unsubscribe();
    await runtime.close();
    journal.close();
  }
});
