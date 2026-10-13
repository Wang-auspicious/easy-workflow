import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Executor } from '../server/runtime.ts';
import type { SourceCandidate, SourceSpec } from '../shared/types.ts';
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
const { SourceSupervisor } = await import('../server/sources.ts');
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
  await factory.sources?.close();
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

const sourceSpec = (overrides: Partial<SourceSpec> = {}): SourceSpec => ({
  id: 'fixture-source', name: 'Fixture source', url: 'https://feed.fixture.test/items',
  platform: 'feed.fixture.test', format: 'json', target: 'components/inbox',
  intervalMs: 86400000, enabled: false, input: {text: 'title'}, ...overrides,
});
const sourceItem = (id: string): SourceCandidate => ({
  id, source: 'fixture-source', platform: 'feed.fixture.test',
  sourceUrl: 'https://feed.fixture.test/items', url: `https://resource.fixture.test/${id}`,
  title: id, author: 'Fixture author', discoveredAt: Date.now(), status: 'pending',
});

test('sources reject middle stations, terminal stores, connected lines and fractional rate limits', async () => {
  const factory = await boot();
  await factory.sources?.close();
  const sources = new SourceSupervisor(factory);
  try {
    for (const target of ['components/published', 'components/discover', 'child/inbox', 'child/paid']) {
      assert.throws(() => sources.configure(sourceSpec({target})), /入口|上游|独立/);
    }
    for (const field of ['perMinute', 'perDay', 'limit'] as const) {
      assert.throws(() => sources.configure(sourceSpec({[field]: 1.5})), /整数/);
    }
    for (const constants of [JSON.parse('{"__proto__":{"polluted":true}}'), {constructor: 'reserved'}, {prototype: 'reserved'}, ['not an object'], new Date()]) {
      assert.throws(() => sources.configure(sourceSpec({constants})), /保留字段|普通对象/);
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(sources.configure(sourceSpec()).target, 'components/inbox');
    assert.equal(sources.configure(sourceSpec({target: 'parent/prepare'})).target, 'parent/prepare', 'declared manifest entry remains supported');
  } finally {
    await sources.close();
    await close(factory);
  }
});

test('a source terminal result in the same committed batch is acknowledged and retry lineage cannot lose completion', async () => {
  const factory = await boot();
  await factory.sources?.close();
  let sources = new SourceSupervisor(factory);
  try {
    sources.configure(sourceSpec());
    const candidate = sourceItem('same-batch');
    factory.journal.append({kind: 'source.candidate', candidate});
    factory.runtime.atomicTransition(() => {
      // A legacy record can finish before its delivered receipt in the same commit.
      const token = factory.runtime.create('components/published', {
        item: candidate.id, url: candidate.url, source: 'source:fixture-source',
        data: {sourceCandidate: candidate.id},
      });
      factory.journal.append({kind: 'source.candidate', candidate: {...candidate, status: 'delivered', targetToken: token.id}});
    });
    assert.equal(sources.list()[0].candidates[0].status, 'acknowledged');
    const retryCandidate = sourceItem('retried');
    const original = factory.runtime.create('components/inbox', {
      item: retryCandidate.id, url: retryCandidate.url, source: 'source:fixture-source',
      data: {sourceCandidate: retryCandidate.id},
    });
    factory.journal.append({kind: 'source.candidate', candidate: {...retryCandidate, status: 'failed', targetToken: original.id}});
    const retry = factory.runtime.create('components/published', {
      item: retryCandidate.id, url: retryCandidate.url, source: 'source:fixture-source',
      data: {sourceCandidate: retryCandidate.id, retryOf: original.id},
    });
    assert.equal(sources.list()[0].candidates[1].status, 'acknowledged');
    assert.equal(sources.list()[0].candidates[1].targetToken, retry.id);
    const accepted = [...factory.journal.read()].filter(event => event.kind === 'source.reputation').at(-1);
    assert.equal(accepted?.kind === 'source.reputation' && accepted.accepted, 2);
    await sources.close();
    sources = new SourceSupervisor(factory);
    assert.equal(sources.list()[0].candidates[1].targetToken, retry.id);
    assert.equal([...factory.journal.read()].filter(event => event.kind === 'source.reputation').length, 2, 'replay never credits the same success twice');
  } finally {
    await sources.close();
    await close(factory);
  }
});

test('source delivery is bounded, respects pauses and rolls back a failed claim before restart', async t => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => {release = resolve;});
  const execute: Executor = async ctx => {
    await blocked;
    return success(ctx);
  };
  let factory = await boot(execute);
  await factory.sources?.close();
  let sources = new SourceSupervisor(factory);
  t.mock.method(console, 'error', () => {});
  try {
    sources.configure(sourceSpec({enabled: true}));
    factory.journal.append({kind: 'source.polled', source: 'fixture-source', nextAt: Date.now() + 86400000, count: 0, duplicates: 0});
    for (let i = 0; i < 3; i++) factory.journal.append({kind: 'source.candidate', candidate: sourceItem(`bounded-${i}`)});
    factory.runtime.start('Bounded source admission');
    factory.runtime.pause();
    sources.pump();
    assert.equal(Object.keys(factory.state.tokens).length, 0);
    factory.runtime.setScopePaused({scope: 'line', key: 'components', paused: true, reason: 'Source fixture pause'});
    factory.runtime.resume();
    sources.pump();
    assert.equal(Object.keys(factory.state.tokens).length, 0);
    factory.runtime.setScopePaused({scope: 'line', key: 'components', paused: false, reason: 'Source fixture resume'});
    factory.broker.modelHold = 'Fixture provider cooldown';
    sources.pump();
    assert.equal(Object.keys(factory.state.tokens).length, 0);
    assert.match(sources.list()[0].deliveryHold ?? '', /cooldown/);
    factory.broker.modelHold = null;
    factory.journal.append({kind: 'batch.configured', batch: {
      runId: factory.state.run.id, target: 1, maxInFlight: 1, intakeWindow: 1,
      maxRecoveries: 2, mode: 'running', startedAt: Date.now(), category: 'scoped-fixture',
    }});
    sources.pump();
    assert.equal(Object.keys(factory.state.tokens).length, 0, 'sources cannot consume an unrelated managed batch target');
    assert.match(sources.list()[0].deliveryHold ?? '', /筛选范围/);
    factory.runtime.end();
    factory.runtime.start('Unmanaged source fixture');
    let injected = false;
    const append = factory.journal.append.bind(factory.journal);
    factory.journal.append = event => {
      if (!injected && event.kind === 'source.candidate' && event.candidate.status === 'delivered') {
        injected = true;
        throw new Error('Fixture source claim crash');
      }
      return append(event);
    };
    assert.throws(() => sources.pump(), /claim crash/);
    assert.equal(Object.keys(factory.state.tokens).length, 0);
    assert.ok(sources.list()[0].candidates.every(candidate => candidate.status === 'pending'));
    await sources.close();
    await close(factory);
    factory = await boot(execute);
    await factory.sources?.close();
    sources = new SourceSupervisor(factory);
    factory.runtime.resume();
    sources.pump();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(Object.keys(factory.state.tokens).length, 1, 'default source admission never opens twelve tasks');
    assert.match(sources.list()[0].deliveryHold ?? '', /1 件/);
    assert.equal(sources.list()[0].candidates.filter(candidate => candidate.status === 'pending').length, 2);
    release();
    await settle(factory);
    assert.equal(Object.keys(factory.state.tokens).length, 3);
    assert.ok(sources.list()[0].candidates.every(candidate => candidate.status === 'acknowledged'));
    assert.equal(new Set(sources.list()[0].candidates.map(candidate => candidate.targetToken)).size, 3);
  } finally {
    release();
    await sources.close();
    await close(factory);
  }
});

test('manual and parked records retain their backlog without consuming source execution slots', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => {release = resolve;});
  const factory = await boot(async ctx => {
    if (ctx.token.item === 'manual-backlog' || ctx.token.item === 'parked-backlog') {
      return {
        ok: true, summary: 'Fixture retained for later resolution',
        finish: {status: ctx.token.item === 'manual-backlog' ? 'manual' : 'parked', reason: 'Fixture awaiting separate recovery'},
      };
    }
    await blocked;
    return success(ctx);
  });
  await factory.sources.close();
  const sources = new SourceSupervisor(factory);
  try {
    factory.runtime.start('Source slots count live work');
    for (const item of ['manual-backlog', 'parked-backlog']) {
      factory.runtime.create('components/inbox', {
        item, url: `https://resource.fixture.test/${item}`, source: 'manual',
        data: {input: {text: item}, express: true},
      });
    }
    await settle(factory);
    assert.deepEqual(Object.values(factory.state.tokens).map(token => token.status), ['manual', 'parked']);
    assert.ok([...factory.runtime.tokens.values()].every(token => token.finished));
    sources.configure(sourceSpec({enabled: true}));
    for (const id of ['source-one', 'source-two']) {
      factory.journal.append({kind: 'source.candidate', candidate: sourceItem(id)});
    }
    sources.pump();
    await new Promise<void>(resolve => setImmediate(resolve));
    const created = Object.values(factory.state.tokens).filter(token => token.data.sourceCandidate);
    assert.equal(created.length, 1, 'terminal manual/parked records cannot block the first new source task');
    assert.equal(created[0].status, 'active');
    sources.pump();
    assert.equal(Object.values(factory.state.tokens).filter(token => token.data.sourceCandidate).length, 1, 'a real active task still holds the single execution slot');
    assert.equal(sources.list()[0].counts.pending, 1);
    release();
    await settle(factory);
    assert.equal(sources.list()[0].counts.acknowledged, 2);
    assert.deepEqual(Object.values(factory.state.tokens).slice(0, 2).map(token => token.status), ['manual', 'parked']);
  } finally {
    release();
    await sources.close();
    await close(factory);
  }
});

test('source login, timeout, persisted quotas and backlog affect only the configured source', async t => {
  const factory = await boot();
  await factory.sources.close();
  let now = Date.now();
  let sources = new SourceSupervisor(factory, {now: () => now, random: () => 0});
  let calls = 0;
  t.mock.method(factory.toolbox, 'call', async (_allowed: unknown, _name: unknown, args: {url: string}) => {
    calls++;
    if (args.url.includes('/login')) {
      return {ok: false, failure: {tag: 'auth_required', message: 'Fixture requires login', owner: 'user', retryable: false}};
    }
    if (args.url.includes('/timeout')) throw new Error('request timed out');
    return {ok: true, links: [{href: 'https://resource.fixture.test/healthy', text: 'Healthy source'}]};
  });
  try {
    for (const id of ['login', 'timeout', 'healthy']) {
      sources.configure(sourceSpec({id, format: 'browser', platform: id, url: `https://feed.fixture.test/${id}`, enabled: true}));
    }
    await sources.runDue();
    const first = sources.list();
    assert.match(first.find(source => source.id === 'login')?.attention ?? '', /login/);
    assert.equal(first.find(source => source.id === 'timeout')?.attention, undefined, 'a transport timeout is scheduled for bounded later retry');
    assert.equal(first.find(source => source.id === 'timeout')?.failure?.tag, 'network_timeout', 'the last failure remains visible instead of looking like an empty successful poll');
    assert.equal(first.find(source => source.id === 'healthy')?.candidates.length, 1);
    assert.equal(calls, 3);
    await sources.close();
    sources = new SourceSupervisor(factory, {now: () => now, random: () => 0});
    assert.deepEqual(await sources.run('healthy'), {deferred: true, nextAt: now + 10000, reason: '平台访问次数或随机间隔尚未到期'});
    assert.equal(calls, 3, 'replay retains the rate ledger');
    now += 20000;
    await sources.run('healthy');
    assert.equal(sources.list().find(source => source.id === 'healthy')?.candidates.length, 1);
    assert.equal([...factory.journal.read()].filter(event => event.kind === 'source.candidate').length, 1, 'same-source duplicates do not append the raw excerpt repeatedly');
    for (let i = 0; i < 499; i++) factory.journal.append({kind: 'source.candidate', candidate: {...sourceItem(`backlog-${i}`), source: 'healthy'}});
    now += 20000;
    const held = await sources.run('healthy');
    assert.ok(held && typeof held === 'object' && 'deferred' in held && held.deferred === true);
    assert.ok('reason' in held && typeof held.reason === 'string');
    assert.match(held.reason, /500/);
    assert.equal(calls, 4, 'a full unresolved backlog does not request another page');
    const full = sources.list().find(source => source.id === 'healthy')!;
    assert.match(full.deferred?.reason ?? '', /500/);
    assert.equal(full.counts.total, 500);
    assert.equal(full.counts.pending, 500);
    assert.equal(full.candidates.length, 50, 'periodic status never returns every historical candidate body');
    assert.equal(full.hasMoreCandidates, true);
    assert.equal(full.candidates.at(-1)?.id, 'backlog-498');
  } finally {
    await sources.close();
    await close(factory);
  }
});

test('a downstream rejection resolves its source backlog without counting as publication', async () => {
  const factory = await boot(async () => ({
    ok: true, summary: 'Fixture excluded invalid resource',
    finish: {status: 'rejected', reason: 'Fixture URL is not an eligible resource'},
  }));
  await factory.sources.close();
  const sources = new SourceSupervisor(factory);
  try {
    sources.configure(sourceSpec({enabled: true}));
    factory.journal.append({kind: 'source.candidate', candidate: sourceItem('excluded')});
    factory.runtime.start('Source exclusion');
    sources.pump();
    await settle(factory);
    const candidate = sources.list()[0].candidates[0];
    assert.equal(candidate.status, 'rejected');
    assert.equal(factory.state.tokens[candidate.targetToken!].status, 'rejected');
    assert.equal(sources.list()[0].deferred, undefined);
    assert.equal(sources.list()[0].deliveryHold, undefined);
    const reputation = [...factory.journal.read()].filter(event => event.kind === 'source.reputation').at(-1);
    assert.equal(reputation?.kind === 'source.reputation' && reputation.accepted, 0);
    assert.equal(reputation?.kind === 'source.reputation' && reputation.rejected, 1);
  } finally {
    await sources.close();
    await close(factory);
  }
});

test('source HTTP collection shares capacity and releases it after cancellation', async () => {
  const {createServer} = await import('node:http');
  let hits = 0;
  let hanging = false;
  const server = createServer((_request, response) => {
    hits++;
    if (!hanging) response.end('[]');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const factory = await boot();
  await factory.sources.close();
  const sources = new SourceSupervisor(factory);
  factory.broker.limits.http = 1;
  const lease = factory.broker.tryAcquire('http');
  assert.ok(lease);
  try {
    const url = `http://127.0.0.1:${(server.address() as {port: number}).port}/feed`;
    sources.configure(sourceSpec({format: 'json', url}));
    const deferred = await sources.run('fixture-source');
    assert.ok(deferred && typeof deferred === 'object' && 'deferred' in deferred && deferred.deferred);
    assert.match(sources.list()[0].deferred?.reason ?? '', /HTTP/);
    assert.equal(hits, 0);
    assert.equal([...factory.journal.read()].filter(event => event.kind === 'source.requested').length, 0,
      'capacity waiting cannot spend a platform request');
    lease.release();
    const result = await sources.run('fixture-source');
    assert.ok(result && typeof result === 'object' && 'ok' in result && result.ok);
    assert.equal(hits, 1);
    assert.equal(factory.broker.used.http, 0);
    sources.configure(sourceSpec({id: 'cancel-source', format: 'json', url, platform: 'cancel-fixture'}));
    hanging = true;
    const pending = sources.run('cancel-source');
    for (let i = 0; i < 100 && hits < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(hits, 2);
    assert.equal(factory.broker.used.http, 1);
    await sources.close();
    const cancelled = await pending;
    assert.ok(cancelled && typeof cancelled === 'object' && 'cancelled' in cancelled && cancelled.cancelled);
    assert.equal(factory.broker.used.http, 0);
  } finally {
    lease.release();
    await sources.close();
    await close(factory);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
