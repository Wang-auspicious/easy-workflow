import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, initialState } from '../../shared/project.ts';
import type { Stamped } from '../../shared/types.ts';
import { nodeCountPresentation } from '../src/canvas/node-counts.ts';

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
