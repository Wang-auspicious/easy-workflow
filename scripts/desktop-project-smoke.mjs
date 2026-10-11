// Real Electron menu callbacks and native WebContentsView station tools, no models.
import { _electron as electron } from 'playwright-core';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-project-menu-'));
const executablePath = process.argv.find(a => a.startsWith('--exe='))?.slice(6) ?? createRequire(import.meta.url)('electron');
const appRoot = process.argv.find(a => a.startsWith('--app='))?.slice(6) ?? root;
const packaged = process.argv.includes('--packaged');
const env = { ...process.env, FACTORY_PROFILE: profile, FACTORY_DESKTOP_TEST: '1', FACTORY_DISCOVERY: '0', FACTORY_PREFLIGHT: '0', FACTORY_MINIMIZED: '1', VISLEXICON_ROOT: path.join(profile, 'unconnected') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'FACTORY_VIEW_VAR', 'FACTORY_PROJECT', 'FACTORY_STATION_COMMAND']) delete env[key];
const checks = [];
const fixture = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Easy Workflow desktop toolbox</title><nav><a href="/nav">Navigation</a></nav><main><h1>Fixture</h1><p id="dynamic"></p><canvas width="160" height="100"></canvas><script>document.getElementById("dynamic").textContent="Rendered fixture content"</script></main>'); });
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const fixtureURL = `http://127.0.0.1:${fixture.address().port}`;
let app, probe;
async function launch() {
  const instance = await electron.launch({ executablePath, args: packaged ? [] : [appRoot], env, timeout: 60000 });
  const page = await instance.firstWindow();
  await page.waitForFunction(() => Boolean(window.desktop), { timeout: 30000 });
  return instance;
}
const info = async () => (await app.firstWindow()).evaluate(() => window.desktop.info());
async function switched(before) {
  let url;
  for (let i = 0; i < 400; i++) {
    url = await app.evaluate(() => globalThis.__factoryDesktop().url);
    if (url !== before) break;
    if (i === 399) throw new Error('Project backend did not switch');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const page = await app.firstWindow();
  await page.waitForFunction(expected => location.origin === expected && Boolean(window.desktop) && document.readyState !== 'loading', url, { timeout: 30000 });
}
async function call(name, args = {}) {
  return (await app.firstWindow()).evaluate(async ({ name, args }) => {
    const response = await fetch('/api/tools/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
    const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body.result;
  }, { name, args });
}
async function menu(label, destination) {
  const before = await app.evaluate(() => globalThis.__factoryDesktop().url);
  await app.evaluate(async ({ Menu, dialog, shell }, { label, destination }) => {
    const root = Menu.getApplicationMenu().items.find(item => item.label === '项目');
    const originalSave = dialog.showSaveDialog, originalOpen = dialog.showOpenDialog, originalReveal = shell.openPath;
    if (destination) {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
    }
    shell.openPath = async dir => { globalThis.__revealedProject = dir; return ''; };
    try { await root.submenu.items.find(item => item.label === label).click(); }
    finally { dialog.showSaveDialog = originalSave; dialog.showOpenDialog = originalOpen; shell.openPath = originalReveal; }
  }, { label, destination });
  if (destination) await switched(before);
}
try {
  app = await launch();
  const defaultProject = path.join(profile, 'projects', 'vislexicon-curation');
  assert.equal((await info()).workspace, defaultProject);
  assert.ok(fs.existsSync(path.join(defaultProject, 'PROJECT.md')));
  await call('note_context', { station: 'curation/reader', kind: 'instruction', text: 'Default-project-only instruction' });
  const next = path.join(profile, 'projects', 'second');
  await menu('新建项目…', next);
  assert.equal((await info()).workspace, next);
  assert.ok(fs.existsSync(path.join(next, 'PROJECT.md')));
  assert.ok(!JSON.stringify(await call('read_context', { station: 'curation/reader' })).includes('Default-project-only instruction'));
  await call('note_context', { station: 'curation/reader', kind: 'instruction', text: 'Second-project-only instruction' });
  await menu('打开项目…', defaultProject);
  assert.equal((await info()).workspace, defaultProject);
  const originalContext = JSON.stringify(await call('read_context', { station: 'curation/reader' }));
  assert.ok(originalContext.includes('Default-project-only instruction'));
  assert.ok(!originalContext.includes('Second-project-only instruction'));
  const beforeRecent = await app.evaluate(() => globalThis.__factoryDesktop().url);
  await app.evaluate(async ({ Menu }, destination) => {
    const projects = Menu.getApplicationMenu().items.find(item => item.label === '项目');
    const recent = projects.submenu.items.find(item => item.label === '最近项目');
    const entry = recent.submenu.items.find(item => item.label.includes(destination));
    if (!entry) throw new Error('New project missing from recent menu');
    await entry.click();
  }, next);
  await switched(beforeRecent);
  assert.equal((await info()).workspace, next);
  await menu('在资源管理器中显示');
  assert.equal(await app.evaluate(() => globalThis.__revealedProject), next);
  checks.push('create/open/recent/reveal menus use the selected folder', 'project journal and CONTEXT are isolated');
  await app.close(); app = await launch();
  assert.equal((await info()).workspace, next);
  assert.ok(JSON.stringify(await call('read_context', { station: 'curation/reader' })).includes('Second-project-only instruction'));
  checks.push('selected project and its context survive restart');
  const nativeResult = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Desktop toolbox probe timed out')), 70000);
    probe = fork(path.join(root, 'scripts', 'desktop-toolbox-probe.mjs'), [fixtureURL], { cwd: root, env: { ...process.env, FACTORY_BROWSER_BRIDGE: '1', FACTORY_VAR: next }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '';
    probe.stderr.on('data', chunk => { output += chunk; });
    probe.on('error', error => { clearTimeout(timer); reject(error); });
    probe.on('exit', code => { if (code) { clearTimeout(timer); reject(new Error(`Probe exit ${code}: ${output}`)); } });
    probe.on('message', async message => {
      if (message.type === 'browser:request') {
        try { const result = await app.evaluate((_, args) => globalThis.__factoryBrowser(args), message.args); if (probe.connected) probe.send({ type: 'browser:reply', id: message.id, result }); }
        catch (error) { if (probe.connected) probe.send({ type: 'browser:reply', id: message.id, error: error.message }); }
      } else if (message.type === 'probe:result') { clearTimeout(timer); resolve(message.result); }
      else if (message.type === 'probe:error') { clearTimeout(timer); reject(new Error(message.error)); }
    });
  });
  assert.equal(nativeResult.text.ok, true);
  assert.equal(nativeResult.text.via, 'browser');
  assert.match(nativeResult.text.text, /Rendered fixture content/);
  assert.ok(nativeResult.text.links.some(link => link.region === 'nav'));
  assert.equal(nativeResult.text.media.canvases, 1);
  assert.equal(nativeResult.found.ok, true);
  assert.ok(nativeResult.found.hits.some(hit => hit.snippet.includes('Rendered fixture content')));
  assert.equal(nativeResult.resources.used.browser, 0);
  checks.push('page_text/page_find use a leased native WebContentsView and rendered DOM', 'tool leases release after both calls');
  const artifact = path.join(root, 'artifacts', 'desktop-projects'); fs.mkdirSync(artifact, { recursive: true });
  const result = { ok: true, profile, appRoot, executablePath, checks, at: new Date().toISOString() };
  fs.writeFileSync(path.join(artifact, 'smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (probe?.exitCode === null) { if (probe.connected) probe.disconnect(); probe.kill(); }
  if (app) await app.close().catch(() => {});
  fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
}
