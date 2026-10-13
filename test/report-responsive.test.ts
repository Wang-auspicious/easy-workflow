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
import { initialState } from '../shared/project.ts';
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
