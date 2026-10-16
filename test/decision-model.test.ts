import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createDecisionClient, projectDecisionClient, decide, withDecisionAttempt, withDecisionClient,
  type DecisionRequest, type DecisionResponse} from '../server/decision-model.ts';
import type {StationContext} from '../server/runtime.ts';
import {Runtime} from '../server/runtime.ts';
import {Journal} from '../server/journal.ts';
import {Broker} from '../server/broker.ts';
import {compile} from '../server/spec/compile.ts';
import {station, line} from '../server/spec/dsl.ts';
import {initialState, apply} from '../shared/project.ts';
import {reportModelResponse} from '../server/model-requests.ts';

const model = 'kev-fixture-deployed';
const key = 'private-decision-test-secret';
const request: DecisionRequest = {purpose: 'Verify the supplied fixture facts', state: {text: 'Exact input'},
  questions: {route: {type: 'choice', instructions: 'Choose the supported route.', criteria: {yes: 'Supported', no: 'Unsupported'}}}};
const valid = () => ({model: 'kev-latest', deployment_model: model, answers: {
  route: {type: 'choice', choice: 'yes', probabilities: {yes: 0.95, no: 0.05}, confidence: 0.95}},
usage: {input_tokens: 12, output_tokens: 3}, latency_ms: 4});
const receipt = (): DecisionResponse => ({answers: valid().answers as DecisionResponse['answers'], model,
  usage: {inputTokens: 12, outputTokens: 3}, requestId: 'fixture-response', latencyMs: 4});
const context = (signal = new AbortController().signal): StationContext => ({
  node: {key: 'fixture/decide'}, token: {id: 'fixture-token', item: 'fixture-item', data: {}}, attempt: 'fixture-attempt', signal,
  progress: () => {}, activity: () => {}, addEvidence: (value: unknown) => value,
}) as unknown as StationContext;

async function until(ready: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!ready()) {
    assert.ok(Date.now() < deadline, 'fixture request did not reach the local server');
    await delay(1);
  }
}

async function server(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>) {
  const instance = http.createServer((req, res) => {void Promise.resolve(handler(req, res)).catch(() => res.destroy());});
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(instance.address() as {port: number}).port}`;
  return {url, close: async () => {
    instance.closeAllConnections();
    await new Promise<void>(resolve => instance.close(() => resolve()));
  }};
}

test('decision configuration and status perform no network and never disclose endpoint credentials', async () => {
  let calls = 0;
  const endpoint = await server((_req, res) => {calls++; res.end('{}');});
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-decision-config-'));
  const previous = process.env.EASY_WORKFLOW_DECISION_MODEL_CONFIG;
  const readOnly = process.env.FACTORY_READONLY;
  try {
    const filename = path.join(directory, 'config.json');
    await fs.writeFile(filename, JSON.stringify({enabled: true, projects: [directory], baseUrl: endpoint.url, apiKey: key, model}));
    process.env.EASY_WORKFLOW_DECISION_MODEL_CONFIG = filename;
    process.env.FACTORY_READONLY = '0';
    const client = projectDecisionClient(directory);
    assert.ok(client);
    assert.doesNotMatch(JSON.stringify(client.status()), /private-decision-test-secret|127\.0\.0\.1|apiKey|baseUrl/);
    assert.equal(projectDecisionClient(path.join(directory, 'another-project')), null);
    process.env.FACTORY_READONLY = '1';
    assert.equal(projectDecisionClient(directory), null);
    assert.equal(await withDecisionClient(client, () => decide(context(), request)), null);
    assert.equal(calls, 0, 'boot/status/help/read-only must not probe or invoke the remote model');
    for (const patch of [{baseUrl: `not a url ${key}`}, {baseUrl: `http://user:${key}@127.0.0.1`},
      {maxConcurrent: NaN}, {maxConcurrent: 0}, {maxQueued: -1}, {timeoutMs: 1.5}, {apiKey: 123}]) {
      assert.throws(() => createDecisionClient({...{baseUrl: endpoint.url, apiKey: key, model}, ...patch} as never),
        error => error instanceof Error && !error.message.includes(key));
    }
  } finally {
    if (previous === undefined) delete process.env.EASY_WORKFLOW_DECISION_MODEL_CONFIG; else process.env.EASY_WORKFLOW_DECISION_MODEL_CONFIG = previous;
    if (readOnly === undefined) delete process.env.FACTORY_READONLY; else process.env.FACTORY_READONLY = readOnly;
    await endpoint.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    await fs.rm(directory, {recursive: true, force: true});
  }
});

test('dedicated client validates complete typed responses and exact input without trusting response metadata', async () => {
  let body: unknown;
  let output: unknown = valid();
  let calls = 0;
  const endpoint = await server(async (req, res) => {
    calls++;
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    let source = '';
    for await (const chunk of req) source += chunk;
    body = JSON.parse(source);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(output));
  });
  try {
    const config = {baseUrl: endpoint.url, apiKey: key, model};
    const client = createDecisionClient(config);
    config.apiKey = 'changed-after-construction';
    const signal = new AbortController().signal;
    const original = {...request, state: {text: '原样保留 https://fixture.test/?path=/story/button--main', nullable: null}};
    const first = await client.decide(original, {signal});
    assert.ok(first);
    assert.equal(first.model, model);
    assert.deepEqual(JSON.parse((body as {state: string}).state), original.state);
    output = {...valid(), model: key, requestId: key, error: key};
    assert.doesNotMatch(JSON.stringify(await client.decide(request, {signal})), new RegExp(key));
    for (const malformed of [
      {...valid(), deployment_model: undefined}, {...valid(), deployment_model: 'wrong-weights'},
      {...valid(), answers: {}}, {...valid(), usage: {input_tokens: -1, output_tokens: 3}},
      {...valid(), answers: {route: {...valid().answers.route, choice: 'unknown'}}},
      {...valid(), answers: {route: {...valid().answers.route, confidence: null}}},
      {...valid(), answers: {route: {...valid().answers.route, probabilities: {yes: 0.3, no: 0.2}}}},
      {...valid(), answers: {route: valid().answers.route, injected: valid().answers.route}},
    ]) {
      output = malformed;
      assert.equal(await client.decide(request, {signal}), null);
      output = valid();
      assert.ok(await client.decide(request, {signal}), 'a valid response resets the failure count between cases');
    }
    const before = calls;
    for (const invalid of [
      {...request, state: 'a'.repeat(12001)},
      {...request, questions: {route: {...request.questions.route, instructions: 'a'.repeat(2049)}}},
      {...request, questions: {route: {type: 'choice', instructions: 'Choose.', criteria: {yes: 'a'.repeat(513), no: 'No'}}}},
    ]) assert.equal(await client.decide(invalid as DecisionRequest, {signal}), null);
    assert.equal(calls, before, 'invalid or oversized inputs are rejected whole, before transport');
  } finally { await endpoint.close(); }
});

test('shared admission bounds multiple clients, queue saturation, cancellation and queue timeout', async () => {
  const releases: (() => void)[] = [];
  let started = 0;
  const endpoint = await server(async (_req, res) => {
    started++;
    await new Promise<void>(resolve => releases.push(resolve));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(valid()));
  });
  try {
    const config = {baseUrl: endpoint.url, apiKey: key, model, maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 30};
    const first = createDecisionClient(config), second = createDecisionClient({...config, maxConcurrent: 4});
    const a = new AbortController(), b = new AbortController();
    const running = first.decide(request, {signal: a.signal});
    await until(() => started > 0);
    const queued = second.decide(request, {signal: b.signal});
    const cancelled = assert.rejects(queued, /queued cancellation/);
    assert.equal(await second.decide(request, {signal: new AbortController().signal}), null, 'a full queue fails open without sending a request');
    b.abort(new Error('queued cancellation'));
    await cancelled;
    assert.equal(second.status().queued, 0);
    assert.equal(await second.decide(request, {signal: new AbortController().signal}), null, 'queue timeout removes the waiter');
    assert.equal(started, 1);
    releases.shift()!();
    assert.ok(await running);
    assert.equal(first.status().active, 0);
    assert.equal(first.status().maxConcurrent, 1, 'another Factory cannot silently widen a shared endpoint budget');
    const immediate = new AbortController();
    const acquired = first.decide(request, {signal: immediate.signal});
    immediate.abort(new Error('cancelled after acquisition'));
    await assert.rejects(acquired, /cancelled after acquisition/);
    assert.equal(first.status().active, 0, 'cancellation between admission and transport must release its slot');
  } finally {
    releases.forEach(release => release());
    await endpoint.close();
  }
});

test('HTTP timeout and active cancellation release capacity without exposing remote error bodies', async () => {
  let started = 0;
  const endpoint = await server(async (_req, res) => {
    started++;
    await delay(100);
    res.statusCode = 500;
    res.end(key);
  });
  try {
    const client = createDecisionClient({baseUrl: endpoint.url, apiKey: key, model, maxConcurrent: 1, timeoutMs: 20});
    assert.equal(await client.decide(request, {signal: new AbortController().signal}), null);
    assert.equal(client.status().active, 0);
    const controller = new AbortController();
    const cancellationClient = createDecisionClient({baseUrl: endpoint.url, apiKey: key, model, maxConcurrent: 1, timeoutMs: 1000});
    const before = started;
    const pending = cancellationClient.decide(request, {signal: controller.signal});
    const cancelled = assert.rejects(pending, /owner cancellation/);
    await until(() => started > before);
    controller.abort(new Error('owner cancellation'));
    await cancelled;
    assert.equal(client.status().active, 0);
    assert.doesNotMatch(JSON.stringify(client.status()), new RegExp(key));
  } finally { await endpoint.close(); }
});

test('decision scopes preserve paid receipts on later failure and cancellation without fabricating missing models', async () => {
  const client = {decide: async () => receipt()};
  const ctx = context();
  const error = await withDecisionAttempt(client, ctx, async current => {
    await decide(current, request);
    throw new Error('later contract failure');
  }).catch(error => error);
  assert.match(error.message, /later contract failure/);
  assert.deepEqual(error.metrics.tokenUsage, {input: 12, output: 3});
  assert.equal(error.metrics.decisionUsage.reported, 1);
  assert.equal(error.metrics.costReported, false);
  const unavailable = await withDecisionAttempt({decide: async () => null}, ctx, async current => {
    assert.equal(await decide(current, request), null);
    return {ok: true, summary: 'Original deterministic path'};
  });
  assert.equal(unavailable.metrics?.execution, undefined, 'a missing response does not prove an actual model');
  assert.equal(unavailable.metrics?.tokenUsage, undefined, 'unknown usage is not reported zero');
  const controller = new AbortController();
  const cancelled = await withDecisionAttempt({decide: async () => {
    controller.abort(new Error('owner cancelled after response'));
    return receipt();
  }}, context(controller.signal), async current => {
    await decide(current, request);
    return {ok: true, summary: 'must not reach'};
  }).catch(error => error);
  assert.match(cancelled.message, /owner cancelled after response/);
  assert.deepEqual(cancelled.metrics.tokenUsage, {input: 12, output: 3});
  assert.equal(cancelled.metrics.activity.spans[0].status, 'cancelled');
});

test('Runtime retains chat-model and typed-decision token receipts exactly once', async () => {
  const id = 'decision-mixed';
  const decision = station({id: 'decide', name: 'Mixed receipt fixture', kind: 'program', role: 'process', resource: 'none',
    input: 'facts', output: 'facts', accept: ['Preserve both real model receipts']});
  const compiled = compile([{id, name: id, version: '1', blurb: 'Mixed usage fixture', resources: {model: 0, browser: 0, cpu: 0, http: 0},
    lines: [line({id, name: id, layer: 3, priority: 'mid', wired: true, blurb: '', stations: [decision], edges: []})], channels: [],
    links: [], conditions: {}, order: [id], collapsed: [], hints: {}}]);
  assert.deepEqual(compiled.issues, []);
  const journal = new Journal(':memory:');
  const state = initialState(compiled);
  journal.subscribeProjection(event => apply(state, event));
  const broker = new Broker({}, 0);
  const runtime = new Runtime(compiled, journal, broker, {}, () => current => withDecisionAttempt({decide: async () => receipt()}, current, async ctx => {
    await decide(ctx, request);
    reportModelResponse({dependency: {key: 'fixture-model', adapter: 'pi', model: 'large-model'}, model: 'large-model',
      modelCalls: 1, usageReported: true, tokenUsage: {input: 100, output: 20}, costReported: true,
      usage: {input: 100, output: 20, cost: 0.01}});
    return {ok: true, summary: 'Both decisions completed', metrics: {execution: {adapter: 'pi', model: 'large-model'},
      tokenUsage: {input: 100, output: 20}, usageReported: true, costReported: true}};
  }));
  runtime.roleResolver = key => ({station: key, path: 'fixture/ROLE.md', revision: 'fixture', content: 'Only run isolated fixture tools and preserve their receipts.'});
  try {
    runtime.ensureWorkers([]);
    runtime.start('Mixed inference receipt regression');
    const token = runtime.create(`${id}/decide`, {item: 'mixed', url: '', source: 'fixture', data: {}});
    await runtime.settle();
    const attempt = state.attempts[state.tokens[token.id].attempts[0]];
    assert.equal(attempt.ok, true);
    assert.deepEqual(attempt.metrics?.tokenUsage, {input: 112, output: 23});
    assert.deepEqual(attempt.metrics?.decisionUsage, {input: 12, output: 3, requests: 1, reported: 1});
    assert.equal(attempt.metrics?.costComplete, false, 'typed inference has no invented monetary price');
    assert.equal(attempt.metrics?.modelTimeReported, false, 'mixed tokens cannot imply a fully observed streaming speed');
    assert.equal(attempt.usage.cost, 0.01);
    assert.deepEqual(attempt.metrics?.execution, {adapter: 'pi', model: 'large-model'}, 'a helper does not relabel the enclosing Agent');
  } finally {
    await runtime.close();
    journal.close();
  }
});
