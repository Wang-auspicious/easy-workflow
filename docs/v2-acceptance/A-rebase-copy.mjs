// Explicitly approved acceptance preparation. Never run against a live project.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {DatabaseSync, backup} from 'node:sqlite';

const [sourceArgument, copyArgument] = process.argv.slice(2);
if (!sourceArgument || !copyArgument) throw new Error('Usage: node A-rebase-copy.mjs SOURCE_ROOT TEMP_COPY');
const source = path.resolve(sourceArgument);
const copy = fs.realpathSync(copyArgument);
const temporary = fs.realpathSync(os.tmpdir());
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
if (!inside(temporary, copy) || !path.basename(copy).startsWith('ew-v2-copy-') ||
    inside(source, copy) || inside(copy, source)) throw new Error('Only a separate ew-v2-copy directory under TEMP is allowed');
const remap = value => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !inside(source, value)) return value;
  return path.join(copy, path.relative(source, value));
};
let references = 0;
const replace = value => {
  if (typeof value === 'string') {
    const result = remap(value);
    if (result !== value) references++;
    return result;
  }
  if (Array.isArray(value)) return value.map(replace);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
  return value;
};
const walk = directory => !fs.existsSync(directory) ? [] : fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
  if (entry.isSymbolicLink()) throw new Error('Acceptance copy must not contain metadata symlinks');
  const file = path.join(directory, entry.name);
  // Content-addressed objects/records remain byte-identical evidence. Their
  // embedded source paths describe provenance, not mutable storage pointers.
  return entry.isDirectory() ? ['objects', 'records'].includes(entry.name) ? [] : walk(file)
    : entry.name.endsWith('.json') ? [file] : [];
});
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const verified = new Set();
const verifyAttachments = value => {
  if (!value || typeof value !== 'object') return;
  if (typeof value.sha256 === 'string' && Number.isSafeInteger(value.bytes)) {
    const candidate = value.recordPath ?? value.path;
    if (typeof candidate === 'string' && (remap(candidate) !== candidate || inside(copy, candidate))) {
      const target = remap(candidate);
      if (!inside(copy, fs.realpathSync(target))) throw new Error('Attachment escapes acceptance copy');
      const key = `${target}:${value.sha256}:${value.bytes}`;
      if (!verified.has(key)) {
        const bytes = fs.readFileSync(target);
        if (bytes.length !== value.bytes || digest(bytes) !== value.sha256) throw new Error('Copied attachment hash mismatch');
        verified.add(key);
      }
    }
  }
  for (const child of Object.values(value)) verifyAttachments(child);
};

const changes = [];
const metadata = [...walk(path.join(copy, 'context', 'external-intake')),
  ...walk(path.join(copy, 'work', 'publication-batches'))];
for (const file of metadata) {
  const original = fs.readFileSync(file, 'utf8');
  const value = JSON.parse(original);
  verifyAttachments(value);
  const before = references;
  const result = replace(value);
  if (references !== before) changes.push({file, original, result: `${JSON.stringify(result, null, 2)}\n`});
}
const metadataReferences = references;
const databaseFile = path.join(copy, 'journal.db');
const reader = new DatabaseSync(databaseFile, {readOnly: true});
const rows = [];
let events;
let backupDirectory;
try {
  const integrity = reader.prepare('PRAGMA quick_check').all();
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('Copy journal integrity check failed');
  events = reader.prepare('SELECT COUNT(*) count FROM events').get().count;
  for (const row of reader.prepare('SELECT seq, body FROM events').iterate()) {
    const before = references;
    const value = JSON.parse(row.body);
    verifyAttachments(value);
    const result = replace(value);
    if (references !== before) rows.push({seq: row.seq, body: JSON.stringify(result)});
  }
  backupDirectory = fs.mkdtempSync(path.join(temporary, 'ew-v2-path-backup-'));
  await backup(reader, path.join(backupDirectory, 'journal.db'));
  for (const change of changes) {
    const destination = path.join(backupDirectory, path.relative(copy, change.file));
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.writeFileSync(destination, change.original, {flag: 'wx'});
  }
} finally {
  reader.close();
}
const writer = new DatabaseSync(databaseFile);
try {
  writer.exec('BEGIN IMMEDIATE');
  const update = writer.prepare('UPDATE events SET body = ? WHERE seq = ?');
  for (const row of rows) update.run(row.body, row.seq);
  if (writer.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='snapshots'").get()) {
    writer.exec('DELETE FROM snapshots');
  }
  for (const change of changes) fs.writeFileSync(change.file, change.result);
  for (const change of changes) verifyAttachments(JSON.parse(change.result));
  if (writer.prepare('SELECT COUNT(*) count FROM events').get().count !== events) throw new Error('Event count changed');
  writer.exec('COMMIT');
} catch (error) {
  writer.exec('ROLLBACK');
  for (const change of changes) fs.writeFileSync(change.file, change.original);
  throw error;
} finally {
  writer.close();
}
const result = {events, metadataFiles: changes.length, metadataReferences,
  journalEvents: rows.length, journalReferences: references - metadataReferences,
  verifiedAttachments: verified.size, backup: path.basename(backupDirectory), snapshotsInvalidated: true};
fs.writeFileSync(path.join(backupDirectory, 'rebase-receipt.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
