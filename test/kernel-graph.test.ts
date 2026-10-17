import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {compile} from '../server/spec/compile.ts';
import {line, station, type Pack} from '../server/spec/dsl.ts';
import {pack} from '../packs/vislexicon/pack.ts';
import {apply, initialState} from '../shared/project.ts';
import {BUDGET_ATTENTION_MS, streamOf} from '../shared/streams.ts';
import {kernelStreams} from '../server/kernel/streams.ts';
import {KernelStore} from '../server/kernel/store.ts';
import {createItem, type ItemState} from '../server/kernel/item.ts';
import {admittedCandidates, sortReady} from '../server/kernel/scheduler.ts';
import type {Executor, StationContext, StationResult, TokenRun} from '../server/runtime.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-kernel-graph-'));
process.env.FACTORY_VAR = root;
process.env.FACTORY_PREFLIGHT = '0';
process.env.VISLEXICON_ROOT = path.join(root, 'unconnected');
const {Runtime} = await import('../server/runtime.ts');
const {Kernel} = await import('../server/kernel/kernel.ts');
const {Journal} = await import('../server/journal.ts');
const {Broker} = await import('../server/broker.ts');

after(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, {recursive: true, force: true});
});

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const broker = () => {
  const value = new Broker({browser: 32, model: 32, modelWorkers: 32, cpu: 32, http: 32}, 0);
  value.freeMem = () => 32768;
  return value;
};

interface Branches {mode: 'shots' | 'video'; proof: boolean; agree: boolean}

async function curationTrace(version: 'v1' | 'v2', branches: Branches) {
  const compiled = compile([pack]);
  assert.deepEqual(compiled.issues, []);
  const journal = new Journal(path.join(root, `${version}-${branches.mode}-${branches.proof}-${branches.agree}.db`));
  const state = initialState(compiled);
  journal.subscribeProjection(event => apply(state, event));
  const pending: {key: string; release(): void}[] = [];
  const waves: string[][] = [];
  let primary = '';
  const executor: Executor = async ctx => {
    assert.equal(journal.inTransaction, false, 'executors must run after the state transition commits');
    const result: StationResult = {ok: true, summary: `Fixture ${ctx.node.key}`,
      data: ctx.node.id === 'kind-join' ? {kindAgreed: branches.agree, kind: 'gallery'} :
        ctx.node.id === 'arbiter' ? {kind: 'gallery'} :
        ctx.node.id === 'plan' ? {mode: branches.mode, needsProof: branches.proof} :
        ctx.node.id === 'gate' ? {gate: 'pass'} : {['fixture.' + ctx.node.id]: true}};
    if (ctx.token.id === primary) {
      await new Promise<void>(release => pending.push({key: ctx.node.key, release}));
    }
    return result;
  };
  const runtime = version === 'v1'
    ? new Runtime(compiled, journal, broker(), pack.conditions, () => executor)
    : new Kernel(compiled, journal, broker(), pack.conditions, () => executor);
  try {
    if (version === 'v1') runtime.ensureWorkers([]);
    runtime.start(`Curation golden ${JSON.stringify(branches)}`);
    primary = runtime.create('curation/dedupe', {item: 'golden',
      url: 'https://fixture.test/golden', source: 'manual'}).id;
    for (let count = 0; count < 100 && state.tokens[primary].status === 'active'; count++) {
      await turn();
      const ready = pending.splice(0);
      assert.ok(ready.length, `The ${version} curation frontier stalled after ${JSON.stringify(waves)}`);
      waves.push(ready.map(value => value.key).sort());
      for (const value of ready) value.release();
      await turn();
    }
    await runtime.settle();
    const token = state.tokens[primary];
    assert.equal(token.status, 'published');
    if (runtime instanceof Kernel) {
      assert.equal(runtime.store.get(primary)?.status, 'published');
      const forbidden = [...journal.read()].filter(event => /^(worker\.(spawned|forked|retired|locked)|measurement\.|consult\.|batch\.configured)/.test(event.kind));
      assert.deepEqual(forbidden, [], 'v2 must not create worker, consultation, measurement or batch events');
    }
    return {waves, store: token.finishedAtNode};
  } finally {
    for (const value of pending) value.release();
    await runtime.close();
    journal.close();
  }
}

for (const mode of ['shots', 'video'] as const) for (const proof of [false, true]) for (const agree of [false, true]) {
  test(`curation v2 matches v1 topological completion layers: ${mode}, proof=${proof}, agree=${agree}`, async () => {
    const branches = {mode, proof, agree};
    const expected = await curationTrace('v1', branches);
    const actual = await curationTrace('v2', branches);
    assert.deepEqual(actual, expected);
    assert.equal(actual.store, 'curation/published');
    const executed = actual.waves.flat();
    assert.equal(executed.includes('curation/arbiter'), !agree);
    assert.equal(executed.includes('curation/record'), mode === 'video');
    assert.equal(executed.includes('curation/breadth'), mode === 'shots');
    assert.equal(executed.includes('curation/proof'), mode === 'shots' && proof);
  });
}

function returnPack(): Pack {
  return {id: 'kernel-return', name: 'Kernel return fixture', version: '1', blurb: 'Deterministic review fixture',
    lines: [line({id: 'review', name: 'Review', layer: 3, priority: 'mid', wired: true,
      blurb: 'Preserve upstream evidence and bound review loops',
      stations: [
        ...['first', 'second'].map(id => station({id, name: id, kind: 'program', role: 'process',
          resource: 'none', accept: ['Return deterministic fixture data']})),
        station({id: 'check', name: 'Check', kind: 'review', role: 'review', resource: 'none',
          accept: ['Request bounded corrections'], returnTo: [{station: 'first', maxRounds: 2}, {station: 'second', maxRounds: 2}]}),
        station({id: 'published', name: 'Published', kind: 'store', role: 'store'}),
      ], edges: [['first', 'second'], ['second', 'check'], ['check', 'published']]})],
    channels: [], links: [], resources: {browser: 0, model: 0, cpu: 0, http: 0}, conditions: {},
    order: ['review'], collapsed: [], hints: {}};
}

function reviewFixture(name: string, execute: Executor) {
  const compiled = compile([returnPack()]);
  assert.deepEqual(compiled.issues, []);
  const journal = new Journal(path.join(root, `${name}.db`));
  const state = initialState(compiled);
  journal.subscribeProjection(event => apply(state, event));
  const kernel = new Kernel(compiled, journal, broker(), {}, () => execute);
  kernel.start(name);
  return {kernel, journal, state, close: async () => {await kernel.close(); journal.close();}};
}

test('v2 return resets the target and descendants, retains data, and parks after the declared round limit', async () => {
  const counts = new Map<string, number>();
  const redos: NonNullable<StationContext['redo']>[] = [];
  const fixture = reviewFixture('bounded-return', async ctx => {
    counts.set(ctx.node.key, (counts.get(ctx.node.key) ?? 0) + 1);
    if (ctx.node.id === 'first') return {ok: true, summary: 'Keep expensive upstream', data: {paid: 'durable'}};
    assert.equal(ctx.token.data.paid, 'durable');
    if (ctx.node.id === 'second') {
      if (ctx.redo) redos.push(structuredClone(ctx.redo));
      return {ok: true, summary: 'Owner output', data: {revision: counts.get(ctx.node.key)}};
    }
    return {ok: true, summary: 'Review requests correction',
      verdict: {verdict: 'return', returnTo: 'review/second', reason: 'Retain evidence and correct owner output'}};
  });
  try {
    const token = fixture.kernel.create('review/first', {item: 'bounded', url: '', source: 'fixture'});
    await fixture.kernel.settle();
    const item = fixture.kernel.store.get(token.id)!;
    assert.equal(item.status, 'parked');
    assert.equal(item.parked?.code, 'max_rounds');
    assert.equal(item.nodes['review/second'].rounds, 3);
    assert.equal(counts.get('review/first'), 1);
    assert.equal(counts.get('review/second'), 3);
    assert.equal(counts.get('review/check'), 3);
    assert.equal(redos.length, 2);
    assert.ok(redos.every(redo => redo.byHuman === false && redo.reason.includes('correct owner')));
    assert.equal(item.data.paid, 'durable');
  } finally {await fixture.close();}
});

test('v2 fix chooses the earliest owner in topology and carries every problem through redo', async () => {
  const order: string[] = [];
  let correction: StationContext['redo'];
  let checks = 0;
  const fixture = reviewFixture('fix-owner-order', async ctx => {
    order.push(ctx.node.key);
    if (ctx.node.id === 'first' && ctx.redo) correction = structuredClone(ctx.redo);
    if (ctx.node.id === 'check' && checks++ === 0) return {ok: true, summary: 'Two owners need fixes',
      verdict: {verdict: 'fix', reason: 'Fix both owners', fixes: [
        {station: 'review/second', fields: ['second'], problem: 'Second owner problem'},
        {station: 'review/first', fields: ['first'], problem: 'First owner problem'},
      ]}};
    return {ok: true, summary: 'Fixture corrected', data: {[ctx.node.id]: 'retained'}};
  });
  try {
    const token = fixture.kernel.create('review/first', {item: 'fix', url: '', source: 'fixture'});
    await fixture.kernel.settle();
    assert.equal(fixture.kernel.store.get(token.id)?.status, 'published');
    assert.deepEqual(order, ['review/first', 'review/second', 'review/check', 'review/first', 'review/second', 'review/check']);
    assert.equal(correction?.reason, 'Second owner problem\nFirst owner problem');
    assert.equal(correction?.byHuman, false);
    assert.equal(fixture.kernel.store.get(token.id)?.nodes['review/first'].rounds, 1);
  } finally {await fixture.close();}
});

test('v2 human correction preserves automated rounds and can undo an unexecuted correction', async () => {
  const fixture = reviewFixture('human-correction', async ctx => ({ok: true, summary: 'Fixture success', data: {[ctx.node.id]: true}}));
  try {
    const token = fixture.kernel.create('review/first', {item: 'human', url: '', source: 'fixture'});
    await fixture.kernel.settle();
    const before = structuredClone(fixture.kernel.store.get(token.id)!);
    fixture.kernel.pause();
    const corrected = fixture.kernel.correct({token: token.id, node: 'review/first'}, 'Wrong view', 'Keep original source');
    assert.equal(corrected.ok, true);
    const after = fixture.kernel.store.get(token.id)!;
    assert.equal(after.nodes['review/first'].rounds, before.nodes['review/first'].rounds);
    assert.equal(after.nodes['review/first'].redo?.byHuman, true);
    assert.equal(after.nodes['review/first'].redo?.note, 'Keep original source');
    assert.equal(fixture.kernel.undoCorrection(corrected.correction!).ok, true);
    const restored = fixture.kernel.store.get(token.id)!;
    assert.equal(restored.status, before.status);
    assert.deepEqual(restored.nodes, before.nodes);
    assert.deepEqual(JSON.parse(JSON.stringify(restored.data)), JSON.parse(JSON.stringify(before.data)),
      'the persisted JSON result and checkpoint are restored');
    assert.equal(fixture.state.tokens[token.id].status, 'published', 'undo must also restore the existing UI projection');
    assert.equal(fixture.state.tokens[token.id].finishedAtNode, 'review/published');
    assert.deepEqual(fixture.state.tokens[token.id].at, []);
  } finally {await fixture.close();}
});

test('v2 admission is FIFO and records resource waits while the oldest item finishes first', async t => {
  t.mock.timers.enable({apis: ['Date'], now: 1_000_000});
  const spec = returnPack();
  for (const node of spec.lines[0].stations) if (node.kind !== 'store') node.resource = 'cpu';
  const compiled = compile([spec]);
  const journal = new Journal(path.join(root, 'admission.db'));
  const pending: {item: string; node: string; release(): void}[] = [];
  const order: string[] = [];
  const kernel = new Kernel(compiled, journal, new Broker({cpu: 1}, 0), {}, () => async ctx => {
    order.push(`${ctx.token.item}:${ctx.node.id}`);
    await new Promise<void>(release => pending.push({item: ctx.token.item, node: ctx.node.key, release}));
    return {ok: true, summary: 'Fixture capacity released'};
  });
  try {
    kernel.maxActiveItems = 2;
    kernel.start('Bounded FIFO admission');
    const tokens: TokenRun[] = [];
    for (const item of ['oldest', 'second', 'queued']) {
      const token = kernel.create('review/first', {item, url: '', source: 'fixture'});
      tokens.push(token);
      await turn();
      t.mock.timers.tick(1);
    }
    assert.equal(kernel.store.get(tokens[2].id)?.status, 'queued');
    assert.equal(kernel.store.get(tokens[1].id)?.nodes['review/first'].status, 'waiting');
    assert.equal(kernel.store.get(tokens[1].id)?.nodes['review/first'].waitingFor, 'resource');
    assert.equal(typeof kernel.store.get(tokens[1].id)?.nodes['review/first'].waitingSince, 'number');
    assert.equal(pending.length, 1);
    for (let i = 0; i < 9; i++) {
      assert.equal(pending.length, 1, 'one CPU lease must bound concurrent node execution');
      pending.shift()!.release();
      await turn();
    }
    await kernel.settle();
    assert.deepEqual(order, ['oldest', 'second', 'queued'].flatMap(item =>
      ['first', 'second', 'check'].map(node => `${item}:${node}`)));
    assert.ok(tokens.every(token => kernel.store.get(token.id)?.status === 'published'));
    assert.throws(() => kernel.ensureWorkers([]), {status: 410, code: 'removed_in_v2'});
  } finally {
    for (const current of pending) current.release();
    await kernel.close();
    journal.close();
  }
});

test('v2 same-millisecond FIFO survives upserts and database reopen', t => {
  t.mock.timers.enable({apis: ['Date'], now: 1_000_000});
  const compiled = compile([returnPack()]);
  const file = path.join(root, 'same-millisecond-fifo.db');
  let journal = new Journal(file);
  let store = new KernelStore(journal);
  const ids = ['z-first', 'a-second', 'm-third'];
  const items = ids.map(id => createItem(compiled, {id, run: 'same-ms', entry: 'review/first', item: id,
    url: '', source: 'fixture', now: Date.now()}));
  try {
    journal.atomic(() => {
      for (const item of items) store.save(item);
      items[0].data.note = 'Updating the oldest row must preserve its place';
      store.save(items[0]);
    });
    assert.deepEqual(store.list().map(item => item.id), ids, 'random ids cannot decide creation order at the same millisecond');
    assert.deepEqual(admittedCandidates(store.list(['queued']), 2).map(item => item.id), ids.slice(0, 2));
    journal.atomic(() => {
      items[0].status = 'active';
      items[0].nodes['review/first'].status = 'done';
      items[0].nodes['review/second'].status = 'ready';
      items[1].status = 'active';
      store.save(items[0], Date.now());
      store.save(items[1], Date.now());
    });
    journal.close();
    journal = new Journal(file);
    store = new KernelStore(journal);
    assert.deepEqual(store.list().map(item => item.id), ids, 'recovery preserves the original tie order');
    assert.deepEqual(sortReady(store.list(['active']), compiled, id => store.admittedAt(id)).map(value => [value.item.id, value.node.key]),
      [['z-first', 'review/second'], ['a-second', 'review/first']],
      'an older item keeps priority even when a newer item has an earlier topology position');
  } finally {journal.close();}
});

test('v2 returning an item invalidates an older parallel attempt even when its external call ignores cancellation', async () => {
  const spec: Pack = {id: 'late-result', name: 'Late result', version: '1', blurb: 'Parallel return fixture',
    lines: [line({id: 'late', name: 'Late', layer: 3, priority: 'mid', wired: true, blurb: 'Reject stale writes',
      stations: [...['entry', 'owner', 'sibling', 'join'].map(id => station({id, name: id, kind: 'program',
        role: 'process', resource: 'none', accept: ['Return the current fixture attempt']})),
      station({id: 'check', name: 'Check', kind: 'review', role: 'review', resource: 'none',
        accept: ['Bound the repair'], returnTo: [{station: 'entry', maxRounds: 2}]}),
      station({id: 'published', name: 'Published', kind: 'store', role: 'store'})],
      edges: [['entry', 'owner'], ['entry', 'sibling'], ['owner', 'check'],
        ['check', 'join'], ['sibling', 'join'], ['join', 'published']]})],
    channels: [], links: [], resources: {model: 0, browser: 0, cpu: 0, http: 0}, conditions: {},
    order: ['late'], collapsed: [], hints: {}};
  const journal = new Journal(path.join(root, 'late-result.db'));
  let checks = 0;
  let siblings = 0;
  let releaseOld: (() => void) | undefined;
  let oldAttempt = '';
  let oldSignal: AbortSignal | undefined;
  const kernel = new Kernel(compile([spec]), journal, broker(), {}, () => async ctx => {
    if (ctx.node.id === 'sibling') {
      if (siblings++ === 0) {
        oldAttempt = ctx.attempt;
        oldSignal = ctx.signal;
        await new Promise<void>(resolve => {releaseOld = resolve;});
        try {ctx.addEvidence({id: 'obsolete-fixture-evidence', kind: 'text', label: 'Obsolete proof'});} catch {}
        return {ok: true, summary: 'Obsolete response', data: {fresh: 'stale'}};
      }
      return {ok: true, summary: 'Current response', data: {fresh: 'current'}};
    }
    if (ctx.node.id === 'check' && checks++ === 0) return {ok: true, summary: 'Repair the item',
      verdict: {verdict: 'return', returnTo: 'late/entry', reason: 'Current owner result needs repair'}};
    return {ok: true, summary: 'Current fixture result'};
  });
  try {
    kernel.start('Ignore obsolete parallel completion');
    const token = kernel.create('late/entry', {item: 'parallel', url: '', source: 'fixture'});
    for (let i = 0; i < 30 && kernel.store.get(token.id)?.status !== 'published'; i++) await turn();
    assert.equal(kernel.store.get(token.id)?.status, 'published');
    assert.equal(oldSignal?.aborted, true);
    assert.ok(releaseOld);
    releaseOld();
    await kernel.settle();
    assert.equal(kernel.store.get(token.id)?.data.fresh, 'current');
    const obsolete = [...journal.read()].findLast(event => event.kind === 'attempt.finished' && event.attempt === oldAttempt);
    assert.equal(obsolete?.kind === 'attempt.finished' && obsolete.cancelled, true);
    assert.equal([...journal.read()].some(event => event.kind === 'evidence.added' &&
      event.evidence.id === 'obsolete-fixture-evidence'), false);
  } finally {
    releaseOld?.();
    await kernel.close();
    journal.close();
  }
});

test('v2 channels create one deterministic child when the parent output is completed again after a return', async () => {
  const spec = returnPack();
  spec.lines.push(line({id: 'child', name: 'Child', layer: 3, priority: 'mid', wired: true,
    blurb: 'Idempotent delivery fixture', stations: [
      station({id: 'consume', name: 'Consume', kind: 'program', role: 'process', resource: 'none',
        accept: ['Consume the parent output once']}),
      station({id: 'published', name: 'Published', kind: 'store', role: 'store'}),
    ], edges: [['consume', 'published']]}));
  spec.channels = [{id: 'fixture.transfer', from: {line: 'review', station: 'first'},
    to: {line: 'child', station: 'consume'}, label: 'Transfer fixture output'}];
  const journal = new Journal(path.join(root, 'channel-idempotency.db'));
  let reviews = 0;
  const consumed: {id: string; value: unknown}[] = [];
  const kernel = new Kernel(compile([spec]), journal, broker(), {}, () => async ctx => {
    if (ctx.node.key === 'review/first') return {ok: true, summary: 'Parent output', data: {transfer: 'exact owner output'}};
    if (ctx.node.key === 'review/check' && reviews++ === 0) return {ok: true, summary: 'Repeat the owner',
      verdict: {verdict: 'return', returnTo: 'review/first', reason: 'Run the parent owner again'}};
    if (ctx.node.line === 'child') consumed.push({id: ctx.token.id, value: ctx.token.data.transfer});
    return {ok: true, summary: 'Fixture completed'};
  });
  try {
    kernel.start('Idempotent cross-line child');
    const parent = kernel.create('review/first', {item: 'channel-parent', url: 'https://fixture.test/', source: 'fixture'});
    await kernel.settle();
    const childId = `${parent.id}:child`;
    assert.deepEqual(consumed, [{id: childId, value: 'exact owner output'}]);
    assert.equal(kernel.store.get(parent.id)?.status, 'published');
    assert.equal(kernel.store.get(childId)?.status, 'published');
    assert.equal([...journal.read()].filter(event => event.kind === 'token.created' && event.token === childId).length, 1);
    assert.equal([...journal.read()].filter(event => event.kind === 'token.finished' &&
      event.token === childId && event.status === 'published').length, 1);
  } finally {await kernel.close(); journal.close();}
});

test('v2 explicit checkpoints expand an earlier entry closure without dropping evidence or sessions', async () => {
  const executed: string[] = [];
  const fixture = reviewFixture('checkpoint-entry-expansion', async ctx => {
    executed.push(ctx.node.key);
    return {ok: true, summary: 'Checkpoint fixture completed'};
  });
  try {
    fixture.kernel.pause();
    const firstSession = {file: 'work/agent-sessions/earlier.json', signature: 'earlier'};
    const secondSession = {file: 'work/agent-sessions/later.json', signature: 'later'};
    const token = fixture.kernel.create('review/second', {item: 'checkpoint', url: '', source: 'fixture',
      data: {evidence: ['preserved-evidence'], stationSessions: {'review/first': firstSession, 'review/second': secondSession}}});
    assert.equal(fixture.kernel.store.get(token.id)?.nodes['review/first'], undefined);
    token.data.runtimeCheckpoint = {version: 1, entry: 'review/first', done: [], rounds: {'review/first': 1},
      notes: [['review/first', {reason: 'Resume original entry', byHuman: false}]]};
    assert.equal(fixture.kernel.restoreCheckpoint(token), true);
    const restored = fixture.kernel.store.get(token.id)!;
    assert.equal(restored.entry, 'review/first');
    assert.equal(restored.nodes['review/first'].status, 'ready');
    assert.equal(restored.nodes['review/second'].status, 'pending', 'the old frontier must now wait for its newly restored predecessor');
    assert.equal(restored.nodes['review/first'].rounds, 1);
    assert.deepEqual(restored.nodes['review/first'].session, firstSession);
    assert.deepEqual(restored.nodes['review/second'].session, secondSession);
    assert.deepEqual(restored.data.evidence, ['preserved-evidence']);
    const seq = fixture.journal.seq;
    token.data.runtimeCheckpoint = {version: 1, entry: 'review/first', done: ['other/workflow'], rounds: {}};
    assert.equal(fixture.kernel.restoreCheckpoint(token), false);
    assert.equal(fixture.journal.seq, seq, 'invalid checkpoints do not append or mutate durable state');
    assert.deepEqual(fixture.kernel.store.get(token.id), restored);
    fixture.kernel.resume();
    await fixture.kernel.settle();
    assert.deepEqual(executed, ['review/first', 'review/second', 'review/check']);
    assert.equal(fixture.kernel.store.get(token.id)?.status, 'published');
  } finally {await fixture.close();}
});

test('v1 retains an agent handoff and its session without treating it as a retryable failure', async () => {
  const compiled = compile([returnPack()]);
  const journal = new Journal(path.join(root, 'v1-handoff.db'));
  const state = initialState(compiled);
  journal.subscribeProjection(event => apply(state, event));
  const session = {file: 'work/agent-sessions/v1.json', signature: 'v1-fixture'};
  const handoff = {done: ['Read source'], evidence: [], remaining: ['Verify output'], suggestion: 'Continue later'};
  let calls = 0;
  const runtime = new Runtime(compiled, journal, broker(), {}, () => async () => {
    calls++;
    return {ok: false, summary: 'Agent handed off', handoff, sessionCheckpoint: {pi: session},
      agentContract: {budget: {maxTokens: 60_000, maxMs: 900_000}, actualTokens: 54_000, actualMs: 1000,
        rounds: 4, reminders: 3, repairs: 0, ending: 'forced_handoff'}};
  });
  runtime.roleResolver = key => ({station: key, path: 'fixture/ROLE.md', revision: 'fixture', content: 'Return the explicit fixture handoff.'});
  try {
    runtime.ensureWorkers([]);
    runtime.start('v1 handoff compatibility');
    const token = runtime.create('review/first', {item: 'handoff', url: '', source: 'fixture'});
    await runtime.settle();
    assert.equal(calls, 1);
    assert.equal(state.tokens[token.id].status, 'manual');
    assert.deepEqual((token.data.stationSessions as Record<string, unknown>)['review/first'], session);
    assert.deepEqual((token.data.agentHandoffs as Record<string, {handoff: unknown}>)['review/first'].handoff, handoff);
    assert.equal(state.nodes['review/first'].failed, 0);
    assert.equal(Object.keys(state.recoveries).length, 0);
  } finally {await runtime.close(); journal.close();}
});

test('E stream classification is pure and keeps claims out of conversation', t => {
  t.mock.method(Date, 'now', () => {throw new Error('streamOf must use the receipt timestamp');});
  for (const kind of ['attempt.started', 'attempt.progress', 'attempt.activity', 'attempt.finished',
    'token.queued', 'token.data', 'token.created', 'evidence.added', 'resource.sample']) {
    assert.equal(streamOf({kind}), 'progress', kind);
  }
  for (const type of ['challenge', 'answer', 'question', 'evidence', 'resolve', 'note']) {
    assert.equal(streamOf({kind: 'board.posted', post: {type}}), 'conversation', type);
  }
  for (const kind of ['room.opened', 'room.round', 'room.closed', 'chat.user', 'chat.assistant', 'chat.message',
    'chat.checkpoint', 'supervisor.summary']) assert.equal(streamOf({kind}), 'conversation', kind);
  assert.equal(streamOf({kind: 'board.posted', post: {type: 'claim', status: 'superseded'}}), 'none');
  assert.equal(streamOf({kind: 'alert.raised'}), 'attention');
  assert.equal(streamOf({kind: 'spec.patched', status: 'proposed'}), 'attention');
  assert.equal(streamOf({kind: 'spec.patched', status: 'accepted'}), 'none');
  for (const value of [null, undefined, [], {}, {kind: 'run.started'}, {kind: 'board.posted'}]) {
    assert.equal(streamOf(value), 'none');
  }
  for (const code of ['auth', 'tls', 'http_forbidden', 'EXTERNAL_OPERATION_UNKNOWN', 'room_unresolved', 'manual_store']) {
    assert.equal(streamOf({kind: 'token.data', patch: {runtimeCheckpoint: {kernel: {
      version: 2, status: 'parked', parked: {code}, nodes: {},
    }}}}), 'attention', code);
  }
  assert.equal(streamOf({kind: 'token.data', patch: {runtimeCheckpoint: {kernel: {
    version: 2, status: 'parked', parked: {code: 'retries_exhausted'}, nodes: {},
  }}}}), 'progress');
  const receipt = {kind: 'token.data', at: 1000 + BUDGET_ATTENTION_MS,
    patch: {runtimeCheckpoint: {kernel: {version: 2, status: 'active', nodes: {
      'review/first': {status: 'waiting', waitingFor: 'budget', waitingSince: 1000},
    }}}}};
  const before = structuredClone(receipt);
  assert.equal(streamOf(receipt), 'progress', 'exactly ten minutes is not over ten minutes');
  assert.equal(streamOf({...receipt, at: receipt.at + 1}), 'attention');
  assert.equal(streamOf({...receipt, at: undefined}), 'progress', 'missing time must never use the wall clock');
  assert.deepEqual(receipt, before);
});

test('E SQLite statistics count items once, retain current work across runs and remove handled attention', () => {
  const compiled = compile([returnPack()]);
  const file = path.join(root, 'stream-statistics.db');
  const journal = new Journal(file);
  const store = new KernelStore(journal);
  const now = 2_000_000;
  const make = (id: string, run = 'current', status: ItemState['status'] = 'active') => {
    const item = createItem(compiled, {id, run, entry: 'review/first', item: id, title: `Title ${id}`,
      url: '', source: 'fixture', now: 1000});
    item.status = status;
    for (const node of Object.values(item.nodes)) node.status = 'pending';
    return item;
  };
  const mixed = make('mixed', 'older');
  mixed.nodes['review/first'].status = 'running';
  mixed.nodes['review/second'].status = 'running';
  Object.assign(mixed.nodes['review/check'], {status: 'waiting', waitingFor: 'model'});
  const resource = make('resource');
  for (const key of ['review/first', 'review/second']) Object.assign(resource.nodes[key], {status: 'waiting', waitingFor: 'resource'});
  const budget = make('budget');
  Object.assign(budget.nodes['review/first'], {status: 'waiting', waitingFor: 'budget', waitingSince: now - 700_000});
  Object.assign(budget.nodes['review/second'], {status: 'waiting', waitingFor: 'budget', waitingSince: now - BUDGET_ATTENTION_MS});
  Object.assign(budget.nodes['review/check'], {status: 'waiting', waitingFor: 'room'});
  const parked = make('parked', 'older', 'parked');
  parked.nodes['review/first'].status = 'failed';
  parked.parked = {node: 'review/first', reason: 'Login is required', code: 'auth', at: now - 10};
  const excludedAttention = make('bounded-retry', 'current', 'parked');
  excludedAttention.parked = {node: 'review/first', reason: 'Retry limit', code: 'retries_exhausted', at: now - 9};
  const queued = make('queued', 'older', 'queued');
  queued.nodes['review/first'].status = 'ready';
  const otherWaits = make('other-waits');
  Object.assign(otherWaits.nodes['review/first'], {status: 'waiting', waitingFor: 'backoff'});
  Object.assign(otherWaits.nodes['review/second'], {status: 'waiting', waitingFor: 'supervisor'});
  const published = make('published', 'current', 'published');
  const oldPublished = make('old-published', 'older', 'published');
  for (const item of [published, oldPublished]) for (const node of Object.values(item.nodes)) node.status = 'done';
  const state = initialState(compiled);
  state.alerts = {
    duplicate: {id: 'duplicate', level: 'red', kind: 'auth', message: 'Same login issue', token: parked.id, node: 'review/first', at: now - 8},
    globalA: {id: 'global-a', level: 'red', kind: 'auth', message: 'Connect the external account', item: 'External account', at: now - 5},
    globalB: {id: 'global-b', level: 'red', kind: 'browser', message: 'Complete verification', at: now - 6},
    completed: {id: 'completed', level: 'red', kind: 'auth', message: 'Outdated reminder', token: published.id, at: now - 3},
  };
  state.patches = [
    {id: 'z', summary: 'Review model binding', status: 'proposed', at: now - 4},
    {id: 'a', summary: 'Review another patch', status: 'proposed', at: now - 4},
    {id: 'handled', summary: 'Already accepted', status: 'accepted', at: now},
  ];
  const projected = structuredClone({alerts: state.alerts, patches: state.patches});
  try {
    journal.atomic(() => {
      for (const item of [mixed, resource, budget, parked, excludedAttention, queued, otherWaits, published, oldPublished]) store.save(item);
    });
    const options = {now, runId: 'current', alerts: state.alerts, patches: state.patches,
      nodeKeys: [...compiled.nodes.map(node => node.key), 'empty/station']};
    const result = kernelStreams(store, options);
    assert.deepEqual(result.summary, {running: 1, waitingResource: 1, waitingModel: 1, published: 1, needsUser: 6});
    assert.deepEqual(result.attention.map(card => card.id), ['patch:a', 'patch:z', 'alert:global-a', 'alert:global-b',
      'parked:parked', 'budget:budget:review/first'], 'all unhandled cards are returned, with deterministic timestamp ties');
    assert.equal(result.attention.find(card => card.item === budget.id)?.action, 'continue_budget');
    assert.equal(result.attention.find(card => card.patchId === 'a')?.action, 'approval');
    assert.equal(result.attention.find(card => card.id === 'alert:global-a')?.title, 'External account');
    assert.deepEqual(result.stations['review/first'], {ready: 1, running: 1, done: 1, parked: 2,
      waiting: {model: 0, budget: 1, room: 0, backoff: 1, resource: 1, supervisor: 0}});
    assert.deepEqual(result.stations['review/check'].waiting, {model: 1, budget: 0, room: 1, backoff: 0, resource: 0, supervisor: 0});
    assert.equal(result.stations['review/second'].waiting.supervisor, 1);
    assert.deepEqual(result.stations['empty/station'], {ready: 0, running: 0, done: 0, parked: 0,
      waiting: {model: 0, budget: 0, room: 0, backoff: 0, resource: 0, supervisor: 0}});
    assert.deepEqual({alerts: state.alerts, patches: state.patches}, projected, 'aggregation must not modify projections');
    const readonly = new Journal(file, true);
    try {assert.deepEqual(kernelStreams(new KernelStore(readonly), options), result);} finally {readonly.close();}
    const resumed = store.get(budget.id)!;
    resumed.nodes['review/first'].status = 'ready';
    delete resumed.nodes['review/first'].waitingFor;
    delete resumed.nodes['review/first'].waitingSince;
    const repaired = store.get(parked.id)!;
    repaired.status = 'active';
    repaired.nodes['review/first'].status = 'ready';
    delete repaired.parked;
    journal.atomic(() => {store.save(resumed); store.save(repaired);});
    const after = kernelStreams(store, {...options, alerts: {}, patches: state.patches.map(patch => ({...patch, status: 'accepted'}))});
    assert.deepEqual(after.attention, []);
    assert.equal(after.summary.needsUser, 0);
  } finally {journal.close();}
});

test('E resource waits are durable, do not spam receipts, and resume after a real broker lease is released', async t => {
  t.mock.timers.enable({apis: ['Date'], now: 1_000_000});
  const spec = returnPack();
  for (const node of spec.lines[0].stations) if (node.kind !== 'store') node.resource = 'cpu';
  const compiled = compile([spec]);
  const journal = new Journal(path.join(root, 'resource-wait-stats.db'));
  const capacity = new Broker({cpu: 1, browser: 0, model: 0, http: 0}, 0);
  capacity.freeMem = () => 32768;
  let release: (() => void) | undefined;
  let calls = 0;
  const kernel = new Kernel(compiled, journal, capacity, {}, () => async () => {
    if (calls++ === 0) await new Promise<void>(resolve => {release = resolve;});
    return {ok: true, summary: 'Resource fixture completed'};
  });
  try {
    kernel.start('Observe bounded CPU admission');
    const first = kernel.create('review/first', {item: 'first', url: '', source: 'fixture'});
    const second = kernel.create('review/first', {item: 'second', url: '', source: 'fixture'});
    await turn();
    const waiting = kernel.store.get(second.id)!.nodes['review/first'];
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.waitingFor, 'resource');
    assert.equal(typeof waiting.waitingSince, 'number');
    assert.deepEqual(kernelStreams(kernel.store, {now: Date.now(), runId: journal.run}).summary,
      {running: 1, waitingResource: 1, waitingModel: 0, published: 0, needsUser: 0});
    const receipt = [...journal.read()].findLast(event => event.kind === 'token.data' && event.token === second.id);
    assert.ok(receipt?.kind === 'token.data');
    const checkpoint = receipt.patch.runtimeCheckpoint as {kernel: {nodes: Record<string, {waitingSince?: number; waitingFor?: string}>}};
    assert.equal(checkpoint.kernel.nodes['review/first'].waitingSince, waiting.waitingSince);
    assert.equal(checkpoint.kernel.nodes['review/first'].waitingFor, 'resource');
    const seq = journal.seq;
    for (let index = 0; index < 3; index++) {kernel.schedule(); await turn();}
    assert.equal(journal.seq, seq, 'unchanged resource waits must not append each scheduling tick');
    assert.ok(release);
    release();
    await kernel.settle();
    assert.equal(kernel.store.get(first.id)?.status, 'published');
    assert.equal(kernel.store.get(second.id)?.status, 'published');
    assert.equal(kernel.store.get(second.id)?.nodes['review/first'].waitingSince, undefined);
    assert.deepEqual(kernelStreams(kernel.store, {now: Date.now(), runId: journal.run}).summary,
      {running: 0, waitingResource: 0, waitingModel: 0, published: 2, needsUser: 0});
  } finally {release?.(); await kernel.close(); journal.close();}
});

test('E parked item checkpoints carry their real attention code to the stream classifier', async () => {
  const fixture = reviewFixture('parked-stream', async () => ({ok: false, summary: 'Login required',
    failure: {tag: 'auth_required', category: 'auth', owner: 'user', retryable: false, code: 'AUTH', message: 'Login required'}}));
  try {
    const token = fixture.kernel.create('review/first', {item: 'login', url: '', source: 'fixture'});
    await fixture.kernel.settle();
    const receipt = [...fixture.journal.read()].findLast(event => event.kind === 'token.data' && event.token === token.id);
    assert.ok(receipt);
    assert.equal(streamOf(receipt), 'attention');
    const cards = kernelStreams(fixture.kernel.store, {now: Date.now(), runId: fixture.journal.run}).attention;
    assert.equal(cards.length, 1);
    assert.equal(cards[0].code, 'auth');
  } finally {await fixture.close();}
});

test('v2 real progress refreshes the durable item timestamp while silent scheduling does not', async t => {
  t.mock.timers.enable({apis: ['Date'], now: 1_000_000});
  let context: StationContext | undefined;
  let release: (() => void) | undefined;
  const fixture = reviewFixture('observed-progress', async ctx => {
    if (!context) {
      context = ctx;
      await new Promise<void>(resolve => {release = resolve;});
    }
    return {ok: true, summary: 'Observed fixture work completed'};
  });
  const payload = {map: new Map([['preserved', new Set(['value'])]]), undefinedProperty: undefined};
  try {
    const token = fixture.kernel.create('review/first', {item: 'observed-progress', url: '', source: 'fixture', data: {payload}});
    await turn();
    assert.ok(context);
    const started = fixture.kernel.store.get(token.id)!.updatedAt;
    const seq = fixture.journal.seq;
    t.mock.timers.tick(9 * 60_000);
    fixture.kernel.schedule();
    await turn();
    assert.equal(fixture.kernel.store.get(token.id)!.updatedAt, started);
    assert.equal(fixture.journal.seq, seq, 'elapsed time and scheduler ticks must not invent progress');
    const receipts: string[] = [];
    fixture.journal.subscribe(event => {
      if (!['attempt.progress', 'attempt.activity'].includes(event.kind)) return;
      const row = fixture.journal.database.prepare('SELECT updated_at FROM items WHERE id = ?').get(token.id) as {updated_at: number};
      assert.equal(row.updated_at, event.at, 'the timestamp column commits with its actual progress receipt');
      assert.equal(fixture.kernel.store.get(token.id)!.updatedAt, event.at, 'body.updatedAt agrees with the indexed column');
      receipts.push(event.kind);
    });
    context.progress('Observed a real page result', {tool: 'fixture', text: 'An observed boundary', ok: true});
    assert.equal(fixture.kernel.store.get(token.id)!.updatedAt, Date.now());
    t.mock.timers.tick(1000);
    context.activity!({id: 'observed-tool', kind: 'tool', source: 'tool-executor', startedAt: Date.now(), status: 'running', toolName: 'fixture'});
    assert.equal(fixture.kernel.store.get(token.id)!.updatedAt, Date.now());
    assert.deepEqual(receipts, ['attempt.progress', 'attempt.activity']);
    assert.deepEqual(fixture.kernel.store.get(token.id)!.data.payload, payload, 'touching the JSON envelope preserves nested snapshot tags');
    const observed = fixture.kernel.store.get(token.id)!.updatedAt;
    const observedSeq = fixture.journal.seq;
    t.mock.timers.tick(11 * 60_000);
    fixture.kernel.schedule();
    await turn();
    assert.equal(fixture.kernel.store.get(token.id)!.updatedAt, observed);
    assert.equal(fixture.journal.seq, observedSeq);
    release!();
    await fixture.kernel.settle();
    assert.equal(fixture.kernel.store.get(token.id)?.status, 'published');
  } finally {release?.(); await fixture.close();}
});
