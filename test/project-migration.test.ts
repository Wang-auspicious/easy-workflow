import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
const { copyProjectSnapshot } = createRequire(import.meta.url)('../app/project-data.cjs');

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
