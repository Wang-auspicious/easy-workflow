import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {_electron as electron} from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const project = fs.realpathSync(process.argv[2]);
const temporary = fs.realpathSync(os.tmpdir());
if (!project.startsWith(temporary + path.sep) || !path.basename(project).startsWith('ew-v2-copy-')) {
  throw new Error('Benchmark requires the approved temporary project copy');
}
const cold = process.argv.includes('--cold');
const count = cold ? 1 : 3;
const before = new DatabaseSync(path.join(project, 'journal.db'));
const events = before.prepare('SELECT COUNT(*) count FROM events').get().count;
if (cold) before.exec('DELETE FROM snapshots');
before.close();
const samples = [];
const executablePath = createRequire(import.meta.url)('electron');
for (let run = 1; run <= count; run++) {
  const profile = fs.mkdtempSync(path.join(temporary, 'ew-v2-desktop-A-'));
  const log = path.join(profile, 'logs', 'startup.log');
  const output = path.join(profile, 'logs', 'desktop.log');
  const env = {...process.env, FACTORY_PROJECT: project, FACTORY_PROFILE: profile,
    FACTORY_DESKTOP_TEST: '1', FACTORY_PREFLIGHT: '0', FACTORY_DISCOVERY: '0',
    FACTORY_MINIMIZED: '1'};
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.FACTORY_VIEW_VAR;
  const started = performance.now();
  let instance;
  try {
    instance = await electron.launch({executablePath, args: [path.join(root, 'dist', 'desktop')],
      env, timeout: 180000});
    let ready;
    let lifecycle = [];
    while (!ready) {
      if (fs.existsSync(log)) {
        const rows = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        lifecycle = rows;
        const failure = rows.find(row => row.phase === 'failure');
        if (failure) throw new Error(`Desktop failed: ${failure.reason}`);
        ready = rows.find(row => row.phase === 'ready');
      }
      if (!ready) {
        if (performance.now() - started > 190000) throw new Error('Desktop readiness wait expired');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    const launchToReadyMs = Math.round(performance.now() - started);
    const stages = fs.readFileSync(output, 'utf8').split('\n').flatMap(line => {
      const match = /^BOOT_STAGE ([a-z0-9-]+) (\d+)\r?$/.exec(line);
      return match ? [{stage: match[1], ms: Number(match[2])}] : [];
    });
    const receivedStages = lifecycle.filter(row => row.phase === 'stage')
      .map(row => ({stage: row.stage, elapsedMs: row.elapsedMs, durationMs: row.durationMs}));
    samples.push({run, backendReadyMs: ready.elapsedMs, launchToReadyMs, stages, receivedStages});
    console.log(JSON.stringify(samples.at(-1)));
  } finally {
    if (instance) await instance.close();
  }
}
const db = new DatabaseSync(path.join(project, 'journal.db'), {readOnly: true});
const snapshots = db.prepare('SELECT name, MAX(seq) seq FROM snapshots GROUP BY name ORDER BY name').all();
db.close();
const result = {mode: cold ? 'cold-without-cli' : 'warm-after-cli', events, samples, snapshots,
  readyLimitMs: 5000, passed: cold ? snapshots.length === 6 : samples.every(sample => sample.backendReadyMs <= 5000)};
fs.writeFileSync(path.join(root, 'docs', 'v2-acceptance', cold ? 'A-cold.json' : 'A-ready.json'), `${JSON.stringify(result, null, 2)}\n`);
if (!result.passed) process.exitCode = 1;
