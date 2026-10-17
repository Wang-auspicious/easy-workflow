import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {compile} from '../server/spec/compile.ts';
import {apply, deserializeSnapshot, initialState, type FactoryState} from '../shared/project.ts';
import {snapshotVersion} from '../server/snapshots.ts';
import {line, station, type Pack} from '../server/spec/dsl.ts';
import type {LoadedWorkflowPacks} from '../server/workflow-packs.ts';
import type {ItemState} from '../server/kernel/item.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-runtime-restart-'));
process.env.FACTORY_VAR = dir;
process.env.FACTORY_PREFLIGHT = '0';
process.env.VISLEXICON_ROOT = path.join(dir, 'unconnected');
const { Factory } = await import('../server/factory.ts');
const { Journal } = await import('../server/journal.ts');
const close = async (factory: InstanceType<typeof Factory>) => {
  factory.recovery.close();
  factory.channels?.close();
  await Promise.all([factory.sources.close(), factory.runtime.close()]);
  factory.publicationOutbox?.close();
  factory.docs.flush();
  factory.lessons.close();
  await factory.closeSnapshots();
  factory.journal.close();
};

test('offline snapshots leave project documents and legacy settings untouched', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-offline-snapshot-'));
  const seed = new Journal(path.join(directory, 'journal.db'));
  seed.append({kind: 'dispatch.note', tone: 'info', text: 'Offline fixture'});
  seed.close();
  const settings = '{"model":2,"browser":3}\n';
  fs.writeFileSync(path.join(directory, 'settings.json'), settings);
  const factory = new Factory(directory, {projectionOnly: true});
  try {
    await factory.snapshot();
    assert.equal(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'), settings);
    assert.deepEqual(fs.readdirSync(directory).filter(name => !name.startsWith('journal.db')), ['settings.json'],
      'the offline command cannot initialize project metadata, documents, or evidence directories');
    const snapshot = factory.journal.latestSnapshot('factory-state', snapshotVersion(factory.compiled.digest));
    assert.equal(snapshot?.seq, 1);
    const saved = deserializeSnapshot(snapshot!.body) as {state: FactoryState};
    assert.equal(typeof saved.state, 'object', 'the wrapper stores state once, without nested JSON text');
    assert.equal(saved.state.activity[0].text, 'Offline fixture');
  } finally {
    factory.journal.close();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('snapshot timing resets after success and shutdown captures a late event after an in-flight write', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-snapshot-timer-'));
  const seed = new Journal(path.join(directory, 'journal.db'));
  seed.append({kind: 'dispatch.note', tone: 'info', text: 'Timer fixture'});
  seed.close();
  const factory = new Factory(directory, {projectionOnly: true});
  const lifecycle = factory as unknown as {startSnapshots(): void; writeSnapshots(): Promise<void>};
  try {
    await factory.snapshot();
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
    let late = false;
    const original = factory.journal.writeSnapshot.bind(factory.journal);
    const writes = t.mock.method(factory.journal, 'writeSnapshot', (...args: Parameters<typeof original>) => {
      const result = original(...args);
      if (late && args[0] === 'outbox') {
        late = false;
        queueMicrotask(() => factory.journal.append({kind: 'dispatch.note', tone: 'info', text: 'Final queued writer'}));
      }
      return result;
    });
    const flush = () => new Promise<void>(resolve => setImmediate(resolve));
    lifecycle.startSnapshots();
    t.mock.timers.tick(540_000);
    factory.journal.atomic(() => {
      for (let i = 0; i < 5000; i++) factory.journal.append({kind: 'dispatch.note', tone: 'info', text: `threshold ${i}`});
    });
    await flush();
    assert.equal(writes.mock.callCount(), 6, 'the event threshold writes all six snapshots once');
    t.mock.timers.tick(599_999);
    await flush();
    assert.equal(writes.mock.callCount(), 6, 'the previous boot-based ten-minute deadline must be cancelled');
    t.mock.timers.tick(1);
    await flush();
    assert.equal(writes.mock.callCount(), 12, 'ten minutes after the successful threshold capture writes again');
    late = true;
    const background = lifecycle.writeSnapshots();
    await Promise.all([background, factory.closeSnapshots()]);
    const snapshot = factory.journal.latestSnapshot('factory-state', snapshotVersion(factory.compiled.digest));
    assert.equal(snapshot?.seq, factory.journal.seq, 'close drains an older capture and includes the final queued event');
    const saved = deserializeSnapshot(snapshot!.body) as {state: FactoryState};
    assert.ok(saved.state.activity.some(entry => entry.text === 'Final queued writer'));
    assert.equal(writes.mock.callCount(), 24, 'shutdown performs another capture only when the journal advanced');
    t.mock.timers.tick(600_000);
    await flush();
    assert.equal(writes.mock.callCount(), 24, 'shutdown cancels the background timer');
  } finally {
    await factory.closeSnapshots();
    t.mock.timers.reset();
    factory.journal.close();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('graph reload rebuilds recovery under the new store kinds before snapshot version changes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-snapshot-graph-'));
  let kind: 'program' | 'store' = 'program';
  const fixturePack = (): Pack => ({id: 'snapshot-fixture', name: 'Snapshot fixture', version: '1', blurb: 'Fixture',
    lines: [line({id: 'snapshot', name: 'Snapshot', layer: 3, priority: 'mid', wired: true, blurb: 'Fixture',
      stations: [station({id: 'step', name: 'Step', kind, role: 'process', resource: 'none',
        accept: ['Preserve fixture input']}), ...(kind === 'store' ? [station({id: 'added', name: 'Added', kind: 'store', role: 'store'})] : [])],
      edges: []})], channels: [], resources: {browser: 0, model: 0, cpu: 0, http: 0}, links: [], conditions: {},
    order: ['snapshot'], collapsed: [], hints: {}});
  const loaded = (): LoadedWorkflowPacks => ({packs: [fixturePack()], conditions: {}, executor: () => null,
    role: key => ({station: key, path: 'fixture/ROLE.md', revision: 'fixture', content: '# Fixture role'}),
    manifests: [], index: {version: 1, builtins: [], packages: []}});
  const seed = new Journal(path.join(directory, 'journal.db'));
  seed.append({kind: 'run.started', runId: 'graph-fixture', title: 'Graph fixture'});
  seed.append({kind: 'token.created', token: 'graph-token', item: 'graph-item', line: 'snapshot',
    url: 'https://fixture.test/', source: 'manual'});
  seed.append({kind: 'token.data', token: 'graph-token', patch: {recoveryRoot: 'snapshot/step'}});
  seed.append({kind: 'token.queued', token: 'graph-token', node: 'snapshot/step'});
  seed.append({kind: 'token.finished', token: 'graph-token', node: 'snapshot/step', status: 'published', reason: 'Fixture'});
  seed.append({kind: 'run.ended', runId: 'graph-fixture', manual: true});
  seed.close();
  const factory = new Factory(directory);
  const configurable = factory as unknown as {loadWorkflowPacks(): Promise<LoadedWorkflowPacks>};
  t.mock.method(configurable, 'loadWorkflowPacks', async () => loaded());
  try {
    await factory.boot();
    const oldVersion = snapshotVersion(factory.compiled.digest);
    assert.ok(factory.journal.latestSnapshot('factory-state', oldVersion));
    assert.equal(factory.runtime.tokens.get('graph-token')?.done.has('snapshot/step'), false);
    kind = 'store';
    await factory.reloadWorkflowPacks();
    assert.equal(factory.runtime.tokens.get('graph-token')?.done.has('snapshot/step'), true,
      'the same historical queue event is a completed store arrival in the replacement graph');
    assert.ok(factory.state.nodes['snapshot/added'], 'the new initial graph must be projected, not relabelled');
    assert.strictEqual(factory.broker.modelCircuits, factory.state.modelCircuits);
    const patch = factory.proposePatch({author: 'user', summary: 'Fixture rename',
      ops: [{op: 'set', station: 'snapshot/step', field: 'name', value: 'Renamed step'}]});
    factory.decidePatch(patch.patch.id, true);
    const version = snapshotVersion(factory.compiled.digest);
    assert.notEqual(version, oldVersion);
    await factory.closeSnapshots();
    const snapshot = factory.journal.latestSnapshot('factory-state', version);
    assert.equal(snapshot?.seq, factory.journal.seq, 'accepted graph changes must continue producing snapshots');
    const expected = initialState(factory.compiled);
    for (const event of factory.journal.read()) apply(expected, event);
    const saved = deserializeSnapshot(snapshot!.body) as {state: FactoryState; recovery: {done: Map<string, Set<string>>}};
    assert.deepEqual(saved.state, expected);
    assert.ok(saved.recovery.done.get('graph-token')?.has('snapshot/step'));
  } finally {
    await close(factory);
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

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

function kernelCrashPack(): Pack {
  return {id: 'kernel-crash', name: 'Kernel crash fixture', version: '1', blurb: 'Durable operation boundaries',
    lines: [line({id: 'crash', name: 'Crash fixture', layer: 3, priority: 'mid', wired: true,
      blurb: 'One completed node, one durable side effect',
      stations: [...['done', 'effect'].map(id => station({id, name: id, kind: 'program', role: 'process',
        resource: 'none', accept: ['Preserve the fixture receipt']})),
      station({id: 'published', name: 'Published', kind: 'store', role: 'store'})],
      edges: [['done', 'effect'], ['effect', 'published']]})],
    channels: [], links: [], resources: {model: 0, browser: 0, cpu: 0, http: 0}, conditions: {},
    order: ['crash'], collapsed: [], hints: {}};
}

for (const boundary of ['completed', 'started'] as const) {
  test(`v2 SIGKILL after an external ${boundary} receipt preserves done nodes and prevents duplicate side effects`,
    {timeout: 30_000}, async () => {
    const {Kernel} = await import('../server/kernel/kernel.ts');
    const {Broker} = await import('../server/broker.ts');
    const {runDurableOperation} = await import('../server/operations.ts');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-kernel-crash-'));
    const journalPath = path.join(directory, 'journal.db');
    const effectPath = path.join(directory, 'effect.log');
    const compiled = compile([kernelCrashPack()]);
    assert.deepEqual(compiled.issues, []);
    const source = `
      import fs from 'node:fs';
      import path from 'node:path';
      import {Kernel} from ${JSON.stringify(new URL('../server/kernel/kernel.ts', import.meta.url).href)};
      import {Journal} from ${JSON.stringify(new URL('../server/journal.ts', import.meta.url).href)};
      import {Broker} from ${JSON.stringify(new URL('../server/broker.ts', import.meta.url).href)};
      import {runDurableOperation} from ${JSON.stringify(new URL('../server/operations.ts', import.meta.url).href)};
      const directory = process.env.KERNEL_FIXTURE_DIRECTORY;
      const journal = new Journal(path.join(directory, 'journal.db'));
      const compiled = JSON.parse(process.env.KERNEL_FIXTURE_COMPILED);
      const boundary = process.env.KERNEL_FIXTURE_BOUNDARY;
      const freeze = async ctx => {
        process.send({token: ctx.token.id, attempt: ctx.attempt, seq: journal.seq});
        await new Promise(() => {});
      };
      const kernel = new Kernel(compiled, journal, new Broker({}, 0), {}, () => async ctx => {
        if (journal.inTransaction) throw new Error('External work entered a SQLite transaction');
        if (ctx.node.id === 'done') {
          fs.appendFileSync(path.join(directory, 'effect.log'), 'done\\n');
          return {ok: true, summary: 'Completed paid work', data: {paid: 'durable output'}};
        }
        const result = await runDurableOperation({journal, token: ctx.token, node: ctx.node.key, revision: 'fixture-v1'},
          'fixture.write', {version: 1}, {item: ctx.token.item}, async () => {
            fs.appendFileSync(path.join(directory, 'effect.log'), 'effect\\n');
            if (boundary === 'started') await freeze(ctx);
            return {receipt: 'written once'};
          }, ctx.signal);
        if (boundary === 'completed') await freeze(ctx);
        return {ok: true, summary: 'Recorded fixture effect', data: {result}};
      });
      kernel.start('Actual crash fixture');
      kernel.create('crash/done', {item: 'one-effect', url: '', source: 'fixture'});
      await kernel.settle();
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {...process.env, FACTORY_VAR: directory, KERNEL_FIXTURE_DIRECTORY: directory,
        KERNEL_FIXTURE_COMPILED: JSON.stringify(compiled), KERNEL_FIXTURE_BOUNDARY: boundary},
    });
    let stderr = '';
    child.stderr!.on('data', bytes => {stderr = (stderr + String(bytes)).slice(-8000);});
    child.stdout!.resume();
    let journal: InstanceType<typeof Journal> | undefined;
    let kernel: InstanceType<typeof Kernel> | undefined;
    try {
      const ready = await new Promise<{token: string; attempt: string; seq: number}>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Crash fixture did not reach its receipt: ${stderr}`)), 20_000);
        child.once('message', value => {clearTimeout(timer); resolve(value as {token: string; attempt: string; seq: number});});
        child.once('error', error => {clearTimeout(timer); reject(error);});
        child.once('exit', code => {clearTimeout(timer); reject(new Error(`Crash fixture exited ${code}: ${stderr}`));});
      });
      const exited = once(child, 'exit');
      assert.equal(child.kill('SIGKILL'), true);
      await exited;
      assert.deepEqual(fs.readFileSync(effectPath, 'utf8').trim().split('\n'), ['done', 'effect']);
      journal = new Journal(journalPath);
      const recorded = [...journal.read()].filter(event => event.kind === 'operation.recorded');
      assert.equal(recorded.at(-1)?.operation.phase, boundary);
      let doneCalls = 0;
      let resumedCalls = 0;
      let sideEffects = 0;
      const activeJournal = journal;
      kernel = new Kernel(compiled, journal, new Broker({}, 0), {}, () => async ctx => {
        assert.equal(activeJournal.inTransaction, false);
        if (ctx.node.id === 'done') doneCalls++;
        else resumedCalls++;
        assert.equal(ctx.token.data.paid, 'durable output');
        const result = await runDurableOperation({journal: activeJournal, token: ctx.token,
          node: ctx.node.key, revision: 'fixture-v1'}, 'fixture.write', {version: 1},
        {item: ctx.token.item}, async () => {
          sideEffects++;
          fs.appendFileSync(effectPath, 'duplicate\n');
          return {receipt: 'must not run'};
        }, ctx.signal);
        return {ok: true, summary: 'Recovered from durable operation receipt', data: {result}};
      });
      const crashed = kernel.store.get(ready.token)!;
      assert.equal(crashed.nodes['crash/done'].status, 'done');
      assert.equal(crashed.nodes['crash/effect'].status, 'running');
      const retries = crashed.nodes['crash/effect'].attempts;
      kernel.recover();
      assert.equal(kernel.store.get(ready.token)?.nodes['crash/effect'].status, 'ready');
      assert.equal(kernel.store.get(ready.token)?.nodes['crash/effect'].attempts, retries);
      assert.equal(kernel.store.attempt(ready.attempt)?.status, 'interrupted');
      assert.equal(doneCalls + resumedCalls, 0, 'recovery alone cannot execute work');
      kernel.resume();
      await kernel.settle();
      assert.equal(doneCalls, 0, 'committed done nodes cannot run again after a process crash');
      assert.equal(resumedCalls, 1);
      assert.equal(sideEffects, 0, 'both completed and uncertain operation receipts forbid another external write');
      assert.deepEqual(fs.readFileSync(effectPath, 'utf8').trim().split('\n'), ['done', 'effect']);
      const item = kernel.store.get(ready.token)!;
      assert.equal(item.status, boundary === 'completed' ? 'published' : 'parked');
      if (boundary === 'started') assert.equal(item.parked?.code, 'EXTERNAL_OPERATION_UNKNOWN');
      assert.equal([...journal.read()].filter(event => event.kind === 'token.finished' && event.status === 'published').length,
        boundary === 'completed' ? 1 : 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      await kernel?.close();
      journal?.close();
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });
}

test('v2 item and attempt states are committed with their journal events before external work observes them', async () => {
  const {Kernel} = await import('../server/kernel/kernel.ts');
  const {Broker} = await import('../server/broker.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-kernel-atomic-'));
  const journalPath = path.join(directory, 'journal.db');
  const journal = new Journal(journalPath);
  const compiled = compile([kernelCrashPack()]);
  let reader: DatabaseSync | undefined;
  const observations: {kind: string; node: string; state: string; attempt: string; dataPresent: boolean}[] = [];
  const kernel = new Kernel(compiled, journal, new Broker({}, 0), {}, () => async ctx => {
    assert.equal(journal.inTransaction, false);
    const row = reader!.prepare('SELECT body FROM items WHERE id = ?').get(ctx.token.id) as {body: string};
    const item = JSON.parse(row.body) as ItemState;
    assert.equal(item.nodes[ctx.node.key].status, 'running');
    const attempt = reader!.prepare('SELECT status FROM attempts WHERE id = ?').get(ctx.attempt) as {status: string};
    assert.equal(attempt.status, 'running');
    ctx.progress('Fixture observation outside the transaction');
    return {ok: true, summary: 'Atomic fixture output', data: {[ctx.node.id]: 'committed'}};
  });
  try {
    reader = new DatabaseSync(journalPath, {readOnly: true});
    journal.subscribe(event => {
      if (event.kind !== 'attempt.started' && event.kind !== 'attempt.finished') return;
      const attempt = reader!.prepare('SELECT item, node, status FROM attempts WHERE id = ?').get(event.attempt) as
        {item: string; node: string; status: string};
      const row = reader!.prepare('SELECT body FROM items WHERE id = ?').get(attempt.item) as {body: string};
      const item = JSON.parse(row.body) as ItemState;
      const dataPresent = (reader!.prepare("SELECT body FROM events WHERE kind = 'token.data'").all() as {body: string}[])
        .some(value => {const parsed = JSON.parse(value.body); return parsed.token === attempt.item &&
          parsed.patch[attempt.node.split('/')[1]] === 'committed';});
      observations.push({kind: event.kind, node: attempt.node, state: item.nodes[attempt.node].status,
        attempt: attempt.status, dataPresent});
    });
    kernel.start('Atomic rows and events');
    const token = kernel.create('crash/done', {item: 'atomic', url: '', source: 'fixture'});
    await kernel.settle();
    assert.equal(kernel.store.get(token.id)?.status, 'published');
    assert.equal(observations.length, 4);
    for (const observed of observations) {
      assert.equal(observed.state, observed.kind === 'attempt.started' ? 'running' : 'done');
      assert.equal(observed.attempt, observed.kind === 'attempt.started' ? 'running' : 'ok');
      if (observed.kind === 'attempt.finished') assert.equal(observed.dataPresent, true);
    }
  } finally {
    reader?.close();
    await kernel.close();
    journal.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('v2 a failed result commit rolls back item, attempt, and compatibility events together', async t => {
  const {Kernel} = await import('../server/kernel/kernel.ts');
  const {Broker} = await import('../server/broker.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-kernel-rollback-'));
  const journalPath = path.join(directory, 'journal.db');
  const journal = new Journal(journalPath);
  const compiled = compile([kernelCrashPack()]);
  let calls = 0;
  let failed = false;
  t.mock.method(console, 'error', () => {});
  const kernel = new Kernel(compiled, journal, new Broker({}, 0), {}, () => async () => {
    calls++;
    return {ok: true, summary: 'Result before a disk fault', data: {mustRollback: 'uncommitted'}};
  });
  const append = journal.append.bind(journal);
  journal.append = event => {
    if (!failed && event.kind === 'token.data' && event.patch.mustRollback) {
      failed = true;
      throw new Error('Fixture failed result transaction');
    }
    return append(event);
  };
  let reader: DatabaseSync | undefined;
  try {
    kernel.start('Result rollback');
    const token = kernel.create('crash/done', {item: 'rollback', url: '', source: 'fixture'});
    await kernel.settle();
    assert.equal(failed, true);
    assert.equal(calls, 1, 'the successor cannot observe an uncommitted result');
    reader = new DatabaseSync(journalPath, {readOnly: true});
    const row = reader.prepare('SELECT body FROM items WHERE id = ?').get(token.id) as {body: string};
    const item = JSON.parse(row.body) as ItemState;
    assert.equal(item.nodes['crash/done'].status, 'running');
    assert.equal(item.data.mustRollback, undefined);
    assert.equal(kernel.store.get(token.id)?.data.mustRollback, undefined);
    assert.equal(kernel.tokens.get(token.id)?.done.has('crash/done'), false);
    const attempts = reader.prepare('SELECT status FROM attempts WHERE item = ?').all(token.id) as {status: string}[];
    assert.deepEqual(attempts.map(attempt => attempt.status), ['running']);
    const events = [...journal.read()];
    assert.equal(events.some(event => event.kind === 'attempt.finished'), false);
    assert.equal(events.some(event => event.kind === 'token.data' && event.patch.mustRollback), false);
    assert.equal(events.some(event => event.kind === 'token.queued' && event.node === 'crash/effect'), false);
    assert.throws(() => kernel.resume(), {code: 'journal_commit_failed'});
  } finally {
    reader?.close();
    await kernel.close();
    journal.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
