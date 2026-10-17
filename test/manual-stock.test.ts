import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-manual-stock-'));
process.env.FACTORY_VAR = dir;
process.env.FACTORY_PREFLIGHT = '0';
process.env.VISLEXICON_ROOT = path.join(dir, 'unconnected');
const { Factory } = await import('../server/factory.ts');
const { Journal } = await import('../server/journal.ts');
const {manualOwner, manualQueue} = await import('../shared/project.ts');
const {manualReview} = await import('../server/manual-review.ts');
const {FactoryControl} = await import('../server/control.ts');
const close = async (factory: InstanceType<typeof Factory>) => {
  await factory.runtime?.close(); factory.docs?.flush(); factory.lessons?.close(); factory.journal.close();
};

test('manual inventory reconciles migrated historical failures without changing their disposition or audit', async () => {
  const journal = new Journal(path.join(dir, 'journal.db'));
  journal.append({ kind: 'run.started', runId: 'run-manual-stock', title: 'legacy migration' });
  for (let i = 0; i < 7; i++) {
    const token = `legacy-${i}`, item = `site-${i}`;
    journal.append({ kind: 'token.created', token, item, url: `https://${item}.example`, line: 'curation', source: 'manual' });
    journal.append({ kind: 'token.finished', token, node: 'curation/manual', status: 'manual', reason: 'legacy screenshot timeout' });
    journal.append({ kind: 'stock.set', node: 'curation/manual', stock: i + 1 });
    journal.append({ kind: 'candidate.disposition', candidate: { token, item, url: `https://${item}.example`, title: item, source: 'manual', disposition: 'retry', failure: { tag: 'browser_capture', category: 'system', retryable: true, message: 'legacy screenshot timeout' } } });
  }
  journal.append({ kind: 'token.created', token: 'real-manual', item: 'needs-human', url: 'https://fixture.example', line: 'curation', source: 'manual' });
  journal.append({ kind: 'token.finished', token: 'real-manual', node: 'curation/manual', status: 'manual', reason: 'A real unresolved content decision' });
  journal.append({ kind: 'stock.set', node: 'curation/manual', stock: 8 });
  journal.append({ kind: 'run.ended', runId: journal.run, manual: true }); journal.close();
  let factory = new Factory();
  try {
    await factory.boot();
    assert.equal(factory.state.nodes['curation/manual'].stock, 1, 'migrated failures no longer occupy the manual store');
    assert.equal(factory.runtime.stock.get('curation/manual'), 1);
    assert.equal(factory.state.tokens['real-manual'].status, 'manual');
    assert.equal(factory.state.tokens['real-manual'].reason, 'A real unresolved content decision');
    assert.equal(factory.state.nodes['curation/manual'].plus, 8, 'historical arrivals remain auditable');
    assert.equal(Object.values(factory.state.recoveries).filter(c => c.disposition === 'retry').length, 7);
    const corrections = [...factory.journal.read()].filter(e => e.kind === 'stock.set' && e.node === 'curation/manual' && e.stock === 1).length;
    await close(factory); factory = new Factory(); await factory.boot();
    assert.equal(factory.state.nodes['curation/manual'].stock, 1);
    assert.equal([...factory.journal.read()].filter(e => e.kind === 'stock.set' && e.node === 'curation/manual' && e.stock === 1).length, corrections, 'boot reconciliation is idempotent');
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('moving a manual item back to recovery removes its stock once and preserves the arrival counter', async () => {
  const factory = new Factory();
  try {
    await factory.boot(); factory.runtime.start('live inventory');
    factory.runtime.executors = () => async () => ({ ok: true, summary: 'needs judgment', verdict: { verdict: 'escalate', reason: 'Needs an owner decision' } });
    const token = factory.runtime.create('curation/audit', { item: 'live-manual', url: 'https://fixture.example', source: 'manual' });
    await factory.runtime.settle();
    assert.equal(factory.state.nodes['curation/manual'].stock, 1);
    const disposition = { kind: 'candidate.disposition' as const, candidate: { token: token.id, item: token.item, url: token.url, title: token.item, source: token.source, disposition: 'retry' as const, failure: { tag: 'tool_error' as const, category: 'system' as const, retryable: true, message: 'Confirmed system defect fixed; ready to retry' } } };
    factory.journal.append(disposition); await Promise.resolve();
    assert.equal(factory.state.nodes['curation/manual'].stock, 0);
    assert.equal(factory.runtime.stock.get('curation/manual'), 0);
    assert.equal(factory.state.nodes['curation/manual'].plus, 1);
    factory.journal.append(disposition); await Promise.resolve();
    assert.equal(factory.state.nodes['curation/manual'].stock, 0);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an independent channel child cannot hide its unresolved parent manual inventory', async () => {
  const factory = new Factory();
  try {
    await factory.boot();
    factory.journal.append({ kind: 'token.created', token: 'manual-parent', item: 'shared-item', url: '', line: 'curation', source: 'manual' });
    factory.journal.append({ kind: 'token.finished', token: 'manual-parent', node: 'curation/manual', status: 'manual', reason: 'Unresolved website review' });
    factory.journal.append({ kind: 'token.created', token: 'active-child', item: 'shared-item', url: '', line: 'components', source: 'channel:components' });
    factory.journal.append({ kind: 'token.data', token: 'active-child', patch: { channelDelivery: 'delivery-manual-stock' } });
    factory.journal.append({ kind: 'token.queued', token: 'active-child', node: 'components/discover' });
    factory.reconcileManualStock();
    assert.equal(factory.state.nodes['curation/manual'].stock, 1);
    assert.equal(factory.state.tokens['manual-parent'].status, 'manual');
    assert.equal(factory.state.tokens['active-child'].status, 'active');
    assert.equal(manualQueue(factory.state).length, 1, 'the UI and triage keep the independent parent');
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('manual triage stays bounded and omits completed retry parents without erasing their audit', async () => {
  const factory = new Factory();
  try {
    await factory.boot();
    factory.journal.append({kind: 'token.created', token: 'old-manual', item: 'same-site', url: '', line: 'candidates', source: 'fixture'});
    factory.journal.append({kind: 'token.data', token: 'old-manual', patch: {manualReason: '没有 pages[]', factPages: ['very long dossier '.repeat(100000)]}});
    factory.journal.append({kind: 'token.finished', token: 'old-manual', node: 'curation/manual', status: 'manual', reason: '没有 pages[]'});
    const detail = await manualReview(factory, {token: 'old-manual'});
    assert.equal(detail.recommendation?.station, 'curation/assemble', 'candidate-origin curation work retains its true repair owner');
    assert.ok(Buffer.byteLength(JSON.stringify(detail)) < 12000, 'unrelated dossier text cannot crowd out the repair fields');
    assert.equal(manualOwner(factory.state.tokens['old-manual']), 'agent');
    factory.state.tokens['old-manual'].data.failure = {owner: 'user', category: 'auth', message: 'Old login problem'};
    assert.equal(manualOwner(factory.state.tokens['old-manual']), 'agent', 'an obsolete login error cannot turn a current capture issue into an owner decision');
    assert.equal(manualOwner({...factory.state.tokens['old-manual'], reason: '本次为站长授权修复，居中拍Description经Style 54 styles选择区到Generate按钮全套'}), 'agent');
    assert.equal(manualOwner({...factory.state.tokens['old-manual'], reason: '需要用户选择分类归属'}), 'human');
    factory.journal.append({kind: 'token.created', token: 'new-published', item: 'same-site', url: '', line: 'curation', source: 'fixture'});
    factory.journal.append({kind: 'token.data', token: 'old-manual', patch: {retriedBy: 'new-published'}});
    factory.journal.append({kind: 'token.finished', token: 'new-published', node: 'curation/published', status: 'published', reason: 'repaired'});
    assert.equal(manualQueue(factory.state).length, 0);
    const queue = await manualReview(factory);
    assert.ok('total' in queue);
    assert.equal(queue.total, 0);
    assert.equal(factory.state.tokens['old-manual'].status, 'manual', 'historical result is retained');
    assert.equal((await manualReview(factory, {token: 'old-manual'})).successor?.token, 'new-published');
    const results = await manualReview(factory, {tokens: ['old-manual', 'new-published']});
    assert.ok('counts' in results && 'results' in results);
    assert.deepEqual(results.counts, {published: 2});
    assert.equal(results.results?.[0].successor, 'new-published');
    const completed = await manualReview(factory, {token: 'new-published'});
    assert.equal(completed.recommendation?.category, 'resolved');
    assert.equal(completed.reason, '');
    factory.journal.append({kind: 'token.created', token: 'new-technical', item: 'capture-only', url: 'https://fixture.example/', line: 'curation', source: 'fixture'});
    factory.journal.append({kind: 'token.finished', token: 'new-technical', node: 'curation/proof', status: 'parked', reason: '特写定位失败，identity/breadth 复用已有证据'});
    const parked = await manualReview(factory, {token: 'new-technical'});
    assert.equal(parked.recommendation?.station, 'curation/proof');
    assert.equal(parked.reason, '特写定位失败，identity/breadth 复用已有证据', 'parked failures remain visible in compact triage');
    assert.deepEqual(parked.recovery?.manualCorrections, {used: 0, max: 3, remaining: 3});
    const responsibility = await manualReview(factory, {tokens: ['new-published', 'new-technical']});
    assert.ok('needsUser' in responsibility && 'agentPending' in responsibility);
    assert.equal(responsibility.needsUser, 0);
    assert.equal(responsibility.agentPending, 1);
    factory.journal.append({kind: 'token.resumed', token: 'new-published', node: 'curation/audit', reason: 'fixture continuation'});
    assert.equal((await manualReview(factory, {token: 'new-published'})).recommendation?.category, 'running');
  } finally {await close(factory); fs.rmSync(dir, {recursive: true, force: true});}
});

test('v1 handoff continuation keeps sessions, bounded budgets and independent review across restart', async () => {
  let factory = new Factory();
  const session = {file: 'work/agent-sessions/fixture.json', signature: 'fixture'};
  const handoff = {done: ['read source'], evidence: ['fixture source'], remaining: ['independent review'], suggestion: 'Finish the saved review'};
  const budget = {maxTokens: 60_000, maxMs: 900_000};
  const report = {budget, actualTokens: 55_000, actualMs: 10, rounds: 1, reminders: 0, repairs: 0, ending: 'handoff' as const};
  try {
    await factory.boot();
    factory.runtime.start('bounded handoff');
    factory.runtime.executors = () => async () => ({ok: false, summary: 'saved handoff', handoff, agentContract: report,
      sessionCheckpoint: {pi: session}, data: {unsubmitted: 'must not leak into business data'}});
    const token = factory.runtime.create('curation/audit', {item: 'handoff-fixture', url: '', source: 'fixture'});
    await factory.runtime.settle();
    assert.equal(factory.state.tokens[token.id].status, 'manual');
    assert.equal(token.data.unsubmitted, undefined);
    assert.equal((await manualReview(factory, {token: token.id})).recommendation?.category, 'handoff');
    const rounds = {...token.rounds};
    factory.runtime.pause();
    assert.deepEqual(factory.resumeAgentHandoff(token.id, 'curation/audit').budget, {maxTokens: 120_000, maxMs: 1_800_000});
    assert.throws(() => factory.resumeAgentHandoff(token.id, 'curation/audit'), {code: 'not_waiting_budget'});
    await close(factory);
    factory = new Factory();
    await factory.boot();
    let reviewed = false;
    factory.runtime.executors = () => async ctx => {
      reviewed = true;
      assert.deepEqual(ctx.agentBudget, {maxTokens: 120_000, maxMs: 1_800_000});
      assert.deepEqual((ctx.token.data.stationSessions as Record<string, unknown>)['curation/audit'], session);
      assert.deepEqual(ctx.token.rounds, rounds);
      return {ok: true, summary: 'independent review passed', finish: {status: 'published', reason: 'fixture'}};
    };
    factory.runtime.resume();
    await factory.runtime.settle();
    assert.equal(reviewed, true);
    assert.equal(factory.state.tokens[token.id].status, 'published');
    assert.throws(() => factory.resumeAgentHandoff(token.id, 'curation/audit'), {code: 'not_waiting_budget'});

    factory.runtime.executors = () => async ctx => ({ok: false, summary: 'still needs work', handoff,
      agentContract: {...report, budget: ctx.agentBudget ?? budget}, sessionCheckpoint: {pi: session}});
    const exhausted = factory.runtime.create('curation/audit', {item: 'handoff-limits', url: '', source: 'fixture'});
    await factory.runtime.settle();
    for (let count = 1; count <= 2; count++) {
      const receipt = factory.resumeAgentHandoff(exhausted.id, 'curation/audit');
      assert.equal(receipt.continuation, count);
      assert.ok(receipt.budget.maxTokens <= 128_000);
      assert.ok(receipt.budget.maxMs <= 1_800_000);
      await factory.runtime.settle();
    }
    assert.throws(() => factory.resumeAgentHandoff(exhausted.id, 'curation/audit'), {code: 'handoff_continuation_limit'});
    assert.equal(factory.state.tokens[exhausted.id].status, 'manual', 'exhaustion cannot manufacture an approval');
  } finally {await close(factory); fs.rmSync(dir, {recursive: true, force: true});}
});

test('automatic review returns do not consume the separate bounded manual correction allowance', async () => {
  const factory = new Factory();
  try {
    await factory.boot();
    factory.runtime.start('separate correction budget');
    factory.runtime.pause();
    const token = factory.runtime.create('curation/proof', {item: 'correction-bounds', url: 'https://fixture.example/', source: 'fixture'});
    const control = new FactoryControl(factory);
    const beforeInvalid = [...factory.journal.read()].length;
    await assert.rejects(control.execute('correct', {token: token.id, station: 'curation/proof', revisit: true,
      reason: 'Reject invented foreign source before consuming a repair', captureTarget: {role: 'proof', url: 'https://unrelated.example/demo', locate: 'Actual demo'}}, 'dispatcher'), {code: 'invalid_capture_target'});
    assert.equal([...factory.journal.read()].length, beforeInvalid, 'invalid source cannot write corrections or attempts');
    assert.equal(token.rounds['manual:curation/proof'], undefined);
    token.rounds['curation/proof'] = 2;
    assert.deepEqual(factory.runtime.manualCorrectionBudget(token.id, 'curation/proof'), {used: 0, max: 3, remaining: 3});
    for (let count = 1; count <= 3; count++) {
      assert.equal(factory.runtime.correct({token: token.id, node: 'curation/proof'}, 'new concrete repair').ok, true);
      assert.equal(token.rounds['manual:curation/proof'], count);
      assert.equal(factory.runtime.manualCorrectionBudget(token.id, 'curation/proof').remaining, 3 - count);
    }
    assert.equal(factory.runtime.correct({token: token.id, node: 'curation/proof'}, 'fourth repair is bounded').ok, false);
    assert.equal(token.rounds['curation/proof'], 5, 'automatic history is retained, never reset');
    assert.equal(factory.state.tokens[token.id].status, 'active', 'a refused correction cannot cancel queued work or overwrite its real failure');
    const corrections = Object.keys(factory.state.corrections ?? {}).length;
    const skipped = await control.execute('correct', {token: token.id, station: 'curation/proof', reason: 'Accidental duplicate queue-cleanup command'}, 'dispatcher');
    assert.equal(skipped.result.skipped, true);
    assert.equal(Object.keys(factory.state.corrections ?? {}).length, corrections);
    factory.journal.append({kind: 'token.finished', token: token.id, node: 'curation/published', status: 'published', reason: 'fixture completed'});
    const published = await control.execute('correct', {token: token.id, station: 'curation/proof', reason: 'Do not withdraw completed work'}, 'dispatcher');
    assert.equal(published.result.skipped, true);
    assert.equal(factory.state.tokens[token.id].status, 'published');
  } finally {await close(factory); fs.rmSync(dir, {recursive: true, force: true});}
});

test('exhausted recovery moves to manual once and resumes only by an explicit checkpoint request', async () => {
  let factory = new Factory();
  try {
    await factory.boot();
    factory.recovery.close();
    factory.runtime.start('Policy review inventory');
    factory.runtime.executors = () => async () => ({ok: false, summary: 'HTTP 503', failure: {
      tag: 'http_server', category: 'network', retryable: true, owner: 'system', message: 'HTTP 503',
    }});
    const token = factory.runtime.create('curation/assemble', {item: 'policy-review', url: 'https://fixture.invalid/', source: 'manual'});
    await factory.runtime.settle();
    const pool = factory.state.nodes['candidates/pool'].stock;
    assert.equal(factory.state.tokens[token.id].status, 'parked');
    token.rounds['curation/assemble'] = 5;
    token.rounds['manual:curation/assemble'] = 3;
    factory.runtime.checkpoint(token);
    factory.holdRecoveryForReview(token.id, 'curation/assemble', 'Configured recovery budget is exhausted');
    assert.equal(factory.state.tokens[token.id].status, 'manual');
    assert.equal(factory.state.recoveries[token.item].disposition, 'manual');
    assert.equal(factory.state.nodes['candidates/pool'].stock, pool - 1);
    assert.equal(factory.state.nodes['curation/manual'].stock, 1);
    const through = factory.journal.seq;
    factory.holdRecoveryForReview(token.id, 'curation/assemble', 'Repeated hold');
    assert.equal(factory.journal.seq, through, 'the same manual transfer cannot add another arrival');
    assert.deepEqual(factory.retryCandidates({items: [token.item], count: 1, automatic: true}), []);
    assert.throws(() => factory.retryCandidates({count: 1, includeManual: true}), /明确指定/);
    factory.runtime.pause();
    await close(factory);
    factory = new Factory();
    await factory.boot();
    factory.recovery.close();
    assert.equal(factory.state.recoveries[token.item].disposition, 'manual');
    assert.equal(factory.state.nodes['curation/manual'].stock, 1);
    assert.equal(factory.state.tokens[token.id].status, 'manual');
    factory.runtime.resume();
    let release!: () => void;
    const pending = new Promise<void>(resolve => {release = resolve;});
    factory.runtime.executors = () => async ctx => {
      await Promise.race([pending, new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), {once: true}))]);
      return {ok: false, summary: 'HTTP 503', failure: {tag: 'http_server', category: 'network', retryable: true, owner: 'system', message: 'HTTP 503'}};
    };
    const beforeClaim = factory.state.nodes['candidates/pool'].stock;
    const control = new FactoryControl(factory);
    const request = {tokens: [token.id], count: 1, includeManual: true, technicalReason: 'The failed network configuration was repaired; resume only the original checkpoint'};
    const previousReason = factory.state.tokens[token.id].reason;
    factory.state.tokens[token.id].reason = '需要用户选择分类归属';
    await assert.rejects(control.execute('retry_candidates', request, 'dispatcher'), {code: 'owner_decision_required'});
    factory.state.tokens[token.id].reason = previousReason;
    const receipt = await control.execute('retry_candidates', request, 'dispatcher');
    const resumed = factory.runtime.tokens.get(receipt.result.tokens[0].id)!;
    factory.runtime.pause();
    assert.equal(resumed.data.retryOf, token.id);
    assert.equal(resumed.data.recoveryStation, 'curation/assemble');
    assert.ok(factory.runtime.queues.get('curation/assemble')?.includes(resumed.id) || resumed.inflight.has('curation/assemble'));
    assert.equal(factory.state.nodes['candidates/pool'].stock, beforeClaim, 'manual work cannot decrement candidate inventory again');
    factory.reconcileManualStock();
    assert.equal(factory.state.nodes['curation/manual'].stock, 0);
    assert.equal(factory.state.recoveries[token.item].disposition, 'claimed');
    assert.equal(resumed.rounds['manual:curation/assemble'], 3, 'a program fix resumes the failed input without resetting correction history');
    assert.equal((resumed.data.technicalResumes as Record<string, {count: number}>)['curation/assemble'].count, 1);
    release();
    factory.runtime.resume();
    await factory.runtime.settle();
    factory.holdRecoveryForReview(resumed.id, 'curation/assemble', 'Retained technical failure after the first repair');
    const second = await control.execute('retry_candidates', {...request, tokens: [resumed.id]}, 'dispatcher');
    const secondToken = factory.runtime.tokens.get(second.result.tokens[0].id)!;
    await factory.runtime.settle();
    factory.holdRecoveryForReview(secondToken.id, 'curation/assemble', 'Retained technical failure after the second repair');
    const beforeRefusal = factory.journal.seq;
    await assert.rejects(control.execute('retry_candidates', {...request, tokens: [secondToken.id]}, 'dispatcher'), {code: 'technical_resume_limit'});
    assert.equal(factory.journal.seq, beforeRefusal, 'an exhausted technical continuation cannot enqueue or overwrite state');
  } finally {
    factory.recovery?.close();
    await close(factory);
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
