import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-runtime-restart-'));
process.env.FACTORY_VAR = dir;
process.env.FACTORY_PREFLIGHT = '0';
process.env.VISLEXICON_ROOT = path.join(dir, 'unconnected');
const { Factory } = await import('../server/factory.ts');
const { Journal } = await import('../server/journal.ts');
const close = async (factory: InstanceType<typeof Factory>) => {
  await factory.runtime.close(); factory.docs.flush(); factory.lessons.close(); factory.journal.close();
};

test('a paused direct repair survives restart with its owner, reviewer, instructions and independent branch', async () => {
  let factory = new Factory();
  const calls: Record<string, number> = {};
  try {
    await factory.boot(); factory.broker.memoryFloorMB = 0; factory.runtime.start('durable direct repair');
    factory.runtime.executors = node => async () => {
      calls[node.key] = (calls[node.key] ?? 0) + 1;
      if (node.key === 'curation/fact-review') {
        factory.runtime.pause();
        return { ok: true, summary: 'license needs its source', verdict: { verdict: 'fix', reason: 'cite the original source', fixes: [{ station: 'curation/facts', fields: ['facts.license'], problem: 'cite the original license source' }] } };
      }
      return { ok: true, summary: 'fixture evidence' };
    };
    const token = factory.runtime.create('curation/plan', { item: 'durable-repair', url: 'https://fixture.test/', source: 'manual' });
    await factory.runtime.settle();
    assert.equal(token.consult?.chain[0], 'curation/facts');
    assert.equal(calls['curation/facts'], 1);
    const originalDone = new Set(token.done);
    await close(factory); factory = new Factory(); await factory.boot(); factory.broker.memoryFloorMB = 0;
    const restored = factory.runtime.tokens.get(token.id)!;
    assert.equal(restored.consult?.reviewer, 'curation/fact-review', 'the original reviewer must remain responsible for the repair');
    assert.equal(restored.consult?.chain[0], 'curation/facts');
    assert.match(restored.notes.get('curation/facts')?.reason ?? '', /original license source/);
    factory.runtime.executors = node => async ctx => {
      calls[node.key] = (calls[node.key] ?? 0) + 1;
      if (node.key === 'curation/facts') assert.match(ctx.redo?.reason ?? '', /original license source/);
      return { ok: true, summary: 'repair checked', data: node.key === 'curation/gate' ? { gate: 'pass' } : undefined };
    };
    factory.runtime.resume(); await factory.runtime.settle();
    assert.equal(factory.state.tokens[token.id].status, 'published');
    assert.equal(calls['curation/facts'], 2);
    assert.equal(calls['curation/fact-review'], 2);
    for (const key of originalDone) if (key !== 'curation/facts') assert.equal(calls[key], 1, `${key} must reuse its finished result`);
    assert.ok(Object.values(factory.state.consults).every(c => c.outcome === 'resolved'));
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('nested repairs retain their parent and three-round budget over repeated restarts', async () => {
  let factory = new Factory();
  const calls: Record<string, number> = {};
  try {
    await factory.boot(); factory.broker.memoryFloorMB = 0; factory.runtime.start('nested restart');
    const execute = () => {
      factory.runtime.executors = node => async () => {
        calls[node.key] = (calls[node.key] ?? 0) + 1;
        if (node.key === 'curation/style' && calls[node.key] === 1) return {
          ok: true, summary: 'subject missing', verdict: { verdict: 'fix', reason: 'subject missing', fixes: [{ station: 'curation/proof', fields: ['shots.proof'], problem: 'show the subject', via: ['curation/process', 'curation/shot-review'] }] },
        };
        if (node.key === 'curation/shot-review' && calls[node.key] > 1) {
          factory.runtime.pause();
          return { ok: true, summary: 'wrong crop', verdict: { verdict: 'fix', reason: 'wrong crop', fixes: [{ station: 'curation/proof', fields: ['shots.proof'], problem: 'crop the subject', via: ['curation/process'] }] } };
        }
        return { ok: true, summary: 'fixture', data: node.key === 'curation/gate' ? { gate: 'pass' } : undefined };
      };
    };
    execute();
    const token = factory.runtime.create('curation/plan', { item: 'nested-repair', url: 'https://fixture.test/', source: 'manual' });
    await factory.runtime.settle();
    for (let round = 1; round <= 3; round++) {
      assert.equal(factory.runtime.tokens.get(token.id)?.consult?.parent?.reviewer, 'curation/style');
      await close(factory); factory = new Factory(); await factory.boot(); factory.broker.memoryFloorMB = 0;
      const restored = factory.runtime.tokens.get(token.id)!;
      assert.equal(restored.consult?.parent?.reviewer, 'curation/style', 'nested repair must resume before the original reviewer');
      assert.equal(restored.rounds['consult:curation/shot-review>curation/proof'], round, 'restarting cannot reset the repair budget');
      execute(); factory.runtime.resume(); await factory.runtime.settle();
    }
    assert.equal(factory.state.tokens[token.id].status, 'manual');
    assert.equal(calls['curation/style'], 1, 'rejected intermediary repairs never advance their parent');
    assert.equal(calls['curation/shot-review'], 5);
    assert.equal(Object.values(factory.state.consults).filter(c => c.outcome === 'manual').length, 4);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a reviewer escalation cancels the item\'s independent work before releasing it to manual review', async () => {
  const factory = new Factory();
  let cancelSibling = false;
  let siblingStarted!: () => void;
  const started = new Promise<void>(resolve => { siblingStarted = resolve; });
  let manualReached!: () => void;
  const manual = new Promise<void>(resolve => { manualReached = resolve; });
  try {
    await factory.boot(); factory.broker.memoryFloorMB = 0; factory.runtime.start('manual cancellation');
    factory.journal.subscribe(event => { if (event.kind === 'token.finished' && event.status === 'manual') manualReached(); });
    factory.runtime.executors = node => async ctx => {
      if (node.key === 'curation/facts') {
        siblingStarted();
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => { cancelSibling = true; reject(ctx.signal.reason); }, { once: true });
        });
      }
      if (node.key === 'curation/shot-review') {
        await started;
        return { ok: true, summary: 'needs owner', verdict: { verdict: 'escalate', reason: 'no eligible preview' } };
      }
      return { ok: true, summary: 'fixture' };
    };
    const token = factory.runtime.create('curation/plan', { item: 'manual-cancel', url: 'https://fixture.test/', source: 'manual' });
    await manual;
    assert.equal(factory.state.tokens[token.id].status, 'manual');
    assert.equal(cancelSibling, true, 'manual disposition must promptly stop obsolete parallel work');
    await factory.runtime.settle();
    const attempt = token && factory.state.tokens[token.id].attempts.map(id => factory.state.attempts[id]).find(a => a.node === 'curation/facts');
    assert.equal(attempt?.cancelled, true);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a crash after a completed checkpoint but before the next queue event reconstructs the live frontier', async () => {
  let factory = new Factory();
  try {
    await factory.boot(); factory.broker.memoryFloorMB = 0; factory.runtime.start('crash between journal events');
    factory.runtime.executors = node => async () => ({ ok: true, summary: 'fixture', data: node.key === 'curation/gate' ? { gate: 'pass' } : undefined });
    const token = factory.runtime.create('curation/facts', { item: 'crash-frontier', url: 'https://fixture.test/', source: 'manual' });
    await factory.runtime.settle();
    const events = [...factory.journal.read()];
    const crashAt = events.findIndex(e => e.kind === 'token.data' && e.token === token.id && (e.patch.runtimeCheckpoint as { done?: string[] })?.done?.includes('curation/facts'));
    assert.ok(crashAt >= 0);
    const prefix = events.slice(0, crashAt + 1);
    await close(factory); fs.rmSync(dir, { recursive: true, force: true });
    const journal = new Journal(path.join(dir, 'journal.db'));
    for (const { seq, at, run, ...event } of prefix) journal.append(event);
    journal.append({ kind: 'run.paused', runId: journal.run }); journal.close();
    factory = new Factory(); await factory.boot(); factory.broker.memoryFloorMB = 0;
    const executed: string[] = [];
    factory.runtime.executors = node => async () => {
      executed.push(node.key);
      return { ok: true, summary: 'fixture', data: node.key === 'curation/gate' ? { gate: 'pass' } : undefined };
    };
    factory.runtime.resume(); await factory.runtime.settle();
    assert.equal(factory.state.tokens[token.id].status, 'published', 'the completed predecessor cannot leave its successor stranded');
    assert.equal(executed[0], 'curation/fact-review');
    assert.ok(!executed.includes('curation/facts'), 'the persisted result must be reused');
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a queued parallel repair survives restart without reviewing stale fields before its owner replies', async () => {
  let factory = new Factory();
  const calls: Record<string, number> = {};
  let repairStarted!: () => void;
  const repairing = new Promise<void>(resolve => { repairStarted = resolve; });
  let pendingSaved!: () => void;
  const saved = new Promise<void>(resolve => { pendingSaved = resolve; });
  try {
    await factory.boot(); factory.broker.memoryFloorMB = 0; factory.runtime.start('parallel repair restart');
    factory.journal.subscribe(event => {
      if (event.kind === 'token.data' && (event.patch.runtimeCheckpoint as { pendingConsults?: unknown[] })?.pendingConsults?.length) pendingSaved();
    });
    factory.runtime.executors = node => async ctx => {
      calls[node.key] = (calls[node.key] ?? 0) + 1;
      if (node.key === 'curation/style') return { ok: true, summary: 'repair screenshot', verdict: { verdict: 'fix', reason: 'show the subject', fixes: [{ station: 'curation/proof', fields: ['shots.proof'], problem: 'show the subject', via: ['curation/process', 'curation/shot-review'] }] } };
      if (node.key === 'curation/proof' && calls[node.key] === 2) {
        repairStarted();
        await new Promise<void>((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }));
      }
      if (node.key === 'curation/fact-review') {
        await repairing; factory.runtime.pause();
        return { ok: true, summary: 'missing license source', verdict: { verdict: 'fix', reason: 'cite source', fixes: [{ station: 'curation/facts', fields: ['facts.license'], problem: 'cite source' }] } };
      }
      return { ok: true, summary: 'fixture' };
    };
    const token = factory.runtime.create('curation/plan', { item: 'parallel-repair', url: 'https://fixture.test/', source: 'manual' });
    await saved; await close(factory); factory = new Factory(); await factory.boot(); factory.broker.memoryFloorMB = 0;
    const order: string[] = [];
    factory.runtime.executors = node => async () => {
      order.push(node.key);
      return { ok: true, summary: 'fixture repair', data: node.key === 'curation/gate' ? { gate: 'pass' } : undefined };
    };
    factory.runtime.resume(); await factory.runtime.settle();
    assert.equal(factory.state.tokens[token.id].status, 'published');
    assert.equal(order.filter(key => key === 'curation/fact-review').length, 1, 'the waiting reviewer must only run after its own repair');
    assert.ok(order.indexOf('curation/facts') < order.indexOf('curation/fact-review'));
    assert.ok(Object.values(factory.state.consults).every(consult => consult.outcome === 'resolved'));
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a successful attempt receipt becomes visible together with its flow or repair decision', async () => {
  const factory = new Factory();
  let reader: InstanceType<typeof Journal> | undefined;
  const observed: { node: string; hasDecision: boolean; queued: string[]; done: string[] }[] = [];
  try {
    await factory.boot(); factory.broker.memoryFloorMB = 0; factory.runtime.start('atomic result decisions');
    reader = new Journal(path.join(dir, 'journal.db'), true);
    factory.journal.subscribe(event => {
      if (event.kind !== 'attempt.finished') return;
      const attempt = factory.state.attempts[event.attempt];
      const durable = [...reader!.read(event.seq)];
      const checkpoint = durable.findLast(e => e.kind === 'token.data' && e.token === attempt.token && e.patch.runtimeCheckpoint);
      observed.push({ node: attempt.node, hasDecision: !!checkpoint,
        queued: durable.filter(e => e.kind === 'token.queued').map(e => e.node),
        done: checkpoint?.kind === 'token.data' ? (checkpoint.patch.runtimeCheckpoint as { done: string[] }).done : [] });
    });
    factory.runtime.executors = node => async () => {
      if (node.key === 'curation/fact-review') {
        factory.runtime.pause();
        return { ok: true, summary: 'needs license source', verdict: { verdict: 'fix', reason: 'cite source', fixes: [{ station: 'curation/facts', fields: ['facts.license'], problem: 'cite source' }] } };
      }
      return { ok: true, summary: 'fixture facts' };
    };
    factory.runtime.create('curation/facts', { item: 'atomic-decision', url: 'https://fixture.test/', source: 'manual' });
    await factory.runtime.settle();
    assert.equal(observed.length, 2);
    assert.ok(observed.every(result => result.hasDecision), 'a receipt alone is never a committed crash boundary');
    assert.ok(observed[0].done.includes('curation/facts')); assert.ok(observed[0].queued.includes('curation/fact-review'));
    assert.ok(!observed[1].done.includes('curation/fact-review'), 'a successful fix request must remain unfinished');
    assert.ok(observed[1].queued.includes('curation/facts'));
  } finally { reader?.close(); await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});
