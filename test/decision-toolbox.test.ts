import test from 'node:test';
import assert from 'node:assert/strict';
import {Toolbox, BASE_TOOLS} from '../server/toolbox.ts';
import {withDecisionAttempt, type DecisionClientLike} from '../server/decision-model.ts';
import type {StationContext} from '../server/runtime.ts';

function setup() {
  const toolbox = new Toolbox({docs: () => ({dir: ''})} as never);
  const context = {node: {key: 'curation/facts'}, token: {id: 'test-token', item: 'site', data: {}}, attempt: 'attempt-one',
    signal: new AbortController().signal, progress: () => {}, activity: () => {}, addEvidence: (value: unknown) => value} as unknown as StationContext;
  const env = {node: context.node.key, signal: context.signal};
  const request = {purpose: 'facts evidence check', state: 'Icons are released under the ISC license.', questions: {
    supported: {type: 'noul' as const, instructions: 'Does the text state that icons have an ISC license?'},
  }};
  return {toolbox, context, env, request};
}

test('every station can discover System One without a model request; tool result and usage enter the enclosing attempt', async () => {
  const {toolbox, context, env, request} = setup(); let calls = 0;
  const client: DecisionClientLike = {async decide(input) {
    calls++; assert.deepEqual(input, request);
    return {model: 'kev-9b-v1.0', answers: {supported: {type: 'noul', noul: 0.99}},
      usage: {inputTokens: 30, outputTokens: 5}, latencyMs: 80, requestId: 'tool-request'};
  }};
  assert.ok(BASE_TOOLS.includes('system_one'));
  assert.equal(toolbox.help(BASE_TOOLS, 'system_one').ok, true);
  assert.equal(calls, 0);
  const result = await withDecisionAttempt(client, context, async () => {
    const value = await toolbox.call(BASE_TOOLS, 'system_one', request, env);
    assert.equal(value.ok, true);
    assert.equal((value as any).answers.supported.noul, 0.99);
    return {ok: true, summary: 'checked'};
  });
  assert.equal(calls, 1);
  assert.equal(result.metrics?.time?.modelCalls, 1);
  assert.deepEqual(result.metrics?.tokenUsage, {input: 30, output: 5});
  assert.equal(result.metrics?.costReported, false);
});

test('System One unavailable is a tool failure, never a false answer; cancellation propagates', async () => {
  const {toolbox, context, env, request} = setup();
  await withDecisionAttempt({decide: async () => null}, context, async () => {
    const value = await toolbox.call(BASE_TOOLS, 'system_one', request, env);
    assert.equal(value.ok, false); assert.equal('answers' in value, false);
    return {ok: true, summary: 'fallback'};
  });
  const controller = new AbortController(); const cancelled = {...context, signal: controller.signal};
  await assert.rejects(withDecisionAttempt({decide: async () => {controller.abort(new Error('station cancelled')); return null;}}, cancelled, async () => {
    await toolbox.call(BASE_TOOLS, 'system_one', request, {...env, signal: controller.signal});
    return {ok: true, summary: 'must not run'};
  }), /station cancelled/);
});

test('System One refuses endpoint or credential overrides from an agent', async () => {
  const {toolbox, context, env, request} = setup(); let calls = 0;
  await withDecisionAttempt({decide: async () => {calls++; return null;}}, context, async () => {
    const value = await toolbox.call(BASE_TOOLS, 'system_one', {...request, apiKey: 'not-allowed', baseUrl: 'http://untrusted.invalid'}, env);
    assert.equal(value.ok, false);
    return {ok: true, summary: 'rejected override'};
  });
  assert.equal(calls, 0);
});
