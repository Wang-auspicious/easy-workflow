// Browser capture steps, ported from VisLexicon `scripts/preview/capture-shots.mjs` and
// `record-scroll.mjs` and split per station (Spec §8 ⑥⑦⑧⑨). Rules come from
// `preview-rules.json`; read-only browsing: never accept cookies, log in or fill forms.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as wait } from "node:timers/promises";
import type { ElementHandle, Frame, Page } from "playwright-core";
import {aHashAsync, hamming, imageStatsAsync, runFfmpeg, type ImageProcessOptions} from '../../server/evidence.ts';
import { PREVIEW_RULES } from "./env.ts";
import { browserAttention, inspectBrowserAttention, withBrowserFrames } from "../../server/browser.ts";
import { ClassifiedFailure, classifyFailure } from "../../shared/failures.ts";

export const VIEW = { width: PREVIEW_RULES.viewport.width, height: PREVIEW_RULES.viewport.height };
const DECLINE = /^(reject|decline|deny|refuse|necessary only|only necessary|essential only|required only|only required|use necessary cookies only|continue without accepting|拒绝|仅必要|仅限必要|不同意)/i;
export const STAGE_SELECTORS: string[] = PREVIEW_RULES.kinds["component-source"]?.roles.proof?.stageSelectors ?? ["[class*=preview]", "[class*=demo]", "iframe"];
/** Query/hash routers identify distinct rendered pages, not tracking noise. */
export function pageKey(href:string) {try{const u=new URL(href);for(const k of [...u.searchParams.keys()])if(/^utm_|^(ref|fbclid|gclid)$/i.test(k))u.searchParams.delete(k);u.searchParams.sort();if(!/^#(?:\/|!)/.test(u.hash))u.hash="";return u.origin+u.pathname.replace(/\/+$/,"")+u.search+u.hash;}catch{return href;}}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const runFile = promisify(execFile);
const visitedPages = new WeakMap<Page, { requestedUrl: string; finalUrl: string }>();

function fontDownloadURL(value: string): boolean {
  try { return /\.(ttf|otf|ttc|woff2?)$/i.test(new URL(value).pathname); }
  catch { return false; }
}

export interface Link { href: string; text: string; inNav: boolean; inMain: boolean; hasImage: boolean; visible: boolean; order: number }

export interface BrowserCaptureState {
  readonly method: 'browser-native';
  readonly capturedAt: string;
  readonly sourceUrl: string;
  readonly finalUrl: string;
  readonly viewport: {width: number; height: number};
  readonly scroll: {x: number; y: number; containers: {selector: string; x: number; y: number}[]};
  readonly clip: {x: number; y: number; width: number; height: number} | null;
  readonly actions: readonly string[];
  readonly controls: Record<string, string | boolean>[];
  readonly text: string;
  readonly sha256?: string;
  readonly finalWebPSha256?: string;
}

/** Sample the actual page immediately before its screenshot, without changing it. */
export async function sampleBrowserCapture(page: Page,
    clip: BrowserCaptureState['clip'] = null): Promise<BrowserCaptureState> {
  const capturedAt = new Date().toISOString();
  const observed = await page.evaluate(() => {
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight &&
        box.right > 0 && box.left < innerWidth && style.display !== 'none' &&
        style.visibility !== 'hidden' && Number(style.opacity) !== 0;
    };
    const selector = (element: Element) => element.id ? `#${CSS.escape(element.id)}` :
      `${element.tagName.toLowerCase()}:nth-of-type(${[...element.parentElement?.children ?? []]
        .filter(sibling => sibling.tagName === element.tagName).indexOf(element) + 1})`;
    const controls = [...document.querySelectorAll('input,textarea,select,button,[role=slider]')]
      .filter(visible).filter(element => {
        const type = element.getAttribute('type') ?? '';
        const identity = ['name', 'id', 'aria-label', 'autocomplete'].map(key => element.getAttribute(key) ?? '').join(' ');
        return !/^(?:password|hidden|file)$/i.test(type) && !/password|secret|api[-_ ]?key|token|authorization/i.test(identity);
      }).slice(0, 100).map(element => {
        const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement;
        return {selector: selector(element), tag: element.tagName.toLowerCase(),
          type: element.getAttribute('type') ?? '', name: element.getAttribute('name') ?? '',
          label: (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 200),
          value: String(control.value ?? element.getAttribute('aria-valuenow') ?? '').slice(0, 500),
          checked: element instanceof HTMLInputElement && element.checked, disabled: Boolean(control.disabled)};
      });
    const containers = [...document.querySelectorAll('body *')].filter(element =>
      visible(element) && (element.scrollTop !== 0 || element.scrollLeft !== 0) &&
      (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth))
      .slice(0, 40).map(element => ({selector: selector(element), x: element.scrollLeft, y: element.scrollTop}));
    return {finalUrl: location.href, viewport: {width: innerWidth, height: innerHeight},
      scroll: {x: scrollX, y: scrollY, containers}, controls,
      text: (document.body?.innerText ?? '').slice(0, 20000)};
  });
  return {method: 'browser-native', capturedAt,
    sourceUrl: visitedPages.get(page)?.requestedUrl ?? observed.finalUrl,
    ...observed, clip, actions: []};
}

/** Click a real close control on a named presentation overlay; retain auth walls. */
export async function dismissReadOnlyOverlay(page: Page, title: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const before = pageKey(page.url());
  const result = await page.evaluate(title => {
    const norm = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = (element: Element) => {const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';};
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,p,span,div')].filter(element => visible(element) && norm((element as HTMLElement).innerText || '') === norm(title))
      .sort((a, b) => Number(!a.closest('[role=dialog],dialog,[aria-modal=true]')) - Number(!b.closest('[role=dialog],dialog,[aria-modal=true]')));
    let sawOverlay = false;
    for (const heading of headings) for (let container = heading.parentElement, depth = 0; container && depth < 6 && !container.matches('main,body,html'); container = container.parentElement, depth++) {
      sawOverlay ||= Boolean(container.closest('[role=dialog],dialog,[aria-modal=true]')) || getComputedStyle(container).position === 'fixed';
      const text = (container.innerText || '').slice(0, 2000);
      const close = [...container.querySelectorAll('button,[role=button],a,[aria-label]')].find(element => {
        if (!visible(element) || element.closest('form') || element.hasAttribute('download')) return false;
        if (element instanceof HTMLAnchorElement && !['', '#'].includes(element.getAttribute('href') ?? '')) return false;
        const label = element.getAttribute('aria-label') || element.getAttribute('title') || (element as HTMLElement).innerText || '';
        return /^(?:(?:close|dismiss)(?:\s+(?:modal|dialog|popup|window))?|关闭(?:弹窗|对话框)?|取消|×|✕|x)$/iu.test(label.trim()) || Boolean(element.querySelector('svg.lucide-x,svg[data-lucide="x"]'));
      });
      if (close) {
        if (container.querySelector('input[type=password]') || /captcha|verify your|verify that|sign in to|log in to|unlock|subscribe to continue|验证码|验证身份/iu.test(text)) return {state: 'auth'};
        const selectorOf = (target: Element) => {
          const parts: string[] = [];
          for (let element: Element | null = target; element; element = element.parentElement) {
            if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) {parts.unshift(`#${CSS.escape(element.id)}`); break;}
            if (!element.parentElement) {parts.unshift(element.tagName.toLowerCase()); break;}
            const siblings = [...element.parentElement.children].filter(sibling => sibling.tagName === element!.tagName);
            parts.unshift(`${element.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(element) + 1})`);
          }
          return parts.join(' > ');
        };
        return {state: 'ready', selector: selectorOf(container), closeSelector: selectorOf(close)};
      }
    }
    return {state: sawOverlay ? 'no-close-control' : 'not-present'};
  }, title);
  if (result.state === 'auth') throw new Error('该弹层涉及登录或验证，保留给用户接管，未关闭');
  if (result.state === 'no-close-control') throw new Error('没有找到与指定弹层绑定的真实关闭按钮，未隐藏页面内容');
  if (result.state === 'ready') {
    await page.locator(result.closeSelector!).click({timeout: 5000});
    await page.waitForFunction(({selector, title}) => {
      const element = document.querySelector(selector!);
      if (!element || !((element as HTMLElement).innerText || '').toLowerCase().includes(title.toLowerCase())) return true;
      const box = element.getBoundingClientRect();
      return box.width === 0 || box.height === 0 || getComputedStyle(element).visibility === 'hidden';
    }, {selector: result.selector, title}, {timeout: 5000});
  }
  signal?.throwIfAborted();
  if (pageKey(page.url()) !== before) throw new Error('关闭弹层离开原页，停止截图');
  return `dismiss-overlay: ${title}; ${result.state === 'ready' ? 'clicked' : result.state}`;
}

/** Follow an existing declarative preview-to-dialog binding on the original page. */
export async function openReadOnlyDialog(page: Page, label: string, signal?: AbortSignal): Promise<{action: string; location: CaptureLocation}> {
  signal?.throwIfAborted();
  const before = pageKey(page.url());
  const trigger = page.locator('[data-toggle="modal"][data-target]').filter({hasText: label});
  if (await trigger.count() !== 1) throw new Error('需要唯一的原页预览入口，未点击');
  const selector = await trigger.evaluate(element => {
    const target = element.getAttribute('data-target') ?? '';
    if (!/^#[a-zA-Z][\w:-]*$/.test(target) || element.closest('form') || element.hasAttribute('download') ||
        element instanceof HTMLAnchorElement && !['', '#', target].includes(element.getAttribute('href') ?? '')) return null;
    const dialog = document.querySelector(target);
    if (!dialog?.matches('[role=dialog],dialog') || dialog.querySelector('input[type=password]') ||
        /captcha|sign in|log in|checkout|payment|验证码|支付/iu.test(dialog.textContent ?? '')) return null;
    return target;
  });
  if (!selector) throw new Error('入口没有绑定只读页面预览，未点击');
  await trigger.scrollIntoViewIfNeeded({timeout: 5000});
  await trigger.click({timeout: 5000});
  await page.locator(selector).waitFor({state: 'visible', timeout: 8000});
  signal?.throwIfAborted();
  if (pageKey(page.url()) !== before) throw new Error('预览离开原页，停止截图');
  const coordinates = await page.locator(selector).evaluate(element => ({y: element.getBoundingClientRect().top + scrollY, scrollY}));
  return {action: `open-dialog: ${label}; ${selector}`, location: {matched: label, anchors: [label], selector, ...coordinates}};
}

/** Only open an original Webflow image lightbox; never arbitrary links or scripts. */
export async function openReadOnlyPreview(page: Page, index: number,
    signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(index) || index < 0 || index > 49) throw new Error('Invalid preview index');
  const trigger = page.locator('a.w-lightbox').nth(index);
  const expectedImage = await trigger.evaluate(element => {
    if (!(element instanceof HTMLAnchorElement) || element.hasAttribute('download') ||
        !['', '#'].includes(element.getAttribute('href') ?? '')) return null;
    try {
      const data = JSON.parse(element.querySelector('script.w-json[type="application/json"]')?.textContent ?? '{}') as
        {items?: {type?: string; url?: string}[]};
      const image = data.items?.find(item => item.type === 'image' && typeof item.url === 'string');
      if (!image?.url) return null;
      const url = new URL(image.url, location.href);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch {return null;}
  });
  if (!expectedImage) throw new Error('预览入口不是已核验的原页图片灯箱，或链接会导航/下载；未点击。');
  const before = pageKey(page.url());
  await trigger.scrollIntoViewIfNeeded({timeout: 5000});
  signal?.throwIfAborted();
  await trigger.click({timeout: 5000});
  if (pageKey(page.url()) !== before) throw new Error('预览交互离开原页，不能作为只读灯箱截图');
  const image = page.locator('.w-lightbox-backdrop .w-lightbox-image:visible').first();
  await image.waitFor({state: 'visible', timeout: 8000});
  const actual = await image.evaluate(async element => {
    if (!(element instanceof HTMLImageElement)) return null;
    if (!element.complete) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Preview image did not load')), 8000);
      element.addEventListener('load', () => {clearTimeout(timer); resolve();}, {once: true});
      element.addEventListener('error', () => {clearTimeout(timer); reject(new Error('Preview image failed'));}, {once: true});
    });
    const box = element.getBoundingClientRect();
    return element.naturalWidth >= 64 && element.naturalHeight >= 64 && box.width >= 64 && box.height >= 64 ?
      element.currentSrc || element.src : null;
  });
  signal?.throwIfAborted();
  if (actual !== expectedImage) throw new Error('预览未显示与原页绑定的实际图片，不能拍摄');
  return `open-preview: click a.w-lightbox index=${index}; image=${actual}`;
}

export async function pageVerdict(page: Page, entryHost: string): Promise<string[]> {
  const access = await inspectBrowserAttention(page);
  return page.evaluate(({ entryHost, access }) => {
    const text = (document.body?.innerText || "").slice(0, 4000);
    const issues: string[] = [];
    if (/\b404\b|not found|page not found|找不到页面/i.test(document.title + " " + text.slice(0, 400))) issues.push("notFound");
    const shown = (el: Element) => (el as HTMLElement).checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? (el as HTMLElement).offsetParent !== null;
    if (access.url === location.href && access.kind === "auth") issues.push("loginWall");
    if (access.url === location.href && access.kind === "challenge") issues.push("challenge");
    if (access.url === location.href && access.kind === "http") issues.push("accessDenied");
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
  }, { entryHost, access });
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
  return [...found,...stories].filter((l,i,all)=>!fontDownloadURL(l.href)&&all.findIndex(a=>pageKey(a.href)===pageKey(l.href))===i);
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
    if (/\.(pdf|zip|png|jpe?g|svg|mp4|ttf|otf|ttc|woff2?)$/i.test(url.pathname)) continue;
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
  if (fontDownloadURL(url)) {
    throw new ClassifiedFailure({tag: 'needs_selection', category: 'system', owner: 'agent', retryable: true,
      url, requestedUrl: url, message: '字体文件是下载资源，不能作为截图页面；请重新选择字体展示页',
      nextAction: '从原站目录选择可浏览的 specimen、字体详情或演示页，保留已完成的事实和图片。'});
  }
  say?.(`打开 ${url.replace(/^https?:\/\//, "")}`);
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 }).catch((error: Error) => ({ error }));
  if (response && "error" in response) throw new ClassifiedFailure(classifyFailure(response.error,{url,requestedUrl:url}));
  visitedPages.set(page, { requestedUrl: url, finalUrl: page.url() });
  if (response && response.status() >= 400) {
    if ([401,403].includes(response.status())) {
      const access = await inspectBrowserAttention(page);
      if (access.kind === "auth" || access.kind === "challenge" || response.status() === 401) {
        const message = access.kind === "challenge" ? "页面需要完成人机验证" : "页面要求登录认证";
        await browserAttention(page, message, access.kind === "challenge" ? "challenge" : "auth");
        throw new ClassifiedFailure(classifyFailure(message,{url:page.url(),requestedUrl:url,status:response.status()}));
      }
    }
    throw new ClassifiedFailure(classifyFailure(`HTTP ${response.status()}`,{url:page.url(),requestedUrl:url,status:response.status()}));
  }
  await settle(page);
  const declined = await declineCookies(page);
  if (declined) say?.(`Cookie 只点了“${declined}”`);
  await sleep(400);
  const hidden = await hideFloating(page);
  const issues = await pageVerdict(page, entryHost);
  if (issues.includes("loginWall") || issues.includes("challenge")) {
    await browserAttention(page, issues.includes("loginWall") ? "登录状态需要检查" : "页面需要完成验证");
    throw new ClassifiedFailure(classifyFailure("页面需要登录或验证，已保留在内置浏览器", { url: page.url(), requestedUrl: url }));
  }
  if (issues.includes("accessDenied")) throw new ClassifiedFailure(classifyFailure("服务器拒绝请求（HTTP 403）", { url: page.url(), requestedUrl: url, status: 403 }));
  return { issues, hidden };
}

/** Consent UI can arrive while a demo is rendering or reappear on scroll. Reuse
 * the visit policy immediately before each captured frame; never hide an access wall. */
async function prepareScreenshot(page: Page) {
  const issues = await pageVerdict(page, new URL(page.url()).hostname.replace(/^www\./, ""));
  const visited = visitedPages.get(page), requestedUrl = visited?.finalUrl === page.url() ? visited.requestedUrl : undefined;
  if (issues.includes("loginWall") || issues.includes("challenge")) {
    const message = "页面需要登录或验证，已保留在内置浏览器";
    await browserAttention(page, message);
    throw new ClassifiedFailure(classifyFailure(message, { url: page.url(), requestedUrl }));
  }
  if (issues.includes("accessDenied")) throw new ClassifiedFailure(classifyFailure("服务器拒绝请求（HTTP 403）", { url: page.url(), requestedUrl, status: 403 }));
  await declineCookies(page);
  await hideFloating(page);
}

export async function shoot(page: Page, clip?: { x: number; y: number; width: number; height: number }, options: ImageProcessOptions = {}) {
  return withBrowserFrames(page,async()=>{
    options.signal?.throwIfAborted();
    if (!clip) {
      await prepareScreenshot(page);
      options.signal?.throwIfAborted();
      const png = await page.screenshot({fullPage: false});
      options.signal?.throwIfAborted();
      return png;
    }
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
          options.signal?.throwIfAborted();
          const x=Math.round(clip.x)+dx,y=Math.round(clip.y)+dy;
          await page.evaluate(async({x,y})=>{window.scrollTo(Math.max(0,x-32),Math.max(0,y-Math.min(160,innerHeight/4)));await new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())));},{x,y});
          await prepareScreenshot(page);
          const view=await page.evaluate(()=>({x:scrollX,y:scrollY,w:innerWidth,h:innerHeight}));
          const sx=Math.round(x-view.x),sy=Math.round(y-view.y);
          const w=Math.min(width-dx,view.w-sx),h=Math.min(height-dy,view.h-sy);
          if(sx<0||sy<0||w<1||h<1)throw new Error('舞台裁剪超出页面范围');
          const viewport=await page.screenshot({fullPage:false,scale:'css'});
          const raw = await runFfmpeg(['-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-vf', `scale=${view.w}:${view.h}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], {...options, input: viewport, maxBuffer: 1 << 26});
          if (raw.length !== view.w * view.h * 4) throw new Error('舞台截图像素解码不完整');
          for(let row=0;row<h;row++)raw.copy(pixels,((dy+row)*width+dx)*4,((sy+row)*view.w+sx)*4,((sy+row)*view.w+sx+w)*4);
          dx+=w;rowHeight=Math.min(rowHeight,h);
        }
        dy+=rowHeight;
      }
      return await runFfmpeg(['-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1'], {...options, input: pixels, maxBuffer: 1 << 26});
    }finally{await page.evaluate(p=>window.scrollTo(p.x,p.y),original).catch(()=>{});}
  });
}

export async function checkImage(png: Buffer, others: string[], options: ImageProcessOptions & {stage?: boolean; previewRegion?: {x: number; y: number; width: number; height: number}} = {}) {
  const issues: string[] = [];
  const stats = await imageStatsAsync(png, options);
  if (stats.std < 6 || stats.content < 0.02) issues.push(`blank(std ${stats.std.toFixed(1)}, content ${(stats.content * 100).toFixed(1)}%)`);
  else if (options.stage && stats.content < 0.03) issues.push(`stage-nearly-empty(${(stats.content * 100).toFixed(1)}%)`);
  let preview: {region: NonNullable<typeof options.previewRegion>; stats: typeof stats} | undefined;
  if (stats.flatBlock && options.previewRegion) {
    const region = options.previewRegion;
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    if (Object.values(region).every(Number.isSafeInteger) && region.x >= 0 && region.y >= 0 && region.width >= 240 && region.height >= 160 &&
        region.x + region.width <= width && region.y + region.height <= height && region.width * region.height >= width * height * .15) {
      const pixels = await runFfmpeg(['-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-vf', `crop=${region.width}:${region.height}:${region.x}:${region.y}`, '-f', 'image2', '-c:v', 'png', 'pipe:1'], {...options, input: png});
      preview = {region, stats: await imageStatsAsync(pixels, options)};
    }
  }
  // A verified original dialog has a deliberately flat backdrop. Assess its
  // actual content pixels as well; preserve the full native screenshot and all
  // duplicate/blank checks and require the same independent visual review.
  if (stats.flatBlock && (!preview || preview.stats.flatBlock || preview.stats.std < 6 || preview.stats.content < .03)) issues.push('flat-block');
  const hash = await aHashAsync(png, options);
  for (const other of others) if (other && hamming(hash, other) <= 6) issues.push("duplicate");
  return {issues, stats, hash, preview};
}

export async function motionFirst(page: Page) {
  return page.evaluate(() => {
    const vw = innerWidth * innerHeight;
    const big = [...document.querySelectorAll("canvas, video")].some((el) => { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.width * r.height >= 0.5 * vw; });
    return { scrollHijacked: document.documentElement.scrollHeight <= innerHeight * 1.2, canvasHero: big };
  }).catch(() => ({ scrollHijacked: false, canvasHero: false }));
}

export async function previewsInViewport(page: Page) {
  return page.evaluate((selectors) => {
    const visible = (el: Element) => {
      if (el.closest("nav, header, footer, aside, pre, code")) return false;
      const r = el.getBoundingClientRect(), css = getComputedStyle(el);
      const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      if (w <= 80 || h <= 60 || css.visibility === "hidden" || css.display === "none" || Number(css.opacity) === 0) return false;
      if (el instanceof HTMLImageElement && (!el.complete || !el.naturalWidth)) return false;
      if (/^\s*(loading|加载中)[.…]*\s*$/i.test((el as HTMLElement).innerText ?? "")) return false;
      return true;
    };
    const stages = new Set<Element>();
    for (const sel of selectors) try { for (const el of document.querySelectorAll(sel)) if (visible(el)) stages.add(el); } catch { /* Invalid optional selector. */ }
    // One stage can match data-preview, preview and demo at once. Nested wrappers
    // and images inside that same stage are still one preview, not four.
    const leaves = [...stages].filter(el => ![...stages].some(other => other !== el && el.contains(other)));
    const media = [...document.querySelectorAll("main img, main canvas, main video")].filter(el => visible(el) && ![...stages].some(stage => stage.contains(el)));
    return leaves.length + media.length;
  }, STAGE_SELECTORS).catch(() => 0);
}

/** How the catalogue shot was chosen. `rendered-items` / `name-list` come from the
 *  side-by-side visual comparison of candidate pages; `owner-choice` from 指定采集页. */
export interface BreadthVisual { basis: "rendered-items" | "name-list" | "owner-choice"; reason: string; compared: number }

/** A single tool shows functional range; a library still has to show its items. */
export function breadthRoleGuidance(kind: string): string {
  if (kind !== 'tool') return '';
  return 'Tool breadth: a complete working workspace with its actual rendered output and multiple real visible functions or controls can show the range of this tool. It does not need a gallery of many works. A single output alone, empty or loading controls, or feature marketing text alone is insufficient. Identity, breadth and proof must still show distinct information: the same workspace with only a different seed or output colour does not add a role. Keep the actual capture state and independent three-image review; this tool rule does not relax library, asset or collection breadth.';
}

/** The element count is a program hint. It decides alone only when no one has looked:
 *  pure CSS effects and SVG icon grids count as 0 even when the screen is full of them. */
export function breadthPreviewIssues(kind: string, previews: unknown, visual?: Partial<BreadthVisual> | null): string[] {
  if (kind !== "component-source") return [];
  if (visual?.basis && ["rendered-items", "name-list", "owner-choice"].includes(visual.basis)) return [];
  if (typeof previews !== "number" || !Number.isInteger(previews) || previews < 0) return ["breadth-previews-missing（没有可核验的首屏预览计数）"];
  return previews < 4 ? [`breadth-previews-below-minimum（首屏渲染预览 ${previews} 个，至少需要 4 个）`] : [];
}

/** Scroll the way a person would: try the first few screens and stay on the one with the
 *  most rendered previews. `skipFirst` skips the first screen (the home page's own first
 *  screen is already the identity shot). */
export async function bestScrollFrame(page: Page, { skipFirst = false } = {}) {
  const view = await page.evaluate(() => ({ h: innerHeight, total: document.documentElement.scrollHeight })).catch(() => ({ h: VIEW.height, total: VIEW.height }));
  const offsets = [0, 0.85, 1.7, 2.55].map((f) => Math.round(f * view.h)).filter((y, i) => (i === 0 || y + view.h * 0.5 < view.total) && !(skipFirst && i === 0));
  if (!offsets.length) return null;
  let best = { y: offsets[0], previews: -1 };
  for (const y of offsets) {
    await page.evaluate((top) => window.scrollTo(0, top), y).catch(() => {});
    await sleep(500);
    const previews = await previewsInViewport(page);
    if (previews > best.previews) best = { y, previews };
  }
  await page.evaluate((top) => window.scrollTo(0, top), best.y).catch(() => {});
  await sleep(600);
  return { y: best.y, previews: Math.max(0, best.previews) };
}

/* ------------------------------------------------------------------ stage (component close-up) */

export interface CaptureLocation { matched?: string; anchors: string[]; y?: number; scrollY?: number; selector?: string }

/** Extract rendered labels from instructions; the explanation itself is not DOM text. */
function captureAnchors(hints: readonly string[]): string[] {
  const generic = /^(?:proof|breadth|identity|hero|svg|hex|iframe|html|css|dom|viewport|px|h[1-6]|l[1-6])$/i;
  return [...new Set(hints.flatMap(hint => {
    // A review often describes an old, incorrect frame before stating the new
    // target. Do not scroll back to labels mentioned only in that old frame.
    const request = hint.match(/(?:请|\bplease\b)([\s\S]*)/i)?.[1] ?? hint;
    const text = request.replace(/https?:\/\/[^\s，。；、）)]+/gi, ' ')
      .replace(/(?:不要|不再|避免|别再|而非|不要只|\bdo not\b)[^，。；;\n]*/gi, ' ');
    const quoted = [...text.matchAll(/[「『“\"]([^」』”\"]{2,240})[」』”\"]/g)]
      .map(match => match[1].trim());
    // Chinese capture notes frequently name English headings without quotes:
    // “拍到This sections hues/Click to copy的Elements…”. Keep those labels,
    // rather than searching for the entire mixed-language instruction.
    const labels = [...text.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[ \t]+[A-Za-z][A-Za-z0-9'’!?-]*)*/g)]
      .map(match => match[0].trim())
      .filter(label => label.length >= 2 && label.length <= 120 && !generic.test(label) &&
        !/^(?:scroll(?:ing)?|locate|reframe|capture|click|wait|please)\b/i.test(label));
    const compact = text.trim();
    const literal = compact.length >= 2 && compact.length <= 80 &&
      !/[，,。；;：:\n（）()]/.test(compact) &&
      !/(?:请|滚到|滚动|定位|重新|取景|拍到|拍摄|点击|不要|scroll|reframe|capture|click)/i.test(compact) ? [compact] : [];
    return quoted.length ? quoted : literal.length ? literal : labels;
  }))];
}

/** Reader/reviewer prose contains quoted visible text, not a literal DOM text
 * node. Match the complete rendered heading (including nested spans and breaks)
 * and verify that scrolling actually brought it into the viewport. */
export async function locateCaptureTarget(page: Page, hints: string[], position: 'below' | 'above' | 'center' = 'below', selector?: string): Promise<CaptureLocation> {
  const anchors = captureAnchors(hints);
  const candidates = selector ? [hints[0] || selector] : anchors;
  return page.evaluate(async ({ anchors, candidates, position, selector }) => {
    const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\s\u200b]+/g, ' ').replace(/[.。…]+$/g, '').trim();
    const eligible = (el: Element, explicit = false) => {
      if (el.closest(explicit ? 'script,style,noscript,pre,code' : 'nav,header,footer,aside,script,style,noscript,pre,code')) return false;
      const box = el.getBoundingClientRect(), style = getComputedStyle(el);
      // An observed target may be a real tool sidebar or a lazy visual that only
      // fades in after scrolling. Locate it first; readiness still verifies its
      // original rendered pixels before the camera is allowed to capture it.
      return box.width > 0 && box.height > 0 && style.display !== 'none' && (explicit || style.visibility !== 'hidden' && Number(style.opacity) !== 0);
    };
    const elements = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading],p,label,span,strong,a,button,[role=button],div,section,input:not([type=password]):not([type=hidden]),textarea,select')].filter(element => eligible(element));
    for (const candidate of candidates) {
      const wanted = normalize(candidate); if (wanted.length < 2) continue;
      const matches = elements.map(element => ({ element, text: normalize((element as HTMLElement).innerText || element.getAttribute('aria-label') || '') }))
        .filter(({ text }) => text.length <= 1000 && text.includes(wanted))
        .sort((a, b) => Number(!a.element.matches('h1,h2,h3,h4,h5,h6,[role=heading]')) - Number(!b.element.matches('h1,h2,h3,h4,h5,h6,[role=heading]')) || a.text.length - b.text.length);
      let target = matches[0]?.element;
      if (selector) {
        const exact = document.querySelectorAll(selector);
        if (exact.length !== 1 || !eligible(exact[0], true)) return {anchors};
        target = exact[0];
      }
      if (!target) continue;
      // A label can sit in the middle of a drop zone. Aligning the label itself
      // cuts off its working area and fills the frame with the following FAQ.
      if (!selector && !target.matches('h1,h2,h3,h4,h5,h6,[role=heading]')) {
        for (let parent = target.parentElement, depth = 0; parent && depth < 5 && !parent.matches('main,body,html'); parent = parent.parentElement, depth++) {
          const box = parent.getBoundingClientRect();
          if (box.height > innerHeight - 120) break;
          if (box.width >= 240 && box.height >= 160 &&
              (parent.querySelector('input[type=file]') || parent.querySelectorAll('input:not([type=hidden]),textarea,select').length >= 2)) target = parent;
        }
      }
      target.scrollIntoView({ block: 'start', behavior: 'instant' });
      // At the page bottom scrollIntoView is already clamped. A relative -96px
      // scroll can move that still-visible last heading below the viewport.
      const targetBox = target.getBoundingClientRect();
      const inset = position === 'above' ? innerHeight - targetBox.height - 64
        : position === 'center' ? (innerHeight - targetBox.height) / 2 : Math.min(96, innerHeight / 6);
      window.scrollTo({top: Math.max(0, scrollY + targetBox.top - inset), behavior: 'instant'});
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const box = target.getBoundingClientRect();
      if (box.bottom > 0 && box.top < innerHeight) {
        const parts: string[] = [];
        for (let element: Element | null = target; element; element = element.parentElement) {
          if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) {
            parts.unshift(`#${CSS.escape(element.id)}`); break;
          }
          if (!element.parentElement) {parts.unshift(element.tagName.toLowerCase()); break;}
          const siblings = [...element.parentElement?.children ?? []].filter(sibling => sibling.tagName === element!.tagName);
          parts.unshift(`${element.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(element) + 1})`);
        }
        return { matched: candidate, anchors, y: box.top + scrollY, scrollY, selector: parts.join(' > ') };
      }
    }
    return { anchors };
  }, { anchors, candidates, position, selector });
}

export interface Stage { sel: string; x: number; y: number; w: number; h: number; painted: number; media: number; locked: boolean }
export interface CaptureWait { timeoutMs?: number; deadline?: number; signal?: AbortSignal; anchorY?: number }

export interface ProofReadinessSample {
  observedAt: string;
  selector: string;
  count: number;
  visible: boolean;
  finitePending: number;
  elements: {selector: string; opacity: string; display: string; visibility: string;
    layout: number[]; rect: number[]; animations: {properties: string[]; playState: string;
      pending: boolean; currentTime: number | null; endTime: number | null; infinite: boolean}[]}[];
  media: {selector: string; tag: string; ready: boolean; width: number; height: number;
    readyState?: number; complete?: boolean; decodedFrames?: number; source: string}[];
  stability: string;
}

export interface ProofCaptureReadiness {
  status: 'ready' | 'timeout';
  code?: 'CAPTURE_NOT_READY';
  startedAt: string;
  elapsedMs: number;
  budgetMs: number;
  samples: ProofReadinessSample[];
}

/** Observe the original located viewport; never alter opacity, timing or media.
 * Finite entry transitions share one deadline, while natural infinite motion
 * does not require frozen pixels or opacity1. Readiness is not image approval. */
export async function waitProofCaptureReady(page: Page, location: CaptureLocation,
    opts: CaptureWait = {}): Promise<ProofCaptureReadiness> {
  const started = Date.now();
  const budgetMs = Math.min(20000, Math.max(0, opts.timeoutMs ?? 20000),
    Math.max(0, (opts.deadline ?? started + 20000) - started));
  const deadline = started + budgetMs;
  const samples: ProofReadinessSample[] = [];
  let stable = 0, previous = '';
  while (Date.now() < deadline) {
    opts.signal?.throwIfAborted();
    const sample = await boundedFrameRead(() => page.evaluate(({selector}) => {
      const matches = selector ? [...document.querySelectorAll(selector)] : [];
      const target = matches.length === 1 ? matches[0] : undefined;
      const rect = (element: Element) => {
        const box = element.getBoundingClientRect();
        return [box.left, box.top, box.width, box.height];
      };
      const inView = (element: Element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
      };
      const name = (element: Element) => element.id ? `#${CSS.escape(element.id)}` : element.tagName.toLowerCase();
      const scope = target?.closest('section,article,[role=region]') ?? target?.parentElement ?? target;
      const mediaElements = scope ? [...scope.querySelectorAll('img,video')]
        .filter(element => inView(element) && !element.closest('nav,header,footer,aside')) : [];
      const ancestors = new Set<Element>();
      for (const element of [target, ...mediaElements]) {
        for (let current = element; current; current = current.parentElement ?? undefined) ancestors.add(current);
      }
      const elements = [...ancestors].map(element => {
        const css = getComputedStyle(element), html = element as HTMLElement;
        const animations = element.getAnimations().map(animation => {
          const effect = animation.effect as KeyframeEffect | null;
          const timing = effect?.getComputedTiming();
          const properties = [...new Set((effect?.getKeyframes() ?? []).flatMap(frame => Object.keys(frame)))]
            .filter(key => ['opacity', 'transform', 'translate', 'scale', 'rotate', 'filter', 'clipPath', 'visibility'].includes(key));
          return {properties, playState: animation.playState, pending: animation.pending,
            currentTime: typeof animation.currentTime === 'number' ? animation.currentTime : null,
            endTime: typeof timing?.endTime === 'number' && Number.isFinite(timing.endTime) ? timing.endTime : null,
            infinite: timing?.iterations === Infinity || timing?.endTime === Infinity};
        }).filter(animation => animation.properties.length > 0);
        return {selector: name(element), opacity: css.opacity, display: css.display, visibility: css.visibility,
          layout: [html.offsetLeft, html.offsetTop, html.offsetWidth, html.offsetHeight], rect: rect(element), animations};
      });
      const finitePending = elements.flatMap(element => element.animations)
        .filter(animation => !animation.infinite && (animation.pending || animation.playState === 'running')).length;
      const visible = Boolean(target?.isConnected && inView(target) && elements.every(element =>
        element.display !== 'none' && !['hidden', 'collapse'].includes(element.visibility) && Number(element.opacity) > 0));
      const media = mediaElements.map(element => {
        if (element instanceof HTMLImageElement) return {selector: name(element), tag: 'img',
          ready: element.complete && element.naturalWidth > 0 && element.naturalHeight > 0,
          complete: element.complete, width: element.naturalWidth, height: element.naturalHeight, source: element.currentSrc};
        const video = element as HTMLVideoElement;
        return {selector: name(element), tag: 'video', ready: video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0,
          readyState: video.readyState, width: video.videoWidth, height: video.videoHeight,
          decodedFrames: video.getVideoPlaybackQuality?.().totalVideoFrames, source: video.currentSrc};
      });
      // Layout coordinates exclude animated transforms; an infinite original
      // opacity animation likewise must not demand an impossible final value.
      const stability = JSON.stringify({scroll: [scrollX, scrollY], elements: elements.map(element => ({
        selector: element.selector, layout: element.layout,
        opacity: element.animations.some(animation => animation.infinite && animation.properties.includes('opacity')) ? undefined : element.opacity,
      })), media: media.map(element => [element.selector, element.width, element.height, element.ready])});
      return {observedAt: new Date().toISOString(), selector, count: matches.length, visible,
        finitePending, elements, media, stability};
    }, {selector: location.selector ?? ''}).catch(() => null), opts.signal, deadline - Date.now());
    opts.signal?.throwIfAborted();
    if (!sample) break;
    samples.push(sample);
    const ready = sample.visible && sample.finitePending === 0 && sample.media.every(media => media.ready);
    stable = ready ? sample.stability === previous ? stable + 1 : 1 : 0;
    previous = sample.stability;
    if (stable >= 3) return {status: 'ready', startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started, budgetMs, samples};
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await wait(Math.min(200, remaining), undefined, {signal: opts.signal});
  }
  opts.signal?.throwIfAborted();
  return {status: 'timeout', code: 'CAPTURE_NOT_READY', startedAt: new Date(started).toISOString(),
    elapsedMs: Date.now() - started, budgetMs, samples};
}
// Selectors are descriptive (and can match several examples). Retain the exact
// chosen DOM node for frame checks without adding attributes to the source page.
const stageElements = new WeakMap<Stage, ElementHandle<Element>>();

async function findStageOnce(page: Page, anchorY?: number): Promise<Stage | null> {
  const selection = await page.evaluateHandle(({ selectors, anchorY }) => {
    const seen = new Set<Element>();
    const boxes: { stage: Stage; element: Element }[] = [];
    const roots:(Document|ShadowRoot)[]=[document];
    for(let i=0;i<roots.length;i++)for(const el of roots[i].querySelectorAll('*'))if(el.shadowRoot)roots.push(el.shadowRoot);
    // A standalone story can render several complete variants in one tall root.
    // Descend only those known render roots, stop at the first eligible container
    // on each branch, and never split a list/table/form into constituent rows.
    const storyGroups = new Set<Element>();
    const structures = "ul,ol,table,form,fieldset,[role=list],[role=grid],[role=tree],[role=menu],[role=dialog]";
    const fragments = "li,tr,td,th,dt,dd,button,input,select,textarea,svg,canvas,img,video,iframe,[role=row],[role=cell],[role=gridcell],[role=listitem],[role=option],[role=menuitem]";
    for (const story of roots.flatMap(root => [...root.querySelectorAll("#storybook-root,#root > .sb-story")])) {
      if (story.getBoundingClientRect().height <= innerHeight * 1.5 || story.closest("nav,header,footer,aside,article,pre,code")) continue;
      const queue = [...story.children].map(element => ({ element, depth: 1 }));
      let checked = 0;
      while (queue.length && checked++ < 200) {
        const { element, depth } = queue.shift()!;
        if (element.matches(`nav,header,footer,aside,article,pre,code,${fragments}`)) continue;
        const r = element.getBoundingClientRect(), css = getComputedStyle(element);
        if (css.display === "none" || css.visibility === "hidden" || Number(css.opacity) === 0 || !((element as HTMLElement).checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true)) continue;
        const containsComponent = element.matches(structures) || Boolean(element.querySelector(structures)) || [...element.querySelectorAll("canvas,img,svg,video,iframe")].some(media => { const box = media.getBoundingClientRect(); return box.width >= 80 && box.height >= 24; });
        if (element.matches("div,section,ul,ol,table,form,fieldset") && r.width >= 80 && r.height >= 24 && r.height <= innerHeight * 1.5 && containsComponent && !element.querySelector("article,pre,code")) {
          storyGroups.add(element); continue;
        }
        if (depth < 4 && !element.matches(structures)) queue.push(...[...element.children].map(child => ({ element: child, depth: depth + 1 })));
      }
    }
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
    for (const sel of ["example-before-code", ".bd-example", "[data-preview]", ".sp-preview-container", ".sp-preview-iframe", "#storybook-root", "#root > .sb-story", "canvas", "svg", "[class*=playground]", ...selectors, "storybook-component-group"]) {
      let found: Element[] = [];
      try { found = sel==='example-before-code'?[...examples]:sel==='storybook-component-group'?[...storyGroups]:roots.flatMap(root=>[...root.querySelectorAll(sel)]); } catch { continue; }
      for (const el of found) {
        if (seen.has(el) || el.closest("nav, header, footer, aside, pre, code")) continue;
        seen.add(el);
        const r = el.getBoundingClientRect();
        if (r.width < 80 || r.height < 24 || r.height > innerHeight * 1.5 || getComputedStyle(el).visibility==="hidden") continue;
        if (anchorY !== undefined && (r.bottom <= 0 || r.top >= innerHeight)) continue;
        const painted = el.querySelectorAll("*").length;
        const media = el.querySelectorAll("canvas, img, svg, video").length + (el.matches("iframe,canvas,img,svg,video") ? 1 : 0);
        if (painted < 1 && !media && !el.matches("button,input,[role=button]")) continue;
        if (el.querySelector("pre,code") && !el.matches(".bd-example,[data-preview],#storybook-root")) continue;
        const locked = /\b(pro|upgrade|unlock)\b|会员/i.test(((el as HTMLElement).innerText || "").slice(0, 200)) && el.querySelectorAll("svg").length > 0 && painted < 12;
        boxes.push({ stage: { sel, x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, painted, media, locked }, element: el });
      }
    }
    boxes.sort((a, b) => (anchorY === undefined ? (a.stage.y<innerHeight?0:1)-(b.stage.y<innerHeight?0:1) : Math.abs(a.stage.y-anchorY)-Math.abs(b.stage.y-anchorY)) || b.stage.w*b.stage.h-a.stage.w*a.stage.h);
    return boxes.find((b) => !b.stage.locked) || { stage: null, element: null };
  }, { selectors: STAGE_SELECTORS, anchorY }).catch(() => null);
  if (!selection) return null;
  try {
    const info = await selection.getProperty("stage");
    const stage = await info.jsonValue(); await info.dispose();
    const node = await selection.getProperty("element"), element = node.asElement();
    if (!stage || !element) { await node.dispose(); return null; }
    stageElements.set(stage, element as ElementHandle<Element>);
    return stage;
  } finally { await selection.dispose(); }
}

/** Discover a genuinely rendered stage using the unchanged qualification rules.
 * An absolute deadline lets discovery and iframe rendering share one budget. */
export async function findStage(page: Page, opts: CaptureWait = {}): Promise<Stage | null> {
  const bounded = opts.deadline !== undefined || (opts.timeoutMs ?? 0) > 0;
  const deadline = opts.deadline ?? Date.now() + Math.max(0, opts.timeoutMs ?? 0);
  while (true) {
    opts.signal?.throwIfAborted();
    const stage = await boundedFrameRead(() => findStageOnce(page, opts.anchorY).catch(() => null), opts.signal, bounded ? deadline - Date.now() : undefined);
    opts.signal?.throwIfAborted();
    if (stage || !bounded) return stage;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await wait(Math.min(200, remaining), undefined, { signal: opts.signal });
  }
}

export function stageClip(stage: Stage, pageWidth: number) {
  const pad = 16;
  const x = Math.max(0, Math.round(stage.x - pad));
  const y = Math.max(0, Math.round(stage.y - pad));
  return { x, y, width: Math.round(Math.min(stage.w + pad * 2, pageWidth - x)), height: Math.round(stage.h + pad * 2) };
}

/** Border colour = the mode of the outermost pixel ring (works for oklch pages too). */
async function borderColor(png: Buffer, width: number, height: number, options: ImageProcessOptions) {
  const rgb = await runFfmpeg(['-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {...options, input: png, maxBuffer: 1 << 26});
  if (rgb.length !== width * height * 3) throw new Error('舞台截图尺寸与像素解码不一致');
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

export async function letterbox(png: Buffer, clip: { width: number; height: number }, options: ImageProcessOptions = {}) {
  if (!Number.isSafeInteger(clip.width) || !Number.isSafeInteger(clip.height) || clip.width < 2 || clip.height < 2 || clip.width * clip.height > 16_000_000) {
    throw new Error('舞台补边尺寸无效或过大');
  }
  const ratio = 16 / 10;
  const w = clip.width % 2 ? clip.width + 1 : clip.width;
  const h = clip.height % 2 ? clip.height + 1 : clip.height;
  const outW = Math.max(w, Math.ceil((h * ratio) / 2) * 2);
  const outH = Math.max(h, Math.ceil(outW / ratio / 2) * 2);
  const hex = await borderColor(png, clip.width, clip.height, options);
  return runFfmpeg(['-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-vf', `pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=0x${hex}`, '-f', 'image2', '-c:v', 'png', 'pipe:1'], {...options, input: png, maxBuffer: 1 << 26});
}

/** Visible iframe content belonging to this exact stage, including nested demos.
 * Hidden analytics and unrelated sibling frames cannot veto or validate a stage. */
export async function stageFrames(page: Page, stage: Stage): Promise<(Frame | null)[]> {
  const element = stageElements.get(stage);
  if (!element || (await element.ownerFrame())?.page() !== page || !(await element.evaluate(el => el.isConnected))) throw new Error("选中的舞台元素已失效，需要重新定位");
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect(), css = getComputedStyle(el);
    return r.width > 10 && r.height > 10 && css.display !== "none" && css.visibility !== "hidden" && Number(css.opacity) > 0
      && ((el as HTMLElement).checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true);
  };
  const handles = await element.$$("iframe");
  if (await element.evaluate(el => el.matches("iframe"))) handles.unshift(element as ElementHandle<HTMLIFrameElement>);
  const frames: (Frame | null)[] = [];
  for (const handle of handles) {
    try { if (await handle.evaluate(visible)) frames.push(await handle.contentFrame()); }
    finally { if (handle !== element) await handle.dispose(); }
  }
  for (let i = 0; i < frames.length; i++) {
    for (const child of frames[i]?.childFrames() ?? []) {
      const handle = await child.frameElement();
      try { if (await handle.evaluate(visible)) frames.push(child); }
      finally { await handle.dispose(); }
    }
  }
  return frames;
}

async function boundedFrameRead<T>(read: () => Promise<T>, signal?: AbortSignal, timeoutMs?: number): Promise<T | null> {
  signal?.throwIfAborted();
  if (timeoutMs !== undefined && timeoutMs <= 0) return null;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined, done = false;
    const finish = (value: T | null, error?: unknown) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener("abort", aborted);
      error === undefined ? resolve(value) : reject(error);
    };
    const aborted = () => finish(null, signal!.reason);
    signal?.addEventListener("abort", aborted, { once: true });
    if (timeoutMs !== undefined) timer = setTimeout(() => finish(null), timeoutMs);
    void read().then(value => finish(value), error => finish(null, error));
  });
}

/** Load/networkidle can precede async Storybook rendering. Re-check this stage's
 * current frames until the original threshold is met or the one deadline expires.
 * Frame attachment and navigation are sampled again, never satisfied by siblings. */
export async function iframeEmpty(page: Page, stage: Stage, opts: CaptureWait = {}) {
  const bounded = opts.deadline !== undefined || (opts.timeoutMs ?? 0) > 0;
  const deadline = opts.deadline ?? Date.now() + Math.max(0, opts.timeoutMs ?? 0);
  let hadFrames = false;
  while (true) {
    opts.signal?.throwIfAborted();
    const sample = await boundedFrameRead(async () => {
      try {
        const frames = await stageFrames(page, stage), counts: number[] = [];
        for (const frame of frames) counts.push(frame ? await frame.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 10 && r.height > 10; }).length).catch(() => 0) : 0);
        return { hasFrames: frames.length > 0, ready: counts.some(count => count >= 3) };
      } catch {
        // A navigating/detached frame is not evidence of readiness. The exact
        // selected element must become readable again within the same budget.
        return { hasFrames: true, ready: false };
      }
    }, opts.signal, bounded ? deadline - Date.now() : undefined);
    opts.signal?.throwIfAborted();
    if (!sample) return true;
    hadFrames ||= sample.hasFrames;
    if (sample.ready || !hadFrames) return false;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return true;
    await wait(Math.min(200, remaining), undefined, { signal: opts.signal });
  }
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
