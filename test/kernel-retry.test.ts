import assert from 'node:assert/strict';
import test, {after, type TestContext} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {compile} from '../server/spec/compile.ts';
import {line, station, type Pack} from '../server/spec/dsl.ts';
import {classifyFailure, type Failure, type FailureTag} from '../shared/failures.ts';
import {apply, initialState} from '../shared/project.ts';
import type {Executor, ExecutorRegistration, StationContext} from '../server/runtime.ts';
import type {AgentContractReport, AgentHandoff, ModelDependency, StationRecoveryPolicy} from '../shared/types.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-kernel-retry-'));
process.env.FACTORY_VAR = root;
process.env.FACTORY_PREFLIGHT = '0';
process.env.VISLEXICON_ROOT = path.join(root, 'unconnected');
const {Kernel} = await import('../server/kernel/kernel.ts');
const {planFailure} = await import('../server/kernel/retry.ts');
const {Journal} = await import('../server/journal.ts');
const {Broker} = await import('../server/broker.ts');
const {KernelStore} = await import('../server/kernel/store.ts');

after(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, {recursive: true, force: true});
});
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const transient = (tag: FailureTag): Failure => ({tag, category: 'network',
  message: `Synthetic ${tag}`, retryable: true, owner: 'system'});

function fixture(t: TestContext, name: string,
    executor: (node: {key: string}) => Executor | ExecutorRegistration,
    options: {policy?: StationRecoveryPolicy; selection?: boolean; model?: boolean} = {}) {
  t.mock.timers.enable({apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000});
  const lineId = options.selection ? 'curation' : 'retry';
  const ids = options.selection ? ['reader', 'capture'] : options.model ? ['model-a', 'model-b', 'program'] : ['work'];
  const pack: Pack = {id: name, name, version: '1', blurb: 'Deterministic failure transitions',
    lines: [line({id: lineId, name: lineId, layer: 3, priority: 'mid', wired: true, blurb: name,
      stations: [...ids.map(id => station({id, name: id,
        kind: id.startsWith('model-') ? 'agent' : 'program', role: 'process',
        resource: id.startsWith('model-') ? 'model' : 'none', accept: ['Return fixture result'],
        ...(options.policy ? {recovery: options.policy} : {}),
        ...(id === 'capture' ? {returnTo: [{station: 'reader', maxRounds: 2}]} : {})})),
      station({id: 'published', name: 'Published', kind: 'store', role: 'store'})],
      edges: options.selection ? [['reader', 'capture'], ['capture', 'published']] : ids.map(id => [id, 'published'])})],
    channels: [], links: [], resources: {model: 8, browser: 0, cpu: 0, http: 0}, conditions: {},
    order: [lineId], collapsed: [], hints: {}};
  const compiled = compile([pack]);
  assert.deepEqual(compiled.issues, []);
  const journal = new Journal(path.join(root, `${name}.db`));
  const state = initialState(compiled);
  journal.subscribeProjection(event => apply(state, event));
  const kernel = new Kernel(compiled, journal, new Broker({model: 8, modelWorkers: 8}, 0), {}, executor);
  kernel.start(name);
  const advance = async (ms: number) => {
    t.mock.timers.tick(ms);
    kernel.schedule();
    await turn();
    await kernel.settle();
  };
  return {kernel, journal, state, advance, close: async () => {await kernel.close(); journal.close();}};
}

for (const tag of ['network_timeout', 'network_connection', 'network_dns', 'http_server',
  'http_rate_limit', 'browser_capture', 'tool_error'] as const) {
  test(`v2 ${tag} retries after 10/30/90 seconds then parks with a reason`, async t => {
    let calls = 0;
    const failure = transient(tag);
    const f = fixture(t, tag.replaceAll('_', '-'), () => async () => {
      calls++;
      return {ok: false, summary: failure.message, error: failure.message, failure};
    });
    try {
      const token = f.kernel.create('retry/work', {item: tag, url: 'https://fixture.test/', source: 'fixture'});
      await f.kernel.settle();
      for (const [index, delay] of [10_000, 30_000, 90_000].entries()) {
        const node = f.kernel.store.get(token.id)!.nodes['retry/work'];
        assert.equal(node.status, 'waiting');
        assert.equal(node.waitingFor, 'backoff');
        assert.equal(node.attempts, index + 1);
        assert.equal(node.nextAt, Date.now() + delay);
        await f.advance(delay - 1);
        assert.equal(calls, index + 1, 'backoff cannot execute early');
        await f.advance(1);
        assert.equal(calls, index + 2);
      }
      const item = f.kernel.store.get(token.id)!;
      assert.equal(item.status, 'parked');
      assert.equal(item.parked?.code, 'retries_exhausted');
      assert.ok(item.parked?.reason.includes(failure.message));
      await f.advance(600_000);
      assert.equal(calls, 4, 'an exhausted item cannot silently start another attempt');
    } finally {await f.close();}
  });
}

for (const ending of ['handoff', 'forced_handoff'] as const) {
  test(`v2 ${ending} commits budget waiting, preserves its session and continues only with doubled budget`, async t => {
    const name = `contract-${ending.replaceAll('_', '-')}`;
    const budget = {maxTokens: 60_000, maxMs: 900_000};
    const session = {file: 'work/agent-sessions/fixture-first.json', signature: 'fixture-signature'};
    const nextSession = {file: 'work/agent-sessions/fixture-next.json', signature: 'fixture-signature'};
    const handoff: AgentHandoff = {done: ['Read the source'], evidence: ['fixture-evidence'],
      remaining: ['Verify the output'], suggestion: 'Continue the same conversation'};
    const report: AgentContractReport = {budget, actualTokens: 54_000, actualMs: 1000,
      rounds: 4, reminders: 3, repairs: 0, ending};
    const calls: {budget: StationContext['agentBudget']; session: StationContext['session']; redo: StationContext['redo']}[] = [];
    const f = fixture(t, name, () => async ctx => {
      calls.push({budget: ctx.agentBudget, session: ctx.session, redo: ctx.redo});
      if (calls.length === 1) return {ok: false, summary: 'Budget handoff', handoff, agentContract: report,
        sessionCheckpoint: {pi: session}, data: {incomplete: 'must not become business output'}};
      return {ok: true, summary: 'Submitted', data: {complete: true}, sessionCheckpoint: {pi: nextSession},
        agentContract: {...report, budget: ctx.agentBudget!, actualTokens: 400, reminders: 0, ending: 'submit'}};
    });
    const reader = new Journal(path.join(root, `${name}.db`), true);
    const readStore = new KernelStore(reader);
    const committed: {attempt: string; status: string | undefined; waiting: string | undefined}[] = [];
    try {
      const token = f.kernel.create('retry/work', {item: name, url: '', source: 'fixture'});
      f.journal.subscribe(event => {
        if (event.kind !== 'attempt.finished' || event.error !== 'handoff') return;
        committed.push({attempt: event.attempt, status: readStore.attempt(event.attempt)?.status,
          waiting: readStore.get(token.id)?.nodes['retry/work'].waitingFor});
      });
      await f.kernel.settle();
      const item = f.kernel.store.get(token.id)!;
      const node = item.nodes['retry/work'];
      assert.equal(item.status, 'active');
      assert.equal(item.parked, undefined);
      assert.equal(node.status, 'waiting');
      assert.equal(node.waitingFor, 'budget');
      assert.equal(node.waitingSince, Date.now());
      assert.equal(node.attempts, 0);
      assert.deepEqual(node.session, session);
      assert.deepEqual(node.agentBudget, budget);
      assert.deepEqual(node.handoff, handoff);
      assert.equal(item.data.incomplete, undefined);
      const attempt = f.kernel.store.attempts(token.id)[0];
      assert.equal(attempt.status, 'handoff');
      assert.deepEqual(attempt.body.agentContract, report);
      assert.deepEqual(attempt.body.handoff, handoff);
      assert.deepEqual(committed, [{attempt: attempt.id, status: 'handoff', waiting: 'budget'}],
        'another connection observes the attempt and waiting node together with their committed receipt');
      assert.equal(f.state.nodes['retry/work'].failed, 0);
      await f.advance(600_000);
      assert.equal(calls.length, 1, 'budget waits do not auto-retry');
      assert.deepEqual(f.kernel.continueBudget(token.id, 'retry/work').budget,
        {maxTokens: 120_000, maxMs: 1_800_000});
      await f.kernel.settle();
      assert.equal(f.kernel.store.get(token.id)?.status, 'published');
      assert.deepEqual(calls[1].session, session);
      assert.deepEqual(calls[1].budget, {maxTokens: 120_000, maxMs: 1_800_000});
      assert.deepEqual(f.kernel.store.get(token.id)?.nodes['retry/work'].session, nextSession);
      assert.equal(f.kernel.store.attempts(token.id).filter(value => value.status === 'ok').length, 1);
      assert.throws(() => f.kernel.continueBudget(token.id, 'retry/work'), {code: 'not_waiting_budget'});
      assert.equal(f.kernel.returnToken(token, 'human', 'retry/work', 'Review correction', true), true);
      await f.kernel.settle();
      assert.deepEqual(calls[2].session, nextSession, 'a later review return retains the submitted conversation');
      assert.deepEqual(calls[2].budget, {maxTokens: 120_000, maxMs: 1_800_000});
      assert.equal(calls[2].redo?.reason, 'Review correction');
    } finally {reader.close(); await f.close();}
  });
}

test('v2 declared retry policy overrides the defaults and preserves capped backoff', async t => {
  const policy: StationRecoveryPolicy = {tags: ['network_timeout'], maxRetries: 2,
    backoff: {initialMs: 7000, factor: 4, maxMs: 20000, jitter: 0}, exhausted: 'parked'};
  assert.deepEqual([0, 1].map(attempts => planFailure(transient('network_timeout'), attempts, policy, 100).nextAt), [7100, 20100]);
  let calls = 0;
  const f = fixture(t, 'declared-policy', () => async () => {
    calls++;
    return {ok: false, summary: 'Timeout', failure: transient('network_timeout')};
  }, {policy});
  try {
    const token = f.kernel.create('retry/work', {item: 'policy', url: '', source: 'fixture'});
    await f.kernel.settle();
    await f.advance(7000);
    await f.advance(20000);
    assert.equal(calls, 3);
    assert.equal(f.kernel.store.get(token.id)?.parked?.code, 'retries_exhausted');
  } finally {await f.close();}
});

const unsafe: [string, Failure, string][] = [
  ['auth', classifyFailure(new Error('Login required')), 'auth'],
  ['tls', classifyFailure(Object.assign(new Error('Certificate invalid'), {code: 'CERT_HAS_EXPIRED'})), 'tls'],
  ['forbidden', classifyFailure(new Error('HTTP 403')), 'http_forbidden'],
  ['unknown-operation', {...transient('tool_error'), code: 'EXTERNAL_OPERATION_UNKNOWN', retryable: false}, 'EXTERNAL_OPERATION_UNKNOWN'],
];
for (const [name, failure, code] of unsafe) {
  test(`v2 ${name} parks without issuing an automatic retry`, async t => {
    let calls = 0;
    const f = fixture(t, name, () => async () => {
      calls++;
      return {ok: false, summary: failure.message, failure};
    });
    try {
      const token = f.kernel.create('retry/work', {item: name, url: 'https://fixture.test/', source: 'fixture'});
      await f.kernel.settle();
      const item = f.kernel.store.get(token.id)!;
      assert.equal(item.status, 'parked');
      assert.equal(item.parked?.code, code);
      assert.ok(item.parked?.reason);
      await f.advance(900_000);
      assert.equal(calls, 1);
    } finally {await f.close();}
  });
}

for (const status of [404, 410]) {
  test(`v2 entry HTTP ${status} is excluded with a durable candidate disposition`, async t => {
    const failure = classifyFailure(new Error(`HTTP ${status}`), {url: 'https://fixture.test/', status});
    const f = fixture(t, `invalid-${status}`, () => async () => ({ok: false, summary: failure.message, failure}));
    try {
      const token = f.kernel.create('retry/work', {item: `gone-${status}`, url: 'https://fixture.test/', source: 'fixture'});
      await f.kernel.settle();
      assert.equal(f.kernel.store.get(token.id)?.status, 'excluded');
      assert.ok([...f.journal.read()].some(event => event.kind === 'candidate.disposition' &&
        event.candidate.token === token.id && event.candidate.disposition === 'removed'));
    } finally {await f.close();}
  });
}

for (const tag of ['needs_selection', 'page_unavailable'] as const) {
  test(`v2 ${tag} returns to reader with the failure reason and one review round`, async t => {
    const order: string[] = [];
    let captureCalls = 0;
    let redo: StationContext['redo'];
    const f = fixture(t, tag.replaceAll('_', '-'), () => async ctx => {
      order.push(ctx.node.key);
      if (ctx.node.id === 'reader' && ctx.redo) redo = structuredClone(ctx.redo);
      if (ctx.node.id === 'capture' && captureCalls++ === 0) {
        return {ok: false, summary: 'Choose another public page',
          failure: {...transient(tag), message: 'Choose another public page', category: 'system'}};
      }
      return {ok: true, summary: 'Selected fixture page', data: {keptEvidence: 'fixture-evidence'}};
    }, {selection: true});
    try {
      const token = f.kernel.create('curation/reader', {item: tag, url: 'https://fixture.test/', source: 'fixture'});
      await f.kernel.settle();
      assert.equal(f.kernel.store.get(token.id)?.status, 'published');
      assert.deepEqual(order, ['curation/reader', 'curation/capture', 'curation/reader', 'curation/capture']);
      assert.equal(f.kernel.store.get(token.id)?.nodes['curation/reader'].rounds, 1);
      assert.equal(redo?.reason, 'Choose another public page');
      assert.equal(redo?.byHuman, false);
    } finally {await f.close();}
  });
}

for (const tag of ['model_transport', 'model_unavailable'] as const) {
  test(`v2 ${tag} allows one model probe while programs and other dependencies continue`, async t => {
    const dependency = (key: string): ModelDependency => ({key, adapter: 'pi', provider: 'fixture', model: key});
    let modelCalls = 0;
    let releaseProbe: (() => void) | undefined;
    const other: string[] = [];
    const f = fixture(t, tag.replaceAll('_', '-'), node => node.key === 'retry/model-a' ? {
      prepare: () => ({dependency: dependency('provider-a'), execute: async () => {
        modelCalls++;
        if (modelCalls === 1) return {ok: false, summary: 'Provider temporarily unavailable', failure: {
          tag, category: 'system', message: 'Provider temporarily unavailable', retryable: true,
          owner: 'system', dependency: dependency('provider-a')}};
        if (modelCalls === 2) await new Promise<void>(resolve => {releaseProbe = resolve;});
        return {ok: true, summary: 'Provider healthy'};
      }}),
    } : {prepare: () => ({...(node.key === 'retry/model-b' ? {dependency: dependency('provider-b')} : {}),
      execute: async () => {other.push(node.key); return {ok: true, summary: 'Independent work'};}})}, {model: true});
    try {
      const first = f.kernel.create('retry/model-a', {item: 'first', url: '', source: 'fixture'});
      await f.kernel.settle();
      const waiting = f.kernel.store.get(first.id)!.nodes['retry/model-a'];
      assert.equal(waiting.status, 'waiting');
      assert.equal(waiting.waitingFor, 'model');
      assert.equal(waiting.attempts, 0, 'provider failures do not consume per-item retries');
      const second = f.kernel.create('retry/model-a', {item: 'second', url: '', source: 'fixture'});
      const third = f.kernel.create('retry/model-a', {item: 'third', url: '', source: 'fixture'});
      f.kernel.create('retry/model-b', {item: 'different-dependency', url: '', source: 'fixture'});
      f.kernel.create('retry/program', {item: 'program', url: '', source: 'fixture'});
      await f.kernel.settle();
      assert.deepEqual(other.sort(), ['retry/model-b', 'retry/program']);
      assert.equal(modelCalls, 1);
      t.mock.timers.tick(30_000);
      f.kernel.schedule();
      await turn();
      assert.equal(modelCalls, 2, 'exactly one actual station is admitted as the probe');
      t.mock.timers.tick(5000);
      f.kernel.schedule();
      await turn();
      assert.equal(modelCalls, 2, 'an unresolved probe keeps every peer waiting');
      assert.ok(releaseProbe);
      releaseProbe();
      await f.kernel.settle();
      assert.equal(modelCalls, 4);
      for (const token of [first, second, third]) assert.equal(f.kernel.store.get(token.id)?.status, 'published');
    } finally {releaseProbe?.(); await f.close();}
  });
}
