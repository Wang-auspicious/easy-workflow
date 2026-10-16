import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {createRequire} from 'node:module';
import { Type } from "typebox";
import { configureAgentStations, runAgentStation } from "../server/agent-station.ts";
import { closeModelTransport } from "../server/pi.ts";
import { closeNetwork } from "../server/network.ts";
import { Journal } from "../server/journal.ts";
import { Toolbox } from "../server/toolbox.ts";
import { Broker } from "../server/broker.ts";
import type { Docs } from "../server/docs.ts";
import type { StationContext, StationResult } from "../server/runtime.ts";
import type { ActivitySpan, AttemptMetrics, Usage } from "../shared/types.ts";
import { compile } from "../server/spec/compile.ts";
import { pack } from "../packs/vislexicon/pack.ts";
import { apply, initialState } from "../shared/project.ts";
import { buildReport, stationReport } from "../server/report.ts";
import type { Factory } from "../server/factory.ts";

// Use the installed transport's Fetch denylist without changing its security policy.
const {badPorts} = createRequire(import.meta.url)('undici/lib/web/fetch/constants.js') as {badPorts: string[]};
const fetchForbiddenPorts = new Set(badPorts.map(Number));
async function listenLocal(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once('error', failed);
    server.listen(port, '127.0.0.1', () => {server.off('error', failed); resolve();});
  });
}
async function listenForFetch(server: http.Server): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!server.listening) await listenLocal(server, 0);
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    if (!fetchForbiddenPorts.has(address.port)) return address.port;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  throw new Error('The local fixture could not allocate a Fetch-permitted ephemeral port');
}

test('local HTTP fixture rebinds a Fetch-forbidden port without bypassing the denylist', async () => {
  let requests = 0;
  const server = http.createServer((_request, response) => {requests++; response.end('safe local fixture');});
  try {
    // These are non-privileged Fetch-denied ports. Try another only when occupied.
    for (const port of [6697, 10080, 6667, 6668, 6669, 6000]) {
      assert.ok(fetchForbiddenPorts.has(port));
      try {await listenLocal(server, port); break;}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;}
    }
    assert.ok(server.listening, 'the boundary regression needs one available forbidden port');
    const first = server.address();
    assert.ok(first && typeof first !== 'string');
    await assert.rejects(fetch(`http://127.0.0.1:${first.port}/`), error =>
      (error as Error & {cause?: Error}).cause?.message === 'bad port');
    assert.equal(requests, 0, 'Fetch still rejects the port before any HTTP request');
    const port = await listenForFetch(server);
    assert.ok(!fetchForbiddenPorts.has(port));
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'safe local fixture');
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

const gate = () => { let resolve!: () => void; const promise = new Promise<void>(ready => { resolve = ready; }); return { promise, resolve }; };
const eventually = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "expected real provider/tool boundary did not arrive");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

test("real SSE and HTTP tools persist overlapping activity, replay runs and retain cancellation boundaries", { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-activity-"));
  const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "FACTORY_MODEL", "FACTORY_PROVIDER", "FACTORY_STATION_COMMAND", "FACTORY_STATION_MODEL"].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = dir;
  for (const key of ["FACTORY_MODEL", "FACTORY_PROVIDER", "FACTORY_STATION_COMMAND", "FACTORY_STATION_MODEL"]) delete process.env[key];
  const scenarios = new Map<string, { first: ReturnType<typeof gate>; finish: ReturnType<typeof gate>; tools: ReturnType<typeof gate>[]; arrivals: Set<number>; hits: number[]; requests: number; bodies: any[]; useTools: boolean; failRequests: number[] }>();
  const scenario = (name: string, useTools = true) => {
    const value = { first: gate(), finish: gate(), tools: [gate(), gate()], arrivals: new Set<number>(), hits: [0, 0], requests: 0, bodies: [] as any[], useTools, failRequests: [] as number[] };
    scenarios.set(name, value); return value;
  };
  let origin = "";
  const server = http.createServer(async (req, res) => {
    try {
      const tool = req.url?.match(/^\/tool\/([^/]+)\/([01])$/);
      if (tool) {
        const current = scenarios.get(tool[1])!, index = Number(tool[2]); current.arrivals.add(index); current.hits[index]++;
        await current.tools[index].promise;
        res.writeHead(200, { "content-type": "text/plain" }); res.end(`Observed fixture ${index}`); return;
      }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const name = body.match(/activity-case:([a-z-]+)/)?.[1];
      assert.ok(name && scenarios.has(name));
      const current = scenarios.get(name)!; current.requests++; current.bodies.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
      const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "activity-fixture", object: "chat.completion.chunk", created: 1, model: "activity-fixture", choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } } : {}) })}\n\n`);
      if (current.failRequests.includes(current.requests)) {
        send({ role: "assistant", content: "DISCARDED-FAILURE: partial response before a real socket interruption. " });
        // Break an already streaming response, so transport-level HTTP retries cannot
        // hide the failed assistant turn that the station must resume explicitly.
        setTimeout(() => res.destroy(), 25); return;
      }
      if (current.requests === 1) {
        await current.first.promise;
        send({ role: "assistant", content: "Observed streamed output. " });
        await current.finish.promise;
      }
      const calls = current.requests === 1 && current.useTools
        ? [0, 1].map(index => ({ index, id: `${name}-tool-${index}`, type: "function", function: { name: "env_call", arguments: JSON.stringify({ name: "fetch_text", arguments: { url: `${origin}/tool/${name}/${index}` } }) } }))
        : [{ index: 0, id: `${name}-submit`, type: "function", function: { name: "submit", arguments: JSON.stringify({ answer: name }) } }];
      send({ tool_calls: calls }); send({}, "tool_calls"); res.end("data: [DONE]\n\n");
    } catch (error) { res.destroy(error as Error); }
  });
  origin = `http://127.0.0.1:${await listenForFetch(server)}`;
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultProvider: "activity-fixture", defaultModel: "activity-fixture" }));
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "activity-fixture": { type: "api_key", key: "local-activity-fixture" } }));
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { "activity-fixture": { api: "openai-completions", baseUrl: `${origin}/v1`, models: [{ id: "activity-fixture", input: ["text"] }] } } }));
  const compiled = compile([pack]), state = initialState(compiled);
  let journal = new Journal(path.join(dir, "journal.db"));
  journal.subscribe(event => apply(state, event));
  const run = "run-activity-recorded";
  journal.append({ kind: "run.started", runId: run, title: "Observed stream" });
  const docs = { dir, envelope: () => ({ text: "Local activity integration fixture", sizes: { role: 0, project: 0, context: 0, caseFile: 0 } }) } as unknown as Docs;
  const toolbox = new Toolbox({ journal, broker: new Broker({ model: 4, http: 4, browser: 1, cpu: 1 }), docs: () => docs });
  configureAgentStations({ docs: () => docs, toolbox: () => toolbox });
  let committed = 0;
  const start = (name: string, node = "curation/classify", timeoutMs?: number) => {
    const ctrl = new AbortController(), token = `token-${name}`, attempt = `attempt-${name}`, worker = `worker-${name}`;
    journal.append({ kind: "token.created", token, line: "curation", item: name, url: "https://example.test", source: "fixture" });
    journal.append({ kind: "worker.spawned", worker, node, label: name, reason: "fixture" });
    const began = journal.append({ kind: "attempt.started", attempt, token, node, worker, input: name });
    const ctx = { token: { id: token, item: name }, node: compiled.nodes.find(n => n.key === node)!, attempt, worker: { id: worker }, signal: ctrl.signal,
      progress: (text: string) => journal.append({ kind: "attempt.progress", attempt, text }),
      activity: (activity: ActivitySpan) => journal.append({ kind: "attempt.activity", attempt, activity }) } as unknown as StationContext;
    const finish = (result: StationResult, cancelled = false) => journal.append({ kind: "attempt.finished", attempt, ok: result.ok, cancelled, summary: result.summary,
      ms: Date.now() - began.at, queuedMs: 0, usage: result.usage, metrics: result.metrics });
    const pending = runAgentStation({ system: "Use the fixture tools, then submit.", tools: ["fetch_text"], timeoutMs, schema: Type.Object({ answer: Type.String() }),
      input: () => ({ text: `activity-case:${name}` }), after: () => { committed++; return { ok: true, summary: "observed" }; } }, ctx)
      .then(result => { finish(result); return result; }, error => { const partial = error as { usage?: Usage; metrics?: AttemptMetrics };
        finish({ ok: false, summary: "cancelled", usage: partial.usage, metrics: partial.metrics }, ctrl.signal.aborted); throw error; });
    return { ctrl, attempt, pending, spans: () => state.attempts[attempt]?.metrics?.activity?.spans ?? [] };
  };
  try {
    await t.test("request/wait/output boundaries are journaled while live, with concurrent stations and HTTP tools", async () => {
      const first = scenario("success"), other = scenario("other", false);
      const a = start("success"), b = start("other", "curation/facts");
      await eventually(() => first.requests === 1 && other.requests === 1);
      assert.equal(a.spans().filter(s => s.kind === "model_request" && s.status === "running").length, 1);
      const live = buildReport({ compiled, state, journal } as unknown as Factory, run);
      assert.ok(live.activity!.intervals.some(span => span.kind === "first_token" && span.durationMs === null));
      first.first.resolve(); other.first.resolve(); other.finish.resolve();
      await eventually(() => a.spans().some(s => s.kind === "model_output" && s.status === "running"));
      const wait = a.spans().find(s => s.kind === "first_token")!, output = a.spans().find(s => s.kind === "model_output")!;
      assert.equal(wait.endedAt, output.startedAt);
      assert.equal(wait.status, "completed"); assert.equal(output.endedAt, undefined);
      first.finish.resolve();
      await eventually(() => first.arrivals.size === 2);
      const tools = a.spans().filter(s => s.kind === "tool" && s.operation === "fetch_text");
      assert.equal(tools.length, 2); assert.ok(tools.every(s => s.status === "running"));
      assert.equal(new Set(tools.map(s => s.id)).size, 2);
      first.tools[1].resolve();
      await eventually(() => a.spans().some(s => s.kind === "tool" && s.status === "completed"));
      assert.ok(a.spans().some(s => s.kind === "tool" && s.status === "running"));
      first.tools[0].resolve();
      const [result, otherResult] = await Promise.all([a.pending, b.pending]);
      assert.equal(result.ok, true, result.error ?? "first station failed"); assert.equal(otherResult.ok, true, otherResult.error ?? "other station failed");
      assert.equal(result.metrics!.activity!.modelTiming, "observed");
      assert.equal(result.metrics!.time!.modelCalls, 2); assert.equal(result.metrics!.time!.toolCalls, 3);
      assert.ok(a.spans().every(s => s.endedAt !== undefined && s.endedAt >= s.startedAt));
      const requests = a.spans().filter(s => s.kind === "model_request");
      assert.ok(tools.every(s => s.requestId === requests[0].id));
      assert.ok(a.spans().filter(s => s.kind === "tool" && s.operation === "fetch_text").every(s => s.endedAt! <= requests[1].startedAt));
      assert.equal(new Set([...a.spans(), ...b.spans()].map(s => s.id)).size, a.spans().length + b.spans().length);
      assert.ok(!JSON.stringify(a.spans()).includes("local-activity-fixture"));
    });

    for (const phase of ["waiting", "output", "tools"] as const) await t.test(`cancellation during ${phase} closes only observed intervals and never commits output`, async () => {
      const name = `cancel-${phase}`, current = scenario(name), task = start(name), before = committed;
      const rejected = assert.rejects(task.pending, { name: "AbortError" });
      await eventually(() => current.requests === 1);
      if (phase !== "waiting") {
        current.first.resolve();
        await eventually(() => task.spans().some(span => span.kind === "model_output"));
      }
      if (phase === "tools") { current.finish.resolve(); await eventually(() => current.arrivals.size === 2); }
      task.ctrl.abort(); await rejected;
      assert.equal(committed, before);
      assert.ok(task.spans().every(span => span.endedAt !== undefined));
      assert.ok(task.spans().some(span => span.status === "cancelled"));
      assert.equal(task.spans().some(span => span.kind === "model_output"), phase !== "waiting");
      assert.equal(state.attempts[task.attempt].cancelled, true);
      if (phase === "tools") assert.equal(task.spans().filter(span => span.kind === "tool" && span.status === "cancelled").length, 2);
      current.first.resolve(); current.finish.resolve(); current.tools.forEach(tool => tool.resolve());
    });

    await t.test("socket failure after completed tools continues the same transcript once and retains usage and trace", async () => {
      const current = scenario("resume"); current.failRequests = [2];
      current.first.resolve(); current.finish.resolve(); current.tools.forEach(tool => tool.resolve());
      const task = start("resume"), result = await task.pending;
      assert.equal(result.ok, true, result.error ?? "continuation failed");
      assert.equal(current.requests, 3);
      assert.deepEqual(current.hits, [1, 1], "completed page tools must not execute again");
      const continuation = current.bodies[2].messages;
      assert.equal(continuation.at(-1).role, "tool");
      assert.equal(continuation.filter((message: { role: string }) => message.role === "tool").length, 2);
      assert.ok(JSON.stringify(continuation).includes("Observed fixture 0"));
      assert.ok(!JSON.stringify(continuation).includes("DISCARDED-FAILURE"));
      assert.equal(result.usage?.input, 40); assert.equal(result.usage?.output, 16);
      assert.equal(result.metrics?.usageComplete, false, "the failed response did not report billable usage");
      assert.equal(result.metrics?.time?.modelCalls, 3);
      assert.deepEqual(task.spans().filter(span => span.kind === "model_request").map(span => span.status), ["completed", "failed", "completed"]);
      assert.ok(state.attempts[task.attempt].steps.some(step => step.text.includes("DISCARDED-FAILURE")), "failed partial output remains auditable in trace");
      assert.equal(state.attempts[task.attempt].steps.filter(step => step.text.includes("保留已完成的工具结果")).length, 1);
    });

    await t.test("a second socket failure stops without a whole-station retry", async () => {
      const current = scenario("resume-limit"); current.failRequests = [2, 3];
      current.first.resolve(); current.finish.resolve(); current.tools.forEach(tool => tool.resolve());
      const before = committed, result = await start("resume-limit").pending;
      assert.equal(result.ok, false); assert.equal(committed, before);
      assert.equal(current.requests, 3); assert.deepEqual(current.hits, [1, 1]);
      assert.equal(result.metrics?.time?.modelCalls, 3);
      assert.equal(result.usage?.input, 20);
    });

    await t.test("continuation shares the original deadline and cancellation interrupts backoff", async () => {
      const limited = scenario("resume-budget", false); limited.failRequests = [1];
      limited.first.resolve(); limited.finish.resolve();
      const began = Date.now(), result = await start("resume-budget", "curation/classify", 250).pending;
      assert.equal(result.ok, false); assert.equal(limited.requests, 1);
      assert.ok(Date.now() - began < 1500, "recovery must not restart the model-session budget");
      const stopped = scenario("resume-cancel"); stopped.failRequests = [2];
      stopped.first.resolve(); stopped.finish.resolve(); stopped.tools.forEach(tool => tool.resolve());
      const task = start("resume-cancel"), rejected = assert.rejects(task.pending, { name: "AbortError" });
      await eventually(() => state.attempts[task.attempt].steps.some(step => step.text.includes("保留已完成的工具结果")));
      task.ctrl.abort(); await rejected;
      assert.equal(stopped.requests, 2); assert.deepEqual(stopped.hits, [1, 1]);
      assert.equal(state.attempts[task.attempt].usage.input, 20);
      assert.equal(task.spans().filter(span => span.kind === "model_request").length, 2);
    });

    await t.test("SQLite reopen and a later run preserve historical intervals and station filters", () => {
      journal.append({ kind: "run.ended", runId: run, manual: true });
      const factory = () => ({ compiled, state, journal } as unknown as Factory);
      const old = buildReport(factory(), run);
      journal.append({ kind: "run.started", runId: "run-activity-later", title: "later run" });
      journal.append({ kind: "attempt.started", attempt: "later-attempt", token: "later-token", node: "curation/classify", worker: "later-worker", input: "later" });
      journal.append({ kind: "attempt.activity", attempt: "later-attempt", activity: { id: "later-span", kind: "first_token", source: "model-stream", status: "running", startedAt: Date.now() } });
      journal.close(); journal = new Journal(path.join(dir, "journal.db"));
      const replayed = buildReport(factory(), run);
      assert.deepEqual(replayed.activity, old.activity);
      assert.ok(!replayed.activity!.intervals.some(span => span.id === "later-span"));
      const filtered = stationReport(replayed, "curation/facts");
      assert.equal(filtered.attempts.length, 1);
      assert.ok(filtered.activity!.intervals.every(span => span.node === "curation/facts"));
      assert.equal(filtered.metrics.coverage.attempts, 1);
      assert.equal(filtered.metrics.time.modelCalls, 1);
      assert.equal(replayed.activity!.coverage.unclosedSpans, 0);
      const incomplete = buildReport(factory(), "run-activity-later");
      assert.equal(incomplete.activity!.intervals[0].durationMs, null);
      assert.equal(incomplete.activity!.intervals[0].endedAt, undefined);
    });
  } finally {
    for (const value of scenarios.values()) { value.first.resolve(); value.finish.resolve(); value.tools.forEach(tool => tool.resolve()); }
    await closeModelTransport(); await closeNetwork(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); journal.close();
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("easy-workflow-activity-")); fs.rmSync(dir, { recursive: true, force: true });
  }
});
