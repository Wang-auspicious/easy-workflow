import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, initialState } from '../../shared/project.ts';
import type { Stamped } from '../../shared/types.ts';
import { nodeCountPresentation } from '../src/canvas/node-counts.ts';
import { browserMemoryGuard, executionIndex, nodeExecutionPresentation, recordNodeExecution, recordedUsage, runStatus, runtimeRecoveryIndex, stationStatus, tokenStatus } from '../src/canvas/status.ts';
import {applyUiEvent, uiEvent, uiState} from '../../shared/client-view.ts';

test('resource counters report journaled arrivals even though stores never execute attempts', () => {
  const state = initialState(); let seq = 0;
  const emit = (event: Omit<Stamped, 'seq' | 'at' | 'run'>) => apply(state, { ...event, seq: ++seq, at: seq, run: 'counter-fixture' } as Stamped);
  emit({ kind: 'run.started', runId: 'counter-fixture', title: 'Counters' } as never);
  for (const [key, count] of [['curation/published', 3], ['curation/manual', 13]] as const) {
    for (let i = 0; i < count; i++) {
      const token = `${key}-${i}`;
      emit({ kind: 'token.created', token, item: token, source: 'fixture', line: 'curation', url: 'https://fixture.test/' } as never);
      emit({ kind: 'token.finished', token, node: key, status: key.endsWith('published') ? 'published' : 'manual', reason: 'Fixture arrival' } as never);
    }
    const counts = nodeCountPresentation({ key, kind: 'store' }, state.nodes[key], state);
    assert.equal(state.nodes[key].processed, 0);
    assert.equal(counts.footer, `流入 ${count} 件`);
    assert.match(counts.detail, new RegExp(`本轮流入 ${count} 件`));
    assert.doesNotMatch(counts.detail, /尝试|通过/);
  }
});

test('station attempts, approvals, returns and current queue remain distinct', () => {
  const state = initialState(); let seq = 0;
  const emit = (event: unknown) => apply(state, { ...(event as object), seq: ++seq, at: seq, run: 'counter-fixture' } as Stamped);
  const key = 'curation/fact-review';
  emit({ kind: 'run.started', runId: 'counter-fixture', title: 'Counters' });
  emit({ kind: 'token.created', token: 'one', item: 'one', line: 'curation', source: 'fixture', url: 'https://fixture.test/' });
  for (const [index, ok, cancelled] of [[1, true, false], [2, false, false], [3, false, true]] as const) {
    emit({ kind: 'token.queued', token: 'one', node: key });
    emit({ kind: 'attempt.started', token: 'one', node: key, attempt: `a${index}`, worker: 'fixture', input: 'one' });
    emit({ kind: 'attempt.finished', attempt: `a${index}`, ok, cancelled, summary: 'Fixture result', ms: 1, queuedMs: 0 });
  }
  emit({ kind: 'review.verdict', token: 'one', node: key, verdict: 'pass', reason: 'Verified.' });
  emit({ kind: 'token.returned', token: 'one', from: key, to: 'curation/facts', round: 1, byHuman: false, reason: 'Fix source.' });
  emit({ kind: 'consult.opened', token: 'one', consult: 'fix', reviewer: key, owner: 'curation/facts', fields: ['facts.license'], problem: 'Fix scope.', round: 1 });
  emit({ kind: 'token.queued', token: 'one', node: key });
  const counts = nodeCountPresentation({ key, kind: 'review' }, state.nodes[key], state);
  assert.equal(counts.footer, '尝试 3 次');
  for (const text of ['审核通过 1 次', '退回 1 次', '要求修改 1 项', '执行异常 1 次', '取消 1 次', '当前排队 1 件', '进行中 0 次']) assert.ok(counts.detail.includes(text), text);
  emit({ kind: 'run.started', runId: 'next', title: 'Next run' });
  assert.equal(nodeCountPresentation({ key, kind: 'review' }, state.nodes[key], state).footer, '尝试 0 次');
});

function statusFixture() {
  const state = initialState(); let sequence = 0;
  const emit = (event: unknown) => apply(state, { ...(event as object), seq: ++sequence, at: sequence + 100, run: 'status-fixture' } as Stamped);
  emit({ kind: 'run.started', runId: 'status-fixture', title: 'Status' });
  const create = (id: string) => emit({ kind: 'token.created', token: id, item: id, line: 'curation', source: 'manual', url: '' });
  return { state, emit, create };
}

test('manual, failed and parked items never become a green completed batch', () => {
  const { state, emit, create } = statusFixture();
  for (const status of ['manual', 'failed', 'parked', 'published']) { create(status); emit({ kind: 'token.finished', token: status, node: `curation/${status}`, status, reason: 'fixture' }); }
  const display = runStatus(state, 200);
  assert.equal(display.label, '有待处理项'); assert.equal(display.light, 'yellow');
  assert.deepEqual(display.counts, { total: 4, active: 0, published: 1, merged: 0, rejected: 0, parked: 1, manual: 1, failed: 1 });
  assert.match(display.detail, /待重试 1.*待人工 1.*失败 1/);
});

test('model cooldown, trial and pending retry use the actual current batch state', () => {
  const { state, emit, create } = statusFixture();
  create('one'); emit({ kind: 'token.finished', token: 'one', node: 'curation/reader', status: 'parked', reason: 'transport' });
  emit({ kind: 'token.data', token: 'one', patch: { failure: { tag: 'model_transport' } } });
  state.batch = { runId: state.run.id, target: 10, maxInFlight: 1, intakeWindow: 1, maxRecoveries: 2, mode: 'running', startedAt: 101, modelCircuit: { state: 'open', failures: 1, nextAt: 32000 } };
  assert.equal(runStatus(state, 2000).label, '模型冷却'); assert.equal(tokenStatus(state.tokens.one, state, 2000).label, '模型冷却');
  state.batch.modelCircuit = { state: 'trial', failures: 1, nextAt: 0, trialToken: 'one' };
  assert.equal(runStatus(state, 2000).label, '验证模型恢复');
  state.batch.modelCircuit = undefined;
  emit({ kind: 'token.data', token: 'one', patch: { batchRecovery: { count: 1, nextAt: 32000, tag: 'network_timeout', station: 'curation/reader', replan: false } } });
  assert.equal(runStatus(state, 2000).label, '等待自动重试'); assert.equal(tokenStatus(state.tokens.one, state, 2000).label, '等待自动重试');
  emit({ kind: 'run.paused', runId: state.run.id });
  assert.equal(runStatus(state, 2000).label, '已暂停'); assert.equal(tokenStatus(state.tokens.one, state, 2000).label, '待重试');
});

test('a successful station result is not publication; waiting and scoped pause override stale summaries', () => {
  const { state, emit, create } = statusFixture();
  const reader = { key: 'curation/reader', line: 'curation', kind: 'agent' as const, resource: 'model' as const };
  const review = { ...reader, key: 'curation/review', kind: 'review' as const };
  create('one'); emit({ kind: 'token.queued', token: 'one', node: reader.key });
  emit({ kind: 'attempt.started', token: 'one', node: reader.key, attempt: 'a1', worker: 'w1', input: 'one' });
  emit({ kind: 'attempt.finished', attempt: 'a1', ok: true, summary: '已完成材料', ms: 5, queuedMs: 0 });
  assert.deepEqual(state.tokens.one.at, []);
  assert.equal(stationStatus(reader, state, 200).label, '待命'); assert.equal(stationStatus(reader, state, 200).light, 'idle');
  assert.equal(tokenStatus(state.tokens.one, state, 200).label, '等待调度');
  emit({ kind: 'token.queued', token: 'one', node: review.key });
  state.nodes[review.key].summary = '上一个任务完成'; state.resources.waiting[review.key] = '模型名额暂不可用';
  assert.equal(stationStatus(review, state, 200).label, '等待资源');
  assert.match(stationStatus(review, state, 200).detail, /模型名额暂不可用/);
  emit({ kind: 'scope.paused', scope: 'line', key: 'curation', paused: true, reason: 'owner' });
  assert.equal(stationStatus(review, state, 200).label, '已暂停'); assert.equal(tokenStatus(state.tokens.one, state, 200).label, '已暂停');
  emit({ kind: 'attempt.started', token: 'one', node: review.key, attempt: 'a2', worker: 'w2', input: 'already admitted' });
  assert.equal(stationStatus(review, state, 200).label, '在途收尾');
  assert.equal(runStatus(state, 200).counts.published, 0);
});

test('queued browser work names memory protection and preserves the pause and active states', () => {
  const {state, emit, create} = statusFixture();
  const browser = {key: 'curation/proof', line: 'curation', kind: 'agent' as const, resource: 'browser' as const};
  create('memory-wait');
  emit({kind: 'token.queued', token: 'memory-wait', node: browser.key});
  emit({kind: 'resource.sample', used: {browser: 0}, limits: {browser: 1, browserEffective: 0},
    freeMemMB: 2475, waiting: {[browser.key]: '空闲内存 2475MB < 3072MB'}});
  assert.equal(browserMemoryGuard(state.resources)?.label, '内存保护 · 浏览器 0/1');
  assert.match(browserMemoryGuard(state.resources)!.detail, /2475MB < 3072MB.*输入已保留.*用户暂停仍保持/);
  assert.equal(stationStatus(browser, state, 200).label, '等待内存');
  assert.match(stationStatus(browser, state, 200).detail, /2475MB < 3072MB.*排队 1 件.*自动/);
  assert.equal(state.run.status, 'running', 'resource protection does not report that the run has stopped');
  emit({kind: 'run.paused', runId: state.run.id});
  assert.equal(stationStatus(browser, state, 200).label, '已暂停');
  emit({kind: 'run.resumed', runId: state.run.id});
  state.resources.waiting[browser.key] = 'browser 0/0（内存不足，上限暂降自 1）';
  assert.equal(stationStatus(browser, state, 200).label, '等待内存');
  emit({kind: 'attempt.started', token: 'memory-wait', node: browser.key, attempt: 'memory-1', worker: 'fixture', input: ''});
  assert.equal(stationStatus(browser, state, 200).label, '处理中', 'a stale resource sample cannot hide a running attempt');
  emit({kind: 'resource.sample', used: {browser: 1}, limits: {browser: 1, browserEffective: 1},
    freeMemMB: 3305, waiting: {}});
  assert.equal(browserMemoryGuard(state.resources), undefined, 'the guard clears when the effective cap recovers');
  emit({kind: 'resource.sample', used: {browser: 0}, limits: {browser: 0, browserEffective: 0},
    freeMemMB: 3305, waiting: {}});
  assert.equal(browserMemoryGuard(state.resources), undefined, 'an explicitly disabled browser quota is not a memory guard');
});

test('unreported and estimated model usage stays unknown; an explicitly reported zero is zero', () => {
  const { state, emit, create } = statusFixture();
  create('one'); emit({ kind: 'attempt.started', token: 'one', node: 'curation/reader', attempt: 'a1', worker: 'w1', input: 'one' });
  const attempt = state.attempts.a1;
  assert.equal(recordedUsage([attempt]).total, null);
  attempt.usage.input = 100; attempt.metrics = { usageReported: false };
  assert.equal(recordedUsage([attempt]).total, null);
  attempt.usage.input = 0; attempt.metrics = { usageReported: true };
  assert.equal(recordedUsage([attempt]).total, 0);
  attempt.metrics = {usageReported: true, tokenUsage: {input: 84, output: 16}, costReported: false};
  assert.equal(recordedUsage([attempt]).total, 100, 'a token-only native receipt is not a default projection zero');
});

test('node execution labels distinguish actual receipts, requested bindings and plain programs', async () => {
  const {state, emit, create} = statusFixture();
  const node = {kind: 'agent' as const};
  const binding = {effective: {adapter: 'claude-code' as const, command: ['claude'], model: 'requested-model'}};
  assert.equal(nodeExecutionPresentation(node, undefined, binding).label, 'Claude Code · requested-model（配置）');
  assert.equal(nodeExecutionPresentation({kind: 'program'}, undefined, undefined).label, '程序执行');
  const assist = {...binding, mode: 'model-assist' as const};
  assert.equal(nodeExecutionPresentation({kind: 'program'}, undefined, assist).label, '程序 · 模型辅助 Claude Code · requested-model（配置）');
  assert.match(nodeExecutionPresentation(node, undefined, undefined).label, /待同步/);
  assert.match(nodeExecutionPresentation(node, undefined, binding, true).label, /历史执行模型未记录/);
  create('one');
  for (const [attempt, model] of [['old', 'old-model'], ['new', 'actual-model']] as const) {
    emit({kind: 'attempt.started', token: 'one', node: 'curation/reader', attempt, worker: 'fixture', input: ''});
    emit({kind: 'attempt.finished', attempt, ok: true, summary: '', ms: 1, queuedMs: 0, metrics: {execution: {adapter: 'claude-code', model}}});
  }
  const index = executionIndex(state);
  assert.equal(nodeExecutionPresentation(node, index['curation/reader'], binding).label, 'Claude Code · actual-model（实际）');
  recordNodeExecution(index, state.attempts.old);
  assert.equal(index['curation/reader'].model, 'actual-model', 'a late older receipt cannot replace the latest actual model');
  assert.equal(nodeExecutionPresentation(node, {...index['curation/reader'], model: 'unreported'}, binding).label, 'Claude Code · 模型未回报（实际）');
  emit({kind: 'attempt.started', token: 'one', node: 'curation/proof', attempt: 'assist', worker: 'fixture', input: ''});
  emit({kind: 'attempt.finished', attempt: 'assist', ok: true, summary: '', ms: 1, queuedMs: 0,
    metrics: {modelResponses: [{dependency: {key: 'fixture-native', adapter: 'codex', model: 'requested'},
      model: 'actual-helper-model', modelCalls: 1, usageReported: false}]}});
  recordNodeExecution(index, state.attempts.assist);
  assert.equal(nodeExecutionPresentation({kind: 'program'}, index['curation/proof'], assist).label,
    '程序 · 模型辅助 Codex · actual-helper-model（实际）');
  const store = await import('../src/store.ts');
  const previous = store.getState();
  try {
    store.setState({fs: state});
    assert.equal(store.getState().nodeExecutions['curation/reader'].model, 'actual-model');
    store.setState({fs: initialState()});
    assert.deepEqual(store.getState().nodeExecutions, {}, 'loading an earlier replay cannot retain a future actual-model receipt');
  } finally {
    store.setState(previous);
  }
});

test('runtime recovery summaries preserve only the v1 status metadata through snapshots and events', () => {
  const {state, emit, create} = statusFixture();
  create('recovering');
  const plan = {version: 1, runId: state.run.id, kind: 'network', state: 'waiting', station: 'curation/capture',
    nextAt: 5000, networkAttempts: 1, modelFailures: 0, failureAttempt: 'failed-1', reason: 'Connection timeout',
    startedAt: 1000, deadlineAt: 61000, attempts: 1,
    policy: {tags: ['network_timeout'], maxRetries: 5, backoff: {initialMs: 2000, factor: 2, maxMs: 30000, jitter: 0.2},
      deadlineMs: 60000, exhausted: 'manual'}};
  emit({kind: 'token.data', token: 'recovering', patch: {__runtimeRecovery: {...plan, internalPayload: 'x'.repeat(100000)}}});
  const summary = uiState(state);
  assert.deepEqual(summary.tokens.recovering.data.__runtimeRecovery, plan);
  const completed = {...plan, state: 'completed', nextAt: 0};
  applyUiEvent(summary, uiEvent({kind: 'token.data', token: 'recovering', patch: {__runtimeRecovery: completed}, seq: summary.seq + 1, at: 200, run: state.run.id}));
  assert.deepEqual(summary.tokens.recovering.data.__runtimeRecovery, completed);
  applyUiEvent(summary, uiEvent({kind: 'token.data', token: 'recovering', patch: {__runtimeRecovery: null}, seq: summary.seq + 1, at: 201, run: state.run.id}));
  assert.equal(summary.tokens.recovering.data.__runtimeRecovery, null, 'clearing a plan cannot keep a stale automatic recovery label');
});

test('model recovery follows the matching service circuit without clearing other services', () => {
  const {state, emit, create} = statusFixture();
  state.batch = {runId: state.run.id, target: 20, maxInFlight: 4, intakeWindow: 1, maxRecoveries: 2, mode: 'running', startedAt: 101};
  const serviceA = {key: 'pi:service-a', adapter: 'pi', provider: 'provider-a', model: 'model-a'} as const;
  const serviceB = {key: 'pi:service-b', adapter: 'pi', provider: 'provider-b', model: 'model-b'} as const;
  const recovery = (dependency: typeof serviceA | typeof serviceB) => ({version: 1, runId: state.run.id, kind: 'model', state: 'waiting',
    station: 'curation/reader', nextAt: 4000, networkAttempts: 0, modelFailures: 1, failureAttempt: 'failed-model', dependency});
  for (const [id, dependency] of [['a', serviceA], ['a2', serviceA], ['b', serviceB]] as const) {
    create(id);
    emit({kind: 'token.finished', token: id, node: 'curation/reader', status: 'parked', reason: 'Transport unavailable'});
    emit({kind: 'token.data', token: id, patch: {__runtimeRecovery: recovery(dependency)}});
  }
  emit({kind: 'model.circuit', key: serviceA.key, circuit: {dependency: serviceA, state: 'open', failures: 3, nextAt: 31000, runId: state.run.id, reason: 'A is cooling'}});
  emit({kind: 'model.circuit', key: serviceB.key, circuit: {dependency: serviceB, state: 'open', failures: 1, nextAt: 5000, runId: state.run.id, reason: 'B is cooling'}});
  const compact = uiState(state);
  assert.deepEqual(compact.tokens.a.data.__runtimeRecovery, recovery(serviceA));
  assert.match(tokenStatus(compact.tokens.a, compact, 1000).detail, /30 秒后.*provider-a \/ model-a.*3 次/);
  assert.match(tokenStatus(compact.tokens.b, compact, 1000).detail, /4 秒后.*provider-b \/ model-b.*1 次/);
  const update = (event: unknown) => applyUiEvent(compact, uiEvent({...event as object, seq: compact.seq + 1, at: 1500, run: state.run.id} as Stamped));
  update({kind: 'model.circuit', key: serviceA.key, circuit: {...compact.modelCircuits[serviceA.key], state: 'trial', trialToken: 'a', nextAt: 0}});
  assert.equal(tokenStatus(compact.tokens.a2, compact, 2000).label, '等待服务验证');
  assert.equal(tokenStatus(compact.tokens.b, compact, 2000).label, '模型冷却');
  update({kind: 'model.circuit', key: serviceA.key, circuit: null});
  update({kind: 'token.data', token: 'a', patch: {__runtimeRecovery: {...recovery(serviceA), state: 'completed', nextAt: 0}}});
  assert.equal(compact.modelCircuits[serviceA.key], undefined);
  assert.ok(compact.modelCircuits[serviceB.key]);
  assert.equal(tokenStatus(compact.tokens.a, compact, 2000).label, '待重试', 'connection recovery alone is not publication');
  assert.equal(tokenStatus(compact.tokens.b, compact, 2000).label, '模型冷却');
  update({kind: 'resource.sample', used: {browser: 0, model: 1, cpu: 1, http: 0}, waiting: {}, freeGB: 3, browserEffective: 2, modelRequests: {active: 1, queued: 2, limit: 1}});
  assert.deepEqual(compact.resources.modelRequests, {active: 1, queued: 2, limit: 1});
});

test('network recovery waits, pauses, attempts and completion remain separate from task publication', () => {
  const {state, emit, create} = statusFixture();
  const node = {key: 'curation/capture', line: 'curation', kind: 'program' as const, resource: 'browser' as const};
  create('one');
  emit({kind: 'token.finished', token: 'one', node: node.key, status: 'parked', reason: 'Original timeout'});
  const plan = {version: 1, runId: state.run.id, kind: 'network', state: 'waiting', station: node.key,
    nextAt: 5000, networkAttempts: 0, modelFailures: 0, failureAttempt: 'failed-1'};
  emit({kind: 'token.data', token: 'one', patch: {__runtimeRecovery: plan}});
  const station = () => stationStatus(node, state, 1000, false, runtimeRecoveryIndex(state)[node.key]);
  assert.equal(station().label, '等待自动恢复');
  assert.match(station().detail, /最早 4 秒后.*Original timeout.*0 次.*未记录上限/);
  assert.equal(runStatus(state, 1000).label, '等待自动恢复');
  assert.equal(tokenStatus(state.tokens.one, state, 6000).label, '等待恢复条件');
  emit({kind: 'scope.paused', scope: 'station', key: node.key, paused: true, reason: 'Inspect'});
  assert.equal(station().label, '已暂停');
  assert.equal(tokenStatus(state.tokens.one, state, 6000).label, '恢复已暂停');
  assert.doesNotMatch(tokenStatus(state.tokens.one, state, 6000).detail, /秒后/);
  emit({kind: 'scope.paused', scope: 'station', key: node.key, paused: false, reason: 'Continue'});
  emit({kind: 'token.created', token: 'retry', item: 'one', line: 'curation', source: 'manual', url: ''});
  emit({kind: 'token.data', token: 'one', patch: {retriedBy: 'retry'}});
  emit({kind: 'token.data', token: 'retry', patch: {__runtimeRecovery: {...plan, state: 'trial', nextAt: 0, networkAttempts: 1}}});
  emit({kind: 'token.queued', token: 'retry', node: node.key});
  assert.deepEqual(runtimeRecoveryIndex(state)[node.key], ['retry']);
  assert.equal(tokenStatus(state.tokens.one, state, 6000).label, '已接续重试');
  assert.equal(tokenStatus(state.tokens.retry, state, 6000).label, '等待恢复验证');
  assert.equal(station().pulse, false);
  emit({kind: 'attempt.started', token: 'retry', node: node.key, attempt: 'recovery-trial', worker: 'fixture', input: ''});
  assert.equal(station().label, '正在自动恢复');
  assert.equal(station().pulse, true);
  emit({kind: 'attempt.finished', attempt: 'recovery-trial', ok: true, summary: 'Recovered station', ms: 1, queuedMs: 0});
  emit({kind: 'token.data', token: 'retry', patch: {__runtimeRecovery: {...plan, state: 'completed', nextAt: 0, networkAttempts: 1}}});
  assert.deepEqual(runtimeRecoveryIndex(state), {});
  assert.equal(tokenStatus(state.tokens.retry, state, 6000).label, '等待调度');
  assert.equal(runStatus(state, 6000).counts.published, 0);
  emit({kind: 'token.finished', token: 'retry', node: 'curation/published', status: 'published', reason: 'Published'});
  assert.equal(tokenStatus(state.tokens.retry, state, 6000).label, '已发布');
});

test('declared recovery uses its captured budget and wall-clock deadline instead of legacy limits', () => {
  const {state, emit, create} = statusFixture();
  const node = {key: 'curation/capture', line: 'curation', kind: 'program' as const, resource: 'browser' as const};
  const policy = {tags: ['network_timeout'] as const, maxRetries: 5,
    backoff: {initialMs: 2000, factor: 2, maxMs: 30000, jitter: 0.2}, deadlineMs: 60000, exhausted: 'manual'};
  const plan = {version: 1, runId: state.run.id, kind: 'network', state: 'waiting', station: node.key,
    nextAt: 5000, networkAttempts: 1, modelFailures: 0, failureAttempt: 'failed-policy',
    policy, startedAt: 1000, deadlineAt: 61000, attempts: 3};
  create('policy');
  emit({kind: 'token.finished', token: 'policy', node: node.key, status: 'parked', reason: 'Retained evidence'});
  emit({kind: 'token.data', token: 'policy', patch: {__runtimeRecovery: plan}});
  emit({kind: 'batch.configured', batch: {runId: state.run.id, target: 100, maxInFlight: 3,
    intakeWindow: 1, maxRecoveries: 2, mode: 'running', startedAt: state.run.startedAt}});
  const compact = uiState(state);
  assert.deepEqual(tokenStatus(compact.tokens.policy, compact, 1000), tokenStatus(state.tokens.policy, state, 1000),
    'the compact snapshot and full state describe the same persisted recovery plan');
  assert.equal(tokenStatus(compact.tokens.policy, compact, 1000).label, '等待自动恢复');
  assert.match(tokenStatus(compact.tokens.policy, compact, 1000).detail, /3\/5 次/);
  assert.match(tokenStatus(compact.tokens.policy, compact, 1000).detail, /截止.*墙钟.*暂停/);
  assert.doesNotMatch(tokenStatus(compact.tokens.policy, compact, 1000).detail, /1\/2|3\/2/);

  compact.pausedScopes = {lines: ['curation'], stations: []};
  const paused = tokenStatus(compact.tokens.policy, compact, 62000);
  assert.equal(paused.label, '恢复已暂停');
  assert.match(paused.detail, /期限已到/);
  assert.match(paused.detail, /3\/5 次/);
  compact.pausedScopes = {lines: [], stations: []};
  assert.equal(tokenStatus(compact.tokens.policy, compact, 62000).label, '恢复期限已到');
  assert.equal(compact.tokens.policy.status, 'parked', 'displaying an elapsed deadline cannot synthesize a manual disposition');

  compact.tokens.policy.data.__runtimeRecovery = {...plan, state: 'exhausted'};
  assert.equal(tokenStatus(compact.tokens.policy, compact, 62000).label, '自动恢复已耗尽');
  compact.tokens.policy.status = 'manual';
  assert.equal(tokenStatus(compact.tokens.policy, compact, 62000).label, '待人工');
  assert.match(tokenStatus(compact.tokens.policy, compact, 62000).detail, /自动恢复已耗尽.*3\/5 次/);
});

test('custom model recovery waits for both its persisted delay and matching circuit without inventing old budgets', () => {
  const {state, emit, create} = statusFixture();
  const dependency = {key: 'pi:policy-service', adapter: 'pi', provider: 'fixture', model: 'fixture'} as const;
  const policy = {tags: ['model_transport'], maxRetries: 4,
    backoff: {initialMs: 1000, factor: 2, maxMs: 30000}, exhausted: 'parked'};
  const plan = {version: 1, runId: state.run.id, kind: 'model', state: 'waiting', station: 'curation/reader',
    nextAt: 21000, networkAttempts: 0, modelFailures: 7, failureAttempt: 'model-policy', dependency,
    policy, startedAt: 1000, attempts: 2};
  create('model-policy');
  emit({kind: 'token.finished', token: 'model-policy', node: plan.station, status: 'parked', reason: 'Transport unavailable'});
  emit({kind: 'token.data', token: 'model-policy', patch: {__runtimeRecovery: plan}});
  emit({kind: 'model.circuit', key: dependency.key, circuit: {dependency, state: 'open', failures: 7,
    nextAt: 5000, runId: state.run.id}});
  assert.match(tokenStatus(state.tokens['model-policy'], state, 1000).detail, /最早 20 秒后.*2\/4 次/);
  state.modelCircuits[dependency.key].nextAt = 31000;
  assert.match(tokenStatus(state.tokens['model-policy'], state, 1000).detail, /最早 30 秒后.*2\/4 次/);
  state.tokens['model-policy'].data.__runtimeRecovery = {...plan, policy: null, attempts: undefined};
  const legacy = tokenStatus(state.tokens['model-policy'], state, 1000);
  assert.match(legacy.detail, /7 次模型暂态失败/);
  assert.doesNotMatch(legacy.detail, /2\/4|\/2 次|截止/);
  state.tokens['model-policy'].data.__runtimeRecovery = {...plan, policy: {...policy, maxRetries: -1}};
  assert.equal(tokenStatus(state.tokens['model-policy'], state, 1000).label, '待重试', 'invalid policy data cannot promise automatic execution');
});

test('website batch state does not hide or pause independent pack and channel recovery', () => {
  const {state, emit, create} = statusFixture();
  for (const [id, patch] of [['pack', {workflowPack: 'fixture'}], ['channel', {channelDelivery: 'delivery-fixture'}]] as const) {
    create(id);
    emit({kind: 'token.data', token: id, patch: {...patch, __runtimeRecovery: {
      version: 1, runId: state.run.id, kind: 'network', state: 'waiting', station: 'curation/capture',
      nextAt: 5000, networkAttempts: 1, modelFailures: 0, failureAttempt: `${id}-failure`,
    }}});
    emit({kind: 'token.finished', token: id, node: 'curation/capture', status: 'parked', reason: 'Network failure'});
  }
  for (const mode of ['running', 'paused', 'stopped'] as const) {
    emit({kind: 'batch.configured', batch: {runId: state.run.id, target: 100, maxInFlight: 3,
      intakeWindow: 1, maxRecoveries: 2, mode, startedAt: state.run.startedAt}});
    const compact = uiState(state);
    for (const id of ['pack', 'channel']) {
      assert.equal(tokenStatus(compact.tokens[id], compact, 1000).label, '等待自动恢复');
    }
    assert.equal(runStatus(compact, 1000).label, '等待自动恢复');
  }
  emit({kind: 'run.paused', runId: state.run.id});
  assert.equal(tokenStatus(state.tokens.pack, state, 1000).label, '恢复已暂停');
  assert.equal(runStatus(state, 1000).label, '已暂停');
});

test('model trial, blocked and exhausted recovery preserve reasons without reviving old or completed work', () => {
  const {state, emit, create} = statusFixture();
  const node = {key: 'curation/reader', line: 'curation', kind: 'agent' as const, resource: 'model' as const};
  create('one');
  emit({kind: 'token.finished', token: 'one', node: node.key, status: 'parked', reason: 'Transport failure'});
  const plan = {version: 1, runId: state.run.id, kind: 'model', state: 'waiting', station: node.key,
    nextAt: 60000, networkAttempts: 0, modelFailures: 4, failureAttempt: 'failed-model'};
  emit({kind: 'token.data', token: 'one', patch: {__runtimeRecovery: plan}});
  assert.equal(tokenStatus(state.tokens.one, state, 1000).label, '模型冷却');
  emit({kind: 'run.paused', runId: state.run.id});
  assert.equal(tokenStatus(state.tokens.one, state, 1000).label, '恢复已暂停');
  assert.equal(runStatus(state, 1000).label, '已暂停');
  emit({kind: 'run.resumed', runId: state.run.id});
  create('model-trial');
  emit({kind: 'token.data', token: 'model-trial', patch: {__runtimeRecovery: {...plan, state: 'trial', nextAt: 0}}});
  emit({kind: 'token.queued', token: 'model-trial', node: node.key});
  assert.equal(tokenStatus(state.tokens['model-trial'], state, 1000).label, '等待恢复验证');
  emit({kind: 'attempt.started', token: 'model-trial', node: node.key, attempt: 'model-check', worker: 'fixture', input: ''});
  assert.equal(tokenStatus(state.tokens['model-trial'], state, 1000).label, '验证模型恢复');
  emit({kind: 'scope.paused', scope: 'station', key: node.key, paused: true, reason: 'Pause receiving'});
  assert.equal(tokenStatus(state.tokens['model-trial'], state, 1000).label, '在途收尾');
  emit({kind: 'scope.paused', scope: 'station', key: node.key, paused: false, reason: 'Continue'});
  emit({kind: 'attempt.finished', attempt: 'model-check', ok: true, summary: 'Verified', ms: 1, queuedMs: 0});
  emit({kind: 'token.finished', token: 'model-trial', node: 'curation/published', status: 'published', reason: 'Published'});
  for (const [phase, reason, expected] of [['blocked', '缺少持久检查点', '自动恢复受阻'], ['exhausted', '恢复两次后仍连接失败', '自动恢复次数耗尽']]) {
    emit({kind: 'token.data', token: 'one', patch: {__runtimeRecovery: {...plan, state: phase, reason, nextAt: 0}}});
    assert.equal(tokenStatus(state.tokens.one, state, 1000).label, expected);
    assert.match(runStatus(state, 1000).detail, new RegExp(reason));
  }
  const indexed = runtimeRecoveryIndex(state)[node.key];
  const withoutScan = {...state, tokens: new Proxy(state.tokens, {ownKeys() {throw new Error('station status must not scan every token');}})};
  assert.equal(stationStatus(node, withoutScan, 1000, false, indexed).label, '自动恢复次数耗尽');
  create('healthy');
  emit({kind: 'token.queued', token: 'healthy', node: node.key});
  const queued = stationStatus(node, state, 1000, false, runtimeRecoveryIndex(state)[node.key]);
  assert.equal(queued.label, '排队中', 'one exhausted task does not claim the healthy queue is blocked');
  assert.match(queued.detail, /恢复两次后仍连接失败/);
  assert.equal(runStatus(state, 1000).label, '运行中');
  assert.equal(runStatus(state, 1000).light, 'yellow');
  assert.match(runStatus(state, 1000).detail, /恢复两次后仍连接失败/);
  state.resources.waiting[node.key] = '模型资源暂不可用';
  assert.equal(runStatus(state, 1000).label, '等待调度条件');
  assert.notEqual(runStatus(state, 1000).light, 'red');
  emit({kind: 'token.data', token: 'one', patch: {__runtimeRecovery: {...plan, runId: 'old-run'}}});
  assert.deepEqual(runtimeRecoveryIndex(state), {});
  assert.equal(tokenStatus(state.tokens.one, state, 1000).label, '待重试');
  emit({kind: 'token.data', token: 'one', patch: {__runtimeRecovery: plan}});
  emit({kind: 'token.finished', token: 'one', node: 'curation/published', status: 'published', reason: 'Real publication'});
  assert.equal(tokenStatus(state.tokens.one, state, 1000).label, '已发布');
  assert.deepEqual(runtimeRecoveryIndex(state), {});
  emit({kind: 'run.started', runId: 'new-run', title: 'New'});
  assert.equal(tokenStatus(state.tokens.healthy, state, 1000).label, '历史未完成');
});
