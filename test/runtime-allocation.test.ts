import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateResource } from '../server/allocation.ts';
import { Runtime } from '../server/runtime.ts';
import { Journal } from '../server/journal.ts';
import { Broker } from '../server/broker.ts';
import { compile } from '../server/spec/compile.ts';
import { line, station, type Pack } from '../server/spec/dsl.ts';
import { apply, initialState } from '../shared/project.ts';
import {checkModelAdmission} from '../server/model-requests.ts';

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
