import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { McpPeer, mcpText } from "../server/mcp-protocol.ts";
import { mcpRequest } from "../server/mcp.ts";
import { openStationMcp } from "../server/mcp-station.ts";
import { FactoryControl } from "../server/control.ts";
import { compile } from "../server/spec/compile.ts";
import { pack } from "../packs/vislexicon/pack.ts";
import { initialState } from "../shared/project.ts";
import type { Factory } from "../server/factory.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const init = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } };

test("MCP lifecycle, schema errors and cancellation are real protocol messages", async () => {
  const peer = new McpPeer({ name: "test", instructions: "bounded", tools: () => [{ name: "wait", description: "wait", inputSchema: Type.Object({ value: Type.Number() }, { additionalProperties: false }) }],
    call: async (_name, _args, signal) => { await new Promise<void>(resolve => { signal.addEventListener("abort", () => resolve(), { once: true }); if (signal.aborted) resolve(); }); return mcpText("cancelled"); } });
  const rpc = (id: number, method: string, params = {}) => peer.receive({ jsonrpc: "2.0", id, method, params }) as Promise<any>;
  assert.equal((await rpc(1, "tools/list")).error.code, -32002);
  assert.equal((await rpc(2, "initialize", init)).result.protocolVersion, "2025-06-18");
  assert.equal(await peer.receive({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal((await rpc(3, "tools/list")).result.tools[0].name, "wait");
  assert.equal((await rpc(4, "tools/call", { name: "wait", arguments: { value: "invalid" } })).error.code, -32602);
  assert.equal((await rpc(5, "tools/call", { name: "unknown" })).error.code, -32602);
  const pending = rpc(6, "tools/call", { name: "wait", arguments: { value: 1 } });
  await new Promise(resolve => setImmediate(resolve));
  await peer.receive({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 6 } });
  assert.equal((await pending).result.content[0].text, "cancelled");
  peer.close();
});

test("stdio MCP reaches the existing authenticated control registry without credential output", { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h2-mcp-test-")), secret = "mcp-fixture-private-credential";
  const compiled = compile([pack]);
  const control = new FactoryControl({ compiled, state: initialState(compiled), patches: [], journal: { seq: 0 },
    dispatcherModelStatus: () => ({adapter: 'pi', model: 'fixture-model'}),
    getAgentDefaults: () => ({station: {adapter: 'pi'}, dispatcher: {adapter: 'pi'}}),
  } as unknown as Factory);
  let authorized = 0;
  const service = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401); return res.end(JSON.stringify({ error: "unauthorized" })); }
    authorized++;
    const route = req.url!;
    try {
      if (req.method === "GET") return res.end(JSON.stringify(route.endsWith("bootstrap") ? control.bootstrap() : control.describe(decodeURIComponent(route.split("/").at(-1)!))));
      let body = ""; for await (const c of req) body += c;
      res.end(JSON.stringify(await control.execute(decodeURIComponent(route.split("/").at(-1)!), JSON.parse(body))));
    } catch (err: any) { res.writeHead(err.status ?? 500); res.end(JSON.stringify({ code: err.code, error: err.message })); }
  });
  await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve));
  const file = path.join(dir, "connection.json");
  fs.writeFileSync(file, JSON.stringify({ protocol: "h2-agent/1", url: `http://127.0.0.1:${(service.address() as any).port}`, token: secret }));
  const child = spawn(process.execPath, [path.join(root, "server/mcp.ts")], { cwd: root, env: { ...process.env, FACTORY_AGENT_CONNECTION: file }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let transcript = "", errors = "", next = 0;
  const pending = new Map<number, (value: any) => void>();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", line => { transcript += line; const value = JSON.parse(line); const done = pending.get(value.id); if (done) { pending.delete(value.id); done(value); } });
  child.stderr.on("data", c => errors += c);
  const rpc = (method: string, params = {}) => new Promise<any>(resolve => { const id = ++next; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  try {
    assert.equal((await rpc("initialize", init)).result.serverInfo.name, "easy-workflow-control");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    assert.deepEqual((await rpc("tools/list")).result.tools.map((t: any) => t.name), ["easy_workflow_help", "easy_workflow_call", "h2_help", "h2_call"]);
    const bootstrap = JSON.parse((await rpc("tools/call", { name: "easy_workflow_help", arguments: {} })).result.content[0].text);
    assert.equal(bootstrap.product, "Easy Workflow");
    assert.ok(bootstrap.instructions.length < 1500);
    assert.match(bootstrap.roleAuthoring.guide, /站长批准/);
    const schema = await rpc("tools/call", { name: "h2_help", arguments: { name: "read_spec" } });
    assert.equal(JSON.parse(schema.result.content[0].text).inputSchema.additionalProperties, false);
    const spec = await rpc("tools/call", { name: "easy_workflow_call", arguments: { name: "read_spec", arguments: {} } });
    assert.equal(JSON.parse(spec.result.content[0].text).result.factory.digest, compiled.digest);
    const bad = await rpc("tools/call", { name: "h2_call", arguments: { name: "feed_urls", arguments: { urls: "bad" } } });
    assert.equal(bad.result.isError, true);
    const before = authorized;
    const forbidden = await rpc("tools/call", { name: "h2_call", arguments: { name: "decide_patch", arguments: { id: "any", accept: true } } });
    assert.equal(forbidden.result.isError, true); assert.equal(authorized, before);
    assert.ok(authorized >= 4); assert.ok(!transcript.includes(secret)); assert.ok(!errors.includes(secret));
  } finally {
    child.stdin.end(); child.kill(); lines.close();
    service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve()));
    fs.rmSync(file, { force: true }); fs.rmdirSync(dir);
  }
});

test("station scope rejects global tools, wrong auth, invalid submit and expired sessions", async () => {
  const controller = new AbortController(); let submits = 0;
  const session = await openStationMcp([{ name: "submit", label: "Submit", description: "bounded", parameters: Type.Object({ value: Type.Number() }, { additionalProperties: false }), execute: async () => { submits++; return mcpText("received"); } },
    { name: "h2_call", label: "Never expose", description: "bad", parameters: Type.Object({}), execute: async () => mcpText("must not run") }], controller.signal);
  const file = session.config.env.H2_STATION_CONNECTION;
  const info = JSON.parse(fs.readFileSync(file, "utf8"));
  try {
    assert.deepEqual((await mcpRequest(file, "h2-station/1", "/tools")).tools.map((t: any) => t.name), ["submit"]);
    assert.equal((await fetch(`${info.url}/tools`)).status, 401);
    await assert.rejects(mcpRequest(file, "h2-station/1", "/call", { name: "h2_call", arguments: {} }), /not available/);
    await assert.rejects(mcpRequest(file, "h2-station/1", "/call", { name: "submit", arguments: { value: "bad" } }), /contract/);
    assert.equal(submits, 0);
    assert.equal((await mcpRequest(file, "h2-station/1", "/call", { name: "submit", arguments: { value: 1 } })).content[0].text, "received");
    assert.equal(submits, 1);
  } finally { await session.close(); }
  assert.equal(fs.existsSync(file), false);
  await assert.rejects(mcpRequest(file, "h2-station/1", "/tools"), /unavailable/);
});
