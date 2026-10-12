// Desktop capture leases the same persistent tabs shown in the built-in browser.
// The independent service uses a persistent Chromium profile with the same contract.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { emptyBrowser, type BrowserState, type BrowserAttentionKind } from "../shared/browser.ts";

const desktop = process.env.FACTORY_BROWSER_BRIDGE === "1" && Boolean(process.send);
const { BrowserData, webURL } = createRequire(import.meta.url)("../app/browser-data.cjs");
const { browserAttentionProbe, browserAttentionKind, retainBrowserAttention, noteBrowserResponse, applyBrowserAttention, attentionKey, boundedProbe } = createRequire(import.meta.url)("../app/browser-manager.cjs");
const profile = path.resolve(process.env.FACTORY_VAR || "var", "browser");
const data = desktop ? null : new BrowserData(path.join(profile, "browser.json"));
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
const pageIds = new WeakMap<Page, string>();
const tabs = new Map<string, { page: Page; owner: "user" | "agent"; leased: boolean; attention?: string; attentionKind?: BrowserAttentionKind; checkSerial?: number; attentionCheck?: Promise<void>; documentUrl?: string; documentStatus?: number; denied?: Set<string>; manualAttention?: boolean }>();
let state: BrowserState = { ...emptyBrowser(), ...(data ? { bookmarks: data.bookmarks, history: data.history, retentionDays: data.retentionDays } : {}) };
let context: Promise<BrowserContext> | null = null;
let connection: Promise<Browser> | null = null;
const titles = new Map<string,string>();
export const browserEvents = new Set<(state: BrowserState) => void>();
function publish(next: BrowserState) { state = next; for (const listener of browserEvents) listener(next); }

export class BrowserPoolFault extends Error {
  code: string;
  mode: "desktop" | "headless";
  nextAction: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options); this.name = "BrowserPoolFault"; this.code = code;
    this.mode = desktop ? "desktop" : "headless";
    this.nextAction = desktop
      ? "当前浏览器处理已作废；运行时会重新连接桌面浏览器并领取新页。若两次自动恢复仍失败，请重启桌面应用后从当前工位继续；不会自动登录或绕过访问限制。"
      : "当前浏览器处理已作废；运行时会重建共享页面并从当前工位继续。若两次自动恢复仍失败，请检查浏览器安装、进程与内存后重试，保留已有成果。";
  }
}
export interface BrowserAttemptScope {
  signal: AbortSignal;
  usedBrowser: boolean;
  closed: boolean;
  fault?: BrowserPoolFault;
  invalidate(fault: BrowserPoolFault): void;
}
const attemptScopes = new AsyncLocalStorage<BrowserAttemptScope>();
const signalScopes = new WeakMap<AbortSignal, BrowserAttemptScope>();
const activeScopes = new Set<BrowserAttemptScope>();
export function browserAttemptScope(signal: AbortSignal, cancel: (fault: BrowserPoolFault) => void): BrowserAttemptScope {
  const scope: BrowserAttemptScope = { signal, usedBrowser: false, closed: false, invalidate(fault) {
    if (scope.closed || scope.fault || signal.aborted) return;
    scope.fault = fault; cancel(fault);
  } };
  signalScopes.set(signal, scope);
  return scope;
}
export async function withBrowserAttempt<T>(scope: BrowserAttemptScope, run: () => Promise<T>): Promise<T> {
  activeScopes.add(scope);
  try { return await attemptScopes.run(scope, run); }
  finally { scope.closed = true; activeScopes.delete(scope); signalScopes.delete(scope.signal); }
}
function poolFault(error: unknown, stage: "start" | "lease"): BrowserPoolFault | undefined {
  if (error instanceof BrowserPoolFault) return error;
  const text = String((error as Error)?.message ?? error);
  if (stage === "start") return new BrowserPoolFault("BROWSER_START_FAILED", "共享浏览器实例未能启动；请检查浏览器安装、进程或内存。", { cause: error });
  if (/BROWSER_[A-Z_]+|Target (?:page, context or browser has been closed|closed)|page (?:has )?crashed|browser (?:has )?(?:disconnected|closed)|Connection closed|无法挂载后台标签页|内置浏览器(?:响应超时|调试连接尚未就绪)|IPC channel|EPIPE|ECONNREFUSED|ECONNRESET|connectOverCDP|websocket/i.test(text)) {
    return new BrowserPoolFault(desktop ? "BROWSER_BRIDGE_UNAVAILABLE" : "BROWSER_POOL_CLOSED", desktop ? "桌面浏览器连接或租用页面已失效；需要重新建立连接。" : "共享浏览器连接或租用页面已失效；需要重新领取页面。", { cause: error });
  }
  return undefined;
}

if (desktop) process.on("message", (message: any) => {
  if (message?.type === "browser:state") publish(message.state);
  if (message?.type === "browser:reply") { const p = pending.get(message.id); if (!p) {
    // A lease that arrived after timeout/cancellation still owns a native page.
    if (message.result?.id && message.result?.marker) void rpc({action:'release',id:message.result.id,discard:true}).catch(() => {});
    return;
  } clearTimeout(p.timer); pending.delete(message.id); message.error ? p.reject(new Error(message.error)) : p.resolve(message.result); }
});
if (desktop) process.on("disconnect", () => {
  const fault = new BrowserPoolFault("BROWSER_BRIDGE_UNAVAILABLE", "桌面主进程的浏览器通道已断开；请重新打开桌面应用后继续当前工位。");
  for (const scope of activeScopes) if (scope.usedBrowser) scope.invalidate(fault);
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(fault); }
  pending.clear(); connection = null;
});
function rpc(args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    if (!process.connected) { reject(new BrowserPoolFault("BROWSER_BRIDGE_UNAVAILABLE", "桌面浏览器通道未连接；请重新打开桌面应用后继续当前工位。")); return; }
    const id = crypto.randomUUID();
    let done = false;
    const finish = (value: unknown, error = false) => {
      if (done) return; done = true;
      clearTimeout(timer); pending.delete(id); signal?.removeEventListener('abort', abort);
      error ? reject(value) : resolve(value);
    };
    const abort = () => finish(signal!.reason, true);
    const timer = setTimeout(() => finish(new Error("内置浏览器响应超时"),true), 25000);
    pending.set(id, { resolve:v=>finish(v), reject:e=>finish(e,true), timer });
    signal?.addEventListener('abort',abort,{once:true});
    process.send!({ type: "browser:request", id, args }, error => { if (error) finish(error,true); });
  });
}
function executable() { return [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"].find(p => p && fs.existsSync(p)); }
async function persistent(): Promise<BrowserContext> {
  if (!context) {
    const startup = chromium.launchPersistentContext(path.join(profile, "profile"), { headless: true, executablePath: executable(), viewport: { width: 1280, height: 800 }, args: ["--hide-scrollbars", "--mute-audio"] }).then(async c => {
      c.on("close", () => {
        if (context === startup) context = null;
        for (const [id, tab] of tabs) if (tab.page.context() === c) { tabs.delete(id); titles.delete(id); }
        update();
      });
      for (const p of c.pages()) if (p.url() === "about:blank") await p.close();
      return c;
    }).catch(error => { if (context === startup) context = null; throw poolFault(error, "start"); });
    context = startup;
  }
  return context;
}
function update() {
  if (desktop) return;
  publish({ mode: "headless", tabs: [...tabs].map(([id,t]) => ({ id, url:t.page.url(), title:titles.get(id) || "新标签页", loading:false, owner:t.owner, attention:t.attention, attentionKind:t.attentionKind })), active: state.active && tabs.has(state.active) ? state.active : tabs.keys().next().value ?? null, bookmarks:data.bookmarks, history:[...data.history].slice(-200).reverse(), retentionDays:data.retentionDays });
}
async function createHeadless(owner: "user" | "agent") {
  if (tabs.size >= 30) throw new Error("已有 30 个标签页，请先关闭不需要的页面");
  const c = await persistent(), page = await c.newPage(), id = crypto.randomUUID();
  tabs.set(id,{page,owner,leased:owner==="agent"}); pageIds.set(page,id); state.active = id;
  // BrowserContext does not automatically release popup pages with their opener.
  // Background scripts cannot allocate untracked pages outside the quota.
  if (owner === 'agent') {
    try { await page.addInitScript(() => { window.open = () => null; }); }
    catch (error) { tabs.delete(id); await page.close().catch(() => {}); update(); throw error; }
    page.on('popup', popup => { void popup.close().catch(() => {}); });
  }
  page.on("close", () => { tabs.delete(id); titles.delete(id); update(); });
  page.on("response", response => {
    const tab = tabs.get(id); if (!tab) return;
    try {
      const request = response.request(); if (request.frame() !== page.mainFrame()) return;
      if (noteBrowserResponse(tab, { url: response.url(), status: response.status(), mainFrame: request.isNavigationRequest(), resourceType: request.resourceType() })) { update(); void checkHeadless(id); }
    } catch { /* The response may outlive a detached frame. */ }
  });
  page.on("framenavigated", frame => { const tab = tabs.get(id); if (tab && frame === page.mainFrame()) tab.checkSerial = (tab.checkSerial ?? 0) + 1; });
  page.on("domcontentloaded", async () => { const url = page.url(), title = await page.title().catch(() => ""); if (page.isClosed() || page.url() !== url) return; titles.set(id,title); data.visit(url,title); await checkHeadless(id); update(); });
  page.on("crash", () => { const t = tabs.get(id); if (t) { t.attention = "页面进程退出"; t.attentionKind = "crash"; update(); } });
  update(); return { page, context:c, id };
}
async function checkHeadless(id:string, manualCheck = false) {
  const tab=tabs.get(id);if(!tab)return;
  if (tab.attentionCheck) { await tab.attentionCheck; if (!manualCheck) return; }
  const check = (tab.attentionCheck ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (!tabs.has(id) || tab.page.isClosed()) return;
    const serial = tab.checkSerial = (tab.checkSerial ?? 0) + 1, url = tab.page.url();
    const probe = await boundedProbe(tab.page.evaluate(browserAttentionProbe));
    if (!tabs.has(id) || serial !== tab.checkSerial || tab.page.isClosed() || tab.page.url() !== url) return;
    applyBrowserAttention(tab, probe, url, false, manualCheck);
    update();
  });
  tab.attentionCheck = check;
  try { await check; } finally { if (tab.attentionCheck === check) tab.attentionCheck = undefined; }
}

export async function browserCommand(args: Record<string, any>): Promise<any> {
  const action = args.action ?? "state";
  const allowed = ["state","read","open","activate","navigate","back","forward","reload","close","tab.move","bookmark.add","bookmark.update","bookmark.remove","bookmark.move","history.prune","attention.check"];
  if (!allowed.includes(action)) throw new Error("未知浏览器操作");
  if (args.url !== undefined) args.url = webURL(args.url);
  if (action === "read") {
    let page = tabs.get(args.id)?.page;
    if (desktop) {
      const target=await rpc({action:"target",id:args.id});
      if (!connection || !(await connection.catch(()=>null))?.isConnected()) connection=chromium.connectOverCDP(target.endpoint);
      for (const p of (await connection).contexts().flatMap(c=>c.pages())) { const s=await p.context().newCDPSession(p); try { if((await s.send("Target.getTargetInfo")).targetInfo.targetId===target.targetId) {page=p;break;} } finally {await s.detach();} }
    }
    if (!page) throw new Error("找不到标签页");
    return {id:args.id,url:page.url(),title:await page.title(),text:(await page.locator("body").innerText({timeout:5000})).slice(0,30000)};
  }
  if (desktop) return rpc({...args, action});
  if (action === "state") { data.prune(); update(); return state; }
  if (action.startsWith("bookmark.") || action === "history.prune") data.change(action,args);
  else if (action === "open") { const t = await createHeadless("user"); if (args.url) await t.page.goto(args.url, {waitUntil:"domcontentloaded"}); }
  else { const tab = tabs.get(args.id); if (!tab) throw new Error("标签页已经关闭");
    if (action === "close") await tab.page.close();
    else if (action === "activate") state.active = args.id;
    else if (action === "navigate") await tab.page.goto(args.url,{waitUntil:"domcontentloaded"});
    else if (action === "back") await tab.page.goBack();
    else if (action === "forward") await tab.page.goForward();
    else if (action === "reload") await tab.page.reload();
    else if (action === "attention.check") await checkHeadless(args.id, true);
    else if (action === "tab.move") {const entries=[...tabs];const i=entries.findIndex(([id])=>id===args.id);const [item]=entries.splice(i,1);const j=entries.findIndex(([id])=>id===args.before);if(j<0)throw new Error("目标标签不存在");entries.splice(j,0,item);tabs.clear();for(const [id,t] of entries)tabs.set(id,t);}
  }
  update(); return state;
}

export async function openPage(viewport = { width: 1280, height: 800 }, _locale = "en-US", signal?:AbortSignal): Promise<{ page: Page; context: BrowserContext; close: () => Promise<void> }> {
  signal?.throwIfAborted();
  const scope = attemptScopes.getStore() ?? (signal ? signalScopes.get(signal) : undefined);
  if (scope) { scope.usedBrowser = true; scope.signal.throwIfAborted(); }
  const withCancellation=(page:Page, context:BrowserContext, release:()=>Promise<void>)=>{
    let released = false;
    const browser = context.browser();
    const failed = (code: string, message: string) => { if (!released && !signal?.aborted) scope?.invalidate(new BrowserPoolFault(code, message)); };
    const crash = () => failed("BROWSER_PAGE_CRASHED", "共享浏览器标签进程崩溃，当前处理已作废。");
    const closed = () => failed("BROWSER_POOL_CLOSED", "共享浏览器页面或连接意外关闭，当前处理已作废。");
    const disconnected = () => { if (desktop) connection = null; failed("BROWSER_POOL_CLOSED", "共享浏览器进程或调试连接断开，当前处理已作废。"); };
    const unwatch = () => { released = true; page.off("crash", crash); page.off("close", closed); context.off("close", closed); browser?.off("disconnected", disconnected); signal?.removeEventListener("abort", abort); };
    const abort=()=>{unwatch();void page.close().catch(()=>{});};
    page.on("crash", crash); page.on("close", closed); context.on("close", closed); browser?.on("disconnected", disconnected);
    signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
    let closing: Promise<void> | undefined;
    return {page,context,close:()=>{unwatch();return closing ??= release();}};
  };
  try { if (!desktop) {
    const t = await createHeadless("agent");
    try { signal?.throwIfAborted(); await t.page.setViewportSize(viewport); }
    catch (error) { await t.page.close().catch(() => {}); throw error; }
    return withCancellation(t.page,t.context,async () => {
      await checkHeadless(t.id);
      const tab = tabs.get(t.id); if (!tab) return;
      const duplicate = [...tabs.values()].some(other => other !== tab && other.owner === "agent" && !other.leased && attentionKey({...other,url:other.page.url()}) === attentionKey({...tab,url:tab.page.url()}) && retainBrowserAttention(other));
      tab.leased = false;
      if (!retainBrowserAttention(tab) || duplicate) await t.page.close().catch(() => {});
    });
  }
  const lease = await rpc({ action:"lease" }, signal);
  try {
    if (!connection || !(await connection.catch(() => null))?.isConnected()) connection = chromium.connectOverCDP(lease.endpoint);
    const b = await connection;
    let page: Page | undefined;
    for (let i=0;i<40 && !page;i++) { page = b.contexts().flatMap(c => c.pages()).find(p => p.url() === lease.marker); if (!page) await new Promise(r => setTimeout(r,50)); }
    if (!page) throw new Error("无法挂载后台标签页");
    pageIds.set(page,lease.id); await page.setViewportSize(viewport);
    return withCancellation(page,page.context(),async () => { await rpc({action:"release",id:lease.id,discard:Boolean(scope?.fault || signal?.aborted)}).catch(() => {}); });
  } catch (error) { await rpc({action:"release",id:lease.id,discard:true}).catch(() => {}); throw error; }
  } catch (error) {
    if (signal?.aborted && !scope?.fault) throw error;
    const fault = poolFault(error, "lease");
    if (fault) { scope?.invalidate(fault); throw fault; }
    throw error;
  }
}

export async function inspectBrowserAttention(page: Page): Promise<{ url: string; issue: string; kind?: BrowserAttentionKind }> {
  return page.evaluate(browserAttentionProbe);
}

export async function browserAttention(page: Page, message: string, kind?: BrowserAttentionKind) {
  const id = pageIds.get(page); if (!id) return;
  kind ??= browserAttentionKind(message);
  if (desktop) await rpc({action:"attention",id,message,kind});
  else { const t = tabs.get(id); if (t) { t.attention = message; t.attentionKind = kind; t.manualAttention = true; update(); } }
}
/** Hold real compositor frames while capturing an occluded native task page. */
export async function withBrowserFrames<T>(page:Page, capture:()=>Promise<T>):Promise<T> {
  const id=pageIds.get(page);
  if(!desktop||!id)return capture();
  await rpc({action:"capture.begin",id});
  try{return await capture();}
  finally{await rpc({action:"capture.end",id}).catch(()=>{});}
}
export async function closeBrowser() {
  if (!desktop) await (await context?.catch(() => null))?.close();
  if (connection) await (await connection.catch(() => null))?.close().catch(() => {});
  connection = null; context = null;
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("浏览器服务已关闭")); } pending.clear();
}
