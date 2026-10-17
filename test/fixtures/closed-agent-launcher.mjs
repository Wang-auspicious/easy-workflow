// A deterministic vendor-launcher fixture; it drives the real stdio MCP process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
assert.equal(request.protocol, "h2-closed-agent/1");
assert.equal(request.firstMessage.role, "user");
assert.deepEqual(request.firstMessage, request.messages[0]);
assert.match(request.firstMessage.content[0].text, /fixture envelope/);
assert.match(request.firstMessage.content[0].text, /fixture station contract/);
assert.match(request.firstMessage.content[0].text, /fixture input/);
assert.equal(process.env.FACTORY_TOKEN, undefined);
assert.equal(process.env.FACTORY_AGENT_CONNECTION, undefined);
const config = request.mcpServers.h2_station;
assert.ok(config.args.includes("--station"));
assert.equal(config.env.EASY_WORKFLOW_STATION_CONNECTION, config.env.H2_STATION_CONNECTION);
assert.deepEqual(Object.keys(config.env), ["EASY_WORKFLOW_STATION_CONNECTION", "H2_STATION_CONNECTION"]);
const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map(); let next = 0;
const lines = readline.createInterface({ input: child.stdout });
lines.on("line", line => { const value = JSON.parse(line); const resolve = pending.get(value.id); if (resolve) { pending.delete(value.id); resolve(value); } });
child.stderr.resume();
const rpc = (method, params) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const call = (name, args) => rpc("tools/call", { name, arguments: args });
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
assert.deepEqual((await rpc("tools/list", {})).result.tools.map(x => x.name), ["submit", "handoff", "env_help", "env_call"]);
assert.ok((await call("h2_call", { name: "run_control", arguments: { action: "end" } })).error);
assert.ok((await call("easy_workflow_call", { name: "run_control", arguments: { action: "end" } })).error);
const disallowed = await call("env_call", { name: "feed_urls", arguments: { urls: ["https://example.test"] } });
assert.equal(JSON.parse(disallowed.result.content[0].text).ok, false);
const help = await call("env_help", {});
assert.equal(JSON.parse(help.result.content[0].text).ok, true);
if (request.model === 'fixture-schema-probe') {
  const invalid = await call('submit', {score: 'not a number'});
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /schema|score|integer|number/i);
}
if (request.model === 'fixture-handoff') {
  const result = await call('handoff', {done: ['read fixture'], evidence: ['fixture-only observation'],
    remaining: ['verify score'], suggestion: 'Continue score verification.'});
  assert.equal(result.result.content[0].text, 'handoff saved');
  assert.equal((await call('submit', {score: 2})).result.isError, true);
} else {
  const score = request.model === 'fixture-two-repairs' ? Math.min(2, Math.floor((request.messages.length - 1) / 2)) : request.messages.length > 1 ? 1 : 0;
  const result = await call('submit', {score});
  if (result.result.isError) {
    assert.match(result.result.content[0].text, /提交未通过校验/);
  } else {
    assert.equal(result.result.content[0].text, 'received');
    assert.equal((await call('submit', {score: 9})).result.isError, true);
  }
}
child.stdin.end();
await new Promise(resolve => child.once("exit", resolve));
const reply = { model: "fixture-actual-model", usage: { input: 100, output: 20, cost: .001, cacheRead: 30, cacheWrite: 5 }, time: { firstTokenMs: 8, outputMs: 12, modelCalls: 1 } };
if (request.model === "fixture-no-cache") { delete reply.usage.cacheRead; delete reply.usage.cacheWrite; }
if (request.model === "fixture-no-usage") delete reply.usage;
process.stdout.write(JSON.stringify(reply));
