import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-retry-checkpoint-'));
process.env.FACTORY_VAR = dir;
process.env.FACTORY_PREFLIGHT = '0';
process.env.FACTORY_HTTP_CACHE = '0';
process.env.VISLEXICON_ROOT = path.join(dir, 'unconnected');
const { Factory } = await import('../server/factory.ts');

test('retrying one failed branch preserves the unfinished repair and its budget on a parallel branch', { timeout: 15000 }, async () => {
  const factory = new Factory();
  const calls: Record<string, number> = {};
  let ownerStarted!: () => void;
  const ownerRunning = new Promise<void>(resolve => { ownerStarted = resolve; });
  try {
    await factory.boot(); factory.broker.memoryFloorMB = 0;
    factory.runtime.start('parallel repair then independent failure');
    factory.runtime.executors = node => async ctx => {
      const count = calls[node.key] = (calls[node.key] ?? 0) + 1;
      if (node.key === 'curation/style' && count <= 2) return {
        ok: true, summary: 'The subject is still missing.',
        verdict: { verdict: 'fix', reason: 'Capture the actual component.', fixes: [{ station: 'curation/proof', fields: ['shots.proof'], problem: 'Capture the actual component.', via: ['curation/process', 'curation/shot-review'] }] },
      };
      if (node.key === 'curation/proof' && count === 2) {
        ownerStarted();
        await new Promise<void>((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }));
      }
      if (node.key === 'curation/facts' && count === 1) {
        await ownerRunning;
        return { ok: false, summary: 'Fixture model connection failure.', error: 'Connection error.', failure: {
          tag: 'model_transport', category: 'system', message: 'Connection error.', retryable: true, owner: 'system', nextAction: 'Retry the saved station after the provider recovers.',
        } };
      }
      return { ok: true, summary: 'Fixture result.', data: node.key === 'curation/gate' ? { gate: 'pass' } : undefined };
    };
    const original = factory.runtime.create('curation/plan', { item: 'parallel-repair', url: 'https://fixture.test/', source: 'manual', data: { canonical: 'https://fixture.test/', mode: 'shots', needsProof: true } });
    await factory.runtime.settle();
    assert.equal(factory.state.tokens[original.id].status, 'parked');
    assert.equal(calls['curation/style'], 1);
    assert.equal(original.done.has('curation/style'), false, 'a fix request is not a completed station');
    assert.equal(original.rounds['consult:curation/style>curation/proof'], 1);
    factory.clearAlert('model-transport', 'Fixture provider recovery; now test the saved workflow checkpoint.');

    const [retry] = factory.retryCandidates({ items: ['parallel-repair'], count: 1, automatic: true, checkpointOnly: true });
    assert.ok(retry);
    assert.equal(retry.entry, original.entry);
    assert.equal(retry.source, original.source);
    assert.equal(retry.done.has('curation/style'), false, 'attempt.ok cannot override the exact unfinished checkpoint');
    assert.equal(retry.rounds['consult:curation/style>curation/proof'], 1, 'retrying the sibling cannot reset this repair budget');
    await factory.runtime.settle();
    assert.equal(factory.state.tokens[retry.id].status, 'published');
    assert.equal(calls['curation/style'], 3, 'the unresolved reviewer repairs and rechecks before the item advances');
    assert.equal(calls['curation/proof'], 3, 'the interrupted capture is retried after its review request is restored');
    assert.equal(retry.rounds['consult:curation/style>curation/proof'], 2);
  } finally {
    await factory.runtime.close(); factory.docs.flush(); factory.lessons.close(); factory.journal.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('easy-workflow-retry-checkpoint-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed repair owner receives the same redo contract after candidate retry and restart', { timeout: 15000 }, async () => {
  let factory = new Factory();
  let factCalls = 0, reviewCalls = 0;
  let originalRedo: { reason: string; note?: string; byHuman: boolean } | undefined;
  const close = async () => { await factory.runtime.close(); factory.docs.flush(); factory.lessons.close(); factory.journal.close(); };
  try {
    await factory.boot(); factory.broker.memoryFloorMB = 0;
    factory.runtime.start('repair owner transport failure');
    factory.runtime.executors = node => async ctx => {
      if (node.key === 'curation/fact-review' && ++reviewCalls === 1) return {
        ok: true, summary: 'Fix the license scope.', verdict: { verdict: 'fix', reason: 'The license applies to source only.', fixes: [{ station: 'curation/facts', fields: ['facts.license'], problem: 'Keep the license scoped to repository source.' }] },
      };
      if (node.key === 'curation/facts' && ++factCalls === 2) {
        originalRedo = structuredClone(ctx.redo);
        assert.match(originalRedo?.reason ?? '', /facts.license/);
        return { ok: false, summary: 'Fixture model connection failure.', error: 'Connection error.', failure: {
          tag: 'model_transport', category: 'system', message: 'Connection error.', retryable: true, owner: 'system', nextAction: 'Retry the saved repair after the provider recovers.',
        } };
      }
      return { ok: true, summary: 'Fixture result.', data: node.key === 'curation/gate' ? { gate: 'pass' } : undefined };
    };
    const original = factory.runtime.create('curation/plan', { item: 'owner-repair', url: 'https://fixture.test/', source: 'manual', data: { canonical: 'https://fixture.test/', mode: 'shots', needsProof: true } });
    await factory.runtime.settle();
    assert.equal(factory.state.tokens[original.id].status, 'parked');
    assert.ok(originalRedo);
    assert.deepEqual(original.notes.get('curation/facts'), originalRedo, 'failed work must retain its unfulfilled redo instruction');
    const [retry] = factory.retryCandidates({ items: ['owner-repair'], count: 1 });
    factory.runtime.pause();
    assert.deepEqual(retry.notes.get('curation/facts'), originalRedo, 'candidate retry must use the same input contract so its saved agent session can match');
    await close(); factory = new Factory(); await factory.boot(); factory.broker.memoryFloorMB = 0;
    const resumed = factory.runtime.tokens.get(retry.id)!;
    assert.deepEqual(resumed.notes.get('curation/facts'), originalRedo, 'restart preserves the repair contract as well as its station');
    assert.equal(resumed.rounds['consult:curation/fact-review>curation/facts'], 1);
    assert.match(factory.broker.modelHold ?? '', /Connection error/, 'restart must retain the unresolved provider hold');
    factory.clearAlert('model-transport', 'Fixture provider recovery; the unchanged repair contract may now resume.');
    factory.runtime.executors = node => async ctx => {
      if (node.key === 'curation/facts') { factCalls++; assert.deepEqual(ctx.redo, originalRedo); }
      if (node.key === 'curation/fact-review') reviewCalls++;
      return { ok: true, summary: 'The repair has its original context.', data: node.key === 'curation/gate' ? { gate: 'pass' } : undefined };
    };
    factory.runtime.resume(); await factory.runtime.settle();
    assert.equal(factory.state.tokens[retry.id].status, 'published', JSON.stringify({ running: factory.runtime.running, paused: factory.runtime.paused, at: factory.state.tokens[retry.id].at, modelHold: factory.broker.modelHold, factCalls, reviewCalls, done: [...resumed.done] }));
    assert.equal(factCalls, 3); assert.equal(reviewCalls, 2);
  } finally {
    await close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('easy-workflow-retry-checkpoint-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('automatic intake retry validates before claiming and retains original source inputs and evidence', {timeout: 15000}, async () => {
  const factory = new Factory();
  try {
    await factory.boot();
    factory.broker.memoryFloorMB = 0;
    factory.recovery.close();
    factory.runtime.start('Unfinished source intake');
    factory.runtime.executors = () => async ctx => {
      ctx.addEvidence({id: 'intake-receipt', kind: 'text', label: 'Input retained before failure'});
      return {ok: false, summary: 'Temporary connection failure', failure: {
        tag: 'network_connection', category: 'network', message: 'ECONNRESET', retryable: true, owner: 'system',
      }};
    };
    const original = factory.runtime.create('candidates/tidy', {
      item: 'unfinished-input', url: 'https://fixture.example/', source: 'source:fixture',
      data: {sourceCandidate: 'candidate-1', input: {description: 'Keep this supplied input'},
        rerunPublished: true, __runtimeRecovery: {networkAttempts: 1}},
    });
    await factory.runtime.settle();
    const checkpoint = structuredClone(original.data.runtimeCheckpoint);
    const before = factory.runtime.tokens.size;
    factory.journal.append({kind: 'token.data', token: original.id,
      patch: {runtimeCheckpoint: {version: 1, entry: original.entry, done: [], notes: null}}});
    assert.throws(() => factory.retryCandidates({items: [original.item], count: 1,
      automatic: true, checkpointOnly: true}), /完整持久检查点/);
    assert.equal(factory.runtime.tokens.size, before, 'validation cannot claim a new task');
    assert.equal(factory.runtime.running, true, 'invalid saved input is not a failed storage transaction');
    assert.equal(factory.state.recoveries[original.item].disposition, 'retry');

    factory.journal.append({kind: 'token.data', token: original.id, patch: {runtimeCheckpoint: checkpoint}});
    factory.runtime.executors = () => async ctx => {
      assert.equal(ctx.token.entry, original.entry);
      assert.equal(ctx.token.source, original.source);
      assert.deepEqual(ctx.token.data.input, {description: 'Keep this supplied input'});
      assert.equal(ctx.token.data.sourceCandidate, 'candidate-1');
      assert.equal(ctx.token.data.rerunPublished, true);
      assert.deepEqual(ctx.token.data.__runtimeRecovery, {networkAttempts: 1});
      return {ok: true, summary: 'Recovered input', finish: {status: 'published', reason: 'fixture'}};
    };
    const [retry] = factory.retryCandidates({items: [original.item], count: 1,
      automatic: true, checkpointOnly: true, onClaim: token => {
        token.data.claimReceipt = 'same transaction';
        factory.journal.append({kind: 'token.data', token: token.id, patch: {claimReceipt: 'same transaction'}});
      }});
    assert.ok(retry);
    assert.equal(retry.data.retryOf, original.id);
    assert.equal(factory.state.tokens[retry.id].data.claimReceipt, 'same transaction');
    assert.ok(factory.state.tokens[retry.id].evidence.some(id =>
      factory.state.evidence[id].meta?.reusedFrom === 'intake-receipt'));
    await factory.runtime.settle();
    assert.equal(factory.state.tokens[retry.id].status, 'published');
  } finally {
    factory.recovery.close();
    await factory.sources.close();
    factory.channels?.close();
    await factory.runtime.close();
    factory.docs.flush();
    factory.lessons.close();
    factory.journal.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('easy-workflow-retry-checkpoint-'));
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
