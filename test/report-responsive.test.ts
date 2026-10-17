import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import type { Worker } from 'node:worker_threads';
import { Journal } from '../server/journal.ts';
import {JournalEventStream} from '../server/event-stream.ts';
import { readReportJson, closeReportReaders } from '../server/report-reader.ts';
import { compile } from '../server/spec/compile.ts';
import { line, station, type Pack } from '../server/spec/dsl.ts';
import {apply, initialState, latestRunTokens, tokenWorkKey} from '../shared/project.ts';
import {applyUiEvent, isUiState, serializeUiState, uiEvent, uiState} from '../shared/client-view.ts';
import {batchSummary} from '../shared/batch.ts';
import type {JournalEvent, Stamped} from '../shared/types.ts';
import type { Factory } from '../server/factory.ts';
import type { RunReport } from '../server/report.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-report-responsive-'));
const journal = new Journal(path.join(dir, 'journal.db'));
const runId = 'run-synthetic-responsive';
const pack: Pack = { id: 'report-fixture', name: 'Report fixture', version: '1', blurb: 'Synthetic journal only', resources: { cpu: 1, model: 0, http: 0, browser: 0 }, lines: [line({ id: 'fixture', name: 'Fixture', layer: 3, priority: 'mid', wired: true, blurb: 'Synthetic journal only', stations: [
  station({ id: 'work', name: 'Work', kind: 'program', role: 'process', resource: 'cpu', accept: ['Fixture result exists'] }),
  station({ id: 'published', name: 'Published', kind: 'store', role: 'store' }),
], edges: [['work', 'published']] })], channels: [], links: [], conditions: {}, order: ['fixture'], collapsed: [], hints: {} };
const compiled = compile([pack]);
const factory = () => ({ project: { dir }, compiled, journal, state: initialState(compiled) }) as unknown as Factory;
const workers: Worker[] = [];
const observeWorker = (worker: Worker) => workers.push(worker);
process.on('worker', observeWorker);

before(() => {
  assert.deepEqual(compiled.issues, []);
  // Approximately 35 MB of invented text, with actual projection/report events.
  // No real project log, private URL, model reply or credential is copied here.
  journal.atomic(() => {
    journal.append({ kind: 'run.started', runId, title: 'Synthetic large journal' });
    journal.append({ kind: 'worker.spawned', node: 'fixture/work', worker: 'fixture-worker', label: 'Fixture', reason: 'Fixture setup' });
    journal.append({ kind: 'token.created', token: 'fixture-token', line: 'fixture', item: 'fixture-item', url: 'https://fixture.invalid/', source: 'fixture' });
    journal.append({ kind: 'token.queued', token: 'fixture-token', node: 'fixture/work' });
    journal.append({ kind: 'attempt.started', attempt: 'fixture-attempt', token: 'fixture-token', node: 'fixture/work', worker: 'fixture-worker', input: 'Generated performance fixture' });
    const text = 'x'.repeat(1070);
    for (let i = 0; i < 30000; i++) journal.append({ kind: 'attempt.progress', attempt: 'fixture-attempt', text: `Synthetic progress ${String(i).padStart(5, '0')}: ${text}` });
    journal.append({ kind: 'attempt.finished', attempt: 'fixture-attempt', ok: true, summary: 'Fixture complete', ms: 1000, queuedMs: 0 });
    journal.append({ kind: 'token.finished', token: 'fixture-token', node: 'fixture/published', status: 'published', reason: 'Fixture complete' });
    journal.append({ kind: 'run.ended', runId, manual: true });
  });
  const db = new DatabaseSync(path.join(dir, 'journal.db'), { readOnly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) n,SUM(length(body)) bytes FROM events').get() as { n: number; bytes: number };
    assert.ok(row.n >= 30000); assert.ok(row.bytes >= 33000000 && row.bytes <= 40000000, `fixture body is ${row.bytes} bytes`);
  } finally { db.close(); }
});

after(async () => {
  closeReportReaders(); await Promise.allSettled(workers.map(worker => worker.terminate()));
  process.off('worker', observeWorker); journal.close();
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true });
});

test('large reports keep the main heartbeat responsive, share one worker, and isolate subscriber cancellation', { timeout: 20000 }, async t => {
  const f = factory(), controller = new AbortController(), beforeWorkers = workers.length, seq = journal.seq;
  const started = performance.now(), beats = [started];
  const heartbeat = setInterval(() => beats.push(performance.now()), 5);
  try {
    const cancelled = readReportJson(f, runId, controller.signal);
    const cancellation = assert.rejects(cancelled, error => error instanceof Error && error.name === 'AbortError');
    const second = readReportJson(f, runId), third = readReportJson(f, runId);
    controller.abort(); await cancellation;
    const [a, b] = await Promise.all([second, third]); beats.push(performance.now());
    assert.equal(workers.length - beforeWorkers, 1, 'same run/sequence callers must share one actual worker');
    assert.equal(a.seq, seq); assert.equal(b.seq, seq); assert.deepEqual(a.body, b.body);
    assert.ok(beats.length >= 4, 'main-thread timers must keep running while the real SQLite report is built');
    const maxGap = Math.max(...beats.slice(1).map((at, index) => at - beats[index]));
    assert.ok(maxGap < 250, `report generation blocked the main event loop for ${maxGap.toFixed(1)} ms`);
    t.diagnostic(`events=${seq}; elapsed=${(performance.now() - started).toFixed(1)}ms; max heartbeat gap=${maxGap.toFixed(1)}ms; workers=${workers.length - beforeWorkers}`);
    const report = JSON.parse(a.body.toString('utf8')) as RunReport;
    assert.equal(report.runId, runId); assert.equal(report.totals.created, 1); assert.equal(report.totals.published, 1);
    assert.equal(report.attempts.length, 1); assert.equal(report.attempts[0].steps.length, 80);
    const cached = await readReportJson(f, runId); assert.deepEqual(cached.body, a.body);
    assert.equal(workers.length - beforeWorkers, 1, 'a completed unchanged report is reusable');
  } finally { clearInterval(heartbeat); }
});

test('cancelling the final subscriber terminates that worker and a later reader can start again', { timeout: 20000 }, async () => {
  const f = factory(), controller = new AbortController(), beforeWorkers = workers.length;
  const spawned = new Promise<Worker>(resolve => process.once('worker', resolve));
  const pending = readReportJson(f, runId, controller.signal);
  const rejected = assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
  const worker = await spawned; assert.ok(worker);
  const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()));
  controller.abort(); await rejected; await exited;
  assert.equal(worker.threadId, -1);
  const result = await readReportJson(f, runId); assert.equal(JSON.parse(result.body.toString('utf8')).runId, runId);
  assert.equal(workers.length - beforeWorkers, 2, 'a cancelled computation must not poison the next request');
});

test('run completion waits for the final sequence instead of reusing an in-flight live report', async () => {
  const id = 'run-completion-snapshot';
  journal.append({kind: 'run.started', runId: id, title: 'Completion race'});
  const f = factory();
  const live = readReportJson(f, id);
  journal.append({kind: 'run.ended', runId: id, manual: true});
  const finalSeq = journal.seq;
  const final = readReportJson(f, id, undefined, finalSeq);
  const [before, after] = await Promise.all([live, final]);
  assert.ok(before.seq < finalSeq);
  assert.equal(JSON.parse(before.body.toString('utf8')).status, 'running');
  assert.equal(after.seq, finalSeq);
  assert.equal(JSON.parse(after.body.toString('utf8')).status, 'ended');
});

test('bounded journal pages preserve an immutable through cursor with no gaps or duplicates after appends', () => {
  const first = journal.readPage({ limit: 257 }), through = first.through;
  assert.equal(through, journal.seq); assert.equal(first.events.length, 257); assert.equal(first.done, false);
  journal.append({ kind: 'run.started', runId: 'run-after-snapshot', title: 'Appended later' });
  journal.append({ kind: 'dispatch.note', tone: 'info', text: 'This event is outside the snapshot' });
  const seen = first.events.map(event => event.seq); let cursor = first.nextSeq; let done: boolean = first.done;
  while (!done) {
    const page = journal.readPage({ since: cursor, limit: 257, through });
    assert.equal(page.through, through); assert.ok(page.events.length <= 257); assert.ok(page.nextSeq > cursor);
    seen.push(...page.events.map(event => event.seq)); cursor = page.nextSeq; done = page.done;
  }
  assert.deepEqual(seen, Array.from({ length: through }, (_, i) => i + 1));
  assert.equal(new Set(seen).size, seen.length);
  const tail = journal.readPage({ since: through, through }); assert.equal(tail.done, true); assert.deepEqual(tail.events, []);
  const later = journal.readPage({ since: through }); assert.equal(later.events.length, 2); assert.ok(later.through > through);
});

test('run-filtered pagination is complete across unrelated sequence ranges and rejects malformed cursors', () => {
  const j = new Journal(':memory:');
  try {
    j.append({ kind: 'run.started', runId: 'one', title: 'First' });
    j.append({ kind: 'dispatch.note', tone: 'info', text: 'one' });
    j.append({ kind: 'run.started', runId: 'two', title: 'Second' });
    j.append({ kind: 'dispatch.note', tone: 'info', text: 'two' });
    const first = j.readPage({ run: 'one', limit: 1 }); assert.equal(first.done, false);
    const second = j.readPage({ run: 'one', since: first.nextSeq, through: first.through, limit: 1 }); assert.equal(second.done, true);
    assert.deepEqual([...first.events, ...second.events].map(event => event.seq), [1, 2]);
    assert.equal(j.readPage({ run: 'missing' }).done, true); assert.deepEqual(j.readPage({ run: 'missing' }).events, []);
    for (const since of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => j.readPage({ since }), RangeError);
    for (const through of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => j.readPage({ through }), RangeError);
    for (const limit of [0, -1, 501, 1.5, NaN, Infinity]) assert.throws(() => j.readPage({ limit }), RangeError);
    assert.throws(() => j.readPage({ since: 3, through: 2 }), RangeError);
    assert.equal(j.readPage({ limit: 500 }).events.length, 4);
    assert.deepEqual([...j.readSequences([1, 4])].map(event => event.seq), [1, 4]);
    assert.throws(() => [...j.readSequences([2, 1])], RangeError);
    assert.throws(() => [...j.readSequences([1, 1])], RangeError);
    assert.throws(() => [...j.readSequences([5])], /event is missing/);
  } finally { j.close(); }
});

test('SSE catches up without blocking HTTP, retains ordering during appends, and reconnects from the last received event', {timeout: 20000}, async t => {
  const streams = new Set<JournalEventStream>();
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.end('ok'); return; }
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    res.flushHeaders();
    const stream = new JournalEventStream(journal, res, Number(req.headers['last-event-id'] ?? 0), () => [{kind: 'ready'}]);
    streams.add(stream);
    res.on('close', () => streams.delete(stream));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  async function receiveThrough(last: number): Promise<number[]> {
    const decoder = new TextDecoder();
    const received: number[] = [];
    let pending = '';
    while ((received.at(-1) ?? 0) < last) {
      const chunk = await reader!.read();
      assert.equal(chunk.done, false);
      pending += decoder.decode(chunk.value, {stream: true});
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const id = /^id: (\d+)/.exec(frame);
        if (id) received.push(Number(id[1]));
      }
    }
    return received;
  }
  try {
    const response = await fetch(url);
    reader = response.body!.getReader();
    const appended = journal.append({kind: 'dispatch.note', tone: 'info', text: 'Appended during streaming catch-up'});
    const started = performance.now();
    assert.equal(await (await fetch(url + '/health')).text(), 'ok');
    const heartbeatMs = performance.now() - started;
    assert.ok(heartbeatMs < 500, `concurrent HTTP request stalled ${heartbeatMs.toFixed(1)} ms`);
    const received = await receiveThrough(appended.seq);
    assert.deepEqual(received, Array.from({length: appended.seq}, (_, i) => i + 1));
    await reader.cancel();
    const next = journal.append({kind: 'dispatch.note', tone: 'info', text: 'Appended after disconnect'});
    reader = (await fetch(url, {headers: {'last-event-id': String(appended.seq)}})).body!.getReader();
    assert.deepEqual(await receiveThrough(next.seq), [next.seq]);
    t.diagnostic(`streamed=${received.length}; concurrent HTTP=${heartbeatMs.toFixed(1)}ms`);
  } finally {
    await reader?.cancel();
    for (const stream of streams) stream.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a non-reading SSE socket has bounded output buffering and is released after the drain deadline', {timeout: 10000}, async t => {
  let stream: JournalEventStream | undefined;
  let peakBuffered = 0;
  let stopped!: () => void;
  const closed = new Promise<void>(resolve => { stopped = resolve; });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    res.flushHeaders();
    stream = new JournalEventStream(journal, res, 0, () => [], 100);
    const sample = setInterval(() => { peakBuffered = Math.max(peakBuffered, res.writableLength); }, 1);
    res.once('close', () => { clearInterval(sample); stopped(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const request = http.get(url, response => response.pause());
  request.on('error', () => {});
  try {
    await closed;
    assert.ok(peakBuffered > 0);
    assert.ok(peakBuffered < 256 * 1024, `slow reader retained ${peakBuffered} bytes in its output buffer`);
    t.diagnostic(`slow socket peak writable buffer=${peakBuffered} bytes`);
  } finally {
    request.destroy();
    stream?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a live update arriving during snapshot drain cannot be overwritten by the older snapshot', async () => {
  class SlowResponse extends EventEmitter {
    readonly frames: string[] = [];
    writableNeedDrain = false;

    write(frame: string) {
      this.frames.push(frame);
      if (this.frames.length === 1) this.writableNeedDrain = true;
      return !this.writableNeedDrain;
    }

    destroy() { this.emit('close'); }
  }
  const empty = new Journal(':memory:');
  const response = new SlowResponse();
  let revision = 1;
  const stream = new JournalEventStream(empty, response as unknown as http.ServerResponse, 0, () => [
    {kind: 'chat.status', busy: false}, {kind: 'browser.state', revision},
  ]);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(response.writableNeedDrain, true);
    response.writableNeedDrain = false;
    response.emit('drain');
    revision = 2;
    stream.sendLive({kind: 'browser.state', revision});
    await new Promise<void>(resolve => setImmediate(resolve));
    const revisions = response.frames.map(frame => JSON.parse(frame.split('data: ')[1]))
      .filter(event => event.kind === 'browser.state').map(event => event.revision);
    assert.equal(revisions.at(-1), 2);
    assert.deepEqual(revisions, [...revisions].sort());
  } finally {
    stream.close();
    empty.close();
  }
});

test('UI summaries preserve retry and cross-line identities, scheduling, evidence and usage without retaining business payloads', () => {
  const raw = initialState(compiled);
  const compact = uiState(raw);
  let sequence = 0;
  const events: Stamped[] = [];
  const emit = (event: JournalEvent) => {
    const stamped = {...event, seq: ++sequence, at: 1000 + sequence, run: 'run-client-view'} as Stamped;
    events.push(stamped);
    apply(raw, stamped);
    applyUiEvent(compact, uiEvent(stamped));
    assert.deepEqual(latestRunTokens(compact).map(token => [token.id, tokenWorkKey(token)]),
      latestRunTokens(raw).map(token => [token.id, tokenWorkKey(token)]));
    assert.deepEqual(batchSummary(compact), batchSummary(raw));
    for (const key of ['seq', 'run', 'nodes', 'workers', 'totals', 'recoveries', 'consults', 'pausedScopes', 'corrections'] as const) {
      assert.deepEqual(compact[key], raw[key], key);
    }
    return stamped;
  };
  const create = (token: string, line: string, data: Record<string, unknown>) => {
    emit({kind: 'token.created', token, line, item: 'shared-item', url: 'https://fixture.invalid/', source: 'fixture'});
    emit({kind: 'token.data', token, patch: data});
  };
  emit({kind: 'run.started', runId: 'run-client-view', title: 'UI identity fixture'});
  emit({kind: 'batch.configured', batch: {runId: 'run-client-view', target: 5, maxInFlight: 1,
    intakeWindow: 1, maxRecoveries: 2, mode: 'running', startedAt: 1001}});
  create('parent', 'curation', {large: 'x'.repeat(1024 * 1024), style: {applicable: true, subjectVisible: true,
    styles: [{id: 'fixture-style', reason: 'full rationale'}]}, facts: {price: 'free', license: 'MIT', receipts: ['full evidence']},
    copy: {takeawayZh: '可见摘要', descriptionZh: '可见说明', longReport: 'private full copy'}});
  emit({kind: 'token.finished', token: 'parent', status: 'parked', node: 'fixture/work', reason: 'await recovery'});
  create('retry', 'curation', {batchRecovery: {count: 1, nextAt: 60000, tag: 'network_timeout', station: 'fixture/work', replan: false}});
  emit({kind: 'token.data', token: 'parent', patch: {retriedBy: 'retry'}});
  create('child', 'components', {channelDelivery: 'delivery-1'});
  create('generic', 'fixture', {workflowPack: 'generic-pack'});
  assert.equal(latestRunTokens(compact).length, 3);
  assert.equal(batchSummary(compact)!.admitted, 1);
  assert.equal(compact.tokens.parent.data.large, undefined);
  assert.deepEqual(compact.tokens.parent.data.style, {applicable: true, subjectVisible: true, styles: [{id: 'fixture-style'}]});
  assert.equal(raw.tokens.parent.data.large, 'x'.repeat(1024 * 1024));
  emit({kind: 'token.data', token: 'parent', patch: {facts: {
    pricing: {value: 'freemium', sources: ['full pricing evidence']},
    license: {value: 'MIT', sources: ['full license evidence']},
  }}});
  assert.deepEqual(compact.tokens.parent.data.facts, {pricing: {value: 'freemium'}, license: {value: 'MIT'}});
  assert.deepEqual((raw.tokens.parent.data.facts as {license: {sources: string[]}}).license.sources, ['full license evidence']);
  emit({kind: 'scope.paused', scope: 'line', key: 'components', paused: true, reason: 'fixture'});
  emit({kind: 'token.queued', token: 'retry', node: 'fixture/work'});
  emit({kind: 'worker.spawned', node: 'fixture/work', worker: 'worker-ui', label: 'Fixture', reason: 'fixture'});
  emit({kind: 'attempt.started', attempt: 'attempt-ui', token: 'retry', node: 'fixture/work', worker: 'worker-ui', input: 'input'});
  for (let i = 0; i < 85; i++) emit({kind: 'attempt.progress', attempt: 'attempt-ui', text: `Full step ${i}`, step: {tool: 'http', text: `Full step ${i}`, ok: true}});
  emit({kind: 'attempt.activity', attempt: 'attempt-ui', activity: {id: 'activity', kind: 'tool', source: 'tool-executor', startedAt: 1100, endedAt: 1200, status: 'completed'}});
  assert.equal(uiState(raw).attempts['attempt-ui'].metrics, compact.attempts['attempt-ui'].metrics,
    'an activity-only in-flight attempt has the same summary via bootstrap and SSE');
  emit({kind: 'evidence.added', evidence: {id: 'e-ui', token: 'retry', attempt: 'attempt-ui', station: 'fixture/work', at: 1200,
    kind: 'text', label: 'full document', meta: {role: 'proof', href: 'https://fixture.invalid/', content: 0.6, framing: 'stage', document: 'full evidence'}}});
  emit({kind: 'attempt.finished', attempt: 'attempt-ui', ok: true, summary: 'done', ms: 200, queuedMs: 10,
    usage: {input: 0, output: 0, cost: 0}, output: {business: 'full result'},
    metrics: {usageReported: false, usageComplete: false, modelTimeReported: false, execution: {adapter: 'launcher', model: 'unreported'}}});
  assert.equal(compact.attempts['attempt-ui'].steps.length, 1);
  assert.equal(raw.attempts['attempt-ui'].steps.length, 80);
  assert.equal(compact.attempts['attempt-ui'].output, undefined);
  assert.equal(compact.attempts['attempt-ui'].metrics?.usageReported, false, 'missing model usage must remain unknown');
  assert.deepEqual(compact.attempts['attempt-ui'].usage, raw.attempts['attempt-ui'].usage);
  for (const costReported of [false, true]) {
    const attempt = `native-cost-${costReported}`;
    emit({kind: 'attempt.started', attempt, token: 'retry', node: 'fixture/work', worker: 'worker-ui', input: ''});
    const metrics = {execution: {adapter: 'codex', model: 'native-model'}, usageReported: true,
      tokenUsage: {input: 100, output: 20, cacheRead: 4}, costReported, costComplete: false};
    emit({kind: 'attempt.finished', attempt, ok: true, summary: 'native receipt', ms: 20, queuedMs: 0,
      ...(costReported ? {usage: {input: 10, output: 5, cost: 0}} : {}), metrics});
    assert.deepEqual(compact.attempts[attempt].metrics, metrics, 'SSE retains native tokens and missing or partial prices');
    assert.deepEqual(uiState(raw).attempts[attempt].metrics, metrics, 'reconnecting retains the same receipt');
  }
  assert.equal(compact.evidence['e-ui'].meta?.document, undefined);
  assert.equal(raw.evidence['e-ui'].meta?.document, 'full evidence');
  emit({kind: 'case.noted', caseId: 'shared-item', token: 'retry', note: {station: 'fixture/work', section: 'result', text: 'full case', by: 'fixture'}});
  emit({kind: 'context.noted', node: 'fixture/work', note: {kind: 'instruction', text: 'full context', by: 'fixture'}});
  emit({kind: 'consult.opened', consult: 'consult-ui', token: 'retry', reviewer: 'fixture/work', owner: 'fixture/work', fields: ['facts'], problem: 'fixture', round: 1});
  assert.deepEqual(compact.cases, {});
  assert.deepEqual(compact.contextNotes, {});
  assert.equal(Object.keys(compact.consults).length, 1, 'consults still contribute to node counts');
  const fullBefore = JSON.stringify(raw);
  const snapshot = uiState(raw);
  const serialized = serializeUiState(raw);
  assert.equal(serialized, JSON.stringify(snapshot), 'synchronous serialization preserves the detached snapshot body');
  assert.ok(isUiState(snapshot));
  assert.equal(isUiState(raw), false);
  assert.equal(isUiState(null), false);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), JSON.parse(JSON.stringify(compact)));
  const queued = {kind: 'token.queued', token: 'child', node: 'fixture/work', seq: sequence + 1, at: 2000, run: 'run-client-view'} as const;
  applyUiEvent(snapshot, queued);
  applyUiEvent(snapshot, queued);
  assert.equal(JSON.parse(serialized).seq, sequence, 'later events cannot change an already serialized response');
  assert.equal(snapshot.nodes['fixture/work'].queue.filter(id => id === 'child').length, 1);
  assert.equal(JSON.stringify(raw), fullBefore, 'applying a detached UI snapshot must not mutate backend state');
  assert.equal(events.find(event => event.kind === 'token.data')?.kind, 'token.data');
});

test('UI patches retain explicit clears, and correction snapshots restore summaries without recovery internals', () => {
  const raw = initialState(compiled);
  const compact = uiState(raw);
  let sequence = 0;
  const emit = (event: JournalEvent) => {
    const stamped = {...event, seq: ++sequence, at: sequence * 1000, run: 'run-correction-ui'} as Stamped;
    apply(raw, stamped);
    applyUiEvent(compact, uiEvent(stamped));
    return stamped;
  };
  emit({kind: 'token.created', token: 't', line: 'curation', item: 'one', url: 'https://fixture.invalid/', source: 'fixture'});
  emit({kind: 'token.data', token: 't', patch: {style: {applicable: true, subjectVisible: true}, facts: {price: 'free'}, copy: {takeawayZh: 'old'}}});
  emit({kind: 'token.data', token: 't', patch: {title: 'new'}});
  assert.deepEqual(compact.tokens.t.data.facts, {price: 'free'}, 'an absent patch field cannot clear prior values');
  emit({kind: 'token.data', token: 't', patch: {style: null, facts: null, copy: null}});
  assert.equal(compact.tokens.t.data.style, null);
  assert.equal(compact.tokens.t.data.facts, null);
  assert.equal(compact.tokens.t.data.copy, null);
  const snapshot = {data: {title: 'restored', channelDelivery: 'delivery-id', internal: 'must stay server-side'},
    checkpoint: {rounds: {'fixture/work': 2}, completed: ['private checkpoint']}, status: 'active', at: ['fixture/work'], touchedAt: 1234};
  emit({kind: 'correction.created', correction: 'c', token: 't', node: 'fixture/work', reason: 'fixture', snapshot});
  assert.equal(compact.corrections?.c.status, 'pending');
  const reverted = emit({kind: 'correction.reverted', correction: 'c', token: 't', snapshot});
  assert.deepEqual(compact.tokens.t.at, raw.tokens.t.at);
  assert.deepEqual(compact.tokens.t.rounds, raw.tokens.t.rounds);
  assert.equal(compact.tokens.t.touchedAt, raw.tokens.t.touchedAt);
  assert.equal(compact.tokens.t.data.title, 'restored');
  assert.equal(compact.tokens.t.data.internal, undefined);
  assert.equal(raw.tokens.t.data.internal, 'must stay server-side');
  assert.deepEqual(compact.corrections, raw.corrections);
  assert.deepEqual(compact.nodes, raw.nodes);
  const oldSummary = uiEvent(reverted);
  emit({kind: 'token.data', token: 't', patch: {title: 'future'}});
  assert.deepEqual(uiEvent(reverted), oldSummary, 'transforming an old event never reads future state');
});
