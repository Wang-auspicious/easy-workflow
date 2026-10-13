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
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
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
    const beforeClaim = factory.state.nodes['candidates/pool'].stock;
    const [resumed] = factory.retryCandidates({items: [token.item], count: 1, includeManual: true});
    factory.runtime.pause();
    assert.equal(resumed.data.retryOf, token.id);
    assert.equal(resumed.data.recoveryStation, 'curation/assemble');
    assert.ok(factory.runtime.queues.get('curation/assemble')?.includes(resumed.id));
    assert.equal(factory.state.nodes['candidates/pool'].stock, beforeClaim, 'manual work cannot decrement candidate inventory again');
    factory.reconcileManualStock();
    assert.equal(factory.state.nodes['curation/manual'].stock, 0);
    assert.equal(factory.state.recoveries[token.item].disposition, 'claimed');
  } finally {
    factory.recovery?.close();
    await close(factory);
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
