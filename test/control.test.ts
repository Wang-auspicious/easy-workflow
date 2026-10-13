import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from 'node:http';
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import h2Extension from "../integrations/pi/h2-factory.ts";
import {Journal} from '../server/journal.ts';
import type {SourceSpec} from '../shared/types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const secret = "factory-test-only";

async function start(dir: string, readOnly = false) {
  const child = fork(path.join(root, "server/main.ts"), [], {
    cwd: root, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, VISLEXICON_ROOT: path.join(dir, "unconnected"), FACTORY_DISCOVERY: "0", FACTORY_PREFLIGHT: "0", FACTORY_HTTP_CACHE: "0", FACTORY_ROOT: root, FACTORY_PORT: "0", FACTORY_TOKEN: secret,
      FACTORY_VAR: dir, FACTORY_LAYOUT: path.join(dir, "layout.json"), FACTORY_START_PAUSED: "1", FACTORY_READONLY: readOnly ? "1" : "0" },
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`server startup timed out: ${output}`)); }, 20000);
    child.once("error", (err) => { clearTimeout(timer); reject(err); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${output}`)); });
    child.on("message", (message: { type?: string; url?: string }) => {
      if (message.type === "ready" && message.url) { clearTimeout(timer); resolve(message.url); }
    });
  });
  const request = async (route: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(url + route, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() as any };
  };
  const tool = (name: string, args: unknown = {}) => request(`/api/tools/${name}`, args);
  return { child, url, request, tool };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill(), 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send({ type: "shutdown" }); else child.kill();
  });
}

test("headless service: real HTTP capability discovery, control, validation, activation and restart", { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h2-control-"));
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    server = await start(dir);
    let { request, tool } = server;
    await t.test("Bearer authentication and discoverable JSON schemas", async () => {
      assert.equal((await fetch(server!.url + "/api/state")).status, 401);
      assert.equal((await request("/api/state", undefined, { authorization: "Bearer wrong-token" })).status, 401);
      const discovery = await request("/.well-known/agent.json");
      assert.equal(discovery.status, 200);
      assert.equal(discovery.body.transport, "http-json");
      for (const name of ["status", "inspect", "feed_urls", "propose_patch", "decide_patch", "read_report"]) {
        const entry = discovery.body.tools.find((x: any) => x.name === name);
        assert.ok(entry, name);
        assert.equal(entry.inputSchema.type, "object");
        assert.equal(entry.inputSchema.additionalProperties, false);
      }
      assert.equal((await tool("status")).body.ok, true);
    });
    await t.test("Pi bootstraps automatically with compact, current capabilities and lazy schemas", async () => {
      const bootstrap = await request("/api/agent/bootstrap");
      assert.equal(bootstrap.body.protocol, "h2-agent/1");
      assert.ok(bootstrap.body.instructions.length < 1500);
      assert.ok(!JSON.stringify(bootstrap.body).includes(secret));
      assert.ok(bootstrap.body.tools.every((x: any) => !x.inputSchema));
      const part = bootstrap.body.parts.find((p: any) => p.name === "资源采集");
      assert.ok(part);
      const detail = await tool("inspect", { part: part.id });
      assert.equal(detail.body.result.totals.stations, 7);
      assert.equal(detail.body.result.totals.inFlight, 0);
      assert.deepEqual(detail.body.result.recent, []);
      assert.equal((await request("/api/agent/tools/feed_urls")).body.inputSchema.type, "object");
      assert.equal((await request("/api/agent/bootstrap", {})).status, 405);
      assert.equal((await request("/api/agent/tools/nope")).status, 404);
      const connection = path.join(dir, "agent-connection.json");
      fs.writeFileSync(connection, JSON.stringify({ protocol: "h2-agent/1", url: server!.url, token: secret }));
      const previous = process.env.FACTORY_AGENT_CONNECTION;
      process.env.FACTORY_AGENT_CONNECTION = connection;
      try {
        const registered = new Map<string, any>(), handlers = new Map<string, any>();
        h2Extension({ registerTool: (tool) => registered.set(tool.name, tool), on: (name, fn) => handlers.set(name, fn) });
        assert.deepEqual([...registered.keys()], ["easy_workflow_help", "easy_workflow_call", "h2_help", "h2_call"]);
        const hook = handlers.get("before_agent_start");
        const first = await hook({ systemPrompt: "base" });
        const second = await hook({ systemPrompt: first.systemPrompt });
        assert.equal((second.systemPrompt.match(/<easy-workflow-agent>/g) ?? []).length, 1);
        assert.ok(!second.systemPrompt.includes("<h2-agent>"));
        assert.ok(!second.systemPrompt.includes(secret));
        assert.ok(second.systemPrompt.includes(bootstrap.body.revision));
        const reply = await registered.get("easy_workflow_call").execute("test", { name: "status", arguments: {} });
        assert.equal(JSON.parse(reply.content[0].text).ok, true);
        const legacy = await registered.get("h2_call").execute("test", { name: "status", arguments: {} });
        assert.equal(JSON.parse(legacy.content[0].text).ok, true);
      } finally {
        if (previous === undefined) delete process.env.FACTORY_AGENT_CONNECTION; else process.env.FACTORY_AGENT_CONNECTION = previous;
      }
    });
    await t.test("invalid inputs and unknown endpoints fail before changing state", async () => {
      const before = (await request("/api/state")).body;
      assert.equal((await tool("pull_candidates", { count: -2 })).status, 400);
      assert.equal((await tool("run_control", { action: "typo" })).status, 400);
      assert.equal((await request("/api/run", { action: "typo" })).status, 400);
      assert.equal((await tool("feed_urls", { urls: ["file:///C:/private"] })).status, 400);
      assert.equal((await tool("feed_urls", { urls: ["https://user:password@example.test"] })).status, 400);
      assert.equal((await tool("settings", { values: { browser: 99 } })).status, 400);
      assert.equal((await tool("no_such_tool")).status, 404);
      assert.equal((await request("/api/typo")).status, 404);
      assert.equal((await request("/api/state", {})).status, 405);
      assert.equal((await request("/api/events?since=invalid")).status, 400);
      assert.equal((await tool("inspect", { token: "missing" })).status, 404);
      const after = (await request("/api/state")).body;
      assert.deepEqual(after.run, before.run);
      assert.deepEqual(after.tokens, before.tokens);
    });
    let runId = "";
    await t.test("start cannot replace a paused run; feed returns inspectable token ids", async () => {
      runId = (await tool("run_control", { action: "start", title: "isolated API test" })).body.result.id;
      await tool("run_control", { action: "pause" });
      const again = await request("/api/run", { action: "start", title: "must not replace" });
      assert.equal(again.body.run.id, runId);
      assert.equal(again.body.run.status, "paused");
      const feed = await tool("feed_urls", { urls: ["https://a.example.test", "https://b.example.test"] });
      assert.equal(feed.body.result.fed, 2);
      for (const token of feed.body.result.tokens) {
        const detail = await tool("inspect", { token: token.id });
        assert.equal(detail.body.result.status, "active");
        assert.deepEqual(detail.body.result.attempts, []); // No model or website request runs while paused.
        assert.deepEqual(detail.body.result.evidence, []);
      }
      const badCorrection = await tool("correct", { token: feed.body.result.tokens[0].id, station: "no/such/station", reason: "test" });
      assert.equal(badCorrection.status, 409);
    });
    let patchId = "";
    await t.test("patches validate, cannot activate during a run, and take effect after ending", async () => {
      const bad = await tool("propose_patch", { summary: "invalid numeric value", ops: [{ op: "set", station: "curation/proof", field: "workers.max", value: -1 }] });
      assert.ok(bad.body.result.compileIssues.length > 0);
      assert.equal((await tool("decide_patch", { id: bad.body.result.id, accept: true })).status, 422);
      const unknownLine = await tool("propose_patch", { summary: "unknown line", ops: [{ op: "add-edge", from: "missing/a", to: "missing/b" }] });
      assert.equal(unknownLine.status, 200);
      assert.ok(unknownLine.body.result.compileIssues.length > 0);
      const draft = await tool("propose_patch", { summary: "rename proof station", ops: [{ op: "set", station: "curation/proof", field: "name", value: "特写验收工位" }] });
      patchId = draft.body.result.id;
      assert.equal((await tool("decide_patch", { id: patchId, accept: true })).status, 409);
      await tool("run_control", { action: "end" });
      const decision = await tool("decide_patch", { id: patchId, accept: true });
      assert.equal(decision.status, 200);
      const spec = await tool("read_spec");
      assert.equal(spec.body.result.factory.nodes.find((n: any) => n.key === "curation/proof").name, "特写验收工位");
      assert.equal((await request("/api/state")).body.digest, decision.body.result.digest);
      assert.equal((await tool("read_report", { runId })).status, 200);
      const unwired = await tool("propose_patch", { summary: "no executor", ops: [{ op: "add-station", line: "curation", after: "proof", station: { id: "new-reviewer", name: "未接入审查" } }] });
      const rejection = await tool("decide_patch", { id: unwired.body.result.id, accept: true });
      assert.equal(rejection.status, 422);
      assert.equal(rejection.body.code, "missing_executor");
    });
    await t.test("worker locks are journaled; SSE reconnect uses Last-Event-ID", async () => {
      const lock = await tool("workers", { station: "curation/proof", action: "lock", reason: "test fixed staffing" });
      assert.equal(lock.status, 200);
      assert.ok((await request("/api/state")).body.lockedStations.includes("curation/proof"));
      const cursor = lock.body.seq - 1;
      const controller = new AbortController();
      const stream = await fetch(server!.url + "/api/events?since=0", { headers: { authorization: `Bearer ${secret}`, "last-event-id": String(cursor) }, signal: controller.signal });
      const reader = stream.body!.getReader();
      try {
        const chunk = new TextDecoder().decode((await reader.read()).value);
        assert.match(chunk, new RegExp(`^id: ${cursor + 1}\\n`));
      } finally { await reader.cancel(); controller.abort(); }
    });
    await stop(server.child);
    server = await start(dir);
    ({ request, tool } = server);
    await t.test("accepted graph and worker lock survive a real process restart", async () => {
      const inspection = await tool("inspect", { station: "curation/proof" });
      assert.equal(inspection.body.result.spec.name, "特写验收工位");
      assert.equal(inspection.body.result.locked, true);
      assert.equal((await request("/api/state")).body.run.id, runId);
      assert.equal((await tool("read_spec")).body.result.patches.find((p: any) => p.id === patchId).status, "accepted");
    });
    await stop(server.child);
    server = await start(dir, true);
    ({ request, tool } = server);
    await t.test("read-only workspaces expose read tools and reject mutations without journal writes", async () => {
      const before = (await request("/api/state")).body.seq;
      assert.equal((await tool("status")).status, 200);
      assert.equal((await tool("settings")).status, 200);
      assert.equal((await tool("inspect", { station: "curation/proof" })).body.result.locked, true);
      assert.equal((await tool("workers", { station: "curation/proof", action: "unlock", reason: "must be rejected" })).status, 403);
      assert.equal((await tool("feed_urls", { urls: ["https://c.example.test"] })).status, 403);
      assert.equal((await request("/api/state")).body.seq, before);
    });
  } finally {
    if (server) await stop(server.child);
    // Only remove this test's freshly created, resolved temp directory.
    assert.ok(path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()), "h2-control-")));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('configured sources use real HTTP, retain provenance and survive lifecycle boundaries without extra delivery', {timeout: 60000}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-control-sources-'));
  const hits = new Map<string, number>();
  let heldClosed = false;
  const feed = http.createServer((request, response) => {
    const route = request.url ?? '/';
    hits.set(route, (hits.get(route) ?? 0) + 1);
    if (route === '/hold') {
      response.once('close', () => {heldClosed = true;});
      return;
    }
    if (route === '/oversized') {
      response.writeHead(200, {'content-type': 'application/json', 'content-length': 3 * 1024 * 1024});
      response.write('[');
      return;
    }
    if (route === '/rss') {
      response.setHeader('content-type', 'application/rss+xml');
      response.end('<rss><channel><item><title>Same recommendation</title><link>https://resource.fixture.test/shared</link><author>Second author</author></item></channel></rss>');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(route === '/mixed' ? [
      null, {}, 'not a record', {url: 42}, {url: {href: '/fake'}},
      {url: 'https://resource.fixture.test/shared?utm_source=feed', title: 'Shared recommendation', author: 'First author'},
      {url: 'https://resource.fixture.test/shared#chapter', title: 'Same resource'},
      {url: 'https://resource.fixture.test/app#/second', title: 'Distinct SPA route'},
    ] : [{url: 'https://resource.fixture.test/catchup', title: 'Missed scheduled item'}]));
  });
  await new Promise<void>(resolve => feed.listen(0, '127.0.0.1', resolve));
  const port = (feed.address() as {port: number}).port;
  let server: Awaited<ReturnType<typeof start>> | undefined;
  const waitFor = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 7000;
    while (!await predicate()) {
      if (Date.now() >= deadline) throw new Error('Source fixture state did not settle');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const spec = (id: string, route: string): SourceSpec => ({
    id, name: id, url: `http://127.0.0.1:${port}${route}`, format: 'json',
    platform: `fixture-${id}`, target: 'candidates/tidy', intervalMs: 86400000, enabled: false,
  });
  try {
    server = await start(dir);
    assert.deepEqual((await server.tool('source_list')).body.result.sources, []);
    assert.equal(hits.size, 0, 'an unconfigured project makes no source requests');
    const mixed = spec('mixed', '/mixed');
    assert.equal((await server.tool('source_configure', mixed)).status, 403);
    assert.equal((await server.request('/api/sources/configure', {...mixed, target: 'curation/published'})).status, 422);
    const configured = await server.request('/api/sources/configure', mixed);
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    assert.equal(hits.size, 0, 'configuration defaults and explicit disabled state do not collect');
    const first = await server.tool('source_poll', {id: mixed.id});
    assert.equal(first.status, 200);
    assert.equal(first.body.result.count, 2);
    assert.equal(first.body.result.duplicates, 1);
    assert.equal(first.body.result.invalid, 5);
    const deferred = await server.tool('source_poll', {id: mixed.id});
    assert.equal(deferred.body.result.deferred, true);
    assert.equal(hits.get('/mixed'), 1, 'manual polling cannot bypass the persisted platform deadline');

    const rss = {...spec('rss', '/rss'), format: 'rss' as const};
    await server.request('/api/sources/configure', rss);
    assert.equal((await server.tool('source_poll', {id: rss.id})).body.result.duplicates, 1);
    const sources = (await server.tool('source_list')).body.result.sources;
    const shared = sources.find((source: {id: string}) => source.id === mixed.id).candidates.find((candidate: {url: string}) => candidate.url.endsWith('/shared'));
    assert.deepEqual(shared.origins.map((origin: {source: string}) => origin.source), ['mixed', 'rss']);
    assert.equal(sources.find((source: {id: string}) => source.id === rss.id).candidates[0].id, shared.id);
    assert.equal(Object.keys((await server.request('/api/state')).body.tokens).length, 0, 'disabled collection preserves candidates without creating work');
    assert.equal((await server.tool('source_enable', {id: rss.id, enabled: true})).status, 403);
    assert.equal((await server.request('/api/sources/enable', {id: rss.id, enabled: true})).status, 200);
    assert.equal((await server.request('/api/sources/enable', {id: rss.id, enabled: false})).status, 200);
    const afterToggle = (await server.tool('source_list')).body.result.sources.find((source: {id: string}) => source.id === rss.id);
    assert.equal(afterToggle.duplicates, 1, 'enable/disable preserves the last actual poll receipt');
    assert.ok(afterToggle.nextAt > Date.now(), 'enable/disable does not reset the schedule to immediate polling');

    const oversized = spec('oversized', '/oversized');
    await server.request('/api/sources/configure', oversized);
    assert.equal((await server.tool('source_poll', {id: oversized.id})).status, 409);
    const oversizedStatus = (await server.tool('source_list')).body.result.sources.find((source: {id: string}) => source.id === oversized.id);
    assert.match(oversizedStatus.attention, /2097152 bytes/);
    assert.equal((await server.tool('status')).status, 200, 'a single source error never stalls the service');

    const catchup = spec('catchup', '/catchup');
    await server.request('/api/sources/configure', catchup);
    await stop(server.child);
    server = undefined;
    const journal = new Journal(path.join(dir, 'journal.db'));
    // A persisted, explicitly enabled source missed its scheduled time while closed.
    journal.append({kind: 'source.configured', source: {...catchup, enabled: true}});
    journal.append({kind: 'source.polled', source: catchup.id, nextAt: Date.now() - 60000, count: 0, duplicates: 0});
    journal.close();
    server = await start(dir);
    await waitFor(async () => (await server!.tool('source_list')).body.result.sources.some((source: {id: string; count: number}) => source.id === catchup.id && source.count === 1));
    assert.equal(hits.get('/catchup'), 1);
    await stop(server.child);
    server = await start(dir);
    const resumed = (await server.tool('source_list')).body.result.sources;
    assert.equal(resumed.find((source: {id: string}) => source.id === catchup.id).count, 1);
    assert.equal(hits.get('/catchup'), 1, 'restart does not collect again before the durable next deadline');
    assert.equal(Object.keys((await server.request('/api/state')).body.tokens).length, 0, 'an idle restart does not start a workflow to deliver sources');

    const hold = spec('hold', '/hold');
    await server.request('/api/sources/configure', hold);
    await server.request('/api/sources/enable', {id: hold.id, enabled: true});
    await waitFor(async () => hits.get('/hold') === 1);
    const closingAt = Date.now();
    await stop(server.child);
    server = undefined;
    assert.ok(Date.now() - closingAt < 4000, 'shutdown cancels an in-flight source rather than waiting its timeout');
    await waitFor(async () => heldClosed);
    const disable = new Journal(path.join(dir, 'journal.db'));
    disable.append({kind: 'source.configured', source: hold});
    disable.close();
    server = await start(dir, true);
    const before = (await server.request('/api/state')).body.seq;
    assert.equal((await server.tool('source_list')).status, 200);
    assert.equal((await server.tool('source_poll', {id: mixed.id})).status, 403);
    assert.equal((await server.request('/api/state')).body.seq, before);
    assert.equal(hits.get('/catchup'), 1);
    assert.equal(hits.get('/hold'), 1);
  } finally {
    if (server) await stop(server.child);
    feed.closeAllConnections();
    await new Promise<void>(resolve => feed.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
