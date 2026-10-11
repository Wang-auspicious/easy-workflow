const { app, BrowserWindow, Menu, ipcMain, dialog, session, shell } = require('electron');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { BrowserManager } = require('./browser-manager.cjs');
const { copyProjectSnapshot } = require('./project-data.cjs');
const { PRODUCT_NAME, userDataDirectory, projectLocations, activeProjectDirectory, recentProjectDirectories } = require('./branding.cjs');

const root = path.resolve(__dirname, '..');
const profileDirectory = userDataDirectory({ appData: app.getPath('appData'), explicitProfile: process.env.FACTORY_PROFILE });
app.setName(PRODUCT_NAME);
fs.mkdirSync(profileDirectory, { recursive: true });
app.setPath('userData', profileDirectory);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('remote-debugging-port', '0');
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
try { fs.unlinkSync(path.join(app.getPath('userData'), 'DevToolsActivePort')); } catch {}
const partitions = ['persist:social-x', 'persist:social-xhs', 'persist:social-douyin', 'persist:social-bilibili'];
let window, backend, baseURL, browserManager, closing = false;
let viewDir = process.env.FACTORY_VIEW_VAR || null;
const configFile = () => path.join(app.getPath('userData'), 'desktop.json');
const config = () => { try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; } };
const isWeb = (url) => { try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; } };
const saveConfig = (patch) => fs.writeFileSync(configFile(), JSON.stringify({ ...config(), ...patch }, null, 2));

/* Existing projects keep their exact folder and configuration. New projects default to
 * Documents/Easy Workflow/Projects; isolated test profiles retain their own projects. */
const projectPaths = () => projectLocations({ documents: app.getPath('documents'), userData: app.getPath('userData'), explicitProfile: process.env.FACTORY_PROFILE });
const defaultProject = () => projectPaths().defaultProject;
function activeProject() {
  return activeProjectDirectory(projectPaths(), config(), process.env.FACTORY_PROJECT);
}
function rememberProject(dir) {
  const recent = recentProjectDirectories(projectPaths(), config(), dir);
  saveConfig({ activeProject: dir, recentProjects: recent });
}
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });

async function stopBackend() {
  if (!backend) return;
  const child = backend; backend = null;
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 3500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send({ type: 'shutdown' }); else child.kill();
  });
}

async function startBackend() {
  const saved = config();
  const legacy = path.join(app.getPath('userData'), 'workspace');
  const project = viewDir || activeProject();
  if (!viewDir && project === defaultProject() && !fs.existsSync(project) && fs.existsSync(path.join(legacy, 'journal.db'))) {
    await copyProjectSnapshot(legacy, project);
  }
  const token = crypto.randomBytes(32).toString('hex');
  const profile = app.getPath('userData');
  const env = {
    ...process.env, ELECTRON_RUN_AS_NODE: '1', FACTORY_ROOT: root,
    FACTORY_PORT: '0', FACTORY_TOKEN: token,
    FACTORY_VAR: viewDir || activeProject(),
    FACTORY_PROJECT_NAME: path.basename(viewDir || activeProject()),
    FACTORY_LAYOUT: path.join(profile, 'layout', 'factory.layout.json'),
    FACTORY_READONLY: viewDir ? '1' : '0', FACTORY_START_PAUSED: '1',
    FACTORY_BROWSER_BRIDGE: '1',
    FACTORY_DIST: path.join(root, 'ui', 'dist'),
    VISLEXICON_BUNDLED: path.join(root, 'resources', 'vislexicon'),
    ...(saved.vislexiconRoot ? { VISLEXICON_ROOT: saved.vislexiconRoot } : {}),
  };
  const logDir = path.join(profile, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.createWriteStream(path.join(logDir, 'desktop.log'), { flags: 'a' });
  const child = fork(path.join(__dirname, 'server-runner.cjs'), [], {
    execPath: process.execPath, env, cwd: root, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  backend = child;
  child.on('message', message => {
    if (message?.type !== 'browser:request') return;
    browserManager.command(message.args).then(result => { if (child.connected) child.send({ type:'browser:reply', id:message.id, result }); }, error => { if (child.connected) child.send({ type:'browser:reply', id:message.id, error:error.message }); });
  });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  child.once('exit', () => log.end());
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('后台启动超时；请查看用户数据目录中的 logs/desktop.log。')); }, 30000);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`后台退出（${code}）；请查看 logs/desktop.log。`)); });
    child.on('message', (message) => {
      if (message?.type !== 'ready') return;
      clearTimeout(timer); resolve(message);
    });
  });
  baseURL = ready.url;
  await session.defaultSession.cookies.set({ url: baseURL, name: 'pf_auth', value: token, httpOnly: true, sameSite: 'strict', path: '/' });
  child.on('exit', (code) => {
    if (backend === child && !closing) dialog.showErrorBox(`${PRODUCT_NAME} 后台已退出`, `退出码：${code}。重新打开应用可从日志恢复。`);
  });
}

function secureSession(s) {
  s.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
}

const windowTitle = () => viewDir ? `${PRODUCT_NAME} · 只读查看已有运行` : `${PRODUCT_NAME} · ${path.basename(activeProject())}`;
async function changeWorkspace(dir) {
  viewDir = dir;
  await stopBackend();
  await startBackend();
  window.setTitle(windowTitle());
  Menu.setApplicationMenu(menu());
  await window.loadURL(baseURL);
}
async function openProject(dir) {
  fs.mkdirSync(dir, { recursive: true });
  rememberProject(dir);
  await changeWorkspace(null);
}

function menu() {
  return Menu.buildFromTemplate([
    { label: '项目', submenu: [
      { label: '新建项目…', click: async () => {
        const chosen = await dialog.showSaveDialog(window, { title: '新建项目文件夹（项目的全部数据都会存在这里）', defaultPath: path.join(projectPaths().newProjectBase, 'new-project'), buttonLabel: '创建项目' });
        if (chosen.canceled || !chosen.filePath) return;
        await openProject(chosen.filePath).catch(showError);
      } },
      { label: '打开项目…', click: async () => {
        const chosen = await dialog.showOpenDialog(window, { title: '选择项目文件夹', defaultPath: path.dirname(activeProject()), properties: ['openDirectory', 'createDirectory'] });
        if (chosen.canceled) return;
        await openProject(chosen.filePaths[0]).catch(showError);
      } },
      { label: '最近项目', submenu: recentProjectDirectories(projectPaths(), config(), activeProject()).map((dir) => ({ label: `${path.basename(dir)}  —  ${dir}`, type: 'radio', checked: !viewDir && dir === activeProject(), click: () => openProject(dir).catch(showError) })) },
      { label: '在资源管理器中显示', click: () => shell.openPath(viewDir || activeProject()) },
      { type: 'separator' },
      { label: '回到当前项目', click: () => changeWorkspace(null).catch(showError) },
      { label: '查看已有运行（只读）…', click: async () => {
        const chosen = await dialog.showOpenDialog(window, { title: '选择包含 journal.db 的 var 目录（不会复制或修改）', properties: ['openDirectory'] });
        if (chosen.canceled) return;
        const dir = chosen.filePaths[0];
        if (!fs.existsSync(path.join(dir, 'journal.db'))) return dialog.showErrorBox('目录不正确', '这个目录中没有 journal.db。');
        await changeWorkspace(dir).catch(showError);
      } },
      { label: '连接 VisLexicon 资料目录…', click: async () => {
        const chosen = await dialog.showOpenDialog(window, { title: '选择含 Spec.md 和 VisLexicon-browser-design-kit 的目录', properties: ['openDirectory'] });
        if (chosen.canceled) return;
        const dir = chosen.filePaths[0];
        if (!fs.existsSync(path.join(dir, 'VisLexicon-browser-design-kit', 'frontend'))) return dialog.showErrorBox('目录不正确', '未找到 VisLexicon-browser-design-kit/frontend。');
        fs.writeFileSync(configFile(), JSON.stringify({ ...config(), vislexiconRoot: dir }, null, 2));
        await changeWorkspace(viewDir).catch(showError);
      } },
      { type: 'separator' }, { role: 'quit', label: '退出' },
    ] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload', label: '重新加载' }, { role: 'togglefullscreen', label: '全屏' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools', label: '开发者工具' }] : [])] },
  ]);
}

const showError = (error) => dialog.showErrorBox(PRODUCT_NAME, String(error?.stack || error));
if (process.env.FACTORY_DESKTOP_TEST === '1') {
  globalThis.__factoryDesktop = () => ({ backendPid: backend?.pid, url: baseURL, readOnly: Boolean(viewDir) });
  globalThis.__factoryBrowser = args => browserManager.command(args);
}

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    if (isWeb(url)) contents.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => { if (!isWeb(url)) event.preventDefault(); });
});

app.whenReady().then(async () => {
  secureSession(session.defaultSession);
  for (const partition of partitions) secureSession(session.fromPartition(partition));
  browserManager = new BrowserManager(app.getPath('userData'), state => { if (backend?.connected) backend.send({ type:'browser:state', state }); }, secureSession);
  await browserManager.migrate(partitions);
  await startBackend();
  window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    title: windowTitle(),
    backgroundColor: '#f7f8fa', show: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  browserManager.attach(window);
  window.webContents.on('did-start-loading', () => browserManager.setBounds(null));
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== baseURL) event.preventDefault(); });
  window.webContents.on('will-attach-webview', (event, preferences, params) => {
    if (!partitions.includes(params.partition) || !isWeb(params.src)) { event.preventDefault(); return; }
    delete preferences.preload;
    Object.assign(preferences, { nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false });
  });
  ipcMain.handle('desktop:info', (event) => {
    if (event.sender !== window?.webContents) throw new Error('Forbidden');
    return { version: app.getVersion(), platform: process.platform, workspace: viewDir || activeProject(), project: path.basename(viewDir || activeProject()), readOnly: Boolean(viewDir) };
  });
  Menu.setApplicationMenu(menu());
  ipcMain.handle('desktop:browser-bounds', (event, bounds) => {
    if (event.sender !== window?.webContents) throw new Error('Forbidden');
    if (bounds && !['x','y','width','height'].every(k => Number.isFinite(bounds[k]))) throw new Error('Invalid bounds');
    browserManager.setBounds(bounds); return true;
  });
  window.once('ready-to-show', () => { window.show(); if (process.env.FACTORY_MINIMIZED === '1') window.minimize(); });
  window.on('page-title-updated', (event) => event.preventDefault());
  await window.loadURL(baseURL);
  const savedTabs = [...browserManager.data.tabs];
  if (savedTabs.length) for (const tab of savedTabs) { try { browserManager.create(tab.url); } catch {} }
  else browserManager.create();
}).catch((error) => { showError(error); app.quit(); });

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (closing) return;
  event.preventDefault(); closing = true;
  stopBackend().then(() => browserManager?.close()).finally(() => Promise.all(partitions.map((p) => session.fromPartition(p).cookies.flushStore())).finally(() => app.quit()));
});
