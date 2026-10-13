import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { configureAgentStations, runAgentStation } from "../server/agent-station.ts";
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

test('structured launcher failures preserve category and timeout stops a silent vendor process', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-launcher-errors-'));
  try {
    for (const [type, tag] of [['credentials', 'model_unavailable'], ['quota', 'model_unavailable'], ['tls', 'model_unavailable'], ['transport', 'model_transport']] as const) {
      const code = `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({error:{type:${JSON.stringify(type)}}}));process.exitCode=1;});`;
      const agent = new ClosedStationAgent({ command: [process.execPath, '-e', code], model: 'requested', cwd: dir }, 'Fixture', [], () => assert.fail('No model receipt was reported'));
      await assert.rejects(agent.prompt('input'), error => (error as { failure?: { tag?: string } }).failure?.tag === tag);
    }
    const silent = new ClosedStationAgent({ command: [process.execPath, '-e', 'process.stdin.resume();setInterval(()=>{},1000);'], model: 'requested', cwd: dir, requestTimeoutMs: 100 }, 'Fixture', [], () => assert.fail('Timed-out work must not report success'));
    await assert.rejects(silent.prompt('input'), /timed out/);
  } finally { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); }
});
