import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Journal } from "../server/journal.ts";
import { compile } from "../server/spec/compile.ts";
import { pack } from "../packs/vislexicon/pack.ts";
import { apply, initialState } from "../shared/project.ts";
import type { Factory } from "../server/factory.ts";
import type { ActivitySpan, AttemptMetrics } from "../shared/types.ts";

test("read_report rebuilds a legacy cache for its own run, filters stations and never invents interval ends", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-report-activity-"));
  const prior = process.env.FACTORY_VAR; process.env.FACTORY_VAR = dir;
  const { FactoryControl } = await import("../server/control.ts");
  const { buildReport } = await import("../server/report.ts");
  const compiled = compile([pack]), state = initialState(compiled), journal = new Journal(path.join(dir, "journal.db"));
  journal.subscribe(event => apply(state, event));
  const oldRun = "run-activity-cache-old";
  journal.append({ kind: "run.started", runId: oldRun, title: "historical" });
  const begin = (attempt: string, node: string) => {
    journal.append({ kind: "token.created", token: attempt, line: "curation", item: attempt, url: "https://example.test", source: "fixture" });
    journal.append({ kind: "attempt.started", attempt, token: attempt, node, worker: attempt, input: "fixture" });
  };
  const observed: ActivitySpan = { id: "request-old", kind: "model_request", source: "model-stream", status: "running", startedAt: Date.now() };
  begin("a-observed", "curation/classify");
  journal.append({ kind: "attempt.activity", attempt: "a-observed", activity: observed });
  journal.append({ kind: "attempt.activity", attempt: "a-observed", activity: { ...observed, endedAt: observed.startedAt + 20, status: "completed" } });
  // A duplicate start must not reopen a completed span; a legacy terminal event must
  // not erase boundary data collected independently of the final metrics object.
  journal.append({ kind: "attempt.activity", attempt: "a-observed", activity: observed });
  journal.append({ kind: "attempt.finished", attempt: "a-observed", ok: true, summary: "observed", ms: 20, queuedMs: 0 });
  begin("a-closed", "curation/facts");
  const aggregateOnly: AttemptMetrics = { execution: { adapter: "closed-command", model: "fixture" }, modelTimeReported: true,
    time: { firstTokenMs: 20, outputMs: 50, toolMs: 0, programMs: 0, modelCalls: 1, toolCalls: 0 },
    activity: { version: 1, modelTiming: "unavailable", spans: [] } };
  journal.append({ kind: "attempt.finished", attempt: "a-closed", ok: true, summary: "aggregate only", ms: 80, queuedMs: 0, metrics: aggregateOnly, usage: { input: 20, output: 10, cost: .01 } });
  begin("a-interrupted", "curation/reader");
  journal.append({ kind: "attempt.activity", attempt: "a-interrupted", activity: { id: "request-unclosed", kind: "model_request", source: "model-stream", status: "running", startedAt: Date.now() } });
  journal.append({ kind: "run.ended", runId: oldRun, manual: true });
  const factory = { compiled, state, journal } as unknown as Factory;
  const cache = { ...buildReport(factory, oldRun), activity: undefined };
  const cachePath = path.join(dir, "runs", oldRun, "report.json");
  fs.mkdirSync(path.dirname(cachePath), { recursive: true }); fs.writeFileSync(cachePath, JSON.stringify(cache));
  const before = fs.readFileSync(cachePath);
  journal.append({ kind: "run.started", runId: "run-activity-current", title: "current" });
  begin("a-current", "curation/classify");
  journal.append({ kind: "attempt.activity", attempt: "a-current", activity: { ...observed, id: "current-only", startedAt: Date.now() } });
  const control = new FactoryControl(factory);
  try {
    const old = (await control.execute("read_report", { runId: oldRun })).result;
    assert.equal(old.runId, oldRun); assert.equal(old.title, "historical");
    assert.deepEqual(old.activity.intervals.map((span: ActivitySpan) => span.id), ["request-old", "request-unclosed"]);
    assert.equal(old.activity.intervals[0].durationMs, 20);
    assert.equal(old.activity.intervals[1].durationMs, null);
    assert.equal(old.activity.intervals[1].endedAt, undefined);
    assert.equal(old.activity.coverage.unclosedSpans, 1);
    assert.equal(old.activity.coverage.modelTimingUnknown, 1);
    assert.deepEqual(fs.readFileSync(cachePath), before, "reading must not replace historical cache bytes");
    const call = control.agentTools().find(tool => tool.name === 'h2_call')!;
    const agentReply = await call.execute('report-summary', {name: 'read_report', arguments: {runId: oldRun}});
    const agentReceipt = agentReply.details.result as {result: Record<string, unknown>};
    assert.equal(agentReceipt.result.view, 'summary', 'dispatcher report reads must default to bounded results');
    assert.deepEqual(agentReceipt.result.totals, old.totals);
    assert.deepEqual(agentReceipt.result.metrics, old.metrics);
    const explicitFull = await call.execute('report-full', {name: 'read_report', arguments: {runId: oldRun, view: 'full'}});
    const fullReceipt = explicitFull.details.result as {result: typeof old};
    assert.deepEqual(fullReceipt.result.activity, old.activity, 'explicit full reads retain the raw report contract');
    const station = (await control.execute("read_report", { runId: oldRun, station: "curation/facts" })).result;
    assert.equal(station.runId, oldRun); assert.equal(station.station, "curation/facts");
    assert.deepEqual(station.attempts.map((a: { id: string }) => a.id), ["a-closed"]);
    assert.equal(station.metrics.time.outputMs, 50, "reported aggregate durations remain available separately");
    assert.deepEqual(station.activity.intervals, [], "durations cannot create positioned spans");
    assert.equal(station.activity.coverage.modelTimingUnknown, 1);
    assert.equal(station.totals, undefined, "filtered results must not present whole-run totals as station totals");
    const stationSummary = (await control.execute('read_report', {runId: oldRun, station: 'curation/facts', view: 'summary'})).result;
    assert.equal(stationSummary.view, 'summary');
    assert.equal(stationSummary.totals, undefined);
    assert.deepEqual(stationSummary.metrics, station.metrics);
    assert.deepEqual(stationSummary.activity.coverage, station.activity.coverage);
    assert.equal(stationSummary.counts.attempts, 1);
    assert.equal(stationSummary.counts.activityIntervals, 0);
    const changed = { ...factory, compiled: { ...compiled, nodes: compiled.nodes.filter(node => node.key !== "curation/facts") } } as Factory;
    const removed = (await new FactoryControl(changed).execute("read_report", { runId: oldRun, station: "curation/facts" })).result;
    assert.deepEqual(removed.metrics, station.metrics, "a deleted station retains its own journal-backed metrics");
    assert.equal(removed.metrics.coverage.attempts, 1);
    assert.equal(removed.metrics.time.attemptMs, 80);
    assert.equal(removed.metrics.tokens.actual.input, 20); assert.equal(removed.metrics.tokens.actual.output, 10);
    assert.deepEqual(removed.activity, station.activity);
    const oldNode = buildReport(changed, oldRun).layers.flatMap(layer => layer.nodes).find(node => node.key === "curation/facts")!;
    assert.equal(oldNode.role, "historical"); assert.equal(oldNode.layer, 0, "missing historical layout metadata remains explicitly unknown");
    await assert.rejects(control.execute("read_report", { runId: oldRun, station: "missing/station" }), /没有这个工位/);
    await assert.rejects(control.execute("read_report", { runId: "run-not-present" }), /没有这轮报告/);
  } finally {
    journal.close(); if (prior === undefined) delete process.env.FACTORY_VAR; else process.env.FACTORY_VAR = prior;
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("easy-workflow-report-activity-")); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('large journal reports have bounded summaries without losing totals or unknown measurement coverage', async () => {
  const {buildReport, stationReport} = await import('../server/report.ts');
  const {compactReport} = await import('../shared/report-summary.ts');
  const compiled = compile([pack]);
  const state = initialState(compiled);
  const journal = new Journal(':memory:');
  journal.subscribe(event => apply(state, event));
  try {
    const runId = 'run-large-report-summary';
    journal.append({kind: 'run.started', runId, title: 'large report regression'});
    journal.append({kind: 'batch.configured', batch: {runId, target: 500, mode: 'paused',
      maxInFlight: 3, intakeWindow: 1, maxRecoveries: 2, startedAt: Date.now()}});
    const nodes = compiled.nodes.filter(node => !['source', 'store'].includes(node.kind)).slice(0, 16);
    for (const node of nodes) {
      journal.append({kind: 'worker.spawned', node: node.key, worker: `worker-${node.key}`, label: node.key, reason: 'fixture'});
    }
    const body = 'full retained tool result '.repeat(350);
    for (let index = 0; index < 260; index++) {
      const id = `large-${index}`;
      const node = nodes[index % nodes.length].key;
      journal.append({kind: 'token.created', token: id, line: 'curation', item: id, url: 'https://example.test', source: 'fixture'});
      journal.append({kind: 'attempt.started', attempt: id, token: id, node, worker: `worker-${node}`, input: 'fixture'});
      for (let step = 0; step < 4; step++) {
        journal.append({kind: 'attempt.progress', attempt: id, text: body, step: {tool: 'read', text: body}});
      }
      const knownCost = index % 2 === 0;
      const metrics: AttemptMetrics = {
        usageReported: true, usageComplete: knownCost, costReported: knownCost, costComplete: knownCost,
        tokenUsage: {input: 120, output: 30}, modelTimeReported: false,
        activity: {version: 1, modelTiming: 'unavailable', spans: [
          {id: `${id}-open`, kind: 'tool', source: 'tool-executor', status: 'running', startedAt: Date.now()},
        ]},
      };
      journal.append({kind: 'attempt.finished', attempt: id, ok: true, summary: 'recorded', ms: 100, queuedMs: 10,
        usage: knownCost ? {input: 120, output: 30, cost: 0} : undefined, metrics});
    }
    journal.append({kind: 'run.ended', runId, manual: true});
    const report = buildReport({compiled, state, journal} as unknown as Factory, runId);
    const original = JSON.stringify(report);
    assert.ok(original.length > 8_000_000, 'exercise the measured multi-megabyte report failure pattern');
    const summary = compactReport(report)!;
    const serialized = JSON.stringify(summary);
    assert.ok(serialized.length < 24_000, `bounded summary was ${serialized.length} characters`);
    assert.deepEqual(summary.metrics, report.metrics);
    assert.deepEqual(summary.totals, report.totals);
    assert.deepEqual(JSON.parse(JSON.stringify(summary.batch)), JSON.parse(JSON.stringify(report.batch)));
    assert.deepEqual((summary.activity as {coverage: unknown}).coverage, report.activity!.coverage);
    const counts = summary.counts as Record<string, number>;
    assert.equal(counts.attempts, 260);
    assert.equal(counts.steps, 1040);
    assert.equal(counts.stations, 16);
    assert.equal(counts.workers, report.workers.length);
    assert.equal(counts.workerSpans, report.workers.reduce((count, worker) => count + worker.spans.length, 0));
    assert.equal(counts.activityIntervals, 260);
    assert.equal(report.metrics!.coverage.costReported, 130);
    assert.equal(report.metrics!.coverage.usageComplete, 130);
    assert.equal(report.metrics!.tokens.actual!.cost, 0, 'known zero remains a subtotal with partial cost coverage');
    assert.equal(report.metrics!.time.outputMs, null, 'missing model timing remains unknown');
    const attempts = summary.attempts as {id: string; steps?: unknown}[];
    assert.equal(attempts.length, 6);
    assert.deepEqual(attempts.map(attempt => attempt.id), [...report.attempts]
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
      .slice(0, 6).map(attempt => attempt.id));
    assert.ok(attempts.every(attempt => attempt.steps === undefined));
    assert.equal((summary.stations as unknown[]).length, 8);
    assert.ok(!serialized.includes(body));
    assert.ok(!/"(?:intervals|spans|workers)":\[/.test(serialized));
    assert.equal(JSON.stringify(report), original, 'compaction never mutates authoritative report data');
    assert.deepEqual(JSON.parse(JSON.stringify(compactReport(summary))), JSON.parse(serialized), 'recompaction preserves full counts');
    const station = stationReport(report, nodes[0].key);
    const stationSummary = compactReport(station)!;
    assert.equal(stationSummary.totals, undefined);
    assert.equal(stationSummary.batch, undefined);
    assert.deepEqual(stationSummary.metrics, station.metrics);
    assert.equal((stationSummary.counts as Record<string, number>).attempts, station.attempts.length);
    assert.equal(compactReport({version: 3, runId, attempts: []}), undefined);
    assert.equal(compactReport({ok: true, result: report}), undefined, 'callers must identify the actual report payload');
  } finally {
    journal.close();
  }
});
