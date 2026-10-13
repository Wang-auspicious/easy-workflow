import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, initialState } from '../../shared/project.ts';
import type { Stamped } from '../../shared/types.ts';
import { nodeCountPresentation } from '../src/canvas/node-counts.ts';
import { recordedUsage, runStatus, stationStatus, tokenStatus } from '../src/canvas/status.ts';

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

test('unreported and estimated model usage stays unknown; an explicitly reported zero is zero', () => {
  const { state, emit, create } = statusFixture();
  create('one'); emit({ kind: 'attempt.started', token: 'one', node: 'curation/reader', attempt: 'a1', worker: 'w1', input: 'one' });
  const attempt = state.attempts.a1;
  assert.equal(recordedUsage([attempt]).total, null);
  attempt.usage.input = 100; attempt.metrics = { usageReported: false };
  assert.equal(recordedUsage([attempt]).total, null);
  attempt.usage.input = 0; attempt.metrics = { usageReported: true };
  assert.equal(recordedUsage([attempt]).total, 0);
});
