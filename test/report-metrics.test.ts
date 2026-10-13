import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "../server/spec/compile.ts";
import { pack } from "../packs/vislexicon/pack.ts";
import { apply, initialState } from "../shared/project.ts";
import type { AttemptMetrics, JournalEvent, Stamped } from "../shared/types.ts";
import { aggregateMetrics, buildReport } from "../server/report.ts";
import type { Factory } from "../server/factory.ts";
import { Journal } from "../server/journal.ts";

test("report aggregates recorded token/time parts, preserves estimates and isolates historical runs", () => {
  const compiled = compile([pack]), events: Stamped[] = []; let run = "";
  const emit = (at: number, e: JournalEvent) => { if (e.kind === "run.started") run = e.runId; events.push({ ...e, seq: events.length + 1, at, run } as Stamped); };
  const metrics: AttemptMetrics = { usageReported: true, modelTimeReported: true,
    tokens: { system: 20, context: 10, caseFile: 30, input: 40, images: 1100, toolDefs: 50, toolResults: 60, output: 20, actualInput: 100, actualOutput: 20, cacheRead: 30, cacheWrite: 5 },
    time: { firstTokenMs: 100, outputMs: 500, toolMs: 200, programMs: 0, modelCalls: 2, toolCalls: 1 } };
  emit(1000, { kind: "run.started", runId: "run-metrics-old", title: "old metrics" });
  emit(1001, { kind: "token.created", token: "t1", line: "curation", item: "recorded", url: "https://example.test", source: "sources/watch" });
  emit(1100, { kind: "attempt.started", attempt: "a1", token: "t1", node: "curation/classify", worker: "w1", input: "recorded" });
  emit(2000, { kind: "attempt.finished", attempt: "a1", ok: true, summary: "done", ms: 900, queuedMs: 99, usage: { input: 100, output: 20, cost: .01, cacheRead: 30, cacheWrite: 5 }, metrics });
  emit(2001, { kind: "attempt.finished", attempt: "a1", ok: true, summary: "duplicate terminal receipt", ms: 900, queuedMs: 99, usage: { input: 100, output: 20, cost: .01, cacheRead: 30, cacheWrite: 5 }, metrics });
  emit(2100, { kind: "attempt.started", attempt: "a2", token: "t1", node: "curation/process", worker: "w2", input: "program" });
  emit(2200, { kind: "attempt.finished", attempt: "a2", ok: true, summary: "program", ms: 100, queuedMs: 10, metrics: { time: { firstTokenMs: 0, outputMs: 0, toolMs: 0, programMs: 100, modelCalls: 0, toolCalls: 0 } } });
  emit(2300, { kind: "attempt.started", attempt: "a3", token: "t1", node: "curation/facts", worker: "w3", input: "legacy" });
  emit(2400, { kind: "attempt.finished", attempt: "a3", ok: false, cancelled: true, summary: "cancelled", ms: 100, queuedMs: 5 });
  emit(2500, { kind: "run.ended", runId: "run-metrics-old", manual: true });
  emit(3000, { kind: "run.started", runId: "run-metrics-current", title: "new" });
  emit(3001, { kind: "token.created", token: "t2", line: "curation", item: "new", url: "https://example.test/2", source: "sources/watch" });
  emit(3100, { kind: "attempt.started", attempt: "a4", token: "t2", node: "curation/classify", worker: "w1", input: "new" });
  emit(4000, { kind: "attempt.finished", attempt: "a4", ok: true, summary: "new", ms: 900, queuedMs: 99, usage: { input: 999, output: 999, cost: 9 }, metrics });
  const state = initialState(compiled); for (const event of events) apply(state, event);
  const f = { compiled, state, journal: { seq: events.length, lastSequence: (id:string, through=events.length) => events.findLast(e=>e.run===id&&e.seq<=through)?.seq??0, read: (since = 0, id?: string, through=events.length) => events.filter(e => e.seq > since && e.seq<=through && (!id || e.run === id)) } } as unknown as Factory;
  const report = buildReport(f, "run-metrics-old"), m = report.metrics!;
  assert.equal(report.runId, "run-metrics-old"); assert.equal(state.run.id, "run-metrics-current");
  assert.deepEqual(m.tokens.actual, { input: 100, output: 20, cost: .01, cacheRead: 30, cacheWrite: 5 });
  assert.equal(report.totals.usage.input, 100, "duplicate terminal receipt must not double bill");
  assert.equal(m.tokens.estimated?.images, 1100); assert.ok(m.tokens.estimatedFields.includes("images"));
  assert.equal(m.tokens.cacheHitRate, 30 / 135);
  assert.equal(m.time.attemptMs, 1100); assert.equal(m.time.queuedMs, 114); assert.equal(m.time.otherMs, 200);
  assert.equal(m.time.firstTokenMs, 100); assert.equal(m.time.outputMs, 500); assert.equal(m.time.programMs, 100);
  assert.equal(m.time.outputTokensPerSecond, 40); assert.equal(m.time.modelCalls, 2);
  assert.deepEqual(m.coverage, { attempts: 3, finished: 3, tokenBreakdowns: 1, usageReported: 1, usageComplete: 1, cacheUsageComplete: 1, timeBreakdowns: 2, modelTimeReported: 2 });
  assert.deepEqual(report.attempts[0].metrics, metrics);
  assert.equal(report.attempts[0].cacheRead, 30);
  assert.equal(report.layers.flatMap(l => l.nodes).find(n => n.key === "curation/classify")?.metrics.tokens.actual?.input, 100);
});

test("missing measurements remain null; launcher omissions do not become actual zero tokens", () => {
  const empty = aggregateMetrics([], []);
  assert.equal(empty.tokens.actual, null); assert.equal(empty.tokens.estimated, null);
  assert.equal(empty.tokens.cacheHitRate, null); assert.equal(empty.time.outputTokensPerSecond, null); assert.equal(empty.time.outputMs, null);
  const attempt = { id: "a", token: "t", node: "n", worker: "w", input: "", startedAt: 0, endedAt: 100, ms: 100, usage: { input: 0, output: 0, cost: 0 }, steps: [], metrics: { usageReported: false, modelTimeReported: false, time: { firstTokenMs: 0, outputMs: 0, toolMs: 12, programMs: 0, modelCalls: 0, toolCalls: 1 } } };
  const result = aggregateMetrics([attempt], []);
  assert.equal(result.tokens.actual, null); assert.equal(result.time.outputMs, null);
  assert.equal(result.time.toolMs, 12); assert.equal(result.time.otherMs, 88);
});

test("partial usage remains an observed subtotal without a fabricated cache rate or speed", () => {
  const usage = { input: 100, output: 20, cost: .01, cacheRead: 5, cacheWrite: 0 };
  const attempt = { id: "a", token: "t", node: "n", worker: "w", input: "", startedAt: 0, endedAt: 100, ms: 100, usage, steps: [], metrics: { usageReported: true, usageComplete: false, cacheUsageComplete: false, modelTimeReported: true, time: { firstTokenMs: 10, outputMs: 50, toolMs: 12, programMs: 0, modelCalls: 2, toolCalls: 1 } } };
  const result = aggregateMetrics([attempt], [{ kind: "attempt.finished", attempt: "a", usage, ok: true, summary: "done", ms: 100, queuedMs: 0, seq: 1, at: 100, run: "run-partial" }]);
  assert.equal(result.tokens.actual?.input, 100); assert.equal(result.tokens.actual?.cacheRead, 5);
  assert.equal(result.coverage.usageReported, 1); assert.equal(result.coverage.usageComplete, 0); assert.equal(result.coverage.cacheUsageComplete, 0);
  assert.equal(result.tokens.cacheHitRate, null); assert.equal(result.time.outputTokensPerSecond, null);
});

test("historical waiting statistics survive a removed station without inventing a worker configuration suggestion", () => {
  const original = compile([pack]), state = initialState(original), journal = new Journal(":memory:");
  journal.subscribe(event => apply(state, event));
  try {
    const runId = "run-historical-wait";
    journal.append({ kind: "run.started", runId, title: "historical reader queue" });
    for (let i = 0; i < 3; i++) {
      const token = `historical-${i}`, attempt = `historical-attempt-${i}`;
      journal.append({ kind: "token.created", token, line: "curation", item: `recorded-${i}`, url: "https://example.test", source: "manual" });
      journal.append({ kind: "attempt.started", attempt, token, node: "curation/reader", worker: "old-reader", input: "recorded input" });
      journal.append({ kind: "attempt.finished", attempt, ok: true, summary: "read", ms: 100, queuedMs: 1000, usage: { input: 20, output: 10, cost: .01 } });
    }
    journal.append({ kind: "run.ended", runId, manual: true });
    const compiled = { ...original, nodes: original.nodes.filter(node => node.key !== "curation/reader") };
    const report = buildReport({ compiled, state, journal } as unknown as Factory, runId);
    const historical = report.layers.flatMap(layer => layer.nodes).find(node => node.key === "curation/reader")!;
    assert.equal(historical.processed, 3);
    assert.equal(historical.metrics.coverage.attempts, 3);
    assert.equal(historical.metrics.time.attemptMs, 300);
    assert.equal(historical.metrics.time.queuedMs, 3000);
    assert.equal(historical.metrics.tokens.actual?.input, 60);
    assert.equal(historical.metrics.tokens.actual?.output, 30);
    assert.equal(historical.waitShare, 3000 / 3300);
    assert.equal(report.insights.find(insight => insight.id === "wait")?.node, "curation/reader", "historical queue evidence must remain visible");
    assert.ok(report.suggestions.every(suggestion => !suggestion.prompt.includes("workers.max")), "no known current worker configuration exists for this deleted node");
  } finally { journal.close(); }
});
