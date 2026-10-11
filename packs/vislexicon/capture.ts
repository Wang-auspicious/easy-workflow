// Browser capture steps, ported from VisLexicon `scripts/preview/capture-shots.mjs` and
// `record-scroll.mjs` and split per station (Spec §8 ⑥⑦⑧⑨). Rules come from
// `preview-rules.json`; read-only browsing: never accept cookies, log in or fill forms.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Page } from "playwright-core";
import { aHash, hamming, imageStats } from "../../server/evidence.ts";
import { PREVIEW_RULES } from "./env.ts";
import { browserAttention, withBrowserFrames } from "../../server/browser.ts";
import { ClassifiedFailure, classifyFailure } from "../../shared/failures.ts";

export const VIEW = { width: PREVIEW_RULES.viewport.width, height: PREVIEW_RULES.viewport.height };
const DECLINE = /^(reject|decline|deny|refuse|necessary only|only necessary|essential only|required only|only required|use necessary cookies only|continue without accepting|拒绝|仅必要|仅限必要|不同意)/i;
export const STAGE_SELECTORS: string[] = PREVIEW_RULES.kinds["component-source"]?.roles.proof?.stageSelectors ?? ["[class*=preview]", "[class*=demo]", "iframe"];
/** Query/hash routers identify distinct rendered pages, not tracking noise. */
export function pageKey(href:string) {try{const u=new URL(href);for(const k of [...u.searchParams.keys()])if(/^utm_|^(ref|fbclid|gclid)$/i.test(k))u.searchParams.delete(k);u.searchParams.sort();if(!/^#(?:\/|!)/.test(u.hash))u.hash="";return u.origin+u.pathname.replace(/\/+$/,"")+u.search+u.hash;}catch{return href;}}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const runFile = promisify(execFile);

export interface Link { href: string; text: string; inNav: boolean; inMain: boolean; hasImage: boolean; visible: boolean; order: number }

export async function pageVerdict(page: Page, entryHost: string): Promise<string[]> {
  return page.evaluate(({ entryHost }) => {
    const text = (document.body?.innerText || "").slice(0, 4000);
    const issues: string[] = [];
    if (/\b404\b|not found|page not found|找不到页面/i.test(document.title + " " + text.slice(0, 400))) issues.push("notFound");
    const shown = (el: Element) => (el as HTMLElement).checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? (el as HTMLElement).offsetParent !== null;
    const pw = [...document.querySelectorAll("input[type=password]")].some((el) => { const r = el.getBoundingClientRect(); return shown(el) && r.width > 0 && r.top < innerHeight; });
    if (pw || /sign in to continue|log in to view|登录后查看/i.test(text)) issues.push("loginWall");
    if (/verify you are human|checking your browser|captcha|人机验证/i.test(text)) issues.push("challenge");
    if (/^\s*(loading|加载中)[.…]*\s*$/i.test(text)) issues.push("loading");
    const host = location.hostname.replace(/^www\./, "");
    if (!(host === entryHost || host.endsWith("." + entryHost) || entryHost.endsWith("." + host))) issues.push("offSite");
    const vw = innerWidth * innerHeight;
    const cover = [...document.querySelectorAll("body *")].filter((el) => {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" || !shown(el)) return false;
      const r = el.getBoundingClientRect();
      const own = ((el as HTMLElement).innerText || "").slice(0, 900);
      return r.width * r.height > 0.25 * vw && own.length < 800 && /cookie|consent|gdpr|同意.*(cookie|隐私)/i.test(own + " " + el.id + " " + String((el as HTMLElement).className));
    });
    if (cover.length) issues.push("consentOverlay");
    return issues;
  }, { entryHost });
}

export async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let timer = setTimeout(done, 1500);
      const stop = setTimeout(done, 6000);
      const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 1500); });
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      function done() { mo.disconnect(); clearTimeout(stop); resolve(); }
    });
  }).catch(() => {});
}

async function declineCookies(page: Page) {
  return page.evaluate((source) => {
    const re = new RegExp(source, "i");
    const button = [...document.querySelectorAll("button, [role=button], a")].find((el) => re.test(((el as HTMLElement).innerText || "").trim())) as HTMLElement | undefined;
    if (button) { button.click(); return button.innerText.trim(); }
    return null;
  }, DECLINE.source).catch(() => null);
}

/** Hides sticky bars, chat bubbles and consent bars without a decline button (visibility only; nothing is clicked or accepted). */
async function hideFloating(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const hidden: string[] = [];
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "sticky") continue;
      const r = el.getBoundingClientRect();
      const own = ((el as HTMLElement).innerText || "").slice(0, 1500);
      const cls = String((el as HTMLElement).className);
      const consent = /cookie|consent|gdpr/i.test(own + " " + el.id + " " + cls) && own.length < 1500 && !el.querySelector("nav, main");
      const chat = consent || /intercom|crisp|drift|chat|hubspot|tawk|truste|onetrust|cookie/i.test(el.id + " " + cls);
      if (chat || (r.top > innerHeight * 0.5 && r.height < 200)) { (el as HTMLElement).style.setProperty("visibility", "hidden", "important"); hidden.push(el.tagName.toLowerCase() + (el.id ? "#" + el.id : "")); }
    }
    return hidden;
  }).catch(() => []);
}

export async function links(page: Page): Promise<Link[]> {
  const found=await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a, order) => {
    const r = a.getBoundingClientRect();
    return {
      href: (a as HTMLAnchorElement).href,
      text: (((a as HTMLElement).innerText || a.getAttribute("aria-label") || "").trim()).slice(0, 60),
      inNav: Boolean(a.closest("header, nav, [role=navigation]")),
      inMain: Boolean(a.closest("main, [role=main], article")) && !a.closest("header, nav, footer, aside"),
      hasImage: Boolean(a.querySelector("img, picture, video, canvas, svg")),
      visible: r.width > 0 && r.height > 0,
      order,
    };
  })).catch(() => []);
  const stories=await page.evaluate(async()=>{
    if(!document.querySelector('#storybook-preview-iframe')&&!document.title.toLowerCase().includes('storybook'))return [];
    const base=new URL(location.href);base.search="";base.hash="";if(!base.pathname.endsWith('/')&&!base.pathname.endsWith('.html'))base.pathname+='/';
    for(const file of ['index.json','stories.json'])try{
      const r=await fetch(new URL(file,base),{signal:AbortSignal.timeout(3000)});if(!r.ok)continue;
      const body=await r.json();const entries=Object.values(body.entries??body.stories??{}) as {id:string;title:string;name:string;type?:string}[];
      return entries.filter(e=>typeof e.id==='string'&&/^[a-z0-9_-]+$/i.test(e.id)).slice(0,160).map(e=>{
        const u=new URL(e.type==='docs'?'./':'iframe.html',base);
        if(e.type==='docs')u.searchParams.set('path',`/docs/${e.id}`);else{u.searchParams.set('id',e.id);u.searchParams.set('viewMode','story');}
        return {href:u.href,text:`${e.title} ${e.name}`,inNav:true,inMain:e.type!=='docs',hasImage:false,visible:false,order:0};
      });
    }catch{}
    return [];
  }).catch(()=>[]);
  return [...found,...stories].filter((l,i,all)=>all.findIndex(a=>pageKey(a.href)===pageKey(l.href))===i);
}

export function sameSite(href: string, entryHost: string) {
  try { const host = new URL(href).hostname.replace(/^www\./, ""); return host === entryHost || host.endsWith("." + entryHost); } catch { return false; }
}

/** Path / link text scoring: path rule +3 (earlier rules weigh more), link text +2, nav +1, shorter paths win. */
export function scoreLinks(candidates: Pick<Link, "href" | "text" | "inNav">[], role: { pathPatterns?: string[]; linkText?: string[] }) {
  const pathRes = (role.pathPatterns || []).map((p) => new RegExp(p, "i"));
  const texts = (role.linkText || []).map((t) => t.toLowerCase());
  const seen = new Map<string, { href: string; score: number; reasons: string[]; text: string }>();
  for (const link of candidates) {
    let url: URL;
    try { url = new URL(link.href); } catch { continue; }
    if (/\.(pdf|zip|png|jpe?g|svg|mp4)$/i.test(url.pathname)) continue;
    const reasons: string[] = [];
    let score = 0;
    const hit = pathRes.findIndex((re) => re.test(url.pathname+(url.searchParams.get('path')??'')));
    if (hit >= 0) { score += 3 + (pathRes.length - hit) * 0.2; reasons.push(`path#${hit + 1}`); }
    const text = link.text.toLowerCase();
    if (texts.some((t) => text === t || text.startsWith(t + " ") || text.endsWith(" " + t))) { score += 2; reasons.push("text"); }
    if (!score) continue;
    if (link.inNav) { score += 1; reasons.push("nav"); }
    score -= url.pathname.split("/").filter(Boolean).length * 0.25;
    const key = pageKey(url.href);
    if (!seen.has(key) || seen.get(key)!.score < score) seen.set(key, { href: key, score: Number(score.toFixed(2)), reasons, text: link.text });
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

export async function visit(page: Page, url: string, entryHost: string, say?: (t: string) => void) {
  say?.(`打开 ${url.replace(/^https?:\/\//, "")}`);
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 }).catch((error: Error) => ({ error }));
  if (response && "error" in response) throw new ClassifiedFailure(classifyFailure(response.error,{url}));
  if (response && response.status() >= 400) {
    if ([401,403].includes(response.status())) await browserAttention(page, `访问被拒绝（${response.status()}），请检查登录或验证状态`);
    throw new ClassifiedFailure(classifyFailure(`HTTP ${response.status()}`,{url,status:response.status()}));
  }
  await settle(page);
  const declined = await declineCookies(page);
  if (declined) say?.(`Cookie 只点了“${declined}”`);
  await sleep(400);
  const hidden = await hideFloating(page);
  const issues = await pageVerdict(page, entryHost);
  if (issues.includes("loginWall") || issues.includes("challenge")) { await browserAttention(page, issues.includes("loginWall") ? "登录状态需要检查" : "页面需要完成验证"); throw new Error("页面需要登录或验证，已保留在内置浏览器"); }
  return { issues, hidden };
}

export async function shoot(page: Page, clip?: { x: number; y: number; width: number; height: number }) {
  return withBrowserFrames(page,async()=>{
    if(!clip)return page.screenshot({fullPage:false});
    // Full-page capture can reposition responsive/sticky content after the DOM
    // coordinates were measured. Crop the real viewport pixels instead, and tile
    // taller stages without changing viewport dimensions or reflowing the page.
    const original=await page.evaluate(()=>({x:scrollX,y:scrollY}));
    const width=Math.round(clip.width),height=Math.round(clip.height);
    if(width<1||height<1||width*height>16_000_000)throw new Error('截图裁剪范围无效或过大');
    const pixels=Buffer.alloc(width*height*4);
    try{
      for(let dy=0;dy<height;){
        let rowHeight=height-dy;
        for(let dx=0;dx<width;){
          const x=Math.round(clip.x)+dx,y=Math.round(clip.y)+dy;
          const view=await page.evaluate(async({x,y})=>{window.scrollTo(Math.max(0,x-32),Math.max(0,y-Math.min(160,innerHeight/4)));await new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())));return {x:scrollX,y:scrollY,w:innerWidth,h:innerHeight};},{x,y});
          const sx=Math.round(x-view.x),sy=Math.round(y-view.y);
          const w=Math.min(width-dx,view.w-sx),h=Math.min(height-dy,view.h-sy);
          if(sx<0||sy<0||w<1||h<1)throw new Error('舞台裁剪超出页面范围');
          const viewport=await page.screenshot({fullPage:false,scale:'css'});
          const raw=execFileSync('ffmpeg',['-loglevel','error','-f','image2pipe','-i','pipe:0','-vf',`scale=${view.w}:${view.h}`,'-f','rawvideo','-pix_fmt','rgba','pipe:1'],{input:viewport,maxBuffer:1<<26});
          for(let row=0;row<h;row++)raw.copy(pixels,((dy+row)*width+dx)*4,((sy+row)*view.w+sx)*4,((sy+row)*view.w+sx+w)*4);
          dx+=w;rowHeight=Math.min(rowHeight,h);
        }
        dy+=rowHeight;
      }
      return execFileSync('ffmpeg',['-loglevel','error','-f','rawvideo','-pix_fmt','rgba','-s',`${width}x${height}`,'-i','pipe:0','-frames:v','1','-f','image2','-c:v','png','pipe:1'],{input:pixels,maxBuffer:1<<26});
    }finally{await page.evaluate(p=>window.scrollTo(p.x,p.y),original).catch(()=>{});}
  });
}

export function checkImage(png: Buffer, others: string[], { stage = false } = {}) {
  const issues: string[] = [];
  const stats = imageStats(png);
  if (stats.std < 6 || stats.content < 0.02) issues.push(`blank(std ${stats.std.toFixed(1)}, content ${(stats.content * 100).toFixed(1)}%)`);
  else if (stage && stats.content < 0.03) issues.push(`stage-nearly-empty(${(stats.content * 100).toFixed(1)}%)`);
  if (stats.flatBlock) issues.push("flat-block");
  const hash = aHash(png);
  for (const other of others) if (other && hamming(hash, other) <= 6) issues.push("duplicate");
  return { issues, stats, hash };
}

export async function motionFirst(page: Page) {
  return page.evaluate(() => {
    const vw = innerWidth * innerHeight;
    const big = [...document.querySelectorAll("canvas, video")].some((el) => { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.width * r.height >= 0.5 * vw; });
    return { scrollHijacked: document.documentElement.scrollHeight <= innerHeight * 1.2, canvasHero: big };
  }).catch(() => ({ scrollHijacked: false, canvasHero: false }));
}

export async function previewsInViewport(page: Page) {
  return page.evaluate((selectors) => selectors.reduce((n, sel) => {
    try { return n + [...document.querySelectorAll(sel)].filter((el) => { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.width > 80 && r.height > 60; }).length; } catch { return n; }
  }, 0) + [...document.querySelectorAll("main img, main canvas, main video")].filter((el) => el.getBoundingClientRect().top < innerHeight).length, STAGE_SELECTORS).catch(() => 0);
}

/* ------------------------------------------------------------------ stage (component close-up) */

export interface Stage { sel: string; x: number; y: number; w: number; h: number; painted: number; media: number; locked: boolean }

export async function findStage(page: Page): Promise<Stage | null> {
  return page.evaluate((selectors) => {
    const seen = new Set<Element>();
    const boxes: Stage[] = [];
    const roots:(Document|ShadowRoot)[]=[document];
    for(let i=0;i<roots.length;i++)for(const el of roots[i].querySelectorAll('*'))if(el.shadowRoot)roots.push(el.shadowRoot);
    // Documentation frameworks often put an unnamed live example directly before
    // its code block. Recognise that relationship, without treating docs text or
    // the code toolbar itself as a rendered component.
    const examples=new Set<Element>();
    for(const pre of document.querySelectorAll('main pre,article pre')){
      let block:Element|null=pre;
      for(let depth=0;block&&depth<3;depth++,block=block.parentElement){
        const preview=block.previousElementSibling;
        if(!preview||!preview.matches('div,section')||preview.querySelector('pre,code,h1,h2,h3'))continue;
        const rendered=[...preview.querySelectorAll('*')].filter(el=>{
          const r=el.getBoundingClientRect(),style=getComputedStyle(el);
          return r.width>20&&r.height>20&&(el.matches('button,input,select,canvas,svg,iframe')||!['transparent','rgba(0, 0, 0, 0)'].includes(style.backgroundColor));
        });
        if(rendered.length)examples.add(preview);
      }
    }
    for (const sel of ["example-before-code", ".bd-example", "[data-preview]", ".sp-preview-container", ".sp-preview-iframe", "#storybook-root", "#root > .sb-story", "canvas", "svg", "[class*=playground]", ...selectors]) {
      let found: Element[] = [];
      try { found = sel==='example-before-code'?[...examples]:roots.flatMap(root=>[...root.querySelectorAll(sel)]); } catch { continue; }
      for (const el of found) {
        if (seen.has(el) || el.closest("nav, header, footer, aside, pre, code")) continue;
        seen.add(el);
        const r = el.getBoundingClientRect();
        if (r.width < 80 || r.height < 24 || r.height > innerHeight * 1.5 || getComputedStyle(el).visibility==="hidden") continue;
        const painted = el.querySelectorAll("*").length;
        const media = el.querySelectorAll("canvas, img, svg, video").length + (el.matches("iframe,canvas,img,svg,video") ? 1 : 0);
        if (painted < 1 && !media && !el.matches("button,input,[role=button]")) continue;
        if (el.querySelector("pre,code") && !el.matches(".bd-example,[data-preview],#storybook-root")) continue;
        const locked = /\b(pro|upgrade|unlock)\b|会员/i.test(((el as HTMLElement).innerText || "").slice(0, 200)) && el.querySelectorAll("svg").length > 0 && painted < 12;
        boxes.push({ sel, x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, painted, media, locked });
      }
    }
    boxes.sort((a, b) => (a.y<innerHeight?0:1)-(b.y<innerHeight?0:1) || b.w*b.h-a.w*a.h);
    return boxes.find((b) => !b.locked) || null;
  }, STAGE_SELECTORS).catch(() => null);
}

export function stageClip(stage: Stage, pageWidth: number) {
  const pad = 16;
  const x = Math.max(0, Math.round(stage.x - pad));
  const y = Math.max(0, Math.round(stage.y - pad));
  return { x, y, width: Math.round(Math.min(stage.w + pad * 2, pageWidth - x)), height: Math.round(stage.h + pad * 2) };
}

/** Border colour = the mode of the outermost pixel ring (works for oklch pages too). */
function borderColor(png: Buffer, width: number, height: number) {
  const rgb = execFileSync("ffmpeg", ["-loglevel", "error", "-f", "image2pipe", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { input: png, maxBuffer: 1 << 26 });
  const counts = new Map<number, { n: number; c: number[] }>();
  const add = (x: number, y: number) => {
    const i = (y * width + x) * 3;
    const key = ((rgb[i] >> 3) << 10) | ((rgb[i + 1] >> 3) << 5) | (rgb[i + 2] >> 3);
    const entry = counts.get(key) || { n: 0, c: [rgb[i], rgb[i + 1], rgb[i + 2]] };
    entry.n++;
    counts.set(key, entry);
  };
  for (let x = 0; x < width; x += 2) { add(x, 1); add(x, height - 2); }
  for (let y = 0; y < height; y += 2) { add(1, y); add(width - 2, y); }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return best.c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

export function letterbox(png: Buffer, clip: { width: number; height: number }) {
  const ratio = 16 / 10;
  const w = clip.width % 2 ? clip.width + 1 : clip.width;
  const h = clip.height % 2 ? clip.height + 1 : clip.height;
  const outW = Math.max(w, Math.ceil((h * ratio) / 2) * 2);
  const outH = Math.max(h, Math.ceil(outW / ratio / 2) * 2);
  const hex = borderColor(png, clip.width, clip.height);
  return execFileSync("ffmpeg", ["-loglevel", "error", "-f", "image2pipe", "-i", "pipe:0", "-vf", `pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=0x${hex}`, "-f", "image2", "-c:v", "png", "pipe:1"], { input: png, maxBuffer: 1 << 26 });
}

export async function iframeEmpty(page: Page) {
  const counts: number[] = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    counts.push(await frame.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 10 && r.height > 10; }).length).catch(() => 0));
  }
  return counts.length > 0 && Math.max(...counts) < 3;
}

/* ------------------------------------------------------------------ scroll recording */

const LIMITS = { introMs: 1500, stepMs: 140, stepPx: 120, maxMs: 16000, stillStopMs: 2500, minMs: 4000, cardMaxBytes: 1.5 * 1024 * 1024 };

export async function recordScroll(page: Page, url: string, outDir: string, say: (t: string) => void, signal?:AbortSignal) {
  const frames: { file: string; t: number }[] = [];
  const FR = path.join(outDir, "frames");
  fs.rmSync(FR, { recursive: true, force: true });
  fs.mkdirSync(FR, { recursive: true });
  const report: Record<string, unknown> & { issues: string[] } = { issues: [] };
  say(`打开 ${url.replace(/^https?:\/\//, "")}，先停 1.5 秒看入场动画`);
  await visit(page,url,new URL(url).hostname.replace(/^www\./,""));
  signal?.throwIfAborted();
  const shape = await page.evaluate(() => ({ scrollHeight: document.documentElement.scrollHeight, viewport: innerHeight }));
  const mode = shape.scrollHeight > shape.viewport * 1.2 ? "document-scroll" : "hijacked-or-single-screen";
  report.mode = mode;
  let reason = "time-cap";
  await withBrowserFrames(page,async()=>{
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const file = path.join(FR, `${String(frames.length).padStart(5, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: metadata.timestamp ?? Date.now() / 1000 });
    await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await page.mouse.move(VIEW.width / 2, VIEW.height / 2);
  const t0 = Date.now();
  try {
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 1 });
  await sleep(LIMITS.introMs);
  say(mode === "document-scroll" ? "真实滚轮每 140ms 推 120px，到底就停" : "页面劫持了滚动：用滚轮推进，画面静止 2.5 秒就停");
  let lastCount = frames.length, lastChange = Date.now();
  while (Date.now() - t0 < LIMITS.maxMs) {
    signal?.throwIfAborted();
    await page.mouse.wheel(0, LIMITS.stepPx);
    await sleep(LIMITS.stepMs);
    if (frames.length !== lastCount) { lastCount = frames.length; lastChange = Date.now(); }
    if (mode === "document-scroll") {
      const atEnd = await page.evaluate(() => innerHeight + scrollY >= document.documentElement.scrollHeight - 4);
      if (atEnd) { await sleep(900); reason = "reached-bottom"; break; }
    } else if (Date.now() - lastChange > LIMITS.stillStopMs) { reason = "still-for-2.5s"; break; }
  }
  } finally {
    await cdp.send("Page.stopScreencast").catch(()=>{});
    await cdp.detach().catch(()=>{});
  }
  });
  await sleep(300);
  report.stop = reason; report.frames = frames.length;
  if (frames.length < 2) throw new Error("screencast 没有出帧");
  const end = frames[frames.length - 1].t + 0.5;
  const list = frames.map((frame, i) => `file '${path.basename(frame.file)}'\nduration ${((frames[i + 1]?.t ?? end) - frame.t).toFixed(4)}`).join("\n") + `\nfile '${path.basename(frames[frames.length - 1].file)}'\n`;
  fs.writeFileSync(path.join(FR, "list.txt"), list);
  report.durationSec = Number((end - frames[0].t).toFixed(2));
  say(`收到 ${frames.length} 帧，ffmpeg 按真实时间拼成 30fps`);
  const encode = (name: string, width: number, crf: number) => runFile("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-vf", `fps=30,scale=${width}:-2:flags=lanczos`, "-c:v", "libx264", "-preset", "slow", "-crf", String(crf),
    "-pix_fmt", "yuv420p", "-profile:v", "high", "-g", "30", "-movflags", "+faststart", "-an", path.join("..", name),
  ], { cwd: FR, signal, timeout:120000, windowsHide:true });
  await encode("preview.mp4", 1280, 28);
  await encode("preview.card.mp4", 720, 31);
  const poster = frames.find((fr) => fs.statSync(fr.file).size > 12000) || frames[0];
  for (const [name, width] of [["poster.webp", 1280], ["poster.card.webp", 720]] as const) {
    await runFile("ffmpeg", ["-y", "-loglevel", "error", "-i", path.basename(poster.file), "-vf", `scale=${width}:-2:flags=lanczos`, "-quality", "80", path.join("..", name)], { cwd: FR, signal, timeout:30000, windowsHide:true });
  }
  const sizes = frames.map((fr) => fs.statSync(fr.file).size);
  const changed = sizes.filter((size, i) => i > 0 && Math.abs(size - sizes[i - 1]) / sizes[i - 1] > 0.01).length;
  report.changedShare = Number((changed / Math.max(1, frames.length - 1)).toFixed(3));
  const cardBytes = fs.statSync(path.join(outDir, "preview.card.mp4")).size;
  report.bytes = { preview: fs.statSync(path.join(outDir, "preview.mp4")).size, card: cardBytes };
  if (sizes[0] < 12000 && poster === frames[0]) report.issues.push("all-frames-blank");
  if ((report.changedShare as number) < 0.15) report.issues.push("too-little-motion");
  if ((report.durationSec as number) * 1000 < LIMITS.minMs) report.issues.push("too-short");
  if (cardBytes > LIMITS.cardMaxBytes) report.issues.push("card-video-too-large");
  fs.rmSync(FR, { recursive: true, force: true });
  return report;
}
