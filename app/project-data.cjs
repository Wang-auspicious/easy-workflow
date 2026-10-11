// A copy-only, consistent project snapshot. Never merge or replace user data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');

function filesUnder(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Project snapshot refuses symbolic links: ${file}`);
    if (entry.isDirectory()) files.push(...filesUnder(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const contains = (parent, child) => child === parent || child.startsWith(parent + path.sep);

// A not-yet-created destination may sit below an existing junction/symlink. Resolve
// its nearest existing ancestor before any directory creation or containment test.
function destinationIdentity(input) {
  let ancestor = path.resolve(input);
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('Destination has no accessible existing ancestor');
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.resolve(fs.realpathSync(ancestor), ...suffix);
}

async function copyProjectSnapshot(sourcePath, destinationPath, options = {}) {
  const source = fs.realpathSync(sourcePath), destination = destinationIdentity(destinationPath);
  const identity = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (contains(identity(source), identity(destination)) || contains(identity(destination), identity(source))) throw new Error('Source and destination must be separate project folders');
  if (fs.existsSync(destination)) throw new Error(`Destination already exists; no files were replaced: ${destination}`);
  const journal = path.join(source, 'journal.db');
  if (!fs.statSync(journal).isFile()) throw new Error('Source project has no journal.db');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(destination), '.easy-workflow-import-'));
  let db;
  try {
    const excluded = options.withoutBrowserSession ? ['browser/'] : [];
    const includedFiles = () => filesUnder(source).filter(file => {
      const relative = path.relative(source, file);
      return !/^journal\.db(?:-wal|-shm|-journal)?$/.test(relative) && !(options.withoutBrowserSession && relative.startsWith('browser' + path.sep));
    }).sort();
    // Hold the same read-only connection across both the files and database copy.
    // SQLite backup alone can be valid while referring to newer evidence that was
    // not present in the initial file list. Refuse such a mixed project snapshot.
    db = new DatabaseSync(journal, { readOnly: true });
    const version = () => db.prepare('PRAGMA data_version').get().data_version;
    const sourceVersion = version();
    const files = includedFiles();
    const inventory = [];
    const archiveReceipt = sha256 => {
      let folder = 'migration-history', folderIndex = 0;
      while (fs.existsSync(path.join(source, folder)) && !fs.statSync(path.join(source, folder)).isDirectory()) folder = `migration-history-${++folderIndex}`;
      let relative = path.join(folder, `${sha256}.json`), index = 0;
      while (fs.existsSync(path.join(source, relative)) || fs.existsSync(path.join(stage, relative))) relative = path.join(folder, `${sha256}-${++index}.json`);
      return relative;
    };
    for (const file of files) {
      const relative = path.relative(source, file);
      const sha256 = hash(file);
      // The new receipt owns the root filename. Preserve a source receipt as exact
      // historical bytes, with separate source/target paths in the new inventory.
      const copiedRelative = identity(relative) === 'migration-receipt.json' ? archiveReceipt(sha256) : relative;
      const target = path.join(stage, copiedRelative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
      if (hash(target) !== sha256 || hash(file) !== sha256) throw new Error(`Source changed while copying: ${relative}`);
      inventory.push({ path: copiedRelative.split(path.sep).join('/'), sourcePath: relative.split(path.sep).join('/'), bytes: fs.statSync(target).size, sha256 });
    }
    await backup(db, path.join(stage, 'journal.db'));
    if (version() !== sourceVersion) throw new Error('Source project changed during migration: journal updated; stop its running service and retry');
    const finalFiles = includedFiles();
    if (files.length !== finalFiles.length || files.some((file, index) => file !== finalFiles[index])) throw new Error('Source project changed during migration: file inventory changed; stop its running service and retry');
    for (const entry of inventory) {
      const file = path.join(source, entry.sourcePath);
      if (fs.statSync(file).size !== entry.bytes || hash(file) !== entry.sha256) throw new Error(`Source project changed during migration: ${entry.sourcePath}; stop its running service and retry`);
    }
    // A writer can commit while the (potentially large) second hash pass runs.
    if (version() !== sourceVersion) throw new Error('Source project changed during migration: journal updated during file verification; stop its running service and retry');
    db.close(); db = undefined;
    const snapshot = new DatabaseSync(path.join(stage, 'journal.db'), { readOnly: true });
    let tables;
    try {
      const check = snapshot.prepare('PRAGMA quick_check').all();
      if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') throw new Error('Copied journal failed SQLite integrity check');
      tables = snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => ({ name, rows: snapshot.prepare(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`).get().count }));
    } finally { snapshot.close(); }
    const prior = inventory.find(entry => identity(entry.sourcePath) === 'migration-receipt.json');
    const receipt = { version: 2, copiedAt: new Date().toISOString(), source, destination, method: 'copy-files-and-sqlite-backup', sourcePreserved: true, consistency: { sourceDataVersion: sourceVersion, sourceFilesRechecked: true }, excluded, previousReceipt: prior ? { sourcePath: prior.sourcePath, path: prior.path, sha256: prior.sha256 } : null, files: inventory, journal: { sha256: hash(path.join(stage, 'journal.db')), tables } };
    // Project manifests are not rewritten: ensureProject resolves the current folder.
    // The generated root receipt is metadata about this copy, not a copied source
    // file, so it cannot appear in its own content-hashed inventory.
    fs.writeFileSync(path.join(stage, 'migration-receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
    if (fs.existsSync(destination)) throw new Error('Destination was created during import; refusing to replace it');
    fs.renameSync(stage, destination);
    return receipt;
  } finally {
    db?.close();
    // Only the resolved staging folder we created is ever removed.
    const boundary = path.resolve(path.dirname(destination));
    if (fs.existsSync(stage) && path.resolve(stage).startsWith(boundary + path.sep) && path.basename(stage).startsWith('.easy-workflow-import-')) fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { copyProjectSnapshot };
