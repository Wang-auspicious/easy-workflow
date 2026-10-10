// Desktop capture leases the same persistent tabs shown in the built-in browser.
// The independent service uses a persistent Chromium profile with the same contract.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { emptyBrowser, type BrowserState } from "../shared/browser.ts";

const desktop = process.env.FACTORY_BROWSER_BRIDGE === "1" && Boolean(process.send);
const { BrowserData, webURL } = createRequire(import.meta.url)("../app/browser-data.cjs");
const profile = path.resolve(process.env.FACTORY_VAR || "var", "browser");
const data = desktop ? null : new BrowserData(path.join(profile, "browser.json"));
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
const pageIds = new WeakMap<Page, string>();
const tabs = new Map<string, { page: Page; owner: "user" | "agent"; attention?: string }>();
let state: BrowserState = { ...emptyBrowser(), ...(data ? { bookmarks: data.bookmarks, history: data.history, retentionDays: data.retentionDays } : {}) };
let context: Promise<BrowserContext> | null = null;
let connection: Promise<Browser> | null = null;
const titles = new Map<string,string>();
export const browserEvents = new Set<(state: BrowserState) => void>();
function publish(next: BrowserState) { state = next; for (const listener of browserEvents) listener(next); }

if (desktop) process.on("message", (message: any) => {
  if (message?.type === "browser:state") publish(message.state);
  if (message?.type === "browser:reply") { const p = pending.get(message.id); if (!p) return; clearTimeout(p.timer); pending.delete(message.id); message.error ? p.reject(new Error(message.error)) : p.resolve(message.result); }
});
function rpc(args: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("内置浏览器响应超时")); }, 25000);
    pending.set(id, { resolve, reject, timer });
    process.send!({ type: "browser:request", id, args }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
  });
}
function executable() { return [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"].find(p => p && fs.existsSync(p)); }
async function persistent(): Promise<BrowserContext> {
  if (!context) context = chromium.launchPersistentContext(path.join(profile, "profile"), { headless: true, executablePath: executable(), viewport: { width: 1280, height: 800 }, args: ["--hide-scrollbars", "--mute-audio"] }).then(async c => { for(const p of c.pages())if(p.url()==="about:blank")await p.close();c.on("close", () => { context = null; tabs.clear(); update(); }); return c; }).catch(error => { context = null; throw error; });
  return context;
}
function update() {
  if (desktop) return;
  publish({ mode: "headless", tabs: [...tabs].map(([id,t]) => ({ id, url:t.page.url(), title:titles.get(id) || "新标签页", loading:false, owner:t.owner, attention:t.attention })), active: state.active && tabs.has(state.active) ? state.active : tabs.keys().next().value ?? null, bookmarks:data.bookmarks, history:[...data.history].slice(-200).reverse(), retentionDays:data.retentionDays });
}
async function createHeadless(owner: "user" | "agent") {
  if (tabs.size >= 30) throw new Error("已有 30 个标签页，请先关闭不需要的页面");
  const c = await persistent(), page = await c.newPage(), id = crypto.randomUUID();
  tabs.set(id,{page,owner}); pageIds.set(page,id); state.active = id;
  page.on("close", () => { tabs.delete(id); titles.delete(id); update(); });
  page.on("domcontentloaded", async () => { const title = await page.title().catch(() => ""); titles.set(id,title); data.visit(page.url(),title); await checkHeadless(id); update(); });
  page.on("crash", () => { const t = tabs.get(id); if (t) { t.attention = "页面进程退出"; update(); } });
  update(); return { page, context:c, id };
}
async function checkHeadless(id:string) {
  const tab=tabs.get(id);if(!tab)return;
  const blocked=await tab.page.evaluate(()=>Boolean(document.querySelector('input[type="password"]')) || /sign in to continue|log in to view|登录后查看|captcha|人机验证/i.test((document.body?.innerText||"").slice(0,6000))).catch(()=>false);
  tab.attention=blocked?"登录或验证状态需要检查":undefined;
}

export async function browserCommand(args: Record<string, any>): Promise<any> {
  const action = args.action ?? "state";
  const allowed = ["state","read","open","activate","navigate","back","forward","reload","close","tab.move","bookmark.add","bookmark.remove","bookmark.move","history.prune","attention.check"];
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
    else if (action === "reload") { tab.attention = undefined; await tab.page.reload(); }
    else if (action === "attention.check") await checkHeadless(args.id);
    else if (action === "tab.move") {const entries=[...tabs];const i=entries.findIndex(([id])=>id===args.id);const [item]=entries.splice(i,1);const j=entries.findIndex(([id])=>id===args.before);if(j<0)throw new Error("目标标签不存在");entries.splice(j,0,item);tabs.clear();for(const [id,t] of entries)tabs.set(id,t);}
  }
  update(); return state;
}

export async function openPage(viewport = { width: 1280, height: 800 }, _locale = "en-US", signal?:AbortSignal): Promise<{ page: Page; context: BrowserContext; close: () => Promise<void> }> {
  signal?.throwIfAborted();
  const withCancellation=(page:Page, context:BrowserContext, release:()=>Promise<void>)=>{
    const abort=()=>{void page.close().catch(()=>{});};signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
    return {page,context,close:async()=>{signal?.removeEventListener("abort",abort);await release();}};
  };
  if (!desktop) {
    const t = await createHeadless("agent"); await t.page.setViewportSize(viewport);
    return withCancellation(t.page,t.context,async () => { if (!tabs.get(t.id)?.attention) await t.page.close().catch(() => {}); });
  }
  const lease = await rpc({ action:"lease" });
  try {
    if (!connection || !(await connection.catch(() => null))?.isConnected()) connection = chromium.connectOverCDP(lease.endpoint);
    const b = await connection;
    let page: Page | undefined;
    for (let i=0;i<40 && !page;i++) { page = b.contexts().flatMap(c => c.pages()).find(p => p.url() === lease.marker); if (!page) await new Promise(r => setTimeout(r,50)); }
    if (!page) throw new Error("无法挂载后台标签页");
    pageIds.set(page,lease.id); await page.setViewportSize(viewport);
    return withCancellation(page,page.context(),async () => { await rpc({action:"release",id:lease.id}).catch(() => {}); });
  } catch (error) { await rpc({action:"release",id:lease.id}).catch(() => {}); throw error; }
}

export async function browserAttention(page: Page, message: string) {
  const id = pageIds.get(page); if (!id) return;
  if (desktop) await rpc({action:"attention",id,message});
  else { const t = tabs.get(id); if (t) { t.attention = message; update(); } }
}
export async function closeBrowser() {
  if (!desktop) await (await context?.catch(() => null))?.close();
  if (connection) await (await connection.catch(() => null))?.close().catch(() => {});
  connection = null; context = null;
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("浏览器服务已关闭")); } pending.clear();
}
