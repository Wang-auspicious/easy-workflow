import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('Pi installer keeps one active adapter and protects unrelated extensions', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-install-'));
  const extensions = path.join(profile, 'extensions'); fs.mkdirSync(extensions);
  const canonical = path.join(extensions, 'easy-workflow.ts'), legacy = path.join(extensions, 'h2-factory.ts');
  const run = () => spawnSync(process.execPath, ['scripts/install-pi.mjs'], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: profile }, encoding: 'utf8' });
  try {
    assert.equal(run().status, 0);
    assert.ok(fs.existsSync(canonical));
    assert.match(fs.readFileSync(canonical, 'utf8'), /easy_workflow_help/);
    fs.renameSync(canonical, legacy);
    assert.equal(run().status, 0);
    assert.equal(fs.existsSync(canonical), false, 'upgrade the existing adapter without loading a second entry');
    fs.copyFileSync(legacy, canonical);
    assert.equal(run().status, 0);
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(fs.readdirSync(extensions).filter(file => file.endsWith('.ts')).length, 1);
    fs.writeFileSync(legacy, '// user-owned unrelated plugin\n');
    const before = fs.readFileSync(canonical);
    assert.notEqual(run().status, 0);
    assert.deepEqual(fs.readFileSync(canonical), before);
    assert.equal(fs.readFileSync(legacy, 'utf8'), '// user-owned unrelated plugin\n');
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});
