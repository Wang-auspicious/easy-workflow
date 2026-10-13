import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../server/runtime.ts';
import { Journal } from '../server/journal.ts';
import { Broker } from '../server/broker.ts';
import { compile } from '../server/spec/compile.ts';
import { line, station, type Pack } from '../server/spec/dsl.ts';
import { apply, initialState, latestRunTokens } from '../shared/project.ts';
import { batchSummary } from '../shared/batch.ts';

test('fork and join leave only real queued or active token locations, including journal replay', { timeout: 5000 }, async () => {
  const pack: Pack = { id: 'locations', name: 'Locations', blurb: 'Fixture', version: '1', resources: { cpu: 4, model: 0, browser: 0, http: 0 }, lines: [line({ id: 'flow', name: 'Flow', layer: 3, priority: 'mid', wired: true, blurb: 'Fixture', stations: [
    ...['root', 'left', 'right', 'join', 'hold'].map(id => station({ id, name: id, role: 'process', kind: 'program', resource: 'cpu', accept: ['Fixture completes'] })),
    station({ id: 'published', name: 'Published', role: 'store', kind: 'store' }),
  ], edges: [['root', 'left'], ['root', 'right'], ['left', 'join'], ['right', 'join'], ['join', 'hold'], ['hold', 'published']] })], channels: [], links: [], conditions: {}, order: ['flow'], collapsed: [], hints: {} };
  const compiled = compile([pack]); assert.deepEqual(compiled.issues, []);
  const journal = new Journal(':memory:'), state = initialState(compiled);
  journal.subscribeProjection(event => apply(state, event));
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  const reached = deferred(), release = deferred();
  const runtime = new Runtime(compiled, journal, new Broker({ cpu: 4 }, 0), {}, node => async () => {
    if (node.key === 'flow/hold') { reached.resolve(); await release.promise; }
    return { ok: true, summary: 'Fixture completes' };
  });
  runtime.roleResolver = key => ({ station: key, path: `${key}/ROLE.md`, revision: 'fixture', content: 'Complete fixture.' });
  try {
    runtime.ensureWorkers([]); runtime.start('locations');
    const token = runtime.create('flow/root', { item: 'fork-join', url: '', source: 'fixture' });
    await reached.promise;
    assert.deepEqual(state.tokens[token.id].at, ['flow/hold']);
    assert.equal(state.nodes['flow/left'].active.length, 0); assert.equal(state.nodes['flow/right'].active.length, 0);
    const replayed = initialState(compiled); for (const event of journal.read()) apply(replayed, event);
    assert.deepEqual(replayed.tokens[token.id].at, ['flow/hold']);
    release.resolve(); await runtime.settle(); assert.deepEqual(state.tokens[token.id].at, []);
  } finally { release.resolve(); await runtime.close(); journal.close(); }
});

test('a late completion does not erase another active attempt or a queued retry at the same station', () => {
  const journal = new Journal(':memory:'), state = initialState(); journal.subscribeProjection(event => apply(state, event));
  try {
    journal.append({ kind: 'token.created', token: 'token', line: 'flow', item: 'item', url: '', source: 'fixture' });
    journal.append({ kind: 'token.queued', token: 'token', node: 'flow/work' });
    journal.append({ kind: 'attempt.started', attempt: 'old', token: 'token', node: 'flow/work', worker: 'old-worker', input: '' });
    journal.append({ kind: 'attempt.started', attempt: 'new', token: 'token', node: 'flow/work', worker: 'new-worker', input: '' });
    journal.append({ kind: 'attempt.finished', attempt: 'old', ok: false, summary: 'stale', cancelled: true, ms: 10, queuedMs: 0 });
    assert.deepEqual(state.tokens.token.at, ['flow/work']);
    journal.append({ kind: 'token.queued', token: 'token', node: 'flow/work' });
    journal.append({ kind: 'attempt.finished', attempt: 'new', ok: true, summary: 'done', ms: 10, queuedMs: 0 });
    assert.deepEqual(state.tokens.token.at, ['flow/work']);
    journal.append({ kind: 'attempt.started', attempt: 'retry', token: 'token', node: 'flow/work', worker: 'retry-worker', input: '' });
    journal.append({ kind: 'attempt.finished', attempt: 'retry', ok: true, summary: 'done', ms: 10, queuedMs: 0 });
    assert.deepEqual(state.tokens.token.at, []);
    const replayed = initialState(); for (const event of journal.read()) apply(replayed, event);
    assert.deepEqual(replayed.tokens.token.at, []);
  } finally { journal.close(); }
});

test('a cross-line child is a separate work item and cannot replace its parent in the website batch', () => {
  const journal = new Journal(':memory:'), state = initialState(); journal.subscribeProjection(event => apply(state, event));
  try {
    journal.append({ kind: 'run.started', runId: 'batch', title: 'Website batch' });
    journal.append({ kind: 'batch.configured', batch: { runId: 'batch', target: 1, maxInFlight: 1, intakeWindow: 1, maxRecoveries: 2, mode: 'running', startedAt: Date.now() } });
    journal.append({ kind: 'token.created', token: 'parent', line: 'curation', item: 'shared-site', url: '', source: 'candidates/pool' });
    journal.append({ kind: 'token.finished', token: 'parent', node: 'curation/published', status: 'published', reason: 'Website complete' });
    journal.append({ kind: 'token.created', token: 'child', line: 'components', item: 'shared-site', url: '', source: 'channel:components' });
    journal.append({ kind: 'token.data', token: 'child', patch: { channelDelivery: 'delivery-a' } });
    journal.append({ kind: 'token.queued', token: 'child', node: 'components/discover' });
    assert.deepEqual(latestRunTokens(state).map(token => token.id), ['parent', 'child']);
    assert.equal(batchSummary(state)?.status, 'completed');
    assert.equal(batchSummary(state)?.admitted, 1); assert.equal(batchSummary(state)?.published, 1);
    journal.append({ kind: 'token.created', token: 'retry', line: 'components', item: 'shared-site', url: '', source: 'channel:components' });
    journal.append({ kind: 'token.data', token: 'retry', patch: { channelDelivery: 'delivery-a', retryOf: 'child' } });
    journal.append({ kind: 'token.data', token: 'child', patch: { retriedBy: 'retry' } });
    assert.deepEqual(latestRunTokens(state).map(token => token.id), ['parent', 'retry']);
    assert.equal(batchSummary(state)?.admitted, 1);
  } finally { journal.close(); }
});
