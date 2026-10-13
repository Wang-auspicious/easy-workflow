import { loadReplayEvents } from '../ui/src/canvas/replay-load.ts';
import { timelineDisplay } from '../ui/src/report/timeline-display.ts';
import assert from "node:assert/strict";
import test from "node:test";
import { buildTimeView, usageSummary, timeStrip, type DisplayInterval, type ActivityAttempt } from "../ui/src/report/activity.ts";
import type { ActivitySpan } from "../shared/types.ts";
import {DetailCache, type DetailTarget} from '../ui/src/details.ts';

const recorded = (id: string, kind: ActivitySpan["kind"], startedAt: number, endedAt?: number, requestId?: string): ActivitySpan => ({
  id, kind, source: kind === "tool" ? "tool-executor" : "model-stream", startedAt, endedAt, requestId,
  status: endedAt === undefined ? "running" : "completed", ...(kind === "tool" ? { toolName: "env_call", operation: "fetch_text" } : { model: "recorded-model" }),
});
const attempt = (overrides: Partial<ActivityAttempt> = {}): ActivityAttempt => ({ id: "a-recorded", node: "curation/reader", startedAt: 1000, endedAt: 2000, ms: 1000, queuedMs: 50, input: 100, output: 20, cost: 0.01, ...overrides });
const observedAttempt = () => attempt({ metrics: {
  execution: { adapter: "pi", model: "recorded-model" }, usageReported: true, usageComplete: true,
  time: { firstTokenMs: 120, outputMs: 230, toolMs: 810, programMs: 0, modelCalls: 2, toolCalls: 3 },
  activity: { version: 1, modelTiming: "observed", spans: [
    recorded("request-1", "model_request", 1100, 1400), recorded("wait-1", "first_token", 1100, 1200, "request-1"), recorded("output-1", "model_output", 1200, 1400, "request-1"),
    recorded("tool-a", "tool", 1400, 1800, "request-1"), recorded("tool-b", "tool", 1500, 1900, "request-1"),
    recorded("request-2", "model_request", 1900, 1950), recorded("wait-2", "first_token", 1900, 1920, "request-2"), recorded("output-2", "model_output", 1920, 1950, "request-2"),
    { ...recorded("submit", "tool", 1950, 1960, "request-2"), toolName: "submit", operation: undefined },
  ] },
} });

test("recorded model/tool boundaries replace attempt proportions and parallel tools count once in wall time", () => {
  const source = observedAttempt(), before = JSON.stringify(source);
  const view = buildTimeView([source], { live: false, observedUntil: 999999 });
  assert.deepEqual(view.totals, { tool: 510, output: 230, first: 120, program: 0, queue: 50, other: 140, unknown: 0 });
  assert.equal(Object.values(view.totals).reduce((sum, n) => sum + n, 0), 1050);
  assert.ok(view.intervals.every(span => !span.id.startsWith("request-")), "parent requests do not become a second copy of model time");
  assert.deepEqual(view.intervals.filter(span => span.key === "other").map(span => [span.from, span.to]), [[1000, 1100], [1960, 2000]]);
  const overlapping = view.strip!.segments.find(segment => segment.from === 1500 && segment.to === 1800)!;
  assert.deepEqual(overlapping.keys, ["tool"]);
  assert.deepEqual(overlapping.intervals.map(span => [span.id, span.from, span.to, span.label]), [["tool-a", 1400, 1800, "env_call · fetch_text"], ["tool-b", 1500, 1900, "env_call · fetch_text"]]);
  assert.equal(view.coverage.observed, 1); assert.equal(view.coverage.estimated, 0);
  assert.equal(JSON.stringify(source), before, "display bounds must not alter the recorded journal data");
});

test("concurrent stations share the actual horizontal range while the ring sums separate worker time", () => {
  const program = attempt({ id: "a-program", node: "curation/process", queuedMs: 0, metrics: { time: { firstTokenMs: 0, outputMs: 0, toolMs: 0, programMs: 1, modelCalls: 0, toolCalls: 0 } } });
  const view = buildTimeView([observedAttempt(), program], { live: false, observedUntil: 0, programNodes: new Set([program.node]) });
  assert.equal(view.totals.program, 1000, "program uses its actual attempt endpoints, not a synthetic proportional duration");
  assert.equal(view.strip!.end - view.strip!.start, 1050);
  assert.ok(view.strip!.segments.some(segment => segment.keys.includes("tool") && segment.keys.includes("program")));
  const selected = buildTimeView([program], { live: false, observedUntil: 0, programNodes: new Set([program.node]) });
  assert.deepEqual(selected.strip!.segments.map(segment => segment.keys), [["program"]]);
});

test("closed agents' aggregate durations never fabricate positioned model bands or idle gaps", () => {
  const closed = attempt({ queuedMs: 0, metrics: { execution: { adapter: "closed-command", model: "closed-fixture" }, modelTimeReported: true,
    time: { firstTokenMs: 300, outputMs: 600, toolMs: 100, programMs: 0, modelCalls: 1, toolCalls: 1 },
    activity: { version: 1, modelTiming: "unavailable", spans: [recorded("closed-tool", "tool", 1200, 1300)] } } });
  const view = buildTimeView([closed], { live: false, observedUntil: 3000, programNodes: new Set([closed.node]) });
  assert.equal(view.totals.unknown, 900); assert.equal(view.totals.tool, 100);
  assert.equal(view.totals.first, 0); assert.equal(view.totals.output, 0); assert.equal(view.totals.program, 0); assert.equal(view.totals.other, 0);
  assert.ok(view.strip!.segments.every(segment => segment.keys.length > 0));
  assert.deepEqual(view.intervals.filter(span => span.key === "unknown").map(span => [span.from, span.to]), [[1000, 1200], [1300, 2000]]);
});

test("legacy phase totals remain explicitly estimated and missing metrics remain unknown", () => {
  const legacy = attempt({ queuedMs: 0, metrics: { time: { firstTokenMs: 100, outputMs: 200, toolMs: 300, programMs: 0, modelCalls: 1, toolCalls: 1 } } });
  const view = buildTimeView([legacy], { live: false, observedUntil: 900000 });
  assert.equal(view.coverage.estimated, 1); assert.equal(view.coverage.observed, 0);
  assert.equal(view.intervals.length, 1); assert.equal(view.intervals[0].quality, "estimated");
  assert.deepEqual([view.intervals[0].from, view.intervals[0].to], [1000, 2000]);
  assert.equal(view.totals.first, 100); assert.equal(view.totals.output, 200); assert.equal(view.totals.tool, 300); assert.equal(view.totals.other, 400);
  const missing = buildTimeView([attempt({ queuedMs: 0 })], { live: false, observedUntil: 900000 });
  assert.equal(missing.totals.unknown, 1000); assert.equal(missing.totals.other, 0);
});

test("editing the current graph cannot reclassify completed or historical attempts with the same station key", () => {
  const legacyAgent = attempt({ queuedMs: 0, metrics: { time: { firstTokenMs: 100, outputMs: 400, toolMs: 100, programMs: 0, modelCalls: 1, toolCalls: 1 } } });
  const before = buildTimeView([legacyAgent], { live: false, observedUntil: 5000, programNodes: new Set() });
  const after = buildTimeView([legacyAgent], { live: false, observedUntil: 5000, programNodes: new Set([legacyAgent.node]) });
  assert.deepEqual(after, before);
  assert.equal(after.totals.program, 0); assert.equal(after.coverage.estimated, 1);
  assert.deepEqual(buildTimeView([legacyAgent], { live: true, observedUntil: 5000, programNodes: new Set([legacyAgent.node]) }), before, "a current run's completed attempt also retains its own identity");
  const unknown = buildTimeView([attempt({ metrics: undefined, queuedMs: 0 })], { live: false, observedUntil: 5000, programNodes: new Set([legacyAgent.node]) });
  assert.equal(unknown.totals.program, 0); assert.equal(unknown.totals.unknown, 1000);
  const recordedProgram = attempt({ queuedMs: 0, metrics: { time: { firstTokenMs: 0, outputMs: 0, toolMs: 0, programMs: 1000, modelCalls: 0, toolCalls: 0 } } });
  assert.equal(buildTimeView([recordedProgram], { live: false, observedUntil: 5000, programNodes: new Set() }).totals.program, 1000, "recorded program execution survives the node being changed back to agent");
});

test("open live boundaries use an observation bound; historical missing ends never acquire a fabricated endpoint", () => {
  const open = attempt({ endedAt: undefined, ms: 800000, queuedMs: 0, metrics: {
    activity: { version: 1, modelTiming: "observed", spans: [recorded("open-request", "model_request", 1100), recorded("open-wait", "first_token", 1100)] },
  } });
  const live = buildTimeView([open], { live: true, observedUntil: 1600 });
  const waiting = live.intervals.find(span => span.id === "open-wait")!;
  assert.equal(waiting.to, undefined); assert.equal(waiting.through, 1600); assert.equal(waiting.state, "running");
  assert.equal(live.totals.first, 500); assert.equal(live.coverage.running, 1);
  const historical = buildTimeView([open], { live: false, observedUntil: 800000 });
  assert.equal(historical.totals.first, 0); assert.equal(historical.coverage.unknownEnd, 1);
  assert.equal(historical.strip!.end, 1100);
  assert.equal(historical.strip!.markers[0].to, undefined); assert.equal(historical.strip!.markers[0].through, undefined);
  assert.equal(historical.strip!.markers[0].state, "unknown_end");
  assert.ok(!JSON.stringify(historical).includes("800000"));
  const closedAttemptWithUnclosedSpan = buildTimeView([{ ...open, endedAt: 2000 }], { live: false, observedUntil: 800000 });
  assert.equal(closedAttemptWithUnclosedSpan.coverage.unknownEnd, 1);
  assert.equal(closedAttemptWithUnclosedSpan.strip!.markers[0].to, undefined, "an attempt's terminal event cannot certify the missing phase end");
  assert.equal(closedAttemptWithUnclosedSpan.totals.unknown, 900);
});

test("unknown usage/cache differs from reported zero and partial coverage cannot claim a cache hit rate", () => {
  const missing = attempt({ input: 0, output: 0, cost: 0 });
  assert.equal(usageSummary([missing]).total, null); assert.equal(usageSummary([missing]).cacheHitRate, null);
  const zero = attempt({ input: 0, output: 0, cost: 0, cacheRead: 0, cacheWrite: 0, metrics: { usageReported: true, usageComplete: true, cacheUsageComplete: true } });
  assert.equal(usageSummary([zero]).total, 0); assert.equal(usageSummary([zero]).reported, 1);
  assert.equal(usageSummary([zero]).cacheHitRate, null, "no input means no cache-rate denominator");
  const noHits = { ...zero, input: 100 };
  assert.equal(usageSummary([noHits]).cacheHitRate, 0, "reported zero cache reads are a real zero rate");
  const cached = { ...noHits, cacheRead: 30, cacheWrite: 20 };
  assert.equal(usageSummary([cached]).cacheHitRate, 30 / 150);
  const partial = { ...cached, metrics: { usageReported: true, usageComplete: false, cacheUsageComplete: false } };
  assert.equal(usageSummary([partial]).input, 100); assert.equal(usageSummary([partial]).complete, 0);
  assert.equal(usageSummary([partial]).cacheHitRate, null);
  const projected = { ...cached, metrics: { usageReported: false } };
  assert.equal(usageSummary([projected]).total, null);
  assert.equal(usageSummary([attempt()]).total, 120, "legacy positive observations remain usable without inventing known zero");
  assert.equal(usageSummary([attempt({ cacheRead: 0, cacheWrite: 0 })]).cacheHitRate, null, "legacy zero fields without completeness metadata do not certify a zero hit rate");
});

test('replay pages freeze the upper sequence and preserve every ordered event', async () => {
  const controller = new AbortController(), progress: number[] = [], calls: URL[] = [];
  const result = await loadReplayEvents('fixture', controller.signal, count => progress.push(count), async input => {
    const url = new URL(String(input), 'http://fixture.test'); calls.push(url);
    const since = Number(url.searchParams.get('since'));
    assert.equal(url.searchParams.get('limit'), '200');
    if (since) assert.equal(url.searchParams.get('through'), '401');
    const events = Array.from({ length: Math.min(200, 401 - since) }, (_, index) => ({ seq: since + index + 1, at: 1, kind: 'dispatch.note', text: 'fixture' }));
    return new Response(JSON.stringify({ events, through: 401, nextSeq: events.at(-1)!.seq, done: since >= 400 }));
  });
  assert.equal(result.length, 401); assert.equal(calls.length, 3); assert.deepEqual(progress, [200, 400, 401]);
});

test('cancelled replay stops between pages and non-advancing/error pages reject instead of loading forever', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(loadReplayEvents('fixture', controller.signal, () => controller.abort(new Error('owner cancelled')), async () => {
    calls++; return new Response(JSON.stringify({ events: [{ seq: 1, at: 1 }], through: 2, nextSeq: 1, done: false }));
  }), /owner cancelled/);
  assert.equal(calls, 1);
  await assert.rejects(loadReplayEvents('fixture', new AbortController().signal, () => {}, async () => new Response(JSON.stringify({ events: [], through: 5, nextSeq: 0, done: false }))), /没有前进/);
  await assert.rejects(loadReplayEvents('fixture', new AbortController().signal, () => {}, async () => new Response('failed', { status: 500 })), /HTTP 500/);
});

test('a dense timeline renders at bounded resolution while retaining original intervals and all activity categories', () => {
  const intervals: DisplayInterval[] = Array.from({ length: 30000 }, (_, index) => ({ id: `span-${index}`, attempt: `attempt-${index % 20}`, from: index, to: index + 8, key: index % 2 ? 'tool' : 'output', quality: 'observed', state: 'ended' }));
  const strip = timeStrip(intervals)!;
  const display = timelineDisplay(strip);
  assert.equal(display.length, 480);
  assert.ok(display.every(segment => segment.intervals.length <= 6 && segment.aggregated));
  assert.ok(display.every(segment => segment.keys.includes('tool') && segment.keys.includes('output')));
  assert.equal(strip.segments.length, 30007, 'display aggregation cannot replace the original exact timeline');
  assert.equal(display[0].from, strip.start); assert.equal(display.at(-1)!.to, strip.end);
});

test('lazy detail reads reject an older response and cancel only when the last view leaves', async () => {
  const requests: {signal: AbortSignal; resolve: (value: {seq: number; result: unknown; bytes: number}) => void}[] = [];
  const target: DetailTarget = {kind: 'attempt', id: 'recorded-attempt'};
  const cache = new DetailCache(async (_target, signal) => new Promise(resolve => requests.push({signal, resolve})));
  const first = cache.watch(target, 10, () => {});
  const second = cache.watch(target, 10, () => {});
  assert.equal(requests.length, 1, 'two views share one request');
  cache.invalidate(target, 12);
  requests[0].resolve({seq: 11, result: {steps: ['stale response']}, bytes: 20});
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(cache.snapshot(target).data, undefined, 'a stale response cannot replace new projected progress');
  assert.equal(requests.length, 2);
  requests[1].resolve({seq: 12, result: {steps: ['complete current transcript']}, bytes: 30});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cache.snapshot(target).data, {steps: ['complete current transcript']});
  cache.invalidate(target, 13);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(requests.length, 3);
  first();
  assert.equal(requests[2].signal.aborted, false, 'leaving one view does not cancel another reader');
  second();
  assert.equal(requests[2].signal.aborted, true, 'leaving the last view cancels its actual fetch');
  requests[2].resolve({seq: 13, result: {steps: ['cancelled result']}, bytes: 30});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cache.snapshot(target).seq, 12, 'cancelled work cannot enter the cache');
  cache.clear();
});

test('detail cache bounds retained records and bytes without merging full data into the projection', async () => {
  let reads = 0;
  const cache = new DetailCache(async target => {
    reads++;
    return {seq: 20, result: {id: target.id, output: 'full output'}, bytes: target.id === 'oversized' ? 30 : 8};
  }, 2, 20);
  const targets: DetailTarget[] = ['one', 'two', 'three'].map(id => ({kind: 'attempt', id}));
  for (const target of targets) {
    const leave = cache.watch(target, 10, () => {});
    await new Promise(resolve => setImmediate(resolve));
    leave();
  }
  assert.equal(cache.snapshot(targets[0]).data, undefined);
  assert.ok(cache.snapshot(targets[1]).data);
  assert.ok(cache.snapshot(targets[2]).data);
  const before = reads;
  const cached = cache.watch(targets[2], 100, () => {});
  assert.equal(reads, before, 'unrelated global events do not invalidate a tracked target');
  cached();
  const oversized: DetailTarget = {kind: 'token', id: 'oversized'};
  const leave = cache.watch(oversized, 10, () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.match(cache.snapshot(oversized).error ?? '', /超过缓存上限/);
  assert.equal(cache.snapshot(oversized).data, undefined);
  leave();
  cache.clear();
  assert.equal(cache.snapshot(targets[2]).data, undefined);
  const previousView = cache.watch(targets[0], 10, () => {});
  cache.clear();
  const nextView = cache.watch(targets[0], 10, () => {});
  previousView();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cache.snapshot(targets[0]).data, {id: targets[0].id, output: 'full output'},
    'a watcher from a previous projection cannot delete a newer snapshot entry');
  nextView();
  cache.clear();
});
