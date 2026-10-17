import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Dispatcher, type DispatcherOptions } from "../server/dispatcher.ts";
import { Journal } from "../server/journal.ts";
import { closeModelTransport, models } from "../server/pi.ts";
import type { Factory } from "../server/factory.ts";
import { FactoryControl } from "../server/control.ts";
import type { ConversationEntry } from "../shared/conversation.ts";
import {apply, initialState} from '../shared/project.ts';
import type {StationAgentBinding} from '../shared/types.ts';
import {setTimeout as delay} from 'node:timers/promises';

test("dispatcher recovers an actual Pi provider timeout after a completed write without repeating the write", { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-dispatcher-"));
  const previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "FACTORY_MODEL", "FACTORY_PROVIDER"].map(k => [k, process.env[k]]));
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.FACTORY_MODEL; delete process.env.FACTORY_PROVIDER;
  const bodies: any[] = [];
  let writes = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (bodies.length === 2) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "The operation was aborted due to timeout (local-fixture-secret)" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = bodies.length === 1
      ? { role: "assistant", tool_calls: [{ index: 0, id: "call-feed", type: "function", function: { name: "easy_workflow_call", arguments: JSON.stringify({ name: "feed_urls", arguments: { urls: ["https://fixture.invalid"] } }) } }] }
      : { role: "assistant", content: "已投料 1 件，并从原来的工具回执恢复了回答。" };
    for (const part of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: bodies.length === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
    ]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", ...part })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture-model" }));
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "local-fixture-secret" } }));
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, models: [{ id: "fixture-model", input: ["text"] }] } } }));
  const journal = new Journal(path.join(dir, "journal.db"));
  const conversation: ConversationEntry[] = [];
  const events: any[] = [];
  journal.subscribe(e => {
    if (e.kind === "chat.user") conversation.push({ id: e.id, turn: e.id, message: { role: "user", content: e.text, timestamp: e.at } });
    if (e.kind === "chat.message") conversation.push({ id: e.id, turn: e.turn, message: e.message });
  });
  const f = { project: { dir }, state: { conversation, evidence: {}, tokens: {}, run: { id: "test-run" } }, journal, docs: { envelope: () => ({ text: "dispatcher fixture" }) }, emit: (e: unknown) => events.push(e) } as unknown as Factory;
  const control = {
    bootstrap: () => ({ instructions: "Use the discovered tool." }),
    mutates: () => true,
    execute: async () => ({ result: { running: 0 } }),
    agentTools: () => [{ name: "easy_workflow_call", label: "Call", description: "Call", parameters: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name", "arguments"] }, execute: async () => { writes++; return { content: [{ type: "text", text: "已投料 1 件" }], details: { summary: "已投料 1 件", result: { task: "t-already-created", seq: journal.seq } } }; } }],
  } as unknown as FactoryControl;
  try {
    const dispatcher = new Dispatcher(f, control);
    await dispatcher.chat("投一个网站，并告诉我结果", []);
    const answer = [...journal.read()].filter(e => e.kind === "chat.assistant").at(-1);
    assert.ok(answer?.text.includes("从原来的工具回执恢复"), `expected recovery, got ${answer?.text}`);
    assert.equal(writes, 1, "a model retry must not repeat a completed write");
    assert.equal(bodies.length, 3);
    assert.ok(bodies[2].messages.some((m: any) => m.role === "tool" && m.tool_call_id === "call-feed"), "resume includes the original write receipt");
    assert.ok(events.some(e => e.kind === "chat.status" && e.status === "recovering"));
    assert.ok(!JSON.stringify(events).includes("local-fixture-secret"), "provider-echoed credentials must not enter live messages or recovery state");
    assert.equal(dispatcher.busy, false);
  } finally {
    await closeModelTransport(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); journal.close();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    assert.ok(path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()), "easy-workflow-dispatcher-")));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const launcherPrelude = `import assert from 'node:assert/strict';
import fs from 'node:fs';
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
const ledger = process.argv[2];
const count = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split('\\n').length : 0;
fs.appendFileSync(ledger, JSON.stringify({cwd: process.cwd(), model: request.model, pid: process.pid,
  scopeFile: request.mcpServers.h2_station.env.EASY_WORKFLOW_STATION_CONNECTION}) + '\\n');
assert.ok(request.firstMessage.content[0].text.includes('dispatcher native fixture'));
assert.ok(Buffer.byteLength(raw) < 256 * 1024);
const connection = JSON.parse(fs.readFileSync(request.mcpServers.h2_station.env.EASY_WORKFLOW_STATION_CONNECTION, 'utf8'));
const call = async (name, parameters) => {
  const response = await fetch(connection.url + '/call', {method: 'POST', headers: {
    authorization: 'Bearer ' + connection.token, 'content-type': 'application/json'},
    body: JSON.stringify({name, arguments: parameters})});
  assert.equal(response.status, 200);
  return response.json();
};
const tools = await fetch(connection.url + '/tools', {headers: {authorization: 'Bearer ' + connection.token}}).then(r => r.json());
assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['env_call', 'env_help', 'submit']);
`;

function nativeDispatcherFixture(source: string, adapter: 'launcher' | 'claude-code' = 'launcher') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-native-dispatcher-'));
  const script = path.join(dir, 'client.mjs');
  const ledger = path.join(dir, 'launches.jsonl');
  fs.writeFileSync(script, source);
  let binding: StationAgentBinding = {adapter, command: [process.execPath, script, ledger],
    model: 'requested-native', requestTimeoutMs: 5000};
  const journal = new Journal(path.join(dir, 'journal.db'));
  const state = initialState();
  journal.subscribeProjection(event => apply(state, event));
  const events: Record<string, unknown>[] = [];
  const writes: string[] = [];
  const factory = {project: {dir}, state, journal,
    getAgentDefaults: () => ({station: {adapter: 'pi', provider: 'unused', model: 'unused'}, dispatcher: structuredClone(binding)}),
    docs: {envelope: () => ({text: 'dispatcher native fixture'})},
    emit: (event: Record<string, unknown>) => events.push(event),
  } as unknown as Factory;
  const control = {
    bootstrap: () => ({instructions: 'Use the guarded tools and submit the final reply.'}),
    describe: () => ({name: 'fixture_write'}),
    mutates: (name: string) => !['status', 'read_report'].includes(name),
    execute: async (name: string, input: {value?: string}, actor: string) => {
      assert.equal(actor, 'dispatcher');
      if (name === 'status') return {ok: true, result: {writes: writes.length}, summary: 'Local state'};
      if (name === 'read_report') return {ok: true, tool: name,
        result: {activity: {intervals: [{text: 'private long report '.repeat(40000)}]}}, summary: 'Report', seq: journal.seq};
      // Owner-level decisions reach the service; the real patch gate still rejects them.
      if (name === 'decide_patch') throw new Error('补丁不存在或已处理');
      assert.equal(name, 'fixture_write');
      writes.push(input.value!);
      if (input.value === 'uncertain') throw new Error('connection interrupted after local write');
      return {ok: true, tool: name, result: {saved: input.value}, summary: `Saved ${input.value}`, seq: journal.seq};
    },
    agentTools: FactoryControl.prototype.agentTools,
  } as unknown as FactoryControl;
  return {
    dir, journal, state, events, writes,
    select: (next: StationAgentBinding) => {binding = next;},
    binding: () => structuredClone(binding),
    launches: () => fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as {cwd: string; model: string; pid: number; scopeFile: string; session?: string; resumed?: boolean}) : [],
    dispatcher: (options: DispatcherOptions = {}) => new Dispatcher(factory, control, {maxAttempts: 2, retryDelaysMs: [1],
      modelFactory: () => {throw new Error('A native dispatcher must never read or invoke Pi');}, ...options}),
    close: () => {
      journal.close();
      assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
      fs.rmSync(dir, {recursive: true, force: true});
    },
  };
}

test('native dispatcher preserves independent writes, guarded authority and bounded receipts across provider recovery', {timeout: 15000}, async () => {
  const fixture = nativeDispatcherFixture(launcherPrelude + `
await call('env_help', {name: 'fixture_write'});
const first = await call('env_call', {name: 'fixture_write', arguments: {value: 'first'}});
const second = await call('env_call', {name: 'fixture_write', arguments: {value: 'second'}});
assert.match(JSON.stringify(first), /first/);
assert.match(JSON.stringify(second), /second/);
const uncertain = await call('env_call', {name: 'fixture_write', arguments: {value: 'uncertain'}});
if (count) assert.match(JSON.stringify(uncertain), /核对/);
const approval = await call('env_call', {name: 'decide_patch', arguments: {id: 'never-approved', accept: true}});
assert.match(JSON.stringify(approval), /补丁不存在|核对/);
const report = await call('env_call', {name: 'read_report', arguments: {}});
assert.ok(Buffer.byteLength(JSON.stringify(report)) < 32 * 1024);
if (count) assert.match(raw, /first|second/);
await call('submit', {text: count ? '已从回执恢复，没有重复写入。' : '不得交付的失败过程回复'});
process.stdout.write(JSON.stringify({model: 'native-actual', modelCalls: 1,
  ...(count ? {} : {error: {type: 'transport'}})}));
`);
  try {
    const dispatcher = fixture.dispatcher();
    await dispatcher.chat('保存两项并核对结果', []);
    assert.equal(dispatcher.status.status, 'completed', dispatcher.status.error ?? 'native reply missing');
    assert.deepEqual(fixture.writes, ['first', 'second', 'uncertain']);
    assert.equal(fixture.launches().length, 2);
    assert.equal(fixture.launches()[0].cwd, fixture.launches()[1].cwd);
    const events = [...fixture.journal.read()];
    const final = events.findLast(event => event.kind === 'chat.assistant');
    assert.ok(final?.kind === 'chat.assistant');
    assert.equal(final.text, '已从回执恢复，没有重复写入。');
    assert.ok(!JSON.stringify(fixture.state.conversation).includes('不得交付的失败过程回复'));
    const checkpoint = events.findLast(event => event.kind === 'chat.checkpoint');
    assert.ok(checkpoint?.kind === 'chat.checkpoint');
    assert.equal(checkpoint.checkpoint.operations.length, 4);
    assert.equal(new Set(checkpoint.checkpoint.operations.map(operation => operation.callId)).size, 4,
      'MCP transport ids cannot collapse distinct dispatcher writes');
    const native = fixture.state.conversation.at(-1)!.message;
    assert.ok(native.role === 'assistant' && 'native' in native);
    assert.equal(native.model, 'native-actual');
    assert.equal(native.native.usageReported, false);
    assert.equal(native.native.costReported, false);
    assert.equal(native.usage, undefined, 'unreported usage is never fabricated as zero');
    assert.ok(fixture.state.conversation.some(entry => entry.message.role === 'toolResult' &&
      JSON.stringify(entry.message).length > 500000), 'the journal retains the complete unprojected tool receipt');
  } finally {fixture.close();}
});

test('native dispatcher cancellation and restart preserve the captured client, queued input and mutation receipts', {timeout: 15000}, async () => {
  const fixture = nativeDispatcherFixture(launcherPrelude + `
if (count < 2) await call('env_call', {name: 'fixture_write', arguments: {value: 'before-cancel'}});
if (!count) {
  fs.writeFileSync(ledger + '.ready', 'ready');
  setInterval(() => {}, 1000);
} else {
  if (count === 1) assert.ok(!raw.includes('follow-up request'));
  if (count === 2) assert.match(raw, /follow-up request/);
  await call('submit', {text: '已完成恢复。'});
  process.stdout.write(JSON.stringify({model: 'native-actual', usage: {input: 20, output: 5, cost: 0.01}}));
}
`);
  const dispatcher = fixture.dispatcher();
  let pending: Promise<unknown> | undefined;
  try {
    pending = dispatcher.chat('original request', []);
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(fixture.dir, 'launches.jsonl.ready')) && Date.now() < deadline) await delay(10);
    assert.ok(fs.existsSync(path.join(fixture.dir, 'launches.jsonl.ready')));
    dispatcher.steer('follow-up request', []);
    fixture.select({...fixture.binding(), model: 'requested-next'} as StationAgentBinding);
    dispatcher.abort();
    await pending;
    assert.equal(dispatcher.status.status, 'aborted');
    assert.equal(fs.existsSync(fixture.launches()[0].scopeFile), false, 'cancel waits for scoped MCP cleanup');
    assert.throws(() => process.kill(fixture.launches()[0].pid, 0), 'cancel waits for its own client to exit');
    assert.deepEqual(fixture.writes, ['before-cancel']);
    const restored = fixture.dispatcher();
    await restored.recover();
    assert.equal(fixture.launches().length, 1, 'a user-cancelled conversation never restarts itself');
    await restored.resume();
    assert.equal(restored.status.status, 'completed', restored.status.error ?? 'native resume missing');
    assert.deepEqual(fixture.writes, ['before-cancel'], 'resume keeps completed writes even when new input is queued');
    assert.equal(fixture.launches()[1].model, 'requested-native', 'a changed native model waits for a new conversation');
    const recovered = fixture.state.conversation.at(-1)!.message;
    assert.ok(recovered.role === 'assistant' && 'native' in recovered);
    assert.deepEqual(recovered.native.usage, {input: 20, output: 5, cost: 0.01});
    await restored.chat('new request', []);
    assert.equal(restored.status.status, 'completed');
    assert.equal(fixture.launches().at(-1)!.model, 'requested-next');
    assert.notEqual(fixture.launches()[0].cwd, fixture.launches().at(-1)!.cwd, 'new conversations have independent client sessions');
  } finally {
    dispatcher.abort();
    await pending;
    fixture.close();
  }
});

test('native Claude dispatcher reuses its isolated protocol session and records measured failed-process usage', {timeout: 15000}, async () => {
  const fixture = nativeDispatcherFixture(`import assert from 'node:assert/strict';
import fs from 'node:fs';
const ledger = process.argv[2], args = process.argv.slice(3);
const value = name => args[args.indexOf(name) + 1];
assert.equal(value('--tools'), '');
assert.ok(args.includes('--strict-mcp-config'));
assert.ok(!args.includes('--dangerously-skip-permissions'));
const resumed = args.includes('--resume'), session = value(resumed ? '--resume' : '--session-id');
const records = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split('\\n').map(line => JSON.parse(line)) : [];
if (records.length) {
  assert.equal(resumed, true);
  assert.equal(session, records[0].session);
  assert.equal(process.cwd(), records[0].cwd);
}
fs.appendFileSync(ledger, JSON.stringify({session, resumed, cwd: process.cwd(), model: value('--model')}) + '\\n');
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
assert.ok(JSON.parse(raw).message.content[0].text.includes('dispatcher native fixture'));
const mcp = JSON.parse(value('--mcp-config')).mcpServers.h2_station;
const connection = JSON.parse(fs.readFileSync(mcp.env.EASY_WORKFLOW_STATION_CONNECTION, 'utf8'));
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
emit({type: 'system', subtype: 'init', session_id: session, model: 'reported-claude',
  tools: ['mcp__h2_station__env_help', 'mcp__h2_station__env_call', 'mcp__h2_station__submit'],
  mcp_servers: [{name: 'h2_station', status: 'connected'}]});
const call = async (name, parameters) => fetch(connection.url + '/call', {method: 'POST',
  headers: {authorization: 'Bearer ' + connection.token, 'content-type': 'application/json'},
  body: JSON.stringify({name, arguments: parameters})}).then(response => response.json());
await call('env_call', {name: 'fixture_write', arguments: {value: 'native-session-write'}});
if (resumed) await call('submit', {text: '原会话已恢复。'});
emit({type: 'assistant', message: {id: 'request-' + records.length, model: 'reported-claude', content: [{type: 'text', text: 'Protocol fixture'}]}});
emit({type: 'result', subtype: resumed ? 'success' : 'error_during_execution', is_error: !resumed,
  session_id: session, errors: resumed ? [] : ['ECONNRESET'], total_cost_usd: resumed ? 0.02 : 0.01,
  usage: {input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0}});
process.exitCode = resumed ? 0 : 1;
`, 'claude-code');
  try {
    const dispatcher = fixture.dispatcher({maxAttempts: 1});
    await dispatcher.chat('恢复原生协议会话', []);
    assert.equal(dispatcher.status.status, 'failed');
    const restarted = fixture.dispatcher({maxAttempts: 1});
    await restarted.resume();
    assert.equal(restarted.status.status, 'completed', restarted.status.error ?? 'native protocol failed');
    assert.deepEqual(fixture.writes, ['native-session-write']);
    assert.deepEqual(fixture.launches().map(record => record.resumed), [false, true]);
    assert.equal(new Set(fixture.launches().map(record => record.session)).size, 1);
    const receipts = fixture.state.conversation.flatMap(entry => {
      const message = entry.message;
      return message.role === 'assistant' && 'native' in message && message.native.usage
        ? [message] : [];
    });
    assert.deepEqual(receipts.map(message => message.stopReason), ['error', 'stop']);
    assert.deepEqual(receipts.map(message => message.native.usage?.cost), [0.01, 0.02]);
    assert.ok(receipts.every(message => message.model === 'reported-claude' && message.native.costReported));
  } finally {fixture.close();}
});

test('dispatcher harness changes wait for a new conversation and native history remains valid for the real Pi serializer', {timeout: 15000}, async () => {
  const fixture = nativeDispatcherFixture(launcherPrelude + `
await call('env_call', {name: 'fixture_write', arguments: {value: 'native-write'}});
await call('submit', {text: '来自原生主调度的历史回复。'});
process.stdout.write(JSON.stringify({model: 'native-actual'}));
`);
  const native = fixture.binding();
  const previous = process.env.PI_CODING_AGENT_DIR;
  const requests: {model: string; messages: {role: string; content?: unknown}[]}[] = [];
  let arrived!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => {arrived = resolve;});
  const held = new Promise<void>(resolve => {release = resolve;});
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const count = requests.length;
    if (count === 1) {arrived(); await held;}
    response.writeHead(200, {'content-type': 'text/event-stream'});
    const delta = count === 1 ? {role: 'assistant', tool_calls: [{index: 0, id: 'pi-write', type: 'function',
      function: {name: 'easy_workflow_call', arguments: JSON.stringify({name: 'fixture_write', arguments: {value: 'pi-write'}})}}]}
      : {role: 'assistant', content: 'Pi 已保留历史并回答。'};
    for (const part of [
      {choices: [{index: 0, delta, finish_reason: null}]},
      {choices: [{index: 0, delta: {}, finish_reason: count === 1 ? 'tool_calls' : 'stop'}],
        usage: {prompt_tokens: 20, completion_tokens: 5, total_tokens: 25}},
    ]) response.write(`data: ${JSON.stringify({id: 'harness-transition', model: body.model, ...part})}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.PI_CODING_AGENT_DIR = fixture.dir;
  fs.writeFileSync(path.join(fixture.dir, 'auth.json'), JSON.stringify({fixture: {type: 'api_key', key: 'local-fixture-only'}}));
  fs.writeFileSync(path.join(fixture.dir, 'models.json'), JSON.stringify({providers: {
    fixture: {api: 'openai-completions', baseUrl: `http://127.0.0.1:${(server.address() as {port: number}).port}/v1`,
      models: [{id: 'pi-fixture', input: ['text']}]},
  }}));
  fixture.select({adapter: 'pi', provider: 'fixture', model: 'pi-fixture'});
  const dispatcher = fixture.dispatcher({modelFactory: models});
  let pending: Promise<unknown> | undefined;
  try {
    pending = dispatcher.chat('先完成 Pi 原请求', []);
    await started;
    fixture.select(native);
    release();
    await pending;
    assert.equal(dispatcher.status.status, 'completed');
    assert.equal(requests.length, 2);
    assert.equal(fixture.launches().length, 0, 'selecting native never interrupts an active Pi tool loop');
    assert.deepEqual(fixture.writes, ['pi-write']);
    await dispatcher.chat('新对话使用原生底座', []);
    assert.equal(dispatcher.status.status, 'completed', dispatcher.status.error ?? 'native transition failed');
    assert.equal(fixture.launches().length, 1);
    fixture.select({adapter: 'pi', provider: 'fixture', model: 'pi-fixture'});
    await dispatcher.chat('再次使用 Pi 并保留历史', []);
    assert.equal(dispatcher.status.status, 'completed', dispatcher.status.error ?? 'Pi serialization failed');
    assert.equal(requests.length, 3);
    assert.ok(JSON.stringify(requests.at(-1)).includes('来自原生主调度的历史回复'));
    assert.ok(JSON.stringify(requests.at(-1)).includes('native-write'), 'native tool receipts remain available as quoted history');
    assert.equal(requests.at(-1)!.messages.filter(message => message.role === 'tool').length, 1,
      'native receipts do not leave orphaned Pi tool results');
    assert.deepEqual(fixture.writes, ['pi-write', 'native-write']);
    assert.ok(fixture.state.conversation.some(entry => entry.message.role === 'assistant' &&
      'native' in entry.message && entry.message.usage === undefined), 'input projection never rewrites unknown historical usage');
    assert.equal(requests.at(-1)!.model, 'pi-fixture');
  } finally {
    release();
    dispatcher.abort();
    await pending;
    await closeModelTransport();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fixture.close();
  }
});
