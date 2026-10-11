// Explicit live model verification: two read-only checks, no ingestion or publication.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-pi-live-'));
const connection = path.join(dir, 'connection.json');
const token = 'isolated-live-pi-check';
const out = path.join(root, 'artifacts', 'pi-integration');
fs.mkdirSync(out, { recursive: true });
const child = fork(path.join(root, 'server/main.ts'), [], { cwd: root, execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, FACTORY_DISCOVERY: '0', FACTORY_VAR: dir, FACTORY_LAYOUT: path.join(dir, 'layout.json'), FACTORY_PORT: '0', FACTORY_TOKEN: token, FACTORY_START_PAUSED: '1' } });
let logs = '', cli;
child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Easy Workflow startup timeout')), 20000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Easy Workflow exited before ready')); });
    child.on('message', m => { if (m.type === 'ready') { clearTimeout(timer); resolve(m.url); } });
  });
  const request = async (route, input) => {
    const res = await fetch(url + route, { method: input === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(5000) });
    assert.ok(res.ok); return res.json();
  };
  const bootstrap = await request('/api/agent/bootstrap');
  assert.ok(bootstrap.model.ready, bootstrap.model.error ?? 'Pi credentials missing');
  console.log(JSON.stringify({ phase: 'connected', model: bootstrap.model, bootstrapCharacters: bootstrap.instructions.length }));
  const prompt = '检查 Easy Workflow 当前是否有任务在运行。只读查询，不要投料或启动任务。用一句中文告诉我真实状态。';
  await request('/api/chat', { text: prompt });
  const deadline = Date.now() + 120000;
  let reply;
  while (Date.now() < deadline) {
    const state = await request('/api/state');
    reply = state.chat.find(m => m.role === 'assistant');
    if (reply) break;
    await new Promise(r => setTimeout(r, 750));
  }
  assert.ok(reply, 'dispatcher did not finish');
  const dispatcherOK = reply.tools?.some(t => t.name === 'easy_workflow_call') && !/出错|调用失败/.test(reply.text);
  console.log(JSON.stringify({ phase: 'dispatcher', text: reply.text, tools: reply.tools }));
  fs.writeFileSync(connection, JSON.stringify({ protocol: 'h2-agent/1', url, token }), { mode: 0o600 });
  const cliPath = process.env.PI_CLI ?? path.join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
  assert.ok(fs.existsSync(cliPath), 'installed Pi CLI not found');
  let output = '', errors = '';
  cli = spawn(process.execPath, [cliPath, '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '-e', path.join(root, 'integrations/pi/easy-workflow.ts'), '--tools', 'easy_workflow_help,easy_workflow_call', '--thinking', 'off', '--mode', 'json', '--system-prompt', '你是用户的助手，优先使用当前提供的工具获取真实信息。', '-p', prompt], {
    cwd: dir, windowsHide: true, env: { ...process.env, FACTORY_AGENT_CONNECTION: connection }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  cli.stdout.on('data', b => { output += b; }); cli.stderr.on('data', b => { errors += b; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cli.kill(); reject(new Error('Pi CLI live check timeout')); }, 120000);
    cli.once('error', reject); cli.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(code, 0, errors.slice(-600));
  const events = output.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const calls = events.filter(e => e.type === 'tool_execution_end').map(e => ({ name: e.toolName, isError: e.isError }));
  assert.ok(calls.some(c => c.name === 'easy_workflow_call' && !c.isError), 'Pi did not discover and call Easy Workflow');
  const answer = events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').at(-1)?.message?.content?.filter(c => c.type === 'text').map(c => c.text).join('');
  const state = await request('/api/state');
  const native = state.conversation;
  assert.ok(native.some(e => e.message.role === 'assistant' && e.message.content.some(c => c.type === 'toolCall')), 'Pi tool calls were not recorded');
  assert.ok(native.some(e => e.message.role === 'toolResult'), 'Pi tool results were not recorded');
  const callsById = new Set(native.flatMap(e => e.message.role === 'assistant' ? e.message.content.filter(c => c.type === 'toolCall').map(c => c.id) : []));
  assert.ok(native.filter(e => e.message.role === 'toolResult').every(e => callsById.has(e.message.toolCallId)), 'unpaired tool result');
  fs.writeFileSync(path.join(out, 'conversation.json'), JSON.stringify(native, null, 2));
  assert.equal(Object.keys(state.tokens).length, 0); assert.equal(state.run.status, 'idle');
  const result = { ok: Boolean(dispatcherOK), model: bootstrap.model, bootstrapCharacters: bootstrap.instructions.length, dispatcher: { text: reply.text, tools: reply.tools }, externalPi: { calls, answer }, businessStateUnchanged: true };
  fs.writeFileSync(path.join(out, 'live-check.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  assert.ok(dispatcherOK, 'GUI dispatcher live query failed');
} finally {
  if (cli && cli.exitCode === null) cli.kill();
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
    const timer = setTimeout(() => child.kill(), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send({ type: 'shutdown' }); else child.kill();
  });
  assert.ok(path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()), 'easy-workflow-pi-live-')));
  fs.rmSync(dir, { recursive: true, force: true });
}
