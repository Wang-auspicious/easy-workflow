import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import { Journal } from '../server/journal.ts';
import {restoreSnapshots, saveSnapshots, snapshotVersion, type Snapshottable} from '../server/snapshots.ts';
import {apply, deserializeSnapshot, deserializeState, initialState, serializeSnapshot, serializeState, validateState} from '../shared/project.ts';
import type {JournalEvent, Stamped} from '../shared/types.ts';

test('journal rollback preserves durable rows, sequence, run and all subscriber visibility', () => {
  const journal = new Journal(':memory:');
  const projection: number[] = [], observed: number[] = [], effects: string[] = [];
  journal.subscribeProjection(event => projection.push(event.seq));
  journal.subscribe(event => observed.push(event.seq));
  try {
    journal.append({ kind: 'run.started', runId: 'original', title: 'original' });
    assert.throws(() => journal.atomic(() => {
      journal.append({ kind: 'run.started', runId: 'rolled-back', title: 'rolled-back' });
      journal.afterCommit(() => effects.push('must not run'));
      assert.deepEqual(projection, [1]); assert.deepEqual(observed, [1]);
      throw new Error('fixture write failure');
    }), /fixture write failure/);
    assert.equal(journal.seq, 1); assert.equal(journal.run, 'original');
    assert.deepEqual([...journal.read()].map(event => event.seq), [1]);
    assert.deepEqual(projection, [1]); assert.deepEqual(observed, [1]); assert.deepEqual(effects, []);
    const next = journal.append({ kind: 'dispatch.note', tone: 'info', text: 'after rollback' });
    assert.equal(next.seq, 2); assert.equal(next.run, 'original');
  } finally { journal.close(); }
});

test('committed projections precede notifications and nested writes preserve subscriber sequence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-journal-atomic-'));
  const file = path.join(dir, 'journal.db');
  const journal = new Journal(file), reader = new Journal(file, true);
  const projected: number[] = [], first: number[] = [], second: number[] = [];
  const committedEffects: number[][] = [];
  let visibleAtNotification: number[] = [], projectedAtNotification: number[] = [], projectedAfterWrite: number[] = [];
  journal.subscribeProjection(event => projected.push(event.seq));
  journal.subscribe(event => {
    first.push(event.seq);
    if (event.seq === 1) {
      visibleAtNotification = [...reader.read()].map(e => e.seq);
      projectedAtNotification = [...projected];
      journal.append({ kind: 'dispatch.note', tone: 'info', text: 'listener follow-up' });
      projectedAfterWrite = [...projected];
    }
  });
  journal.subscribe(event => second.push(event.seq));
  try {
    journal.atomic(() => {
      journal.append({ kind: 'run.started', runId: 'atomic', title: 'atomic' });
      journal.atomic(() => journal.append({ kind: 'run.paused', runId: 'atomic' }));
      journal.afterCommit(() => committedEffects.push([...reader.read()].map(event => event.seq)));
      assert.deepEqual([...reader.read()], []);
      assert.deepEqual(projected, []); assert.deepEqual(first, []);
    });
    assert.deepEqual(visibleAtNotification, [1, 2], 'the full transition is already visible in another connection');
    assert.deepEqual(projectedAtNotification, [1, 2], 'consumers see the committed state before reacting');
    assert.deepEqual(projectedAfterWrite, [1, 2, 3], 'synchronous commands see their own committed write');
    assert.deepEqual(first, [1, 2, 3]); assert.deepEqual(second, [1, 2, 3]);
    assert.deepEqual(committedEffects, [[1, 2, 3]]);
    assert.equal(journal.seq, 3);
  } finally {
    reader.close(); journal.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('async transaction callbacks are rejected before their body can run', () => {
  const journal = new Journal(':memory:');
  let invoked = false;
  try {
    assert.throws(() => journal.atomic(async () => { invoked = true; }), /synchronous/);
    assert.equal(invoked, false); assert.equal(journal.seq, 0);
  } finally { journal.close(); }
});

test('filtered replay preserves cross-kind order, bounds and detached historical payloads', () => {
  const journal = new Journal(':memory:');
  try {
    journal.append({kind: 'run.started', runId: 'first', title: 'First'});
    journal.append({kind: 'token.data', token: 'fixture', patch: {nested: {value: 'original'}}});
    journal.append({kind: 'dispatch.note', tone: 'info', text: 'Unrelated large payload'.repeat(1000)});
    journal.append({kind: 'run.ended', runId: 'first', manual: true});
    journal.append({kind: 'run.started', runId: 'second', title: 'Second'});
    const kinds = ['run.started', 'token.data', 'run.started'] as const;
    assert.deepEqual([...journal.readKinds(kinds)], [...journal.read()].filter(event => kinds.includes(event.kind as typeof kinds[number])));
    assert.deepEqual([...journal.readKinds(kinds, 1, 4)].map(event => event.seq), [2]);
    assert.deepEqual([...journal.readKinds([])], []);
    const first = [...journal.readKinds(['token.data'])][0];
    if (first.kind !== 'token.data') assert.fail('Expected data');
    (first.patch.nested as {value: string}).value = 'mutated';
    const second = [...journal.readKinds(['token.data'])][0];
    assert.equal(second.kind === 'token.data' && (second.patch.nested as {value: string}).value, 'original');
  } finally { journal.close(); }
});

function stateProjection() {
  let state = initialState();
  return {
    snapshotName: 'factory-state',
    get state() { return state; },
    serialize: () => serializeState(state),
    restore: (body: string) => { state = deserializeState(body); },
    observe: (event: Stamped) => { apply(state, event); },
  } satisfies Snapshottable & {readonly state: ReturnType<typeof initialState>};
}

test('snapshot codec retains own undefined properties, Map/Set, tag collisions and safe property names', () => {
  const value = {
    optional: undefined,
    nested: [undefined, new Map([['one', new Set([1, undefined])]])],
    tags: {$map: 'ordinary data', $undefined: false, $object: [['name', 'literal']]},
    reserved: JSON.parse('{"__proto__":{"polluted":true},"constructor":"ordinary"}'),
    nullPrototype: Object.assign(Object.create(null), {optional: undefined}),
    numbers: [NaN, Infinity, -Infinity, -0],
  };
  const restored = deserializeSnapshot(serializeSnapshot(value));
  assert.deepStrictEqual(restored, value);
  assert.equal(Object.hasOwn(restored as object, 'optional'), true);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
  assert.deepStrictEqual(deserializeState(serializeState(initialState())), initialState());
  const state = initialState();
  assert.equal(validateState(state), state, 'validation reuses the decoded state tree');
  for (const body of ['{"$map":[[1]]}', '{"$set":{}}', '{"$undefined":false}', '{"$number":"bad"}',
    '{"$map":[],"extra":0}', '{"$object":[[1,2]]}', '{"$object":[["a",1],["a",2]]}']) {
    assert.throws(() => deserializeSnapshot(body), /Invalid snapshot encoding/);
  }
  assert.throws(() => deserializeState('{"seq":0}'), /Invalid factory state snapshot/);
  const invalid = initialState();
  invalid.nodes.fixture = null as never;
  assert.throws(() => deserializeState(serializeState(invalid)), /Invalid factory state snapshot/);
});

test('snapshot codec preserves repeated references structurally and rejects object or tagged cycles', () => {
  const shared = {value: undefined, tags: {$set: ['literal'], $map: [['literal', 1]]}};
  const value = {first: shared, second: shared, map: new Map([[shared, new Set([shared])]])};
  assert.deepStrictEqual(deserializeSnapshot(serializeSnapshot(value)), value);
  const object: Record<string, unknown> = {};
  object.self = object;
  const map = new Map<unknown, unknown>();
  map.set('self', map);
  const set = new Set<unknown>();
  set.add(set);
  const escaped: Record<string, unknown> = {$map: 'literal'};
  escaped.self = escaped;
  for (const circular of [object, map, set, escaped]) assert.throws(() => serializeSnapshot(circular), /Circular snapshot value/);
  for (const unsupported of [new Date(), 1n, () => undefined, Symbol('fixture')]) {
    assert.throws(() => serializeSnapshot(unsupported), /Unsupported snapshot/);
  }
});

test('20,000 events replay identically from snapshots at 5,000, 12,000 and 20,000', () => {
  const journal = new Journal(':memory:');
  const events: Stamped[] = [];
  try {
    journal.atomic(() => {
      events.push(journal.append({kind: 'run.started', runId: 'snapshot-fixture', title: 'Snapshot fixture'}));
      for (let index = 0; journal.seq < 20_000; index++) {
        const token = `token-${index}`;
        const worker = `worker-${index}`;
        const attempt = `attempt-${index}`;
        const node = `fixture/station-${index % 3}`;
        const cycle: JournalEvent[] = [
          {kind: 'token.created', token, line: 'fixture', item: token, url: 'https://fixture.invalid/', source: 'fixture'},
          {kind: 'worker.spawned', worker, node, label: worker, reason: 'fixture'},
          {kind: 'token.queued', token, node},
          {kind: 'attempt.started', attempt, token, node, worker, input: 'fixture'},
          {kind: 'attempt.finished', attempt, ok: true, summary: 'fixture completed', ms: index % 100, queuedMs: index % 7,
            usage: {input: index % 17, output: index % 11, cost: 0}},
          {kind: 'token.data', token, patch: {nested: {index}, tags: {$map: 'literal user data'}}},
          {kind: 'token.finished', token, node, status: index % 2 ? 'published' : 'manual', reason: 'fixture'},
          {kind: 'worker.retired', worker, node, reason: 'fixture'},
        ];
        for (const event of cycle) if (journal.seq < 20_000) events.push(journal.append(event));
      }
    });
    assert.equal(events.length, 20_000);
    const complete = stateProjection();
    const cuts = [5_000, 12_000, 20_000];
    for (const event of events) {
      complete.observe(event);
      if (cuts.includes(event.seq)) {
        journal.writeSnapshot(complete.snapshotName, event.seq, snapshotVersion(`fixture-${event.seq}`), complete.serialize());
      }
    }
    const read = journal.read.bind(journal);
    let reads = 0;
    journal.read = function* (since = 0, run?: string, through?: number) {
      reads++;
      yield* read(since, run, through);
    };
    for (const cut of cuts) {
      const restored = stateProjection();
      const result = restoreSnapshots(journal, [restored], snapshotVersion(`fixture-${cut}`));
      assert.deepStrictEqual(restored.state, complete.state, `state at cut ${cut}`);
      assert.deepEqual(result, {replayed: 20_000 - cut, fullReplay: false, through: 20_000});
    }
    assert.equal(reads, 3, 'each restore shares exactly one tail read');
    const mismatched = stateProjection();
    assert.deepEqual(restoreSnapshots(journal, [mismatched], snapshotVersion('different-digest')),
      {replayed: 20_000, fullReplay: true, through: 20_000});
    assert.deepStrictEqual(mismatched.state, complete.state);
  } finally { journal.close(); }
});

test('mixed snapshot cursors share a single read and invalid snapshots fall back without logging payloads', t => {
  const journal = new Journal(':memory:');
  const version = snapshotVersion('mixed');
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  const components = ['factory-state', 'docs', 'lessons', 'channels', 'sources', 'outbox'].map(snapshotName => {
    let sequences: number[] = [];
    return {
      snapshotName,
      get sequences() { return sequences; },
      serialize: () => serializeSnapshot(sequences),
      restore: (body: string) => {
        const value = deserializeSnapshot(body);
        if (!Array.isArray(value) || !value.every(Number.isSafeInteger)) throw new Error('Invalid fixture');
        sequences = value as number[];
      },
      observe: (event: Stamped) => { sequences.push(event.seq); },
    } satisfies Snapshottable & {readonly sequences: number[]};
  });
  try {
    for (let i = 0; i < 8; i++) journal.append({kind: 'dispatch.note', tone: 'info', text: `fixture-${i}`});
    journal.writeSnapshot('factory-state', 8, version, serializeSnapshot([1, 2, 3, 4, 5, 6, 7, 8]));
    journal.writeSnapshot('docs', 3, version, serializeSnapshot([1, 2, 3]));
    journal.writeSnapshot('lessons', 7, version, '{private fixture payload');
    journal.writeSnapshot('channels', 6, version, serializeSnapshot({invalid: true}));
    journal.writeSnapshot('sources', 8, 'old-version', serializeSnapshot([1, 2, 3, 4, 5, 6, 7, 8]));
    const read = journal.read.bind(journal);
    let reads = 0;
    journal.read = function* (since = 0, run?: string, through?: number) {
      reads++;
      yield* read(since, run, through);
    };
    assert.deepEqual(restoreSnapshots(journal, components, version), {replayed: 8, fullReplay: true, through: 8});
    assert.equal(reads, 1);
    for (const component of components) assert.deepEqual(component.sequences, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /name=lessons fallback=full-replay/);
    assert.equal(warnings.join().includes('private fixture payload'), false);
    saveSnapshots(journal, components, version);
    for (const component of components) assert.equal(journal.latestSnapshot(component.snapshotName, version)?.seq, 8);
    journal.atomic(() => {
      assert.equal(journal.inTransaction, true);
      assert.throws(() => saveSnapshots(journal, components, version), /Journal.atomic/);
    });
    assert.equal(journal.inTransaction, false);
  } finally { journal.close(); }
});

test('snapshot retention keeps the newest three per name and indexed run/event queries preserve history', () => {
  const journal = new Journal(':memory:');
  try {
    journal.append({kind: 'run.started', runId: 'first', title: 'First'});
    journal.append({kind: 'run.ended', runId: 'first', manual: true});
    journal.append({kind: 'run.ended', runId: 'first', manual: true});
    journal.append({kind: 'run.started', runId: 'second', title: 'Second'});
    journal.append({kind: 'run.ended', runId: 'second', manual: false});
    for (let seq = 1; seq <= 5; seq++) journal.writeSnapshot('fixture', seq, `version-${seq}`, '{}');
    assert.equal(journal.latestSnapshot('fixture', 'version-1'), null);
    assert.equal(journal.latestSnapshot('fixture', 'version-2'), null);
    for (let seq = 3; seq <= 5; seq++) assert.deepEqual(journal.latestSnapshot('fixture', `version-${seq}`), {seq, body: '{}'});
    journal.writeSnapshot('other', 1, 'version-1', '{}');
    assert.deepEqual(journal.latestSnapshot('other', 'version-1'), {seq: 1, body: '{}'});
    journal.writeSnapshot('fixture', 5, 'replacement', '{"value":true}');
    assert.equal(journal.latestSnapshot('fixture', 'version-5'), null);
    assert.deepEqual(journal.latestSnapshot('fixture', 'replacement'), {seq: 5, body: '{"value":true}'});
    assert.deepEqual(journal.completedRuns(), new Set(['first', 'second']));
    assert.equal(journal.latestEvent('run.ended')?.runId, 'second');
    assert.equal(journal.latestEvent('chat.user'), null);
    journal.atomic(() => assert.throws(() => journal.writeSnapshot('fixture', 5, 'bad', '{}'), /Journal.atomic/));
    assert.throws(() => journal.writeSnapshot('fixture', 6, 'bad', '{}'), /Invalid snapshot/);
  } finally { journal.close(); }
});

test('legacy read-only journals without the snapshot table remain readable without schema changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-snapshot-legacy-'));
  const file = path.join(dir, 'journal.db');
  const database = new DatabaseSync(file);
  database.exec('CREATE TABLE events (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, run TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL)');
  database.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)').run(1, 1, 'legacy', 'run.ended', JSON.stringify({kind: 'run.ended', runId: 'legacy', manual: true}));
  database.close();
  const journal = new Journal(file, true);
  try {
    assert.equal(journal.latestSnapshot('factory-state', snapshotVersion('legacy')), null);
    assert.deepEqual(journal.completedRuns(), new Set(['legacy']));
    const component = stateProjection();
    assert.deepEqual(restoreSnapshots(journal, [component], snapshotVersion('legacy')), {replayed: 1, fullReplay: true, through: 1});
    assert.equal(component.state.run.status, 'ended');
    const check = new DatabaseSync(file, {readOnly: true});
    try {
      assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE name = 'snapshots'").get(), undefined);
    } finally { check.close(); }
  } finally {
    journal.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('Factory restores all six components from mixed cuts and preserves legacy checkpoint/return order', async t => {
  const {Factory} = await import('../server/factory.ts');
  const {Runtime} = await import('../server/runtime.ts');
  const {Broker} = await import('../server/broker.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-six-snapshots-'));
  const file = path.join(directory, 'journal.db');
  const outboxDirectory = path.join(directory, 'work', 'publication-batches');
  fs.mkdirSync(outboxDirectory, {recursive: true});
  const outboxFile = path.join(outboxDirectory, 'outbox.json');
  const outboxBody = JSON.stringify({schemaVersion: 1, cursor: 0, pending: [], blocked: []});
  fs.writeFileSync(outboxFile, outboxBody);
  const stages: JournalEvent[][] = [
    [
      {kind: 'run.started', runId: 'snapshot-history', title: 'Snapshot history'},
      {kind: 'token.created', token: 'legacy-return', item: 'legacy-return', line: 'curation', source: 'manual', url: 'https://fixture.invalid/'},
      {kind: 'attempt.started', attempt: 'legacy-before-return', token: 'legacy-return', node: 'curation/reader', worker: 'fixture', input: 'fixture'},
      {kind: 'attempt.finished', attempt: 'legacy-before-return', ok: true, summary: 'Before return', ms: 1, queuedMs: 0},
      {kind: 'token.returned', token: 'legacy-return', from: 'curation/fact-review', to: 'curation/reader', reason: 'Reset completed nodes', byHuman: false, round: 1, reset: ['curation/reader', 'curation/facts']},
      {kind: 'source.configured', source: {id: 'fixture-source', name: 'Fixture', url: 'https://fixture.invalid/feed', platform: 'fixture', format: 'rss', target: 'curation/reader', enabled: false, intervalMs: 60_000}},
      {kind: 'token.data', token: 'legacy-return', patch: {framework: ['fixture'], checkpointDone: ['curation/reader', 'curation/facts', 'curation/copy'], value: 'at-emission'}},
      {kind: 'channel.emitted', channel: 'fixture-channel', token: 'legacy-return', item: 'legacy-return'},
    ],
    [
      {kind: 'token.data', token: 'legacy-return', patch: {value: 'later-value'}},
      {kind: 'token.queued', token: 'legacy-return', node: 'curation/manual'},
      {kind: 'source.polled', source: 'fixture-source', nextAt: 200, count: 1, duplicates: 0},
      {kind: 'token.created', token: 'legacy-redone', item: 'legacy-redone', line: 'curation', source: 'manual', url: 'https://fixture.invalid/'},
      {kind: 'token.returned', token: 'legacy-redone', from: 'curation/fact-review', to: 'curation/reader', reason: 'Redo reader', byHuman: true, round: 0, reset: ['curation/reader']},
      {kind: 'token.data', token: 'legacy-redone', patch: {checkpointDone: ['curation/reader', 'curation/facts']}},
      {kind: 'attempt.started', attempt: 'legacy-after-return', token: 'legacy-redone', node: 'curation/reader', worker: 'fixture', input: 'fixture'},
      {kind: 'attempt.finished', attempt: 'legacy-after-return', ok: true, summary: 'After return', ms: 1, queuedMs: 0},
      {kind: 'token.created', token: 'checkpointed', item: 'checkpointed', line: 'curation', source: 'manual', url: 'https://fixture.invalid/'},
      {kind: 'token.data', token: 'checkpointed', patch: {runtimeCheckpoint: {version: 1, entry: 'curation/reader', done: ['curation/reader', 'curation/facts'], rounds: {}, notes: [['curation/facts', {reason: 'Checkpoint note', byHuman: false}]]}}},
    ],
    [
      {kind: 'token.returned', token: 'checkpointed', from: 'curation/fact-review', to: 'curation/facts', reason: 'After checkpoint', byHuman: false, round: 1, reset: ['curation/facts']},
      {kind: 'attempt.started', attempt: 'after-checkpoint', token: 'checkpointed', node: 'curation/facts', worker: 'fixture', input: 'fixture'},
      {kind: 'attempt.finished', attempt: 'after-checkpoint', ok: true, summary: 'No newer checkpoint', ms: 1, queuedMs: 0},
      {kind: 'token.queued', token: 'checkpointed', node: 'curation/manual'},
      {kind: 'token.data', token: 'checkpointed', patch: {checkpointDone: ['curation/copy']}},
      {kind: 'token.finished', token: 'legacy-return', node: 'curation/manual', status: 'manual', reason: 'fixture'},
      {kind: 'token.finished', token: 'legacy-redone', node: 'curation/manual', status: 'manual', reason: 'fixture'},
      {kind: 'token.finished', token: 'checkpointed', node: 'curation/published', status: 'published', reason: 'fixture'},
      {kind: 'run.ended', runId: 'snapshot-history', manual: true},
      {kind: 'run.started', runId: 'snapshot-current', title: 'Current run'},
      {kind: 'run.ended', runId: 'snapshot-current', manual: true},
    ],
  ];
  type FactoryInternals = {
    snapshotComponents: Snapshottable[];
    prepareProjection(): Promise<{replayed: number; fullReplay: boolean; through: number}>;
    restore(): void;
  };
  const internals = (factory: InstanceType<typeof Factory>) => factory as unknown as FactoryInternals;
  const captures: {seq: number; bodies: Map<string, string>}[] = [];
  let factory: InstanceType<typeof Factory> | undefined;
  try {
    for (const stage of stages) {
      const writer = new Journal(file);
      for (const event of stage) writer.append(event);
      writer.close();
      factory = new Factory(directory);
      await factory.snapshot();
      captures.push({seq: factory.journal.seq,
        bodies: new Map(internals(factory).snapshotComponents.map(component => [component.snapshotName, component.serialize()]))});
      factory.journal.close();
      factory = undefined;
    }
    assert.deepEqual([...captures[0].bodies.keys()], ['factory-state', 'docs', 'lessons', 'channels', 'sources', 'outbox']);
    const database = new DatabaseSync(file);
    database.exec('DELETE FROM snapshots');
    database.close();
    factory = new Factory(directory);
    await internals(factory).prepareProjection();
    const expected = new Map(internals(factory).snapshotComponents.map(component => [component.snapshotName, deserializeSnapshot(component.serialize())]));
    const events = [...factory.journal.read()];
    const version = snapshotVersion(factory.compiled.digest);
    for (const [index, name] of [...expected.keys()].entries()) {
      const capture = captures[index % captures.length];
      factory.journal.writeSnapshot(name, capture.seq, version, capture.bodies.get(name)!);
    }
    factory.journal.close();
    factory = new Factory(directory);
    const read = factory.journal.read.bind(factory.journal);
    let reads = 0;
    t.mock.method(factory.journal, 'read', function* (since = 0, run?: string, through?: number) {
      reads++;
      yield* read(since, run, through);
    });
    await internals(factory).prepareProjection();
    assert.equal(reads, 1, 'six real components share one bounded tail read');
    for (const component of internals(factory).snapshotComponents) {
      assert.deepStrictEqual(deserializeSnapshot(component.serialize()), expected.get(component.snapshotName), component.snapshotName);
    }
    assert.deepStrictEqual([...read()], events, 'offline snapshots never append business events');
    assert.equal(fs.readFileSync(outboxFile, 'utf8'), outboxBody, 'offline replay preserves the durable outbox checkpoint');
    assert.equal(fs.existsSync(path.join(outboxDirectory, 'records')), false, 'offline replay never prepares publication files');
    factory.broker = new Broker({browser: 1, model: 1, modelWorkers: 1, cpu: 1, http: 1}, 0);
    factory.runtime = new Runtime(factory.compiled, factory.journal, factory.broker, factory.workflowPacks!.conditions, () => null);
    t.mock.method(factory.runtime, 'ensureWorkers', () => {});
    internals(factory).restore();
    assert.deepEqual(factory.runtime.tokens.get('legacy-return')?.done, new Set(['curation/copy', 'curation/manual']));
    assert.deepEqual(factory.runtime.tokens.get('legacy-redone')?.done, new Set(['curation/facts', 'curation/reader']));
    assert.deepEqual(factory.runtime.tokens.get('checkpointed')?.done, new Set(['curation/reader', 'curation/manual']));
    assert.deepEqual(factory.runtime.tokens.get('checkpointed')?.notes, new Map());
    await factory.runtime.close();
    factory.journal.close();
    factory = undefined;
    const corruptor = new Journal(file);
    for (const name of expected.keys()) corruptor.writeSnapshot(name, corruptor.seq, version, '{corrupted fixture');
    corruptor.close();
    factory = new Factory(directory);
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (message: string) => warnings.push(message));
    const restored = await internals(factory).prepareProjection();
    assert.equal(restored.fullReplay, true);
    assert.equal(warnings.length, 6);
    for (const component of internals(factory).snapshotComponents) {
      assert.deepStrictEqual(deserializeSnapshot(component.serialize()), expected.get(component.snapshotName), `corrupted ${component.snapshotName}`);
    }
  } finally {
    await factory?.runtime?.close();
    factory?.journal.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
