// Real Electron lifecycle check, with an isolated profile and no curation/model tasks.
import { _electron as electron, chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-factory-desktop-'));
const artifacts = path.join(root, 'artifacts', 'desktop'); fs.mkdirSync(artifacts, { recursive: true });
const env = { ...process.env, FACTORY_PROFILE: profile, FACTORY_DESKTOP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.OPENCODE_API_KEY;
delete env.FACTORY_VIEW_VAR;
const executablePath = path.resolve(process.argv.find((a) => a.startsWith('--exe='))?.slice(6) || require('electron'));
const appRoot = path.resolve(process.argv.find((a) => a.startsWith('--app='))?.slice(6) || root);
if (process.argv.includes('--standalone')) { env.VISLEXICON_ROOT = path.join(profile, 'unconnected'); env.HOME = profile; env.USERPROFILE = profile; }
const packaged = process.argv.includes('--packaged');
const results = { profile, executablePath, appRoot, checks: [] };
let app;
const fixture = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(req.url === '/login' ? '<!doctype html><title>Login required</title><input type="password"><p>Sign in to continue</p>' : '<!doctype html><title>Local webview check</title><p>Persistent browser partition</p>'); });
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const fixtureURL = `http://127.0.0.1:${fixture.address().port}`;

async function launch(overrides = {}) {
  return electron.launch({ executablePath, args: packaged ? [] : [appRoot], env: { ...env, ...overrides }, timeout: 45000 });
}
async function closeAndVerify(instance) {
  const { backendPid, url } = await instance.evaluate(() => globalThis.__factoryDesktop());
  await instance.close();
  for (let i = 0; i < 40; i++) {
    let alive = true; try { process.kill(backendPid, 0); } catch { alive = false; }
    if (!alive) { results.checks.push('backend exits with window'); break; }
    if (i === 39) throw new Error(`Backend ${backendPid} survived window close`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const response = await fetch(url).catch(() => null);
  assert.equal(response, null, 'backend listener must close');
}

async function checkNativeLayers(instance, browserVisible=false) {
  const layers=await instance.evaluate(({BrowserWindow})=>{
    const w=BrowserWindow.getAllWindows()[0],children=w.contentView.children;
    return {visible:children.filter(v=>v.getVisible()).map(v=>v.getBounds()),size:w.getContentSize()};
  });
  assert.equal(layers.visible.length,browserVisible?1:0,'only the selected tab in the browser workspace may be visible');
  for(const b of layers.visible){assert.ok(b.x>0&&b.y>0,'native page must respect the browser toolbar and application rail');assert.ok(b.x+b.width<=layers.size[0]&&b.y+b.height<=layers.size[1]);}
}

async function checkCompositedWindow(instance, name) {
  // DOM screenshots omit native WebContentsView overlays. Capture this actual
  // application window and reject the large black surface from the regression.
  const shot=await instance.evaluate(async({BrowserWindow,desktopCapturer})=>{
    const w=BrowserWindow.getAllWindows()[0];
    const sources=await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:1280,height:900}});
    const source=sources.find(s=>s.id===w.getMediaSourceId());
    if(!source)throw new Error('Native window capture unavailable');
    const bitmap=source.thumbnail.toBitmap();let dark=0;
    for(let i=0;i<bitmap.length;i+=4)if(bitmap[i]<40&&bitmap[i+1]<40&&bitmap[i+2]<40)dark++;
    return {darkShare:dark/(bitmap.length/4),size:source.thumbnail.getSize(),png:source.thumbnail.toPNG().toString('base64')};
  });
  assert.ok(shot.size.width>500&&shot.size.height>300,'native window thumbnail must contain the actual client area');
  fs.writeFileSync(path.join(artifacts,`${name}.png`),Buffer.from(shot.png,'base64'));
  assert.ok(shot.darkShare<.15,`black native overlay covers ${(shot.darkShare*100).toFixed(1)}% of the app`);
}

try {
  app = await launch();
  const page = await app.firstWindow();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.node').first().waitFor({ timeout: 30000 });
  await checkNativeLayers(app);
  const desktop = await page.evaluate(() => window.desktop.info());
  assert.equal(desktop.readOnly, false);
  assert.equal(desktop.workspace, path.join(profile, 'workspace'));
  const boot = await page.evaluate(async () => ({ factory: await (await fetch('/api/factory')).json(), state: await (await fetch('/api/state')).json() }));
  assert.equal(boot.factory.factory.nodes.length, 66);
  assert.equal(Object.keys(boot.state.tokens).length, 0);
  assert.equal(boot.state.run.status, 'idle');
  const role = await page.evaluate(async()=>{
    const r=await fetch('/api/tools/read_role',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({station:'curation/proof'})});
    if(!r.ok)throw new Error(`read_role: ${r.status}`);return r.json();
  });
  assert.match(JSON.stringify(role),/组件特写摄影/);
  assert.match(JSON.stringify(role),/情况判断与处理/);
  results.checks.push('bundled node ROLE.md accessible through the Agent interface');
  if (process.argv.includes('--standalone')) {
    assert.equal(boot.factory.keyPresent, false, 'standalone smoke must not discover an API key');
    assert.equal(boot.state.nodes['candidates/pool'].stock, 0, 'standalone smoke must not read the local candidate catalogue');
    results.checks.push('starts without API key or connected VisLexicon data');
  }
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const prefs = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.sandbox, true);
  const { url } = await app.evaluate(() => globalThis.__factoryDesktop());
  assert.equal((await fetch(`${url}/api/state`)).status, 401);
  results.checks.push('66-node graph renders without running work', 'isolated writable workspace', 'sandbox and context isolation', 'unauthenticated local request rejected');
  await page.evaluate((url) => new Promise((resolve, reject) => {
    const w = document.createElement('webview'); w.id = 'desktop-smoke-webview';
    w.setAttribute('partition', 'persist:social-x'); w.src = url;
    w.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:180px;z-index:99999';
    w.addEventListener('dom-ready', () => resolve(true), { once: true });
    w.addEventListener('did-fail-load', (e) => reject(new Error(e.errorDescription)), { once: true });
    document.body.append(w);
  }), fixtureURL);
  const guest = await app.evaluate(async ({ webContents }) => {
    const w = webContents.getAllWebContents().find((w) => w.getType() === 'webview');
    return { prefs: w.getLastWebPreferences(), title: w.getTitle(), node: await w.executeJavaScript('typeof require') };
  });
  assert.equal(guest.title, 'Local webview check'); assert.equal(guest.node, 'undefined');
  assert.equal(guest.prefs.sandbox, true); assert.equal(guest.prefs.nodeIntegration, false);
  await page.evaluate(() => document.getElementById('desktop-smoke-webview').remove());
  results.checks.push('real webview loads local page with Node disabled');
  const browserCall = args => page.evaluate(async args => { const res = await fetch('/api/browser', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)});const data=await res.json();if(!res.ok)throw new Error(JSON.stringify(data));return data; },args);
  await browserCall({action:'open',url:fixtureURL});
  await page.locator('.rail-item[data-tip="内置浏览器"]').click();
  await page.getByRole('tab',{name:/Local webview check/}).waitFor();
  await checkNativeLayers(app,true);
  const browsing = await page.evaluate(async()=> (await fetch('/api/browser')).json());
  const manualTab = browsing.tabs.find(t=>t.url===fixtureURL+'/');
  const read = await browserCall({action:'read',id:manualTab.id});
  assert.match(read.text,/Persistent browser partition/);
  const bounds = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].contentView.children.map(v=>v.getBounds()));
  assert.ok(bounds.some(b=>b.width>600&&b.height>400), 'native browser view mounted in the browser body');
  await app.evaluate(async({session},url)=>session.fromPartition('persist:h2-browser').cookies.set({url,name:'shared-session-test',value:'shared-with-worker'}),fixtureURL);
  const lease=await app.evaluate(()=>globalThis.__factoryBrowser({action:'lease'}));
  await page.locator('.rail-item[data-tip="画布 · 流水线  Alt 1"]').click();
  await checkNativeLayers(app);
  const cdp=await chromium.connectOverCDP(lease.endpoint);
  try {
    let workerPage;
    for(let i=0;i<30&&!workerPage;i++){workerPage=cdp.contexts().flatMap(c=>c.pages()).find(p=>p.url()===lease.marker);if(!workerPage)await new Promise(r=>setTimeout(r,50));}
    assert.ok(workerPage,'leased native tab is available to background automation');
    await workerPage.setViewportSize({width:1280,height:800});
    await workerPage.goto(fixtureURL);
    await checkNativeLayers(app);
    await app.evaluate((_electron,id)=>globalThis.__factoryBrowser({action:'capture.begin',id}),lease.id);
    await workerPage.screenshot({path:path.join(artifacts,'background-capture.png'),timeout:4000});
    const screencast=await workerPage.context().newCDPSession(workerPage);let frameCount=0;
    screencast.on('Page.screencastFrame',e=>{frameCount++;void screencast.send('Page.screencastFrameAck',{sessionId:e.sessionId}).catch(()=>{});});
    await screencast.send('Page.startScreencast',{format:'jpeg',quality:80,everyNthFrame:1});
    for(let i=0;i<12&&frameCount<2;i++){await workerPage.evaluate(i=>document.body.style.background=i%2?'#ddeeff':'#fff',i);await new Promise(r=>setTimeout(r,100));}
    await screencast.send('Page.stopScreencast');await screencast.detach();assert.ok(frameCount>=2,'background recording must produce real frames');
    assert.equal((await app.evaluate((_electron,id)=>globalThis.__factoryBrowser({action:'capture.end',id}),lease.id)).capturing,false);
    await checkCompositedWindow(app,'native-during-background-capture');
    assert.match(await workerPage.evaluate(()=>document.cookie),/shared-session-test=shared-with-worker/);
    await workerPage.goto(fixtureURL+'/login');
    await page.locator('.rail-browser-alert').waitFor();
    await app.evaluate((_electron,id)=>globalThis.__factoryBrowser({action:'release',id}),lease.id);
    assert.ok((await page.evaluate(async()=> (await fetch('/api/browser')).json())).tabs.some(t=>t.id===lease.id&&t.attention),'auth-blocked worker page remains open');
    await browserCall({action:'navigate',id:lease.id,url:fixtureURL});
    await page.waitForFunction(()=>!document.querySelector('.rail-browser-alert'));
    await browserCall({action:'close',id:lease.id});
  } finally { await cdp.close(); }
  await browserCall({action:'bookmark.add',url:fixtureURL,title:'本地验证'});
  await page.locator('.rail-item[data-tip="内置浏览器"]').click();
  await browserCall({action:'bookmark.move',id:'bilibili',before:'x'});
  await page.waitForFunction(()=>document.querySelector('.browser-bookmarks button')?.textContent.includes('B 站'));
  const localBookmark=page.locator('.browser-bookmarks').getByRole('button',{name:'本地验证',exact:true});
  await localBookmark.click({button:'right'});
  await page.getByRole('menuitem',{name:'编辑名称与网址'}).click();
  await page.getByRole('textbox',{name:'收藏名称',exact:true}).fill('本地验证 · 已编辑');
  await page.getByRole('textbox',{name:'收藏网址',exact:true}).fill(fixtureURL+'/edited');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.locator('.browser-bookmarks').getByRole('button',{name:'本地验证 · 已编辑',exact:true}).waitFor();
  assert.equal((await browserCall({action:'state'})).bookmarks.find(b=>b.title==='本地验证 · 已编辑').url,fixtureURL+'/edited');
  await page.getByRole('button',{name:'自定义收藏',exact:true}).click();
  await page.getByRole('textbox',{name:'收藏名称',exact:true}).fill('待删除测试');
  await page.getByRole('textbox',{name:'收藏网址',exact:true}).fill(fixtureURL+'/remove');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.locator('.browser-bookmarks').getByRole('button',{name:'待删除测试',exact:true}).click({button:'right'});
  await page.getByRole('menuitem',{name:'删除收藏'}).click();
  await page.waitForFunction(()=>!document.querySelector('.browser-bookmarks')?.textContent.includes('待删除测试'));
  results.checks.push('bookmark right-click edits title and URL; separate menu removes; new bookmark remains independent');
  await page.screenshot({path:path.join(artifacts,'shared-browser.png')});
  await page.getByRole('button',{name:'浏览历史',exact:true}).click();
  await page.locator('.browser-history').waitFor();
  assert.match(await page.locator('.browser-history').textContent(),/Local webview check/);
  await page.screenshot({path:path.join(artifacts,'browser-history.png')});
  results.checks.push('user and background worker share persistent browser session', 'real native tabs mounted inside workspace', 'Pi reads the same page through CDP', 'auth interruption retains tab and shows red badge', 'successful login/navigation clears alert', 'bookmark order and visit history');
  await page.locator('.rail-item[data-tip="画布 · 流水线  Alt 1"]').click();
  await page.getByRole('button',{name:'运行',exact:true}).click();
  await page.getByRole('button',{name:'暂停',exact:true}).click();
  await page.getByRole('button',{name:'继续',exact:true}).waitFor();
  await page.getByRole('button',{name:'结束本轮',exact:true}).click();
  await page.getByRole('dialog',{name:'结束本轮确认'}).waitFor();
  // A real rejected request must leave an actionable error, then allow retry.
  await page.route('**/api/run',route=>route.fulfill({status:503,json:{error:'test-only temporary outage'}}),{times:1});
  await page.getByRole('button',{name:'结束并生成报告',exact:true}).click();
  await page.getByRole('dialog').getByRole('alert').waitFor();
  await page.getByRole('button',{name:'结束并生成报告',exact:true}).click();
  await page.locator('.run-dashboard').waitFor();
  const ended=await page.evaluate(async()=>(await fetch('/api/state')).json());
  assert.equal(ended.run.status,'ended');
  assert.equal((await page.evaluate(async id=>(await fetch('/api/report/'+id)).json(),ended.run.id)).status,'ended');
  results.checks.push('paused run ends via in-app confirmation; errors stay visible; retry opens report');
  await page.locator('.rail-item[data-tip="画布 · 流水线  Alt 1"]').click();
  for (const size of [[1440, 900], [1366, 768]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), size);
    await checkNativeLayers(app);
    await page.screenshot({ path: path.join(artifacts, `desktop-${size.join('x')}.png`) });
  }
  await app.evaluate(async ({ session }) => {
    await session.fromPartition('persist:social-x').cookies.set({ url: 'https://x.com', name: 'factory-persistence-test', value: 'survives-restart', expirationDate: Date.now() / 1000 + 3600, secure: true });
    await session.fromPartition('persist:social-x').cookies.flushStore();
  });
  await closeAndVerify(app); app = null;
  app = await launch();
  await (await app.firstWindow()).locator('.node').first().waitFor({ timeout: 30000 });
  await checkNativeLayers(app);
  const cookies = await app.evaluate(async ({ session }) => session.fromPartition('persist:social-x').cookies.get({ name: 'factory-persistence-test' }));
  assert.equal(cookies[0]?.value, 'survives-restart');
  results.checks.push('persistent webview session survives restart');
  results.checks.push('inactive native browser views stay hidden across restore, capture, navigation and resize');
  await checkCompositedWindow(app,'native-after-restart');
  const restored = await (await app.firstWindow()).evaluate(async()=> (await fetch('/api/browser')).json());
  assert.equal(restored.bookmarks[0].id,'bilibili');assert.ok(restored.bookmarks.some(b=>b.title==='本地验证 · 已编辑'));assert.ok(restored.history.some(h=>h.title==='Local webview check'));
  results.checks.push('bookmarks and history survive restart');
  await closeAndVerify(app); app = null;
  const journal = path.join(profile, 'workspace', 'journal.db');
  const before = crypto.createHash('sha256').update(fs.readFileSync(journal)).digest('hex');
  app = await launch({ FACTORY_VIEW_VAR: path.join(profile, 'workspace') });
  const readPage = await app.firstWindow();
  await readPage.locator('.node').first().waitFor({ timeout: 30000 });
  assert.equal((await readPage.evaluate(() => window.desktop.info())).readOnly, true);
  assert.equal(await readPage.evaluate(async () => (await fetch('/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"count":1}' })).status), 403);
  await closeAndVerify(app); app = null;
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(journal)).digest('hex'), before);
  results.checks.push('read-only view rejects work and preserves journal bytes');
  assert.deepEqual(errors, []);
  results.checks.push('no renderer exceptions');
  results.ok = true;
  results.checks.push('background screenshot and recording frames while canvas is active');
  fs.writeFileSync(path.join(artifacts, 'smoke.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  if (app) await app.close().catch(() => {});
  fixture.closeAllConnections(); await new Promise((resolve) => fixture.close(resolve));
}
