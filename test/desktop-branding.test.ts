import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import {EventEmitter} from "node:events";
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
    stdout: {pipe() {}}, stderr: {pipe() {}},
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

test('desktop startup accepts normal and slower cold recovery while keeping its window visible', async () => {
  for (const delay of [31000, 0, 59000, 75000]) {
    const fixture = desktopStartupFixture(); await fixture.flush();
    await fixture.advance(delay);
    assert.equal(fixture.state().kills, 0, `A backend still booting at ${delay}ms must remain alive`);
    fixture.ready(); await fixture.flush();
    assert.deepEqual(fixture.state(), {windows: 1, kills: 0, quits: 0, timers: 0});
    assert.deepEqual(fixture.startup().map(row => row.phase), ['start', 'fork', 'ready']);
    assert.equal(fixture.startup().at(-1).elapsedMs, delay);
    assert.doesNotMatch(fixture.logText(), /PRIVATE_|127\.0\.0\.1|isolated\/project/);
  }
});

test('desktop startup retains a bounded recovery deadline and ignores late ready IPC', async () => {
  const fixture = desktopStartupFixture(); await fixture.flush();
  await fixture.advance(179999);
  assert.deepEqual(fixture.state(), {windows: 1, kills: 0, quits: 0, timers: 1});
  await fixture.advance(1);
  assert.deepEqual(fixture.state(), {windows: 1, kills: 1, quits: 1, timers: 0});
  fixture.ready(); await fixture.advance(120000);
  assert.deepEqual(fixture.state(), {windows: 1, kills: 1, quits: 1, timers: 0});
  const failure = fixture.startup().at(-1);
  assert.equal(failure.phase, 'failure'); assert.equal(failure.reason, 'ready_timeout');
  assert.equal(failure.elapsedMs, 180000); assert.equal(failure.deadlineMs, 180000);
  assert.equal(fixture.startup().length, 3);
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
