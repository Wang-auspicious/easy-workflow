import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type {StationContext} from '../server/runtime.ts';
import {reuseExternalStation} from '../server/intake-continuation.ts';

process.env.FACTORY_PREFLIGHT = '0';
process.env.VISLEXICON_ROOT = path.join(os.tmpdir(), 'workflow-continuation-unconnected');
const {Factory} = await import('../server/factory.ts');
const {FactoryControl} = await import('../server/control.ts');

test('continuation keeps the existing paused round, excludes main and prioritizes prepared entry identities', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-continuation-'));
  const storageDir = path.join(project, 'context/external-intake/vislexicon-20261014');
  fs.mkdirSync(path.join(storageDir, 'snapshots'), {recursive: true});
  const stages = {facts: 'missing', plan: 'missing', precopy: false, capturedRoles: [], fullDraft: false,
    currentFiveKindApproval: false, contentDigest: null};
  const candidates = [
    {entryId: 'published', title: 'Published', ordinal: 1, url: 'https://shared.example/', disposition: 'published', stages},
    {entryId: 'cold', title: 'Cold', ordinal: 2, url: 'https://cold.example/', disposition: 'continue', stages},
    {entryId: 'ready', title: 'Ready', ordinal: 3, url: 'https://shared.example/tool', disposition: 'continue',
      stages: {...stages, facts: 'passed', plan: 'three-roles', precopy: true}},
  ].map(candidate => ({...candidate, holds: [], attachments: [], nextGap: 'capture'}));
  const manifestPath = path.join(storageDir, 'snapshots/test.json');
  fs.writeFileSync(manifestPath, JSON.stringify({schemaVersion: 1, intakeId: 'vislexicon-20261014', storageDir,
    inventorySha256: 'test', candidates, files: [], summary: {published: 1}, warnings: []}));
  fs.writeFileSync(path.join(storageDir, 'current.json'), JSON.stringify({manifestPath}));
  const factory = new Factory(project);
  try {
    await factory.boot();
    factory.runtime.start('Existing goal'); factory.runtime.pause();
    const run = factory.state.run.id;
    factory.catalog = candidates.map(candidate => ({id: candidate.entryId, name: candidate.title, canonicalUrl: candidate.url}));
    const pulled = factory.pull(2);
    assert.deepEqual(pulled.map(token => token.item), ['ready', 'cold']);
    assert.equal(factory.state.run.id, run);
    assert.equal(factory.runtime.paused, true);
    assert.equal((pulled[0].data.externalResearch as {entryId: string}).entryId, 'ready');
    assert.equal(factory.pull(2).length, 0);
    const control = new FactoryControl(factory);
    const status = await control.execute('external_intake', {action: 'status'});
    assert.equal((status.result as {summary: {published: number}}).summary.published, 1);

    factory.taken.clear();
    assert.deepEqual(factory.pull(10, {candidateIds: ['cold', 'published']}).map(token => token.item), ['cold'],
      'an exact cohort excludes ready unrelated work and never re-admits saved main entries');
    factory.taken.clear();
    let sourceClaims = 0;
    factory.sources.admitManaged = () => {sourceClaims++; return 1;};
    factory.runtime.executors = () => async () => ({ok: false, summary: 'Isolated admission fixture'});
    const result = await control.execute('run_batch', {action: 'start', target: 500, maxInFlight: 1,
      intakeWindow: 1, candidateIds: ['cold', 'cold']});
    assert.deepEqual(factory.state.batch?.candidateIds, ['cold']);
    assert.equal(factory.state.batch?.runId, run);
    assert.equal(sourceClaims, 0, 'unrelated managed sources cannot take a focused cohort slot');
    assert.ok(result.ok);
  } finally {
    factory.publicationOutbox?.close();
    factory.recovery?.close(); await factory.sources?.close(); factory.channels?.close();
    await factory.runtime?.close(); factory.docs?.flush(); factory.lessons?.close(); factory.journal.close();
    fs.rmSync(project, {recursive: true, force: true});
  }
});

test('draft status never masks an HTTP challenge and is not reused as a successful scout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-challenge-'));
  try {
    const file = path.join(root, 'source.json');
    const bytes = Buffer.from(JSON.stringify({status: 'DRAFT', httpStatus: 403,
      sourceUrl: 'https://challenge.example/', raw: '<title>Just a moment</title>'}));
    fs.writeFileSync(file, bytes);
    const ctx = {node: {key: 'curation/scout'}, token: {url: 'https://challenge.example/', data: {
      externalResearch: {sources: [{path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex')}]},
    }}, signal: new AbortController().signal} as unknown as StationContext;
    let calls = 0;
    await reuseExternalStation(ctx, async () => {calls++; return {ok: true, summary: 'Actual scout'};});
    assert.equal(calls, 1);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});
