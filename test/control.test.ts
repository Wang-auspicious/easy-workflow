import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import h2Extension from "../integrations/pi/h2-factory.ts";

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
