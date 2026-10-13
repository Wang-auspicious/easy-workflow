import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from 'node:http';
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { configureAgentStations, runAgentStation, type AgentStationDef } from "../server/agent-station.ts";
import { Toolbox } from "../server/toolbox.ts";
import { Broker } from "../server/broker.ts";
import { Docs } from "../server/docs.ts";
import { Journal } from "../server/journal.ts";
import { Runtime, type StationContext, type StationResult } from "../server/runtime.ts";
import { compile } from '../server/spec/compile.ts';
import { line, station, type Pack } from '../server/spec/dsl.ts';
import { apply, initialState } from '../shared/project.ts';
import { closeNetwork, readEvidence, rememberRead } from "../server/network.ts";
import { ClosedStationAgent, closedAgentConfig } from '../server/mcp-station.ts';
import { ClaudeCodeProtocol, type ClaudeSessionReference } from '../server/claude-code.ts';
import { EvidenceStore, type ImageProcessOptions } from '../server/evidence.ts';
import { closeModelTransport, models, piStatus, probeModelConnection, redactModelError } from '../server/pi.ts';
import type {ModelDependency, StationAgentBinding} from '../shared/types.ts';
import { sessionSignature, type SessionRef } from '../server/station-session.ts';
import {withModelAdmission} from '../server/model-requests.ts';
import {closedModelDependency} from '../server/agent-bindings.ts';
import {installWorkflowPack, type WorkflowManifest} from '../server/workflow-packs.ts';

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
    assert.equal(result.metrics?.time?.toolCalls, 8, "count actual env_call, env_help, submit and duplicate-submit executions in both answers");
    assert.equal(result.metrics?.activity?.modelTiming, "unavailable", "aggregate launcher durations cannot establish model interval boundaries");
    assert.equal(result.metrics?.activity?.spans.length, 8);
    assert.ok(result.metrics?.activity?.spans.every(span => span.kind === "tool" && span.endedAt !== undefined));
    assert.equal(result.metrics?.activity?.spans.filter(span => span.status === "failed").length, 4);
    assert.ok(progress.some(p => p.includes("程序检查全部通过")));
    assert.ok(!progress.join("\n").includes("not-for-station"));
    assert.ok(fs.existsSync(path.join(dir, "work", "fixture-task")));
    const simple = { system: "fixture station contract", schema: Type.Object({ score: Type.Integer() }, { additionalProperties: false }), input: () => ({ text: "fixture input" }), after: () => ({ ok: true, summary: "done" }) };
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
assert.equal(value('--setting-sources'), ''); assert.ok(args.includes('--strict-mcp-config'));
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
    tools: ['mcp__h2_station__env_help', 'mcp__h2_station__env_call', 'mcp__h2_station__submit'], mcp_servers: [{ name: 'h2_station', status: 'connected' }] });
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

test('explicit station bindings override compatibility defaults without sharing mutable commands', () => {
  const keys = ['FACTORY_STATION_COMMAND', 'FACTORY_STATION_MODEL', 'FACTORY_STATION_ADAPTER', 'FACTORY_STATION_TIMEOUT_MS'];
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
      assert.deepEqual(recovered.metrics?.execution, { adapter: 'pi', model: 'shared-model' });
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
  await nativeFixture(async (_dir, reads) => {
    const binding: StationAgentBinding = { adapter: 'claude-code', command: [process.execPath, '-e', claudeFixture, '--'], model: 'binding-model', requestTimeoutMs: 10000 };
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
    assert.equal(result.usage?.cost, .002); assert.deepEqual(result.data?.closedStationSessions, {});
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
      assert.equal(finished.ok, true); assert.equal(reads(), 1); assert.deepEqual(finished.data?.stationSessions, {});
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
    assert.deepEqual(second.data?.closedStationSessions, {});
  });
});

test('cancelling image preparation preserves a restored Claude checkpoint without a new model charge', { timeout: 15000 }, async t => {
  await nativeFixture(async (dir, reads) => {
    const image = path.join(dir, 'fixture.ppm');
    fs.writeFileSync(image, Buffer.concat([Buffer.from('P6\n4 6\n255\n'), Buffer.alloc(4 * 6 * 3, 128)]));
    const definition = { system: 'Fixture image contract', schema: Type.Object({ score: Type.Integer() }), tools: ['fetch_text'],
      input: () => ({ text: 'native-restart', images: [{ file: image, label: 'fixture image' }] }), after: () => ({ ok: true, summary: 'done' }) };
    const first = await runAgentStation(definition, nativeContext('image-original'));
    assert.equal(first.failure?.tag, 'model_transport');
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

test('Claude stream rejects foreign capabilities and never subtracts another CLI process cost', () => {
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
  assert.equal('totalCostUsd' in saved, false, 'a session reference is not a cost baseline');
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
  await nativeFixture(async (_dir, reads) => {
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
      assert.equal(retry.data.accepted, true); assert.deepEqual(retry.data.closedStationSessions, {});

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

test('Factory captures installed Agent execution before start observers rebind the next item', {timeout: 30000}, async t => {
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
          assert.deepEqual(token.data.result, {value: name});
          const attempt = factory.state.attempts[factory.state.tokens[token.id].attempts[0]];
          assert.deepEqual(attempt.dependency, identities[index]);
          assert.deepEqual(attempt.metrics?.dependency, identities[index]);
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
    assert.deepEqual(requests, [{path: '/a/v1/chat/completions', model: 'shared-model'},
      {path: '/b/v1/chat/completions', model: 'shared-model'}]);
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
    const delta = station ? {role: 'assistant', tool_calls: [{index: 0, id: `project-${requests.length}-${provider}`,
      type: 'function', function: wroteNote ? {name: 'submit', arguments: JSON.stringify({value: provider})}
        : {name: 'env_call', arguments: JSON.stringify({name: 'case_note', arguments: {section: 'fixture', text: `local-${provider}-note`}})}}]}
      : {role: 'assistant', content: `Dispatcher ${provider}`};
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
      models: [{id: 'fixture-model', input: ['text']}]}]))}));
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
    assert.deepEqual(tokens.map(token => token.data.result), [{value: 'a'}, {value: 'a'}, {value: 'b'}, {value: 'b'}]);
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
    assert.throws(() => left.setAgentDefaults({dispatcher: {adapter: 'launcher', command: ['never-run'], model: 'unused'}}),
      /主调度目前支持 Pi/);
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
