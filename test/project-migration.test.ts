import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import {externalIntakeAttachments, importExternalIntake, readExternalIntake} from '../server/external-intake.ts';
const { copyProjectSnapshot } = createRequire(import.meta.url)('../app/project-data.cjs');

function externalFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-external-intake-'));
  const source = path.join(root, 'source');
  const project = path.join(root, 'project');
  const extra = 'docs/verification/extra-200-20261013';
  const continuous = 'docs/verification/continuous-intake-20261014';
  const write = (relative: string, value: unknown) => {
    const file = path.join(source, relative);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  write(`${extra}/selection.json`, {candidates: ['published', 'same-origin-one', 'same-origin-two', 'same-origin-one']
    .map((id, index) => ({selectionOrdinal: index + 1, observation: {
      id, name: id, canonicalUrl: `https://example.test/${id}`,
    }}))});
  const facts = '{ "entryId": "same-origin-one", "facts": {}, "original": "原字节" }\r\n';
  const sha = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
  write(`${extra}/facts-drafts/same-origin-one.json`, facts);
  write(`${extra}/sources/same-origin-one/home.json`, '{ "text": "Original source body", "language": "en" }\r\n');
  write(`${continuous}/lane-b/reviews/same-origin-one.facts-pre-review.json`, {
    factsDraftSha256: sha(facts), verdict: 'pass-for-facts-only',
  });
  write(`${continuous}/lane-b/plans/same-origin-one.json`, {
    pages: ['identity', 'breadth', 'proof'].map(role => ({role, url: `https://example.test/${role}`})),
  });
  write(`${extra}/sync-receipts.jsonl`, `${JSON.stringify({entryId: 'published',
    sourceSynchronized: true, publicProjectionVerified: true, remotePushed: true,
    gitCommit: 'a'.repeat(40), digest: 'b'.repeat(64)})}\n`);
  return {root, source, project, extra, continuous, write, facts, sha};
}

test('external intake preserves raw bytes, exact identities and publication overlap with idempotent imports', () => {
  const fixture = externalFixture();
  try {
    const first = importExternalIntake({sourceRoot: fixture.source, projectDir: fixture.project});
    assert.equal(first.summary.rawObservations, 4);
    assert.equal(first.summary.uniqueEntryIds, 3);
    assert.equal(first.summary.published, 1);
    assert.equal(first.summary.facts, 1);
    assert.equal(first.summary.unpublishedFacts, 1);
    assert.equal(first.summary.continuationCandidates, 2);
    const candidate = first.candidates.find(item => item.entryId === 'same-origin-one')!;
    assert.deepEqual(candidate.observationOrdinals, [2, 4]);
    assert.equal(candidate.stages.facts, 'passed');
    assert.equal(candidate.currentAttachments?.facts?.sourcePath,
      `${fixture.extra}/facts-drafts/same-origin-one.json`);
    assert.equal(candidate.currentAttachments?.plan?.sourcePath,
      `${fixture.continuous}/lane-b/plans/same-origin-one.json`);
    assert.equal(candidate.nextGap, 'capture');
    assert.equal(candidate.stages.currentFiveKindApproval, false);
    assert.equal(first.candidates.find(item => item.entryId === 'published')!.nextGap, 'published');
    const attachments = externalIntakeAttachments(first, 'same-origin-one');
    const copiedFacts = attachments.find(item => item.kind === 'facts')!;
    assert.deepEqual(fs.readFileSync(copiedFacts.path), Buffer.from(fixture.facts));
    assert.equal(attachments.some(item => item.kind === 'source' && item.sourcePath.includes('/sources/')), true);
    const receiptPath = path.join(first.storageDir, 'receipts.jsonl');
    const receipts = fs.readFileSync(receiptPath);
    const second = importExternalIntake({sourceRoot: fixture.source, projectDir: fixture.project});
    assert.equal(second.alreadyPresent, true);
    assert.equal(second.inventorySha256, first.inventorySha256);
    assert.deepEqual(fs.readFileSync(receiptPath), receipts);
    assert.equal(readExternalIntake(fixture.project)!.inventorySha256, first.inventorySha256);
    fs.unlinkSync(path.join(first.storageDir, 'current.json'));
    assert.equal(readExternalIntake(fixture.project), null);
    const recovered = importExternalIntake({sourceRoot: fixture.source, projectDir: fixture.project});
    assert.equal(recovered.alreadyPresent, true);
    assert.equal(readExternalIntake(fixture.project)!.inventorySha256, first.inventorySha256);
    assert.deepEqual(fs.readFileSync(receiptPath), receipts);
    assert.deepEqual(fs.readFileSync(path.join(fixture.source, fixture.extra, 'facts-drafts/same-origin-one.json')),
      Buffer.from(fixture.facts));
  } finally { fs.rmSync(fixture.root, {recursive: true, force: true}); }
});

test('external intake never promotes stale facts reviews or two screenshots and retains prior snapshots', () => {
  const fixture = externalFixture();
  try {
    const first = importExternalIntake({sourceRoot: fixture.source, projectDir: fixture.project});
    fixture.write(`${fixture.extra}/facts-drafts/same-origin-one.json`, `${fixture.facts} `);
    fixture.write(`${fixture.continuous}/lane-b/plans/same-origin-one.before-current.json`,
      {pages: [{role: 'identity', url: 'https://example.test/stale-page'}]});
    fixture.write(`${fixture.continuous}/lane-b/materials/same-origin-one.precopy-before-current.json`,
      {editorial: {descriptionZh: 'Old copy'}});
    fixture.write(`${fixture.continuous}/lane-b/materials/same-origin-one.precopy.json`,
      {editorial: {descriptionZh: 'Current copy'}});
    const pages = ['identity', 'breadth'].map(role => {
      const bytes = `${role} image bytes`;
      fixture.write(`${fixture.extra}/captures/same-origin-one/${role}.webp`, bytes);
      return {role, file: `${role}.webp`, shot: {sha256: fixture.sha(bytes)}, issues: []};
    });
    fixture.write(`${fixture.extra}/captures/same-origin-one/observation.json`, {pages});
    fixture.write(`${fixture.continuous}/lane-b/drafts/same-origin-one.json`, {digest: 'c'.repeat(64)});
    const second = importExternalIntake({sourceRoot: fixture.source, projectDir: fixture.project});
    const candidate = second.candidates.find(item => item.entryId === 'same-origin-one')!;
    assert.equal(candidate.stages.facts, 'pending');
    assert.equal(candidate.currentAttachments?.plan?.sourcePath,
      `${fixture.continuous}/lane-b/plans/same-origin-one.json`);
    assert.equal(candidate.currentAttachments?.precopy?.sourcePath,
      `${fixture.continuous}/lane-b/materials/same-origin-one.precopy.json`);
    assert.deepEqual(candidate.stages.capturedRoles, ['identity', 'breadth']);
    assert.equal(candidate.stages.currentFiveKindApproval, false);
    assert.equal(candidate.nextGap, 'facts-review');
    assert.equal(fs.existsSync(first.manifestPath), true);
    assert.notEqual(second.inventorySha256, first.inventorySha256);
    const attachment = externalIntakeAttachments(second, 'same-origin-one')[0];
    fs.writeFileSync(attachment.path, 'changed imported artifact');
    assert.throws(() => externalIntakeAttachments(second, 'same-origin-one'), /integrity failure/);
  } finally { fs.rmSync(fixture.root, {recursive: true, force: true}); }
});

test('external intake rejects source-nested targets and does not commit a moving source snapshot', t => {
  const fixture = externalFixture();
  try {
    assert.throws(() => importExternalIntake({sourceRoot: fixture.source,
      projectDir: path.join(fixture.source, 'nested')}), /outside its source/);
    const read = fs.readFileSync;
    let changed = false;
    const target = path.join(fixture.source, fixture.extra, 'selection.json');
    t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
      const result = read(...args);
      if (!changed && String(args[0]) === target) {
        changed = true;
        fixture.write(`${fixture.extra}/sources/late.json`, {newObservation: true});
      }
      return result;
    });
    assert.throws(() => importExternalIntake({sourceRoot: fixture.source,
      projectDir: fixture.project}), /inventory changed/);
    assert.equal(readExternalIntake(fixture.project), null);
  } finally { t.mock.restoreAll(); fs.rmSync(fixture.root, {recursive: true, force: true}); }
});

test('external intake accepts original observation.url and keeps the latest exact capture queue status', () => {
  const fixture = externalFixture();
  try {
    fixture.write(`${fixture.extra}/selection.json`, {candidates: [{selectionOrdinal: 1,
      observation: {id: 'same-origin-one', name: 'Original URL shape',
        url: 'https://example.test/original-entry?variant=one'}}]});
    fixture.write(`${fixture.continuous}/lane-a/capture-status.json`, {
      updatedAt: '2026-10-14T20:00:00Z', entries: [{entryId: 'same-origin-one',
        status: 'plan-ready-awaiting-camera', blockers: ['Earlier queue entry']}],
    });
    fixture.write(`${fixture.continuous}/lane-b/capture-status.json`, {
      updatedAt: '2026-10-14T21:00:00Z', entries: [{entryId: 'same-origin-one',
        status: 'capture-held-private-evidence', blockers: [],
        roles: [{role: 'proof', status: 'capture-held', reason: 'Actual stage timeout'}]},
      {entryId: 'same-origin-two', status: 'plan-ready-awaiting-camera', blockers: []}],
    });
    const result = importExternalIntake({sourceRoot: fixture.source, projectDir: fixture.project});
    assert.equal(result.candidates[0].url, 'https://example.test/original-entry?variant=one');
    assert.equal(result.candidates[0].captureStatus, 'capture-held-private-evidence');
    assert.deepEqual(result.candidates[0].captureBlockers, ['proof: Actual stage timeout']);
    assert.match(result.manifestPath, /\.v3\.json$/);
    fixture.write(`${fixture.extra}/selection.json`, {candidates: [{selectionOrdinal: 1,
      observation: {id: 'same-origin-one', url: 'javascript:alert(1)'}}]});
    assert.throws(() => importExternalIntake({sourceRoot: fixture.source, projectDir: fixture.project}),
      /valid HTTP URL: same-origin-one/);
    assert.equal(readExternalIntake(fixture.project)!.inventorySha256, result.inventorySha256);
  } finally {fs.rmSync(fixture.root, {recursive: true, force: true});}
});

test('project migration preserves source, includes uncheckpointed WAL and refuses overwrite', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-project-copy-'));
  const source = path.join(root, 'old'), destination = path.join(root, 'new');
  fs.mkdirSync(path.join(source, 'published'), { recursive: true });
  const artifact = Buffer.from('{"entryId":"kept"}\n');
  fs.writeFileSync(path.join(source, 'published', 'kept.json'), artifact);
  const db = new DatabaseSync(path.join(source, 'journal.db'));
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE events(seq INTEGER PRIMARY KEY, event TEXT); INSERT INTO events(event) VALUES (\'published\')');
    const receipt = await copyProjectSnapshot(source, destination);
    assert.deepEqual(fs.readFileSync(path.join(source, 'published', 'kept.json')), artifact);
    assert.deepEqual(fs.readFileSync(path.join(destination, 'published', 'kept.json')), artifact);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n, 1);
    const copied = new DatabaseSync(path.join(destination, 'journal.db'), { readOnly: true });
    try { assert.equal(copied.prepare('SELECT event FROM events').get()!.event, 'published'); } finally { copied.close(); }
    assert.equal(receipt.sourcePreserved, true);
    assert.equal(receipt.consistency.sourceFilesRechecked, true);
    await assert.rejects(copyProjectSnapshot(source, destination), /already exists/);
    await assert.rejects(copyProjectSnapshot(source, path.join(source, 'nested')), /separate project/);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('migration rejects a live source commit made during artifact copying and removes only its staging directory', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-copy-live-'));
  const source = path.join(root, 'source'), destination = path.join(root, 'new');
  fs.mkdirSync(path.join(source, 'evidence'), { recursive: true });
  const kept = path.join(source, 'evidence', 'existing.txt'), added = path.join(source, 'evidence', 'new.txt');
  fs.writeFileSync(kept, 'existing evidence');
  const untouched = path.join(root, 'unrelated'); fs.mkdirSync(untouched); fs.writeFileSync(path.join(untouched, 'keep.txt'), 'user data');
  const writer = new DatabaseSync(path.join(source, 'journal.db'));
  writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE events(seq INTEGER PRIMARY KEY, event TEXT); INSERT INTO events(event) VALUES ('existing.txt')");
  const copy = fs.copyFileSync;
  let changed = false;
  const intercept = t.mock.method(fs, 'copyFileSync', (from: fs.PathLike, to: fs.PathLike, flags?: number) => {
    copy(from, to, flags);
    if (!changed && String(from) === kept) {
      changed = true;
      fs.writeFileSync(added, 'new evidence from the still-running source');
      writer.prepare('INSERT INTO events(event) VALUES (?)').run('new.txt');
    }
  });
  try {
    await assert.rejects(copyProjectSnapshot(source, destination), /journal updated/);
    assert.equal(changed, true);
    assert.equal(writer.prepare('SELECT COUNT(*) AS n FROM events').get()!.n, 2);
    assert.equal(fs.readFileSync(added, 'utf8'), 'new evidence from the still-running source');
    assert.equal(fs.readFileSync(kept, 'utf8'), 'existing evidence');
    assert.equal(fs.readFileSync(path.join(untouched, 'keep.txt'), 'utf8'), 'user data');
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.easy-workflow-import-')), []);
  } finally { intercept.mock.restore(); writer.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('migration rechecks file inventory and previously copied bytes even without a journal write', async (t) => {
  for (const change of ['add', 'remove', 'overwrite'] as const) await t.test(change, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-copy-files-'));
    const source = path.join(root, 'source'), destination = path.join(root, 'new');
    fs.mkdirSync(source);
    const first = path.join(source, 'a.txt'), last = path.join(source, 'z.txt');
    fs.writeFileSync(first, 'old'); fs.writeFileSync(last, 'stable');
    const db = new DatabaseSync(path.join(source, 'journal.db'));
    db.exec('CREATE TABLE events(seq INTEGER PRIMARY KEY, event TEXT)'); db.close();
    const copy = fs.copyFileSync;
    const intercept = t.mock.method(fs, 'copyFileSync', (from: fs.PathLike, to: fs.PathLike, flags?: number) => {
      copy(from, to, flags);
      if (String(from) === last) {
        if (change === 'add') fs.writeFileSync(path.join(source, 'late.txt'), 'new');
        else if (change === 'remove') fs.unlinkSync(first);
        else fs.writeFileSync(first, 'new');
      }
    });
    try {
      await assert.rejects(copyProjectSnapshot(source, destination), change === 'overwrite' ? /a\.txt/ : /file inventory changed/);
      assert.equal(fs.existsSync(destination), false);
      assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.easy-workflow-import-')), []);
      assert.equal(fs.readFileSync(last, 'utf8'), 'stable');
    } finally { intercept.mock.restore(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});

test('migration detects a source commit during the final file hash pass', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-copy-recheck-'));
  const source = path.join(root, 'source'), destination = path.join(root, 'new');
  fs.mkdirSync(source);
  const file = path.join(source, 'a.txt'); fs.writeFileSync(file, 'unchanged');
  const writer = new DatabaseSync(path.join(source, 'journal.db'));
  writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE events(seq INTEGER PRIMARY KEY, event TEXT)');
  const read = fs.readFileSync;
  let sourceReads = 0;
  const intercept = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    const result = read(...args);
    if (String(args[0]) === file && ++sourceReads === 3) writer.prepare('INSERT INTO events(event) VALUES (?)').run('committed-during-verification');
    return result;
  });
  try {
    await assert.rejects(copyProjectSnapshot(source, destination), /journal updated during file verification/);
    assert.equal(writer.prepare('SELECT COUNT(*) AS n FROM events').get()!.n, 1);
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.easy-workflow-import-')), []);
  } finally { intercept.mock.restore(); writer.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('migration resolves destination junction ancestors before creating directories inside the source', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-copy-junction-'));
  const source = path.join(root, 'source'), alias = path.join(root, 'alias');
  fs.mkdirSync(source);
  const db = new DatabaseSync(path.join(source, 'journal.db'));
  db.exec('CREATE TABLE events(seq INTEGER PRIMARY KEY, event TEXT)'); db.close();
  fs.writeFileSync(path.join(source, 'keep.txt'), 'untouched source');
  try {
    try { fs.symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Directory links are unavailable in this environment'); return; }
      throw error;
    }
    const before = fs.readdirSync(source).sort();
    await assert.rejects(copyProjectSnapshot(source, path.join(alias, 'new-parent', 'destination')), /separate project folders/);
    assert.deepEqual(fs.readdirSync(source).sort(), before);
    assert.equal(fs.readFileSync(path.join(source, 'keep.txt'), 'utf8'), 'untouched source');
    assert.equal(fs.existsSync(path.join(source, 'new-parent')), false);
    assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.easy-workflow-import-')), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('source to first to second migration preserves the original receipt bytes and every inventory hash', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-copy-repeat-'));
  const source = path.join(root, 'source'), first = path.join(root, 'first'), second = path.join(root, 'second');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'PROJECT.md'), '# Kept project\n');
  const db = new DatabaseSync(path.join(source, 'journal.db'));
  db.exec("CREATE TABLE events(seq INTEGER PRIMARY KEY, event TEXT); INSERT INTO events(event) VALUES ('original')"); db.close();
  const sha = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
  try {
    await copyProjectSnapshot(source, first);
    const originalReceipt = fs.readFileSync(path.join(first, 'migration-receipt.json'));
    const receipt = await copyProjectSnapshot(first, second);
    assert.equal(receipt.version, 2);
    assert.equal(receipt.previousReceipt.sourcePath, 'migration-receipt.json');
    assert.equal(receipt.previousReceipt.sha256, sha(originalReceipt));
    assert.match(receipt.previousReceipt.path, /^migration-history\/[0-9a-f]{64}\.json$/);
    assert.deepEqual(fs.readFileSync(path.join(first, 'migration-receipt.json')), originalReceipt);
    assert.deepEqual(fs.readFileSync(path.join(second, receipt.previousReceipt.path)), originalReceipt);
    assert.notDeepEqual(fs.readFileSync(path.join(second, 'migration-receipt.json')), originalReceipt);
    assert.equal(new Set(receipt.files.map((entry: { path: string }) => entry.path)).size, receipt.files.length);
    for (const entry of receipt.files) {
      const copied = fs.readFileSync(path.join(second, entry.path));
      assert.equal(sha(copied), entry.sha256, entry.path);
      assert.equal(copied.length, entry.bytes, entry.path);
      assert.deepEqual(copied, fs.readFileSync(path.join(first, entry.sourcePath)), entry.sourcePath);
    }
    assert.equal(receipt.files.some((entry: { path: string }) => entry.path === 'migration-receipt.json'), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(second, 'migration-receipt.json'), 'utf8')), receipt);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('receipt history chooses an unused path instead of overwriting existing user metadata', async (t) => {
  for (const collision of ['filename', 'directory'] as const) await t.test(collision, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-copy-history-'));
    const source = path.join(root, 'source'), destination = path.join(root, 'destination');
    fs.mkdirSync(source);
    const db = new DatabaseSync(path.join(source, 'journal.db'));
    db.exec('CREATE TABLE events(seq INTEGER PRIMARY KEY, event TEXT)'); db.close();
    const oldReceipt = Buffer.from('{ "version": 1, "original": "bytes and whitespace preserved" }\r\n');
    const oldHash = crypto.createHash('sha256').update(oldReceipt).digest('hex');
    fs.writeFileSync(path.join(source, 'migration-receipt.json'), oldReceipt);
    const existingPath = collision === 'filename' ? path.join('migration-history', `${oldHash}.json`) : 'migration-history';
    fs.mkdirSync(path.dirname(path.join(source, existingPath)), { recursive: true });
    fs.writeFileSync(path.join(source, existingPath), 'existing user metadata');
    try {
      const receipt = await copyProjectSnapshot(source, destination);
      assert.notEqual(receipt.previousReceipt.path, existingPath.split(path.sep).join('/'));
      assert.deepEqual(fs.readFileSync(path.join(destination, receipt.previousReceipt.path)), oldReceipt);
      assert.equal(fs.readFileSync(path.join(destination, existingPath), 'utf8'), 'existing user metadata');
      assert.equal(fs.readFileSync(path.join(source, existingPath), 'utf8'), 'existing user metadata');
      for (const entry of receipt.files) {
        const copied = fs.readFileSync(path.join(destination, entry.path));
        assert.equal(crypto.createHash('sha256').update(copied).digest('hex'), entry.sha256, entry.path);
        assert.deepEqual(copied, fs.readFileSync(path.join(source, entry.sourcePath)), entry.sourcePath);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
