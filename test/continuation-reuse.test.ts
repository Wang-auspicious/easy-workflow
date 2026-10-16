import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type {StationContext} from '../server/runtime.ts';
import {reuseExternalStation} from '../server/intake-continuation.ts';
import {reuseExternalCapture} from '../server/intake-captures.ts';
import {EvidenceStore} from '../server/evidence.ts';

test('resumed facts reuse current independent evidence without another paid facts call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-reuse-'));
  try {
    const bytes = Buffer.from(JSON.stringify({facts: {pricing: {value: 'unknown', evidence: 'Not stated'}},
      repositoryLicense: {value: 'ISC'}, conflicts: ['Website and repository have different scopes'],
      offers: [{id: 'specific-offer'}], pricingNote: 'Unknown'}));
    const file = path.join(root, 'facts.json'); fs.writeFileSync(file, bytes);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const headers = path.join(root, 'headers.txt'); fs.writeFileSync(headers, 'HTTP/1.1 200 OK');
    const ctx = {node: {key: 'curation/facts'}, token: {data: {externalResearch: {
      factsPassed: true, facts: {path: file, sha256: sha}, sources: [{path: headers, sourcePath: 'sources/entry/headers.txt'}],
    }}}, signal: new AbortController().signal, progress() {}, redo: undefined} as unknown as StationContext;
    let calls = 0;
    const result = await reuseExternalStation(ctx, async () => {calls++; throw new Error('Must reuse');});
    assert.equal(calls, 0);
    assert.equal(result.data?.pricingNote, 'Unknown');
    assert.deepEqual(result.data?.offers, [{id: 'specific-offer'}]);
    assert.deepEqual(result.data?.factConflicts, ['Website and repository have different scopes']);
    assert.deepEqual((result.data?.facts as Record<string, unknown>).repositoryLicense, {value: 'ISC'});
    const repaired = await reuseExternalStation({...ctx, redo: {reason: 'Fix pricing', byHuman: false}},
      async () => ({ok: true, summary: 'Corrected', data: {facts: {pricing: {value: 'paid'}}}}));
    assert.deepEqual(repaired.data?.offers, [], 'a changed fact must invalidate the old offer grant');
    assert.equal(repaired.data?.externalFactsReused, false);
    fs.writeFileSync(file, '{}');
    await assert.rejects(reuseExternalStation(ctx, async () => {calls++; return {ok: true, summary: 'Wrong fallback'};}), /integrity/i);
    assert.equal(calls, 0, 'a changed attachment must not silently redo paid work');
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('a reviewer correction reaches its owner rather than replaying the imported facts', async () => {
  const ctx = {node: {key: 'curation/facts'}, token: {data: {externalResearch: {factsPassed: true}}},
    redo: {reason: 'Correct the pricing scope'}, signal: new AbortController().signal} as unknown as StationContext;
  let calls = 0;
  await reuseExternalStation(ctx, async () => {calls++; return {ok: true, summary: 'Correction executed'};});
  assert.equal(calls, 1);
});

function captureFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-capture-reuse-'));
  const entryId = 'specific-entry-01234567';
  const sha = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
  const ppm = Buffer.concat([Buffer.from('P6\n8 8\n255\n'),
    Buffer.from(Array.from({length: 8 * 8 * 3}, (_, index) => index % 256))]);
  const imageBytes = EvidenceStore.webp(ppm, 8, 100);
  const ref = (name: string, bytes: Buffer, sourcePath: string) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, bytes);
    return {path: file, sourcePath, sha256: sha(bytes)};
  };
  const image = ref('image.webp', imageBytes,
    `docs/verification/extra-200-20261013/captures/${entryId}/identity.webp`);
  const page = {role: 'identity', file: 'identity.webp',
    sourceUrl: 'https://example.test/original', finalUrl: 'https://example.test/final/',
    title: 'Actual source title', shot: {sha256: image.sha256, width: 8, height: 8},
    issues: [], scrollPosition: {x: 0, y: 300}, captureState: {controls: []}};
  const observation = ref('observation.json', Buffer.from(JSON.stringify({entryId, pages: [page],
    sourceObservation: {original: 'retained source metadata'}})),
  `docs/verification/extra-200-20261013/captures/${entryId}/observation.json`);
  const imageReview = {role: 'identity', file: 'identity.webp', sha256: image.sha256,
    actuallyViewed: true, sourceUrl: page.sourceUrl, finalUrl: page.finalUrl,
    finding: 'The source identity and original artwork are visibly loaded.',
    verdict: 'identity-readable-only-pending-full-role-review'};
  const reviewBody = {entryId, reviewerId: 'codex:/independent-review',
    observationFileSha256: observation.sha256, images: [imageReview],
    verdict: 'awaiting-three-valid-images-and-current-full-draft', fullFiveKindApproval: false};
  const review = ref('review.json', Buffer.from(JSON.stringify(reviewBody)),
    `docs/verification/continuous-intake-20261014/lane-b/reviews/${entryId}.images-pre-review.json`);
  const evidence: unknown[] = [];
  const ctx = {node: {key: 'curation/identity'}, attempt: 'attempt-one',
    token: {data: {shots: {breadth: {file: 'existing-breadth', href: 'https://example.test/catalogue'}},
      externalResearch: {intakeId: 'vislexicon-20261014', entryId,
        captures: [image, observation], reviews: [review]}}},
    signal: new AbortController().signal, progress() {},
    addEvidence(value: unknown) {evidence.push(value); return value;},
  } as unknown as StationContext;
  const store = new EvidenceStore(path.join(root, 'evidence'));
  const rewriteReview = () => {
    const bytes = Buffer.from(JSON.stringify(reviewBody));
    fs.writeFileSync(review.path, bytes);
    review.sha256 = sha(bytes);
  };
  return {root, ctx, store, evidence, image, imageBytes, page, observation,
    imageReview, reviewBody, review, rewriteReview};
}

test('historical partial role observations reuse exact WebP bytes without inventing current approval or visual counts', async () => {
  const fixture = captureFixture();
  try {
    const result = await reuseExternalCapture(fixture.ctx, fixture.store);
    assert.equal(result?.ok, true);
    const shots = result!.data!.shots as Record<string, Record<string, unknown>>;
    assert.equal(shots.breadth.file, 'existing-breadth');
    assert.equal(shots.identity.href, fixture.page.finalUrl);
    assert.equal(String(shots.identity.hash).length, 64);
    assert.deepEqual(fs.readFileSync(String(shots.identity.file)), fixture.imageBytes);
    for (const unobserved of ['previews', 'visual', 'content']) {
      assert.equal(shots.identity[unobserved], undefined);
    }
    assert.equal(result!.verdict, undefined);
    assert.equal(result!.data!.images, undefined);
    const provenance = (result!.data!.externalCaptureReuse as Record<string, Record<string, unknown>>).identity;
    assert.equal(provenance.originalRoleVerdict, 'identity-readable-only-pending-full-role-review');
    assert.equal(provenance.sourceUrl, fixture.page.sourceUrl);
    assert.deepEqual(provenance.roleObservation, fixture.page);
    assert.equal(fixture.evidence.length, 1);
  } finally {fs.rmSync(fixture.root, {recursive: true, force: true});}
});

test('missing roles, stale semantic binding and unviewed images fall through to actual capture', async () => {
  const fixture = captureFixture();
  try {
    const missing = {...fixture.ctx, node: {...fixture.ctx.node, key: 'curation/proof'}};
    assert.equal(await reuseExternalCapture(missing, fixture.store), null);
    fixture.imageReview.actuallyViewed = false;
    fixture.rewriteReview();
    assert.equal(await reuseExternalCapture(fixture.ctx, fixture.store), null);
    fixture.imageReview.actuallyViewed = true;
    fixture.reviewBody.observationFileSha256 = '0'.repeat(64);
    fixture.rewriteReview();
    assert.equal(await reuseExternalCapture(fixture.ctx, fixture.store), null);
    assert.equal(fixture.evidence.length, 0);
  } finally {fs.rmSync(fixture.root, {recursive: true, force: true});}
});

test('historical image or review byte tampering throws instead of silently paying for another capture', async () => {
  const fixture = captureFixture();
  try {
    fs.writeFileSync(fixture.image.path, 'changed bytes');
    await assert.rejects(reuseExternalCapture(fixture.ctx, fixture.store), /integrity/);
    fs.writeFileSync(fixture.image.path, fixture.imageBytes);
    fs.appendFileSync(fixture.review.path, ' ');
    await assert.rejects(reuseExternalCapture(fixture.ctx, fixture.store), /integrity/);
    assert.equal(fixture.evidence.length, 0);
  } finally {fs.rmSync(fixture.root, {recursive: true, force: true});}
});
