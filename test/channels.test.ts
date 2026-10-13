import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Executor } from '../server/runtime.ts';
import { station, line } from '../server/spec/dsl.ts';
import { installWorkflowPack, type WorkflowManifest } from '../server/workflow-packs.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-channels-'));
process.env.FACTORY_VAR = directory;
process.env.FACTORY_PREFLIGHT = '0';
process.env.FACTORY_START_PAUSED = '1';
process.env.FACTORY_RESUME_MANAGED = '0';
process.env.FACTORY_HTTP_CACHE = '0';
process.env.VISLEXICON_ROOT = path.join(directory, 'unconnected');
const { Factory } = await import('../server/factory.ts');
const { ChannelSupervisor } = await import('../server/channels.ts');
const { latestRunTokens } = await import('../shared/project.ts');

before(async () => {
  const definitions = [['parent', ['prepare']], ['child', ['prepare', 'paid', 'review']], ['components', ['discover']]] as const;
  const bindings: WorkflowManifest['bindings'] = {}, files: Record<string, string> = {};
  const lines = definitions.map(([id, programs]) => {
    for (const program of programs) {
      const role = `roles/${id}/${program}/ROLE.md`;
      files[role] = '# Fixture execution contract\nExecute the supplied deterministic fixture and preserve the task evidence. Never contact a model or a browser.';
      bindings[`${id}/${program}`] = { role, inputSchema: 'text', outputSchema: 'text', input: { text: { path: 'input.text' } }, outputKey: `${id}-${program}`, execute: { kind: 'builtin', name: 'normalize-text' } };
    }
    const ids = ['inbox', ...programs, 'published'];
    return line({ id, name: id, layer: 3, priority: 'mid', wired: true, blurb: 'Deterministic channel fixture',
      stations: ids.map(id => station({ id, name: id, kind: ['inbox', 'published'].includes(id) ? 'store' : 'program', role: ['inbox', 'published'].includes(id) ? 'store' : 'process', resource: 'none', accept: ['Return the supplied deterministic fixture result'], workers: { initial: 1, min: 1, max: 1, policy: 'fixed' } })),
      edges: ids.slice(1).map((id, i) => [ids[i], id] as [string, string]),
    });
  });
  const manifest: WorkflowManifest = { format: 1, id: 'channel-fixture', name: 'Channel fixture', version: '1', blurb: 'Fixture only', entry: 'parent/prepare', inputSchema: 'text',
    schemas: { text: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }, bindings, lines,
    channels: [{ id: 'fixture.ready', from: { line: 'parent', station: 'published' }, to: { line: 'child', station: 'inbox' }, label: 'Fixture delivery' }],
    resources: { cpu: 1, model: 1, browser: 1, http: 1 }, links: [], conditions: {},
  };
  await installWorkflowPack(directory, { manifest, files, builtins: [] }, { running: false });
});
beforeEach(() => {
  for (const file of ['journal.db', 'journal.db-wal', 'journal.db-shm']) fs.rmSync(path.join(directory, file), { force: true });
});
after(() => {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});
const success: Executor = async () => ({ ok: true, summary: 'Fixture program completed', data: { retained: 'durable fixture output' } });
async function boot(executor: Executor = success) {
  const factory = new Factory(); await factory.boot(); factory.broker.memoryFloorMB = 0;
  factory.runtime.executors = () => executor;
  return factory;
}
async function close(factory: InstanceType<typeof Factory>) {
  factory.channels?.close(); await factory.runtime.close(); factory.docs.flush(); factory.lessons.close(); factory.journal.close();
}
async function settle(factory: InstanceType<typeof Factory>) {
  // A channel consumer queues a scheduler microtask after the current journal
  // notification. Let that admission happen before waiting for runtime jobs.
  await new Promise<void>(resolve => setImmediate(resolve));
  await factory.runtime.settle();
}
function parent(factory: InstanceType<typeof Factory>, item = 'same-source') {
  factory.runtime.setScopePaused({ scope: 'line', key: 'parent', paused: true, reason: 'Hold the upstream fixture while testing explicit emissions' });
  return factory.runtime.create('parent/prepare', { item, url: 'https://fixture.test/' + item, title: item, source: 'manual', data: { input: { text: item }, business: 'original payload' } });
}
function emit(factory: InstanceType<typeof Factory>, token: string, inventory: 'consumer' | undefined = 'consumer') {
  return factory.journal.append({ kind: 'channel.emitted', channel: 'fixture.ready', token, item: factory.state.tokens[token].item, ...(inventory ? { inventory } : {}) });
}
const children = (factory: InstanceType<typeof Factory>) => Object.values(factory.state.tokens).filter(token => token.data.channelDelivery);

test('one committed batch deduplicates repeated emissions using the payload at each emission', async () => {
  const factory = await boot();
  try {
    const source = parent(factory);
    factory.runtime.atomicTransition(() => {
      emit(factory, source.id); emit(factory, source.id);
      factory.journal.append({ kind: 'token.data', token: source.id, patch: { business: 'after emission' } });
    });
    assert.equal(factory.channels!.status().length, 1);
    assert.equal(factory.channels!.status()[0].data.business, 'original payload');
    assert.equal(factory.state.nodes['child/inbox'].stock, 1, 'duplicate emission cannot reserve inventory twice');
    factory.channels!.close(); factory.channels = new ChannelSupervisor(factory);
    assert.equal(factory.channels.status().length, 1, 'replay computes exactly the same delivery id');
    assert.equal(factory.state.nodes['child/inbox'].stock, 1);
  } finally { await close(factory); }
});

test('historical deliveries add at most one active child and respect global and line pauses', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const factory = await boot(async ctx => { if (ctx.node.line === 'child') await blocked; return success(ctx); });
  try {
    const source = parent(factory);
    for (let i = 0; i < 8; i++) { factory.journal.append({ kind: 'token.data', token: source.id, patch: { batch: i } }); emit(factory, source.id); }
    factory.runtime.start('Bounded channels'); factory.runtime.pause(); factory.channels!.pump();
    assert.equal(children(factory).length, 0);
    factory.runtime.setScopePaused({ scope: 'line', key: 'child', paused: true, reason: 'Fixture line paused' });
    factory.runtime.resume(); factory.channels!.pump(); assert.equal(children(factory).length, 0);
    factory.runtime.setScopePaused({ scope: 'line', key: 'child', paused: false, reason: 'Fixture resumes' });
    factory.channels!.pump();
    assert.equal(children(factory).filter(token => token.status === 'active').length, 1);
    assert.equal(factory.channels!.status().filter(delivery => delivery.status === 'pending').length, 7);
  } finally { factory.channels!.close(); release(); await close(factory); }
});

test('emission survives a failed pending commit and is queued once on restart', async t => {
  let factory = await boot(), injected = false;
  t.mock.method(console, 'error', () => {});
  try {
    const source = parent(factory), append = factory.journal.append.bind(factory.journal);
    factory.journal.append = event => {
      if (!injected && event.kind === 'channel.delivery') { injected = true; throw new Error('Fixture crash before pending commit'); }
      return append(event);
    };
    emit(factory, source.id);
    assert.equal(injected, true); assert.equal(factory.channels!.status().length, 0);
    assert.equal([...factory.journal.read()].filter(event => event.kind === 'channel.emitted').length, 1);
    assert.equal(factory.state.nodes['child/inbox'].stock, 0, 'reservation rolled back with the pending receipt');
    await close(factory); factory = await boot();
    const first = factory.channels!.status()[0]; assert.equal(first.status, 'pending');
    assert.equal(factory.state.nodes['child/inbox'].stock, 1);
    await close(factory); factory = await boot();
    assert.equal(factory.channels!.status().length, 1); assert.equal(factory.channels!.status()[0].id, first.id);
    assert.equal(factory.state.nodes['child/inbox'].stock, 1); assert.equal(children(factory).length, 0);
  } finally { await close(factory); }
});

test('child creation and delivered receipt roll back together and recover without duplicate creation', async t => {
  let factory = await boot(), injected = false;
  t.mock.method(console, 'error', () => {});
  try {
    const source = parent(factory); emit(factory, source.id); factory.runtime.start('Atomic child claim');
    const append = factory.journal.append.bind(factory.journal);
    factory.journal.append = event => {
      if (!injected && event.kind === 'channel.delivery' && event.delivery.status === 'delivered') { injected = true; throw new Error('Fixture crash after create before delivered'); }
      return append(event);
    };
    assert.throws(() => factory.channels!.pump(), /Fixture crash/);
    assert.equal(children(factory).length, 0); assert.equal(factory.state.nodes['child/inbox'].stock, 1);
    assert.equal(factory.runtime.running, false); assert.equal(factory.runtime.paused, true);
    assert.throws(() => factory.runtime.resume(), /重启/);
    await close(factory); factory = await boot();
    factory.runtime.resume(); await settle(factory);
    assert.equal(children(factory).length, 1); assert.equal(factory.channels!.status()[0].status, 'acknowledged');
    assert.equal(factory.state.nodes['child/inbox'].stock, 0);
    await close(factory); factory = await boot();
    factory.runtime.resume(); await settle(factory);
    assert.equal(children(factory).length, 1); assert.equal(factory.channels!.status()[0].attempts, 1);
  } finally { await close(factory); }
});

test('committed child identity is adopted when a legacy journal lacks its delivered receipt', async () => {
  let factory = await boot();
  try {
    const source = parent(factory); emit(factory, source.id); const delivery = factory.channels!.status()[0];
    factory.channels!.close(); factory.runtime.start('Legacy orphan claim');
    let childId = '';
    factory.runtime.atomicTransition(() => {
      factory.runtime.stockDelta('child/inbox', -1);
      childId = factory.runtime.create('child/inbox', { item: source.item, url: source.url, source: 'channel:fixture.ready', data: { ...delivery.data, express: true, channelDelivery: delivery.id } }).id;
    });
    factory.runtime.pause(); await close(factory); factory = await boot();
    assert.equal(factory.channels!.status()[0].targetToken, childId); assert.equal(children(factory).length, 1);
    assert.equal(factory.state.nodes['child/inbox'].stock, 0);
    factory.runtime.resume(); await settle(factory);
    assert.equal(factory.channels!.status()[0].status, 'acknowledged'); assert.equal(children(factory).length, 1);
  } finally { await close(factory); }
});

test('completed child is acknowledged after an ack commit fails without repeating work', async t => {
  let calls = 0, injected = false;
  const execute: Executor = async ctx => { if (ctx.node.key === 'child/paid') calls++; return success(ctx); };
  let factory = await boot(execute);
  t.mock.method(console, 'error', () => {});
  try {
    const source = parent(factory); emit(factory, source.id);
    const append = factory.journal.append.bind(factory.journal);
    factory.journal.append = event => {
      if (!injected && event.kind === 'channel.delivery' && event.delivery.status === 'acknowledged') { injected = true; throw new Error('Fixture crash before ack commit'); }
      return append(event);
    };
    factory.runtime.start('Ack recovery'); await settle(factory);
    assert.equal(calls, 1); assert.equal(injected, true); assert.equal(children(factory)[0].status, 'published');
    assert.equal(factory.channels!.status()[0].status, 'delivered');
    await close(factory); factory = await boot(execute);
    assert.equal(factory.channels!.status()[0].status, 'acknowledged');
    factory.runtime.resume(); await settle(factory); assert.equal(calls, 1);
    assert.equal(children(factory).length, 1); assert.equal(factory.state.nodes['child/published'].stock, 1);
  } finally { await close(factory); }
});

test('legacy emitter inventory and repeated emissions migrate exactly once', async () => {
  let factory = await boot();
  try {
    const source = parent(factory); factory.channels!.close();
    factory.runtime.atomicTransition(() => {
      for (let i = 0; i < 2; i++) factory.journal.append({ kind: 'channel.emitted', channel: 'fixture.ready', token: source.id, item: source.item });
      factory.runtime.stockDelta('child/inbox', 2, 'Old emitter counted each event');
    });
    await close(factory); factory = await boot();
    assert.equal(factory.channels!.status().length, 1); assert.equal(factory.channels!.status()[0].emissions?.length, 2);
    assert.equal(factory.state.nodes['child/inbox'].stock, 1);
    await close(factory); factory = await boot(); assert.equal(factory.state.nodes['child/inbox'].stock, 1);
    factory.runtime.start('Migrate and consume'); await settle(factory);
    assert.equal(children(factory).length, 1); assert.equal(factory.state.nodes['child/inbox'].stock, 0);
    await close(factory); factory = await boot(); assert.equal(factory.state.nodes['child/inbox'].stock, 0);
    assert.equal(factory.channels!.status()[0].status, 'acknowledged');
  } finally { await close(factory); }
});

test('retry survives restart, preserves paid results and evidence, and keeps parent and child identities separate', async () => {
  let paid = 0, reviews = 0;
  const execute: Executor = async ctx => {
    if (ctx.node.key === 'child/paid') { paid++; return { ok: true, summary: 'Paid work', data: { paidArtifact: 'artifact-from-first-attempt' } }; }
    if (ctx.node.key === 'child/review') {
      reviews++; assert.equal(ctx.token.data.paidArtifact, 'artifact-from-first-attempt');
      if (reviews === 1) return { ok: false, summary: 'Fixture timeout', failure: { tag: 'network_timeout', category: 'system', message: 'Fixture network timeout', retryable: true, owner: 'system' } };
    }
    return success(ctx);
  };
  let factory = await boot(execute);
  try {
    factory.runtime.start('Resume only failed review');
    const source = parent(factory);
    factory.journal.append({ kind: 'token.data', token: source.id, patch: { failure: { message: 'parent marker' }, checkpointDone: ['parent/prepare'], __runtimePrivate: 'parent-only', sourceCandidate: 'parent-source' } });
    emit(factory, source.id); await settle(factory);
    const failed = factory.channels!.status()[0], oldChild = factory.state.tokens[failed.targetToken!];
    assert.equal(failed.status, 'failed'); assert.equal(paid, 1); assert.equal(reviews, 1);
    assert.equal(oldChild.data.__runtimePrivate, undefined); assert.equal(oldChild.data.sourceCandidate, undefined);
    assert.equal(oldChild.item, source.item); assert.notEqual(oldChild.id, source.id);
    factory.journal.append({ kind: 'evidence.added', evidence: { id: 'paid-evidence', kind: 'text', label: 'Paid result', station: 'child/paid', token: oldChild.id, attempt: oldChild.attempts[1], at: Date.now() } });
    factory.runtime.pause(); factory.channels!.retry(failed.id);
    factory.runtime.setScopePaused({ scope: 'station', key: 'child/review', paused: true, reason: 'Inspect failed review' });
    assert.equal(factory.channels!.status()[0].status, 'pending'); assert.equal(factory.channels!.status()[0].targetToken, oldChild.id);
    await close(factory); factory = await boot(execute);
    assert.equal(factory.channels!.status()[0].status, 'pending');
    factory.runtime.resume(); await settle(factory);
    assert.equal(reviews, 1); assert.equal(children(factory).length, 1, 'paused retry station retains the existing failed child');
    factory.runtime.setScopePaused({ scope: 'station', key: 'child/review', paused: false, reason: 'Review is ready' }); await settle(factory);
    const result = factory.channels!.status()[0], child = factory.state.tokens[result.targetToken!];
    assert.equal(result.status, 'acknowledged'); assert.equal(result.attempts, 2);
    assert.equal(paid, 1); assert.equal(reviews, 2); assert.equal(child.data.retryOf, oldChild.id);
    assert.equal(child.data.channelDelivery, failed.id); assert.equal(child.data.paidArtifact, 'artifact-from-first-attempt');
    assert.ok(child.evidence.some(id => factory.state.evidence[id].meta?.reusedFrom === 'paid-evidence'));
    assert.equal(factory.state.nodes['child/inbox'].stock, 0); assert.equal(children(factory).length, 2);
    assert.equal(factory.state.tokens[source.id].status, 'active');
    assert.equal(latestRunTokens(factory.state).filter(token => token.item === source.item).length, 2, 'parent and latest child remain distinct current work');
    assert.equal(Object.keys(factory.state.recoveries).length, 0, 'child failure does not overwrite a parent candidate recovery');
  } finally { await close(factory); }
});

test('a failed child without a durable checkpoint is blocked rather than restarted from its entrance', async () => {
  const factory = await boot(async () => ({ ok: false, summary: 'Fixture failure', error: 'fixture timeout' }));
  try {
    const source = parent(factory); emit(factory, source.id); factory.runtime.start('Missing checkpoint'); await settle(factory);
    const delivery = factory.channels!.status()[0];
    factory.journal.append({ kind: 'token.data', token: delivery.targetToken!, patch: { runtimeCheckpoint: null } });
    assert.throws(() => factory.channels!.retry(delivery.id), /持久检查点/);
    assert.equal(children(factory).length, 1); assert.equal(factory.channels!.status()[0].status, 'failed');
  } finally { await close(factory); }
});

test('component continuations are finite, unique and discard prior batch execution output', async () => {
  const all = Array.from({ length: 45 }, (_, i) => `https://fixture.test/components/${i}`), cursors: number[] = [];
  const factory = await boot(async ctx => {
    assert.equal(ctx.node.key, 'components/discover'); const cursor = Number(ctx.token.data.componentCursor ?? 0); cursors.push(cursor);
    if (cursor > 0) { assert.equal(ctx.token.data.componentCaptures, undefined); assert.equal(ctx.token.data.businessPublished, undefined); assert.equal(ctx.token.data.atlasChanges, undefined); }
    return { ok: true, summary: 'Discovered next bounded batch', data: { componentDiscovery: { all, total: all.length, cursor, next: cursor + 20 < all.length ? cursor + 20 : null }, componentCaptures: ['previous batch only'], businessPublished: 'previous batch only', atlasChanges: ['previous batch only'] } };
  });
  try {
    factory.runtime.start('Finite component continuation');
    factory.runtime.create('components/discover', { item: 'component-site', url: 'https://fixture.test/components', source: 'manual', data: { input: { text: 'fixture' }, componentAdapter: { kind: 'fixture' }, componentLimit: 20 } });
    await settle(factory);
    assert.deepEqual(cursors, [0, 20, 40]);
    const deliveries = factory.channels!.status(); assert.equal(deliveries.length, 2); assert.ok(deliveries.every(delivery => delivery.status === 'acknowledged'));
    assert.deepEqual(deliveries.map(delivery => delivery.item), ['component-site#components-20', 'component-site#components-40']);
    factory.channels!.close(); factory.channels = new ChannelSupervisor(factory); await settle(factory);
    assert.deepEqual(cursors, [0, 20, 40]); assert.equal(factory.channels.status().length, 2);
  } finally { await close(factory); }
});
