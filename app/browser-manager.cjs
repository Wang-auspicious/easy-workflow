// One persistent browser shared by the owner and every capture worker.
const { WebContentsView, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { BrowserData, webURL } = require('./browser-data.cjs');

class BrowserManager {
  constructor(profile, notify, secureSession) {
    this.profile = profile; this.notify = notify; this.secureSession = secureSession;
    this.data = new BrowserData(path.join(profile, 'browser.json'));
    this.tabs = new Map(); this.active = null; this.window = null; this.bounds = null; this.mounted = null;
    this.partition = 'persist:h2-browser'; this.secureSession(session.fromPartition(this.partition));
    this.timer = setInterval(() => { this.data.prune(); this.data.save(); this.publish(); }, 3600000); this.timer.unref();
    this.authTimer = setInterval(() => { for(const t of this.tabs.values())if(!t.loading)void this.check(t); },30000);this.authTimer.unref();
    session.fromPartition(this.partition).webRequest.onCompleted(details=>{
      const t=[...this.tabs.values()].find(t=>t.view.webContents.id===details.webContentsId);
      if(!t||!['mainFrame','xhr'].includes(details.resourceType))return;
      try{if(new URL(details.url).hostname!==new URL(t.url).hostname)return;}catch{return;}
      t.denied ??= new Set();const key=details.url.split('?')[0];
      if([401,403].includes(details.statusCode)){t.denied.add(key);t.attention=`授权请求失败（${details.statusCode}），请检查登录或验证状态`;this.publish();}
      else if(details.statusCode>=200&&details.statusCode<400&&t.denied.delete(key))void this.check(t);
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
  snapshot() { return { mode: 'desktop', tabs: [...this.tabs.values()].map(t => ({ id: t.id, url: t.url, title: t.title, owner: t.owner, loading: t.loading, attention: t.attention, canGoBack: !t.view.webContents.isDestroyed() && t.view.webContents.navigationHistory.canGoBack(), canGoForward: !t.view.webContents.isDestroyed() && t.view.webContents.navigationHistory.canGoForward() })), active: this.active, bookmarks: this.data.bookmarks, history: this.data.history.slice(-200).reverse(), retentionDays: this.data.retentionDays }; }
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
    const t = { id, view, url, title: url === 'about:blank' ? '新标签页' : new URL(url).hostname, owner, loading: false, attention: undefined };
    this.tabs.set(id,t); view.setBounds({x:0,y:0,width:1280,height:800});
    view.setVisible(false);
    // Detached WebContentsViews can navigate but have no composited frame to capture.
    // Keep pages attached but hidden; the scoped native capturer supplies frames.
    this.window?.contentView.addChildView(view,0);
    const wc = view.webContents;
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(({url}) => { try { this.create(url, 'user'); } catch {} return {action:'deny'}; });
    wc.on('will-navigate', (event, url) => { try { webURL(url); } catch { event.preventDefault(); } });
    wc.on('did-start-loading', () => { t.loading = true; this.publish(); });
    wc.on('did-stop-loading', () => { t.loading = false; this.publish(); });
    wc.on('page-title-updated', (_e,title) => { t.title = wc.getURL().startsWith('about:') ? '新标签页' : title || t.title; const visit=[...this.data.history].reverse().find(h=>h.url===wc.getURL()); if(visit){visit.title=t.title;this.data.save();} this.publish(); });
    const navigated = () => { t.url = wc.getURL(); t.title = t.url.startsWith('about:') ? '新标签页' : wc.getTitle() || t.title; this.data.visit(t.url,t.title); this.persistTabs(); this.publish(); void this.check(t); };
    wc.on('did-navigate', navigated); wc.on('did-navigate-in-page', navigated); wc.on('did-finish-load', () => void this.check(t));
    wc.on('did-fail-load', (_e,code,description,_url,main) => { if (main && code !== -3) { t.attention = `页面加载失败：${description}`; this.publish(); } });
    wc.on('render-process-gone', () => { t.attention = '页面进程已退出，点击重新加载'; t.loading = false; this.publish(); });
    wc.once('destroyed', () => { this.tabs.delete(id); if (this.active === id) this.active = this.tabs.keys().next().value ?? null; this.mount(); this.publish(); this.persistTabs(); });
    if (owner === 'user' || !this.active) this.active = id;
    // The marker lets Playwright find precisely this page, never a user's other tab.
    t.ready = wc.loadURL(url === 'about:blank' ? `about:blank#h2-${id}` : url).catch(error => { t.attention = error.message; this.publish(); });
    this.mount(); this.publish(); return t;
  }
  async check(t) {
    const wc = t.view.webContents; if (wc.isDestroyed() || !/^https?:/.test(wc.getURL())) return;
    const serial=t.checkSerial=(t.checkSerial||0)+1, url=wc.getURL();
    const issue = await wc.executeJavaScript(`(() => { const text = (document.body?.innerText || '').slice(0, 6000); const password = [...document.querySelectorAll('input[type=password]')].some(e => e.getBoundingClientRect().width > 0); if (/verify you are human|checking your browser|captcha|人机验证|安全验证/i.test(text)) return '页面需要完成验证'; if (password || /sign in to continue|log in to view|登录后查看|登录后继续/i.test(text) || /\\/(?:login|signin|sign-in)(?:[/?#]|$)|\\/i\\/flow\\/login|\\/i\\/[^/]*onboarding/i.test(location.href)) return '登录状态需要检查'; return ''; })()`).catch(() => '');
    if (!this.tabs.has(t.id)||serial!==t.checkSerial||wc.isDestroyed()||wc.getURL()!==url) return;
    if (issue) t.attention = issue;
    else if (!wc.isLoading()&&!t.denied?.size) t.attention = undefined;
    this.publish();
  }
  async endpoint() {
    for (let i=0;i<50;i++) { try { const lines = fs.readFileSync(path.join(this.profile, 'DevToolsActivePort'),'utf8').trim().split(/\r?\n/); const port = Number(lines[0]); if (port > 0 && lines[1]?.startsWith('/devtools/browser/')) return `http://127.0.0.1:${port}`; } catch {} await new Promise(r=>setTimeout(r,100)); }
    throw new Error('内置浏览器调试连接尚未就绪');
  }
  async command(args) {
    const action = args.action;
    if (action === 'state') return this.snapshot();
    if (action === 'target') {
      const t=this.tabs.get(args.id); if(!t)throw new Error('标签页已经关闭');
      const debug=t.view.webContents.debugger, own=!debug.isAttached();
      try {if(own)debug.attach('1.3');const result=await debug.sendCommand('Target.getTargetInfo');return {endpoint:await this.endpoint(), targetId:result.targetInfo.targetId};} finally {if(own&&debug.isAttached())debug.detach();}
    }
    if (action === 'lease') { const t = this.create('about:blank','agent'); await t.ready; return { id:t.id, marker:`about:blank#h2-${t.id}`, endpoint:await this.endpoint() }; }
    if (action === 'open') { this.create(args.url || 'about:blank'); return this.snapshot(); }
    if (action.startsWith('bookmark.') || action === 'history.prune') { this.data.change(action,args); this.publish(); return this.snapshot(); }
    const t = this.tabs.get(args.id); if (!t) throw new Error('标签页已经关闭');
    const wc = t.view.webContents;
    if (action === 'capture.begin') {
      // A mounted but occluded view can stop producing compositor frames. Hold a
      // native capturer only for the screenshot/recording operation, never idle.
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
    else if (action === 'reload') { t.attention = undefined; wc.reload(); }
    else if (action === 'attention') t.attention = String(args.message || '页面需要检查').slice(0,200);
    else if (action === 'attention.check') await this.check(t);
    else if (action === 'tab.move') { const entries=[...this.tabs]; const i=entries.findIndex(([id])=>id===t.id); const [entry]=entries.splice(i,1); const j=entries.findIndex(([id])=>id===args.before); if(j<0)throw new Error('目标标签不存在'); entries.splice(j,0,entry); this.tabs=new Map(entries); this.persistTabs(); }
    else if (action === 'release') { if(t.captureDepth){wc.endFrameSubscription();t.captureDepth=0;} if (!t.attention) wc.close(); }
    else if (action === 'close') wc.close();
    else throw new Error('未知浏览器操作');
    this.publish(); return this.snapshot();
  }
  async close() { clearInterval(this.timer);clearInterval(this.authTimer); this.persistTabs(); for (const t of [...this.tabs.values()]) { t.view.webContents.removeAllListeners('destroyed'); t.view.webContents.close(); } this.tabs.clear(); await session.fromPartition(this.partition).cookies.flushStore(); }
}
module.exports = { BrowserManager };
