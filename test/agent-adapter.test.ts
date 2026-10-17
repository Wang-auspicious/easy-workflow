import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from 'node:http';
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { configureAgentStations, runAgentStation, runStationDialogue, stationBudget, type AgentStationDef } from "../server/agent-station.ts";
import { Toolbox, type EnvContext } from "../server/toolbox.ts";
import { Broker } from "../server/broker.ts";
import { Docs } from "../server/docs.ts";
import { Journal } from "../server/journal.ts";
import { Runtime, type StationContext, type StationResult } from "../server/runtime.ts";
import { compile } from '../server/spec/compile.ts';
import { line, station, type Pack } from '../server/spec/dsl.ts';
import { apply, initialState } from '../shared/project.ts';
import { closeNetwork, readEvidence, rememberRead } from "../server/network.ts";
import { ClosedStationAgent, closedAgentConfig, openStationMcp } from '../server/mcp-station.ts';
import { ClaudeCodeProtocol, type ClaudeSessionReference } from '../server/claude-code.ts';
import { EvidenceStore, type ImageProcessOptions } from '../server/evidence.ts';
import { closeModelTransport, models, piStatus, probeModelConnection, redactModelError } from '../server/pi.ts';
import type {CompiledFactory, ModelDependency, StationAgentBinding} from '../shared/types.ts';
import {collaborationView, collaborationImages, collaborationPixels} from '../server/collaboration-views.ts';
import { sessionSignature, type SessionRef } from '../server/station-session.ts';
import {withModelAdmission} from '../server/model-requests.ts';
import {closedModelDependency} from '../server/agent-bindings.ts';
import {installWorkflowPack, type WorkflowManifest} from '../server/workflow-packs.ts';
import {OpenCodeProtocol, validOpenCodeSession, type OpenCodeSessionReference} from '../server/opencode.ts';
import {CodexProtocol, validCodexSession, type CodexSessionReference} from '../server/codex.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {KernelStore} from '../server/kernel/store.ts';
import {Kernel} from '../server/kernel/kernel.ts';
import {BoardStore} from '../server/board.ts';
import type {Factory} from '../server/factory.ts';
import type {BoardPost, BoardPostInput} from '../shared/board.ts';
import type {CollaborationTurn} from '../server/collaboration.ts';

test("closed launcher receives envelope first, calls scoped MCP, repairs and reports real usage", { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h2-closed-agent-test-"));
  const previous = Object.fromEntries(["FACTORY_STATION_COMMAND", "FACTORY_STATION_MODEL", "FACTORY_TOKEN", "FACTORY_AGENT_CONNECTION"].map(k => [k, process.env[k]]));
  process.env.FACTORY_STATION_COMMAND = JSON.stringify([process.execPath, fileURLToPath(new URL("./fixtures/closed-agent-launcher.mjs", import.meta.url))]);
  process.env.FACTORY_STATION_MODEL = "fixture-requested-model";
  process.env.FACTORY_TOKEN = "not-for-station";
  process.env.FACTORY_AGENT_CONNECTION = "not-for-station.json";
  const docs = { dir, envelope: () => ({ text: "fixture envelope", sizes: { role: 16, project: 0, context: 0, caseFile: 0 } }) } as unknown as Docs;
  const toolbox = new Toolbox({ journal: { append: () => { throw new Error("unexpected journal write"); } } as unknown as Journal, broker: new Broker({ browser: 1, http: 1, model: 1, cpu: 1 }), docs: () => docs });
  configureAgentStations({ docs: () => docs, toolbox: () => toolbox });
  const progress: string[] = [];
  const ctx = { token: { id: "fixture-task", item: "fixture.test" }, node: { key: "curation/reader" }, attempt: "fixture-attempt", worker: { id: "fixture-worker" }, signal: new AbortController().signal, progress: (text: string) => progress.push(text) } as unknown as StationContext;
  try {
    const result = await runAgentStation({ system: "fixture station contract", schema: Type.Object({ score: Type.Integer() }, { additionalProperties: false }),
      input: () => ({ text: "fixture input" }), check: (out: { score: number }) => out.score === 1 ? [] : ["score must be 1"],
      after: (out, _ctx, meta) => ({ ok: true, summary: `score ${out.score}`, data: { rounds: meta.rounds } }) }, ctx);
    assert.equal(result.ok, true, result.error ?? "closed agent must complete");
    assert.equal(result.data?.rounds, 2);
    assert.deepEqual(result.usage, { input: 200, output: 40, cost: .002, cacheRead: 60, cacheWrite: 10 });
    assert.deepEqual(result.metrics?.execution, { adapter: "closed-command", model: "fixture-actual-model" });
    assert.equal(result.metrics?.usageReported, true);
    assert.equal(result.metrics?.usageComplete, true);
    assert.equal(result.metrics?.cacheUsageComplete, true);
    assert.equal(result.metrics?.modelTimeReported, true);
    assert.equal(result.metrics?.time?.modelCalls, 2);
    assert.equal(result.metrics?.time?.firstTokenMs, 16);
    assert.equal(result.metrics?.time?.outputMs, 24);
    assert.equal(result.metrics?.time?.toolCalls, 7, "count both env_call/env_help/submit rounds and the duplicate after the accepted submit");
    assert.equal(result.metrics?.activity?.modelTiming, "unavailable", "aggregate launcher durations cannot establish model interval boundaries");
    assert.equal(result.metrics?.activity?.spans.length, 7);
    assert.ok(result.metrics?.activity?.spans.every(span => span.kind === "tool" && span.endedAt !== undefined));
    assert.equal(result.metrics?.activity?.spans.filter(span => span.status === "failed").length, 4);
    assert.ok(progress.some(p => p.includes("程序检查全部通过")));
    assert.ok(!progress.join("\n").includes("not-for-station"));
    assert.ok(fs.existsSync(path.join(dir, "work", "fixture-task")));
    const simple = { system: "fixture station contract", schema: Type.Object({ score: Type.Integer() }, { additionalProperties: false }), input: () => ({ text: "fixture input" }), after: () => ({ ok: true, summary: "done" }) };
    process.env.FACTORY_STATION_MODEL = 'fixture-schema-probe';
    const schemaProbe = await runAgentStation(simple, ctx);
    assert.equal(schemaProbe.ok, true, schemaProbe.error ?? 'Schema repair must succeed');
    assert.equal(schemaProbe.agentContract?.repairs, 1);
    assert.equal(schemaProbe.agentContract?.rounds, 2);
    process.env.FACTORY_STATION_MODEL = "fixture-no-cache";
    const noCache = await runAgentStation(simple, ctx);
    assert.equal(noCache.ok, true); assert.equal(noCache.usage?.cacheRead, undefined); assert.equal(noCache.usage?.cacheWrite, undefined);
    assert.equal(noCache.metrics?.usageComplete, true); assert.equal(noCache.metrics?.cacheUsageComplete, false);
    process.env.FACTORY_STATION_MODEL = "fixture-no-usage";
    const noUsage = await runAgentStation(simple, ctx);
    assert.equal(noUsage.ok, true); assert.equal(noUsage.usage, undefined);
    assert.equal(noUsage.metrics?.usageReported, false); assert.equal(noUsage.metrics?.usageComplete, false);
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await closeNetwork();
    assert.ok(path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()), "h2-closed-agent-test-")));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// An explicit vendor-protocol fixture, not a claim about a live Claude model.
// It checks the real argv/stdin boundary and uses the actual scoped MCP server.
const claudeFixture = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const args = process.argv.slice(1), value = flag => args[args.indexOf(flag) + 1];
assert.equal(value('--tools'), ''); assert.equal(value('--permission-mode'), 'dontAsk');
assert.ok(!args.includes('--max-turns'), 'the host budget must not be replaced by a twelve-turn CLI ceiling');
assert.equal(value('--setting-sources'), ''); assert.ok(args.includes('--strict-mcp-config'));
assert.deepEqual(value('--allowedTools').split(','), ['mcp__h2_station__env_help', 'mcp__h2_station__env_call', 'mcp__h2_station__submit', 'mcp__h2_station__handoff']);
assert.ok(args.includes('--disable-slash-commands')); assert.ok(!args.includes('--dangerously-skip-permissions'));
assert.equal(JSON.parse(value('--settings')).disableAllHooks, true);
const resumed = args.includes('--resume'), id = value(resumed ? '--resume' : '--session-id');
const vendorFile = require('node:path').join(process.cwd(), '.fixture-vendor-session-' + id);
if (resumed) assert.ok(fs.existsSync(vendorFile), 'This fixture models the installed CLI: resume must use its original cwd');
else fs.writeFileSync(vendorFile, 'Fixture vendor session');
let raw = ''; process.stdin.on('data', data => { raw += data; });
process.stdin.on('end', async () => {
  const input = JSON.parse(raw); assert.equal(input.type, 'user'); assert.equal(input.message.role, 'user');
  const mcp = JSON.parse(value('--mcp-config')).mcpServers.h2_station;
  const connection = JSON.parse(fs.readFileSync(mcp.env.EASY_WORKFLOW_STATION_CONNECTION, 'utf8'));
  const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
  emit({ type: 'system', subtype: 'init', session_id: id, model: 'fixture-actual-claude',
    tools: ['mcp__h2_station__env_help', 'mcp__h2_station__env_call', 'mcp__h2_station__submit', 'mcp__h2_station__handoff'], mcp_servers: [{ name: 'h2_station', status: 'connected' }] });
  const call = async (name, parameters) => {
    const response = await fetch(connection.url + '/call', { method: 'POST', headers: { authorization: 'Bearer ' + connection.token, 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: parameters }) });
    assert.equal(response.status, 200); return response.json();
  };
  if (!resumed) await call('env_call', { name: 'fetch_text', arguments: { url: 'https://fixture.invalid/source' } });
  if (!resumed && input.message.content[0].text.includes('native-cancel')) {
    setInterval(() => {}, 1000); return;
  }
  const fail = !resumed && input.message.content[0].text.includes('native-restart');
  if (!fail) await call('submit', { score: resumed ? 1 : 0 });
  emit({ type: 'assistant', message: { id: 'one-api-message', model: 'fixture-actual-claude', content: [{ type: 'text', text: 'Fixture' }] } });
  emit({ type: 'assistant', message: { id: 'one-api-message', model: 'fixture-actual-claude', content: [{ type: 'tool_use', name: 'submit' }] } });
  emit({ type: 'result', subtype: fail ? 'error_during_execution' : 'success', is_error: fail, session_id: id,
    errors: fail ? ['ECONNRESET fixture-only secret must not be logged'] : [], total_cost_usd: resumed ? .05 : .1,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 } });
  process.exitCode = fail ? 1 : 0;
});`;

async function nativeFixture(run: (dir: string, calls: () => number, envelope: { text: string; sessionPolicy: string }) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-claude-adapter-'));
  const keys = ['FACTORY_STATION_COMMAND', 'FACTORY_STATION_MODEL', 'FACTORY_STATION_ADAPTER', 'FACTORY_STATION_TIMEOUT_MS'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.FACTORY_STATION_COMMAND = JSON.stringify([process.execPath, '-e', claudeFixture, '--']);
  process.env.FACTORY_STATION_MODEL = 'fixture-requested-claude'; process.env.FACTORY_STATION_ADAPTER = 'claude-code';
  process.env.FACTORY_STATION_TIMEOUT_MS = '10000';
  let reads = 0;
  const envelope = { text: 'Fixture station identity', sessionPolicy: 'fixture-policy-one' };
  const docs = { dir, envelope: () => ({ ...envelope, sizes: { role: 16, project: 0, context: 0, caseFile: 0 } }) } as unknown as Docs;
  const toolbox = { help: () => ({ ok: true }), call: async (allowed: string[], name: string) => {
    assert.ok(allowed.includes(name)); assert.equal(name, 'fetch_text'); reads++;
    rememberRead('https://fixture.invalid/source', 'Persisted fixture observation'); return { ok: true, text: 'Persisted fixture observation' };
  } } as unknown as Toolbox;
  configureAgentStations({ docs: () => docs, toolbox: () => toolbox });
  try { await run(dir, () => reads, envelope); }
  finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true });
  }
}

const nativeContext = (id: string, data: Record<string, unknown> = {}) => ({
  token: { id, item: 'fixture-item', data }, node: { key: 'curation/reader' }, attempt: `attempt-${id}`,
  worker: { id: 'fixture-worker' }, signal: new AbortController().signal, progress: () => {},
}) as unknown as StationContext;

interface ContractReply {
  text?: string;
  tool?: {name: string; arguments: Record<string, unknown>};
  tokens?: number;
}

interface ContractFixture {
  dir: string;
  requests: Record<string, unknown>[];
  reads: () => number;
  definition: AgentStationDef<{score: number; note?: string}>;
  context: StationContext;
}

/** Real Pi transport and tool dispatch, with a deterministic local model only. */
async function contractFixture(reply: (index: number, request: Record<string, unknown>) => ContractReply,
  run: (fixture: ContractFixture) => Promise<void>) {
  await nativeFixture(async (dir, reads) => {
    const previousDirectory = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    const requests: Record<string, unknown>[] = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      requests.push(body);
      const next = reply(requests.length, body);
      const delta = next.tool ? {role: 'assistant', tool_calls: [{index: 0, id: `contract-${requests.length}`,
        type: 'function', function: {name: next.tool.name, arguments: JSON.stringify(next.tool.arguments)}}]}
        : {role: 'assistant', content: next.text ?? 'I am still checking the fixture.'};
      response.writeHead(200, {'content-type': 'text/event-stream'});
      for (const part of [
        {choices: [{index: 0, delta, finish_reason: null}]},
        {choices: [{index: 0, delta: {}, finish_reason: next.tool ? 'tool_calls' : 'stop'}],
          usage: {prompt_tokens: next.tokens ?? 10, completion_tokens: 0, total_tokens: next.tokens ?? 10}},
      ]) response.write(`data: ${JSON.stringify({id: 'contract-fixture', model: 'contract-model', ...part})}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as {port: number}).port;
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({contract: {type: 'api_key', key: 'local-contract-fixture'}}));
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({providers: {contract: {
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`,
      models: [{id: 'contract-model', input: ['text', 'image']}],
    }}}));
    const definition: ContractFixture['definition'] = {
      agent: {adapter: 'pi', provider: 'contract', model: 'contract-model'},
      role: {station: 'curation/reader', path: 'fixture/ROLE.md', revision: 'contract-role-v1', content: 'Fixture reader role.'},
      system: 'Fixture contract with strict program checks.',
      schema: Type.Object({score: Type.Integer(), note: Type.Optional(Type.String())}, {additionalProperties: false}),
      tools: ['fetch_text'], input: () => ({text: 'contract-original-input-marker'}),
      check: output => output.score === 2 ? [] : ['score must be 2'],
      after: output => ({ok: true, summary: 'contract accepted', data: output}),
    };
    const context = nativeContext('contract-fixture');
    context.node = {...context.node, accept: ['Score equals 2', 'Evidence remains traceable']};
    try {
      await run({dir, requests, reads, definition, context});
    } finally {
      await closeModelTransport();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDirectory;
    }
  });
}

const contractReminder = '你还没有调用 submit。请先对照下面的自检清单逐条确认，然后调用 submit 提交。若无法完成，调用 handoff 说明已完成的部分和缺失的部分。';
const submitContract = (score = 2): ContractReply => ({tool: {name: 'submit', arguments: {score}}});

test('D dialogue uses the original Pi history with scoped input and dedicated answer/turn endings', {timeout: 20000}, async () => {
  const answer = {type: 'answer', field: 'proof', target: 'question-fixture', body: 'The observed proof is valid.', evidence: ['proof-evidence']};
  const claim = {type: 'claim', field: 'proof', body: JSON.stringify({value: 'confirmed', reason: 'Observed proof'}), evidence: ['proof-evidence']};
  await contractFixture(index => index === 1 ? {tool: {name: 'submit', arguments: {score: 2, note: 'original-submit-history-marker'}}}
    : index === 2 ? {tool: {name: 'board_post', arguments: answer}}
      : index === 3 ? {tool: {name: 'submit_answer', arguments: {}}}
        : index === 4 ? {tool: {name: 'board_post', arguments: claim}}
          : {tool: {name: 'submit_turn', arguments: {}}}, async fixture => {
    let dialogue = false, inputs = 0, envelopes = 0, afters = 0;
    const docs = {dir: fixture.dir, envelope: () => {
      assert.equal(dialogue, false, 'a dialogue must not reread the full current PROJECT/CASE envelope');
      envelopes++;
      return {text: 'Original authorized envelope.', sizes: {role: 0, project: 0, context: 0, caseFile: 0}};
    }} as unknown as Docs;
    const definition: typeof fixture.definition = {...fixture.definition,
      services: {docs: () => docs, toolbox: () => ({names: () => []}) as unknown as Toolbox},
      input: () => {assert.equal(dialogue, false, 'dialogue must not rerun the original task input'); inputs++; return {text: 'original-only-input-marker'};},
      after: output => {assert.equal(dialogue, false, 'answering a colleague must not rerun the business after hook'); afters++; return {ok: true, summary: 'original complete', data: output};},
    };
    const first = await runAgentStation(definition, fixture.context);
    assert.equal(first.ok, true, first.error ?? 'Original task should submit');
    assert.ok(first.sessionCheckpoint?.pi);
    dialogue = true;
    const posts: unknown[] = [], checkpoints: unknown[] = [];
    const context: StationContext = {...fixture.context, attempt: 'answer-turn', session: first.sessionCheckpoint.pi,
      token: {...fixture.context.token, data: {...first.data, proof: 'visible-proof', privateUnrelated: 'DO-NOT-LEAK-FULL-ITEM'}},
      checkpointSession: value => checkpoints.push(value)};
    const reply = await runStationDialogue(definition, context, {kind: 'answer',
      prompt: '有同事提问：证据是否支持当前取值？请 board_post answer 后 submit_answer。',
      input: {text: JSON.stringify({proof: 'visible-proof'})}, read: () => [],
      post: value => {posts.push(value); return {id: 'answer-fixture'};}});
    assert.equal(reply.ok, true, reply.error ?? 'Question must finish with submit_answer');
    assert.deepEqual(posts, [answer]);
    assert.equal(reply.sessionCheckpoint?.pi?.signature, first.sessionCheckpoint.pi.signature);
    assert.deepEqual(reply.agentContract?.budget, {maxTokens: 8000, maxMs: 180000});
    assert.match(JSON.stringify(fixture.requests[1]), /original-submit-history-marker/);
    assert.ok(!JSON.stringify(fixture.requests.slice(1)).includes('DO-NOT-LEAK-FULL-ITEM'));
    const image = path.join(fixture.dir, 'dialogue-home.ppm');
    fs.writeFileSync(image, Buffer.concat([Buffer.from('P6\n4 6\n255\n'), Buffer.alloc(4 * 6 * 3, 128)]));
    const room = await runStationDialogue(definition, {...context, attempt: 'room-turn', session: reply.sessionCheckpoint!.pi}, {
      kind: 'room', prompt: '讨论室 proof，第 1/3 轮，请发一条 claim 后 submit_turn。',
      input: {text: JSON.stringify({proof: 'visible-proof'}), images: [{file: image, label: '本轮新增首页截图'}]}, read: () => posts,
      post: value => {(posts as unknown[]).push(value); return {id: 'claim-fixture'};}});
    assert.equal(room.ok, true, room.error ?? 'Room must finish with submit_turn');
    assert.equal(room.sessionCheckpoint?.pi?.signature, first.sessionCheckpoint.pi.signature);
    assert.deepEqual(room.agentContract?.budget, {maxTokens: 12000, maxMs: 240000});
    assert.deepEqual(posts, [answer, claim]);
    assert.deepEqual([inputs, envelopes, afters], [1, 1, 1]);
    assert.equal(fixture.requests.length, 5);
    assert.ok(checkpoints.length >= 2, 'each persisted board post checkpoints its live original session');
    const roomRequest = JSON.stringify(fixture.requests[3]);
    assert.match(roomRequest, /original-only-input-marker/);
    assert.match(roomRequest, /The observed proof is valid/);
    assert.ok(!roomRequest.includes('DO-NOT-LEAK-FULL-ITEM'));
    const latestUser = (fixture.requests[3].messages as {role: string; content: unknown}[]).findLast(message => message.role === 'user');
    assert.ok(Array.isArray(latestUser?.content), 'a restored dialogue must append its new image to this turn');
    const imagePart = (latestUser.content as {type: string; image_url?: {url: string}}[]).find(part => part.type === 'image_url');
    assert.match(imagePart?.image_url?.url ?? '', /^data:image\/jpeg;base64,/);
    const tools = fixture.requests[3].tools as {function: {name: string}}[];
    assert.deepEqual(tools.map(tool => tool.function.name).sort(), ['board_post', 'board_read', 'handoff', 'submit_turn']);
    const saved = JSON.parse(fs.readFileSync(path.join(fixture.dir, room.sessionCheckpoint!.pi!.file), 'utf8'));
    assert.match(saved.submitSummary, /original-submit-history-marker/, 'dialogue closers do not replace the original business submit summary');

    const store = new EvidenceStore(path.join(fixture.dir, 'missing-evidence'), true);
    const missingView = {viewKind: 'shots+pixels', images: [{role: 'proof', src: '/evidence/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp'}]};
    const scoped = await collaborationPixels(missingView, store);
    const missing = collaborationImages(scoped, store);
    assert.equal(missing?.length, 1);
    assert.equal(missing?.[0].file, '', 'a declared missing image must not disappear from model input');
    const rejected = await runStationDialogue(definition, context, {kind: 'room', prompt: 'Review the declared image.',
      input: {text: JSON.stringify(scoped), images: missing}});
    assert.equal(rejected.failure?.tag, 'missing_artifact');
    assert.equal(fixture.requests.length, 5, 'missing images stop before any model request');
  });
});

test('D participant views expose only declared evidence and remain detached from item data', () => {
  const compiled = {rooms: [
    {field: 'kind', participants: ['c/classify', 'c/classify-review'], judge: 'c/arbiter', views: {'c/classify': 'dossier', 'c/classify-review': 'dossier+home'}},
    {field: 'shots.*', participants: ['c/shot-review', 'c/style', 'c/reader'], judge: 'program:shot-rules', views: {'c/shot-review': 'shots+pixels', 'c/style': 'shots', 'c/reader': 'plan+sitemap'}},
    {field: 'facts.*', participants: ['c/facts', 'c/fact-review'], judge: 'c/fact-review', views: {'c/facts': 'sources', 'c/fact-review': 'source-quotes'}},
    {field: 'copy', participants: ['c/copy', 'c/copy-review'], judge: 'c/copy-review', views: {'c/copy': 'facts+style', 'c/copy-review': 'facts+style'}},
  ]} as unknown as CompiledFactory;
  const data = {dossier: {title: 'Public title', text: 'Dossier evidence', secret: 'nested-private', files: {sitemap: ['/evidence'], llms: 'Public rules'}},
    images: [{role: 'identity', src: '/evidence/home.webp'}, {role: 'proof', src: '/evidence/proof.webp'}],
    readerPlan: {proof: {url: 'https://fixture.invalid/evidence'}}, facts: {license: {value: 'MIT', quote: 'Original license line', evidence: 'license-evidence'}},
    factPages: [{url: 'https://fixture.invalid/license', text: 'Source page text'}], style: {styles: ['plain']}, unrelated: 'private-unrelated'};
  const classify = collaborationView(compiled, data, 'c/classify', 'kind');
  assert.ok(!JSON.stringify(classify).includes('/evidence/') && !JSON.stringify(classify).includes('nested-private'));
  const reviewer = collaborationView(compiled, data, 'c/classify-review', 'kind');
  assert.equal((reviewer.images as unknown[]).length, 1);
  assert.ok(JSON.stringify(reviewer).includes('home.webp') && !JSON.stringify(reviewer).includes('proof.webp'));
  const beforeCapture = {...data, images: [], homeScreenshot: {src: '/evidence/room-home.webp', evidence: 'room-home', secret: 'capture-private'}};
  const capturedHome = collaborationView(compiled, beforeCapture, 'c/classify-review', 'kind');
  assert.equal(capturedHome.homeScreenshotAvailable, true);
  assert.deepEqual(capturedHome.images, [{src: '/evidence/room-home.webp', evidence: 'room-home', role: 'identity'}]);
  assert.ok(!JSON.stringify(collaborationView(compiled, beforeCapture, 'c/classify', 'kind')).includes('room-home'));
  assert.deepEqual(Object.keys(collaborationView(compiled, data, 'c/style', 'shots.proof')).sort(), ['images', 'viewKind']);
  assert.deepEqual(Object.keys(collaborationView(compiled, data, 'c/reader', 'shots.proof')).sort(), ['readerPlan', 'sitemap', 'viewKind']);
  const copy = collaborationView(compiled, data, 'c/copy', 'copy');
  assert.deepEqual(Object.keys(copy).sort(), ['facts', 'style', 'viewKind']);
  (copy.facts as typeof data.facts).license.value = 'changed-in-view';
  assert.equal(data.facts.license.value, 'MIT', 'view mutations cannot change the actual item');
  for (const [node, field] of [['c/facts', 'facts.license'], ['c/fact-review', 'facts.license'], ['c/shot-review', 'shots.proof']]) {
    const view = collaborationView(compiled, data, node, field);
    assert.ok(!JSON.stringify(view).includes('private-unrelated'));
  }
});

test('C contract retains two missing submissions and accepts the third in the same conversation', {timeout: 20000}, async () => {
  await contractFixture(index => index < 3 ? {text: `unfinished-turn-${index}`} : submitContract(), async fixture => {
    const result = await runAgentStation(fixture.definition, fixture.context);
    assert.equal(result.ok, true, result.error ?? 'Expected accepted submission');
    assert.equal(fixture.requests.length, 3);
    const history = JSON.stringify(fixture.requests.at(-1));
    assert.ok(history.includes('unfinished-turn-1') && history.includes('unfinished-turn-2'));
    assert.equal(history.split(contractReminder).length - 1, 2);
    for (const accept of fixture.context.node.accept!) assert.ok(history.includes(accept));
    assert.equal(result.agentContract?.reminders, 2);
    assert.equal(result.agentContract?.ending, 'submit');
    assert.equal(result.agentContract?.actualTokens, 30);
    assert.ok(result.sessionCheckpoint?.pi, 'successful work must retain its reusable transcript');
  });
});

test('C contract uses exactly three fixed reminders then saves a forced handoff', {timeout: 20000}, async () => {
  await contractFixture(index => ({text: `never-submits-${index}`}), async fixture => {
    const result = await runAgentStation(fixture.definition, fixture.context);
    assert.equal(result.ok, false);
    assert.equal(fixture.requests.length, 4);
    assert.equal(JSON.stringify(fixture.requests.at(-1)).split(contractReminder).length - 1, 3);
    assert.equal(result.agentContract?.reminders, 3);
    assert.equal(result.agentContract?.ending, 'forced_handoff');
    assert.equal(result.failure, undefined, 'contract exhaustion is a resumable handoff, not a no-submit failure');
    assert.deepEqual(result.handoff, {done: [], evidence: [], remaining: fixture.context.node.accept,
      suggestion: '模型未能在预算内完成'});
    assert.ok(result.sessionCheckpoint?.pi);
  });
});

test('C contract reports schema and program failures as tools before the third valid submit', {timeout: 20000}, async () => {
  await contractFixture(index => index === 1 ? {tool: {name: 'submit', arguments: {score: 'two'}}}
    : submitContract(index === 2 ? 0 : 2), async fixture => {
    let accepted = 0;
    const result = await runAgentStation({...fixture.definition, after: output => {
      accepted++;
      return {ok: true, summary: 'accepted only after both checks', data: output};
    }}, fixture.context);
    assert.equal(result.ok, true, result.error ?? 'Expected accepted submission');
    assert.equal(accepted, 1);
    assert.equal(fixture.requests.length, 3);
    const messages = fixture.requests.at(-1)!.messages as {role: string; content: unknown}[];
    const errors = messages.filter(message => message.role === 'tool').map(message => JSON.stringify(message.content));
    assert.equal(errors.length, 2);
    assert.match(errors[0], /score|integer|number/i);
    assert.match(errors[1], /score must be 2/);
    assert.ok(JSON.stringify(messages).includes('contract-original-input-marker'));
    assert.equal(result.agentContract?.repairs, 2);
    assert.equal(result.agentContract?.rounds, 3);
    assert.equal(result.agentContract?.ending, 'submit');
  });
});

test('C contract keeps all fifteen completed environment tools when budget permits', {timeout: 20000}, async () => {
  await contractFixture(index => index <= 15 ? {tool: {name: 'env_call', arguments: {
    name: 'fetch_text', arguments: {url: 'https://fixture.invalid/source'},
  }}} : submitContract(), async fixture => {
    const result = await runAgentStation(fixture.definition, {...fixture.context, agentBudget: {maxTokens: 1000, maxMs: 900000}});
    assert.equal(result.ok, true, result.error ?? 'Expected accepted submission');
    assert.equal(fixture.reads(), 15);
    assert.equal(fixture.requests.length, 16);
    assert.equal(result.metrics?.time?.toolCalls, 16);
    assert.equal(result.agentContract?.actualTokens, 160);
    assert.equal(result.agentContract?.ending, 'submit');
  });
});

test('C contract requests handoff at ninety percent and records the explicit bounded handoff', {timeout: 20000}, async () => {
  const handoff = {done: ['read source'], evidence: ['https://fixture.invalid/source'], remaining: ['verify score'], suggestion: 'Continue verification.'};
  await contractFixture(index => index === 1 ? {text: 'Ninety percent of token budget consumed.', tokens: 90}
    : {tool: {name: 'handoff', arguments: handoff}, tokens: 1}, async fixture => {
    const result = await runAgentStation(fixture.definition, {...fixture.context, agentBudget: {maxTokens: 100, maxMs: 900000}});
    assert.equal(result.ok, false);
    assert.equal(fixture.requests.length, 2);
    assert.match(JSON.stringify(fixture.requests[1]), /90%/);
    assert.deepEqual(result.handoff, handoff);
    assert.equal(result.agentContract?.ending, 'handoff');
    assert.equal(result.agentContract?.actualTokens, 91);
    assert.ok(result.sessionCheckpoint?.pi);
  });
});

test('C contract forces a handoff at one hundred percent without spending another model request', {timeout: 20000}, async () => {
  await contractFixture(() => ({text: 'Token budget exhausted before submitting.', tokens: 100}), async fixture => {
    const result = await runAgentStation(fixture.definition, {...fixture.context, agentBudget: {maxTokens: 100, maxMs: 900000}});
    assert.equal(result.ok, false);
    assert.equal(fixture.requests.length, 1);
    assert.equal(result.agentContract?.ending, 'forced_handoff');
    assert.equal(result.agentContract?.actualTokens, 100);
    assert.deepEqual(result.handoff?.remaining, fixture.context.node.accept);
    assert.equal(result.failure, undefined);
    assert.ok(result.sessionCheckpoint?.pi);
  });
});

test('C contract keeps a validated submit when its final usage receipt crosses the budget', {timeout: 20000}, async () => {
  await contractFixture(() => ({...submitContract(), tokens: 125}), async fixture => {
    const result = await runAgentStation(fixture.definition, {...fixture.context, agentBudget: {maxTokens: 100, maxMs: 900000}});
    assert.equal(result.ok, true, 'a checked, received submit must not be replaced by a late forced handoff');
    assert.equal(result.agentContract?.ending, 'submit');
    assert.equal(result.agentContract?.actualTokens, 125, 'actual cost remains reported without pretending it stayed under budget');
    assert.equal(result.handoff, undefined);
    assert.equal(fixture.requests.length, 1, 'no follow-up model call or paid retry is permitted');
  });
});

test('a reused reviewer session receives changed screenshots without needing a direct redo note', {timeout: 20000}, async () => {
  await contractFixture(() => submitContract(), async fixture => {
    const file = path.join(fixture.dir, 'current-shot.ppm');
    fs.writeFileSync(file, Buffer.concat([Buffer.from('P6\n4 6\n255\n'), Buffer.alloc(4 * 6 * 3, 50)]));
    const definition = {...fixture.definition, input: () => ({text: 'Review the current screenshot.', images: [{file, label: 'current proof'}]})};
    const first = await runAgentStation(definition, fixture.context);
    assert.equal(first.ok, true);
    fs.writeFileSync(file, Buffer.concat([Buffer.from('P6\n4 6\n255\n'), Buffer.alloc(4 * 6 * 3, 220)]));
    const second = await runAgentStation(definition, {...fixture.context, attempt: 'new-screenshot-review',
      token: {...fixture.context.token, data: {...fixture.context.token.data, ...first.data}}});
    assert.equal(second.ok, true);
    const latestUser = (fixture.requests[1].messages as {role: string; content: unknown}[]).findLast(message => message.role === 'user');
    assert.ok(Array.isArray(latestUser?.content), 'new review inputs must carry the new pixels despite a restored session');
    const pixels = (latestUser.content as {type: string; image_url?: {url: string}}[]).find(part => part.type === 'image_url');
    assert.match(pixels?.image_url?.url ?? '', /^data:image\/jpeg;base64,/);
    const old = (fixture.requests[0].messages as {role: string; content: unknown}[]).findLast(message => message.role === 'user');
    assert.notDeepEqual(latestUser.content, old?.content, 'the changed file cannot reuse the old pixel payload');
  });
});

test('C contract rejects an oversized handoff field within the same model conversation', {timeout: 20000}, async () => {
  await contractFixture(index => index === 1 ? {tool: {name: 'handoff', arguments: {
    done: ['x'.repeat(501)], evidence: [], remaining: ['verify score'], suggestion: 'Continue.',
  }}} : submitContract(), async fixture => {
    const result = await runAgentStation(fixture.definition, fixture.context);
    assert.equal(result.ok, true, result.error ?? 'Expected accepted submission');
    assert.equal(fixture.requests.length, 2);
    const messages = fixture.requests[1].messages as {role: string; content: unknown}[];
    assert.ok(messages.some(message => message.role === 'tool' && /500|maxLength|length/i.test(JSON.stringify(message.content))));
    assert.equal(result.handoff, undefined);
    assert.equal(result.agentContract?.ending, 'submit');
  });
});

test('C contract redo preserves history and reason while a changed role starts with a bounded submit summary', {timeout: 20000}, async () => {
  const previousNote = `prior-submit-summary-start-${'x'.repeat(2400)}-prior-submit-summary-tail`;
  await contractFixture(() => ({tool: {name: 'submit', arguments: {score: 2, note: previousNote}}}), async fixture => {
    const first = await runAgentStation(fixture.definition, fixture.context);
    assert.equal(first.ok, true, first.error ?? 'Expected initial submission');
    assert.ok(first.sessionCheckpoint?.pi);
    const firstSaved = JSON.parse(fs.readFileSync(path.join(fixture.dir, first.sessionCheckpoint.pi.file), 'utf8'));
    assert.equal(firstSaved.submitSummary.length, 2000);
    const redo = {...fixture.context, attempt: 'attempt-redo', token: {...fixture.context.token, data: first.data!},
      session: first.sessionCheckpoint.pi, redo: {reason: 'review found a missing citation', note: 'Keep the observed source.', byHuman: false}};
    const second = await runAgentStation(fixture.definition, redo);
    assert.equal(second.ok, true, second.error ?? 'Expected corrected submission');
    assert.equal(second.sessionCheckpoint?.pi?.signature, first.sessionCheckpoint.pi.signature);
    const resumed = JSON.stringify(fixture.requests[1]);
    assert.ok(resumed.includes('prior-submit-summary-tail'), 'unchanged role receives the complete earlier conversation');
    assert.ok(resumed.includes('审查退回：review found a missing citation\\nKeep the observed source.'));
    assert.ok(resumed.includes('contract-original-input-marker'));
    const third = await runAgentStation({...fixture.definition, role: {...fixture.definition.role!, revision: 'contract-role-v2'}}, redo);
    assert.equal(third.ok, true, third.error ?? 'Expected submission under changed role');
    assert.notEqual(third.sessionCheckpoint?.pi?.signature, first.sessionCheckpoint.pi.signature);
    const restarted = JSON.stringify(fixture.requests[2]);
    assert.ok(restarted.includes('prior-submit-summary-start-'));
    assert.ok(!restarted.includes('prior-submit-summary-tail'), 'changed role may receive only the bounded prior submission summary');
    const messages = fixture.requests[2].messages as {role: string}[];
    assert.equal(messages.filter(message => message.role === 'assistant').length, 0, 'old assistant/tool history cannot cross a role signature change');
  });
});

test('C contract default and explicit budgets retain the minimum time and measured token policy', async () => {
  const definition = {system: 'budget fixture', schema: Type.Object({}), input: () => ({text: ''}), after: () => ({ok: true, summary: ''})};
  const context = nativeContext('budget-policy');
  assert.deepEqual(stationBudget(definition, context), {maxTokens: 60000, maxMs: 900000});
  assert.deepEqual(stationBudget(definition, {...context, agentBudget: {maxTokens: 123, maxMs: 1}}), {maxTokens: 123, maxMs: 180000});
  const journal = new Journal(':memory:');
  const store = new KernelStore(journal);
  const measured = {...definition, services: {journal, docs: () => {throw new Error('Budget lookup must not read docs');},
    toolbox: () => {throw new Error('Budget lookup must not call tools');}}};
  const save = (index: number, tokens: number, status: 'ok' | 'failed' = 'ok', node = context.node.key) => {
    journal.atomic(() => store.saveAttempt({id: `budget-${index}`, item: 'budget-fixture', node,
      startedAt: index, endedAt: index + 1, status,
      body: {metrics: {tokenUsage: {input: tokens / 2, output: tokens / 4, cacheRead: tokens / 8, cacheWrite: tokens / 8}}}}));
  };
  try {
    for (let index = 1; index <= 9; index++) save(index, 100);
    assert.equal(stationBudget(measured, context).maxTokens, 60000, 'nine successes cannot establish the median budget');
    save(10, 1000);
    assert.equal(stationBudget(measured, context).maxTokens, 500, 'the tenth success enables the complete-usage median, including cache');
    for (let index = 1; index <= 50; index++) save(index + 10, index);
    save(61, 999999, 'failed');
    save(62, 999999, 'ok', 'other/station');
    assert.equal(stationBudget(measured, context).maxTokens, 128, 'only the latest fifty successes of this station determine the rounded median times five');
  } finally {
    journal.close();
  }
});

test('explicit station bindings override compatibility defaults without sharing mutable commands', () => {
  const keys = ['FACTORY_STATION_COMMAND', 'FACTORY_STATION_MODEL', 'FACTORY_STATION_ADAPTER', 'FACTORY_STATION_TIMEOUT_MS', 'PATH'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.FACTORY_STATION_COMMAND = 'invalid default JSON';
    process.env.FACTORY_STATION_MODEL = 'wrong-default';
    process.env.FACTORY_STATION_ADAPTER = 'wrong-default';
    process.env.FACTORY_STATION_TIMEOUT_MS = 'invalid';
    assert.equal(closedAgentConfig('unused', undefined, { adapter: 'pi' }), null);
    for (const adapter of ['launcher', 'claude-code'] as const) {
      const binding = { adapter, command: ['fixture', '--bounded'], model: 'selected-model' };
      const config = closedAgentConfig('unused', undefined, binding)!;
      binding.command.push('changed-after-selection');
      assert.equal(config.adapter, adapter); assert.equal(config.model, 'selected-model');
      assert.equal(config.requestTimeoutMs, 180000); assert.deepEqual(config.command, ['fixture', '--bounded']);
    }
    for (const adapter of ['claude-code', 'opencode', 'codex'] as const) {
      const config = closedAgentConfig('unused', undefined, {adapter, command: ['fixture-only-no-native-process']})!;
      assert.equal(config.model, undefined, 'native defaults never inherit FACTORY_STATION_MODEL');
    }
    process.env.PATH = '';
    for (const adapter of ['claude-code', 'opencode', 'codex'] as const) {
      assert.throws(() => closedAgentConfig('unused', undefined, {adapter}), /未找到本机/);
    }
    assert.equal(process.env.FACTORY_STATION_COMMAND, 'invalid default JSON');
  } finally {
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('Pi and Claude bindings run concurrently, cancel independently and isolate provider session signatures', { timeout: 20000 }, async () => {
  await nativeFixture(async (dir, reads) => {
    const keys = ['PI_CODING_AGENT_DIR', 'FACTORY_PROVIDER', 'FACTORY_MODEL'];
    const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.FACTORY_PROVIDER = 'unselected-global-provider';
    process.env.FACTORY_MODEL = 'unselected-global-model';
    process.env.FACTORY_STATION_COMMAND = 'invalid global launcher JSON';
    const requests: { provider: string; body: Record<string, unknown> }[] = [];
    let holdProbe = false, probeArrived: (() => void) | undefined;
    let enterInput!: () => void, releaseInput!: () => void, enterPi!: () => void, releasePi!: () => void;
    const preparing = new Promise<void>(resolve => { enterInput = resolve; });
    const inputReady = new Promise<void>(resolve => { releaseInput = resolve; });
    const piEntered = new Promise<void>(resolve => { enterPi = resolve; });
    const piReady = new Promise<void>(resolve => { releasePi = resolve; });
    const server = http.createServer(async (request, response) => {
      const provider = request.url?.startsWith('/a/') ? 'a' : 'b';
      assert.equal(request.headers.authorization, `Bearer local-binding-${provider}-secret`);
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      requests.push({ provider, body });
      if (holdProbe && !body.tools) { probeArrived?.(); return; }
      if (JSON.stringify(body).includes('token=pi-held;')) { enterPi(); await piReady; }
      if (response.destroyed) return;
      if (JSON.stringify(body).includes('token=pi-redact;')) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Invalid API key: local-binding-b-secret' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = body.tools
        ? { role: 'assistant', tool_calls: [{ index: 0, id: `binding-${requests.length}`, type: 'function', function: { name: 'submit', arguments: '{"score":7}' } }] }
        : { role: 'assistant', content: 'OK' };
      for (const part of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: body.tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
      ]) response.write(`data: ${JSON.stringify({ id: 'binding-fixture', model: 'shared-model', ...part })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ defaultProvider: 'a', defaultModel: 'shared-model' }));
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(Object.fromEntries(['a', 'b'].map(provider => [provider, { type: 'api_key', key: `local-binding-${provider}-secret` }]))));
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: Object.fromEntries(['a', 'b'].map(provider => [provider, {
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/${provider}/v1`, models: [{ id: 'shared-model', input: ['text'], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
    }])) }));
    const definition: AgentStationDef<{ score: number }> = {
      system: 'Return the requested fixture score', schema: Type.Object({ score: Type.Integer() }), tools: ['fetch_text'],
      input: () => ({ text: 'Per-station configuration fixture' }), after: output => ({ ok: true, summary: 'done', data: output }),
    };
    const binding: StationAgentBinding = { adapter: 'pi', provider: 'a', model: 'shared-model' };
    const controller = new AbortController();
    let checkpoint: StationResult['sessionCheckpoint'];
    try {
      const selected = { provider: 'b', model: 'shared-model' };
      assert.equal(models(selected).model.provider, 'b'); assert.equal(piStatus(selected).ready, true);
      assert.equal(piStatus(selected).source, 'explicit');
      assert.equal(redactModelError('failure local-binding-b-secret', selected), 'failure [redacted]');
      const piTask = runAgentStation({ ...definition, agent: binding, input: async () => {
        enterInput(); await inputReady; return { text: 'Per-station configuration fixture' };
      } }, { ...nativeContext('pi-held'), signal: controller.signal });
      const cancelled = assert.rejects(piTask, error => {
        const partial = error as Error & StationResult;
        assert.equal(partial.name, 'AbortError'); checkpoint = partial.sessionCheckpoint;
        return true;
      });
      await preparing;
      binding.provider = 'unselected-mutated-provider'; binding.model = 'unselected-mutated-model';
      releaseInput(); await piEntered;
      const claudeTask = runAgentStation({ ...definition, agent: { adapter: 'claude-code', command: [process.execPath, '-e', claudeFixture, '--'], model: 'explicit-claude', requestTimeoutMs: 10000 } }, nativeContext('claude-parallel'));
      const deadline = Date.now() + 5000;
      while (!reads() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(reads(), 1);
      controller.abort(); releasePi(); await cancelled;
      const closed = await claudeTask;
      assert.equal(closed.ok, true, closed.error ?? 'Explicit Claude station failed');
      assert.deepEqual(closed.metrics?.execution, { adapter: 'claude-code', model: 'fixture-actual-claude' });
      assert.equal(closed.usage?.cost, .1);
      assert.ok(checkpoint?.pi, 'cancelled Pi work retains its own transcript reference');
      const recovered = await runAgentStation({ ...definition, agent: { adapter: 'pi', ...selected } }, nativeContext('pi-other-provider', { stationSessions: { 'curation/reader': checkpoint.pi } }));
      assert.equal(recovered.ok, true, recovered.error ?? 'Selected Pi station failed');
      assert.deepEqual(recovered.metrics?.execution, { adapter: 'pi', model: 'shared-model', provider: 'b' });
      assert.equal(recovered.usage?.input, 20); assert.equal(recovered.usage?.output, 8);
      const last = requests.at(-1)!;
      assert.equal(last.provider, 'b'); assert.equal(last.body.model, 'shared-model');
      assert.match(JSON.stringify(last.body), /token=pi-other-provider;/);
      assert.ok(!JSON.stringify(last.body).includes('token=pi-held;'), 'same model ID on another provider must not resume the old conversation');
      assert.equal((await probeModelConnection(2000, selected)).ok, true);
      assert.equal(requests.at(-1)?.provider, 'b');
      holdProbe = true;
      const probeEntered = new Promise<void>(resolve => { probeArrived = resolve; });
      const probeOwner = new AbortController();
      const probing = probeModelConnection(5000, selected, probeOwner.signal);
      const probeStopped = assert.rejects(probing, error => error === probeOwner.signal.reason);
      await probeEntered; probeOwner.abort(new Error('Fixture probe cancelled by its owner')); await probeStopped;
      holdProbe = false;
      assert.equal((await probeModelConnection(2000, selected)).ok, true, 'cancelled probes release the model request slot');
      const failed = await runAgentStation({ ...definition, agent: { adapter: 'pi', ...selected } }, nativeContext('pi-redact'));
      assert.equal(failed.failure?.tag, 'model_unavailable');
      assert.ok(!JSON.stringify(failed).includes('local-binding-b-secret'));
      assert.match(failed.error ?? '', /\[redacted\]/);
      assert.equal(process.env.FACTORY_PROVIDER, 'unselected-global-provider');
      assert.equal(process.env.FACTORY_STATION_COMMAND, 'invalid global launcher JSON');
    } finally {
      controller.abort(); releaseInput(); releasePi();
      await closeModelTransport(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
});

test('closed station references are isolated by the selected model, command and adapter', { timeout: 15000 }, async () => {
  await nativeFixture(async (dir, reads) => {
    const binding = { adapter: 'claude-code', command: [process.execPath, '-e', claudeFixture, '--'], model: 'binding-model', requestTimeoutMs: 10000 } satisfies StationAgentBinding;
    const definition: AgentStationDef<{ score: number }> = { agent: binding, system: 'Configuration signature fixture', schema: Type.Object({ score: Type.Integer() }), tools: ['fetch_text'],
      input: () => ({ text: 'native-restart' }), after: output => ({ ok: true, summary: 'done', data: output }) };
    const first = await runAgentStation(definition, nativeContext('binding-original'));
    assert.equal(first.failure?.tag, 'model_transport');
    const reference = (first.data!.closedStationSessions as Record<string, ClaudeSessionReference>)['curation/reader'];
    const resumed = await runAgentStation(definition, nativeContext('binding-same', first.data));
    assert.equal(resumed.ok, true); assert.equal(reads(), 1);
    for (const [index, changed] of [
      { ...binding, model: 'other-selected-model' },
      { ...binding, command: [...binding.command, '--fixture-binding', 'different-command'] },
    ].entries()) {
      const result = await runAgentStation({ ...definition, agent: changed }, nativeContext(`binding-changed-${index}`, first.data));
      assert.equal(result.failure?.tag, 'model_transport');
      const changedReference = (result.data!.closedStationSessions as Record<string, ClaudeSessionReference>)['curation/reader'];
      assert.notEqual(changedReference.id, reference.id);
    }
    assert.equal(reads(), 3);
    const legacy = String.raw`
const fs = require('node:fs'); let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  const request = JSON.parse(input);
  const connection = JSON.parse(fs.readFileSync(request.mcpServers.h2_station.env.EASY_WORKFLOW_STATION_CONNECTION, 'utf8'));
  const response = await fetch(connection.url + '/call', { method: 'POST', headers: { authorization: 'Bearer ' + connection.token, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'submit', arguments: { score: 7 } }) });
  if (!response.ok) process.exit(1);
  process.stdout.write(JSON.stringify({ model: 'actual-legacy-binding', usage: { input: 11, output: 3, cost: .002 } }));
});`;
    const result = await runAgentStation({ ...definition, agent: { adapter: 'launcher', command: [process.execPath, '-e', legacy], model: binding.model } }, nativeContext('binding-legacy', first.data));
    assert.equal(result.ok, true, result.error ?? 'Explicit legacy launcher failed');
    assert.deepEqual(result.metrics?.execution, { adapter: 'closed-command', model: 'actual-legacy-binding' });
    assert.equal(result.usage?.cost, .002);
    assert.equal(result.sessionCheckpoint?.closed, undefined, 'a launcher cannot adopt a Claude native session');
    assert.ok(result.sessionCheckpoint?.pi);
    assert.notEqual(result.sessionCheckpoint.pi.signature, reference.signature);
    assert.ok(fs.existsSync(path.join(dir, result.sessionCheckpoint.pi.file)));
  });
});

test('legacy Pi checkpoints migrate only with verified receipt identity and never repeat an observed tool', { timeout: 20000 }, async () => {
  await nativeFixture(async (dir, reads) => {
    const previousDirectory = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    const requests: Record<string, unknown>[] = [];
    let mode = 'capture';
    let waiting: (() => void) | undefined;
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      requests.push(body);
      const observed = JSON.stringify(body).includes('Persisted fixture observation');
      if (mode !== 'complete' && observed) { waiting?.(); return; }
      const call = mode === 'capture' ? { name: 'env_call', arguments: '{"name":"fetch_text","arguments":{"url":"https://fixture.invalid/source"}}' }
        : { name: 'submit', arguments: '{"score":7}' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const part of [
        { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `legacy-${requests.length}`, type: 'function', function: call }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
      ]) response.write(`data: ${JSON.stringify({ id: 'legacy-fixture', model: 'legacy-model', ...part })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ a: { type: 'api_key', key: 'local-legacy-a' }, b: { type: 'api_key', key: 'local-legacy-b' } }));
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: Object.fromEntries(['a', 'b'].map(provider => [provider, {
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/${provider}/v1`, models: [{ id: 'legacy-model', input: ['text'] }],
    }])) }));
    const definition: AgentStationDef<{ score: number }> = {
      agent: { adapter: 'pi', provider: 'a', model: 'legacy-model' },
      role: { station: 'curation/reader', path: 'fixture/ROLE.md', revision: 'legacy-fixture-role', content: 'Read the fixture then submit.' },
      system: 'Legacy session fixture', schema: Type.Object({ score: Type.Integer() }), tools: ['fetch_text'],
      input: () => ({ text: 'Preserve the observed fixture tool result.' }), after: output => ({ ok: true, summary: 'done', data: output }),
    };
    const cancelAfterObservation = async (token: string, data: Record<string, unknown> = {}) => {
      let entered!: () => void;
      const observed = new Promise<void>(resolve => { entered = resolve; }); waiting = entered;
      const controller = new AbortController();
      let reference: SessionRef | undefined;
      const task = runAgentStation(definition, { ...nativeContext(token, data), signal: controller.signal });
      const cancelled = assert.rejects(task, error => {
        const partial = error as Error & StationResult;
        assert.equal(partial.name, 'AbortError'); reference = partial.sessionCheckpoint?.pi; return true;
      });
      await observed; controller.abort(); await cancelled;
      assert.ok(reference); return reference;
    };
    try {
      const current = await cancelAfterObservation('legacy-original');
      assert.equal(reads(), 1);
      const file = path.join(dir, current.file);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { signature: string; messages: Record<string, unknown>[] };
      assert.ok(saved.messages.some(message => message.role === 'assistant' && message.provider === 'a' && message.model === 'legacy-model'), 'the genuine Pi transcript supplies identity evidence');
      const legacySignature = sessionSignature({ node: 'curation/reader', model: 'legacy-model', role: definition.role!.revision,
        contract: definition.system, schema: definition.schema, input: 'Preserve the observed fixture tool result.', images: undefined });
      const legacy = { file: current.file, signature: legacySignature };
      fs.writeFileSync(file, JSON.stringify({ ...saved, signature: legacySignature }));
      const legacyData = { stationSessions: { 'curation/reader': legacy } };
      mode = 'migrate';
      const migrated = await cancelAfterObservation('legacy-migrating', legacyData);
      assert.equal(reads(), 1, 'verified migration must not repeat the completed fetch');
      assert.equal(migrated.signature, current.signature, 'the next save writes the new execution identity');
      mode = 'complete';
      const finished = await runAgentStation(definition, nativeContext('legacy-complete', { stationSessions: { 'curation/reader': migrated } }));
      assert.equal(finished.ok, true); assert.equal(reads(), 1);
      assert.ok(finished.sessionCheckpoint?.pi);
      assert.equal(finished.sessionCheckpoint.pi.signature, migrated.signature);
      assert.deepEqual((finished.data?.stationSessions as Record<string, SessionRef>)['curation/reader'], finished.sessionCheckpoint.pi);
      assert.ok(fs.existsSync(path.join(dir, finished.sessionCheckpoint.pi.file)));
      const changed = await runAgentStation({ ...definition, agent: { adapter: 'pi', provider: 'b', model: 'legacy-model' } }, nativeContext('legacy-other-provider', legacyData));
      assert.equal(changed.ok, true);
      assert.match(JSON.stringify(requests.at(-1)), /token=legacy-other-provider;/);
      assert.ok(!JSON.stringify(requests.at(-1)).includes('Persisted fixture observation'));
      for (const message of saved.messages) if (message.role === 'assistant') delete message.provider;
      fs.writeFileSync(file, JSON.stringify({ ...saved, signature: legacySignature }));
      const unverified = await runAgentStation(definition, nativeContext('legacy-no-identity', legacyData));
      assert.equal(unverified.ok, true);
      assert.match(JSON.stringify(requests.at(-1)), /token=legacy-no-identity;/);
      assert.ok(!JSON.stringify(requests.at(-1)).includes('Persisted fixture observation'));
      let selected = {provider: 'a', model: 'legacy-model'};
      definition.piControl = {
        resolve: current => current.model.provider === selected.provider ? current : models(selected),
        list: () => ['a', 'b'].map(provider => ({provider, model: 'legacy-model', name: provider, input: ['text']})),
        select: next => {selected = next;},
      };
      mode = 'capture';
      const live = await cancelAfterObservation('live-model-original');
      assert.equal(reads(), 2);
      selected = {provider: 'b', model: 'legacy-model'};
      definition.agent = {adapter: 'pi', ...selected};
      mode = 'complete';
      const switched = await runAgentStation(definition,
        nativeContext('live-model-retry', {stationSessions: {'curation/reader': live}}));
      assert.equal(switched.ok, true);
      assert.equal(reads(), 2, 'a controlled Pi model change resumes the completed tool result');
      assert.equal(switched.metrics?.execution?.provider, 'b');
      assert.ok(JSON.stringify(requests.at(-1)).includes('Persisted fixture observation'));
      const other = nativeContext('different-node', {stationSessions: {'curation/facts': live}});
      other.node = {...other.node, key: 'curation/facts'};
      assert.equal((await runAgentStation(definition, other)).ok, true);
      assert.ok(!JSON.stringify(requests.at(-1)).includes('Persisted fixture observation'),
        'a model-independent signature still rejects another station context');
    } finally {
      await closeModelTransport(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDirectory;
    }
  });
});

test('Claude protocol adapter uses only station tools and sums each CLI process cost without fabricated timing', { timeout: 30000 }, async () => {
  await nativeFixture(async (_dir, reads) => {
    const result = await runAgentStation({ system: 'Fixture contract', schema: Type.Object({ score: Type.Integer() }), tools: ['fetch_text'], input: () => ({ text: 'native-repair' }),
      check: (out: { score: number }) => out.score === 1 ? [] : ['Use score 1'], after: () => ({ ok: true, summary: 'Fixture done' }) }, nativeContext('repair'));
    assert.equal(result.ok, true, result.error ?? 'Native protocol fixture should complete'); assert.equal(reads(), 1);
    assert.deepEqual(result.metrics?.execution, { adapter: 'claude-code', model: 'fixture-actual-claude' });
    assert.equal(result.usage?.input, 200); assert.ok(Math.abs(result.usage!.cost - .15) < 1e-12);
    assert.equal(result.metrics?.time?.modelCalls, 2, 'multiple content blocks from one message are one API call');
    assert.equal(result.metrics?.modelTimeReported, false); assert.equal(result.metrics?.activity?.modelTiming, 'unavailable');
  });
});

test('Claude station failures preserve signed sessions, read evidence and tool budget across a new token', { timeout: 30000 }, async () => {
  await nativeFixture(async (dir, reads) => {
    const definition = { system: 'Fixture resume contract', schema: Type.Object({ score: Type.Integer() }), tools: ['fetch_text'], input: () => ({ text: 'native-restart' }), after: () => {
      assert.ok(readEvidence().some(evidence => evidence.url === 'https://fixture.invalid/source' && evidence.text === 'Persisted fixture observation'));
      return { ok: true, summary: 'Recovered from saved observations' };
    } };
    const first = await runAgentStation(definition, nativeContext('initial'));
    assert.equal(first.ok, false); assert.equal(first.failure?.tag, 'model_transport'); assert.match(first.error ?? '', /provider connection/); assert.ok(!JSON.stringify(first).includes('fixture-only secret'));
    const reference = (first.data!.closedStationSessions as Record<string, ClaudeSessionReference>)['curation/reader'];
    assert.equal(reference.context?.calls, 1); assert.equal(reference.context?.evidence.length, 1);
    assert.equal(reference.workDirectory, 'work/initial');
    const local = new ClosedStationAgent({ ...closedAgentConfig(path.join(dir, 'work', 'initial'), { projectDirectory: dir, workDirectory: path.join(dir, 'work') })! }, 'Fixture', [], () => {});
    local.configureSession('curation/reader', reference.signature);
    assert.equal(local.sessionReference()?.id, reference.id, 'a hard restart can find the last local checkpoint');
    local.configureSession('curation/reader', 'changed-input'); assert.equal(local.sessionReference(), undefined);
    const second = await runAgentStation(definition, nativeContext('retry', first.data));
    assert.equal(second.ok, true, second.error ?? 'Saved station should resume'); assert.equal(reads(), 1);
    assert.ok(Math.abs(second.usage!.cost - .05) < 1e-12);
    const retained = (second.data?.closedStationSessions as Record<string, ClaudeSessionReference>)['curation/reader'];
    assert.equal(retained.id, reference.id);
    assert.equal(retained.signature, reference.signature);
    assert.deepEqual(second.sessionCheckpoint?.closed, retained);
    assert.ok(second.sessionCheckpoint?.pi);
    assert.ok(fs.existsSync(path.join(dir, second.sessionCheckpoint.pi.file)));
  });
});

test('cancelling image preparation preserves a restored Claude checkpoint without a new model charge', { timeout: 15000 }, async t => {
  await nativeFixture(async (dir, reads) => {
    const image = path.join(dir, 'fixture.ppm');
    fs.writeFileSync(image, Buffer.concat([Buffer.from('P6\n4 6\n255\n'), Buffer.alloc(4 * 6 * 3, 128)]));
    const definition = { system: 'Fixture image contract', schema: Type.Object({ score: Type.Integer() }), tools: ['fetch_text'],
      input: () => ({ text: 'native-restart', images: [{ file: image, label: 'fixture image' }] }), after: () => ({ ok: true, summary: 'done' }) };
    const first = await runAgentStation(definition, nativeContext('image-original'));
    assert.equal(first.failure?.tag, 'model_transport', first.error ?? 'Expected the fixture provider interruption');
    const reference = (first.data!.closedStationSessions as Record<string, ClaudeSessionReference>)['curation/reader'];
    let entered!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const convert = t.mock.method(EvidenceStore, 'jpegAsync', async (_file: string, _width?: number, options?: ImageProcessOptions) => {
      assert.ok(options?.signal);
      assert.ok(readEvidence().some(evidence => evidence.text === 'Persisted fixture observation'));
      entered();
      await new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
      return Buffer.alloc(0);
    });
    try {
      const controller = new AbortController();
      const pending = runAgentStation(definition, { ...nativeContext('image-retry', first.data), signal: controller.signal });
      const rejected = assert.rejects(pending, error => {
        const partial = error as Error & StationResult;
        assert.equal(partial.name, 'AbortError');
        assert.equal(partial.sessionCheckpoint?.closed?.id, reference.id);
        assert.equal(partial.sessionCheckpoint?.closed?.context?.calls, 1);
        assert.equal(partial.usage, undefined);
        assert.equal(partial.metrics?.time?.modelCalls, 0);
        return true;
      });
      await preparing; controller.abort(); await rejected;
      assert.equal(reads(), 1); assert.equal(first.usage?.cost, .1);
    } finally { convert.mock.restore(); }
  });
});

test('closed session working directories require explicit project ownership and reject path or junction escapes', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-session-path-'));
  const work = path.join(project, 'work');
  const original = path.join(work, 'original');
  const current = path.join(work, 'current');
  const outside = path.join(project, 'outside-work');
  fs.mkdirSync(original, { recursive: true }); fs.mkdirSync(current); fs.mkdirSync(outside);
  const config = { command: [process.execPath], model: 'fixture', adapter: 'claude-code' as const, cwd: current, sessionScope: { projectDirectory: project, workDirectory: work } };
  const reference: ClaudeSessionReference = { version: 1, adapter: 'claude-code', id: '11111111-1111-4111-8111-111111111111', signature: 'fixture', model: 'fixture', workDirectory: 'work/original' };
  const agent = new ClosedStationAgent(config, 'Fixture', [], () => {});
  try {
    agent.configureSession('fixture/station', 'fixture', reference);
    assert.equal(agent.sessionReference()?.id, reference.id);
    for (const directory of ['../outside-work', 'outside-work', original, 'work/../outside-work', 'work/missing']) {
      agent.configureSession('fixture/station', 'fixture', { ...reference, workDirectory: directory });
      assert.equal(agent.sessionReference(), undefined, directory);
    }
    const link = path.join(work, 'linked');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    agent.configureSession('fixture/station', 'fixture', { ...reference, workDirectory: 'work/linked' });
    assert.equal(agent.sessionReference(), undefined);
    const escaped = new ClosedStationAgent({ ...config, cwd: path.join(link, 'child') }, 'Fixture', [], () => {});
    assert.throws(() => escaped.configureSession('fixture/station', 'fixture'), /without symbolic links/);
    const unscoped = new ClosedStationAgent({ ...config, sessionScope: undefined }, 'Fixture', [], () => {});
    unscoped.configureSession('fixture/station', 'fixture', reference);
    assert.equal(unscoped.sessionReference(), undefined, 'an external relative path has no authority without an explicit root');
    fs.symlinkSync(outside, path.join(current, 'closed-sessions'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => agent.configureSession('fixture/station', 'fixture'), /without symbolic links/);
  } finally {
    assert.equal(path.dirname(path.resolve(project)), path.resolve(os.tmpdir()));
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('Claude stream rejects foreign capabilities and never subtracts another CLI process cost', async () => {
  let saved!: ClaudeSessionReference;
  const protocol = new ClaudeCodeProtocol('requested', 'signature', undefined, reference => { saved = reference; });
  const init = { type: 'system', subtype: 'init', session_id: protocol.id, model: 'actual', tools: ['mcp__h2_station__submit'], mcp_servers: [{ name: 'h2_station', status: 'connected' }] };
  assert.throws(() => protocol.accept(JSON.stringify({ ...init, tools: ['Bash'] })), /outside.*scope/);
  assert.throws(() => protocol.accept(JSON.stringify({ ...init, tools: [], mcp_servers: [{ name: 'h2_station', status: 'pending' }] })), /required.*submit tool/);
  protocol.accept(JSON.stringify(init));
  protocol.accept(JSON.stringify({ type: 'result', subtype: 'success', session_id: protocol.id, total_cost_usd: 2, usage: { input_tokens: 10, output_tokens: 5 } }));
  assert.equal(protocol.finish().usage?.cost, 2);
  const resumed = new ClaudeCodeProtocol('requested', 'signature', saved, () => {});
  resumed.accept(JSON.stringify({ ...init, session_id: resumed.id }));
  resumed.accept(JSON.stringify({ type: 'result', subtype: 'success', session_id: resumed.id, total_cost_usd: 1, usage: { input_tokens: 10, output_tokens: 5 } }));
  assert.equal(resumed.finish().usage?.cost, 1, 'a resumed CLI process reports its own spend');
  const failed = new ClaudeCodeProtocol('requested', 'signature', saved, reference => { saved = reference; });
  failed.accept(JSON.stringify({ ...init, session_id: failed.id }));
  failed.accept(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: failed.id, errors: ['ECONNRESET'], total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } }));
  const failure = failed.finish();
  assert.equal(failure.failure?.tag, 'model_transport'); assert.equal(failure.usage?.cost, 0);
  assert.equal(failure.failure?.code, 'CLAUDE_ERROR_DURING_EXECUTION');
  assert.equal('totalCostUsd' in saved, false, 'a session reference is not a cost baseline');
  const canary = 'CLAUDE_PRIVATE_CANARY';
  const unknown = new ClaudeCodeProtocol('requested', 'signature', undefined, () => {});
  unknown.accept(JSON.stringify({...init, session_id: unknown.id}));
  unknown.accept(JSON.stringify({type: 'result', subtype: canary, is_error: true, session_id: unknown.id, errors: [canary]}));
  assert.equal(unknown.finish().failure?.code, 'CLAUDE_EXECUTION_ERROR');
  assert.equal(JSON.stringify(unknown.finish()).includes(canary), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-claude-invalid-tail-'));
  try {
    // The local Node fixture deliberately closes stdout without a newline. This
    // exercises the close handler, not its separately protected streaming path.
    const malformed = new ClosedStationAgent({adapter: 'claude-code', model: 'fixture', cwd: dir,
      command: [process.execPath, '-e', `process.stdout.write('${canary}')`, '--'], requestTimeoutMs: 1000},
    'Fixture only', [], () => {throw new Error('Malformed output must never produce a receipt');});
    await assert.rejects(malformed.prompt('Fixture'), error => {
      assert.match(String(error), /invalid JSON stream message/);
      assert.equal(String(error).includes(canary.slice(0, 8)), false);
      return true;
    });
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('recorded native CLI receipts sum to the measured cost of two resumed processes', () => {
  let saved!: ClaudeSessionReference;
  // Only public protocol fields and measured counters are retained from the
  // isolated live acceptance. No user directory, credential or transcript text.
  const receipts = [
    { input_tokens: 2780, output_tokens: 407, total_cost_usd: 0.004815 },
    { input_tokens: 4005, output_tokens: 262, total_cost_usd: 0.005315 },
  ];
  let total = 0;
  for (const [index, receipt] of receipts.entries()) {
    const protocol = new ClaudeCodeProtocol('haiku', 'recorded-cli-contract', index ? saved : undefined, reference => { saved = reference; });
    protocol.accept(JSON.stringify({ type: 'system', subtype: 'init', session_id: protocol.id,
      model: 'claude-haiku-4-5-20251001', tools: ['mcp__h2_station__submit'], mcp_servers: [{ name: 'h2_station', status: 'connected' }] }));
    protocol.accept(JSON.stringify({ type: 'result', subtype: 'success', session_id: protocol.id,
      total_cost_usd: receipt.total_cost_usd, usage: { input_tokens: receipt.input_tokens, output_tokens: receipt.output_tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));
    const result = protocol.finish();
    assert.equal(result.usage?.cost, receipt.total_cost_usd);
    total += result.usage!.cost;
  }
  assert.ok(Math.abs(total - 0.01013) < 1e-12);
});

test('document envelopes bind stable project, role and trial policy without hashing rolling history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-envelope-policy-'));
  const compiled = compile([]), state = initialState(compiled), journal = new Journal(':memory:');
  const role = { station: 'dispatcher', path: 'fixture/ROLE.md', revision: 'fixture-v1', content: 'Fixture role' };
  const docs = new Docs({ compiled, state, journal, runtime: { roleResolver: () => role } }, dir, 'Fixture');
  let history = 'Before work', trial = 'Trial one';
  docs.contextBrief = () => history;
  docs.caseBrief = () => 'Case history';
  docs.setLessons({ pendingContext: () => '', validationContext: () => trial });
  fs.writeFileSync(path.join(dir, 'PROJECT.md'), 'Project instructions');
  const envelope = (tools = ['read', 'submit']) => docs.envelope('dispatcher', 'fixture-item', tools, { token: 'fixture-token', attempt: 'fixture-attempt' });
  try {
    const first = envelope();
    history = 'A completed attempt was appended';
    const later = envelope(['submit', 'read']);
    assert.notEqual(first.text, later.text); assert.equal(first.sessionPolicy, later.sessionPolicy);
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), 'Changed project instruction');
    assert.notEqual(first.sessionPolicy, envelope().sessionPolicy);
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), 'Project instructions');
    role.content = 'Changed role'; assert.notEqual(first.sessionPolicy, envelope().sessionPolicy);
    role.content = 'Fixture role'; trial = 'Different validation rule';
    assert.notEqual(first.sessionPolicy, envelope().sessionPolicy);
    trial = 'Trial one'; assert.notEqual(first.sessionPolicy, envelope(['submit']).sessionPolicy);
  } finally {
    journal.close(); assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resumed Claude sessions accept fresh running history but invalidate changed project policy and capabilities', { timeout: 30000 }, async () => {
  await nativeFixture(async (_dir, reads, envelope) => {
    const definition = { system: 'Fixture contract', schema: Type.Object({ score: Type.Integer() }), tools: ['fetch_text'], input: () => ({ text: 'native-restart' }), after: () => ({ ok: true, summary: 'done' }) };
    const first = await runAgentStation(definition, nativeContext('policy-initial'));
    assert.equal(first.failure?.tag, 'model_transport');
    const references = first.data!.closedStationSessions as Record<string, ClaudeSessionReference>;
    envelope.text += '\nA new attempt is recorded in the rolling case history.';
    const resumed = await runAgentStation(definition, nativeContext('policy-history', first.data));
    assert.equal(resumed.ok, true); assert.equal(reads(), 1);
    envelope.sessionPolicy = 'changed-project-instructions';
    const changed = await runAgentStation(definition, nativeContext('policy-changed', first.data));
    assert.equal(changed.ok, false); assert.equal(reads(), 2);
    assert.notEqual((changed.data!.closedStationSessions as Record<string, ClaudeSessionReference>)['curation/reader'].id, references['curation/reader'].id);
    envelope.sessionPolicy = 'fixture-policy-one';
    const restricted = await runAgentStation({ ...definition, tools: [...definition.tools, 'fixture-extra-capability'] }, nativeContext('policy-tools', first.data));
    assert.equal(restricted.ok, false); assert.equal(reads(), 3);
  });
});

test('runtime cancellation journals only host session metadata and resumes it in a new token', { timeout: 30000 }, async () => {
  await nativeFixture(async (dir, reads) => {
    const pack: Pack = {
      id: 'adapter-runtime', name: 'Adapter runtime', blurb: 'Fixture', version: '1', resources: { model: 1, browser: 0, http: 0, cpu: 0 },
      lines: [line({ id: 'curation', name: 'Fixture', layer: 3, priority: 'mid', wired: true, blurb: 'Fixture',
        stations: [station({ id: 'reader', name: 'Fixture station', kind: 'agent', role: 'process', accept: ['A structured score exists'] }), station({ id: 'published', name: 'Finished', kind: 'store', role: 'store' })], edges: [['reader', 'published']] })],
      channels: [], links: [], conditions: {}, order: ['curation'], collapsed: [], hints: {},
    };
    const compiled = compile([pack]); assert.deepEqual(compiled.issues, []);
    const journal = new Journal(':memory:');
    const state = initialState(compiled); journal.subscribeProjection(event => apply(state, event));
    const definition = { system: 'Fixture cancellation contract', schema: Type.Object({ score: Type.Integer() }), tools: ['fetch_text'], input: () => ({ text: 'native-cancel' }), after: () => ({ ok: true, summary: 'resumed', data: { accepted: true } }) };
    const runtime = new Runtime(compiled, journal, new Broker({ model: 1 }, 0), {}, () => ctx => runAgentStation(definition, ctx));
    runtime.roleResolver = key => ({ station: key, path: `fixture/${key}`, revision: 'fixture', content: 'Complete the fixture contract.' });
    runtime.ensureWorkers([]); runtime.start('cancel fixture');
    try {
      const token = runtime.create('curation/reader', { item: 'cancelled-item', url: '', source: 'fixture' });
      const deadline = Date.now() + 10000;
      while (!reads() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(reads(), 1);
      runtime.end(); await runtime.settle();
      const patch = [...journal.read()].findLast(event => event.kind === 'token.data' && event.token === token.id && event.patch.closedStationSessions);
      assert.equal(patch?.kind, 'token.data', 'end() must durably transport the host reference out of the cancelled attempt');
      const reference = (token.data.closedStationSessions as Record<string, ClaudeSessionReference>)['curation/reader'];
      assert.equal(reference.context?.calls, 1); assert.equal(token.data.accepted, undefined);
      runtime.start('resume fixture');
      const retry = runtime.create('curation/reader', { item: token.item, url: '', source: 'fixture', data: structuredClone(token.data) });
      await runtime.settle();
      assert.equal(state.tokens[retry.id].status, 'published'); assert.equal(reads(), 1);
      assert.equal(retry.data.accepted, true);
      const retained = (retry.data.closedStationSessions as Record<string, ClaudeSessionReference>)['curation/reader'];
      assert.equal(retained.id, reference.id);
      assert.equal(retained.signature, reference.signature);
      const transcript = (retry.data.stationSessions as Record<string, SessionRef>)['curation/reader'];
      assert.ok(transcript && fs.existsSync(path.join(dir, transcript.file)), 'publication retains the completed conversation for a later correction');

      for (const changedEpoch of [false, true]) {
        let started!: () => void;
        const running = new Promise<void>(resolve => { started = resolve; });
        runtime.executors = () => async ctx => {
          started();
          await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
          return { ok: true, summary: 'obsolete output', data: { forbiddenBusinessData: true }, sessionCheckpoint: { closed: reference } } satisfies StationResult;
        };
        const obsolete = runtime.create('curation/reader', { item: `obsolete-${changedEpoch}`, url: '', source: 'fixture' });
        await running;
        if (changedEpoch) obsolete.nodeEpochs = new Map([['curation/reader', 1]]);
        runtime.end(); await runtime.settle();
        assert.equal(obsolete.data.forbiddenBusinessData, undefined);
        assert.equal(!!obsolete.data.closedStationSessions, !changedEpoch, 'correction epochs invalidate old session metadata too');
        runtime.start('next fixture');
      }
    } finally { await runtime.close(); journal.close(); }
  });
});

test('closed agents obey model admission before opening a scope or launching a vendor process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-launcher-admission-'));
  const receipt = path.join(dir, 'request.json');
  const code = `let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(receipt)},input);process.stdout.write(JSON.stringify({model:'actual-fixture-model',modelCalls:1}));});`;
  try {
    for (const adapter of ['launcher', 'claude-code'] as const) {
      const agent = new ClosedStationAgent({adapter, command: [process.execPath, '-e', code, '--'],
        model: 'fixture-requested', cwd: dir}, 'Fixture envelope', [], () => {});
      await assert.rejects(withModelAdmission(() => 'Another task owns the model trial',
        () => agent.prompt('Blocked input')), /MODEL_CIRCUIT_OPEN/);
      assert.equal(fs.existsSync(receipt), false, 'blocked work must never start the vendor process');
      if (adapter === 'launcher') {
        await withModelAdmission(() => null, () => agent.prompt('Allowed input'));
        const request = JSON.parse(fs.readFileSync(receipt, 'utf8'));
        assert.equal(request.messages.length, 1, 'a refused request must not enter the resumed conversation');
        assert.match(request.firstMessage.content[0].text, /Allowed input/);
        assert.doesNotMatch(request.firstMessage.content[0].text, /Blocked input/);
        fs.unlinkSync(receipt);
      }
    }
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('easy-workflow-launcher-admission-'));
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('structured launcher failures preserve category and timeout stops a silent vendor process', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-launcher-errors-'));
  try {
    for (const [type, tag] of [['credentials', 'model_unavailable'], ['quota', 'model_unavailable'], ['tls', 'model_unavailable'], ['transport', 'model_transport']] as const) {
      const code = `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({error:{type:${JSON.stringify(type)}}}));process.exitCode=1;});`;
      const agent = new ClosedStationAgent({ command: [process.execPath, '-e', code], model: 'requested', cwd: dir }, 'Fixture', [], () => assert.fail('No model receipt was reported'));
      await assert.rejects(agent.prompt('input'), error => (error as { failure?: { tag?: string } }).failure?.tag === tag);
    }
    const timeoutPid = path.join(dir, 'timeout.pid');
    const silentCode = `require('node:fs').writeFileSync(${JSON.stringify(timeoutPid)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000);`;
    const silent = new ClosedStationAgent({ command: [process.execPath, '-e', silentCode], model: 'requested', cwd: dir, requestTimeoutMs: 500 }, 'Fixture', [], () => assert.fail('Timed-out work must not report success'));
    await assert.rejects(silent.prompt('input'), /timed out/);
    const pid = Number(fs.readFileSync(timeoutPid, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'timeout must await child exit before returning to a directory cleanup caller');
    const abortPid = path.join(dir, 'abort.pid');
    const abortCode = `require('node:fs').writeFileSync(${JSON.stringify(abortPid)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000);`;
    const cancellable = new ClosedStationAgent({ command: [process.execPath, '-e', abortCode], model: 'requested', cwd: dir, requestTimeoutMs: 5000 }, 'Fixture', [], () => assert.fail('Cancelled work must not report success'));
    const cancelled = assert.rejects(cancellable.prompt('input'), /cancelled/);
    const deadline = Date.now() + 4000;
    while (!fs.existsSync(abortPid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    const cancelledPid = Number(fs.readFileSync(abortPid, 'utf8'));
    cancellable.abort(); await cancelled;
    assert.throws(() => process.kill(cancelledPid, 0), { code: 'ESRCH' }, 'owner cancellation also waits for child close');
  } finally { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('OpenCode native receipts preserve harness defaults, scoped MCP and resumed tool results', {timeout: 15000}, async () => {
  const {spawn, execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const executeFile = promisify(execFile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-opencode-protocol-'));
  const file = path.join(dir, 'opencode-fixture.mjs');
  fs.writeFileSync(file, String.raw`import fs from 'node:fs'; import assert from 'node:assert/strict';
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const stored = './native-session.json';
if (args[0] === 'debug') {
  console.log(JSON.stringify({model:'native-provider/default-model',small_model:'native-provider/small',provider:{'native-provider':{options:{baseURL:'https://fixture.invalid'}}},
    mcp:{foreign:{type:'local',command:['must-not-launch']}},plugin:['must-not-load']}));
} else if (args[0] === 'export') {
  assert.equal(args[1], 'ses_fixtureOwned'); assert.ok(args.includes('--sanitize'));
  console.log(fs.readFileSync(stored,'utf8'));
} else {
  assert.equal(args[0],'run'); assert.equal(value('--format'),'json'); assert.ok(args.includes('--pure'));
  assert.equal(args.includes('--model'), false, 'native model selection must not inherit Pi defaults');
  const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
  const selected=config.enabled_providers?.[0]??'native-provider';
  if(selected==='provider-b'){
    const merged={model:'native-provider/default-model',small_model:'native-provider/small',...config};
    assert.equal(merged.model,'');assert.equal(merged.small_model,'');
    assert.ok(Object.hasOwn(merged.provider,'provider-b'));
    assert.equal(merged.provider['native-provider'].options.baseURL,'https://fixture.invalid');
  }else assert.equal(config.model,'native-provider/default-model');
  assert.equal(config.mcp.foreign.enabled,false);
  assert.equal(config.permission['*'],'deny');
  assert.equal(config.permission.h2_station_submit,'allow');
  assert.equal(process.env.OPENCODE_PURE,'1');
  let text='';for await(const chunk of process.stdin)text+=chunk;
  assert.match(text,/fixture station/);
  const old=fs.existsSync(stored)?JSON.parse(fs.readFileSync(stored,'utf8')):{info:{id:'ses_fixtureOwned'},messages:[]};
  const turn=old.messages.length+1;
  assert.equal(args.includes('--session'),turn>1);
  if(turn>1)assert.equal(value('--session'),'ses_fixtureOwned');
  const sessionID='ses_fixtureOwned',messageID='msg_turn'+turn;
  const emit=(type,part)=>console.log(JSON.stringify({type,sessionID,...(part?{part}:{} )}));
  emit('step_start',{id:'prt_start'+turn,sessionID,messageID,type:'step-start'});
  if(text.includes('fixture stall')){fs.writeFileSync('./native-pid.txt',String(process.pid));await new Promise(()=>setInterval(()=>{},1000));}
  const connection=JSON.parse(fs.readFileSync(config.mcp.h2_station.environment.EASY_WORKFLOW_STATION_CONNECTION,'utf8'));
  const call=async(name,arguments_)=>fetch(connection.url+'/call',{method:'POST',headers:{authorization:'Bearer '+connection.token,'content-type':'application/json'},body:JSON.stringify({name,arguments:arguments_})});
  assert.equal((await call('set_caps',{})).status,403);
  const tool=turn===1?'env_call':'submit';
  const response=await call(tool,turn===1?{name:'fixture_read'}:{score:7});assert.equal(response.status,200);await response.text();
  emit('tool_use',{id:'prt_tool'+turn,sessionID,messageID,type:'tool',tool:'h2_station_'+tool,state:{status:'completed'}});
  const step={id:'prt_step'+turn,sessionID,messageID,type:'step-finish',reason:turn===1?'tool-calls':'stop',
    cost:turn*.001,tokens:{input:turn*10,output:5,reasoning:2,cache:{read:turn,write:0}}};
  old.messages.push({info:{id:messageID,sessionID,role:'assistant',providerID:selected,modelID:selected==='provider-b'?'provider-b-native-default':'actual-native-model'},parts:[step]});
  fs.writeFileSync(stored,JSON.stringify(old));emit('step_finish',step);
  if(turn===1){console.log(JSON.stringify({type:'error',sessionID,error:{name:'APIError',data:{message:'ECONNRESET fixture'}}}));process.exitCode=1;}
}`);
  const command = [process.execPath, file];
  let reads = 0;
  let submitted = 0;
  let reference: OpenCodeSessionReference | undefined;
  const request = {role: 'user' as const, content: [{type: 'text' as const, text: 'Complete this fixture station.'}]};
  const executeCommand = async (description: NonNullable<ReturnType<OpenCodeProtocol['receiptCommand']>>) => {
    const result = await executeFile(description.argv[0], description.argv.slice(1), {cwd: dir,
      env: {...process.env, ...description.env}, windowsHide: true, encoding: 'utf8',
      timeout: description.timeoutMs, maxBuffer: description.maxBufferBytes});
    return JSON.parse(result.stdout) as unknown;
  };
  try {
    for (const turn of [1, 2]) {
      const protocol = new OpenCodeProtocol({}, 'station-signature', reference, saved => { reference = saved; });
      protocol.acceptConfiguration(await executeCommand(protocol.configurationCommand(command)));
      const owner = new AbortController();
      const scope = await openStationMcp([
        {name: 'env_call', label: 'Read fixture', description: 'Read fixture evidence', parameters: Type.Object({name: Type.Literal('fixture_read')}),
          execute: async () => { reads++; return {content: [{type: 'text', text: 'Previously paid-for fixture observation'}]}; }},
        {name: 'submit', label: 'Submit', description: 'Submit fixture', parameters: Type.Object({score: Type.Integer()}),
          execute: async (_id, output) => { assert.equal(output.score, 7); submitted++; return {content: [{type: 'text', text: 'received'}]}; }},
      ], owner.signal);
      try {
        await protocol.prepareInput(request, dir);
        const argv = protocol.argv(command);
        const child = spawn(argv[0], argv.slice(1), {cwd: dir, env: {...process.env,
          ...protocol.environment({h2_station: scope.config})}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
        let output = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.resume();
        child.stdin.end(protocol.input(request));
        const code = await new Promise(resolve => child.once('close', resolve));
        assert.equal(code, turn === 1 ? 1 : 0);
        for (const event of output.trim().split(/\r?\n/)) protocol.accept(event);
        assert.ok(reference);
        assert.equal(validOpenCodeSession(reference, {}, 'station-signature'), true);
        protocol.acceptReceipt(await executeCommand(protocol.receiptCommand(command)!));
        const result = protocol.finish();
        assert.equal(result.provider, 'native-provider');
        assert.equal(result.model, 'actual-native-model');
        assert.equal(result.modelCalls, 1);
        assert.equal(result.usage?.input, turn * 10);
        assert.equal(result.usage?.cost, turn * .001, 'resuming must not charge the old step a second time');
        assert.equal(result.failure?.tag, turn === 1 ? 'model_transport' : undefined);
        assert.throws(() => process.kill(child.pid!, 0), {code: 'ESRCH'});
      } finally {
        await scope.close();
        protocol.disposeInput();
        assert.equal(fs.existsSync(scope.config.env.EASY_WORKFLOW_STATION_CONNECTION), false);
      }
    }
    assert.equal(reads, 1, 'the native resumed session reuses its completed observation');
    assert.equal(submitted, 1);
    const unknown = new OpenCodeProtocol({}, 'unknown', undefined, () => {});
    assert.throws(() => unknown.finish(), /verified actual model receipt/);
    assert.throws(() => unknown.accept('malformed private-credential-fragment'), error => {
      assert.doesNotMatch(String(error), /private-credential-fragment/);
      return true;
    });
    assert.throws(() => unknown.environment({}), /configuration must be inspected/);
    assert.throws(() => unknown.accept(JSON.stringify({type: 'tool_use', sessionID: 'ses_scope', part: {
      sessionID: 'ses_scope', messageID: 'msg_scope', tool: 'bash',
    }})), /outside this station scope/);
    assert.equal(validOpenCodeSession(reference, {provider: 'different'}, 'station-signature'), false);
    assert.throws(() => new OpenCodeProtocol({model: 'providerless'}, 'fixture', undefined, () => {}), /provider\/model/);
    const selected = new OpenCodeProtocol({provider: 'native-provider', model: 'override'}, 'selected', undefined, () => {});
    assert.ok(selected.argv(command).includes('native-provider/override'));
    await selected.prepareInput({role: 'user', content: [{type: 'image', data: Buffer.from('fixture image bytes').toString('base64'), mimeType: 'image/jpeg'}]}, dir);
    const selectedArgv = selected.argv(command);
    const image = selectedArgv[selectedArgv.indexOf('--file') + 1];
    assert.equal(fs.existsSync(image), true);
    selected.disposeInput();
    assert.equal(fs.existsSync(image), false);
    reads = 0;
    submitted = 0;
    let reply: import('../server/mcp-station.ts').ClosedAgentReply | undefined;
    const work = path.join(dir, 'work');
    const tools = [
      {name: 'env_call', label: 'Read fixture', description: 'Read fixture evidence', parameters: Type.Object({name: Type.Literal('fixture_read')}),
        execute: async () => {reads++; return {content: [{type: 'text' as const, text: 'retained observation'}]};}},
      {name: 'submit', label: 'Submit', description: 'Submit fixture', parameters: Type.Object({score: Type.Integer()}),
        execute: async () => {submitted++; return {content: [{type: 'text' as const, text: 'received'}]};}},
    ];
    const native = (token: string, requestTimeoutMs = 5000) => new ClosedStationAgent({adapter: 'opencode', command,
      cwd: path.join(work, token), sessionScope: {projectDirectory: dir, workDirectory: work}, requestTimeoutMs},
    'Complete only this fixture station.', tools, result => {reply = result;});
    const first = native('first');
    first.configureSession('fixture/reader', 'native-runner', undefined, () => ({calls: reads, evidence: []}));
    await assert.rejects(first.prompt('Complete the fixture station.'), /provider connection failed/);
    const checkpoint = first.sessionReference();
    assert.ok(checkpoint);
    assert.equal(checkpoint.adapter, 'opencode');
    assert.equal(checkpoint.context?.calls, 1);
    const resumed = native('next-token');
    resumed.configureSession('fixture/reader', 'native-runner', checkpoint, () => ({calls: reads, evidence: []}));
    await resumed.prompt('Complete the fixture station.');
    assert.equal(reads, 1);
    assert.equal(submitted, 1);
    assert.equal(reply?.model, 'actual-native-model');
    assert.equal(reply?.provider, 'native-provider');
    assert.equal(reply?.usage?.cost, .002);
    assert.equal(reply?.costReported, true);
    assert.equal(resumed.sessionReference()?.id, checkpoint.id);
    const providerOnly = new ClosedStationAgent({adapter: 'opencode', command, provider: 'provider-b',
      cwd: path.join(work, 'provider-only'), sessionScope: {projectDirectory: dir, workDirectory: work}, requestTimeoutMs: 5000},
    'Complete only this fixture station.', tools, result => {reply = result;});
    providerOnly.configureSession('fixture/reader', 'native-provider-only');
    await assert.rejects(providerOnly.prompt('Complete the fixture station.'), /provider connection failed/);
    assert.equal(reply?.provider, 'provider-b');
    assert.equal(reply?.model, 'provider-b-native-default');
    const stalled = native('cancelled');
    stalled.configureSession('fixture/reader', 'native-cancel');
    const aborted = assert.rejects(stalled.prompt('fixture station; fixture stall'), /abort/i);
    const pidFile = path.join(work, 'cancelled', 'native-pid.txt');
    while (!fs.existsSync(pidFile)) await new Promise(resolve => setTimeout(resolve, 10));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    stalled.abort();
    await aborted;
    assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'}, 'OpenCode cancellation waits for the actual child exit');
    assert.equal(fs.existsSync(path.join(work, 'cancelled', 'native-session.json')), false, 'cancelled runs do not launch receipt export');
    const timed = native('timed-out', 1200);
    timed.configureSession('fixture/reader', 'native-timeout');
    await assert.rejects(timed.prompt('fixture station; fixture stall'), /timed out/);
    const timedPid = Number(fs.readFileSync(path.join(work, 'timed-out', 'native-pid.txt'), 'utf8'));
    assert.throws(() => process.kill(timedPid, 0), {code: 'ESRCH'}, 'the whole native deadline waits for child exit');
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
  }
});

test('Codex app-server preserves native defaults and scoped tool observations across resumed turns', {timeout: 15000}, async () => {
  const {spawn} = await import('node:child_process');
  const {createInterface} = await import('node:readline');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-codex-protocol-'));
  const file = path.join(dir, 'codex-fixture.mjs');
  fs.writeFileSync(file, String.raw`import fs from 'node:fs';import assert from 'node:assert/strict';import {createInterface} from 'node:readline';
assert.deepEqual(process.argv.slice(2),['app-server','--listen','stdio://']);
const send=value=>console.log(JSON.stringify(value));
const stateFile='./native-thread.json';
let state,turn;
const done=status=>{
  state.total+=21;fs.writeFileSync(stateFile,JSON.stringify(state));
  send({method:'thread/tokenUsage/updated',params:{threadId:state.id,turnId:turn,tokenUsage:{total:{inputTokens:state.total,outputTokens:state.turn*3,cachedInputTokens:state.turn*2,cacheWriteInputTokens:0,reasoningOutputTokens:state.turn},last:{}}}});
  send({method:'turn/completed',params:{threadId:state.id,turn:{id:turn,status,...(status==='failed'?{error:{message:'ECONNRESET fixture'}}:{})}}});
};
for await(const line of createInterface({input:process.stdin})){
  const event=JSON.parse(line),p=event.params;
  if(event.method==='initialize'){
    assert.equal(p.capabilities.experimentalApi,true);send({id:event.id,result:{userAgent:'fixture'}});
  }else if(event.method==='initialized'){
  }else if(event.method==='config/read'){
    assert.equal(p.cwd,process.cwd());send({id:event.id,result:{config:{model:'native-only',mcp_servers:{'foreign.with.dot':{}},plugins:{foreign:{enabled:true}}}}});
  }else if(event.method==='thread/start'||event.method==='thread/resume'){
    assert.equal(Object.hasOwn(p,'model'),false);assert.equal(Object.hasOwn(p,'modelProvider'),false);
    assert.equal(p.approvalPolicy,'never');assert.equal(p.sandbox,'read-only');
    assert.equal(p.config.web_search,'disabled');assert.equal(p.config['features.shell_tool'],false);
    assert.equal(p.config['features.unified_exec'],false);assert.equal(p.config['features.code_mode'],false);
    assert.equal(p.config['mcp_servers."foreign.with.dot".enabled'],false);
    assert.equal(p.config['plugins."foreign".enabled'],false);
    assert.equal(p.config['features.plugins'],false);assert.equal(p.config['features.skip_host_skill_discovery'],true);
    if(event.method==='thread/start'){
      state={id:'thread_fixture',turn:0,total:0,read:false,tools:p.dynamicTools};
      assert.deepEqual(p.dynamicTools.map(t=>t.name),['env_call','submit']);
      assert.ok(p.dynamicTools.every(t=>t.type==='function'&&t.inputSchema.type==='object'));
    }else{
      state=JSON.parse(fs.readFileSync(stateFile,'utf8'));assert.equal(p.threadId,state.id);
      assert.equal(p.excludeTurns,true);assert.equal(p.dynamicTools,undefined);assert.equal(state.read,true);
    }
    send({id:event.id,result:{thread:{id:state.id},cwd:process.cwd(),model:'actual-native-codex',modelProvider:'actual-native-provider',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false}}});
  }else if(event.method==='turn/start'){
    state.turn++;turn='turn_'+state.turn;
    assert.equal(p.threadId,state.id);assert.deepEqual(p.sandboxPolicy,{type:'readOnly',networkAccess:false});
    assert.match(p.input[0].text,/fixture station/);assert.deepEqual(p.input[0].text_elements,[]);
    send({id:event.id,result:{turn:{id:turn,status:'inProgress'}}});
    send({method:'turn/started',params:{threadId:state.id,turn:{id:turn,status:'inProgress'}}});
    if(p.input[0].text.includes('fixture stall')){fs.writeFileSync('./native-pid.txt',String(process.pid));continue;}
    send({id:state.read?'server-submit':'server-read',method:'item/tool/call',params:{threadId:state.id,turnId:turn,callId:state.read?'call_submit':'call_read',namespace:null,tool:state.read?'submit':'env_call',arguments:state.read?{score:7}:{name:'fixture_read'}}});
  }else if(event.id==='server-read'){
    assert.equal(event.result.success,true);assert.match(event.result.contentItems[0].text,/retained observation/);
    send({id:'server-read-again',method:'item/tool/call',params:{threadId:state.id,turnId:turn,callId:'call_read',namespace:null,tool:'env_call',arguments:{name:'fixture_read'}}});
  }else if(event.id==='server-read-again'){
    state.read=true;done('failed');
  }else if(event.id==='server-submit'){
    assert.equal(event.result.success,true);done('completed');
  }else if(event.method==='turn/interrupt'){
    assert.equal(p.threadId,state.id);assert.equal(p.turnId,turn);send({id:event.id,result:{}});done('interrupted');
  }else throw new Error('Unexpected fixture message');
}`);
  let reads = 0;
  let submissions = 0;
  let saved: CodexSessionReference | undefined;
  const definitions = [
    {name: 'env_call', label: 'Read fixture', description: 'Read fixture evidence', parameters: Type.Object({name: Type.Literal('fixture_read')}),
      execute: async () => { reads++; return {content: [{type: 'text' as const, text: 'retained observation'}]}; }},
    {name: 'submit', label: 'Submit', description: 'Submit fixture result', parameters: Type.Object({score: Type.Integer()}),
      execute: async (_id: string, value: {score: number}) => { assert.equal(value.score, 7); submissions++; return {content: [{type: 'text' as const, text: 'received'}]}; }},
  ];
  try {
    for (const turn of [1, 2]) {
      const controller = new AbortController();
      const scope = await openStationMcp(definitions, controller.signal);
      const connection = JSON.parse(fs.readFileSync(scope.config.env.EASY_WORKFLOW_STATION_CONNECTION, 'utf8'));
      const protocol = new CodexProtocol({selection: {}, signature: 'fixture-contract', previous: saved,
        checkpoint: reference => {saved = reference;}, cwd: dir, tools: definitions, signal: controller.signal});
      const command = protocol.argv([process.execPath, file]);
      const child = spawn(command[0], command.slice(1), {cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
      let failure: unknown;
      let pending = Promise.resolve();
      const lines = createInterface({input: child.stdout});
      const deadline = setTimeout(() => child.kill(), 5000);
      child.stderr.resume();
      const close = new Promise<number | null>(resolve => child.once('close', resolve));
      protocol.bind({send: line => {child.stdin.write(line);}, complete: () => child.stdin.end(),
        call: async (name, args, signal) => {
          const response = await fetch(connection.url + '/call', {method: 'POST', signal,
            headers: {authorization: `Bearer ${connection.token}`, 'content-type': 'application/json'},
            body: JSON.stringify({name, arguments: args})});
          assert.equal(response.status, 200);
          return await response.json();
        }});
      lines.on('line', line => {
        pending = pending.then(() => protocol.accept(line)).catch(error => {failure = error; child.kill();});
      });
      try {
        child.stdin.write(protocol.input({role: 'user', content: [{type: 'text', text: 'Complete the fixture station.'}]}));
        assert.equal(await close, 0);
        await pending;
        if (failure) throw failure;
        assert.ok(saved);
        assert.equal(validCodexSession(saved, {}, 'fixture-contract'), true);
        const receipt = protocol.finish();
        assert.equal(receipt.model, 'actual-native-codex');
        assert.equal(receipt.provider, 'actual-native-provider');
        assert.deepEqual(receipt.tokenUsage, {input: 21, output: 3, cacheRead: 2, cacheWrite: 0, reasoning: 1});
        assert.equal('usage' in receipt, false, 'native token receipts contain no dollar cost');
        assert.equal(receipt.failure?.tag, turn === 1 ? 'model_transport' : undefined);
        assert.throws(() => process.kill(child.pid!, 0), {code: 'ESRCH'});
        await assert.rejects(protocol.accept(JSON.stringify({id: 'foreign', method: 'item/tool/call', params: {
          threadId: saved.id, turnId: saved.turn, callId: 'foreign_call', tool: 'set_caps', namespace: null, arguments: {},
        }})), /outside this station scope/);
      } finally {
        clearTimeout(deadline);
        lines.close();
        child.kill();
        await close;
        await scope.close();
      }
    }
    assert.equal(reads, 1, 'a retransmitted call and a resumed native turn must not repeat completed tool work');
    assert.equal(submissions, 1);
    reads = 0;
    submissions = 0;
    const work = path.join(dir, 'work');
    let lastReply: import('../server/mcp-station.ts').ClosedAgentReply | undefined;
    const native = (token: string) => new ClosedStationAgent({adapter: 'codex', command: [process.execPath, file],
      cwd: path.join(work, token), sessionScope: {projectDirectory: dir, workDirectory: work}, requestTimeoutMs: 5000},
    'Execute only the fixture station.', definitions, reply => {lastReply = reply;});
    const first = native('first');
    first.configureSession('fixture/reader', 'runner-contract', undefined, () => ({calls: reads, evidence: []}));
    await assert.rejects(first.prompt('Complete the fixture station.'), /could not complete/);
    const checkpoint = first.sessionReference();
    assert.ok(checkpoint);
    assert.equal(checkpoint.adapter, 'codex');
    assert.equal(checkpoint.context?.calls, 1);
    const resumed = native('next-token');
    resumed.configureSession('fixture/reader', 'runner-contract', checkpoint, () => ({calls: reads, evidence: []}));
    await resumed.prompt('Complete the fixture station.');
    assert.equal(reads, 1);
    assert.equal(submissions, 1);
    assert.equal(lastReply?.model, 'actual-native-codex');
    assert.equal(lastReply?.provider, 'actual-native-provider');
    assert.equal(lastReply?.tokenUsage?.input, 21);
    assert.equal(lastReply?.usage, undefined);
    assert.equal(lastReply?.costReported, false);
    assert.equal(resumed.sessionReference()?.id, checkpoint.id);
    const stalled = native('cancelled');
    stalled.configureSession('fixture/reader', 'runner-cancel');
    const aborted = assert.rejects(stalled.prompt('fixture station; fixture stall'), /abort/i);
    const pidFile = path.join(work, 'cancelled', 'native-pid.txt');
    while (!fs.existsSync(pidFile)) await new Promise(resolve => setTimeout(resolve, 10));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    stalled.abort();
    await aborted;
    assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'}, 'Codex cancellation waits for the actual fixture process');
    assert.equal(validCodexSession(saved, {model: 'different'}, 'fixture-contract'), false);
    assert.equal(validCodexSession(saved, {}, 'different-role-or-tools'), false);
    const output: string[] = [];
    const owner = new AbortController();
    const unknown = new CodexProtocol({selection: {}, signature: 'unknown', cwd: dir, tools: definitions,
      signal: owner.signal, checkpoint: () => {}});
    unknown.bind({send: line => output.push(line), complete: () => {}, call: async () => {throw new Error('unexpected call');}});
    await assert.rejects(unknown.accept('malformed private-credential-fragment'), error => {
      assert.doesNotMatch(String(error), /private-credential-fragment/);
      return true;
    });
    const initialize = JSON.parse(unknown.input({role: 'user', content: [{type: 'text', text: 'fixture'}]}));
    await unknown.accept(JSON.stringify({id: initialize.id, result: {}}));
    await unknown.accept(JSON.stringify({id: JSON.parse(output.at(-1)!).id, result: {config: {}}}));
    await unknown.accept(JSON.stringify({id: JSON.parse(output.at(-1)!).id, result: {thread: {id: 'unknown_thread'}, cwd: dir,
      approvalPolicy: 'never', sandbox: {type: 'readOnly', networkAccess: false}}}));
    await unknown.accept(JSON.stringify({id: JSON.parse(output.at(-1)!).id, result: {turn: {id: 'unknown_turn'}}}));
    unknown.interrupt();
    assert.deepEqual(JSON.parse(output.at(-1)!).params, {threadId: 'unknown_thread', turnId: 'unknown_turn'});
    await unknown.accept(JSON.stringify({method: 'turn/completed', params: {threadId: 'unknown_thread', turn: {id: 'unknown_turn', status: 'completed'}}}));
    assert.deepEqual(unknown.finish(), {model: 'unknown'});
    owner.abort(new Error('owner cancelled'));
    await assert.rejects(unknown.accept('{}'), /owner cancelled/);
    const claude = new ClaudeCodeProtocol(undefined, 'native-default', undefined, () => {});
    const args = claude.argv(['fixture-only-no-native-process'], {h2_station: {}});
    assert.equal(args.includes('--model'), false);
    assert.equal(args[args.indexOf('--setting-sources') + 1], 'user');
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
  }
});

test('Factory captures native execution and applies Pi rebinding at the next provider request', {timeout: 30000}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-factory-binding-'));
  const keys = ['FACTORY_VAR', 'FACTORY_PREFLIGHT', 'FACTORY_START_PAUSED', 'FACTORY_RESUME_MANAGED',
    'FACTORY_HTTP_CACHE', 'VISLEXICON_ROOT', 'PI_CODING_AGENT_DIR', 'FACTORY_STATION_COMMAND'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile);
  process.env.FACTORY_VAR = dir;
  process.env.FACTORY_PREFLIGHT = '0';
  process.env.FACTORY_START_PAUSED = '1';
  process.env.FACTORY_RESUME_MANAGED = '0';
  process.env.FACTORY_HTTP_CACHE = '0';
  process.env.VISLEXICON_ROOT = path.join(dir, 'unconnected');
  process.env.PI_CODING_AGENT_DIR = profile;
  process.env.FACTORY_STATION_COMMAND = 'invalid unselected launcher default';
  const receipt = path.join(dir, 'launcher.jsonl');
  const launcher = path.join(dir, 'launcher.mjs');
  fs.writeFileSync(launcher, `import assert from 'node:assert/strict';
import fs from 'node:fs';
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
assert.match(request.firstMessage.content[0].text, /Captured fixture role/);
fs.appendFileSync(process.argv[3], JSON.stringify({command: process.argv[2], model: request.model}) + '\\n');
const connection = JSON.parse(fs.readFileSync(request.mcpServers.h2_station.env.EASY_WORKFLOW_STATION_CONNECTION, 'utf8'));
const response = await fetch(connection.url + '/call', {method: 'POST', headers: {
  authorization: 'Bearer ' + connection.token, 'content-type': 'application/json'},
  body: JSON.stringify({name: 'submit', arguments: {value: process.argv[2]}})});
assert.equal(response.status, 200);
process.stdout.write(JSON.stringify({model: 'reported-' + request.model, modelCalls: 1,
  usage: {input: 20, output: 5, cost: 0}}));`);
  const bindings = ['a', 'b'].map(name => ({adapter: 'launcher' as const,
    command: [process.execPath, launcher, name, receipt], model: `requested-${name}`}));
  const valueSchema = {type: 'object', properties: {value: {type: 'string'}},
    required: ['value'], additionalProperties: false};
  const manifest: WorkflowManifest = {
    format: 1, id: 'captured', name: 'Captured fixture', version: '1', blurb: 'Actual adapter capture',
    entry: 'captured/work', inputSchema: 'value', resources: {model: 1, browser: 0, cpu: 0, http: 0},
    lines: [line({id: 'captured', name: 'Captured fixture', layer: 3, priority: 'mid', wired: true,
      blurb: 'Actual adapter capture', stations: [
        station({id: 'work', name: 'Capture', kind: 'agent', role: 'process', resource: 'model',
          accept: ['Submit the exact fixture result'], workers: {min: 1, max: 1, initial: 1, policy: 'fixed'}}),
        station({id: 'published', name: 'Done', kind: 'store', role: 'store'}),
      ], edges: [['work', 'published']]})],
    channels: [], links: [], conditions: {}, schemas: {value: valueSchema},
    bindings: {'captured/work': {role: 'roles/work/ROLE.md', inputSchema: 'value', outputSchema: 'value',
      input: {value: {path: 'input.value'}}, outputKey: 'result', execute: {kind: 'agent',
        instructions: 'Return only the supplied fixture value.', agent: bindings[0]}}},
  };
  const requests: {path: string; model: string}[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {model: string};
    const name = request.url?.startsWith('/a/') ? 'a' : 'b';
    requests.push({path: request.url!, model: body.model});
    assert.equal(request.headers.authorization, `Bearer local-capture-${name}`);
    assert.match(Buffer.concat(chunks).toString(), /Captured fixture role/);
    response.writeHead(200, {'content-type': 'text/event-stream'});
    for (const part of [
      {choices: [{index: 0, delta: {role: 'assistant', tool_calls: [{index: 0, id: `capture-${requests.length}`,
        type: 'function', function: {name: 'submit', arguments: JSON.stringify({value: name})}}]}, finish_reason: null}]},
      {choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}],
        usage: {prompt_tokens: 20, completion_tokens: 5, total_tokens: 25}},
    ]) response.write(`data: ${JSON.stringify({id: 'capture', model: body.model, ...part})}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as {port: number}).port;
  const providerConfig = {providers: Object.fromEntries(['a', 'b'].map(name => [name, {
    api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/${name}/v1`,
    models: [{id: 'shared-model', input: ['text']}],
  }]))};
  fs.writeFileSync(path.join(profile, 'auth.json'), JSON.stringify(Object.fromEntries(['a', 'b']
    .map(name => [name, {type: 'api_key', key: `local-capture-${name}`}]))));
  fs.writeFileSync(path.join(profile, 'models.json'), JSON.stringify(providerConfig));
  await installWorkflowPack(dir, {manifest, files: {'roles/work/ROLE.md':
    '# Captured fixture role\n\nReturn only the supplied value through the submit contract. Use no external sources and do not invent additional evidence.'}, builtins: []}, {running: false});
  const {Factory} = await import('../server/factory.ts');
  const factory = new Factory();
  try {
    assert.equal(factory.project.dir, dir);
    await factory.boot();
    factory.broker.memoryFloorMB = 0;
    factory.runtime.start('Captured execution fixture');
    for (const adapter of ['launcher', 'pi'] as const) await t.test(adapter, async () => {
      const selected: StationAgentBinding[] = adapter === 'launcher' ? bindings
        : ['a', 'b'].map(provider => ({adapter: 'pi', provider, model: 'shared-model'}));
      if (adapter === 'launcher') {
        assert.equal(factory.agentBindings('captured/work').bindings[0].source, 'workflow');
      } else factory.setAgentBinding('captured/work', selected[0]);
      const identities = selected.map(binding => binding.adapter === 'pi'
        ? models(binding).dependency : closedModelDependency(binding));
      let changed = false;
      const unsubscribe = factory.journal.subscribe(event => {
        if (event.kind !== 'attempt.started' || event.node !== 'captured/work' || changed) return;
        changed = true;
        factory.setAgentBinding(event.node, selected[1]);
        if (adapter === 'pi') {
          providerConfig.providers.a.baseUrl = `http://127.0.0.1:${port}/changed-after-start/v1`;
          fs.writeFileSync(path.join(profile, 'models.json'), JSON.stringify(providerConfig));
        }
      });
      try {
        for (const [index, name] of ['a', 'b'].entries()) {
          const token = factory.runtime.create('captured/work', {item: `${adapter}-${name}`, url: '',
            source: 'manual', data: {workflowPack: manifest.id, input: {value: name}}});
          await factory.runtime.settle();
          assert.equal(factory.state.tokens[token.id].status, 'published');
          assert.deepEqual(token.data.result, {value: adapter === 'pi' ? 'b' : name});
          const attempt = factory.state.attempts[factory.state.tokens[token.id].attempts[0]];
          assert.deepEqual(attempt.dependency, identities[index]);
          assert.deepEqual(attempt.metrics?.dependency, identities[adapter === 'pi' ? 1 : index]);
          assert.equal(attempt.metrics?.execution?.model,
            adapter === 'launcher' ? `reported-requested-${name}` : 'shared-model');
          const durable = [...factory.journal.read()].find(event =>
            event.kind === 'attempt.started' && event.attempt === attempt.id);
          assert.ok(durable?.kind === 'attempt.started');
          assert.deepEqual(durable.dependency, identities[index]);
        }
      } finally {
        unsubscribe();
      }
    });
    assert.deepEqual(fs.readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
      [{command: 'a', model: 'requested-a'}, {command: 'b', model: 'requested-b'}]);
    assert.deepEqual(requests, [{path: '/b/v1/chat/completions', model: 'shared-model'},
      {path: '/b/v1/chat/completions', model: 'shared-model'}]);
    await t.test('an invalid live model selection does not blame the previously healthy provider', async () => {
      factory.setAgentBinding('captured/work', {adapter: 'pi', provider: 'a', model: 'shared-model'});
      const dependency = models({provider: 'a', model: 'shared-model'}).dependency;
      const unsubscribe = factory.journal.subscribe(event => {
        if (event.kind === 'attempt.started' && event.node === 'captured/work') {
          factory.setAgentBinding(event.node, {adapter: 'pi', provider: 'a', model: 'missing-model'});
        }
      });
      try {
        const token = factory.runtime.create('captured/work', {item: 'invalid-live-selection', url: '', source: 'manual',
          data: {workflowPack: manifest.id, input: {value: 'unchanged'}}});
        await factory.runtime.settle();
        assert.equal(factory.state.tokens[token.id].status, 'parked');
        assert.equal((token.data.failure as {code?: string}).code, 'INVALID_AGENT_BINDING');
        assert.equal(factory.state.modelCircuits[dependency.key], undefined);
        assert.equal(requests.length, 2, 'configuration rejection does not send a provider request');
      } finally {unsubscribe();}
    });
    await t.test('native defaults resolve once before observers can change PATH', async () => {
      const previousPath = process.env.PATH;
      const first = path.join(dir, 'first-native-bin');
      const later = path.join(dir, 'later-native-bin');
      fs.mkdirSync(first);
      fs.mkdirSync(later);
      const host = factory as unknown as {captureAgent: (node: string, declared?: StationAgentBinding) => {
        binding: StationAgentBinding; dependency: ModelDependency;
      }};
      try {
        for (const adapter of ['claude-code', 'opencode', 'codex'] as const) {
          const executable = (adapter === 'claude-code' ? 'claude' : adapter) + (process.platform === 'win32' ? '.exe' : '');
          // File lookup only: these are deliberately non-executable placeholders.
          // Never start a real vendor CLI while checking configuration capture.
          for (const directory of [first, later]) fs.writeFileSync(path.join(directory, executable), 'isolated resolution fixture');
          process.env.PATH = first;
          factory.setAgentBinding('captured/work', {adapter});
          assert.deepEqual(factory.state.agentBindings?.['captured/work'], {adapter}, 'persisted defaults remain declarative');
          const captured = host.captureAgent('captured/work');
          assert.notEqual(captured.binding.adapter, 'pi');
          if (captured.binding.adapter === 'pi') throw new Error('Native capture unexpectedly selected Pi');
          assert.deepEqual(captured.binding.command, [path.join(first, executable)]);
          process.env.PATH = later;
          const config = closedAgentConfig(path.join(dir, 'work', adapter),
            {projectDirectory: dir, workDirectory: path.join(dir, 'work')}, captured.binding)!;
          const actual = closedModelDependency({adapter, command: config.command, model: config.model, provider: config.provider});
          assert.deepEqual(actual, captured.dependency, 'scheduler capture and actual request guard share one resolved key');
          assert.deepEqual(config.command, captured.binding.command, 'later PATH changes do not redirect an in-flight attempt');
          assert.notEqual(host.captureAgent('captured/work').dependency.key, captured.dependency.key,
            'only a future capture can select the changed native executable');
        }
      } finally {
        if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      }
    });
    await t.test('deterministic skip survives an invalid captured model without reopening configuration', async () => {
      const {pack} = await import('../packs/vislexicon/pack.ts');
      const node = compile([pack]).nodes.find(node => node.key === 'curation/style')!;
      factory.journal.append({kind: 'agent.binding', node: node.key,
        binding: {adapter: 'pi', provider: 'missing-provider', model: 'missing-model'}});
      const registered = factory.runtime.executors(node);
      assert.ok(registered && typeof registered !== 'function');
      const prepared = registered.prepare();
      factory.journal.append({kind: 'agent.binding', node: node.key,
        binding: {adapter: 'pi', provider: 'b', model: 'shared-model'}});
      let skipped = 0;
      const context = {...nativeContext('deterministic-skip', {kind: 'component-source', mode: 'video'}),
        node, progress: () => { skipped++; }};
      const result = await prepared.execute(context);
      assert.equal(result.ok, true);
      assert.deepEqual(result.data?.style, {applicable: false});
      assert.equal(result.metrics, undefined);
      assert.equal(skipped, 1, 'the deterministic skip runs once');
      context.token.data.mode = 'screenshots';
      await assert.rejects(prepared.execute(context), /Pi 模型未配置：missing-provider\/missing-model/,
        'a non-skipped attempt must report its captured error instead of silently switching to the new binding');
      assert.equal(requests.length, 2);
    });
  } finally {
    factory.recovery?.close();
    await factory.sources?.close();
    factory.channels?.close();
    await factory.runtime?.close();
    factory.docs?.flush();
    factory.lessons?.close();
    factory.journal.close();
    await closeModelTransport();
    await closeNetwork();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
  }
});

test('project defaults, dispatcher turns and concurrent station contexts remain independent of the external Pi default', {timeout: 30000}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-project-models-'));
  const profile = path.join(directory, 'profile');
  fs.mkdirSync(profile);
  const keys = ['PI_CODING_AGENT_DIR', 'FACTORY_PROVIDER', 'FACTORY_MODEL', 'FACTORY_STATION_COMMAND',
    'FACTORY_PREFLIGHT', 'FACTORY_HTTP_CACHE', 'FACTORY_START_PAUSED', 'FACTORY_RESUME_MANAGED'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = profile;
  delete process.env.FACTORY_PROVIDER;
  delete process.env.FACTORY_MODEL;
  process.env.FACTORY_STATION_COMMAND = 'unselected external command must never start';
  process.env.FACTORY_PREFLIGHT = '0';
  process.env.FACTORY_HTTP_CACHE = '0';
  process.env.FACTORY_START_PAUSED = '1';
  process.env.FACTORY_RESUME_MANAGED = '0';
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const requests: {provider: string; body: string}[] = [];
  let active = 0;
  let peak = 0;
  let selfModelCalls = 0;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const body = JSON.parse(text) as {model: string; tools?: {function: {name: string}}[]; messages: {role: string}[]};
    const provider = request.url!.split('/')[1];
    requests.push({provider, body: text});
    active++;
    peak = Math.max(peak, active);
    await gate;
    const station = body.tools?.some(tool => tool.function.name === 'submit');
    const wroteNote = body.messages.some(message => message.role === 'tool');
    let delta = station ? {role: 'assistant', tool_calls: [{index: 0, id: `project-${requests.length}-${provider}`,
      type: 'function', function: wroteNote ? {name: 'submit', arguments: JSON.stringify({value: provider})}
        : {name: 'env_call', arguments: JSON.stringify({name: 'case_note', arguments: {section: 'fixture', text: `local-${provider}-note`}})}}]}
      : {role: 'assistant', content: `Dispatcher ${provider}`};
    if (station && text.includes('SELF_MODEL_SELECTION')) {
      const calls = [
        {name: 'station_model', arguments: JSON.stringify({action: 'select', provider: 'unconnected', model: 'fixture-model'})},
        {name: 'station_model', arguments: JSON.stringify({action: 'select', provider: 'b', model: 'fixture-model', node: 'independent/beta'})},
        {name: 'station_model', arguments: JSON.stringify({action: 'list'})},
        {name: 'station_model', arguments: JSON.stringify({action: 'select', provider: 'b', model: 'fixture-next-model'})},
        {name: 'submit', arguments: JSON.stringify({value: provider})},
      ];
      assert.ok(selfModelCalls < calls.length, 'the station model control must not loop');
      delta = {role: 'assistant', tool_calls: [{index: 0, id: `self-model-${selfModelCalls}`,
        type: 'function', function: calls[selfModelCalls++]}]};
    }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    for (const part of [
      {choices: [{index: 0, delta, finish_reason: null}]},
      {choices: [{index: 0, delta: {}, finish_reason: station ? 'tool_calls' : 'stop'}],
        usage: {prompt_tokens: 20, completion_tokens: 5, total_tokens: 25}},
    ]) response.write(`data: ${JSON.stringify({id: 'project-selection', model: body.model, ...part})}\n\n`);
    response.end('data: [DONE]\n\n');
    active--;
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as {port: number}).port;
  fs.writeFileSync(path.join(profile, 'auth.json'), JSON.stringify(Object.fromEntries(['a', 'b']
    .map(provider => [provider, {type: 'api_key', key: `fixture-project-${provider}`}]))));
  fs.writeFileSync(path.join(profile, 'models.json'), JSON.stringify({providers: Object.fromEntries(['a', 'b']
    .map(provider => [provider, {api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/${provider}/v1`,
      models: [{id: 'fixture-model', input: ['text']}, {id: 'fixture-next-model', input: ['text']}]}]))}));
  const selectExternal = (provider: string) => fs.writeFileSync(path.join(profile, 'settings.json'),
    JSON.stringify({defaultProvider: provider, defaultModel: 'fixture-model'}));
  const schema = {type: 'object', properties: {value: {type: 'string'}}, required: ['value'], additionalProperties: false};
  const manifest: WorkflowManifest = {
    format: 1, id: 'independent', name: 'Independent contexts', version: '1', blurb: 'Local model fixture',
    entry: 'independent/alpha', inputSchema: 'value', resources: {model: 4, browser: 0, cpu: 0, http: 0},
    lines: [line({id: 'independent', name: 'Independent contexts', layer: 3, priority: 'mid', wired: true,
      blurb: 'Concurrent contexts', stations: [
        ...['alpha', 'beta'].map(id => station({id, name: id, kind: 'agent', role: 'process', resource: 'model',
          accept: ['Write the own case note and submit the fixture value'],
          workers: {min: 2, max: 2, initial: 2, policy: 'fixed'}})),
        station({id: 'published', name: 'Done', kind: 'store', role: 'store'}),
      ], edges: [['alpha', 'published'], ['beta', 'published']]})],
    channels: [], links: [], conditions: {}, schemas: {value: schema},
    bindings: Object.fromEntries(['alpha', 'beta'].map(node => [`independent/${node}`, {
      role: `roles/${node}/ROLE.md`, inputSchema: 'value', outputSchema: 'value',
      input: {value: {path: 'input.value'}}, outputKey: 'result', execute: {kind: 'agent' as const,
        instructions: 'Keep this station input separate. Write one case note, then submit the fixture value.'},
    }])),
  };
  const {Factory} = await import('../server/factory.ts');
  const {Dispatcher} = await import('../server/dispatcher.ts');
  const factories: InstanceType<typeof Factory>[] = [];
  const sessions: {project: string; node: string; session: string; input: string}[] = [];
  type Captured = {binding: StationAgentBinding; piRuntime?: ReturnType<typeof models>; dependency: ModelDependency};
  const binding = (provider: string): StationAgentBinding => ({adapter: 'pi', provider, model: 'fixture-model'});
  try {
    for (const project of ['a', 'b']) {
      const root = path.join(directory, `project-${project}`);
      await installWorkflowPack(root, {manifest, builtins: [], files: Object.fromEntries(['alpha', 'beta']
        .map(node => [`roles/${node}/ROLE.md`, `# ${node} isolated role\n\nUse only this station's input, write its case note, and submit the exact fixture value.`]))}, {running: false});
      selectExternal(project);
      const factory = new Factory(root);
      factories.push(factory);
      await factory.boot();
      fs.writeFileSync(path.join(root, 'PROJECT.md'), `# Private project ${project}\n\nPROJECT_${project.toUpperCase()}_ONLY`);
      factory.broker.memoryFloorMB = 0;
      factory.broker.limits.model = 4;
      assert.deepEqual(factory.getAgentDefaults(), {station: binding(project), dispatcher: binding(project)});
      const host = factory as unknown as {captureAgent: (node: string, declared?: StationAgentBinding) => Captured};
      const capture = host.captureAgent.bind(factory);
      t.mock.method(host, 'captureAgent', (node: string, declared?: StationAgentBinding) => {
        const result = capture(node, declared);
        if (result.piRuntime) {
          const stream = result.piRuntime.stream;
          result.piRuntime = {...result.piRuntime, stream: async (model, context, options) => {
            sessions.push({project, node, session: options?.sessionId ?? '', input: JSON.stringify(context)});
            return stream(model, context, options);
          }};
        }
        return result;
      });
      factory.runtime.start('Independent project fixture');
    }
    const [left, right] = factories;
    selectExternal('nonexistent-outside-provider');
    left.setAgentBinding('independent/beta', {adapter: 'pi', provider: 'b'});
    const tokens = [
      left.runtime.create('independent/alpha', {item: 'left-one', url: '', source: 'manual', data: {input: {value: 'LEFT_ONE'}}}),
      left.runtime.create('independent/alpha', {item: 'left-two', url: '', source: 'manual', data: {input: {value: 'LEFT_TWO'}}}),
      left.runtime.create('independent/beta', {item: 'left-beta', url: '', source: 'manual', data: {input: {value: 'LEFT_BETA'}}}),
      right.runtime.create('independent/alpha', {item: 'right-one', url: '', source: 'manual', data: {input: {value: 'RIGHT_ONE'}}}),
    ];
    for (let i = 0; i < 400 && (sessions.length < 4 || requests.length < 2); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(sessions.length, 4, 'two workers, another node and another project own distinct captured model requests');
    assert.ok(peak >= 2, 'independent contexts really overlap at the local model service within its shared capacity');
    left.setAgentDefaults({station: binding('b'), dispatcher: binding('b')});
    right.setAgentDefaults({dispatcher: binding('a')});
    release();
    await Promise.all(factories.map(factory => factory.runtime.settle()));
    assert.deepEqual(tokens.map(token => token.data.result), [{value: 'b'}, {value: 'b'}, {value: 'b'}, {value: 'b'}],
      'already sent A requests finish, then the same station conversations select B on their next request');
    const firstRequests = sessions.filter((_value, index) => index < 4);
    assert.equal(new Set(firstRequests.map(value => value.session)).size, 4);
    for (const value of sessions) {
      assert.ok(value.session);
      assert.match(value.input, new RegExp(`PROJECT_${value.project.toUpperCase()}_ONLY`));
      assert.ok(!value.input.includes(value.project === 'a' ? 'PROJECT_B_ONLY' : 'PROJECT_A_ONLY'));
    }
    assert.ok(left.state.cases['left-one'].some(note => note.text === 'local-a-note'));
    assert.equal(right.state.cases['left-one'], undefined, 'the host toolbox cannot write into another project');
    assert.ok(right.state.cases['right-one'].some(note => note.text === 'local-b-note'));
    assert.equal(left.state.cases['right-one'], undefined);
    await t.test('a Pi station lists and selects only its own connected models inside one attempt', async () => {
      left.setAgentBinding('independent/alpha', binding('a'));
      left.setAgentBinding('independent/beta', binding('a'));
      const defaults = left.getAgentDefaults();
      const startIndex = requests.length;
      const self = left.runtime.create('independent/alpha', {item: 'self-model', url: '', source: 'manual',
        data: {input: {value: 'SELF_MODEL_SELECTION'}}});
      await left.runtime.settle();
      assert.equal(left.state.tokens[self.id].status, 'published');
      assert.equal(left.state.tokens[self.id].attempts.length, 1, 'selection continues the same attempt');
      assert.deepEqual(requests.slice(startIndex).map(request => request.provider), ['a', 'a', 'a', 'a', 'b']);
      const finalInput = requests.at(-1)!.body;
      assert.match(finalInput, /unconnected/);
      assert.ok(finalInput.includes('must not have additional properties'), 'cross-node selection is rejected by the tool schema');
      assert.doesNotMatch(finalInput, /fixture-project-[ab]|127\.0\.0\.1|apiKey|authorization/i,
        'the model directory contains no provider credentials or endpoints');
      assert.deepEqual(left.state.agentBindings?.['independent/alpha'], {...binding('b'), model: 'fixture-next-model'});
      assert.deepEqual(left.state.agentBindings?.['independent/beta'], binding('a'), 'the tool cannot target another node');
      assert.deepEqual(left.getAgentDefaults(), defaults, 'the dispatcher and project default stay unchanged');
      const attempt = left.state.attempts[left.state.tokens[self.id].attempts[0]];
      assert.equal(attempt.metrics?.execution?.provider, 'b');
      assert.equal(attempt.metrics?.execution?.model, 'fixture-next-model');
      assert.equal(attempt.metrics?.dependency?.provider, 'b');
      const requestedModels = requests.slice(startIndex).map(request =>
        (JSON.parse(request.body) as {model: string}).model);
      assert.deepEqual(attempt.metrics?.activity?.spans.filter(span => span.kind === 'model_request')
        .map(span => span.model), requestedModels, 'the activity timeline names the model actually sent for each request');
      assert.deepEqual(attempt.metrics?.modelResponses?.map(response => [response.provider, response.modelCalls]), [['a', 4], ['b', 1]]);
      assert.equal(attempt.metrics?.tokenUsage?.input, 100);
      assert.equal(attempt.metrics?.tokenUsage?.output, 25);
      left.setAgentBinding('independent/alpha', null);
    });
    const next = left.runtime.create('independent/alpha', {item: 'left-next', url: '', source: 'manual', data: {input: {value: 'LEFT_NEXT'}}});
    await left.runtime.settle();
    assert.deepEqual(next.data.result, {value: 'b'}, 'a project change applies to the next attempt');
    const dispatchers = factories.map(factory => new Dispatcher(factory));
    await Promise.all(dispatchers.map((dispatcher, index) => dispatcher.chat(`Independent dispatch ${index}`, [])));
    assert.match(left.state.conversation.at(-1)?.message.content.toString() ?? '', /./);
    assert.equal(dispatchers[0].agent!.state.model.provider, 'b');
    assert.equal(dispatchers[1].agent!.state.model.provider, 'a');
    assert.notEqual(dispatchers[0].agent!.sessionId, dispatchers[1].agent!.sessionId);
    assert.ok(dispatchers.every(dispatcher => dispatcher.agent!.sessionId?.startsWith('easy-workflow-dispatcher-')));
    const checkpoint = [...left.journal.read()].findLast(event => event.kind === 'chat.checkpoint');
    assert.ok(checkpoint?.kind === 'chat.checkpoint');
    assert.deepEqual(checkpoint.checkpoint.agent, binding('b'));
    assert.ok(requests.some(request => request.provider === 'b' && request.body.includes('Independent dispatch 0')));
    assert.ok(requests.some(request => request.provider === 'a' && request.body.includes('Independent dispatch 1')));
    for (const dispatcher of dispatchers) dispatcher.interrupt();
    left.setAgentDefaults({dispatcher: {adapter: 'launcher', command: ['never-run'], model: 'unused'}});
    assert.equal(left.dispatcherModelStatus().id, 'unused', 'configuring a native dispatcher must not launch it');
    const persisted = left.getAgentDefaults();
    left.recovery.close(); await left.sources.close(); left.channels?.close(); await left.runtime.close();
    left.docs.flush(); left.lessons.close(); left.journal.close();
    const restarted = new Factory(left.project.dir);
    factories[0] = restarted;
    await restarted.boot();
    assert.deepEqual(restarted.getAgentDefaults(), persisted, 'restart never rereads the external Pi default');
    assert.equal(restarted.agentBindings('independent/alpha').bindings[0].effective?.model, 'fixture-model');
  } finally {
    release();
    for (const factory of factories) {
      factory.recovery?.close(); await factory.sources?.close(); factory.channels?.close();
      await factory.runtime?.close(); factory.docs?.flush(); factory.lessons?.close(); factory.journal.close();
    }
    await closeModelTransport();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
  }
});
test('Pi tools retain a worker but release the real request slot for an independent station', {timeout: 20000}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-pi-tool-slots-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const calls: {node: string; attempt: string; at: number}[] = [];
  const requestCounts = new Map<string, number>();
  const errors: unknown[] = [];
  let active = 0;
  let peak = 0;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        messages: {content: unknown}[];
      };
      const input = body.messages.map(message => typeof message.content === 'string'
        ? message.content : JSON.stringify(message.content)).join('\n');
      const node = /station=([^;]+)/.exec(input)?.[1];
      const attempt = /attempt=([^;]+)/.exec(input)?.[1];
      assert.ok(node === 'first/work' || node === 'second/work');
      assert.ok(attempt);
      const count = (requestCounts.get(attempt) ?? 0) + 1;
      requestCounts.set(attempt, count);
      active++;
      peak = Math.max(peak, active);
      calls.push({node, attempt, at: Date.now()});
      const name = node === 'first/work' && count === 1 ? 'env_call' : 'submit';
      const args = name === 'env_call' ? {name: 'fixture_wait', arguments: {}} : {ok: true};
      response.writeHead(200, {'content-type': 'text/event-stream'});
      await delay(20);
      for (const part of [
        {choices: [{index: 0, delta: {role: 'assistant', tool_calls: [{index: 0,
          id: `${attempt}-${count}`, type: 'function', function: {name, arguments: JSON.stringify(args)}}]}, finish_reason: null}]},
        {choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}],
          usage: {prompt_tokens: 5, completion_tokens: 2, total_tokens: 7}},
      ]) response.write(`data: ${JSON.stringify({id: attempt, model: 'fixture-model', ...part})}\n\n`);
      response.end('data: [DONE]\n\n');
      active--;
    } catch (error) {
      errors.push(error);
      response.writeHead(500);
      response.end('fixture protocol failure');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as {port: number}).port;
  fs.writeFileSync(path.join(directory, 'auth.json'), JSON.stringify({fixture: {type: 'api_key', key: 'local-fixture-only'}}));
  fs.writeFileSync(path.join(directory, 'models.json'), JSON.stringify({providers: {fixture: {
    api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`,
    models: [{id: 'fixture-model', input: ['text']}],
  }}}));
  const fixturePack: Pack = {
    id: 'pi-tool-slots', name: 'Pi tool slots', version: '1', blurb: 'Local protocol fixture',
    resources: {model: 1, browser: 1, cpu: 1, http: 1},
    lines: ['first', 'second'].map(id => line({id, name: id, layer: 3, priority: 'mid', wired: true,
      blurb: 'Independent context', stations: [
        station({id: 'work', name: 'Work', role: 'process', kind: 'agent', resource: 'model',
          accept: ['The local result is submitted'], estimateSeconds: 1,
          workers: {min: 1, max: 1, initial: 1, policy: 'fixed'}}),
        station({id: 'published', name: 'Done', role: 'store', kind: 'store'}),
      ], edges: [['work', 'published']]})),
    channels: [], links: [], conditions: {}, order: ['first', 'second'], collapsed: [], hints: {},
  };
  const compiled = compile([fixturePack]);
  assert.deepEqual(compiled.issues, []);
  const waitFor = async (condition: () => boolean, message: string) => {
    const deadline = Date.now() + 4000;
    while (!condition() && Date.now() < deadline) await delay(5);
    assert.deepEqual(errors, []);
    assert.ok(condition(), message);
  };
  try {
    for (const modelWorkers of [1, 3]) await t.test(`${modelWorkers} model workers with one real request`, async () => {
      const journal = new Journal(':memory:');
      const state = initialState(compiled);
      journal.subscribeProjection(event => apply(state, event));
      const broker = new Broker({...fixturePack.resources, modelWorkers}, 0);
      const selected = models({provider: 'fixture', model: 'fixture-model'});
      const sessions: {id: string; input: string}[] = [];
      const piRuntime: ReturnType<typeof models> = {...selected, stream: async (model, context, options) => {
        sessions.push({id: options?.sessionId ?? '', input: JSON.stringify(context)});
        return selected.stream(model, context, options);
      }};
      const gates = new Map<string, () => void>();
      const toolSignals = new Map<string, AbortSignal>();
      const toolFinished = new Set<string>();
      const docs = {dir: directory, envelope: () => ({text: 'Only this station and case.',
        sizes: {role: 27, project: 0, context: 0, caseFile: 0}})} as unknown as Docs;
      const toolbox = {
        help: () => ({ok: true, tools: [{name: 'fixture_wait'}]}),
        call: async (allowed: string[], name: string, _args: unknown, context: Parameters<Toolbox['call']>[3]) => {
          assert.equal(name, 'fixture_wait');
          assert.ok(allowed.includes(name));
          const token = context.token;
          assert.ok(token);
          const lease = await broker.acquire('browser', {signal: context.signal, timeoutMs: 1000});
          assert.ok(lease);
          toolSignals.set(token, context.signal);
          try {
            await new Promise<void>((resolve, reject) => {
              const abort = () => reject(context.signal.reason);
              gates.set(token, () => {
                context.signal.removeEventListener('abort', abort);
                resolve();
              });
              context.signal.addEventListener('abort', abort, {once: true});
              if (context.signal.aborted) abort();
            });
            toolFinished.add(token);
            return {ok: true, content: 'Controlled asynchronous tool completed'};
          } finally {
            gates.delete(token);
            lease.release();
          }
        },
      } as unknown as Toolbox;
      const role = (key: string) => ({station: key, path: `fixture/${key}/ROLE.md`,
        revision: key, content: `Complete only ${key}.`});
      const definition = (key: string): AgentStationDef => ({
        agent: {adapter: 'pi', provider: 'fixture', model: 'fixture-model'}, piRuntime,
        role: role(key), system: 'Call the indicated local tool, then submit ok:true.', tools: ['fixture_wait'],
        schema: Type.Object({ok: Type.Boolean()}), input: context => ({text: `Own case ${context.token.item}`}),
        after: () => ({ok: true, summary: 'Pi fixture accepted'}), timeoutMs: 8000, requestTimeoutMs: 2000,
        services: {docs: () => docs, toolbox: () => toolbox},
      });
      const runtime = new Runtime(compiled, journal, broker, {}, node => ({prepare: () => ({
        dependency: selected.dependency, execute: context => runAgentStation(definition(node.key), context),
      })}));
      runtime.roleResolver = role;
      runtime.ensureWorkers([]);
      runtime.start('Pi lifecycle fixture');
      try {
        const first = runtime.create('first/work', {item: 'FIRST_PRIVATE_CASE', url: '', source: 'fixture'});
        await waitFor(() => gates.has(first.id), 'the actual Pi agent must reach its asynchronous tool');
        assert.equal(broker.used.model, 1);
        assert.equal(broker.modelRequests.active, 0, 'the completed HTTP call no longer occupies the request pool');
        const beforeSecond = calls.length;
        const second = runtime.create('second/work', {item: 'SECOND_PRIVATE_CASE', url: '', source: 'fixture'});
        if (modelWorkers === 1) {
          await delay(60);
          assert.equal(calls.length, beforeSecond, 'an explicit single worker preserves serial station execution');
          assert.equal(state.tokens[second.id].attempts.length, 0);
        } else {
          await waitFor(() => second.finished, 'the second station must finish before the first tool is released');
          assert.equal(state.tokens[second.id].status, 'published');
          assert.ok(calls.slice(beforeSecond).some(call => call.node === 'second/work'));
          assert.equal(toolFinished.has(first.id), false);
          assert.equal(broker.used.browser, 1);
          runtime.pause();
          const paused = runtime.create('second/work', {item: 'PAUSED_PRIVATE_CASE', url: '', source: 'fixture'});
          await delay(30);
          assert.equal(state.tokens[paused.id].attempts.length, 0, 'extra worker capacity does not bypass global pause');
          runtime.resume();
          await waitFor(() => paused.finished, 'resume dispatches the preserved queued task');
          assert.equal(state.tokens[paused.id].status, 'published');
        }
        gates.get(first.id)!();
        await runtime.settle();
        assert.deepEqual([state.tokens[first.id].status, state.tokens[second.id].status], ['published', 'published']);
        const firstSession = sessions.find(value => value.input.includes('FIRST_PRIVATE_CASE'))!;
        const secondSession = sessions.find(value => value.input.includes('SECOND_PRIVATE_CASE'))!;
        assert.ok(firstSession.id && secondSession.id);
        assert.notEqual(firstSession.id, secondSession.id);
        assert.ok(!firstSession.input.includes('SECOND_PRIVATE_CASE'));
        assert.ok(!secondSession.input.includes('FIRST_PRIVATE_CASE'));
        if (modelWorkers === 3) {
          const cancelled = runtime.create('first/work', {item: 'CANCEL_PRIVATE_CASE', url: '', source: 'fixture'});
          await waitFor(() => gates.has(cancelled.id), 'the next attempt must own a new cancellable tool');
          runtime.end();
          await runtime.settle();
          assert.equal(toolSignals.get(cancelled.id)?.aborted, true);
          assert.equal(toolFinished.has(cancelled.id), false);
          assert.equal(state.tokens[second.id].status, 'published', 'cancellation cannot erase another completed receipt');
        }
        assert.equal(peak, 1, 'actual model HTTP concurrency never exceeds the configured request quota');
        assert.equal(broker.used.model, 0);
        assert.equal(broker.used.browser, 0);
        assert.equal(broker.modelRequests.active, 0);
        assert.equal(broker.modelRequests.queued, 0);
      } finally {
        await runtime.close();
        journal.close();
      }
    });
  } finally {
    await closeModelTransport();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
  }
});

for (const answeredBeforeRestart of [false, true]) test(`D pending question restores its original SSE tool receipt after ${answeredBeforeRestart ? 'answer' : 'question'} persistence`, {timeout: 20000}, async () => {
  await contractFixture(index => index === 1 ? {tool: {name: 'env_call', arguments: {name: 'board_post', arguments: {
    type: 'question', field: 'proof', addressee: 'curation/owner', body: 'What did the original evidence show?',
  }}}} : submitContract(), async fixture => {
    const {Factory} = await import('../server/factory.ts');
    const compiled = compile([{id: 'pending-fixture', name: 'Pending question', version: '1', blurb: 'Local recovery',
      resources: {model: 4, cpu: 1, browser: 0, http: 0}, channels: [], links: [], conditions: {}, order: ['curation'], collapsed: [], hints: {},
      lines: [line({id: 'curation', name: 'Question recovery', layer: 3, priority: 'mid', wired: true, blurb: 'Keep receipts', stations: [
        station({id: 'owner', name: 'Owner', kind: 'agent', role: 'process', resource: 'model', accept: ['Keep evidence']}),
        station({id: 'reader', name: 'Reader', kind: 'agent', role: 'process', resource: 'model', accept: ['Score equals 2']}),
        station({id: 'published', name: 'Published', kind: 'store', role: 'store'}),
      ], edges: [['owner', 'reader'], ['reader', 'published']]})]}]);
    assert.deepEqual(compiled.issues, []);
    const journal = new Journal(path.join(fixture.dir, 'questions.db'));
    const broker = new Broker({model: 4, modelWorkers: 4}, 0);
    const board = new BoardStore(journal, compiled, {'curation/owner': {outputKey: 'proof'}, 'curation/reader': {outputKey: 'score'}});
    const docs = {dir: fixture.dir, envelope: () => ({text: 'Original task.', sizes: {role: 0, project: 0, context: 0, caseFile: 0}})} as unknown as Docs;
    let interrupted!: () => void;
    const interruption = new Promise<void>(resolve => {interrupted = resolve;});
    let recovering = false, answers = 0;
    const answer = async (question: BoardPost, signal: AbortSignal): Promise<BoardPost> => {
      const existing = board.answerTo(question.id);
      if (existing) return existing;
      let reply: BoardPost | undefined;
      if (recovering || answeredBeforeRestart) {
        reply = board.addPost({item: question.item, author: question.addressee!, type: 'answer', field: question.field,
          target: question.id, body: 'Original durable answer: fixture evidence supports score 2.'});
        answers++;
      }
      if (recovering) return reply!;
      interrupted();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
      throw new Error('The interrupted request must not continue');
    };
    let kernel!: Kernel;
    const postBoard = (Factory.prototype as unknown as {postBoard(context: EnvContext, input: BoardPostInput): Promise<unknown>}).postBoard;
    const facade = {get runtime() {return kernel;}, journal, board, collaboration: {answer}} as unknown as Factory;
    const toolbox = new Toolbox({journal, broker, docs: () => docs, board: {
      read: (context, options) => board.read(context.token!, options), post: (context, input) => postBoard.call(facade, context, input),
    }});
    const definition = {...fixture.definition, services: {docs: () => docs, toolbox: () => toolbox}};
    const create = () => {
      const value = new Kernel(compiled, journal, broker, {}, () => async context => context.node.id === 'owner'
        ? {ok: true, summary: 'Owned proof', data: {proof: 'known'}} : runAgentStation(definition, context));
      value.configureCollaboration({board, answer, openRoom: () => {throw new Error('No room in question fixture');}, runRoom: async () => {}});
      return value;
    };
    kernel = create();
    let token: ReturnType<Kernel['create']>;
    let atomicReceipt = false;
    journal.subscribe(event => {
      if (event.kind === 'board.posted' && event.post.type === 'question') {
        const pending = kernel.store.get(event.post.item)?.nodes[event.post.author]?.pendingQuestion;
        assert.equal(pending?.id, event.post.id, 'question and suspended call must be visible in one commit');
        const ref = kernel.store.get(event.post.item)?.nodes[event.post.author]?.session;
        assert.ok(ref && JSON.parse(fs.readFileSync(path.join(fixture.dir, ref.file), 'utf8')).messages
          .some((message: {content?: {type?: string; id?: string}[]}) => Array.isArray(message.content) && message.content.some(part => part.type === 'toolCall' && part.id === pending?.toolCallId)));
        atomicReceipt = true;
      }
    });
    try {
      kernel.start('pending fixture');
      token = kernel.create('curation/owner', {item: 'fixture', url: 'https://fixture.invalid', source: 'fixture'});
      await interruption;
      assert.equal(atomicReceipt, true);
      const pending = kernel.store.get(token.id)!.nodes['curation/reader'].pendingQuestion!;
      assert.equal(board.askQuota(token.id, 'curation/owner'), 1);
      await kernel.close();
      recovering = true;
      kernel = create(); kernel.recover(); kernel.resume();
      await kernel.settle();
      assert.equal(kernel.store.get(token.id)?.status, 'published');
      assert.equal(kernel.store.get(token.id)?.nodes['curation/reader'].pendingQuestion, undefined);
      assert.equal(board.askQuota(token.id, 'curation/owner'), 1, 'recovery cannot consume another question');
      assert.equal(answers, 1, 'a persisted answer is reused');
      assert.equal(fixture.requests.length, 2, 'recovery continues the original task without another question request');
      const messages = fixture.requests[1].messages as {role: string; tool_call_id?: string; content: unknown}[];
      const receipt = messages.find(message => message.role === 'tool' && message.tool_call_id === pending.toolCallId);
      assert.ok(receipt, 'the answer belongs to the original tool call');
      assert.match(JSON.stringify(receipt.content), /Original durable answer/);
      assert.ok(!JSON.stringify(messages).includes('No result provided'));
    } finally {await kernel.close(); journal.close();}
  });
});

test('D SSE rejects self and cyclic questions before posting or spending quota', {timeout: 20000}, async () => {
  await contractFixture(index => index <= 2 ? {tool: {name: 'env_call', arguments: {name: 'board_post', arguments: {
    type: 'question', field: index === 1 ? 'score' : 'proof', addressee: index === 1 ? 'curation/reader' : 'curation/owner', body: 'This would reenter a live session.',
  }}}} : submitContract(), async fixture => {
    const {Factory} = await import('../server/factory.ts');
    const compiled = compile([{id: 'cycle-fixture', name: 'No cyclic question', version: '1', blurb: 'Local policy',
      resources: {model: 4, cpu: 1, browser: 0, http: 0}, channels: [], links: [], conditions: {}, order: ['curation'], collapsed: [], hints: {},
      lines: [line({id: 'curation', name: 'Question recovery', layer: 3, priority: 'mid', wired: true, blurb: 'Single live session', stations: [
        station({id: 'owner', name: 'Owner', kind: 'agent', role: 'process', resource: 'model', accept: ['Keep evidence']}),
        station({id: 'reader', name: 'Reader', kind: 'agent', role: 'process', resource: 'model', accept: ['Score equals 2']}),
      ], edges: [['owner', 'reader']]})]}]);
    assert.deepEqual(compiled.issues, []);
    const journal = new Journal(path.join(fixture.dir, 'cycles.db'));
    const broker = new Broker({model: 4, modelWorkers: 4}, 0);
    const kernel = new Kernel(compiled, journal, broker, {}, () => async () => {throw new Error('Do not schedule the fixture');});
    const board = new BoardStore(journal, compiled, {'curation/owner': {outputKey: 'proof'}, 'curation/reader': {outputKey: 'score'}});
    const docs = {dir: fixture.dir, envelope: () => ({text: 'Original task.', sizes: {role: 0, project: 0, context: 0, caseFile: 0}})} as unknown as Docs;
    const postBoard = (Factory.prototype as unknown as {postBoard(context: EnvContext, input: BoardPostInput): Promise<unknown>}).postBoard;
    const facade = {runtime: kernel, journal, board, collaboration: {answer: () => {throw new Error('A rejected cycle must never start a second session');}}} as unknown as Factory;
    const toolbox = new Toolbox({journal, broker, docs: () => docs, board: {
      read: (context, options) => board.read(context.token!, options), post: (context, input) => postBoard.call(facade, context, input),
    }});
    const token = kernel.create('curation/owner', {item: 'fixture', url: 'https://fixture.invalid', source: 'fixture'});
    const item = kernel.store.get(token.id)!;
    item.status = 'active'; item.nodes['curation/reader'].status = 'running'; item.nodes['curation/reader'].lastAttempt = 'reader-live';
    journal.atomic(() => {
      const question = board.addPost({item, author: 'curation/owner', type: 'question', field: 'score', addressee: 'curation/reader', body: 'Explain your score.'});
      item.nodes['curation/owner'].status = 'waiting'; item.nodes['curation/owner'].waitingFor = 'room';
      item.nodes['curation/owner'].pendingQuestion = {id: question.id, toolCallId: 'original-owner-call', askedBy: 'curation/owner', addressee: 'curation/reader'};
      kernel.store.save(item);
    });
    const controller = new AbortController();
    try {
      const result = await runAgentStation({...fixture.definition, services: {docs: () => docs, toolbox: () => toolbox}}, {
        ...fixture.context, token: {...fixture.context.token, id: token.id}, attempt: 'reader-live', node: compiled.nodes.find(node => node.key === 'curation/reader')!,
      });
      assert.equal(result.ok, true, result.error ?? 'The original attempt should continue after tool errors');
      assert.deepEqual([board.askQuota(token.id, 'curation/reader'), board.askQuota(token.id, 'curation/owner')], [1, 0]);
      assert.equal(board.read(token.id).length, 1, 'cycle errors must leave no new post');
      const errors = (fixture.requests[2].messages as {role: string; content: unknown}[]).filter(message => message.role === 'tool');
      assert.equal(errors.length, 2);
      assert.ok(errors.every(message => JSON.stringify(message.content).includes('不能向自己或正在等待答疑的节点提问')));
      let idle = false;
      const wait = kernel.waitForStationIdle(token.id, 'curation/owner', controller.signal).then(() => {idle = true;});
      await delay(30);
      assert.equal(idle, false, 'a waiting original session is still live and cannot be resumed concurrently');
      journal.atomic(() => {const next = kernel.store.get(token.id)!; next.nodes['curation/owner'].status = 'done'; kernel.store.save(next);});
      await wait;
    } finally {controller.abort(); await kernel.close(); journal.close();}
  });
});

for (const disposition of ['return', 'park', 'shutdown'] as const) test(`D Factory ${disposition === 'return' ? 'question' : 'room'} session saves respect ${disposition} before a deferred result`, async () => {
  const {Factory} = await import('../server/factory.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-room-session-'));
  const compiled = compile([{id: 'room-session', name: 'Room session', version: '1', blurb: 'Deferred Factory result',
    resources: {model: 4, cpu: 1, browser: 0, http: 0}, channels: [], links: [], conditions: {}, order: ['room'], collapsed: [], hints: {},
    lines: [line({id: 'room', name: 'Room', layer: 3, priority: 'mid', wired: true, blurb: 'Session generation', stations: [
      station({id: 'owner', name: 'Owner', kind: 'agent', role: 'process', resource: 'model', accept: ['Keep proof']}),
      station({id: 'review', name: 'Review', kind: 'review', role: 'review', resource: 'model', accept: ['Check proof']}),
    ], edges: [['owner', 'review']]})]}]);
  const journal = new Journal(path.join(dir, 'journal.db'));
  const broker = new Broker({model: 4, modelWorkers: 4}, 0);
  const kernel = new Kernel(compiled, journal, broker, {}, () => async () => {throw new Error('No ordinary work in fixture');});
  const board = new BoardStore(journal, compiled, {'room/owner': {outputKey: 'proof'}});
  kernel.configureCollaboration({board, openRoom: () => {throw new Error('Use fixture room');}, runRoom: async () => {}, answer: async () => {throw new Error('No question');}});
  const token = kernel.create('room/owner', {item: 'room', url: 'https://fixture.invalid', source: 'fixture'});
  const before = kernel.store.get(token.id)!;
  const room = board.createRoom({item: before, field: 'proof', topic: 'Keep session', participants: ['room/owner', 'room/review'], judge: 'room/review'});
  before.status = 'active'; before.nodes['room/owner'].status = 'done';
  before.nodes['room/owner'].lastAttempt = 'original-owner-attempt';
  before.roomHolds = {[room.id]: {field: 'proof', owner: 'room/owner', nodes: ['room/review']}};
  journal.atomic(() => kernel.store.save(before));
  const initial = {pi: {file: 'work/agent-sessions/current.json', signature: 'same-contract'}};
  const late = {pi: {file: 'work/agent-sessions/late.json', signature: 'same-contract'}};
  const final = {pi: {file: 'work/agent-sessions/final.json', signature: 'same-contract'}};
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => {entered = resolve;}), barrier = new Promise<void>(resolve => {release = resolve;});
  const controller = new AbortController();
  const facade = Object.assign(Object.create(Factory.prototype), {journal, broker, store: new EvidenceStore(path.join(dir, 'evidence')), stationAgents: {},
    workflowPacks: {executor: () => async (context: StationContext) => {
      context.checkpointSession!(initial); entered(); await barrier;
      context.checkpointSession!(late);
      if (disposition !== 'return') throw Object.assign(new Error('Deferred interruption'), {sessionCheckpoint: final});
      return {ok: true, summary: 'Late room result', sessionCheckpoint: final};
    }}}) as Factory;
  const run = (Factory.prototype as unknown as {runCollaborationTurn(kernel: Kernel, turn: CollaborationTurn): Promise<StationResult>}).runCollaborationTurn;
  const mode = disposition === 'return' ? 'answer' : 'room';
  const pending = run.call(facade, kernel, {itemId: token.id, node: 'room/owner', ...(mode === 'room' ? {room} : {}), mode, prompt: 'Fixture',
    view: {}, posts: [], budget: {maxTokens: 12000, maxMs: 240000}, signal: controller.signal});
  try {
    await ready;
    assert.deepEqual(kernel.store.get(token.id)?.nodes['room/owner'].session, initial.pi);
    if (disposition === 'return') kernel.returnToken(token, 'human', 'room/owner', 'New correction', true);
    else if (disposition === 'park') kernel.toManual(token, compiled.nodes.find(node => node.key === 'room/owner')!, 'Manual review');
    else {controller.abort(new Error('Shutdown')); kernel.dispose();}
    release();
    if (disposition === 'return') await pending;
    else await assert.rejects(pending, /Deferred interruption/);
    assert.deepEqual(kernel.store.get(token.id)?.nodes['room/owner'].session, disposition === 'shutdown' ? final.pi : initial.pi);
    assert.deepEqual((kernel.store.get(token.id)?.data.stationSessions as Record<string, SessionRef>)['room/owner'], disposition === 'shutdown' ? final.pi : initial.pi);
    assert.equal(kernel.store.attempts(token.id).find(attempt => attempt.body.dialogue === mode)?.status, 'cancelled');
  } finally {
    release(); controller.abort(); await kernel.close(); journal.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, {recursive: true, force: true});
  }
});
