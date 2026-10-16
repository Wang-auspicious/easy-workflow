import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {compile} from '../server/spec/compile.ts';
import {line, station, type Pack} from '../server/spec/dsl.ts';
import {pack} from '../packs/vislexicon/pack.ts';
import {apply, initialState} from '../shared/project.ts';
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

test('v2 admission is FIFO and a resource shortage leaves nodes ready while the oldest item finishes first', async t => {
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
    assert.equal(kernel.store.get(tokens[1].id)?.nodes['review/first'].status, 'ready');
    assert.equal(kernel.store.get(tokens[1].id)?.nodes['review/first'].waitingFor, undefined);
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
