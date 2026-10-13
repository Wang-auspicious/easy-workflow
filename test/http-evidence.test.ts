import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from 'node:crypto';
import {EvidenceStore} from '../server/evidence.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test('content-addressed evidence repairs an interrupted file and preserves the damaged bytes for audit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-evidence-repair-'));
  try {
    const store = new EvidenceStore(dir);
    const content = Buffer.from('Complete immutable evidence bytes');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const file = path.join(dir, hash.slice(0, 2), `${hash}.json`);
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, content.subarray(0, 6));
    const saved = store.put(content, 'json');
    assert.equal(saved.file, file);
    assert.deepEqual(fs.readFileSync(file), content);
    const quarantine = fs.readdirSync(path.dirname(file)).find(name => name.includes('.corrupt-'));
    assert.ok(quarantine);
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(file), quarantine)), content.subarray(0, 6));
    const before = fs.statSync(file).mtimeMs;
    assert.equal(store.put(content, 'json').src, saved.src);
    assert.equal(fs.statSync(file).mtimeMs, before, 'valid immutable bytes are reused');
    assert.equal(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp')).length, 0);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('failed evidence replacement preserves the previous file and never returns a partial artifact', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-evidence-disk-'));
  try {
    const store = new EvidenceStore(dir);
    const content = Buffer.from('A complete evidence artifact');
    const stored = store.put(content, 'txt');
    const damaged = Buffer.alloc(content.length, 0);
    fs.writeFileSync(stored.file, damaged);
    const rename = fs.renameSync;
    const fault = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from).endsWith('.tmp')) throw new Error('Fixture disk replacement failed');
      return rename(from, to);
    });
    assert.throws(() => store.put(content, 'txt'), /disk replacement failed/);
    assert.deepEqual(fs.readFileSync(stored.file), damaged);
    assert.equal(fs.readdirSync(path.dirname(stored.file)).filter(name => name.endsWith('.tmp')).length, 0);
    fault.mock.restore();
    assert.equal(store.put(content, 'txt').src, stored.src);
    assert.deepEqual(fs.readFileSync(stored.file), content);
    assert.throws(() => store.put(content, '../escape'), /extension/);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test("evidence video seeking handles suffix, open and unsatisfiable ranges without breaking the server", { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-media-"));
  const dist = path.join(dir, "ui");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "clip.mp4"), "0123456789");
  const child = fork(path.join(root, "server/main.ts"), [], {
    cwd: root, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, FACTORY_VAR: path.join(dir, "project"), FACTORY_LAYOUT: path.join(dir, "layout.json"),
      FACTORY_PORT: "0", FACTORY_TOKEN: "media-test-only", FACTORY_DISCOVERY: "0", FACTORY_PREFLIGHT: "0",
      FACTORY_START_PAUSED: "1", FACTORY_DIST: dist, VISLEXICON_ROOT: path.join(dir, "unconnected") },
  });
  let output = "";
  child.stderr?.on("data", chunk => { output += chunk; });
  child.stdout?.on("data", chunk => { output += chunk; });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 15000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
      child.on("message", (message: { type?: string; url?: string }) => {
        if (message.type === "ready" && message.url) { clearTimeout(timer); resolve(message.url); }
      });
    });
    const request = (range?: string) => fetch(url + "/clip.mp4", { headers: {
      authorization: "Bearer media-test-only", ...(range ? { range } : {}),
    }, signal: AbortSignal.timeout(3000) });
    for (const [range, expected, contentRange] of [
      ["bytes=-4", "6789", "bytes 6-9/10"],
      ["bytes=4-", "456789", "bytes 4-9/10"],
      ["bytes=4-99", "456789", "bytes 4-9/10"],
      ["bytes=0-0", "0", "bytes 0-0/10"],
    ]) {
      const response = await request(range);
      assert.equal(response.status, 206, range);
      assert.equal(response.headers.get("content-range"), contentRange, range);
      assert.equal(await response.text(), expected, range);
    }
    for (const range of ["bytes=10-", "bytes=9-2", "bytes=-0", "bytes=wat", "bytes=999999999999999999999-"]) {
      const response = await request(range);
      assert.equal(response.status, 416, range);
      assert.equal(response.headers.get("content-range"), "bytes */10", range);
      await response.arrayBuffer();
    }
    const multipart = await request("bytes=0-1,4-5");
    assert.equal(multipart.status, 200, "unsupported multipart ranges return the complete representation");
    assert.equal(await multipart.text(), "0123456789");
    const healthy = await fetch(url + "/api/state", { headers: { authorization: "Bearer media-test-only" } });
    assert.equal(healthy.status, 200);
    await healthy.arrayBuffer();
  } finally {
    if (child.exitCode === null) await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill(), 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send({ type: "shutdown" }); else child.kill();
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
