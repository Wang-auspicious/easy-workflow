// One persistent browser shared by the owner and every capture worker.
// DOM and response checks are shared with the independent browser service. Electron
// is loaded only when constructing the desktop manager, not by the shared probes.
let WebContentsView, session;
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { BrowserData, webURL } = require('./browser-data.cjs');

function browserAttentionProbe() {
  const text = (document.body?.innerText || '').slice(0, 6000), title = document.title || '';
  const visible = el => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const password = [...document.querySelectorAll('input[type=password]')].some(visible);
  const authPath = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:(?:account|auth)\/)?(?:login|signin|sign-in|log-in)(?:[/?#]|$)|^\/i\/flow\/login|^\/i\/[^/]*onboarding/i.test(location.pathname);
  const authTitle = /^(?:log[ -]?in|sign[ -]?in|登录)(?:\b|\s|$)/i.test(title.trim());
  const explicitWall = /sign in to (?:continue|view|access)|log in to (?:continue|view|access)|登录后查看|登录后继续/i.test(text);
  const authDialog = [...document.querySelectorAll('[role=dialog],dialog')].some(el => visible(el) && /sign[ -]?in|log[ -]?in|登录/i.test(el.innerText || '') && el.querySelector('input[type=password]'));
  let issue = '', kind;
  // A password demo or an ordinary Sign in navigation item does not block public
  // content. Require an authentication page, a blocking dialog or explicit wall.
  if (/just a moment/i.test(title) || /verify you are human|checking your browser|人机验证|安全验证/i.test(text)) { issue = '页面需要完成人机验证'; kind = 'challenge'; }
  else if (authPath || authDialog || (password && authTitle) || (explicitWall && (password || text.length < 1200))) { issue = '登录状态需要检查'; kind = 'auth'; }
  else if (/attention required|access denied|403 forbidden/i.test(title) || /sorry,?\s*you have been blocked|you are unable to access|your (?:request|access) (?:has been|was) blocked|访问被拒绝|拒绝访问|请求被拦截/i.test(text)) { issue = '服务器拒绝访问，系统将核对公开入口与请求状态'; kind = 'http'; }
  return { url: location.href, issue, kind };
}

function browserAttentionKind(message) {
  if (/certificate|CERT_|ERR_(?:SSL|TLS)_|SSL_ERROR|证书/i.test(message)) return 'certificate';
  if (/ERR_CONNECTION|ECONN|ERR_NAME|DNS|timeout|超时|连接|页面加载失败/i.test(message)) return 'network';
  if (/人机验证|verify you are human|checking your browser|captcha|页面需要完成验证/i.test(message)) return 'challenge';
  if (/登录|loginWall|sign in to|log in to/i.test(message) && !/403|拒绝访问|访问被拒绝/i.test(message)) return 'auth';
  return 'http';
}
function retainBrowserAttention(tab) { return Boolean(tab.attention && ['auth', 'challenge', 'certificate'].includes(tab.attentionKind)); }
function attentionKey(tab) { try { return `${new URL(tab.url).origin}:${tab.attentionKind}`; } catch { return tab.url; } }
function boundedProbe(promise, ms = 5000) {
  let timer;
  return Promise.race([promise.catch(() => null), new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]).finally(() => clearTimeout(timer));
}

function documentKey(url) { try { const parsed = new URL(url); parsed.hash = ''; return parsed.href; } catch { return url; } }
function noteBrowserResponse(tab, { url, status, mainFrame, resourceType }) {
  const key = url.split('?')[0];
  if (mainFrame) {
    tab.documentUrl = url; tab.documentStatus = status;
    tab.denied = new Set(); tab.checkSerial = (tab.checkSerial || 0) + 1;
    if (status >= 200 && status < 400) tab.manualAttention = false;
  } else {
    if (!['xhr', 'fetch'].includes(resourceType)) return false;
    try { if (new URL(url).origin !== new URL(tab.documentUrl || tab.url).origin) return false; } catch { return false; }
    tab.denied ??= new Set();
  }
  if ([401, 403].includes(status)) {
    tab.denied.add(key);
    // Anonymous /session checks are common on public pages. A same-origin XHR
    // denial is evidence to inspect, not proof that the main content needs login.
    if (!mainFrame) return true;
    tab.attention = status === 401 ? '页面要求身份认证（HTTP 401）' : '服务器拒绝请求（HTTP 403），系统将检查公开入口';
    tab.attentionKind = status === 401 ? 'auth' : 'http';
    return true;
  }
  if (mainFrame && status >= 400) { tab.attention = `页面加载失败（HTTP ${status}）`; tab.attentionKind = 'http'; return true; }
  if (status >= 200 && status < 400) return tab.denied.delete(key) || mainFrame;
  return false;
}
function applyBrowserAttention(tab, probe, currentUrl, loading, manualCheck = false) {
  // A failed/stale probe cannot prove that an existing alert has been resolved.
  if (!probe || probe.url !== currentUrl) return;
  if (probe.issue) {
    if (tab.documentStatus === 401 && probe.kind === 'http') return;
    tab.attention = probe.issue; tab.attentionKind = probe.kind || browserAttentionKind(probe.issue); return;
  }
  const healthy = tab.documentStatus === undefined || (tab.documentStatus >= 200 && tab.documentStatus < 400 && documentKey(tab.documentUrl) === documentKey(currentUrl));
  if (!loading && healthy) {
    if (manualCheck) tab.manualAttention = false;
    if (!tab.manualAttention) { tab.attention = undefined; tab.attentionKind = undefined; }
  }
}

class BrowserManager {
  constructor(profile, notify, secureSession) {
    ({ WebContentsView, session } = require('electron'));
    this.profile = profile; this.notify = notify; this.secureSession = secureSession;
    this.data = new BrowserData(path.join(profile, 'browser.json'));
    this.tabs = new Map(); this.active = null; this.window = null; this.bounds = null; this.mounted = null;
    this.partition = 'persist:h2-browser'; // Stable storage key keeps existing browser sessions and cookies.
    this.secureSession(session.fromPartition(this.partition));
    this.downloadGuard = (event, _item, contents) => {
      const tab = [...this.tabs.values()].find(candidate => candidate.view.webContents.id === contents?.id);
      // Background exploration must never summon a native Save As dialog. Only
      // an explicit user tab may delegate a download to Electron's normal UI.
      if (tab?.owner !== 'user') event.preventDefault();
    };
    session.fromPartition(this.partition).on('will-download', this.downloadGuard);
    this.timer = setInterval(() => { this.data.prune(); this.data.save(); this.publish(); }, 3600000); this.timer.unref();
    this.authTimer = setInterval(() => { for(const t of this.tabs.values())if(!t.loading)void this.check(t); },30000);this.authTimer.unref();
    session.fromPartition(this.partition).webRequest.onCompleted(details=>{
      const t=[...this.tabs.values()].find(t=>t.view.webContents.id===details.webContentsId);
      if(!t||!['mainFrame','xhr','fetch'].includes(details.resourceType))return;
      if(noteBrowserResponse(t,{url:details.url,status:details.statusCode,mainFrame:details.resourceType==='mainFrame',resourceType:details.resourceType})){this.publish();void this.check(t);}
    });
  }
  async migrate(partitions) {
    const dest = session.fromPartition(this.partition);
    if (fs.existsSync(path.join(this.profile, 'browser-session-migrated'))) return;
    for (const p of partitions) for (const c of await session.fromPartition(p).cookies.get({})) {
      const { hostOnly, session: ephemeral, ...cookie } = c;
      const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./,'')}${c.path || '/'}`;
      await dest.cookies.set({ ...cookie, url }).catch(() => {});
    }
    await dest.cookies.flushStore(); fs.writeFileSync(path.join(this.profile, 'browser-session-migrated'), '1');
  }
  attach(window) { this.window = window; }
  snapshot() { return { mode: 'desktop', tabs: [...this.tabs.values()].map(t => ({ id: t.id, url: t.url, title: t.title, owner: t.owner, loading: t.loading, attention: t.attention, attentionKind: t.attentionKind, canGoBack: !t.view.webContents.isDestroyed() && t.view.webContents.navigationHistory.canGoBack(), canGoForward: !t.view.webContents.isDestroyed() && t.view.webContents.navigationHistory.canGoForward() })), active: this.active, bookmarks: this.data.bookmarks, history: this.data.history.slice(-200).reverse(), retentionDays: this.data.retentionDays }; }
  publish() { this.notify(this.snapshot()); }
  persistTabs() { this.data.tabs = [...this.tabs.values()].filter(t => t.owner === 'user' && /^https?:/.test(t.url)).map(t => ({url:t.url})); this.data.save(); }
  mount() {
    if (!this.window || this.window.isDestroyed()) return;
    const view = this.bounds && this.tabs.get(this.active)?.view;
    // Native children paint above BrowserWindow's document regardless of index.
    // Explicit visibility, not sibling order, separates background work from UI.
    for(const t of this.tabs.values())if(!t.view.webContents.isDestroyed())t.view.setVisible(t.view===view);
    this.mounted = view || null;
    if (view) { this.window.contentView.addChildView(view); view.setBounds(this.bounds); }
  }
  setBounds(bounds) {
    if (!bounds) this.bounds = null;
    else { const [w,h] = this.window.getContentSize(); this.bounds = { x: Math.max(0,Math.round(bounds.x)), y: Math.max(0,Math.round(bounds.y)), width: Math.max(1,Math.min(w - bounds.x, Math.round(bounds.width))), height: Math.max(1,Math.min(h - bounds.y, Math.round(bounds.height))) }; }
    this.mount();
  }
  create(url = 'about:blank', owner = 'user') {
    if (url !== 'about:blank') url = webURL(url);
    if (this.tabs.size >= 30) throw new Error('已有 30 个标签页，请先关闭不需要的页面');
    const id = crypto.randomUUID();
    const view = new WebContentsView({ webPreferences: { partition: this.partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: owner !== 'agent' } });
    const t = { id, view, url, title: url === 'about:blank' ? '新标签页' : new URL(url).hostname, owner, leased: owner === 'agent', loading: false, attention: undefined };
    this.tabs.set(id,t); view.setBounds({x:0,y:0,width:1280,height:800});
    view.setVisible(false);
    // Detached WebContentsViews can navigate but have no composited frame to capture.
    // Keep pages attached but hidden; the scoped native capturer supplies frames.
    this.window?.contentView.addChildView(view,0);
    const wc = view.webContents;
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(args => this.openWindow(t, args));
    wc.on('will-navigate', (event, url) => { try { webURL(url); } catch { event.preventDefault(); } });
    wc.on('did-start-loading', () => { t.loading = true; this.publish(); });
    wc.on('did-stop-loading', () => { t.loading = false; this.publish(); void this.check(t); });
    wc.on('page-title-updated', (_e,title) => { t.title = wc.getURL().startsWith('about:') ? '新标签页' : title || t.title; const visit=[...this.data.history].reverse().find(h=>h.url===wc.getURL()); if(visit){visit.title=t.title;this.data.save();} this.publish(); });
    const navigated = () => { t.url = wc.getURL(); t.title = t.url.startsWith('about:') ? '新标签页' : wc.getTitle() || t.title; this.data.visit(t.url,t.title); this.persistTabs(); this.publish(); void this.check(t); };
    wc.on('did-navigate', navigated); wc.on('did-navigate-in-page', navigated); wc.on('did-finish-load', () => void this.check(t));
    wc.on('did-fail-load', (_e,code,description,_url,main) => { if (main && code !== -3) { t.attention = `页面加载失败：${description}`; t.attentionKind = browserAttentionKind(description); this.publish(); } });
    wc.on('render-process-gone', (_event, details) => {
      t.crashed = true; t.attention = `页面进程已退出（${details?.reason || 'crashed'}），点击重新加载`; t.attentionKind = 'crash'; t.loading = false;
      this.publish();
      // Only disposable agent leases are replaced automatically. User/verification
      // tabs remain visible and retain their persistent session for manual reload.
      if (t.owner === 'agent') this.discardAgent(t);
    });
    wc.on('did-finish-load', () => { t.crashed = false; });
    wc.once('destroyed', () => { if (this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(view); this.tabs.delete(id); if (this.active === id) this.active = this.tabs.keys().next().value ?? null; this.mount(); this.publish(); this.persistTabs(); });
    if (owner === 'user' || !this.active) this.active = id;
    // The marker lets Playwright find precisely this page, never a user's other tab.
    t.ready = wc.loadURL(url === 'about:blank' ? `about:blank#easy-workflow-${id}` : url).catch(error => { t.readyError = error.message; t.attention = error.message; this.publish(); });
    this.mount(); this.publish(); return t;
  }
  openWindow(parent, { url }) {
    // A script popup from a task must never become a durable user tab or escape
    // its resource lease. Agent navigation is explicit through the browser API.
    if (parent.owner === 'user') { try { this.create(url, 'user'); } catch {} }
    return { action: 'deny' };
  }
  async check(t, manualCheck = false, requireFresh = false) {
    if (t.attentionCheck) { await t.attentionCheck; if (!manualCheck && !requireFresh) return; }
    const check = (t.attentionCheck || Promise.resolve()).catch(() => {}).then(async () => {
      const wc = t.view.webContents; if (!this.tabs.has(t.id) || t.crashed || wc.isDestroyed() || !/^https?:/.test(wc.getURL())) return;
      const serial=t.checkSerial=(t.checkSerial||0)+1, url=wc.getURL();
      const probe = await boundedProbe(wc.executeJavaScript(`(${browserAttentionProbe.toString()})()`));
      if (!this.tabs.has(t.id)||serial!==t.checkSerial||wc.isDestroyed()||wc.getURL()!==url) return;
      applyBrowserAttention(t, probe, url, wc.isLoading(), manualCheck);
      this.publish();
    });
    t.attentionCheck = check;
    try { await check; } finally { if (t.attentionCheck === check) t.attentionCheck = undefined; }
  }
  discardAgent(t) {
    if (t.owner !== 'agent') return false;
    const wc = t.view.webContents;
    if (t.captureDepth && !wc.isDestroyed()) { try { wc.endFrameSubscription(); } catch {} }
    t.captureDepth = 0;
    if (!wc.isDestroyed()) wc.close();
    return true;
  }
  async endpoint() {
    for (let i=0;i<50;i++) { try { const lines = fs.readFileSync(path.join(this.profile, 'DevToolsActivePort'),'utf8').trim().split(/\r?\n/); const port = Number(lines[0]); if (port > 0 && lines[1]?.startsWith('/devtools/browser/')) return `http://127.0.0.1:${port}`; } catch {} await new Promise(r=>setTimeout(r,100)); }
    throw new Error('内置浏览器调试连接尚未就绪');
  }
  async command(args) {
    const action = args.action;
    if (action === 'state') return this.snapshot();
    if (action === 'target') {
      const t=this.tabs.get(args.id); if(!t || t.crashed || t.view.webContents.isDestroyed())throw new Error('BROWSER_PAGE_CLOSED: 内置浏览器标签已失效，请重新领取页面');
      const debug=t.view.webContents.debugger, own=!debug.isAttached();
      try {if(own)debug.attach('1.3');const result=await debug.sendCommand('Target.getTargetInfo');return {endpoint:await this.endpoint(), targetId:result.targetInfo.targetId};} finally {if(own&&debug.isAttached())debug.detach();}
    }
    if (action === 'lease') {
      const t = this.create('about:blank','agent');
      try {
        const ready = await boundedProbe(t.ready.then(() => true));
        if (!ready) throw new Error('BROWSER_LEASE_FAILED: 创建页面超时');
        if (t.readyError || t.crashed || t.view.webContents.isDestroyed()) throw new Error('BROWSER_LEASE_FAILED: 内置浏览器未能创建可用页面');
        return { id:t.id, marker:`about:blank#easy-workflow-${t.id}`, endpoint:await this.endpoint() };
      } catch (error) { this.discardAgent(t); throw error; }
    }
    if (action === 'open') { this.create(args.url || 'about:blank'); return this.snapshot(); }
    if (action.startsWith('bookmark.') || action === 'history.prune') { this.data.change(action,args); this.publish(); return this.snapshot(); }
    const t = this.tabs.get(args.id); if (!t) throw new Error('BROWSER_PAGE_CLOSED: 标签页已经关闭');
    const wc = t.view.webContents;
    if (action === 'capture.begin') {
      // A mounted but occluded view can stop producing compositor frames. Hold a
      // native capturer only for the screenshot/recording operation, never idle.
      if(t.crashed||wc.isDestroyed())throw new Error('BROWSER_PAGE_CRASHED: 截图页面已失效，请重新领取页面');
      if(!t.captureDepth)wc.beginFrameSubscription(true,()=>{});
      t.captureDepth=(t.captureDepth||0)+1;return {capturing:true};
    }
    else if(action==='capture.end') {
      t.captureDepth=Math.max(0,(t.captureDepth||0)-1);
      if(!t.captureDepth)wc.endFrameSubscription();return {capturing:Boolean(t.captureDepth)};
    }
    else if (action === 'activate') { this.active = t.id; this.mount(); }
    else if (action === 'navigate') { await wc.loadURL(webURL(args.url)); }
    else if (action === 'back') { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); }
    else if (action === 'forward') { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); }
    else if (action === 'reload') wc.reload();
    else if (action === 'attention') { t.attention = String(args.message || '页面需要检查').slice(0,200); t.attentionKind = args.kind || browserAttentionKind(t.attention); t.manualAttention = true; }
    else if (action === 'attention.check') await this.check(t, true);
    else if (action === 'tab.move') { const entries=[...this.tabs]; const i=entries.findIndex(([id])=>id===t.id); const [entry]=entries.splice(i,1); const j=entries.findIndex(([id])=>id===args.before); if(j<0)throw new Error('目标标签不存在'); entries.splice(j,0,entry); this.tabs=new Map(entries); this.persistTabs(); }
    else if (action === 'release') {
      if (args.discard || t.crashed) { this.discardAgent(t); return this.snapshot(); }
      if(t.captureDepth){wc.endFrameSubscription();t.captureDepth=0;}
      // A navigation can invalidate an earlier probe while release is waiting.
      // Inspect the current document before deciding whether its scene is disposable.
      await this.check(t, false, true);
      if (t.owner === 'agent') {
        const duplicate = [...this.tabs.values()].some(other => other !== t && other.owner === 'agent' && other.leased === false && attentionKey(other) === attentionKey(t) && retainBrowserAttention(other));
        t.leased = false;
        if (!retainBrowserAttention(t) || duplicate) wc.close();
      }
    }
    else if (action === 'close') wc.close();
    else throw new Error('未知浏览器操作');
    this.publish(); return this.snapshot();
  }
  async close({savedTabs} = {}) {
    clearInterval(this.timer); clearInterval(this.authTimer);
    // Closing during recovery must not replace saved user tabs with an empty,
    // not-yet-restored browser or only the background agent's temporary pages.
    if (Array.isArray(savedTabs)) { this.data.tabs = savedTabs; this.data.save(); }
    else this.persistTabs();
    for (const t of [...this.tabs.values()]) { t.view.webContents.removeAllListeners('destroyed'); t.view.webContents.close(); }
    this.tabs.clear(); session.fromPartition(this.partition).removeListener('will-download', this.downloadGuard);
    await session.fromPartition(this.partition).cookies.flushStore();
  }
}
module.exports = { BrowserManager, browserAttentionProbe, browserAttentionKind, retainBrowserAttention, noteBrowserResponse, applyBrowserAttention, attentionKey, boundedProbe };
