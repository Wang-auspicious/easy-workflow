import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { launcherEnvironment, redactValue } from "../server/mcp-security.ts";
import { McpPeer, mcpText } from "../server/mcp-protocol.ts";
import { mcpRequest } from "../server/mcp.ts";
import { ClosedStationAgent, openStationMcp } from "../server/mcp-station.ts";

test("launcher filtering handles Windows environment casing and nested credential redaction", () => {
  const filtered = launcherEnvironment({ PATH: "kept", Factory_Token: "global-credential", factory_agent_connection: "private-file", Easy_Workflow_Agent_Connection: "private-current-file", EASY_WORKFLOW_STATION_CONNECTION: "stale-current-scope", PI_CODING_AGENT_DIR: "private-profile", h2_station_connection: "stale-scope", NORMAL: "kept" });
  assert.deepEqual(filtered, { PATH: "kept", NORMAL: "kept" });
  const secret = 'test-credential-"quoted"';
  const safe = redactValue({ nested: [{ text: `Bearer ${secret}` }], [secret]: JSON.stringify(secret) }, [secret]);
  assert.ok(!JSON.stringify(safe).includes("test-credential"));
});

for (const rejectedBeforeStart of [false, true]) {
  const name = rejectedBeforeStart
    ? 'HTTP failure before tool startup propagates and closes the station scope'
    : 'closing a station scope aborts active calls and waits for credential cleanup';
  test(name, {timeout: 10000}, async context => {
    let started!: () => void;
    let entered = false;
    let cancelled = false;
    const began = new Promise<void>(resolve => { started = resolve; });
    const session = await openStationMcp([{
      name: 'env_call', label: 'Wait', description: 'test', parameters: Type.Object({}),
      execute: async (_id, _args, signal) => {
        entered = true;
        started();
        await new Promise<void>(resolve => signal!.addEventListener('abort', () => {
          cancelled = true;
          resolve();
        }, {once: true}));
        return mcpText('stopped');
      },
    }], context.signal);
    const file = session.config.env.H2_STATION_CONNECTION;
    const request = mcpRequest(file, 'h2-station/1', rejectedBeforeStart ? '/missing-fixture-route' : '/call',
      {name: 'env_call', arguments: {}}, context.signal);
    try {
      const startup = Promise.race([began, request.then(() => {
        throw new Error('Station request ended before the tool started');
      })]);
      if (rejectedBeforeStart) {
        await assert.rejects(startup, /404: Unknown station endpoint/);
        assert.equal(entered, false);
      } else {
        await startup;
        const first = session.close();
        assert.equal(first, session.close());
        await first;
        assert.equal(cancelled, true);
      }
    } finally {
      await session.close();
      // Connection termination is expected only after the startup outcome was checked.
      await request.catch(() => undefined);
    }
    assert.equal(fs.existsSync(file), false);
  });
}

test("scope redacts accidental tool credential output and rejects credential-bearing arguments", async () => {
  const previous = process.env.FACTORY_TOKEN; process.env.FACTORY_TOKEN = "global-test-secret";
  let scoped = "", executions = 0;
  const session = await openStationMcp([{ name: "submit", label: "Submit", description: "test", parameters: Type.Object({ text: Type.String() }), execute: async () => { executions++; return mcpText({ text: `${scoped} / global-test-secret` }); } }], new AbortController().signal);
  const file = session.config.env.H2_STATION_CONNECTION; scoped = JSON.parse(fs.readFileSync(file, "utf8")).token;
  try {
    const reply = await mcpRequest(file, "h2-station/1", "/call", { name: "submit", arguments: { text: "ordinary result" } });
    assert.ok(!JSON.stringify(reply).includes(scoped)); assert.ok(!JSON.stringify(reply).includes("global-test-secret"));
    assert.match(reply.content[0].text, /redacted/);
    await assert.rejects(mcpRequest(file, "h2-station/1", "/call", { name: "submit", arguments: { text: scoped } }), /Credentials/);
    assert.equal(executions, 1);
  } finally { await session.close(); if (previous === undefined) delete process.env.FACTORY_TOKEN; else process.env.FACTORY_TOKEN = previous; }
});

test("station connection environment cannot silently fall back to the global stdio mode", { timeout: 15000 }, async () => {
  const session = await openStationMcp([{ name: "submit", label: "Submit", description: "test", parameters: Type.Object({}), execute: async () => mcpText("ok") }], new AbortController().signal);
  // Deliberately omit --station. The connection itself must keep the process scoped.
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server/mcp.ts", import.meta.url))], { env: { ...process.env, ...session.config.env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (value: any) => void>(); let id = 0, transcript = "";
  const lines = readline.createInterface({ input: child.stdout }); child.stderr.resume();
  lines.on("line", line => { transcript += line; const value = JSON.parse(line); pending.get(value.id)?.(value); pending.delete(value.id); });
  const rpc = (method: string, params = {}) => new Promise<any>(resolve => { const current = ++id; pending.set(current, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: current, method, params }) + "\n"); });
  try {
    const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(initialized.result.serverInfo.name, "easy-workflow-station");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    assert.deepEqual((await rpc("tools/list")).result.tools.map((x: any) => x.name), ["submit"]);
    assert.ok((await rpc("tools/call", { name: "h2_call", arguments: {} })).error);
    const secret = JSON.parse(fs.readFileSync(session.config.env.H2_STATION_CONNECTION, "utf8")).token;
    assert.ok(!transcript.includes(secret));
  } finally { child.stdin.end(); child.kill(); lines.close(); await session.close(); }
});

test("MCP cancellation during tool discovery never executes the pending mutation", async () => {
  let called = false;
  const peer = new McpPeer({ name: "test", instructions: "", tools: signal => new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })), call: async () => { called = true; return mcpText("bad"); } });
  await peer.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  await peer.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
  const pending = peer.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mutation", arguments: {} } });
  await peer.receive({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
  await pending; assert.equal(called, false); peer.close();
});

test("the HTTP bridge redacts authentication even from successful upstream JSON", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h2-mcp-redaction-")), secret = "fixture-upstream-auth";
  const service = http.createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ note: `accidental ${secret}` })); });
  await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve));
  const file = path.join(dir, "connection.json"); fs.writeFileSync(file, JSON.stringify({ protocol: "h2-agent/1", token: secret, url: `http://127.0.0.1:${(service.address() as any).port}` }));
  try { assert.deepEqual(await mcpRequest(file, "h2-agent/1", "/api/anything"), { note: "accidental [redacted]" }); }
  finally { service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())); fs.rmSync(file); fs.rmdirSync(dir); }
});

test("cancelling a closed launcher terminates its own child tree and revokes its MCP scope", { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h2-launcher-cancel-"));
  const agent = new ClosedStationAgent({ command: [process.execPath, fileURLToPath(new URL("./fixtures/closed-agent-cancel.mjs", import.meta.url))], model: "fixture-cancel", cwd: dir }, "envelope", [], () => { throw new Error("cancelled launcher cannot report success"); });
  const pending = agent.prompt("input");
  // Attach immediately, so a failure before the marker cannot become an unhandled rejection.
  const rejected = assert.rejects(pending, /cancelled/);
  const file = path.join(dir, "cancel-observed.json");
  try {
    const deadline = Date.now() + 6000;
    while (!fs.existsSync(file) && Date.now() < deadline) await delay(20);
    assert.ok(fs.existsSync(file), "launcher must have started its child");
    const seen = JSON.parse(fs.readFileSync(file, "utf8"));
    agent.abort(); await rejected;
    assert.equal(fs.existsSync(seen.file), false);
    const stopped = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
    const exitDeadline = Date.now() + 2000;
    while ((!stopped(seen.pid) || !stopped(seen.childPid)) && Date.now() < exitDeadline) await delay(20);
    assert.ok(stopped(seen.pid)); assert.ok(stopped(seen.childPid));
    await assert.rejects(fetch(`${seen.url}/tools`, { headers: { authorization: `Bearer ${seen.token}` }, signal: AbortSignal.timeout(1000) }));
    assert.ok(!String(agent.state.errorMessage).includes(seen.token));
  } finally {
    agent.abort(); await rejected;
    assert.ok(path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()), "h2-launcher-cancel-"))); fs.rmSync(dir, { recursive: true, force: true });
  }
});
