import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import {EventEmitter} from "node:events";
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const { PRODUCT_NAME, userDataDirectory, projectLocations, activeProjectDirectory, recentProjectDirectories } = createRequire(import.meta.url)("../app/branding.cjs");

test("canonical and legacy workflow tools render the same Chinese labels", async () => {
  const { renderTool } = await import(new URL("../ui/src/vendor/pi-web-ui/tools/index.js", import.meta.url).href);
  for (const name of ["easy_workflow_call", "h2_call"]) {
    assert.ok(renderTool(name, { name: "status" }, undefined, true).content.values.includes("查看运行状态"), name);
    assert.ok(renderTool(name, { name: "read_report" }, undefined, true).content.values.includes("读取报告"), name);
    assert.ok(renderTool(name, {}, undefined, true).content.values.includes("调用 Easy Workflow"), name);
    assert.ok(renderTool(name, { name: "custom_capability" }, undefined, true).content.values.includes("调用 Easy Workflow · custom_capability"), name);
  }
  for (const name of ["easy_workflow_help", "h2_help"]) {
    assert.ok(renderTool(name, { name: "status" }, undefined, true).content.values.includes("了解能力 · 查看运行状态"), name);
    assert.ok(renderTool(name, {}, undefined, true).content.values.includes("了解能力"), name);
  }
});

// Exercise the actual Electron entry point through its app-ready and child-IPC
// boundaries; no real window, backend, project, or wall-clock wait is created.
function desktopStartupFixture(ownsLock = true, pauseMigration = false) {
  let clock = 0, nextTimer = 0, windows = 0, kills = 0, quits = 0;
  let forks = 0, unlinks = 0, exits = 0, loading = 0, visible = 0, attached = false;
  const attachmentAtFork: boolean[] = [];
  const errors: string[] = [];
  let finishMigration!: () => void, closeTabs: unknown;
  const migration = new Promise<void>(resolve => {finishMigration = resolve;});
  const exitSignal = new Error('fixture immediate exit');
  const timers = new Map<number, {at: number; run: () => void}>();
  const logs: {file: string; text: string}[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 123, connected: true, exitCode: null,
    stdout: Object.assign(new EventEmitter(), {pipe() {}}), stderr: {pipe() {}},
    send() {}, kill() {kills++; child.emit('exit', null); return true;},
  });
  const webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler() {}, loadURL: async () => {},
  });
  const browserSession = {setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    cookies: {set: async () => {}, flushStore: async () => {}}};
  const app = Object.assign(new EventEmitter(), {
    getPath: (name: string) => `/isolated/${name}`, setPath() {}, setName() {},
    commandLine: {appendSwitch() {}}, requestSingleInstanceLock: () => ownsLock,
    whenReady: () => Promise.resolve(), quit() {quits++;}, isPackaged: true,
    exit() {exits++; throw exitSignal;},
  });
  const imports: Record<string, unknown> = {
    electron: {app, BrowserWindow: class extends EventEmitter {
      webContents = webContents;
      constructor() {super(); windows++;}
      async loadURL() {} async loadFile() {loading++;} setTitle() {} show() {visible++;} minimize() {}
    }, Menu: {buildFromTemplate: () => [], setApplicationMenu() {}},
    ipcMain: {handle() {}}, dialog: {showErrorBox(_title: string, message: string) {errors.push(message);}},
    session: {defaultSession: browserSession, fromPartition: () => browserSession}, shell: {}},
    'node:child_process': {fork: () => {forks++; attachmentAtFork.push(attached); return child;}},
    'node:fs': {mkdirSync() {}, unlinkSync() {unlinks++;}, existsSync: () => true,
      readFileSync: () => '{}', createWriteStream: () => ({end() {}}),
      appendFileSync: (file: string, text: string) => logs.push({file, text})},
    'node:path': path,
    'node:crypto': {randomBytes: () => ({toString: () => 'PRIVATE_AUTH_TOKEN'})},
    './browser-manager.cjs': {BrowserManager: class {
      data = {tabs: [{url: 'https://saved-tab.test'}]};
      async migrate() {if (pauseMigration) await migration;}
      attach() {attached = true;} create() {} setBounds() {}
      async close(options: {savedTabs?: unknown}) {closeTabs = options.savedTabs;}
    }},
    './project-data.cjs': {copyProjectSnapshot: async () => {}},
    './branding.cjs': {PRODUCT_NAME: 'Test Workflow', userDataDirectory: () => '/isolated/profile',
      projectLocations: () => ({defaultProject: '/isolated/project'}),
      activeProjectDirectory: () => '/isolated/project', recentProjectDirectories: () => []},
  };
  const context = vm.createContext({require: (name: string) => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected desktop dependency: ${name}`);
    return imports[name];
  }, __dirname: '/isolated/app', process: {env: {}, execPath: '/isolated/electron'},
  Date, performance: {now: () => clock},
  setTimeout: (run: () => void, ms: number) => {const id = ++nextTimer; timers.set(id, {at: clock + ms, run}); return id;},
  clearTimeout: (id: number) => timers.delete(id)});
  try {vm.runInContext(fs.readFileSync(new URL('../app/main.cjs', import.meta.url), 'utf8'), context);}
  catch (error) {if (error !== exitSignal) throw error;}
  const flush = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};
  return {child, flush, advance: async (ms: number) => {
    const through = clock + ms;
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= through).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      clock = due[1].at; timers.delete(due[0]); due[1].run(); await flush();
    }
    clock = through; await flush();
  }, ready: () => child.emit('message', {type: 'ready', url: 'http://127.0.0.1:4321', private: 'PRIVATE_CDP_VALUE'}),
  state: () => ({windows, kills, quits, timers: timers.size}),
  initialization: () => ({forks, unlinks, exits, loading, visible, attachmentAtFork}),
  close: () => app.emit('before-quit', {preventDefault() {}}), errors,
  finishMigration, closedTabs: () => closeTabs === undefined ? undefined : JSON.parse(JSON.stringify(closeTabs)),
  startup: () => logs.filter(log => log.file.endsWith('startup.log')).map(log => JSON.parse(log.text)),
  logText: () => logs.filter(log => log.file.endsWith('startup.log')).map(log => log.text).join('')};
}

test('a duplicate desktop launch exits before touching the active debugger file or starting another backend', async () => {
  const fixture = desktopStartupFixture(false); await fixture.flush();
  assert.deepEqual(fixture.initialization(), {forks: 0, unlinks: 0, exits: 1, loading: 0, visible: 0, attachmentAtFork: []});
  assert.equal(fixture.state().windows, 0);
});

test('desktop shows its recovery window and attaches the browser before backend recovery begins', async () => {
  const fixture = desktopStartupFixture(); await fixture.flush();
  assert.equal(fixture.state().windows, 1);
  assert.equal(fixture.initialization().loading, 1);
  assert.equal(fixture.initialization().visible, 1);
  assert.deepEqual(fixture.initialization().attachmentAtFork, [true]);
  fixture.ready(); await fixture.flush();
});

test('closing the recovery window cancels startup without showing a false failure dialog', async () => {
  const fixture = desktopStartupFixture(); await fixture.flush();
  fixture.close(); fixture.child.emit('exit', 0); await fixture.flush();
  await fixture.advance(180000);
  assert.deepEqual(fixture.errors, []);
  assert.equal(fixture.state().timers, 0);
  assert.equal(fixture.state().kills, 0);
  assert.ok(fixture.state().quits > 0);
  assert.deepEqual(fixture.closedTabs(), [{url: 'https://saved-tab.test'}]);
});

test('quitting while browser migration is pending cannot fork an orphan backend afterwards', async () => {
  const fixture = desktopStartupFixture(true, true); await fixture.flush();
  fixture.close(); await fixture.flush(); fixture.finishMigration(); await fixture.flush();
  assert.equal(fixture.initialization().forks, 0);
  assert.equal(fixture.state().windows, 0);
  assert.deepEqual(fixture.closedTabs(), [{url: 'https://saved-tab.test'}]);
  assert.deepEqual(fixture.errors, []);
});

test('desktop shutdown lets a large final snapshot finish and still bounds a hung backend', async () => {
  const completing = desktopStartupFixture();
  await completing.flush();
  completing.ready();
  await completing.flush();
  completing.close();
  await completing.advance(40000);
  assert.equal(completing.state().kills, 0, 'a final snapshot may take longer than the old 3.5-second allowance');
  assert.equal(completing.state().quits, 0, 'the desktop waits for the backend to finish its durable cleanup');
  completing.child.emit('exit', 0);
  await completing.flush();
  assert.equal(completing.state().kills, 0);
  assert.equal(completing.state().timers, 0);
  assert.ok(completing.state().quits > 0);

  const hung = desktopStartupFixture();
  await hung.flush();
  hung.ready();
  await hung.flush();
  hung.close();
  await hung.advance(179999);
  assert.equal(hung.state().kills, 0);
  await hung.advance(1);
  assert.equal(hung.state().kills, 1);
  assert.equal(hung.state().timers, 0);
  assert.ok(hung.state().quits > 0, 'shutdown cannot wait forever for an unresponsive backend');
});

test('desktop startup accepts normal and slower cold recovery while keeping its window visible', async () => {
  for (const delay of [31000, 0, 59000, 75000]) {
    const fixture = desktopStartupFixture(); await fixture.flush();
    let elapsed = 0;
    while (elapsed + 25000 < delay) {
      await fixture.advance(25000);
      fixture.child.stdout.emit('data', 'BOOT_STAGE replay 25000\n');
      elapsed += 25000;
    }
    await fixture.advance(delay - elapsed);
    assert.equal(fixture.state().kills, 0, `A backend still booting at ${delay}ms must remain alive`);
    fixture.ready(); await fixture.flush();
    assert.deepEqual(fixture.state(), {windows: 1, kills: 0, quits: 0, timers: 0});
    const stages = Array.from({length: elapsed / 25000}, (_, index) => ({stage: 'replay',
      durationMs: 25000, elapsedMs: (index + 1) * 25000}));
    assert.deepEqual(fixture.startup().map(row => row.phase), ['start', 'fork', ...stages.map(() => 'stage'), 'ready']);
    assert.deepEqual(fixture.startup().filter(row => row.phase === 'stage')
      .map(({stage, durationMs, elapsedMs}) => ({stage, durationMs, elapsedMs})), stages);
    assert.equal(fixture.startup().at(-1).elapsedMs, delay);
    assert.doesNotMatch(fixture.logText(), /PRIVATE_|127\.0\.0\.1|isolated\/project/);
  }
});

test('desktop startup retains a bounded recovery deadline and ignores late ready IPC', async () => {
  const fixture = desktopStartupFixture(); await fixture.flush();
  for (let i = 0; i < 7; i++) {
    await fixture.advance(25000);
    fixture.child.stdout.emit('data', 'BOOT_STAGE replay 25000\n');
  }
  await fixture.advance(4999);
  assert.deepEqual(fixture.state(), {windows: 1, kills: 0, quits: 0, timers: 1});
  await fixture.advance(1);
  assert.deepEqual(fixture.state(), {windows: 1, kills: 1, quits: 1, timers: 0});
  fixture.ready(); await fixture.advance(120000);
  assert.deepEqual(fixture.state(), {windows: 1, kills: 1, quits: 1, timers: 0});
  const failure = fixture.startup().at(-1);
  assert.equal(failure.phase, 'failure'); assert.equal(failure.reason, 'ready_timeout');
  assert.equal(failure.elapsedMs, 180000); assert.equal(failure.deadlineMs, 180000);
  assert.equal(fixture.startup().length, 10);
  assert.deepEqual(fixture.startup().filter(row => row.phase === 'stage').map(row => row.elapsedMs),
    [25000, 50000, 75000, 100000, 125000, 150000, 175000]);
});

test('desktop requires complete BOOT_STAGE records and times out a silent backend in 30 seconds', async () => {
  const fixture = desktopStartupFixture(); await fixture.flush();
  await fixture.advance(20000);
  fixture.child.stdout.emit('data', 'PRIVATE_AUTH_TOKEN unrelated output\nBOOT_STAGE invalid PRIVATE_CDP_VALUE\nBOOT_STAGE partial ');
  await fixture.advance(9999);
  assert.equal(fixture.state().kills, 0);
  await fixture.advance(1);
  assert.equal(fixture.state().kills, 1);
  assert.equal(fixture.startup().at(-1).elapsedMs, 30000);
  assert.equal(fixture.child.stdout.listenerCount('data'), 0);
  assert.equal(fixture.startup().filter(row => row.phase === 'stage').length, 0);
  assert.doesNotMatch(fixture.logText(), /PRIVATE_|127\.0\.0\.1|isolated\/project/);
});

test('desktop assembles split stage lines and removes the progress listener after ready', async () => {
  const fixture = desktopStartupFixture(); await fixture.flush();
  await fixture.advance(20000);
  fixture.child.stdout.emit('data', 'BOOT_STAGE re');
  assert.equal(fixture.startup().filter(row => row.phase === 'stage').length, 0);
  await fixture.advance(500);
  fixture.child.stdout.emit('data', 'play 1000\r\n');
  assert.deepEqual(fixture.startup().filter(row => row.phase === 'stage').map(({stage, durationMs, elapsedMs}) =>
    ({stage, durationMs, elapsedMs})), [{stage: 'replay', durationMs: 1000, elapsedMs: 20500}],
  'elapsedMs records receipt of the complete line, independently of the backend duration');
  await fixture.advance(29000);
  assert.equal(fixture.state().kills, 0);
  fixture.ready(); await fixture.flush();
  assert.equal(fixture.child.stdout.listenerCount('data'), 0);
  const entries = fixture.startup().length;
  fixture.child.stdout.emit('data', 'BOOT_STAGE late 999\nPRIVATE_AUTH_TOKEN\n');
  await fixture.advance(180000);
  assert.equal(fixture.state().kills, 0);
  assert.equal(fixture.startup().length, entries);
  assert.doesNotMatch(fixture.logText(), /PRIVATE_|127\.0\.0\.1|isolated\/project/);
});

test('desktop startup error and exit paths clear the deadline and retain the child error guard', async () => {
  for (const event of ['error', 'exit']) {
    const fixture = desktopStartupFixture(); await fixture.flush(); await fixture.advance(5000);
    fixture.child.emit(event, event === 'error' ? new Error('private backend error') : 23);
    await fixture.flush(); fixture.ready(); await fixture.advance(120000);
    assert.deepEqual(fixture.state(), {windows: 1, kills: 0, quits: 1, timers: 0});
    const failure = fixture.startup().at(-1);
    assert.equal(failure.reason, event === 'error' ? 'child_error' : 'child_exit');
    assert.equal(failure.elapsedMs, 5000);
    assert.doesNotMatch(fixture.logText(), /private backend error|PRIVATE_/);
  }
  const ready = desktopStartupFixture(); await ready.flush(); ready.ready(); await ready.flush();
  assert.doesNotThrow(() => ready.child.emit('error', new Error('late process error')),
    'A child process error after ready must retain the existing guard');
  await ready.advance(120000);
  assert.deepEqual(ready.state(), {windows: 1, kills: 0, quits: 0, timers: 0});
  assert.equal(ready.startup().at(-1).phase, 'ready');
});

test("Easy Workflow uses its new defaults while preserving legacy profiles and project entry points", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-branding-"));
  const appData = path.join(root, "appData"), documents = path.join(root, "Documents");
  const currentProfile = path.join(appData, "Easy Workflow"), legacyProfile = path.join(appData, "Pi Factory");
  const currentProject = path.join(documents, "Easy Workflow", "Projects", "vislexicon-curation");
  const legacyProject = path.join(documents, "Pi Factory", "Projects", "vislexicon-curation");
  const saved = { activeProject: legacyProject, recentProjects: [path.join(root, "other-project")] };
  try {
    assert.equal(PRODUCT_NAME, "Easy Workflow");
    assert.equal(userDataDirectory({ appData }), currentProfile, "a fresh installation uses the new product name");
    const locations = projectLocations({ documents, userData: currentProfile });
    assert.equal(locations.defaultProject, currentProject);
    assert.equal(locations.newProjectBase, path.join(documents, "Easy Workflow", "Projects"));
    assert.equal(activeProjectDirectory(locations), currentProject);

    fs.mkdirSync(legacyProfile, { recursive: true });
    const preferences = JSON.stringify(saved), bookmarks = '{"bookmarks":[{"title":"kept","url":"https://example.test"}]}';
    fs.writeFileSync(path.join(legacyProfile, "desktop.json"), preferences);
    fs.writeFileSync(path.join(legacyProfile, "browser.json"), bookmarks);
    fs.mkdirSync(path.join(legacyProfile, "Partitions", "h2-browser"), { recursive: true });
    fs.writeFileSync(path.join(legacyProfile, "Partitions", "h2-browser", "Cookies"), "encrypted-session-fixture");
    fs.mkdirSync(currentProfile, { recursive: true });
    assert.equal(userDataDirectory({ appData }), legacyProfile, "an empty new profile does not hide an existing browser session");

    fs.mkdirSync(path.join(legacyProject, "published"), { recursive: true });
    fs.writeFileSync(path.join(legacyProject, "journal.db"), "legacy-journal-fixture");
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(legacyProject, "published", `${i}.json`), JSON.stringify({ entryId: `legacy-${i}` }));
    assert.equal(activeProjectDirectory(locations), legacyProject, "the migrated five-entry project remains the initial entry point");
    assert.equal(activeProjectDirectory(locations, saved), legacyProject, "saved project paths remain unchanged");
    assert.equal(recentProjectDirectories(locations, saved, legacyProject)[0], legacyProject);
    assert.equal(fs.readdirSync(path.join(legacyProject, "published")).length, 5);
    assert.equal(fs.readFileSync(path.join(legacyProfile, "desktop.json"), "utf8"), preferences);
    assert.equal(fs.readFileSync(path.join(legacyProfile, "browser.json"), "utf8"), bookmarks);
    assert.equal(fs.readFileSync(path.join(legacyProfile, "Partitions", "h2-browser", "Cookies"), "utf8"), "encrypted-session-fixture");
    assert.equal(fs.existsSync(currentProject), false, "path discovery never copies, moves or replaces a project");

    fs.writeFileSync(path.join(currentProfile, "desktop.json"), JSON.stringify({ activeProject: currentProject }));
    assert.equal(userDataDirectory({ appData }), currentProfile, "a configured new profile remains authoritative");
    fs.mkdirSync(currentProject, { recursive: true }); fs.writeFileSync(path.join(currentProject, "journal.db"), "new-journal");
    assert.equal(activeProjectDirectory(locations), currentProject);
    const recents = recentProjectDirectories(locations, { recentProjects: Array.from({ length: 10 }, (_, i) => path.join(root, `recent-${i}`)) }, currentProject);
    assert.equal(recents.length, 8); assert.ok(recents.includes(legacyProject), "the old project remains discoverable after opening new projects");

    const testProfile = path.join(root, "isolated-profile");
    assert.equal(userDataDirectory({ appData, explicitProfile: testProfile }), testProfile);
    const isolated = projectLocations({ documents, userData: testProfile, explicitProfile: testProfile });
    assert.equal(activeProjectDirectory(isolated), path.join(testProfile, "projects", "vislexicon-curation"));
    assert.equal(isolated.legacyProject, null, "test profiles never silently open the user's project");
    assert.equal(activeProjectDirectory(locations, saved, path.join(root, "explicit-project")), path.join(root, "explicit-project"));
  } finally { assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), "easy-workflow-branding-"))); fs.rmSync(root, { recursive: true, force: true }); }
});

test('backend bundles preserve relocated module resources, lazy imports and shared runtime identity', async () => {
  const {bundleDesktopServer} = await import(new URL('../scripts/build.mjs', import.meta.url).href) as {
    bundleDesktopServer(destination: string): Promise<string>;
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-backend-bundle-'));
  const staging = path.join(directory, 'staging app');
  const relocated = path.join(directory, 'relocated app Ω');
  const loaderPath = 'packs/fixture space Ω/loader.js';
  const sources: Record<string, string> = {
    'package.json': JSON.stringify({type: 'module'}),
    'server/main.js': `
      import {resourceReport, runWorker, loadBrowser} from '../${loaderPath}';
      import {state} from '../shared/state.js';
      import {bootLabel} from 'undici';
      state.count = 7;
      export {resourceReport, runWorker, loadBrowser};
      export const dependency = bootLabel;
      export const mainUrl = import.meta.url;
      export function count() { return state.count; }
      export async function loadReport() { return (await import('./report.js')).report(); }
      export async function loadInstalledPack(url) { return (await import(url)).execute(); }
    `,
    'shared/state.js': 'export const state = {count: 0};',
    'server/report.js': `
      import {state} from '../shared/state.js';
      globalThis.fixtureReportLoads = (globalThis.fixtureReportLoads ?? 0) + 1;
      export function report() { return {count: state.count++, url: import.meta.url}; }
    `,
    [loaderPath]: `
      import fs from 'node:fs';
      import {createRequire} from 'node:module';
      import {Worker} from 'node:worker_threads';
      const localRequire = createRequire(import.meta.url);
      export function resourceReport() {
        return {url: import.meta.url, literal: 'import.meta.url',
          commonjs: localRequire('./native-helper.cjs'),
          role: fs.readFileSync(new URL('./roles/ROLE.md', import.meta.url), 'utf8'),
          rules: JSON.parse(fs.readFileSync(new URL('../../resources/vislexicon/rules.json', import.meta.url), 'utf8'))};
      }
      export function runWorker() {
        return new Promise((resolve, reject) => {
          const worker = new Worker(new URL('./worker.js', import.meta.url));
          let received = false;
          let result;
          worker.once('message', value => { received = true; result = value; });
          worker.once('error', reject);
          worker.once('exit', code => {
            if (code === 0 && received) resolve(result);
            else reject(new Error('Fixture worker exited without a result: ' + code));
          });
        });
      }
      export async function loadBrowser() { return (await import('playwright-core')).identity(); }
    `,
    'packs/fixture space Ω/worker.js': `
      import fs from 'node:fs';
      import {parentPort} from 'node:worker_threads';
      parentPort.postMessage({url: import.meta.url,
        text: fs.readFileSync(new URL('./worker-data.txt', import.meta.url), 'utf8')});
    `,
    'packs/fixture space Ω/roles/ROLE.md': 'Initial fixture role',
    'packs/fixture space Ω/worker-data.txt': 'Worker resource',
    'packs/fixture space Ω/native-helper.cjs': `
      const fs = require('node:fs');
      const path = require('node:path');
      module.exports = {file: __filename, text: fs.readFileSync(path.join(__dirname, 'native-resource.txt'), 'utf8')};
    `,
    'packs/fixture space Ω/native-resource.txt': 'Relative CommonJS resource',
    'resources/vislexicon/rules.json': JSON.stringify({source: 'initial fixture rule'}),
    'installed/customer-pack.mjs': `
      import {label} from './pack-helper.mjs';
      import fs from 'node:fs';
      export function execute() { return {label, url: import.meta.url,
        text: fs.readFileSync(new URL('./pack-resource.txt', import.meta.url), 'utf8')}; }
    `,
    'installed/pack-helper.mjs': 'export const label = "Runtime installed pack";',
    'installed/pack-resource.txt': 'Installed pack resource',
    'node_modules/undici/package.json': JSON.stringify({name: 'undici', version: '0.0.0-fixture', type: 'commonjs', exports: './index.js'}),
    'node_modules/undici/index.js': 'const path = require("node:path"); exports.bootLabel = path.basename("Bundled startup dependency");',
    'node_modules/playwright-core/package.json': JSON.stringify({name: 'playwright-core', version: '0.0.0-fixture', type: 'module', exports: './index.js'}),
    'node_modules/playwright-core/index.js': `
      import fs from 'node:fs';
      globalThis.fixtureBrowserLoaded = true;
      export function identity() { return {url: import.meta.url,
        text: fs.readFileSync(new URL('./fixture-resource.txt', import.meta.url), 'utf8')}; }
    `,
    'node_modules/playwright-core/fixture-resource.txt': 'Lazy browser package resource',
  };
  try {
    for (const [relative, body] of Object.entries(sources)) {
      const file = path.join(staging, relative);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, body);
    }
    const entry = await bundleDesktopServer(staging);
    const relativeEntry = path.relative(staging, entry);
    assert.ok(relativeEntry && !path.isAbsolute(relativeEntry) && !relativeEntry.startsWith('..'),
      'the bundled entry remains inside the distribution');
    // Copied resources must remain runtime files, rather than baked-in source
    // paths or build-time values. Exercise the relocated distribution from an
    // unrelated working directory so process.cwd() cannot mask a broken URL.
    fs.writeFileSync(path.join(staging, 'packs/fixture space Ω/roles/ROLE.md'), 'Role from relocated distribution');
    fs.writeFileSync(path.join(staging, 'resources/vislexicon/rules.json'), JSON.stringify({source: 'relocated distribution'}));
    fs.renameSync(staging, relocated);
    fs.renameSync(path.join(relocated, 'node_modules', 'undici'), path.join(relocated, 'node_modules', 'undici-unavailable'));
    assert.equal(fs.readFileSync(path.join(relocated, loaderPath), 'utf8'), sources[loaderPath],
      'original modules remain available for dynamic consumers');
    const runner = path.join(directory, 'probe.mjs');
    fs.writeFileSync(runner, `
      import {pathToFileURL} from 'node:url';
      const app = await import(pathToFileURL(process.argv[2]).href);
      const before = {browser: Boolean(globalThis.fixtureBrowserLoaded), reportLoads: globalThis.fixtureReportLoads ?? 0};
      const resources = app.resourceReport();
      const worker = await app.runWorker();
      const reports = [await app.loadReport(), await app.loadReport()];
      const installed = await app.loadInstalledPack(pathToFileURL(process.argv[3]).href);
      const browser = await app.loadBrowser();
      console.log(JSON.stringify({before, resources, worker, reports, installed, browser,
        dependency: app.dependency, mainUrl: app.mainUrl, count: app.count(),
        after: {browser: Boolean(globalThis.fixtureBrowserLoaded), reportLoads: globalThis.fixtureReportLoads}}));
    `);
    const execution = spawnSync(process.execPath, [runner, path.join(relocated, relativeEntry),
      path.join(relocated, 'installed/customer-pack.mjs')], {
      cwd: directory, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    assert.equal(execution.error, undefined);
    assert.equal(execution.status, 0, execution.stderr);
    const result = JSON.parse(execution.stdout);
    const url = (relative: string) => pathToFileURL(path.join(relocated, relative)).href;
    assert.deepEqual(result.before, {browser: false, reportLoads: 0}, 'dynamic modules do not execute during startup');
    assert.equal(result.mainUrl, url('server/main.js'));
    assert.equal(result.dependency, 'Bundled startup dependency', 'startup does not reopen the removed undici package');
    assert.deepEqual(result.resources, {url: url(loaderPath), literal: 'import.meta.url',
      commonjs: {file: path.join(relocated, 'packs/fixture space Ω/native-helper.cjs'), text: 'Relative CommonJS resource'},
      role: 'Role from relocated distribution', rules: {source: 'relocated distribution'}});
    assert.deepEqual(result.worker, {url: url('packs/fixture space Ω/worker.js'), text: 'Worker resource'});
    assert.deepEqual(result.reports, [{count: 7, url: url('server/report.js')}, {count: 8, url: url('server/report.js')}]);
    assert.equal(result.count, 9, 'literal dynamic imports share the statically bundled singleton');
    assert.deepEqual(result.installed, {label: 'Runtime installed pack', url: url('installed/customer-pack.mjs'), text: 'Installed pack resource'});
    assert.deepEqual(result.browser, {url: url('node_modules/playwright-core/index.js'), text: 'Lazy browser package resource'});
    assert.deepEqual(result.after, {browser: true, reportLoads: 1});
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
