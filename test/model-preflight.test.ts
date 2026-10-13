import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {checkAgentEndpoints, checkModelEndpoint, preflight} from '../server/preflight.ts';
import { closeModelTransport } from '../server/pi.ts';
import { closeNetwork } from '../server/network.ts';
import {Broker} from '../server/broker.ts';
import type {StationAgentBinding} from '../shared/types.ts';

test('model preflight tests authenticated inference, not a healthy public base URL', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-model-check-'));
  const keys = ['PI_CODING_AGENT_DIR', 'FACTORY_PROVIDER', 'FACTORY_MODEL'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let mode = 'unauthorized', getCalls = 0, inferenceCalls = 0, activeKey = 'preflight-fixture-only';
  const requests: any[] = [];
  const requestPaths: string[] = [];
  const selectedKey = 'preflight-selected-only';
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') { getCalls++; res.writeHead(200); res.end('Healthy gateway'); return; }
    inferenceCalls++;
    requestPaths.push(req.url!);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    assert.equal(req.headers.authorization, `Bearer ${req.url?.startsWith('/selected/') ? selectedKey : activeKey}`);
    if (mode === 'unauthorized') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `Invalid API key: ${activeKey}`, type: 'authentication_error' } })); return; }
    if (mode === 'hang') return;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'empty') { res.end('data: '+JSON.stringify({id:'probe',model:'fixture',choices:[{index:0,delta:{},finish_reason:'length'}]})+'\n\ndata: [DONE]\n\n'); return; }
    for (const delta of [{ choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }]) res.write(`data: ${JSON.stringify({ id: 'probe', model: 'fixture', ...delta })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  process.env.PI_CODING_AGENT_DIR = dir; process.env.FACTORY_PROVIDER = 'fixture'; process.env.FACTORY_MODEL = 'fixture';
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'preflight-fixture-only' } }));
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: 'fixture', input: ['text'] }] } } }));
  try {
    await t.test('rejects unusable credentials and does not expose the provider-echoed key', async () => {
      const result = await checkModelEndpoint(5000);
      assert.equal(result.ok, false);
      assert.ok(!JSON.stringify(result).includes('preflight-fixture-only'));
      assert.equal(inferenceCalls, 1); assert.equal(getCalls, 0);
    });
    await t.test('accepts an actual inference with a small bounded output budget', async () => {
      mode = 'success';
      const result = await checkModelEndpoint(5000);
      assert.equal(result.ok, true, result.detail);
      const outputLimit = requests.at(-1).max_tokens ?? requests.at(-1).max_completion_tokens;
      assert.ok(outputLimit > 0 && outputLimit <= 1024);
      assert.equal(inferenceCalls, 2); assert.equal(getCalls, 0);
    });
    await t.test('an empty truncated response never means the provider is healthy', async () => {
      mode = 'empty';
      const result = await checkModelEndpoint(5000);
      assert.equal(result.ok, false); assert.match(result.detail, /未完成体检回答/);
    });
    await t.test('a stalled model is aborted within the check deadline', async () => {
      mode = 'hang'; const start = Date.now();
      const result = await checkModelEndpoint(500);
      assert.equal(result.ok, false);
      assert.ok(Date.now() - start < 4000);
      assert.equal(inferenceCalls, 4);
    });
    await t.test('provider errors cannot leak a credential through JSON escaping', async () => {
      mode = 'unauthorized'; activeKey = 'fixture"escaped\\key';
      fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: activeKey } }));
      const result = await checkModelEndpoint(5000);
      assert.equal(result.ok, false);
      assert.ok(!result.detail.includes(activeKey));
      assert.ok(!result.detail.includes(JSON.stringify(activeKey).slice(1, -1)));
      assert.match(result.detail, /\[redacted\]/);
    });
    await t.test('each explicit Pi selection is probed once without falling back to the default model', async () => {
      mode = 'success';
      fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({selected: {type: 'api_key', key: selectedKey}}));
      fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({providers: {
        selected: {api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/selected/v1`,
          models: [{id: 'selected-a', input: ['text']}, {id: 'selected-b', input: ['text']}]},
      }}));
      const before = inferenceCalls;
      const result = await checkAgentEndpoints(dir, [
        {adapter: 'pi', provider: 'selected', model: 'selected-a'},
        {model: 'selected-a', provider: 'selected', adapter: 'pi'},
        {adapter: 'pi', provider: 'selected', model: 'selected-b'},
      ], {timeoutMs: 5000});
      assert.equal(result.ok, true, result.detail);
      assert.equal(inferenceCalls - before, 2);
      assert.deepEqual(requests.slice(-2).map(request => request.model), ['selected-a', 'selected-b']);
      assert.ok(requestPaths.slice(-2).every(url => url.startsWith('/selected/v1/')));
      assert.equal(process.env.FACTORY_PROVIDER, 'fixture');
      assert.equal(process.env.FACTORY_MODEL, 'fixture');
      const mixed = await checkAgentEndpoints(dir, [
        {adapter: 'pi', provider: 'selected', model: 'selected-a'},
        {adapter: 'pi', provider: 'fixture', model: 'fixture'},
      ], {timeoutMs: 5000});
      assert.equal(mixed.ok, false, 'one successful model cannot clear another selected model failure');
      assert.match(mixed.detail, /selected-a/);
      assert.match(mixed.detail, /fixture/);
      assert.equal(inferenceCalls - before, 3);
    });
  } finally {
    await closeModelTransport(); await closeNetwork();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Local vendor-protocol fixtures exercise the real launcher and scoped MCP server.
// They prove routing and lifecycle behavior, not the availability of a paid model.
const healthLauncher = String.raw`
import fs from 'node:fs';
import {spawn} from 'node:child_process';
const [traceFile, mode, adapter] = process.argv.slice(2);
const args = process.argv.slice(5);
const value = flag => args[args.indexOf(flag) + 1];
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const mcp = adapter === 'claude-code' ? JSON.parse(value('--mcp-config')).mcpServers.h2_station : input.mcpServers.h2_station;
const connectionFile = mcp.env.EASY_WORKFLOW_STATION_CONNECTION;
const connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
const headers = {authorization: 'Bearer ' + connection.token};
const definitions = await (await fetch(connection.url + '/tools', {headers})).json();
const submit = definitions.tools.find(tool => tool.name === 'submit');
const child = mode === 'hang' || mode === 'submit-hang' ?
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {windowsHide: true, stdio: 'ignore'}) : undefined;
fs.writeFileSync(traceFile, JSON.stringify({pid: process.pid, childPid: child?.pid, cwd: process.cwd(), connectionFile,
  endpoint: connection.url, tools: definitions.tools.map(tool => tool.name), firstMessage: adapter === 'claude-code' ? input.message : input.firstMessage}));
const id = adapter === 'claude-code' ? value('--session-id') : undefined;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
if (adapter === 'claude-code') emit({type: 'system', subtype: 'init', session_id: id, model: 'fixture-actual-claude',
  tools: ['mcp__h2_station__submit'], mcp_servers: [{name: 'h2_station', status: 'connected'}]});
if (!['no-submit', 'hang', 'credentials'].includes(mode)) {
  const nonce = mode === 'wrong-nonce' ? 'wrong-nonce' : submit.inputSchema.properties.nonce.const;
  const response = await fetch(connection.url + '/call', {method: 'POST', headers: {...headers, 'content-type': 'application/json'},
    body: JSON.stringify({name: 'submit', arguments: {nonce}})});
  await response.text();
}
if (mode === 'hang' || mode === 'submit-hang') {
  setInterval(() => {}, 1000);
} else if (adapter === 'claude-code') {
  emit({type: 'assistant', message: {id: 'fixture-message', model: 'fixture-actual-claude'}});
  emit({type: 'result', subtype: mode === 'credentials' ? 'error_during_execution' : 'success',
    session_id: id, is_error: mode === 'credentials', result: mode === 'credentials' ? 'authentication unavailable' : ''});
} else {
  emit({model: 'fixture-actual-launcher', ...(mode === 'credentials' ? {error: {type: 'credentials'}} : {})});
}
`;

interface HealthTrace {
  pid: number;
  childPid?: number;
  cwd: string;
  connectionFile: string;
  endpoint: string;
  tools: string[];
  firstMessage: unknown;
}

test('adapter preflight validates a scoped nonce and reclaims only its own project work', {timeout: 30000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-adapter-preflight-'));
  const keys = ['PI_CODING_AGENT_DIR', 'FACTORY_PROVIDER', 'FACTORY_MODEL', 'FACTORY_STATION_COMMAND'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const script = path.join(root, 'health-launcher.mjs');
  fs.writeFileSync(script, healthLauncher);
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.FACTORY_PROVIDER = 'unconfigured-preflight-fixture';
  process.env.FACTORY_MODEL = 'unconfigured-preflight-model';
  process.env.FACTORY_STATION_COMMAND = 'invalid default configuration must not affect an explicit binding';
  const work = path.join(root, 'work');
  const retained = path.join(work, '.preflight-user-session');
  fs.mkdirSync(retained, {recursive: true});
  fs.writeFileSync(path.join(retained, 'keep.txt'), 'belongs to an earlier user session');
  const tracePath = (name: string) => path.join(root, `${name}.json`);
  const binding = (name: string, mode: string, adapter: 'claude-code' | 'launcher' = 'claude-code'):
    Exclude<StationAgentBinding, {adapter: 'pi'}> => ({
    adapter, command: [process.execPath, script, tracePath(name), mode, adapter], model: 'fixture-requested',
  });
  const readTrace = (name: string) => JSON.parse(fs.readFileSync(tracePath(name), 'utf8')) as HealthTrace;
  const checkReclaimed = async (name: string) => {
    const trace = readTrace(name);
    assert.equal(path.dirname(path.resolve(trace.cwd)), path.resolve(work));
    assert.match(path.basename(trace.cwd), /^\.preflight-/);
    assert.equal(fs.existsSync(trace.cwd), false, 'owned health directory is removed after launcher exit');
    assert.equal(fs.existsSync(trace.connectionFile), false, 'scoped connection is revoked and removed');
    for (const pid of [trace.pid, trace.childPid].filter((value): value is number => value !== undefined)) {
      assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'}, 'owned process tree is no longer running');
    }
    await assert.rejects(fetch(trace.endpoint + '/tools', {signal: AbortSignal.timeout(1000)}));
    assert.equal(fs.readFileSync(path.join(retained, 'keep.txt'), 'utf8'), 'belongs to an earlier user session');
  };
  try {
    await t.test('a Claude-only graph succeeds without a Pi key and writes only health evidence', async () => {
      const result = await preflight(root, new Broker({browser: 0, model: 1, cpu: 1, http: 1}, 0), {
        network: false, browser: false, model: false, agents: [binding('claude', 'success')],
      });
      assert.equal(result.ok, true, JSON.stringify(result.checks));
      const model = result.checks.find(check => check.id === 'model');
      assert.equal(model?.ok, true);
      assert.match(model!.detail, /claude-code.*fixture-actual-claude/);
      assert.doesNotMatch(model!.detail, /Pi/);
      assert.deepEqual(readTrace('claude').tools, ['submit']);
      assert.match(JSON.stringify(readTrace('claude').firstMessage), /health check/);
      assert.equal(fs.existsSync(path.join(root, 'journal.sqlite')), false);
      assert.equal(process.env.FACTORY_PROVIDER, 'unconfigured-preflight-fixture');
      assert.equal(process.env.FACTORY_STATION_COMMAND, 'invalid default configuration must not affect an explicit binding');
      await checkReclaimed('claude');
    });
    await t.test('custom launchers must submit too, and duplicate bindings execute once', async () => {
      const selected = binding('launcher', 'success', 'launcher');
      const result = await checkAgentEndpoints(root, [selected, structuredClone(selected)], {timeoutMs: 5000});
      assert.equal(result.ok, true, result.detail);
      assert.match(result.detail, /fixture-actual-launcher/);
      assert.equal(result.detail.split('健康回执').length - 1, 1);
      await checkReclaimed('launcher');
    });
    await t.test('metadata without a valid nonce and authentication failures cannot mark the model healthy', async () => {
      for (const mode of ['no-submit', 'wrong-nonce', 'credentials']) {
        const result = await checkAgentEndpoints(root, [binding(mode, mode)], {timeoutMs: 5000});
        assert.equal(result.ok, false, `${mode}: ${result.detail}`);
        assert.ok(result.fix);
        await checkReclaimed(mode);
      }
      const mixed = await checkAgentEndpoints(root, [binding('mixed-success', 'success'), binding('mixed-failure', 'no-submit')], {timeoutMs: 5000});
      assert.equal(mixed.ok, false, 'one verified adapter cannot certify an unverified adapter');
      await checkReclaimed('mixed-success');
      await checkReclaimed('mixed-failure');
    });
    await t.test('a valid submit followed by a stalled launcher remains unhealthy and its process tree is killed', async () => {
      const started = Date.now();
      const result = await checkAgentEndpoints(root, [{...binding('timeout', 'submit-hang'), requestTimeoutMs: 900}], {timeoutMs: 5000});
      assert.equal(result.ok, false);
      assert.match(result.detail, /超过|timed out/);
      assert.ok(Date.now() - started < 4500);
      await checkReclaimed('timeout');
    });
    await t.test('owner cancellation waits for process cleanup and does not start the next selected adapter', async () => {
      const controller = new AbortController();
      const pending = checkAgentEndpoints(root, [binding('cancel', 'hang'), binding('never-started', 'success')], {timeoutMs: 5000, signal: controller.signal});
      const deadline = Date.now() + 4000;
      while (!fs.existsSync(tracePath('cancel')) && Date.now() < deadline) await delay(10);
      assert.equal(fs.existsSync(tracePath('cancel')), true);
      controller.abort(new Error('fixture owner cancelled'));
      const result = await pending;
      assert.equal(result.ok, false);
      assert.match(result.detail, /取消/);
      assert.equal(fs.existsSync(tracePath('never-started')), false);
      await checkReclaimed('cancel');
    });
    await t.test('an unsupported adapter is reported as untested without invoking any client', async () => {
      const result = await checkAgentEndpoints(root, [{adapter: 'unsupported'} as unknown as StationAgentBinding]);
      assert.equal(result.ok, false);
      assert.match(result.detail, /未执行不受支持/);
    });
    assert.deepEqual(fs.readdirSync(work), [path.basename(retained)]);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, {recursive: true, force: true});
  }
});
