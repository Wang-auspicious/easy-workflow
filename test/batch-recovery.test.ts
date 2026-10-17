import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-batch-'));
process.env.FACTORY_VAR = dir;
process.env.FACTORY_PREFLIGHT = '0';
process.env.FACTORY_HTTP_CACHE = '0';
process.env.VISLEXICON_ROOT = path.join(dir, 'unconnected');
const { Factory: BaseFactory } = await import('../server/factory.ts');
const { FactoryControl } = await import('../server/control.ts');
const { SourceSupervisor } = await import('../server/sources.ts');
const { batchSummary } = await import('../shared/batch.ts');
const {apply, initialState} = await import('../shared/project.ts');
const close = async (factory: InstanceType<typeof Factory>) => {
  factory.recovery?.close();
  await factory.sources?.close(); factory.channels?.close();
  await factory.runtime.close(); factory.docs.flush(); factory.lessons.close(); factory.journal.close();
};
const catalog = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `site-${i}`, name: `Site ${i}`, canonicalUrl: `https://site-${i}.example/` }));
// These cases use in-memory executors. Test admission independently of the host's
// free RAM; browser/memory backpressure has its own broker coverage.
class Factory extends BaseFactory {
  override async boot() { await super.boot(); this.broker.memoryFloorMB = 0; }
}

async function proofSupplementFixture() {
  const {EvidenceStore, aHashAsync, runFfmpeg} = await import('../server/evidence.ts');
  const project = path.join(dir, `proof-supplement-${crypto.randomUUID()}`);
  const factory = new Factory(project);
  await factory.boot();
  factory.runtime.start('Retain manual proof evidence');
  factory.runtime.pause();
  const sha = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex');
  const entryId = 'exact-entry';
  const canonical = 'https://fixture.test/entry';
  const capturedAt = '2026-10-13T12:00:00.000Z';
  const makeImage = async (role: string, filter: string, href: string) => {
    const bytes = await runFfmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', filter,
      '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1']);
    const saved = factory.store.put(await EvidenceStore.webpAsync(bytes, 1280, 82), 'webp');
    const hash = await aHashAsync(bytes);
    const captureState = {method: 'browser-native', capturedAt, sourceUrl: href, finalUrl: href,
      viewport: {width: 1280, height: 800}, scroll: {x: 0, y: 800, containers: []}, clip: null,
      actions: [], controls: [], text: `${entryId} actual ${role}`, sha256: saved.sha};
    return {shot: {file: saved.file, href, hash, evidence: `fixture-${role}`, capturedAt, captureState},
      image: {role, src: saved.src, card: saved.src, sha256: saved.sha, ahash: hash,
        href, evidence: `fixture-${role}`, captureState}, saved};
  };
  const identity = await makeImage('identity', 'testsrc=size=1280x800:rate=1', canonical);
  const breadth = await makeImage('breadth', 'smptebars=size=1280x800:rate=1', canonical + '/catalogue');
  const oldProof = await makeImage('proof', 'color=white:size=1280x800,drawbox=x=0:y=0:w=1280:h=400:color=black:t=fill', 'https://fixture.test/sibling');
  const retained = await makeImage('retained', 'testsrc=size=1280x800:rate=1,negate', canonical + '/demo');
  const unknown = {value: 'unknown', sourceUrl: canonical, quote: '', evidence: 'Retained original source', scope: ''};
  const facts = Object.fromEntries(['author', 'organization', 'repository', 'license', 'pricing', 'sourceCode', 'commercial'].map(field => [field, unknown]));
  const token = factory.runtime.create('curation/manual', {item: entryId, url: canonical, source: 'candidates/pool', data: {
    canonical, host: 'fixture.test', kind: 'assets', kindAgreed: true, mode: 'shots',
    readerPlan: {identity: {url: canonical}, breadth: {url: canonical + '/catalogue'},
      proof: {url: canonical + '/demo', locate: 'Actual entry demo', alternatives: []}},
    externalResearch: {entryId, publicationContract: 'site-entry-three-shots'}, facts,
    factPages: [{url: canonical, text: 'Original source body'}], 'fact-reviewVerdict': 'pass',
    shots: {identity: identity.shot, breadth: breadth.shot, proof: oldProof.shot},
    images: [identity.image, breadth.image, oldProof.image], shotReview: 'pass',
    'copy-reviewVerdict': 'pass', auditVerdict: 'pass', gate: 'pass', digest: 'stale-digest',
    reviews: ['classify-review', 'fact-review', 'shot-review', 'copy-review', 'audit'].map(station => ({station, verdict: 'pass', reason: 'Old input only'})),
    style: {old: true}, copy: {old: true}, manualReason: 'Proof is a sibling product',
  }});
  token.entry = 'curation/plan';
  token.closure = factory.runtime.closureOf(token.entry);
  token.done = new Set(['plan', 'identity', 'breadth', 'facts', 'fact-review', 'manual'].map(key => `curation/${key}`));
  token.rounds = {'curation/proof': 3, 'curation/breadth': 1};
  token.notes.set('curation/proof', {byHuman: true, reason: 'Original owner target must remain historical'});
  factory.runtime.checkpoint(token);
  for (const record of [identity, breadth, oldProof, retained]) factory.journal.append({kind: 'evidence.added', evidence: {
    id: record.shot.evidence, token: token.id, attempt: 'retained-capture-attempt', station: 'curation/proof',
    at: Date.parse(capturedAt), kind: 'image', src: record.saved.src,
    label: 'Fixture original capture', meta: {role: record === retained ? 'proof' : record.image.role,
      href: record.shot.href, captureState: record.shot.captureState},
  }});
  factory.journal.append({kind: 'attempt.started', attempt: 'retained-capture-attempt', token: token.id,
    node: 'curation/proof', worker: 'fixture', input: 'Originally captured exact entry proof'});
  factory.journal.append({kind: 'attempt.finished', attempt: 'retained-capture-attempt', ok: true,
    summary: 'Real capture fixture, not a review', ms: 1, queuedMs: 0});
  const write = (name: string, value: unknown) => {
    const file = path.join(project, 'supplements', name);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const bytes = Buffer.from(JSON.stringify(value));
    fs.writeFileSync(file, bytes);
    return {path: file, sha256: sha(bytes)};
  };
  const state = write('retained-state.json', retained.shot.captureState);
  const observation = write('retained-observation.json', {entryId, pages: [{role: 'proof',
    sourceUrl: retained.shot.href, finalUrl: retained.shot.href, capturedAt,
    shot: {sha256: retained.saved.sha}, captureStateSha256: state.sha256}]});
  const manifestValue = {schemaVersion: 1, entryId, role: 'proof',
    image: {path: retained.saved.file, sha256: retained.saved.sha}, state, observation,
    origin: {kind: 'attempt', token: token.id, attempt: 'retained-capture-attempt', evidence: retained.shot.evidence}};
  const manifest = write('manifest.json', manifestValue);
  const control = new FactoryControl(factory);
  const inspect = await control.execute('inspect', {token: token.id});
  const request = {token: token.id, runId: factory.state.run.id,
    expectedCheckpointSha256: inspect.result.proofCheckpointSha256 ?? '0'.repeat(64),
    idempotencyKey: 'proof-once', manifestPath: manifest.path, manifestSha256: manifest.sha256,
    reason: 'Reuse the retained exact-entry proof instead of the sibling fallback'};
  return {factory, token, control, request, retained, identity, breadth, oldProof, facts, write,
    manifestValue, state, observation, project};
}

test('supplement_proof retains a manual checkpoint and old capture bytes, then runs process and independent review only', {timeout: 30000}, async () => {
  const fixture = await proofSupplementFixture();
  const {factory, token, control, request, retained} = fixture;
  try {
    const before = structuredClone(token.data);
    const reply = await control.execute('supplement_proof', request, 'agent');
    const next = factory.runtime.tokens.get(String(reply.result.token))!;
    assert.ok(next && next.id !== token.id);
    assert.equal(factory.runtime.paused, true);
    assert.deepEqual(next.rounds, {'curation/proof': 3, 'curation/breadth': 1});
    assert.deepEqual(factory.state.tokens[next.id].rounds, next.rounds, 'the API projection retains the real checkpoint caps');
    const replayed = initialState(factory.compiled);
    for (const event of factory.journal.read()) apply(replayed, event);
    assert.deepEqual(replayed.tokens[next.id].rounds, next.rounds, 'the original append-only events reconstruct the same counters');
    assert.deepEqual(next.data.facts, before.facts);
    assert.deepEqual(next.data.factPages, before.factPages);
    const oldPlan = before.readerPlan as Record<string, Record<string, unknown>>;
    const nextPlan = next.data.readerPlan as Record<string, Record<string, unknown>>;
    assert.deepEqual(nextPlan.identity, oldPlan.identity, 'an unsupplied identity plan remains unchanged');
    assert.deepEqual(nextPlan.breadth, oldPlan.breadth, 'an unsupplied breadth plan remains unchanged');
    assert.equal(nextPlan.proof.url, retained.shot.captureState.finalUrl);
    assert.match(String(nextPlan.proof.reason), /补证.*待独立审查/);
    assert.equal(nextPlan.proof.locate, oldPlan.proof.locate);
    assert.deepEqual(nextPlan.proof.alternatives, oldPlan.proof.alternatives);
    const archived = JSON.parse(fs.readFileSync(factory.store.resolve(String(reply.result.supersededReviewState))!, 'utf8'));
    assert.deepEqual(archived.readerPlan, oldPlan, 'the complete old target plan remains in immutable audit evidence');
    assert.deepEqual((next.data.shots as Record<string, unknown>).identity, (before.shots as Record<string, unknown>).identity);
    assert.deepEqual((next.data.shots as Record<string, unknown>).breadth, (before.shots as Record<string, unknown>).breadth);
    assert.equal((next.data.shots as {proof: {capturedAt: string}}).proof.capturedAt, '2026-10-13T12:00:00.000Z');
    assert.deepEqual(fs.readFileSync(retained.saved.file), fs.readFileSync((next.data.shots as {proof: {file: string}}).proof.file));
    assert.equal(next.data.shotReview, 'pending');
    assert.equal(next.data['fact-reviewVerdict'], 'pass');
    assert.equal(next.data['copy-reviewVerdict'], 'pending');
    assert.equal(next.data.auditVerdict, 'pending');
    assert.equal(next.data.gate, undefined);
    assert.equal(next.data.digest, undefined);
    assert.deepEqual((next.data.reviews as {station: string}[]).map(review => review.station), ['classify-review', 'fact-review'],
      'old image-dependent passes must not become effective reviews of the new input');
    assert.deepEqual(factory.runtime.queues.get('curation/process'), [next.id]);
    const called: string[] = [];
    const {TOOLS} = await import('../packs/vislexicon/tools.ts');
    factory.runtime.executors = node => async ctx => {
      called.push(node.key);
      if (node.key === 'curation/process') return TOOLS['curation.process'](ctx, {
        store: factory.store, workDir: path.join(fixture.project, 'work'), publishDir: path.join(fixture.project, 'published'), inFlight: () => new Set(),
      });
      assert.equal(node.key, 'curation/shot-review');
      return {ok: true, summary: 'Independent reviewer still rejects this proof', verdict: {
        verdict: 'return', returnTo: 'curation/proof', reason: 'Original content problem remains unresolved',
      }};
    };
    factory.runtime.resume();
    await factory.runtime.settle();
    assert.deepEqual(called, ['curation/process', 'curation/shot-review']);
    assert.equal(factory.state.tokens[next.id].status, 'manual', 'no extra fourth proof attempt is granted');
    assert.equal(next.rounds['curation/proof'], 3);
    assert.equal(factory.state.tokens[next.id].rounds['curation/proof'], 3, 'a rejected review grants no fourth capture in the API projection');
    assert.deepEqual(token.data.runtimeCheckpoint, before.runtimeCheckpoint, 'original checkpoint remains immutable');
    assert.equal(factory.state.evidence[fixture.oldProof.shot.evidence].src, fixture.oldProof.saved.src);
    const execution = [...factory.journal.read()].find(event => event.kind === 'control.executed' && event.tool === 'supplement_proof');
    assert.equal(execution?.kind === 'control.executed' && execution.actor, 'agent');
  } finally {await close(factory); fs.rmSync(fixture.project, {recursive: true, force: true});}
});

test('supplement_proof validates pending native receipts without importing approval and replays one durable successor', {timeout: 30000}, async () => {
  const fixture = await proofSupplementFixture();
  let {factory} = fixture;
  let closed = false;
  try {
    const {runFfmpeg} = await import('../server/evidence.ts');
    const native = (image: {file: string; sha: string}, stem: string) => {
      const original = fixture.retained.shot.captureState;
      const {capturedAt, sourceUrl, finalUrl, sha256: _sha, ...browserState} = original;
      const state = fixture.write(`${stem}-state.json`, {version: 1, entryId: fixture.token.item, role: 'proof',
        sourceUrl, finalUrl, capturedAt, shotSha256: image.sha, browserState,
        roleEvidence: {visible: false, status: 'pending-independent-visual-review'},
        encoding: {noResize: true, width: 1280, height: 800}});
      const observation = fixture.write(`${stem}-receipt.json`, {entryId: fixture.token.item, role: 'proof',
        requestedUrl: sourceUrl, finalUrl, capturedAt, ok: true, independentlyViewed: false,
        file: image.file, sha256: image.sha, stateFile: state.path, stateSha256: state.sha256});
      return fixture.write(`${stem}-manifest.json`, {...fixture.manifestValue,
        image: {path: image.file, sha256: image.sha}, state, observation, origin: {kind: 'observation'}});
    };
    const blank = factory.store.put(await runFfmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i',
      'color=white:size=1280x800', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1']), 'png');
    const emptyManifest = native(blank, 'blank');
    const count = factory.state.tokenOrder.length;
    await assert.rejects(fixture.control.execute('supplement_proof', {...fixture.request,
      manifestPath: emptyManifest.path, manifestSha256: emptyManifest.sha256}),
    (error: unknown) => (error as {code?: string}).code === 'supplement_image_invalid', 'a blank image cannot enter through a raw observation');
    assert.equal(factory.state.tokenOrder.length, count);
    const valid = native(fixture.retained.saved, 'pending');
    const request = {...fixture.request, manifestPath: valid.path, manifestSha256: valid.sha256};
    const first = await fixture.control.execute('supplement_proof', request, 'dispatcher');
    const next = String(first.result.token);
    assert.equal(first.result.review, 'pending');
    assert.equal(first.result.actor, 'dispatcher');
    assert.equal(factory.state.tokens[next].data.shotReview, 'pending');
    assert.equal(factory.runtime.queues.get('curation/process')!.filter(id => id === next).length, 1);
    const duplicate = await fixture.control.execute('supplement_proof', request);
    assert.equal(duplicate.result.token, next);
    assert.equal(duplicate.result.alreadyPresent, true);
    await assert.rejects(fixture.control.execute('supplement_proof', {...request, reason: 'A changed request cannot reuse this durable key'}),
      (error: unknown) => (error as {code?: string}).code === 'supplement_idempotency_conflict');
    await close(factory); closed = true;
    factory = new Factory(fixture.project); await factory.boot(); closed = false;
    fs.writeFileSync(valid.path, 'Changed after a committed receipt');
    const replay = await new FactoryControl(factory).execute('supplement_proof', request);
    assert.equal(replay.result.token, next, 'a lost response after commit is reconciled from the durable receipt');
    assert.equal(replay.result.alreadyPresent, true);
    assert.equal(factory.state.tokenOrder.length, count + 1);
    assert.equal(factory.runtime.paused, true);
    assert.equal(factory.runtime.tokens.get(next)!.rounds['curation/proof'], 3);
    assert.deepEqual(factory.state.tokens[next].rounds, factory.runtime.tokens.get(next)!.rounds,
      'restart replays the same rounds into API state and the scheduler');
    await assert.rejects(new FactoryControl(factory).execute('supplement_proof', {...request, shotReview: 'pass'}),
      (error: unknown) => (error as {code?: string}).code === 'invalid_arguments');
  } finally {if (!closed) await close(factory); fs.rmSync(fixture.project, {recursive: true, force: true});}
});

test('supplement_proof checkpoint projection ignores invalid rounds and retains explicit correction undo semantics', () => {
  const state = initialState();
  const at = Date.parse('2026-10-15T00:00:00Z');
  apply(state, {kind: 'token.created', token: 'checkpoint-fixture', line: 'curation', item: 'exact-entry',
    url: 'https://fixture.test/entry', source: 'candidates/pool', seq: 1, at, run: 'fixture'});
  const checkpoint = {version: 1, entry: 'curation/plan', done: [], notes: [], rounds: {'curation/proof': 3}};
  const input = (value: unknown) => apply(state, {kind: 'token.data', token: 'checkpoint-fixture',
    patch: {runtimeCheckpoint: value}, seq: state.seq + 1, at, run: 'fixture'});
  input(checkpoint);
  assert.deepEqual(state.tokens['checkpoint-fixture'].rounds, {'curation/proof': 3});
  for (const rounds of [null, [], {'curation/proof': -1}, {'curation/proof': 1.5},
    {'curation/proof': Number.MAX_SAFE_INTEGER + 1}, {'curation/proof': '0'}, {'': 0},
    JSON.parse('{"__proto__":0}')]) {
    input({...checkpoint, rounds});
    assert.deepEqual(state.tokens['checkpoint-fixture'].rounds, {'curation/proof': 3});
  }
  input({...checkpoint, version: 2, rounds: {'curation/proof': 0}});
  assert.deepEqual(state.tokens['checkpoint-fixture'].rounds, {'curation/proof': 3});
  const restored = {...checkpoint, rounds: {'curation/proof': 2}};
  apply(state, {kind: 'correction.reverted', correction: 'old-correction', token: 'checkpoint-fixture',
    snapshot: {data: {runtimeCheckpoint: restored}, checkpoint: restored, status: 'active', at: []},
    seq: state.seq + 1, at, run: 'fixture'});
  assert.deepEqual(state.tokens['checkpoint-fixture'].rounds, {'curation/proof': 2});
  input(restored);
  assert.deepEqual(state.tokens['checkpoint-fixture'].rounds, {'curation/proof': 2});
});

test('supplement_proof resolves embedded native state and rejects a card substituted for the original image', {timeout: 30000}, async () => {
  for (const includeExportedState of [false, true]) {
    const fixture = await proofSupplementFixture();
    const {factory, token, retained, control} = fixture;
    try {
      const {EvidenceStore} = await import('../server/evidence.ts');
      const card = factory.store.put(await EvidenceStore.webpAsync(fs.readFileSync(retained.saved.file), 720), 'webp');
      const evidence = factory.state.evidence[retained.shot.evidence];
      const {sha256: _sha, ...originalState} = retained.shot.captureState;
      factory.journal.append({kind: 'evidence.added', evidence: {...evidence, src: card.src,
        meta: {...evidence.meta, captureState: originalState}}});
      const fullState = {...originalState, sha256: retained.saved.sha, finalWebPSha256: retained.saved.sha};
      factory.journal.append({kind: 'token.data', token: token.id, patch: {
        shots: {proof: {...retained.shot, captureState: fullState}}, images: [{...retained.image, captureState: fullState}],
      }});
      factory.journal.append({kind: 'token.data', token: token.id, patch: {shots: token.data.shots, images: token.data.images}});
      const nativeManifest = fixture.write('embedded-native-manifest.json', {schemaVersion: 1,
        entryId: token.item, role: 'proof', image: fixture.manifestValue.image, origin: fixture.manifestValue.origin,
        ...(includeExportedState ? {state: fixture.write('exported-original-state.json', originalState)} : {})});
      const inspect = await control.execute('inspect', {token: token.id});
      const request = {...fixture.request, manifestPath: nativeManifest.path, manifestSha256: nativeManifest.sha256,
        expectedCheckpointSha256: inspect.result.proofCheckpointSha256};
      const cardManifest = fixture.write('card-instead-of-native.json', {schemaVersion: 1,
        entryId: token.item, role: 'proof', image: {path: card.file, sha256: card.sha}, origin: fixture.manifestValue.origin});
      await assert.rejects(control.execute('supplement_proof', {...request,
        manifestPath: cardManifest.path, manifestSha256: cardManifest.sha256}),
      (error: unknown) => (error as {code?: string}).code === 'supplement_dimensions_invalid');
      const result = await control.execute('supplement_proof', request);
      const next = factory.runtime.tokens.get(String(result.result.token))!;
      assert.equal(result.result.stateProvenance, 'journal-snapshot');
      assert.equal(result.result.originalImageSha256, retained.saved.sha, 'the 1280 original is bound separately from its 720 card');
      assert.equal((next.data.shots as {proof: {capturedAt: string}}).proof.capturedAt, originalState.capturedAt);
      assert.equal((next.data.shots as {proof: {captureState: {viewport: {width: number}}}}).proof.captureState.viewport.width, 1280);
    } finally {await close(factory); fs.rmSync(fixture.project, {recursive: true, force: true});}
  }
});

test('supplement_proof can bind explicit identity and breadth repairs without forcing an unchanged identity image to change', {timeout: 30000}, async () => {
  const fixture = await proofSupplementFixture();
  const {factory, token, control} = fixture;
  try {
    // Both optional roles may fall back to the exact canonical page, whose
    // native browser URL legitimately adds www. Keep the proof plan separate.
    const canonical = String(token.data.canonical);
    const nativeUrl = canonical.replace('://', '://www.');
    token.data.readerPlan = {proof: (token.data.readerPlan as {proof: unknown}).proof,
      identity: {url: 'https://fixture.test/', reason: 'Old source homepage', locate: 'Old identity anchor'},
      breadth: {url: 'https://fixture.test/experiments', reason: 'Old sibling catalogue',
        locate: 'Old catalogue anchor', alternatives: [{url: 'https://fixture.test/experiments/archive', reason: 'Old alternative'}]}};
    factory.journal.append({kind: 'token.data', token: token.id, patch: {readerPlan: token.data.readerPlan}});
    const capture = (role: 'identity' | 'breadth', record: typeof fixture.identity) => {
      const state = fixture.write(`${role}-state.json`, {...record.shot.captureState,
        sourceUrl: canonical, finalUrl: nativeUrl});
      const observation = fixture.write(`${role}-receipt.json`, {entryId: token.item, role,
        requestedUrl: canonical, finalUrl: nativeUrl, capturedAt: record.shot.capturedAt,
        sha256: record.saved.sha, stateSha256: state.sha256, ok: true, independentlyViewed: false});
      return {schemaVersion: 1, entryId: token.item, role,
        image: {path: record.saved.file, sha256: record.saved.sha}, state, observation, origin: {kind: 'observation'}};
    };
    // Actual retained image bytes plus a real supplied state may repair missing
    // identity provenance; this role was never the rejected proof.
    const manifest = fixture.write('all-role-manifest.json', {...fixture.manifestValue,
      additionalCaptures: [capture('identity', fixture.identity), capture('breadth', fixture.breadth)]});
    const before = structuredClone(token.data);
    const inspected = await control.execute('inspect', {token: token.id});
    const result = await control.execute('supplement_proof', {...fixture.request,
      manifestPath: manifest.path, manifestSha256: manifest.sha256,
      expectedCheckpointSha256: inspected.result.proofCheckpointSha256});
    const next = factory.runtime.tokens.get(String(result.result.token))!;
    assert.deepEqual(next.data.suppliedCaptureRoles, ['proof', 'identity', 'breadth']);
    assert.deepEqual(next.data.facts, before.facts);
    assert.equal((next.data.shots as {identity: {captureState: {sha256: string}}}).identity.captureState.sha256,
      fixture.identity.saved.sha, 'valid identity evidence may retain exactly the same screenshot bytes');
    assert.equal((next.data.shots as {identity: {captureState: {finalUrl: string}}}).identity.captureState.finalUrl,
      nativeUrl, 'normalize only comparison keys; preserve the actual native final URL');
    const nextPlan = next.data.readerPlan as Record<string, Record<string, unknown>>;
    const oldPlan = before.readerPlan as Record<string, Record<string, unknown>>;
    for (const role of ['identity', 'breadth']) {
      assert.equal(nextPlan[role].url, nativeUrl, 'reviewers must see the actual supplied target, including www');
      assert.match(String(nextPlan[role].reason), /补证.*待独立审查/);
      assert.equal(nextPlan[role].locate, oldPlan[role].locate);
      assert.deepEqual(nextPlan[role].alternatives, oldPlan[role].alternatives);
    }
    const archived = JSON.parse(fs.readFileSync(factory.store.resolve(String(result.result.supersededReviewState))!, 'utf8'));
    assert.deepEqual(archived.readerPlan, oldPlan);
    assert.deepEqual(next.data.images, [], 'all explicitly supplied roles are processed and independently reviewed');
    assert.deepEqual(next.rounds, {'curation/proof': 3, 'curation/breadth': 1});
    assert.equal(next.data.shotReview, 'pending');
    assert.equal(factory.runtime.queues.get('curation/process')!.filter(id => id === next.id).length, 1);
  } finally {await close(factory); fs.rmSync(fixture.project, {recursive: true, force: true});}
});

test('supplement_proof rejects stale or unsafe inputs and concurrent requests claim one durable checkpoint', {timeout: 30000}, async () => {
  const fixture = await proofSupplementFixture();
  const {factory, token, control, request} = fixture;
  try {
    const baseline = {count: factory.state.tokenOrder.length, evidence: factory.state.evidenceOrder.length,
      rounds: structuredClone(token.rounds), checkpoint: structuredClone(token.data.runtimeCheckpoint)};
    const reject = (args: Record<string, unknown>, code: string) => assert.rejects(control.execute('supplement_proof', args),
      (error: unknown) => (error as {code?: string}).code === code);
    await reject({...request, token: token.item}, 'supplement_target_changed');
    await reject({...request, runId: 'old-run'}, 'supplement_run_not_quiescent');
    await reject({...request, expectedCheckpointSha256: '0'.repeat(64)}, 'supplement_checkpoint_changed');
    await reject({...request, manifestSha256: '0'.repeat(64)}, 'supplement_integrity');
    const wrongEntry = fixture.write('wrong-entry.json', {...fixture.manifestValue, entryId: 'sibling-entry'});
    await reject({...request, manifestPath: wrongEntry.path, manifestSha256: wrongEntry.sha256}, 'supplement_entry_mismatch');
    for (const finalUrl of ['https://fixture.test/sibling', 'https://www.fixture.test/sibling',
      'https://www.fixture.test/entry/demo?different=1', 'https://www.fixture.test/entry/demo#/sibling']) {
      const redirectedState = fixture.write('redirected-state.json', {...fixture.retained.shot.captureState, finalUrl});
      const redirectedObservation = fixture.write('redirected-receipt.json', {entryId: token.item, role: 'proof', ok: true,
        requestedUrl: fixture.retained.shot.href, finalUrl, capturedAt: fixture.retained.shot.capturedAt,
        sha256: fixture.retained.saved.sha, stateSha256: redirectedState.sha256});
      const redirectedManifest = fixture.write('redirected-manifest.json', {...fixture.manifestValue,
        state: redirectedState, observation: redirectedObservation, origin: {kind: 'observation'}});
      await reject({...request, manifestPath: redirectedManifest.path, manifestSha256: redirectedManifest.sha256}, 'supplement_source_unplanned');
    }
    const outside = path.join(dir, `outside-${crypto.randomUUID()}.json`);
    const bytes = fs.readFileSync(request.manifestPath);
    fs.writeFileSync(outside, bytes);
    try {await reject({...request, manifestPath: outside}, 'supplement_path_outside_root');} finally {fs.unlinkSync(outside);}
    factory.runtime.resume();
    await reject(request, 'supplement_run_not_quiescent');
    factory.runtime.pause();
    const worker = [...factory.runtime.workers.values()].flat()[0];
    worker.busy = 'fixture-inflight';
    try {await reject(request, 'supplement_run_not_quiescent');} finally {worker.busy = null;}
    assert.deepEqual({count: factory.state.tokenOrder.length, evidence: factory.state.evidenceOrder.length,
      rounds: token.rounds, checkpoint: token.data.runtimeCheckpoint}, baseline);
    const [first, second] = await Promise.all([control.execute('supplement_proof', request), control.execute('supplement_proof', request)]);
    assert.equal(first.result.token, second.result.token);
    assert.equal(factory.state.tokenOrder.length, baseline.count + 1);
    assert.equal(factory.runtime.queues.get('curation/process')!.length, 1);
    await reject({...request, idempotencyKey: 'another-key'}, 'supplement_target_changed');
  } finally {await close(factory); fs.rmSync(fixture.project, {recursive: true, force: true});}
});

test('supplement_proof requires an explicit exact known-role decision to reassign a page and keeps every review pending', {timeout: 30000}, async () => {
  const fixture = await proofSupplementFixture();
  const {factory, control, token, request} = fixture;
  try {
    const knownUrl = fixture.retained.shot.href;
    const actualUrl = knownUrl.replace('://', '://www.');
    const original = {count: factory.state.tokenOrder.length, rounds: structuredClone(token.rounds)};
    const manifest = (targetDecision: unknown, finalUrl = actualUrl) => {
      const state = fixture.write('reassigned-breadth-state.json', {...fixture.breadth.shot.captureState,
        sourceUrl: knownUrl, finalUrl});
      const observation = fixture.write('reassigned-breadth-receipt.json', {entryId: token.item, role: 'breadth',
        requestedUrl: knownUrl, finalUrl, capturedAt: fixture.breadth.shot.capturedAt,
        sha256: fixture.breadth.saved.sha, stateSha256: state.sha256, ok: true, independentlyViewed: false});
      return fixture.write('role-decision-manifest.json', {...fixture.manifestValue, additionalCaptures: [{
        schemaVersion: 1, entryId: token.item, role: 'breadth', image: {path: fixture.breadth.saved.file, sha256: fixture.breadth.saved.sha},
        state, observation, origin: {kind: 'observation'}, ...(targetDecision === undefined ? {} : {targetDecision}),
      }]});
    };
    const submit = (targetDecision: unknown, finalUrl?: string) => {
      const file = manifest(targetDecision, finalUrl);
      return control.execute('supplement_proof', {...request, manifestPath: file.path, manifestSha256: file.sha256});
    };
    await assert.rejects(submit(undefined), (error: unknown) =>
      (error as {code?: string}).code === 'supplement_source_unplanned', 'another role plan is never an implicit target allowance');
    const decision = {fromRole: 'proof', url: knownUrl, reason: 'Use the already known exact Entry page for breadth; review remains pending'};
    for (const invalid of [{...decision, fromRole: 'breadth'}, {...decision, fromRole: 'catalog'},
      {...decision, reason: ''}, {...decision, reason: '   '}]) {
      await assert.rejects(submit(invalid), (error: unknown) =>
        (error as {code?: string}).code === 'supplement_target_decision_invalid');
    }
    for (const url of ['https://www.fixture.test/sibling', `${knownUrl}?different=1`, `${knownUrl}#/sibling`]) {
      await assert.rejects(submit({...decision, url}, url), (error: unknown) =>
        (error as {code?: string}).code === 'supplement_source_unplanned');
      await assert.rejects(submit(decision, url), (error: unknown) =>
        (error as {code?: string}).code === 'supplement_source_unplanned');
    }
    assert.deepEqual({count: factory.state.tokenOrder.length, rounds: token.rounds}, original);
    const result = await submit(decision);
    const next = factory.runtime.tokens.get(String(result.result.token))!;
    const captures = result.result.captures as {role: string; targetDecision?: unknown}[];
    assert.deepEqual(captures.find(capture => capture.role === 'breadth')!.targetDecision, decision);
    assert.deepEqual(result.result.targetDecisions, [{role: 'breadth', ...decision}]);
    const plan = next.data.readerPlan as {breadth: {url: string; reason: string; targetDecision: unknown}};
    assert.equal(plan.breadth.url, actualUrl);
    assert.deepEqual(plan.breadth.targetDecision, decision);
    assert.match(plan.breadth.reason, /待独立审查/);
    assert.equal(next.data.shotReview, 'pending');
    assert.equal(result.result.review, 'pending');
    assert.deepEqual(next.rounds, original.rounds);
  } finally {await close(factory); fs.rmSync(fixture.project, {recursive: true, force: true});}
});

test('supplement_proof commit failure leaves original manual history intact and can be reconciled after restart', {timeout: 30000}, async () => {
  const fixture = await proofSupplementFixture();
  let {factory} = fixture;
  let closed = false;
  try {
    const baseline = [...factory.journal.read()];
    const atomic = factory.journal.atomic.bind(factory.journal);
    let transactionBaseline = baseline;
    let transactions = 0;
    let transactionDepth = 0;
    factory.journal.atomic = action => {
      // Image validation can take longer than the resource-sample interval.
      // Bind rollback to the exact disk state at transaction entry, while
      // rejecting every non-observational write during preparation as well.
      if (transactionDepth === 0) {
        transactionBaseline = [...factory.journal.read()]; transactions++;
        assert.deepEqual(transactionBaseline.slice(0, baseline.length), baseline);
        assert.ok(transactionBaseline.slice(baseline.length).every(event => event.kind === 'resource.sample'));
      }
      transactionDepth++;
      try {return atomic(action);} finally {transactionDepth--;}
    };
    const append = factory.journal.append.bind(factory.journal);
    let injected = false;
    factory.journal.append = event => {
      if (!injected && event.kind === 'token.data' && event.patch.proofSupplementReceipt) {
        injected = true;
        throw new Error('fixture supplement commit failed');
      }
      return append(event);
    };
    await assert.rejects(fixture.control.execute('supplement_proof', fixture.request), /fixture supplement commit failed/);
    assert.equal(injected, true);
    assert.equal(transactions, 1);
    assert.deepEqual([...factory.journal.read()], transactionBaseline, 'no partial receipt, claimed successor or checkpoint is durable');
    assert.equal(factory.state.tokens[fixture.token.id].status, 'manual');
    assert.equal(factory.state.tokens[fixture.token.id].data.retriedBy, undefined);
    assert.throws(() => factory.runtime.resume(), (error: unknown) => (error as {code?: string}).code === 'journal_commit_failed');
    factory.journal.append = append;
    factory.journal.atomic = atomic;
    await close(factory); closed = true;
    factory = new Factory(fixture.project); await factory.boot(); closed = false;
    const control = new FactoryControl(factory);
    const inspect = await control.execute('inspect', {token: fixture.token.id});
    const result = await control.execute('supplement_proof', {...fixture.request, expectedCheckpointSha256: inspect.result.proofCheckpointSha256});
    assert.equal(result.result.alreadyPresent, false);
    assert.equal(factory.state.tokenOrder.length, 2);
    assert.deepEqual(factory.runtime.tokens.get(String(result.result.token))!.rounds, {'curation/proof': 3, 'curation/breadth': 1});
    assert.equal(factory.runtime.paused, true);
  } finally {if (!closed) await close(factory); fs.rmSync(fixture.project, {recursive: true, force: true});}
});

test('legacy system-created manual stops with a missing sibling become resumable without overriding real human review', async () => {
  let factory=new Factory();
  try {
    await factory.boot();factory.broker.memoryFloorMB=0;factory.runtime.start('legacy frontier');
    factory.runtime.executors=()=>async()=>({ok:true,summary:'fixture'});
    const token=factory.runtime.create('curation/shot-review',{item:'legacy-frontier',url:'https://site.example/',source:'candidates/pool',data:{canonical:'https://site.example/',recoveryRoot:'curation/plan',recoveryStation:'curation/shot-review'}});
    token.entry='curation/plan';token.closure=factory.runtime.closureOf(token.entry);
    token.done=new Set(['curation/plan','curation/identity','curation/breadth','curation/proof','curation/process','curation/facts']);
    factory.journal.append({kind:'token.data',token:token.id,patch:{checkpointDone:[...token.done]}});
    factory.runtime.restoreFlow(token);
    factory.runtime.resumeFrontier=()=>{}; // Reproduce the previous scheduler.
    await factory.runtime.settle();
    assert.equal(factory.state.tokens[token.id].status,'manual');factory.runtime.pause();
    await close(factory);factory=new Factory();await factory.boot();
    assert.equal(factory.state.tokens[token.id].status,'parked');
    assert.equal(factory.state.recoveries[token.item].failure?.code,'RESTORED_FRONTIER_MISSING');
    assert.equal(factory.state.tokens[token.id].finishedAtNode,'curation/fact-review');
    factory.runtime.executors=node=>async()=>({ok:true,summary:'fixture',data:node.key==='curation/gate'?{gate:'pass'}:undefined});
    factory.runtime.resume();const [retry]=factory.retryCandidates({items:[token.item],count:1});await factory.runtime.settle();
    assert.equal(factory.state.tokens[retry.id].status,'published');
  } finally {await close(factory);fs.rmSync(dir,{recursive:true,force:true});}
});

test('managed model recovery requires a matching real response and preserves business or authentication failures', async t => {
  const factory = new Factory();
  const reported = {usageReported: true, execution: {adapter: 'fixture', model: 'fixture-model'},
    time: {firstTokenMs: 1, outputMs: 1, toolMs: 0, programMs: 0, modelCalls: 1, toolCalls: 0}};
  try {
    await factory.boot();
    factory.runtime.start('Managed receipt verification fixture');
    factory.runtime.pause();
    for (const scenario of [
      {name: 'program-only success', ok: true, metrics: undefined, recovered: false},
      {name: 'usage without a model call', ok: true, metrics: {...reported, time: {...reported.time, modelCalls: 0}}, recovered: false},
      {name: 'verified model success', ok: true, metrics: reported, recovered: true},
      {name: 'verified response with a business rejection', ok: false, metrics: reported, recovered: true,
        failure: {tag: 'quality_rejected' as const, category: 'system' as const, message: 'Fixture business gate failed', retryable: true}},
      {name: 'authentication failure after an earlier paid response', ok: false, metrics: reported, recovered: false,
        failure: {tag: 'model_unavailable' as const, category: 'auth' as const, message: 'Fixture credentials rejected', retryable: true, owner: 'user' as const}},
      {name: 'cancelled reported response', ok: true, metrics: reported, recovered: false, cancelled: true},
    ]) {
      await t.test(scenario.name, () => {
        for (const id of Object.keys(factory.state.alerts)) factory.clearAlert(id, 'Reset isolated fixture');
        const token = factory.runtime.create('curation/reader', {item: scenario.name, url: 'https://fixture.invalid/', source: 'fixture'});
        const attempt = `attempt-${token.id}`;
        factory.raiseAlert({id: 'model-transport', level: 'red', kind: 'model', message: 'Fixture transport hold'});
        factory.journal.append({kind: 'batch.configured', batch: {runId: factory.state.run.id, target: 20,
          maxInFlight: 1, intakeWindow: 1, maxRecoveries: 2, mode: 'paused', startedAt: Date.now(),
          modelCircuit: {state: 'trial', failures: 1, nextAt: 0, trialToken: token.id, station: 'curation/reader'}}});
        factory.broker.modelHold = null;
        factory.broker.recoveryToken = token.id;
        factory.journal.append({kind: 'attempt.started', attempt, token: token.id, node: 'curation/reader', worker: 'fixture-worker', input: 'fixture'});
        factory.journal.atomic(() => {
          if (scenario.failure) factory.journal.append({kind: 'token.data', token: token.id, patch: {failure: scenario.failure}});
          if (scenario.failure?.tag === 'model_unavailable') factory.raiseAlert({id: 'model', level: 'red', kind: 'model', message: scenario.failure.message});
          factory.journal.append({kind: 'attempt.finished', attempt, ok: scenario.ok, summary: scenario.name,
            ms: 1, queuedMs: 0, metrics: scenario.metrics, cancelled: scenario.cancelled});
          factory.journal.append({kind: 'token.finished', token: token.id, node: 'curation/reader',
            status: scenario.ok ? 'published' : 'manual', reason: scenario.name});
        });
        assert.equal(factory.state.batch?.modelCircuit === undefined, scenario.recovered);
        assert.equal(factory.state.alerts['model-transport'] === undefined, scenario.recovered);
        if (scenario.failure) {
          assert.equal(factory.state.tokens[token.id].status, 'manual', 'model health does not override the business result');
          assert.deepEqual(factory.state.tokens[token.id].data.failure, scenario.failure);
        }
        if (!scenario.recovered) assert.ok(factory.broker.modelHold);
      });
    }
  } finally {
    await close(factory);
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('retrying a failed screenshot review also restores the cancelled facts-review sibling', async () => {
  const factory=new Factory();let siblingStarted=false;
  try {
    await factory.boot();factory.broker.memoryFloorMB=0;
    factory.runtime.start('interrupted parallel reviews');
    factory.runtime.executors=node=>async ctx=>{
      if(node.key==='curation/fact-review') {siblingStarted=true; await new Promise((resolve,reject)=>ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true}));}
      if(node.key==='curation/shot-review') {for(let i=0;i<100&&!siblingStarted;i++)await new Promise(r=>setTimeout(r,5));return {ok:false,summary:'fixture interruption',failure:{tag:'tool_error',category:'system',message:'interrupted review',retryable:true}};}
      return {ok:true,summary:'fixture complete'};
    };
    const old=factory.runtime.create('curation/plan',{item:'parallel-item',url:'https://site.example/',source:'candidates/pool',data:{canonical:'https://site.example/'}});
    await factory.runtime.settle();assert.equal(siblingStarted,true);
    assert.equal(factory.state.tokens[old.id].status,'parked');
    const nodes:string[]=[];
    factory.runtime.executors=node=>async()=>{nodes.push(node.key);return {ok:true,summary:'fixture recovered',data:node.key==='curation/gate'?{gate:'pass'}:undefined};};
    const [retry]=factory.retryCandidates({items:[old.item],count:1});await factory.runtime.settle();
    assert.equal(factory.state.tokens[retry.id].status,'published');
    assert.ok(nodes.includes('curation/fact-review'),'cancelled sibling must rejoin the live frontier');
    assert.ok(!nodes.includes('curation/facts'),'completed facts are not recomputed');
    assert.equal(nodes.filter(n=>n==='curation/shot-review').length,1);
  } finally {await close(factory);fs.rmSync(dir,{recursive:true,force:true});}
});

test('waiting for browser capacity stays queued and never consumes a website recovery', async () => {
  const factory=new Factory();let calls=0;
  try {
    await factory.boot();factory.catalog=catalog(1);
    factory.runtime.executors=()=>async()=> ++calls===1
      ? {ok:false,summary:'capacity wait',failure:{tag:'tool_error',category:'system',code:'BROWSER_CAPACITY_TIMEOUT',message:'pool full',retryable:true,owner:'system'}}
      : {ok:true,summary:'fixture',finish:{status:'published',reason:'fixture'}};
    const [token]=factory.pull(1);await factory.runtime.settle();
    assert.equal(factory.state.tokens[token.id].status,'active');
    assert.equal(factory.state.recoveries[token.item],undefined);
    await new Promise(r=>setTimeout(r,5100));await factory.runtime.settle();
    assert.equal(factory.state.tokens[token.id].status,'published');
    assert.equal(factory.runtime.tokens.size,1);assert.equal(calls,2);
    assert.equal(Object.values(factory.state.attempts).filter(a=>!a.ok&&!a.cancelled).length,0);
  } finally {await close(factory);fs.rmSync(dir,{recursive:true,force:true});}
});

test('provider circuit and checkpoints survive restart without treating a paused run as authorization to retry', async () => {
  let factory=new Factory();
  try {
    await factory.boot();factory.catalog=catalog(1);
    factory.runtime.executors=()=>async()=>({ok:false,summary:'模型调用失败',failure:{tag:'model_transport',category:'system',message:'Connection error.',retryable:true,owner:'system'}});
    factory.batch.configure({target:1});await factory.runtime.settle();factory.runtime.pause();
    await close(factory);factory=new Factory();await factory.boot();
    const count=factory.runtime.tokens.size;
    assert.equal(factory.state.batch?.modelCircuit?.state,'open');assert.ok(factory.broker.modelHold);
    factory.batch.pump(Date.now()+3600000);await factory.runtime.settle();
    assert.equal(factory.runtime.tokens.size,count);assert.equal(factory.runtime.paused,true);
  } finally {await close(factory);fs.rmSync(dir,{recursive:true,force:true});}
});

test('a shared provider outage stops intake and recovers one real checkpoint before reopening the batch', async () => {
  const factory=new Factory(); let broken=true;
  try {
    await factory.boot(); factory.catalog=catalog(10);
    factory.runtime.executors=()=>async()=>broken
      ? {ok:false,summary:'模型调用失败',failure:{tag:'model_transport',category:'system',message:'Connection error.',retryable:true,owner:'system'}}
      : {ok:true,summary:'real checkpoint fixture',finish:{status:'published',reason:'fixture'},
        metrics: {usageReported: true, execution: {adapter: 'fixture', model: 'local-model-response'},
          time: {firstTokenMs: 1, outputMs: 1, toolMs: 0, programMs: 0, modelCalls: 1, toolCalls: 0}}};
    factory.batch.configure({target:6,maxInFlight:4,intakeWindow:2});
    await factory.runtime.settle();
    assert.ok(batchSummary(factory.state)!.admitted<=2,'an outage must not feed the remaining catalog');
    assert.equal(factory.state.batch!.modelCircuit?.state,'open');
    assert.ok(factory.broker.modelHold);
    assert.ok(Object.values(factory.state.tokens).every(t=>!t.data.batchRecovery),'provider downtime is not a website retry');
    broken=false;
    factory.batch.pump(Date.now()+60000); await factory.runtime.settle();
    assert.equal(factory.state.batch!.modelCircuit,undefined);
    assert.equal(factory.broker.modelHold,null); assert.equal(factory.broker.recoveryToken,null);
    assert.equal(batchSummary(factory.state)!.published,6);
  } finally {await close(factory);fs.rmSync(dir,{recursive:true,force:true});}
});

test('persistent provider failures enter a slow single-site probe schedule without exhausting site repair budgets', async () => {
  const factory=new Factory();
  try {
    await factory.boot(); factory.catalog=catalog(10);
    factory.runtime.executors=()=>async()=>({ok:false,summary:'模型调用失败',failure:{tag:'model_transport',category:'system',message:'Request timed out.',retryable:true,owner:'system'}});
    factory.batch.configure({target:10,maxInFlight:4,intakeWindow:1}); await factory.runtime.settle();
    for(let i=0;i<3;i++){factory.batch.pump(factory.state.batch!.modelCircuit!.nextAt);await factory.runtime.settle();}
    assert.equal(batchSummary(factory.state)!.admitted,1);
    assert.equal(factory.runtime.tokens.size,4);
    assert.ok(factory.state.batch!.modelCircuit!.nextAt >= Date.now() + 14 * 60 * 1000);
    factory.batch.pump(factory.state.batch!.modelCircuit!.nextAt - 1); await factory.runtime.settle();
    assert.equal(factory.runtime.tokens.size,4,'the fifteen-minute cooldown cannot create more trials early');
    assert.ok(Object.values(factory.state.tokens).every(t=>!t.data.batchRecovery));
    assert.ok(factory.broker.modelHold);
  } finally {await close(factory);fs.rmSync(dir,{recursive:true,force:true});}
});

test('a durable 100-site goal replenishes a bounded pipeline without a chat polling loop', async () => {
  const factory = new Factory();
  try {
    await factory.boot();
    factory.catalog = Array.from({ length: 120 }, (_, i) => ({ id: `site-${i}`, name: `Site ${i}`, canonicalUrl: `https://site-${i}.example/` }));
    let peak = 0;
    factory.runtime.executors = () => async () => {
      peak = Math.max(peak, [...factory.runtime.tokens.values()].filter(t => !t.finished).length);
      return { ok: true, summary: 'fixture publication', finish: { status: 'published', reason: 'fixture' } };
    };
    const control = new FactoryControl(factory);
    await control.execute('run_batch', { action: 'start', target: 100, maxInFlight: 6, intakeWindow: 3 }, 'user');
    await factory.runtime.settle();
    const result = (await control.execute('run_batch', { action: 'status' }, 'user')).result;
    assert.equal(result.target, 100);
    assert.equal(result.admitted, 100, 'a title saying 100 must not stop after the first 20');
    assert.equal(result.completed, 100);
    assert.equal(result.status, 'completed');
    assert.ok(peak <= 6, `in-flight peak ${peak} exceeds window`);
    assert.equal(new Set([...factory.runtime.tokens.values()].map(t => t.item)).size, 100);
  } finally {
    await factory.runtime.close(); factory.docs.flush(); factory.lessons.close(); factory.journal.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('flow admission can replace a manual single-item policy while paused and refill before the planning gate', async () => {
  const factory = new Factory();
  let release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  let hold = true;
  try {
    await factory.boot();
    factory.catalog = catalog(8);
    let peak = 0;
    factory.runtime.executors = node => async () => {
      peak = Math.max(peak, [...factory.runtime.tokens.values()].filter(token => !token.finished).length);
      if (node.key === 'curation/scout') {
        if (hold) await held;
        return {ok: true, summary: 'Local admission fixture completed', finish: {status: 'published', reason: 'fixture'}};
      }
      return {ok: true, summary: 'Local entry completed'};
    };
    factory.batch.configure({target: 8, maxInFlight: 1, intakeWindow: 1});
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(factory.runtime.tokens.size, 1);
    const first = [...factory.runtime.tokens.values()][0];
    assert.ok(first.done.has('candidates/route'));
    assert.equal(first.done.has('curation/plan'), false);
    factory.runtime.pause();
    const run = factory.state.run.id;
    const before = factory.journal.seq;
    assert.throws(() => factory.batch.updateAdmission({}), /请指定/);
    const manual = factory.batch.updateAdmission({maxInFlight: 1, intakeWindow: 1});
    assert.equal(manual?.admission, undefined);
    const flow = factory.batch.updateAdmission({flow: true, maxInFlight: 4, intakeWindow: 2});
    assert.deepEqual(flow?.admission, {mode: 'flow', maxInFlightLimit: 4, intakeWindowLimit: 2});
    assert.equal(flow?.status, 'paused');
    assert.equal(factory.runtime.paused, true);
    assert.equal(factory.state.batch?.mode, 'running', 'the existing goal mode is preserved');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(factory.runtime.tokens.size, 1, 'changing paused admission cannot start work');
    assert.ok([...factory.journal.read(before)].every(event => event.kind !== 'run.resumed' && event.kind !== 'run.started'));
    assert.equal(factory.state.run.id, run);
    const replayed = initialState(factory.compiled);
    for (const event of factory.journal.read()) apply(replayed, event);
    assert.deepEqual(replayed.batch?.admission, flow?.admission, 'the flow ceilings survive journal replay');
    assert.equal(replayed.run.status, 'paused');
    factory.runtime.resume();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(factory.runtime.tokens.size > 1, 'completed entry work releases intake before curation/plan');
    assert.ok(factory.runtime.tokens.size <= 4);
    assert.equal(Object.values(factory.state.tokens).filter(token => token.status === 'published').length, 0);
    assert.ok([...factory.runtime.tokens.values()].every(token => !token.done.has('curation/plan')));
    hold = false;
    release();
    await factory.runtime.settle();
    assert.equal(batchSummary(factory.state)?.published, 8);
    assert.ok(peak <= 4, 'user flow ceiling remains a hard limit');
    assert.throws(() => factory.batch.updateAdmission({maxInFlight: 0}), /整数/);
    factory.batch.updateAdmission({maxInFlight: 1, intakeWindow: 1});
    assert.equal(factory.state.batch?.admission, undefined, 'an explicit fixed choice remains available');
    assert.equal(factory.state.batch?.maxInFlight, 1);
  } finally {
    hold = false;
    release();
    await close(factory);
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('pause and process restart retain the total goal, original run and exact remaining admission', async () => {
  let factory = new Factory();
  try {
    await factory.boot(); factory.catalog = catalog(20);
    factory.batch.configure({ target: 9, maxInFlight: 4, intakeWindow: 2 });
    factory.runtime.pause();
    const runId = factory.state.run.id;
    assert.equal(batchSummary(factory.state)?.admitted, 2);
    await close(factory);
    factory = new Factory(); await factory.boot(); factory.catalog = catalog(20);
    assert.equal(factory.state.run.id, runId);
    assert.equal(factory.state.batch?.target, 9);
    assert.equal(batchSummary(factory.state)?.status, 'paused');
    assert.equal(batchSummary(factory.state)?.admitted, 2);
    factory.runtime.executors = () => async () => ({ ok: true, summary: 'fixture', finish: { status: 'published', reason: 'fixture' } });
    factory.batch.setMode('running');
    await factory.runtime.settle();
    assert.equal(batchSummary(factory.state)?.admitted, 9);
    assert.equal(batchSummary(factory.state)?.completed, 9);
    assert.equal(factory.state.run.id, runId);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('transient failures resume automatically, reuse checkpoints and never count retries as more sites', async () => {
  const factory = new Factory();
  try {
    await factory.boot(); factory.catalog = catalog(10);
    factory.runtime.executors = () => async ctx => ctx.token.data.retryOf
      ? { ok: true, summary: 'fixture', finish: { status: 'published', reason: 'fixture' } }
      : { ok: false, summary: 'fixture connection timeout', failure: { tag: 'network_timeout', category: 'network', message: 'timeout', retryable: true, owner: 'system' } };
    factory.batch.configure({ target: 4, maxInFlight: 4, intakeWindow: 2 });
    await factory.runtime.settle();
    assert.equal(batchSummary(factory.state)?.retrying, 4);
    assert.equal(batchSummary(factory.state)?.completed, 0);
    factory.batch.pump(Date.now() + 60000);
    await factory.runtime.settle();
    assert.equal(batchSummary(factory.state)?.admitted, 4);
    assert.equal(batchSummary(factory.state)?.completed, 4);
    assert.equal(factory.runtime.tokens.size, 8);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('persistent failures exhaust a durable retry budget without becoming success or asking for login', async () => {
  const factory = new Factory();
  try {
    await factory.boot(); factory.catalog = catalog(2);
    factory.runtime.executors = () => async () => ({ ok: false, summary: 'timeout', failure: { tag: 'network_timeout', category: 'network', message: 'timeout', retryable: true, owner: 'system' } });
    factory.batch.configure({ target: 2, maxInFlight: 2, intakeWindow: 2 });
    await factory.runtime.settle();
    for (let pass = 0; pass < 4; pass++) { factory.batch.pump(Date.now() + 120000); await factory.runtime.settle(); }
    assert.equal(factory.runtime.tokens.size, 6, 'initial plus exactly two recovery attempts per site');
    assert.equal(batchSummary(factory.state)?.status, 'blocked');
    assert.equal(batchSummary(factory.state)?.completed, 0);
    assert.equal(batchSummary(factory.state)?.blocked, 2);
    assert.deepEqual(Object.values(factory.state.alerts), []);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed page selection goes to the reader with prior failures, not directly to the user', async () => {
  const factory = new Factory();
  try {
    await factory.boot(); factory.catalog = catalog(1);
    const stations: string[] = [];
    factory.runtime.executors = node => async ctx => {
      stations.push(node.key);
      if (ctx.token.data.retryOf) {
        assert.ok(ctx.token.data.repairContext);
        return { ok: true, summary: 'fixture repair', finish: { status: 'published', reason: 'fixture' } };
      }
      return { ok: false, summary: 'no public page selected', failure: { tag: 'needs_selection', category: 'system', message: 'candidate list was insufficient', retryable: true, owner: 'agent' } };
    };
    factory.batch.configure({ target: 1 }); await factory.runtime.settle();
    factory.batch.pump(Date.now() + 60000); await factory.runtime.settle();
    assert.deepEqual(stations, ['candidates/route', 'curation/reader']);
    assert.equal(batchSummary(factory.state)?.completed, 1);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy network login alerts are removed without dropping the failure or incrementing attempts', async () => {
  let factory = new Factory();
  try {
    await factory.boot(); factory.catalog = catalog(1);
    factory.runtime.executors = () => async () => ({ ok: false, summary: 'ECONNRESET', failure: { tag: 'network_connection', category: 'network', message: 'ECONNRESET', retryable: true, owner: 'user' } });
    const [token] = factory.pull(1); await factory.runtime.settle();
    assert.deepEqual(Object.values(factory.state.alerts), [], 'a network failure must not get a login alert even if its old owner is user');
    factory.journal.append({ kind: 'alert.raised', alert: { id: `auth:${token.item}`, kind: 'auth', level: 'red', item: token.item, token: token.id, message: 'legacy wrong login', url: token.url } });
    await close(factory);
    factory = new Factory(); await factory.boot();
    assert.deepEqual(Object.values(factory.state.alerts), []);
    assert.equal(factory.state.recoveries[token.item].failure?.tag, 'network_connection');
    assert.equal(factory.state.recoveries[token.item].failure?.owner, 'system');
    assert.equal(factory.state.recoveries[token.item].attempts, 1);
    assert.ok([...factory.journal.read()].some(event => event.kind === 'alert.cleared'));
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('desktop restart resumes an explicitly managed running goal, while a ended run cannot be resumed', async () => {
  let factory = new Factory();
  const saved = { FACTORY_START_PAUSED: process.env.FACTORY_START_PAUSED, FACTORY_RESUME_MANAGED: process.env.FACTORY_RESUME_MANAGED };
  try {
    await factory.boot();
    factory.batch.configure({ target: 4, maxInFlight: 3, intakeWindow: 2 });
    const run = factory.state.run.id;
    await close(factory);
    process.env.FACTORY_START_PAUSED = '1'; process.env.FACTORY_RESUME_MANAGED = '1';
    factory = new Factory(); await factory.boot();
    assert.equal(factory.runtime.paused, false);
    assert.equal(factory.state.run.id, run);
    factory.catalog = catalog(4);
    factory.runtime.executors = () => async () => ({ ok: true, summary: 'fixture', finish: { status: 'published', reason: 'fixture' } });
    factory.batch.pump(); await factory.runtime.settle();
    assert.equal(batchSummary(factory.state)?.completed, 4);
    factory.runtime.end();
    assert.throws(() => factory.batch.setMode('running'), /本轮已经结束/);
  } finally {
    await close(factory); fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('late review recovery gets the available slot before another early reading attempt', async () => {
  const factory = new Factory();
  try {
    await factory.boot(); factory.runtime.start('prioritize completed evidence');
    factory.runtime.executors = () => async () => ({ ok: false, summary: 'timeout', failure: { tag: 'network_timeout', category: 'network', message: 'timeout', retryable: true, owner: 'system' } });
    for (const [item, node] of [['early', 'curation/reader'], ['late', 'curation/copy-review']]) factory.runtime.create(node, { item, url: `https://${item}.example/`, source: 'manual', data: { canonical: `https://${item}.example/` } });
    await factory.runtime.settle();
    const resumed: string[] = [];
    factory.runtime.executors = node => async () => { resumed.push(node.key); return { ok: true, summary: 'fixture', finish: { status: 'published', reason: 'fixture' } }; };
    factory.batch.configure({ target: 2, maxInFlight: 1, intakeWindow: 1 });
    factory.batch.pump(Date.now() + 60000); await factory.runtime.settle();
    assert.deepEqual(resumed, ['curation/copy-review']);
    assert.equal(batchSummary(factory.state)?.admitted, 2);
    assert.equal(batchSummary(factory.state)?.completed, 1);
  } finally { await close(factory); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('single-slot managed admission alternates durable sources and catalog across restart', async () => {
  let factory = new Factory();
  const order: string[] = [];
  let peak = 0;
  const execute = () => {
    factory.runtime.executors = () => async ctx => {
      order.push(ctx.token.source.startsWith('source:') ? 'source' : 'catalog');
      peak = Math.max(peak, [...factory.runtime.tokens.values()].filter(token => !token.finished).length);
      return {ok: true, summary: 'Fixture publication', finish: {status: 'published', reason: 'fixture'}};
    };
  };
  try {
    await factory.boot();
    await factory.sources.close();
    factory.sources = new SourceSupervisor(factory);
    factory.sources.configure({
      id: 'fresh', name: 'Fresh source', url: 'https://feed.fixture.test/items',
      platform: 'fixture', format: 'json', target: 'candidates/tidy',
      intervalMs: 86400000, enabled: true,
    });
    factory.journal.append({kind: 'source.polled', source: 'fresh', nextAt: Date.now() + 86400000, count: 0, duplicates: 0});
    for (let i = 0; i < 4; i++) {
      factory.journal.append({kind: 'source.candidate', candidate: {
        id: `fresh-${i}`, source: 'fresh', platform: 'fixture', sourceUrl: 'https://feed.fixture.test/items',
        url: `https://fresh-${i}.fixture.test/`, title: `Fresh ${i}`, discoveredAt: Date.now(), status: 'pending',
      }});
    }
    factory.catalog = catalog(12);
    execute();
    const unsubscribe = factory.journal.subscribe(event => {
      if (event.kind === 'token.finished' && order.length === 1) factory.runtime.pause();
    });
    factory.batch.configure({target: 6, maxInFlight: 1, intakeWindow: 1});
    await factory.runtime.settle();
    assert.deepEqual(order, ['source'], 'an already queued source must get a real admission');
    unsubscribe();
    await close(factory);
    factory = new Factory();
    await factory.boot();
    factory.catalog = catalog(12);
    execute();
    assert.equal(factory.runtime.paused, true);
    factory.runtime.resume();
    await factory.runtime.settle();
    assert.deepEqual(order, ['source', 'catalog', 'source', 'catalog', 'source', 'catalog']);
    assert.equal(peak, 1);
    assert.equal(batchSummary(factory.state)?.admitted, 6);
    assert.equal(batchSummary(factory.state)?.completed, 6);
    assert.equal(factory.sources.list()[0].counts.pending, 1, 'the target remains a hard bound');
  } finally {
    await close(factory);
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('single-slot recovery alternates with source and catalog admissions across restart', async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  for (const declared of [false, true]) await t.test(declared ? 'declared website policy' : 'default batch policy', async () => {
    let factory = new Factory();
    const order: string[] = [];
    let peak = 0;
    const setup = () => {
      factory.runtime.nodes.get('curation/reader')!.recovery = declared ? {
        tags: ['network_timeout'], maxRetries: 1,
        backoff: {initialMs: 1000, factor: 1, maxMs: 1000}, exhausted: 'parked',
      } : undefined;
      factory.runtime.executors = () => async context => {
        const retry = typeof context.token.data.retryOf === 'string';
        if (context.token.item.startsWith('waiting-') && !retry) {
          return {ok: false, summary: 'Controlled recoverable fixture failure', failure: {
            tag: 'network_timeout', category: 'network', owner: 'system', retryable: true, message: 'ETIMEDOUT fixture',
          }};
        }
        order.push(retry ? 'recovery' : context.token.source.startsWith('source:') ? 'source' : 'catalog');
        peak = Math.max(peak, [...factory.runtime.tokens.values()].filter(token => !token.finished).length);
        return {ok: true, summary: 'One logical fixture publication', finish: {status: 'published', reason: 'fixture'}};
      };
    };
    try {
      await factory.boot();
      factory.catalog = [];
      setup();
      factory.runtime.start('Fair checkpoint and fresh admission');
      for (let index = 0; index < 3; index++) {
        factory.runtime.create('curation/reader', {item: `waiting-${index}`, url: `https://waiting-${index}.fixture.test/`,
          source: 'candidates/pool', data: {canonical: `https://waiting-${index}.fixture.test/`}});
        await factory.runtime.settle();
      }
      await factory.sources.close();
      factory.sources = new SourceSupervisor(factory);
      factory.sources.configure({id: 'fresh-recovery', name: 'Fresh alongside recovery',
        url: 'https://never-polled.fixture.test/items', platform: 'fixture', format: 'json',
        target: 'candidates/tidy', intervalMs: 86400000, enabled: false});
      factory.journal.append({kind: 'source.polled', source: 'fresh-recovery', nextAt: Date.now() + 86400000, count: 0, duplicates: 0});
      for (let index = 0; index < 4; index++) factory.journal.append({kind: 'source.candidate', candidate: {
        id: `fresh-recovery-${index}`, source: 'fresh-recovery', platform: 'fixture',
        sourceUrl: 'https://never-polled.fixture.test/items', url: `https://fresh-recovery-${index}.fixture.test/`,
        title: `Fresh ${index}`, discoveredAt: Date.now() + index, status: 'pending',
      }});
      factory.batch.configure({target: 9, maxInFlight: 1, intakeWindow: 1});
      const unsubscribe = factory.journal.subscribe(event => {
        if (event.kind === 'token.finished' && order.length === 1) factory.runtime.pause();
      });
      factory.catalog = catalog(12);
      factory.sources.setEnabled('fresh-recovery', true);
      t.mock.timers.tick(20000);
      factory.batch.pump();
      factory.recovery.pump();
      await factory.runtime.settle();
      assert.deepEqual(order, ['recovery']);
      unsubscribe();
      await close(factory);
      factory = new Factory();
      await factory.boot();
      factory.catalog = catalog(12);
      setup();
      assert.equal(factory.runtime.paused, true);
      factory.runtime.resume();
      await factory.runtime.settle();
      assert.deepEqual(order, ['recovery', 'source', 'recovery', 'catalog', 'recovery', 'source', 'catalog', 'source', 'catalog']);
      assert.equal(peak, 1, 'declared recovery must obey the website goal, not the larger default source window');
      assert.equal(batchSummary(factory.state)?.admitted, 9);
      assert.equal(batchSummary(factory.state)?.completed, 9);
      assert.equal(factory.sources.list()[0].counts.pending, 1);
    } finally {
      await close(factory);
      assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});

test('managed feeder rotation preserves filters, disabled sources, intake limits and empty-side fallback', async () => {
  for (const scenario of ['category', 'query', 'disabled', 'source-only', 'local-pause'] as const) {
    const factory = new Factory();
    const origins: string[] = [];
    let peak = 0;
    try {
      await factory.boot();
      await factory.sources.close();
      factory.sources = new SourceSupervisor(factory);
      factory.sources.configure({
        id: 'fresh', name: 'Fresh source', url: 'https://feed.fixture.test/items',
        platform: 'fixture', format: 'json', target: 'candidates/tidy',
        intervalMs: 86400000, enabled: scenario !== 'disabled',
      });
      for (let i = 0; i < 3; i++) factory.journal.append({kind: 'source.candidate', candidate: {
        id: `fresh-${i}`, source: 'fresh', platform: 'fixture', sourceUrl: 'https://feed.fixture.test/items',
        url: `https://fresh-${i}.fixture.test/`, title: `Fresh ${i}`, discoveredAt: Date.now(), status: 'pending',
      }});
      factory.catalog = scenario === 'source-only' ? [] : catalog(6).map(entry => ({...entry, category: 'fixture', name: 'Wanted ' + entry.id}));
      factory.runtime.executors = () => async ctx => {
        origins.push(ctx.token.source.startsWith('source:') ? 'source' : 'catalog');
        peak = Math.max(peak, [...factory.runtime.tokens.values()].filter(token => !token.finished).length);
        return {ok: true, summary: 'Fixture publication', finish: {status: 'published', reason: 'fixture'}};
      };
      if (scenario === 'local-pause') factory.runtime.setScopePaused({scope: 'line', key: 'candidates', paused: true, reason: 'Fixture pause'});
      factory.batch.configure({target: 2, maxInFlight: 3, intakeWindow: 1,
        ...(scenario === 'category' ? {category: 'fixture'} : {}),
        ...(scenario === 'query' ? {query: 'Wanted'} : {}),
      });
      await factory.runtime.settle();
      if (scenario === 'local-pause') {
        assert.equal(Object.keys(factory.state.tokens).length, 0, 'both feeders honor the paused entry line');
        factory.runtime.setScopePaused({scope: 'line', key: 'candidates', paused: false, reason: 'Fixture resumes'});
        await new Promise<void>(resolve => setImmediate(resolve));
        await factory.runtime.settle();
      }
      assert.deepEqual(origins, scenario === 'source-only' ? ['source', 'source']
        : scenario === 'local-pause' ? ['source', 'catalog'] : ['catalog', 'catalog'], scenario);
      assert.equal(peak, 1, 'intakeWindow remains binding even when maxInFlight is larger');
      assert.equal(batchSummary(factory.state)?.admitted, 2);
      assert.equal(batchSummary(factory.state)?.completed, 2);
      assert.equal(Boolean(batchSummary(factory.state)?.supplyExhausted), false, 'successful source intake is available supply even if the catalog is empty');
      if (scenario === 'disabled') assert.equal(factory.sources.list()[0].enabled, false);
    } finally {
      await close(factory);
      fs.rmSync(dir, {recursive: true, force: true});
    }
  }
});

test('publication outbox batches only digest-bound local gate publications and keeps immutable bytes', async () => {
  const {Journal} = await import('../server/journal.ts');
  const {PublicationOutbox} = await import('../server/publication-outbox.ts');
  const {createHash} = await import('node:crypto');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-outbox-'));
  const externalDir = path.join(project, 'context', 'external-intake', 'vislexicon-20261014');
  const externalManifest = path.join(externalDir, 'snapshots', 'fixture.json');
  fs.mkdirSync(path.dirname(externalManifest), {recursive: true});
  fs.writeFileSync(externalManifest, JSON.stringify({schemaVersion: 1, storageDir: externalDir,
    inventorySha256: 'f'.repeat(64), files: [],
    candidates: [{entryId: 'already-main', disposition: 'published'}]}));
  fs.writeFileSync(path.join(externalDir, 'current.json'), JSON.stringify({manifestPath: externalManifest}));
  const journal = new Journal(path.join(project, 'journal.db'));
  journal.append({kind: 'run.started', runId: 'outbox-run', title: 'Outbox behavior'});
  const outbox = new PublicationOutbox(project, journal);
  const publish = (id: string, options: {imported?: boolean; altered?: boolean; gate?: string} = {}) => {
    journal.append({kind: 'token.created', token: id, item: id, line: 'curation',
      url: `https://${id}.example/`, source: 'candidates/pool'});
    const base = {schemaVersion: 3, entryId: id, status: 'APPROVED',
      official: {checkedAt: '2026-10-15T00:00:00Z'},
      classification: {confirmedAt: '2026-10-15T00:00:00Z'},
      editorialVoice: {status: 'written'}, editorial: {name: id}, h2: {token: id}};
    const digest = createHash('sha256').update(JSON.stringify({...base,
      official: {...base.official, checkedAt: ''},
      classification: {...base.classification, confirmedAt: ''}, editorialVoice: null})).digest('hex');
    journal.append({kind: 'token.data', token: id, patch: {key: `${id}.example`,
      gate: options.gate ?? 'pass', digest,
      ...(options.imported ? {importSource: {token: 'old-token'}} : {})}});
    fs.mkdirSync(path.join(project, 'published'), {recursive: true});
    const file = path.join(project, 'published', `${id}.example.json`);
    fs.writeFileSync(file, JSON.stringify({...base,
      ...(options.altered ? {editorial: {name: 'Changed after review'}} : {}),
      h2: {...base.h2, digest, publishedAt: '2026-10-15T00:00:01Z'}}, null, 2));
    journal.append({kind: 'token.finished', token: id, node: 'curation/published',
      status: 'published', reason: 'Passed current gate'});
    return file;
  };
  try {
    publish('imported', {imported: true});
    publish('already-main');
    publish('changed', {altered: true});
    publish('unapproved', {gate: 'fail'});
    for (let i = 0; i < 4; i++) publish(`valid-${i}`);
    assert.equal(outbox.status().pending.length, 4);
    assert.equal(outbox.status().batches.length, 0);
    assert.equal(outbox.status().blocked.length, 2);
    publish('valid-4');
    const status = outbox.status();
    assert.equal(status.pending.length, 0);
    assert.equal(status.batches.length, 1);
    const batch = status.batches[0];
    assert.equal(batch.reason, 'size');
    assert.equal(batch.items.length, 5);
    assert.equal(batch.remotePublished, false);
    assert.equal(JSON.parse(fs.readFileSync(batch.manifestPath, 'utf8')).status, 'prepared');
    const item = batch.items[0];
    const original = fs.readFileSync(item.recordPath);
    fs.writeFileSync(item.sourcePath, 'Mutable publication was replaced');
    assert.deepEqual(fs.readFileSync(item.recordPath), original);
    assert.equal(createHash('sha256').update(original).digest('hex'), item.sha256);
    assert.equal(JSON.parse(original.toString('utf8')).h2.token, item.sourceToken);
    journal.append({kind: 'token.finished', token: item.sourceToken, node: 'curation/published',
      status: 'published', reason: 'Duplicate notification'});
    assert.equal(outbox.status().pending.length, 0);
    assert.equal(outbox.status().batches.length, 1);
    assert.equal(outbox.status().blocked.length, 2, 'a seen digest does not reread a mutable source');
    publish('snapshot-corrupt');
    const pending = outbox.status().pending[0];
    fs.writeFileSync(pending.recordPath, 'Corrupted immutable snapshot');
    assert.equal(outbox.flush(), null);
    assert.equal(outbox.status().pending.length, 0);
    assert.equal(outbox.status().batches.length, 1, 'a corrupt snapshot never becomes a ready manifest');
    assert.equal(outbox.status().blocked.length, 3);
  } finally {
    outbox.close();
    journal.close();
    assert.equal(path.dirname(path.resolve(project)), path.resolve(os.tmpdir()));
    fs.rmSync(project, {recursive: true, force: true});
  }
});

test('publication outbox resumes pending files and missed events, deduplicates manifest recovery and flushes by age', async t => {
  const {Journal} = await import('../server/journal.ts');
  const {PublicationOutbox} = await import('../server/publication-outbox.ts');
  const {createHash} = await import('node:crypto');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-outbox-replay-'));
  const journal = new Journal(path.join(project, 'journal.db'));
  journal.append({kind: 'run.started', runId: 'outbox-replay', title: 'Outbox recovery'});
  const publish = (id: string) => {
    journal.append({kind: 'token.created', token: id, item: id, line: 'curation',
      url: `https://${id}.example/`, source: 'candidates/pool'});
    const base = {schemaVersion: 3, entryId: id, status: 'APPROVED',
      official: {checkedAt: ''}, classification: {confirmedAt: ''}, editorialVoice: null, h2: {token: id}};
    const digest = createHash('sha256').update(JSON.stringify(base)).digest('hex');
    journal.append({kind: 'token.data', token: id, patch: {key: `${id}.example`, gate: 'pass', digest}});
    fs.mkdirSync(path.join(project, 'published'), {recursive: true});
    fs.writeFileSync(path.join(project, 'published', `${id}.example.json`),
      JSON.stringify({...base, h2: {...base.h2, digest, publishedAt: 'now'}}));
    journal.append({kind: 'token.finished', token: id, node: 'curation/published',
      status: 'published', reason: 'Passed current gate'});
  };
  publish('historical');
  const offline = new PublicationOutbox(project, journal, {deferReplay: true});
  for (const event of journal.read()) offline.observe(event);
  offline.close();
  assert.equal(fs.existsSync(path.join(project, 'work', 'publication-batches')), false,
    'offline replay and close do not create publication files');
  let outbox = new PublicationOutbox(project, journal, {maxWaitMs: 50});
  try {
    assert.equal(outbox.status().pending.length, 0, 'first installation does not requeue historical output');
    publish('first');
    const snapshot = outbox.serialize();
    const snapshotSeq = journal.seq;
    outbox.close();
    publish('while-closed');
    journal.append({kind: 'token.data', token: 'while-closed', patch: {gate: 'later value'}});
    const indexPath = path.join(project, 'work', 'publication-batches', 'outbox.json');
    const replayCheckpoint = fs.readFileSync(indexPath);
    const replayRecords = fs.readdirSync(path.join(project, 'work', 'publication-batches', 'records'));
    outbox = new PublicationOutbox(project, journal, {maxWaitMs: 50, deferReplay: true});
    outbox.restore(snapshot);
    for (const event of journal.read(snapshotSeq)) {
      outbox.observe(event);
      outbox.observe(event);
    }
    const queuedSnapshot = outbox.serialize();
    outbox.close();
    outbox = new PublicationOutbox(project, journal, {maxWaitMs: 50, deferReplay: true});
    outbox.restore(queuedSnapshot);
    assert.deepEqual(fs.readFileSync(indexPath), replayCheckpoint,
      'snapshot restore and tail observation never persist publication state');
    assert.deepEqual(fs.readdirSync(path.join(project, 'work', 'publication-batches', 'records')), replayRecords,
      'queued publications remain unprocessed until start');
    outbox.start();
    outbox.start();
    assert.equal(outbox.status().pending.length, 2,
      'pending data and missed events retain the gate data at publication, before later patches');
    const beforeFlush = fs.readFileSync(indexPath);
    const beforeFlushSnapshot = outbox.serialize();
    const beforeFlushSeq = journal.seq;
    const batch = outbox.flush();
    assert.equal(batch?.items.length, 2);
    assert.equal(batch?.reason, 'manual');
    outbox.close();
    // Reproduce a crash between manifest rename and pending-index replacement.
    fs.writeFileSync(indexPath, beforeFlush);
    outbox = new PublicationOutbox(project, journal, {maxWaitMs: 50, deferReplay: true});
    outbox.restore(beforeFlushSnapshot);
    outbox.start();
    assert.equal(outbox.status().pending.length, 0);
    assert.equal(outbox.status().batches.length, 1);
    journal.append({kind: 'token.finished', token: 'first', node: 'curation/published',
      status: 'published', reason: 'Repeated event after replay'});
    assert.equal(outbox.status().pending.length, 0);
    publish('aged');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(outbox.status().pending.length, 0);
    assert.equal(outbox.status().batches.length, 2);
    assert.equal(outbox.status().batches[1].reason, 'timeout');
    assert.equal(outbox.status().batches.every(batch => batch.remotePublished === false), true);
    publish('disk-newer-pending');
    outbox.close();
    const newerCheckpoint = fs.readFileSync(indexPath);
    outbox = new PublicationOutbox(project, journal, {deferReplay: true});
    outbox.restore(beforeFlushSnapshot);
    for (const event of journal.read(beforeFlushSeq)) outbox.observe(event);
    assert.deepEqual(fs.readFileSync(indexPath), newerCheckpoint);
    outbox.start();
    assert.equal(outbox.status().batches.length, 2, 'newer disk manifests survive an older SQLite snapshot');
    assert.deepEqual(outbox.status().pending.map(item => item.sourceToken), ['disk-newer-pending'],
      'a newer disk cursor retains pending publications without reaccepting earlier tail events');
    assert.equal(outbox.status().blocked.length, 0);
    const rename = fs.renameSync;
    const checkpointFault = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (to === indexPath) throw new Error('Fixture publication checkpoint write failure');
      rename(from, to);
    });
    publish('checkpoint-fault');
    assert.equal(outbox.status().suspended, true);
    const failedSnapshot = outbox.serialize();
    outbox.close();
    checkpointFault.mock.restore();
    outbox = new PublicationOutbox(project, journal, {deferReplay: true});
    outbox.restore(failedSnapshot);
    outbox.start();
    assert.equal(outbox.status().suspended, false);
    assert.deepEqual(outbox.status().pending.map(item => item.sourceToken),
      ['disk-newer-pending', 'checkpoint-fault'],
      'a snapshot after an index-write failure must retain its unfinished publication despite an advanced cursor');
    assert.equal(outbox.status().batches.length, 2);
    const prepared = outbox.status().batches[0];
    outbox.close();
    fs.writeFileSync(prepared.items[0].recordPath, 'Prepared snapshot was corrupted');
    const retainedCheckpoint = fs.readFileSync(indexPath);
    const retainedManifest = fs.readFileSync(prepared.manifestPath);
    outbox = new PublicationOutbox(project, journal, {maxWaitMs: 50});
    assert.equal(outbox.status().suspended, true);
    assert.match(outbox.status().issue ?? '', /snapshot integrity failure/);
    assert.equal(outbox.status().batches.length, 0, 'unverified prepared files are not advertised as ready');
    assert.throws(() => outbox.flush(), /snapshot integrity failure/);
    outbox.close();
    assert.deepEqual(fs.readFileSync(indexPath), retainedCheckpoint);
    assert.deepEqual(fs.readFileSync(prepared.manifestPath), retainedManifest);
  } finally {
    outbox.close();
    journal.close();
    assert.equal(path.dirname(path.resolve(project)), path.resolve(os.tmpdir()));
    fs.rmSync(project, {recursive: true, force: true});
  }
});

test('publication outbox isolates a checkpoint from a replaced journal without overwriting retained files', async () => {
  const {Journal} = await import('../server/journal.ts');
  const {PublicationOutbox} = await import('../server/publication-outbox.ts');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-outbox-sequence-'));
  const journalPath = path.join(project, 'journal.db');
  let journal = new Journal(journalPath);
  journal.append({kind: 'run.started', runId: 'old-run', title: 'Existing journal'});
  journal.append({kind: 'dispatch.note', node: 'dispatcher', tone: 'info', text: 'Existing history'});
  let outbox = new PublicationOutbox(project, journal);
  outbox.close();
  journal.close();
  const indexPath = path.join(project, 'work', 'publication-batches', 'outbox.json');
  const retained = fs.readFileSync(indexPath);
  fs.rmSync(journalPath);
  journal = new Journal(journalPath);
  try {
    outbox = new PublicationOutbox(project, journal);
    assert.equal(outbox.status().suspended, true);
    assert.match(outbox.status().issue ?? '', /sequence 2 exceeds journal sequence 0/);
    assert.equal(outbox.status().pending.length, 0);
    assert.equal(outbox.status().batches.length, 0);
    assert.throws(() => outbox.flush(), /retained files require reconciliation/);
    journal.append({kind: 'run.started', runId: 'replacement', title: 'Workflow can still start'});
    assert.equal(journal.seq, 1, 'optional outbox recovery does not block the active workflow');
    outbox.close();
    assert.deepEqual(fs.readFileSync(indexPath), retained, 'suspension preserves the original checkpoint bytes');
  } finally {
    outbox.close();
    journal.close();
    assert.equal(path.dirname(path.resolve(project)), path.resolve(os.tmpdir()));
    fs.rmSync(project, {recursive: true, force: true});
  }
});

// Synthetic HTTP/source documents, real control, content files and disk journal.
// These fixtures never open a browser or make a network/model request.
async function entryUrlDecisionFixture() {
  const project = path.join(dir, `entry-url-${crypto.randomUUID()}`);
  const factory = new Factory(project);
  await factory.boot(); factory.runtime.start('Exact Entry URL decision'); factory.runtime.pause();
  const sha = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex');
  const entryId = 'font-entry', oldUrl = 'https://old.fixture.test/font', newUrl = 'https://new.fixture.test/font/';
  const sourceRoot = path.join(project, 'source'); fs.mkdirSync(sourceRoot, {recursive: true});
  const storageDir = path.join(project, 'context', 'external-intake', 'vislexicon-20261014');
  const attachments: import('../server/external-intake.ts').ExternalIntakeAttachment[] = [];
  const put = (sourcePath: string, value: unknown, kind = 'source') => {
    const bytes = Buffer.from(JSON.stringify(value));
    const file = path.join(storageDir, 'objects', sha(bytes) + '.json'); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, bytes);
    const ref = {kind, sourcePath, path: file, sha256: sha(bytes), bytes: bytes.length}; attachments.push(ref); return ref;
  };
  const headers = `HTTP/1.1 200 Connection established\r\n\r\nHTTP/1.1 301 Moved\r\nLocation: ${newUrl.slice(0, -1)}\r\n\r\nHTTP/2 301\r\nlocation: ${newUrl}\r\n\r\nHTTP/2 200\r\ncontent-type: text/html\r\n\r\n`;
  const chain = [{responseUrl: oldUrl, httpStatus: 301, location: newUrl.slice(0, -1), redirectedTo: newUrl.slice(0, -1)},
    {responseUrl: newUrl.slice(0, -1), httpStatus: 301, location: newUrl, redirectedTo: newUrl},
    {responseUrl: newUrl, httpStatus: 200, location: null, redirectedTo: null}];
  const body = '<a href="https://github.com/owner/font">Project</a><a href="icons.html">Icons</a><a href="examples.html">Examples</a><a href="license.html">License</a>';
  const source = (name: string, url: string, raw: string, extra: Record<string, unknown> = {}) => put(`docs/verification/extra-200-20261013/sources/${entryId}/${name}.json`,
    {entryId, sourceUrl: url, raw, sha256: sha(raw), ...extra});
  const redirect = source('redirect', newUrl, body, {inputUrl: oldUrl, readUrl: oldUrl, finalUrl: newUrl,
    httpStatus: 200, exitCode: 0, responseHeadersRaw: headers, responseHeadersSha256: sha(headers), redirectChain: chain});
  // The actual retained repository uses an HTTP historical homepage while the
  // input request and its redirect chain were HTTPS. Neither source is rewritten.
  const historicalHome = oldUrl.replace('https:', 'http:') + '/';
  const repoRaw = JSON.stringify({id: 1234, full_name: 'owner/font', homepage: historicalHome, private: false});
  const repository = source('repository', 'https://api.github.com/repos/owner/font', repoRaw);
  const readme = source('readme', 'https://github.com/owner/font/blob/fixed/README.md', `# Font\nDocs [homepage](${historicalHome})`);
  source('icons', newUrl + 'icons.html', '<section id="application"><h2>Web Application</h2><i>Actual fixture glyph</i></section>');
  source('examples', newUrl + 'examples.html', '<section id="larger"><h2>Larger Icons <small>Source link</small></h2><i>Actual fixture glyph sizes</i></section>');
  const quote = (ref: typeof redirect, value: string) => {
    const data = JSON.parse(fs.readFileSync(ref.path, 'utf8')) as {raw: string; sourceUrl: string};
    return {observedEntryId: entryId, sourceFile: ref.sourcePath.replace('docs/verification/extra-200-20261013/', ''),
      fileSha256: ref.sha256, sourceUrl: data.sourceUrl, sourceSha256: sha(data.raw), quote: value,
      characterOffset: data.raw.indexOf(value), purpose: 'Synthetic exact-source evidence'};
  };
  const evidence = [quote(redirect, 'https://github.com/owner/font'), quote(repository, '"id":1234'),
    quote(repository, '"full_name":"owner/font"'), quote(repository, `"homepage":"${historicalHome}"`),
    quote(readme, historicalHome), quote(redirect, 'href="icons.html"'), quote(redirect, 'href="examples.html"'), quote(redirect, 'href="license.html"')];
  const unknown = {value: 'unknown', sourceUrl: oldUrl, quote: '', evidence: 'Original direct-source boundary', scope: 'Original exact Entry'};
  const facts = Object.fromEntries(['author', 'organization', 'repository', 'license', 'pricing', 'sourceCode', 'commercial', 'repositoryLicense'].map(field => [field, {...unknown}]));
  const offers = [{id: 'own-source', scope: 'Own code only', pricing: {...unknown}, sourceCode: {...unknown}, license: {...unknown}, commercial: {...unknown}, repositoryLicense: {...unknown}}];
  const factsRef = put(`docs/verification/extra-200-20261013/facts-drafts/${entryId}.json`, {entryId, facts, offers}, 'facts');
  const plan = {entryId, pages: [{role: 'identity', url: newUrl, scrollY: 0},
    {role: 'breadth', url: newUrl + 'icons.html', scrollSelector: '#application'},
    {role: 'proof', url: newUrl + 'examples.html', scrollSelector: '#larger'}]};
  const planRef = put(`docs/verification/continuous-intake-20261014/lane-b/plans/${entryId}.json`, plan, 'plan');
  const proposal = {schemaVersion: 1, entryId, selectionOrdinal: 1, authorId: 'source-author', decision: 'repair-entry-url', status: 'PROPOSED',
    decisionScope: 'candidate-entry-url-repair-only', originalInputUrl: oldUrl, proposedUrl: newUrl,
    originalOrigin: new URL(oldUrl).origin, proposedOrigin: new URL(newUrl).origin, stableRepository: 'owner/font', stableRepositoryId: 1234,
    redirectEvidence: {observedEntryId: entryId, sourceFile: evidence[0].sourceFile, fileSha256: redirect.sha256,
      rawSha256: sha(body), responseHeadersSha256: sha(headers), originalInputUrl: oldUrl, requestUrl: oldUrl,
      observedFinalUrl: newUrl, numRedirects: 2, responseCode: 200, curlExitCode: 0, redirectChain: chain},
    evidence, originalObservationPreserved: true, rawSelectionSha256: sha('fixture raw input'), assignmentSha256: sha('fixture assignment'),
    originalInputRewritten: false, mutationApplied: false, centralSelectionChanged: false, captureHostGuardChanged: false,
    fullFiveKindApproval: false, countedAsCompleted: false, existingFacts: {sha256: factsRef.sha256, modified: false, approvalInherited: false}};
  const proposalRef = put(`docs/verification/continuous-intake-20261014/lane-b/identity-decisions/${entryId}.json`, proposal);
  const review = {schemaVersion: 1, entryId, selectionOrdinal: 1, reviewerId: 'independent-source-reviewer', proposalSha256: proposalRef.sha256,
    verdict: 'pass-for-entry-url-repair-only', approvedDecision: 'repair-entry-url', approvedOriginalInputUrl: oldUrl,
    approvedCanonicalUrl: newUrl, approvedScope: 'Exact project Entry only', evidenceAudits: evidence.map(item => ({...item, quoteSha256: sha(item.quote), exactOriginalVerified: true})),
    redirectAudit: {redirectChain: chain, rawBodySha256: sha(body), responseHeadersRawSha256: sha(headers)},
    repositoryAudit: {stableRepositoryId: 1234, fullName: 'owner/font'}, rawSelectionSha256: proposal.rawSelectionSha256,
    assignmentSha256: proposal.assignmentSha256, rawSelectionCountBefore: 1, rawSelectionCountAfter: 1,
    existingFacts: {...proposal.existingFacts},
    originalObservationPreserved: true, centralMutationApplied: false, entityMergeApproved: false, newCandidateCreated: false,
    captureOriginOverrideApproved: false, captureHostGuardChanged: false, cameraSlotAuthorized: false, classificationInherited: false,
    recordDigest: null, screenshotsViewed: false, fullFiveKindApproval: false, countedAsCompleted: false, problems: []};
  const reviewRef = put(`docs/verification/continuous-intake-20261014/lane-b/reviews/${entryId}.identity-decision-review.json`, review, 'review');
  const manifestPath = path.join(storageDir, 'snapshots', 'fixture.json'); fs.mkdirSync(path.dirname(manifestPath), {recursive: true});
  const intake = {schemaVersion: 1 as const, intakeId: 'vislexicon-20261014', sourceRoot, storageDir, manifestPath,
    inventorySha256: sha('fixture inventory'), importedAt: new Date().toISOString(), alreadyPresent: false, publicationEvidenceScope: 'saved-main-receipt' as const,
    summary: {rawObservations: 1, uniqueEntryIds: 1, facts: 1, factsPassed: 1, factsBlocked: 0, factsPending: 0, published: 0,
      unpublishedFacts: 1, continuationCandidates: 1, threeRolePlans: 1, fullDrafts: 0, currentFiveKindApprovals: 0},
    candidates: [{entryId, ordinal: 1, title: 'Font Entry', url: oldUrl, observationOrdinals: [1], disposition: 'continue' as const,
      nextGap: 'capture', stages: {facts: 'passed' as const, plan: 'three-roles' as const, precopy: false, capturedRoles: [],
        fullDraft: false, currentFiveKindApproval: false, contentDigest: null}, publication: null, holds: [], attachments,
      currentAttachments: {facts: factsRef, plan: planRef}}], files: attachments, warnings: []};
  fs.writeFileSync(manifestPath, JSON.stringify(intake)); fs.writeFileSync(path.join(storageDir, 'current.json'), JSON.stringify({manifestPath}));
  factory.externalIntake = intake; factory.catalog.push({id: entryId, name: 'Font Entry', canonicalUrl: oldUrl});
  const rawImage = factory.store.put(Buffer.from('Historical fixture PNG bytes; no native capture state'), 'png');
  const token = factory.runtime.create('curation/identity', {item: entryId, url: oldUrl, title: 'Font Entry', source: 'candidates/pool', data: {
    canonical: oldUrl, host: 'old.fixture.test', key: 'old.fixture.test/font', mode: 'shots', kind: 'assets', needsProof: true,
    externalResearch: {entryId, intakeId: intake.intakeId, inventorySha256: intake.inventorySha256},
    facts, offers, factPages: [{url: oldUrl, text: 'Original unchanged source body'}], externalFactsReused: true,
    readerPlan: {identity: {url: oldUrl}, breadth: {url: oldUrl + '/icons.html'}, proof: {url: oldUrl + '/examples.html', locate: 'Larger Icons'}},
    shots: {identity: {file: rawImage.file, href: newUrl}}, reviews: [{station: 'classify-review', verdict: 'pass'}, {station: 'fact-review', verdict: 'cancelled'}],
    __runtimeRecovery: {version: 1, runId: factory.state.run.id, kind: 'network', state: 'blocked', station: 'curation/identity',
      nextAt: 0, networkAttempts: 2, modelFailures: 1, failureAttempt: 'historical-failure', attempts: 2},
    failure: {tag: 'tool_error', category: 'system', owner: 'system', retryable: true, message: 'offSite', url: oldUrl}}});
  token.entry = 'candidates/route'; token.closure = factory.runtime.closureOf(token.entry);
  token.done = new Set(['candidates/route', 'curation/dedupe', 'curation/scout', 'curation/classify', 'curation/classify-review',
    'curation/kind-join', 'curation/reader', 'curation/catalog', 'curation/plan', 'curation/facts']);
  token.rounds = {'curation/proof': 2}; token.notes.set('curation/proof', {reason: 'Original bounded history', byHuman: false});
  factory.runtime.checkpoint(token); factory.runtime.parkRecovery(token, 'curation/identity', 'offSite');
  factory.journal.append({kind: 'evidence.added', evidence: {id: 'original-identity', token: token.id, attempt: 'old-attempt',
    station: 'curation/identity', at: 1, kind: 'image', src: rawImage.src, label: 'Historical failed original, no native state'}});
  const manifest = {schemaVersion: 1, kind: 'entry-url-repair', entryId, proposal: {path: proposalRef.path, sha256: proposalRef.sha256},
    review: {path: reviewRef.path, sha256: reviewRef.sha256}, retainedPlan: {path: planRef.path, sha256: planRef.sha256}};
  const repairPath = path.join(project, 'entry-url-manifest.json'); fs.writeFileSync(repairPath, JSON.stringify(manifest));
  const control = new FactoryControl(factory), inspected = await control.execute('inspect', {token: token.id});
  const request = {token: token.id, runId: factory.state.run.id, expectedCheckpointSha256: String(inspected.result.proofCheckpointSha256),
    idempotencyKey: 'repair-once', manifestPath: repairPath, manifestSha256: sha(fs.readFileSync(repairPath)), reason: 'Apply the independently reviewed exact Entry HTTP migration'};
  return {factory, project, token, control, request, manifest, repairPath, proposal, review, proposalRef, reviewRef,
    plan, planRef, factsRef, redirect, attachments, intake, oldUrl, newUrl, facts, offers, rawImage, sha};
}

test('apply_entry_url_decision creates one paused exact checkpoint successor without rewriting inputs or budgets', async () => {
  const f = await entryUrlDecisionFixture();
  try {
    const original = structuredClone(f.factory.state.tokens[f.token.id]);
    f.attachments.push({...f.planRef, sourcePath: f.planRef.sourcePath.replace('continuous-intake-20261014/lane-b', 'extra-200-20261013')});
    const pool = f.factory.state.nodes['candidates/pool'].stock, manual = f.factory.state.nodes['curation/manual'].stock;
    const response = await f.control.execute('apply_entry_url_decision', f.request);
    const next = f.factory.runtime.tokens.get(String(response.result.token))!;
    assert.ok(next); assert.equal(next.url, f.oldUrl); assert.equal(next.item, f.token.item);
    assert.equal(next.data.canonical, f.newUrl.slice(0, -1)); assert.equal(next.data.host, 'new.fixture.test');
    assert.deepEqual(next.data.facts, f.facts); assert.deepEqual(next.data.offers, f.offers);
    assert.deepEqual(next.rounds, original.rounds); assert.deepEqual(next.data.__runtimeRecovery, original.data.__runtimeRecovery);
    assert.equal(f.factory.runtime.paused, true); assert.equal(f.factory.state.run.id, f.request.runId);
    assert.equal(f.factory.state.recoveries[f.token.item].token, next.id); assert.equal(f.factory.state.recoveries[f.token.item].attempts, 1);
    assert.equal(f.factory.state.nodes['candidates/pool'].stock, pool - 1); assert.equal(f.factory.state.nodes['curation/manual'].stock, manual);
    assert.deepEqual(f.factory.state.tokens[f.token.id].data.runtimeCheckpoint, original.data.runtimeCheckpoint);
    assert.deepEqual(fs.readFileSync(f.rawImage.file), Buffer.from('Historical fixture PNG bytes; no native capture state'));
    assert.equal(next.done.has('curation/facts'), true); assert.equal(next.done.has('curation/fact-review'), false);
    assert.ok(f.factory.runtime.queues.get('curation/identity')?.includes(next.id));
    assert.ok(f.factory.runtime.queues.get('curation/fact-review')?.includes(next.id));
    assert.equal(response.result.review, 'pending'); assert.equal(response.result.alreadyPresent, false);
  } finally {await close(f.factory); fs.rmSync(f.project, {recursive: true, force: true});}
});

type EntryDecisionFixture = Awaited<ReturnType<typeof entryUrlDecisionFixture>>;
function rewriteEntryDecision(f: EntryDecisionFixture) {
  const pin = (prior: typeof f.proposalRef, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const next = {...prior, sha256: f.sha(bytes), bytes: bytes.length,
      path: path.join(path.dirname(prior.path), f.sha(bytes) + '.json')};
    fs.writeFileSync(next.path, bytes);
    f.attachments.splice(f.attachments.indexOf(prior), 1, next);
    return next;
  };
  f.proposalRef = pin(f.proposalRef, f.proposal);
  f.review.proposalSha256 = f.proposalRef.sha256;
  f.reviewRef = pin(f.reviewRef, f.review);
  f.planRef = pin(f.planRef, f.plan);
  f.intake.candidates[0].currentAttachments.plan = f.planRef;
  f.manifest.proposal = {path: f.proposalRef.path, sha256: f.proposalRef.sha256};
  f.manifest.review = {path: f.reviewRef.path, sha256: f.reviewRef.sha256};
  f.manifest.retainedPlan = {path: f.planRef.path, sha256: f.planRef.sha256};
  fs.writeFileSync(f.repairPath, JSON.stringify(f.manifest));
  f.request.manifestSha256 = f.sha(fs.readFileSync(f.repairPath));
  fs.writeFileSync(f.intake.manifestPath, JSON.stringify(f.intake));
}
async function rejectEntryDecision(f: EntryDecisionFixture, code: string, request: Record<string, unknown> = f.request) {
  const before = {seq: f.factory.journal.seq, tokens: [...f.factory.state.tokenOrder],
    stocks: [f.factory.state.nodes['candidates/pool'].stock, f.factory.state.nodes['curation/manual'].stock]};
  await assert.rejects(f.control.execute('apply_entry_url_decision', request),
    (error: unknown) => (error as {code?: string}).code === code);
  assert.deepEqual({seq: f.factory.journal.seq, tokens: f.factory.state.tokenOrder,
    stocks: [f.factory.state.nodes['candidates/pool'].stock, f.factory.state.nodes['curation/manual'].stock]}, before);
}

test('apply_entry_url_decision rejects unsafe request paths, SHA changes and approval-bearing manifests', async () => {
  const f = await entryUrlDecisionFixture();
  try {
    await rejectEntryDecision(f, 'invalid_arguments', {...f.request, shotReview: 'pass'});
    await rejectEntryDecision(f, 'entry_url_integrity', {...f.request, manifestSha256: '0'.repeat(64)});
    const outside = path.join(dir, `unconfigured-${crypto.randomUUID()}.json`);
    fs.writeFileSync(outside, fs.readFileSync(f.repairPath));
    try {await rejectEntryDecision(f, 'entry_url_path_outside_root', {...f.request, manifestPath: outside});}
    finally {fs.unlinkSync(outside);}
    const original = fs.readFileSync(f.repairPath);
    for (const change of [{entryId: 'another-entry'}, {fullFiveKindApproval: true}, {offSite: false}, {canonical: f.newUrl}]) {
      const bytes = Buffer.from(JSON.stringify({...f.manifest, ...change})); fs.writeFileSync(f.repairPath, bytes);
      await rejectEntryDecision(f, 'entry_url_manifest_invalid', {...f.request, manifestSha256: f.sha(bytes)});
    }
    fs.writeFileSync(f.repairPath, original);
    for (const attachment of [f.proposalRef, f.reviewRef, f.planRef, f.redirect, f.factsRef]) {
      const bytes = fs.readFileSync(attachment.path); fs.appendFileSync(attachment.path, '\n');
      await rejectEntryDecision(f, 'entry_url_integrity'); fs.writeFileSync(attachment.path, bytes);
    }
    assert.equal(f.factory.runtime.paused, true);
  } finally {await close(f.factory); fs.rmSync(f.project, {recursive: true, force: true});}
});

test('apply_entry_url_decision rejects repinned non-independent decisions and incomplete source audits', async () => {
  const f = await entryUrlDecisionFixture();
  const baseline = structuredClone({proposal: f.proposal, review: f.review});
  try {
    const mutations: (() => void)[] = [
      () => {f.review.reviewerId = f.proposal.authorId;},
      () => {f.review.fullFiveKindApproval = true;},
      () => {f.review.entityMergeApproved = true;},
      () => {f.proposal.captureHostGuardChanged = true;},
      () => {f.review.rawSelectionCountAfter = 2;},
      () => {f.proposal.evidence[0].characterOffset += 1;},
      () => {f.review.evidenceAudits[0].quoteSha256 = '0'.repeat(64);},
      () => {f.review.evidenceAudits[0].exactOriginalVerified = false;},
      () => {f.review.rawSelectionSha256 = f.proposal.rawSelectionSha256 = '';},
      () => {f.proposal.evidence.pop();},
    ];
    for (const mutate of mutations) {
      f.proposal = structuredClone(baseline.proposal); f.review = structuredClone(baseline.review);
      mutate(); rewriteEntryDecision(f); await rejectEntryDecision(f, 'entry_url_decision_invalid');
    }
    f.proposal = structuredClone(baseline.proposal); f.review = structuredClone(baseline.review);
    f.proposal.evidence[0].quote = 'Invented source body'; f.proposal.evidence[0].characterOffset = 0;
    f.review.evidenceAudits[0] = {...f.proposal.evidence[0], quoteSha256: f.sha(f.proposal.evidence[0].quote), exactOriginalVerified: true};
    rewriteEntryDecision(f); await rejectEntryDecision(f, 'entry_url_source_invalid');
    f.proposal = structuredClone(baseline.proposal); f.review = structuredClone(baseline.review);
    f.proposal.stableRepositoryId = 999; f.review.repositoryAudit.stableRepositoryId = 999;
    rewriteEntryDecision(f); await rejectEntryDecision(f, 'entry_url_source_invalid');
    f.proposal = structuredClone(baseline.proposal); f.review = structuredClone(baseline.review);
    f.proposal.evidence[0].sourceUrl = f.review.evidenceAudits[0].sourceUrl = 'https://sibling.fixture.test/';
    rewriteEntryDecision(f); await rejectEntryDecision(f, 'entry_url_integrity');
    f.proposal = structuredClone(baseline.proposal); f.review = structuredClone(baseline.review);
    f.proposal.redirectEvidence.redirectChain = [...f.proposal.redirectEvidence.redirectChain].reverse();
    rewriteEntryDecision(f); await rejectEntryDecision(f, 'entry_url_source_invalid');
  } finally {await close(f.factory); fs.rmSync(f.project, {recursive: true, force: true});}
});

test('apply_entry_url_decision requires the exact paused drained original run and live checkpoint', async () => {
  const f = await entryUrlDecisionFixture();
  try {
    await rejectEntryDecision(f, 'entry_url_target_changed', {...f.request, token: f.token.item});
    await rejectEntryDecision(f, 'entry_url_run_not_quiescent', {...f.request, runId: 'another-run'});
    await rejectEntryDecision(f, 'entry_url_checkpoint_changed', {...f.request, expectedCheckpointSha256: '0'.repeat(64)});
    f.factory.runtime.paused = false;
    await rejectEntryDecision(f, 'entry_url_run_not_quiescent'); f.factory.runtime.paused = true;
    f.factory.runtime.ending = true;
    await rejectEntryDecision(f, 'entry_url_run_not_quiescent'); f.factory.runtime.ending = false;
    const worker = [...f.factory.runtime.workers.values()].flat()[0]; worker.busy = 'isolated-test';
    await rejectEntryDecision(f, 'entry_url_run_not_quiescent'); worker.busy = null;
    f.token.inflight.add('curation/identity');
    await rejectEntryDecision(f, 'entry_url_run_not_quiescent'); f.token.inflight.clear();
    f.factory.broker.used.browser = 1;
    await rejectEntryDecision(f, 'entry_url_run_not_quiescent'); f.factory.broker.used.browser = 0;
    const release = await f.factory.broker.modelRequests.acquire(new AbortController().signal);
    try {await rejectEntryDecision(f, 'entry_url_run_not_quiescent');} finally {release();}
    const digest = f.factory.state.digest; f.factory.state.digest = 'stale-spec';
    await rejectEntryDecision(f, 'entry_url_checkpoint_changed'); f.factory.state.digest = digest;
    const failure = f.factory.state.tokens[f.token.id].data.failure;
    f.factory.state.tokens[f.token.id].data.failure = {...failure as object, message: 'Unrelated network failure'};
    await rejectEntryDecision(f, 'entry_url_target_changed'); f.factory.state.tokens[f.token.id].data.failure = failure;
    assert.equal(f.factory.runtime.paused, true);
  } finally {await close(f.factory); fs.rmSync(f.project, {recursive: true, force: true});}
});

test('apply_entry_url_decision CAS binds changed facts, offers, rounds and original checkpoint but ignores unrelated journal events', async () => {
  const f = await entryUrlDecisionFixture();
  try {
    f.factory.journal.append({kind: 'dispatch.note', node: 'dispatcher', tone: 'info', text: 'Unrelated concurrent status event'});
    const original = structuredClone(f.token.data);
    for (const patch of [{facts: {...f.facts, license: {value: 'Invented'}}}, {offers: []},
      {runtimeCheckpoint: {...original.runtimeCheckpoint as object, rounds: {'curation/proof': 0}}}, {ownerCaptureTargets: {proof: {url: 'a different owner target'}}}]) {
      f.factory.journal.append({kind: 'token.data', token: f.token.id, patch});
      await rejectEntryDecision(f, 'entry_url_checkpoint_changed');
      f.factory.journal.append({kind: 'token.data', token: f.token.id, patch: original});
      // A journal patch is intentionally a merge; remove the injected test-only
      // extra field in both isolated projections before the next scenario.
      delete f.token.data.ownerCaptureTargets;
      delete f.factory.state.tokens[f.token.id].data.ownerCaptureTargets;
    }
    // Restoring byte-identical data is not permission to replace the runtime's
    // exhausted/changed budget, even with a freshly inspected SHA.
    f.token.rounds = {'curation/proof': 0};
    await rejectEntryDecision(f, 'entry_url_checkpoint_missing'); f.token.rounds = {'curation/proof': 2};
    const applied = await f.control.execute('apply_entry_url_decision', f.request);
    assert.equal(applied.result.alreadyPresent, false);
  } finally {await close(f.factory); fs.rmSync(f.project, {recursive: true, force: true});}
});

test('apply_entry_url_decision validates exact retained facts, Entry ownership and unfinished cancelled review frontier', async () => {
  const f = await entryUrlDecisionFixture();
  try {
    const research = f.token.data.externalResearch;
    f.factory.journal.append({kind: 'token.data', token: f.token.id, patch: {externalResearch: {...research as object, inventorySha256: '0'.repeat(64)}}});
    let inspect = await f.control.execute('inspect', {token: f.token.id});
    await rejectEntryDecision(f, 'entry_url_entry_mismatch', {...f.request, expectedCheckpointSha256: inspect.result.proofCheckpointSha256});
    f.factory.journal.append({kind: 'token.data', token: f.token.id, patch: {externalResearch: research, facts: {...f.facts, license: {value: 'different'}}}});
    inspect = await f.control.execute('inspect', {token: f.token.id});
    await rejectEntryDecision(f, 'entry_url_upstream_incompatible', {...f.request, expectedCheckpointSha256: inspect.result.proofCheckpointSha256});
    f.factory.journal.append({kind: 'token.data', token: f.token.id, patch: {facts: f.facts}});
    for (const node of ['curation/fact-review', 'curation/identity', 'curation/gate']) {
      f.token.done.add(node); f.factory.runtime.checkpoint(f.token);
      inspect = await f.control.execute('inspect', {token: f.token.id});
      await rejectEntryDecision(f, 'entry_url_upstream_incompatible', {...f.request, expectedCheckpointSha256: inspect.result.proofCheckpointSha256});
      f.token.done.delete(node);
    }
    f.factory.runtime.checkpoint(f.token);
    const current = f.factory.state.recoveries[f.token.item];
    f.factory.journal.append({kind: 'candidate.disposition', candidate: {...current, disposition: 'claimed'}});
    await rejectEntryDecision(f, 'entry_url_recovery_changed');
    f.factory.journal.append({kind: 'candidate.disposition', candidate: {...current}});
    f.factory.runtime.stockDelta('candidates/pool', -1);
    await rejectEntryDecision(f, 'entry_url_recovery_changed');
  } finally {await close(f.factory); fs.rmSync(f.project, {recursive: true, force: true});}
});

test('apply_entry_url_decision rejects project escape, sibling roles and anchor substitutions after repinning', async () => {
  const f = await entryUrlDecisionFixture();
  const baseline = structuredClone({plan: f.plan, proposal: f.proposal, review: f.review});
  try {
    for (const target of ['https://new.fixture.test/', 'http://new.fixture.test/font/', 'https://new.fixture.test/other/',
      'https://new.fixture.test/font/?x=1', 'https://user@new.fixture.test/font/']) {
      f.proposal = structuredClone(baseline.proposal); f.review = structuredClone(baseline.review);
      f.proposal.proposedUrl = target; f.review.approvedCanonicalUrl = target;
      rewriteEntryDecision(f); await rejectEntryDecision(f, 'entry_url_scope_invalid');
    }
    f.proposal = structuredClone(baseline.proposal); f.review = structuredClone(baseline.review);
    for (const target of ['https://new.fixture.test/other/examples.html', 'https://new.fixture.test/font/never-linked.html',
      'https://new.fixture.test/font/examples.html?x=1', 'https://foreign.fixture.test/font/examples.html']) {
      f.plan = structuredClone(baseline.plan); f.plan.pages[2].url = target;
      rewriteEntryDecision(f); await rejectEntryDecision(f, 'entry_url_target_unverified');
    }
    f.plan = structuredClone(baseline.plan); f.plan.pages[2].scrollSelector = '#not-in-original-body';
    rewriteEntryDecision(f); await rejectEntryDecision(f, 'entry_url_target_unverified');
    f.plan = structuredClone(baseline.plan); f.plan.pages[2].scrollSelector = 'body; arbitrary()';
    rewriteEntryDecision(f); await rejectEntryDecision(f, 'entry_url_target_unverified');
  } finally {await close(f.factory); fs.rmSync(f.project, {recursive: true, force: true});}
});

test('apply_entry_url_decision rejects published Entries, current successors and cross-Entry identity collisions', async () => {
  const f = await entryUrlDecisionFixture();
  try {
    f.factory.catalog.push({id: 'sibling-entry', name: 'Sibling', canonicalUrl: f.newUrl});
    await rejectEntryDecision(f, 'entry_url_identity_collision'); f.factory.catalog.pop();
    const other = f.factory.runtime.create('curation/manual', {item: 'sibling-entry', url: f.newUrl, source: 'candidates/pool'});
    await rejectEntryDecision(f, 'entry_url_identity_collision');
    // Historical mappings also collide even when the current operating URL differs.
    f.factory.journal.append({kind: 'token.data', token: other.id, patch: {entryUrlDecisionReceipt: {originalInputUrl: f.oldUrl}, canonical: 'https://elsewhere.fixture.test/other'}});
    f.factory.state.tokens[other.id].url = 'https://elsewhere.fixture.test/other';
    await rejectEntryDecision(f, 'entry_url_identity_collision');
    f.factory.journal.append({kind: 'token.finished', token: other.id, node: 'curation/manual', status: 'manual', reason: 'Fixture'});
    f.factory.journal.append({kind: 'token.data', token: other.id, patch: {entryUrlDecisionReceipt: {}, retriedBy: 'historical-successor'}});
    const published = f.factory.runtime.create('curation/published', {item: f.token.item, url: f.oldUrl, source: 'candidates/pool'});
    f.factory.journal.append({kind: 'token.finished', token: published.id, node: 'curation/published', status: 'published', reason: 'Already published historical Entry'});
    f.factory.state.tokens[published.id].touchedAt = f.factory.state.run.startedAt - 1;
    await rejectEntryDecision(f, 'entry_url_already_published');
  } finally {await close(f.factory); fs.rmSync(f.project, {recursive: true, force: true});}
});

test('apply_entry_url_decision concurrent and restarted duplicate requests reconcile one durable successor and inventory claim', async () => {
  const f = await entryUrlDecisionFixture(); let factory = f.factory, closed = false;
  try {
    const count = factory.state.tokenOrder.length, pool = factory.state.nodes['candidates/pool'].stock;
    const [first, second] = await Promise.all([f.control.execute('apply_entry_url_decision', f.request), f.control.execute('apply_entry_url_decision', f.request)]);
    assert.equal(first.result.token, second.result.token); assert.equal(first.result.alreadyPresent, false); assert.equal(second.result.alreadyPresent, true);
    assert.equal(factory.state.tokenOrder.length, count + 1); assert.equal(factory.state.nodes['candidates/pool'].stock, pool - 1);
    await rejectEntryDecision(f, 'entry_url_idempotency_conflict', {...f.request, reason: 'A different request cannot share the same durable key'});
    await rejectEntryDecision(f, 'entry_url_target_changed', {...f.request, idempotencyKey: 'second-mutation'});
    await close(factory); closed = true; factory = new Factory(f.project); await factory.boot(); closed = false;
    fs.writeFileSync(f.repairPath, 'Changed after commit; replay is based on the durable receipt');
    const replay = await new FactoryControl(factory).execute('apply_entry_url_decision', f.request);
    assert.equal(replay.result.token, first.result.token); assert.equal(replay.result.alreadyPresent, true);
    assert.equal(factory.state.tokenOrder.length, count + 1); assert.equal(factory.runtime.paused, true);
    assert.equal(factory.state.recoveries[f.token.item].attempts, 1); assert.equal(factory.state.recoveries[f.token.item].disposition, 'claimed');
    const next = factory.runtime.tokens.get(String(first.result.token))!;
    assert.deepEqual(next.rounds, {'curation/proof': 2}); assert.deepEqual(next.data.__runtimeRecovery, f.token.data.__runtimeRecovery);
    assert.deepEqual(factory.state.tokens[next.id].rounds, next.rounds);
    assert.deepEqual([...factory.journal.read()].filter(event => event.kind === 'case.noted' && event.note.section === '入口 URL 决议').length, 1);
    assert.ok(factory.runtime.queues.get('curation/fact-review')?.includes(next.id));
  } finally {if (!closed) await close(factory); fs.rmSync(f.project, {recursive: true, force: true});}
});

test('apply_entry_url_decision resumes missing captures and cancelled fact review without repeating facts or inheriting publication', async () => {
  const f = await entryUrlDecisionFixture();
  try {
    const result = await f.control.execute('apply_entry_url_decision', f.request), nextId = String(result.result.token);
    const called: string[] = [];
    f.factory.runtime.executors = node => async () => {
      called.push(node.key);
      if (node.key === 'curation/shot-review') return {ok: true, summary: 'Independent source review still required', verdict: {verdict: 'escalate', reason: 'Fixture deliberately holds publication'}};
      return {ok: true, summary: 'Offline executor fixture', data: node.key === 'curation/fact-review' ? {'fact-reviewVerdict': 'pass'} : undefined};
    };
    f.factory.runtime.resume(); await f.factory.runtime.settle();
    assert.ok(called.includes('curation/identity')); assert.ok(called.includes('curation/breadth')); assert.ok(called.includes('curation/proof'));
    assert.ok(called.includes('curation/fact-review')); assert.ok(called.includes('curation/shot-review'));
    assert.ok(!called.includes('curation/facts') && !called.includes('curation/reader') && !called.includes('curation/plan'));
    assert.ok(!called.includes('curation/gate') && !called.includes('curation/published'));
    assert.equal(f.factory.state.tokens[nextId].status, 'manual'); assert.equal(result.result.publicationApproval, false);
    const next = f.factory.state.tokens[nextId]; assert.deepEqual(next.data.facts, f.facts); assert.deepEqual(next.data.offers, f.offers);
    assert.deepEqual(next.rounds, {'curation/proof': 2});
    assert.equal(fs.existsSync(path.join(f.project, 'published', 'new.fixture.test', 'font.json')), false);
  } finally {await close(f.factory); fs.rmSync(f.project, {recursive: true, force: true});}
});

test('apply_entry_url_decision rolls back an interrupted disk transaction and requires fresh recovery after restart', async () => {
  const f = await entryUrlDecisionFixture(); let factory = f.factory, closed = false;
  try {
    const events = [...factory.journal.read()], original = structuredClone(factory.state.tokens[f.token.id]);
    const append = factory.journal.append.bind(factory.journal);
    factory.journal.append = event => {
      if (event.kind === 'candidate.disposition' && event.candidate.disposition === 'claimed') throw new Error('Injected SQLite transaction interruption');
      return append(event);
    };
    await assert.rejects(f.control.execute('apply_entry_url_decision', f.request), /Injected SQLite transaction interruption/);
    assert.deepEqual([...factory.journal.read()], events); assert.equal(factory.runtime.running, false); assert.equal(factory.runtime.paused, true);
    assert.throws(() => factory.runtime.resume(), (error: unknown) => (error as {code?: string}).code === 'journal_commit_failed');
    factory.journal.append = append;
    await close(factory); closed = true; factory = new Factory(f.project); await factory.boot(); closed = false;
    assert.equal(factory.state.tokenOrder.length, 1); assert.equal(factory.state.tokens[f.token.id].data.retriedBy, undefined);
    assert.equal(factory.state.recoveries[f.token.item].disposition, 'retry'); assert.equal(factory.state.recoveries[f.token.item].attempts, 1);
    assert.deepEqual(factory.state.tokens[f.token.id].data.facts, original.data.facts); assert.deepEqual(factory.state.tokens[f.token.id].rounds, original.rounds);
    const control = new FactoryControl(factory), inspect = await control.execute('inspect', {token: f.token.id});
    const result = await control.execute('apply_entry_url_decision', {...f.request, expectedCheckpointSha256: inspect.result.proofCheckpointSha256});
    assert.equal(result.result.alreadyPresent, false); assert.equal(factory.state.tokenOrder.length, 2);
  } finally {if (!closed) await close(factory); fs.rmSync(f.project, {recursive: true, force: true});}
});
