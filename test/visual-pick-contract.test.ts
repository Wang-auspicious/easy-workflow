import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import type { StationContext } from '../server/runtime.ts';

test('a tool workspace reaches visual selection without requiring an imaginary asset catalogue', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-workspace-breadth-'));
  const previous = Object.fromEntries(['PI_CODING_AGENT_DIR', 'FACTORY_VAR', 'VISLEXICON_ROOT'].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.FACTORY_VAR = root;
  process.env.VISLEXICON_ROOT = path.join(root, 'unconnected');
  let observation: 'workspace' | 'catalogue' | 'marketing' = 'workspace';
  const received: {accepted: boolean; images: number}[] = [];
  // Replays the actual rejected observation: one output plus Generate, seed,
  // Scatter/Grid, Points and Easing controls. This is a local contract oracle,
  // not a test pretending that an online vision model was evaluated.
  const model = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const parts = request.messages.filter((message: {role: string}) => message.role === 'user').at(-1).content;
    const text = parts.filter((part: {type: string}) => part.type === 'text').map((part: {text: string}) => part.text).join('\n');
    const images = parts.filter((part: {type: string}) => part.type === 'image_url').length;
    const workspacePermitted = /complete working workspace/i.test(text) && /multiple.*visible.*(?:functions|controls)/i.test(text);
    const cataloguePermitted = /actual items|actual rendered items/i.test(text) && /name-list/.test(text);
    const accepted = observation === 'workspace' && workspacePermitted || observation === 'catalogue' && cataloguePermitted;
    received.push({accepted, images});
    const answer = accepted
      ? {index: 1, basis: 'rendered-items', reason: observation === 'workspace'
        ? '完整生成器工作区显示实际渐变及Generate、seed、Scatter/Grid、Points和Easing多种可见功能。'
        : '真实条目目录同时展示多个可取得条目。'}
      : {index: 0, basis: 'none', reason: '两张截图仅展示单个渐变示例和功能介绍，未能一眼看出该工具的作品范围。'};
    res.writeHead(200, {'content-type': 'text/event-stream'});
    const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({id: 'workspace', object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{index: 0, delta, finish_reason}]})}\n\n`);
    send({role: 'assistant', tool_calls: [{index: 0, id: 'workspace-result', type: 'function', function: {name: 'submit', arguments: JSON.stringify(answer)}}]});
    send({}, 'tool_calls');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(model.address() as {port: number}).port}/v1`;
  fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({fixture: {type: 'api_key', key: 'local-test-only'}}));
  fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({providers: {fixture: {api: 'openai-completions', baseUrl: origin, models: [{id: 'fixture', input: ['text', 'image']}]}}}));
  const shot = path.join(root, 'workspace.png');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32', '-frames:v', '1', shot], {windowsHide: true});
  const {breadthPageQuestion} = await import('../packs/vislexicon/tools.ts');
  const {shotReview} = await import('../packs/vislexicon/agents.ts');
  const {pickByImages} = await import('../server/agent-station.ts');
  const {closeModelTransport} = await import('../server/pi.ts');
  const ctx = {node: {key: 'curation/breadth'}, token: {id: 'workspace-fixture', data: {}}, attempt: 'workspace-fixture', worker: {id: 'fixture'},
    modelAssist: {binding: {adapter: 'pi', provider: 'fixture', model: 'fixture'}, projectDirectory: root},
    signal: new AbortController().signal, progress() {}, addEvidence: () => ({})} as unknown as StationContext;
  try {
    const select = (kind: string) => pickByImages(ctx, breadthPageQuestion('Easy Mesh Gradient fixture', kind), [{file: shot, label: 'Generator workspace'}]);
    const selected = await select('tool');
    assert.equal(selected?.index, 0, 'a complete single-tool workspace can show functional breadth without an imaginary gallery');
    assert.equal(selected?.basis, 'rendered-items');
    for (const kind of ['component-source', 'assets', 'collection']) assert.equal((await select(kind))?.index, -1,
      `${kind} must retain its multi-item catalogue requirement`);
    observation = 'marketing';
    assert.equal((await select('tool'))?.index, -1, 'a single output or feature marketing alone is insufficient');
    observation = 'catalogue';
    for (const kind of ['tool', 'component-source', 'assets', 'collection']) assert.equal((await select(kind))?.index, 0,
      `${kind} retains the existing actual-items catalogue path`);
    assert.ok(received.every(request => request.images === 1), 'the actual helper still receives its screenshot');
    const reviewer = shotReview({resolve: () => shot} as never);
    for (const kind of ['tool', 'assets']) {
      const context = {...ctx, token: {...ctx.token, data: {kind, images: [], shots: {}}}};
      const text = (await reviewer.input(context)).text;
      assert.equal(/complete working workspace/i.test(text), kind === 'tool', 'independent review receives the same narrowly scoped rule');
    }
    const duplicateProof = {perImage: [{role: 'identity', ok: true, reason: 'identity'}, {role: 'breadth', ok: true, reason: 'functional range'},
      {role: 'proof', ok: false, reason: 'proof is the home first screen again'}], verdict: 'return' as const,
      returnTo: 'proof', repair: 'replace-page' as const, reason: 'proof重复首页首屏，应为编辑器实际取景'};
    const returned = await reviewer.after!(duplicateProof, {...ctx, token: {...ctx.token, data: {kind: 'tool', shots: {}}}}, {rounds: 1} as never);
    assert.equal(returned.verdict?.verdict, 'return');
    assert.equal(returned.verdict?.returnTo, 'curation/proof', 'tool breadth guidance cannot approve duplicate proof');
  } finally {
    await closeModelTransport();
    await new Promise<void>(resolve => model.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('a positive screenshot verdict with index zero is repaired rather than silently turned into rejection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-visual-contract-'));
  const previous = Object.fromEntries(['PI_CODING_AGENT_DIR', 'FACTORY_VAR', 'VISLEXICON_ROOT'].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.FACTORY_VAR = root;
  process.env.VISLEXICON_ROOT = path.join(root, 'unconnected');
  let calls = 0;
  const requestedModels: string[] = [];
  const model = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requestedModels.push(request.model);
    const args = { index: ++calls === 1 ? 0 : 1, basis: 'rendered-items', reason: 'The image clearly shows multiple items.' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'pick', object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant', tool_calls: [{ index: 0, id: `pick-${calls}`, type: 'function', function: { name: 'submit', arguments: JSON.stringify(args) } }] });
    send({}, 'tool_calls'); res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const port = (model.address() as { port: number }).port;
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
  fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify(Object.fromEntries(['fixture', 'other'].map(provider => [provider, {type: 'api_key', key: 'test-only'}]))));
  fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({providers: Object.fromEntries(['fixture', 'other'].map(provider => [provider,
    {api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, models: [{id: provider, input: ['text', 'image']}]}]))}));
  const shot = path.join(root, 'image.png');
  execFileSync('ffmpeg', ['-loglevel','error','-f','lavfi','-i','color=c=blue:s=32x32','-frames:v','1',shot], { windowsHide: true });
  const { pickByImages } = await import('../server/agent-station.ts');
  const { closeModelTransport, models } = await import('../server/pi.ts');
  try {
    let selected = 'fixture';
    const ctx = { node: { key: 'curation/breadth' }, token: {id: 'test-pick'}, attempt: 'test-pick', worker: { id: 'test' },
      modelAssist: {binding: {adapter: 'pi', provider: 'fixture', model: 'fixture'}, projectDirectory: root,
        piControl: {resolve: () => models({provider: selected, model: selected})}},
      signal: new AbortController().signal, progress(text: string) { if (text.includes('输出无效')) selected = 'other'; } } as unknown as StationContext;
    const picked = await pickByImages(ctx, 'Pick image 1 if it shows items; index 0 means none.', [{ file: shot, label: '/gallery' }]);
    assert.equal(picked?.index, 0, 'the selected first image should remain selected (internal index zero)');
    assert.equal(picked?.basis, 'rendered-items');
    assert.equal(calls, 2, 'inconsistent output must receive feedback before rejecting the site');
    assert.deepEqual(requestedModels, ['fixture', 'other'], 'the repair request uses this node’s latest model');
    const independent = {...ctx, node: {...ctx.node, key: 'curation/proof'}, attempt: 'independent-helper',
      modelAssist: {binding: {adapter: 'pi' as const, provider: 'fixture', model: 'fixture'}, projectDirectory: root}};
    assert.equal((await pickByImages(independent, 'Choose the supplied screenshot.', [{file: shot, label: '/gallery'}]))?.index, 0);
    assert.deepEqual(requestedModels, ['fixture', 'other', 'fixture'], 'another node keeps its own configured selection');
  } finally {
    await closeModelTransport();
    await new Promise<void>(resolve => model.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('easy-workflow-visual-contract-'));
    fs.rmSync(root, {recursive: true, force: true});
  }
});

// Local protocol substitutes; no installed client or online model is invoked.
const selectionFixture = String.raw`import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
const [adapter, mode, ...args] = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const log = path.join(path.dirname(fileURLToPath(import.meta.url)), 'calls.jsonl');
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const actualModel = 'fixture-' + adapter;
const expectedChoice = images => images ? {index: 2, basis: 'rendered-items', reason: 'Two actual screenshots'}
  : {index: 2, reason: 'Second supplied link'};
const inspectInput = (text, images) => {
  assert.match(text, /program station/);
  assert.match(text, /submit/);
  if (images.length) {
    assert.equal(images.length, 2);
    assert.match(text, /image 1: first/);
    assert.match(text, /image 2: second/);
    for (const image of images) assert.equal(image.subarray(0, 2).toString('hex'), 'ffd8');
  } else {
    assert.match(text, /1\. first-link/);
    assert.match(text, /2\. second-link/);
  }
  fs.appendFileSync(log, JSON.stringify({adapter, mode, images: images.length, cwd: process.cwd()}) + '\n');
};
const submit = async (mcp, images) => {
  const connection = JSON.parse(fs.readFileSync(mcp.env.EASY_WORKFLOW_STATION_CONNECTION, 'utf8'));
  const headers = {authorization: 'Bearer ' + connection.token, 'content-type': 'application/json'};
  const listed = await fetch(connection.url + '/tools', {headers}).then(response => response.json());
  assert.deepEqual(listed.tools.map(tool => tool.name), ['submit']);
  const call = async (name, parameters) => {
    const response = await fetch(connection.url + '/call', {method: 'POST', headers, body: JSON.stringify({name, arguments: parameters})});
    return {status: response.status, body: await response.json()};
  };
  assert.equal((await call('env_call', {name: 'fetch_text'})).status, 403);
  assert.equal((await call('submit', {index: 999, reason: 'out of range'})).status, 400);
  if (mode === 'bad-schema') return true;
  if (mode === 'hang') { setInterval(() => {}, 1000); return false; }
  if (images && ['repair', 'invalid'].includes(mode)) {
    const rejected = await call('submit', {index: 0, basis: 'rendered-items', reason: 'Inconsistent'});
    assert.match(rejected.body.content[0].text, /编号与依据矛盾/);
    if (mode === 'invalid') {
      await call('submit', {index: 0, basis: 'rendered-items', reason: 'Still inconsistent'});
      const late = await call('submit', expectedChoice(images));
      assert.equal(late.body.isError, true);
      return true;
    }
  }
  const result = await call('submit', mode === 'none'
    ? {index: 0, basis: 'none', reason: 'No candidate qualifies'} : expectedChoice(images));
  assert.equal(result.status, 200);
  assert.equal(result.body.content[0].text, 'ok');
  const duplicate = await call('submit', expectedChoice(images));
  assert.equal(duplicate.body.isError, true);
  return true;
};
if (adapter === 'codex') {
  const thread = 'helperthread';
  const turn = 'helperturn';
  let images = 0;
  const input = readline.createInterface({input: process.stdin});
  for await (const line of input) {
    const message = JSON.parse(line);
    const reply = result => emit({id: message.id, result});
    if (message.method === 'initialize') reply({});
    else if (message.method === 'config/read') reply({config: {}});
    else if (message.method === 'thread/start') {
      assert.deepEqual(message.params.dynamicTools.map(tool => tool.name), ['submit']);
      reply({thread: {id: thread}, cwd: process.cwd(), approvalPolicy: 'never',
        sandbox: {type: 'readOnly', networkAccess: false}, model: actualModel, modelProvider: 'fixture'});
    } else if (message.method === 'turn/start') {
      const parts = message.params.input;
      const files = parts.filter(part => part.type === 'image').map(part => Buffer.from(part.url.split(',')[1], 'base64'));
      images = files.length;
      inspectInput(parts.filter(part => part.type === 'text').map(part => part.text).join('\n'), files);
      reply({turn: {id: turn}});
      emit({id: 'selection-call', method: 'item/tool/call', params: {
        threadId: thread, turnId: turn, callId: 'selectioncall', tool: 'submit', arguments: expectedChoice(images)}});
    } else if (message.id === 'selection-call') {
      assert.equal(message.result.success, true);
      emit({method: 'thread/tokenUsage/updated', params: {threadId: thread, turnId: turn,
        tokenUsage: {total: {inputTokens: 21, outputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 26}}}});
      emit({method: 'turn/completed', params: {threadId: thread, turn: {id: turn, status: 'completed'}}});
    }
  }
} else if (adapter === 'opencode' && args[0] === 'debug') {
  process.stdout.write(JSON.stringify({mcp: {}}));
} else if (adapter === 'opencode' && args[0] === 'export') {
  process.stdout.write(JSON.stringify({info: {id: 'ses_picker'}, messages: [{
    info: {id: 'msg_picker', sessionID: 'ses_picker', role: 'assistant', providerID: 'fixture', modelID: actualModel},
    parts: [{id: 'prt_picker', type: 'step-finish', messageID: 'msg_picker', sessionID: 'ses_picker',
      tokens: {input: 21, output: 5, cache: {read: 0, write: 0}}, cost: 0.001}],
  }]}));
} else {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let text, files, mcp, id;
  if (adapter === 'launcher') {
    const request = JSON.parse(raw);
    assert.equal(request.protocol, 'h2-closed-agent/1');
    const parts = request.messages.at(-1).content;
    text = parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
    files = parts.filter(part => part.type === 'image').map(part => Buffer.from(part.data, 'base64'));
    mcp = request.mcpServers.h2_station;
  } else if (adapter === 'claude-code') {
    const request = JSON.parse(raw);
    text = request.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    files = request.message.content.filter(part => part.type === 'image').map(part => Buffer.from(part.source.data, 'base64'));
    mcp = JSON.parse(value('--mcp-config')).mcpServers.h2_station;
    id = request.session_id;
    emit({type: 'system', subtype: 'init', session_id: id, model: actualModel,
      tools: ['mcp__h2_station__submit'], mcp_servers: [{name: 'h2_station', status: 'connected'}]});
  } else {
    assert.equal(adapter, 'opencode');
    const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
    mcp = {env: config.mcp.h2_station.environment};
    text = raw;
    files = args.includes('--file') ? args.slice(args.indexOf('--file') + 1).map(file => fs.readFileSync(file)) : [];
  }
  inspectInput(text, files);
  if (await submit(mcp, files.length)) {
    if (adapter === 'launcher') {
      if (mode === 'failed-after-submit') process.exitCode = 1;
      process.stdout.write(JSON.stringify({model: actualModel,
        ...(mode === 'known-cost' ? {usage: {input: 21, output: 5, cost: 0.001}} : {})}));
    } else if (adapter === 'claude-code') {
      emit({type: 'assistant', message: {id: 'assistant', model: actualModel}});
      emit({type: 'result', subtype: 'success', is_error: false, session_id: id,
        total_cost_usd: 0.001, usage: {input_tokens: 21, output_tokens: 5}});
    } else {
      emit({type: 'step_finish', sessionID: 'ses_picker',
        part: {id: 'prt_picker', type: 'step-finish', sessionID: 'ses_picker', messageID: 'msg_picker'}});
    }
  }
}
`;

test('program model helpers use each explicit native adapter with actual images and a submit-only scope', {timeout: 60000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-helper-adapters-'));
  const previous = Object.fromEntries(['PI_CODING_AGENT_DIR', 'FACTORY_VAR', 'FACTORY_STATION_COMMAND', 'FACTORY_STATION_MODEL'].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.FACTORY_VAR = root;
  process.env.FACTORY_STATION_COMMAND = 'invalid-global-launcher-must-not-be-read';
  process.env.FACTORY_STATION_MODEL = 'wrong-global-model';
  const fixture = path.join(root, 'selector.mjs');
  fs.writeFileSync(fixture, selectionFixture);
  const shot = path.join(root, 'image.png');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32', '-frames:v', '1', shot], {windowsHide: true});
  const images = [{file: shot, label: 'first'}, {file: shot, label: 'second'}];
  const {pickByImages, pickOne} = await import('../server/agent-station.ts');
  const {ModelRequests, withModelAdmission} = await import('../server/model-requests.ts');
  const pool = new ModelRequests(1);
  const receipts: import('../shared/types.ts').ModelResponse[] = [];
  let sequence = 0;
  const context = (adapter: 'launcher' | 'opencode' | 'claude-code' | 'codex', mode = 'unknown-cost', signal = new AbortController().signal) => ({
    token: {id: 'helper-token'}, node: {key: 'curation/breadth'}, attempt: 'helper-' + ++sequence,
    worker: {id: 'helper-worker'}, signal, progress() {},
    modelAssist: {binding: {adapter, command: [process.execPath, fixture, adapter, mode],
      model: adapter === 'opencode' ? 'fixture/requested' : 'requested', requestTimeoutMs: 10000}, projectDirectory: root},
  }) as unknown as StationContext;
  const run = <T>(work: () => Promise<T>) => withModelAdmission(() => null, work,
    (_dependency, signal) => pool.acquire(signal), response => receipts.push(response));
  try {
    for (const adapter of ['launcher', 'claude-code', 'opencode', 'codex'] as const) {
      await t.test(adapter + ' receives the two images and returns the selected candidate', async () => {
        const result = await run(() => pickByImages(context(adapter), 'Choose from the supplied pictures.', images));
        assert.equal(result?.index, 1);
        assert.equal(result?.basis, 'rendered-items');
        assert.equal(receipts.at(-1)?.dependency.adapter, adapter);
        assert.equal(receipts.at(-1)?.model, 'fixture-' + adapter);
        if (adapter === 'launcher' || adapter === 'codex') {
          assert.equal(result?.usage, undefined, 'unknown cost must not become zero');
          assert.equal(receipts.at(-1)?.costReported, false);
        } else assert.equal(result?.usage?.cost, 0.001);
        if (adapter === 'codex') {
          assert.equal(receipts.at(-1)?.tokenUsage?.input, 21);
          assert.equal(receipts.at(-1)?.tokenUsage?.output, 5);
        }
        assert.equal(pool.active, 0);
      });
      await t.test(adapter + ' can only select from the supplied link list', async () => {
        const ctx = context(adapter);
        ctx.node.key = 'curation/proof';
        const result = await run(() => pickOne(ctx, 'Choose a supplied link.', ['first-link', 'second-link']));
        assert.equal(result?.index, 1);
        assert.equal(pool.active, 0);
      });
    }
    await t.test('an inconsistent visual index gets one repair and cannot be accepted after two bad submissions', async () => {
      const repaired = await run(() => pickByImages(context('launcher', 'repair'), 'Repair a contradictory image number.', images));
      assert.equal(repaired?.index, 1);
      await assert.rejects(run(() => pickByImages(context('launcher', 'invalid'), 'Reject repeated contradictory numbers.', images)), /输出契约错误/);
      const rejected = await run(() => pickByImages(context('launcher', 'none'), 'None qualifies.', images));
      assert.equal(rejected?.index, -1);
      assert.equal(rejected?.basis, 'none');
    });
    await t.test('a submit followed by client failure cannot produce an accepted selection', async () => {
      await assert.rejects(run(() => pickByImages(context('launcher', 'failed-after-submit'), 'The client will fail after submit.', images)), /exited/);
      await assert.rejects(run(() => pickOne(context('launcher', 'bad-schema'), 'Reject an out-of-range result.', ['first-link', 'second-link'])), /未按契约提交/);
      assert.equal(pool.active, 0);
    });
    await t.test('a blocked model dependency is preserved without starting a helper process', async () => {
      const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8');
      await assert.rejects(withModelAdmission(() => 'fixture dependency is cooling down',
        () => pickOne(context('launcher'), 'Wait for this dependency.', ['first-link', 'second-link'])), /MODEL_CIRCUIT_OPEN/);
      assert.equal(fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8'), calls);
      assert.equal(pool.active, 0);
    });
    await t.test('empty input, missing images and missing binding never launch a fallback client', async () => {
      const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8');
      const empty = context('launcher');
      Object.defineProperty(empty, 'modelAssist', {get() { throw new Error('empty input read its binding'); }});
      assert.equal(await pickByImages(empty, 'empty', []), null);
      assert.equal(await pickOne(empty, 'empty', []), null);
      await assert.rejects(pickByImages(context('launcher'), 'missing', [{file: path.join(root, 'missing.png'), label: 'missing'}]));
      const unconfigured = context('launcher');
      delete unconfigured.modelAssist;
      await assert.rejects(pickOne(unconfigured, 'No global fallback.', ['first-link', 'second-link']), /未配置本节点执行器/);
      assert.equal(fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8'), calls);
    });
    await t.test('cancellation terminates the local helper and releases model admission', async () => {
      const controller = new AbortController();
      const ctx = context('launcher', 'hang', controller.signal);
      const result = run(() => pickOne(ctx, 'Wait until cancelled.', ['first-link', 'second-link']));
      const cancelled = assert.rejects(result, /cancel selection/);
      for (let count = 0; count < 200; count++) {
        if (fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').includes('"mode":"hang"')) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      controller.abort(new Error('cancel selection'));
      await cancelled;
      assert.equal(pool.active, 0);
      assert.equal(pool.queued, 0);
    });
    const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(new Set(calls.map(call => call.cwd)).size, calls.length, 'selections have independent attempt directories');
    assert.ok(calls.every(call => path.relative(path.join(root, 'work'), call.cwd).startsWith('model-assist')));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('easy-workflow-helper-adapters-'));
    fs.rmSync(root, {recursive: true, force: true});
  }
});
