// Program stations of the VisLexicon pack (Spec §8), with optional model-assisted
// candidate ordering. Each returns a structured result; evidence is written to the content store and
// shows up next to its node on the canvas.
import crypto from "node:crypto";
import {businessInput, candidateRoute} from './intake.ts';
import fs from "node:fs";
import path from "node:path";
import type { EvidenceRef, Usage } from "../../shared/types.ts";
import { EvidenceStore, aHashAsync, hamming } from "../../server/evidence.ts";
import { openPage } from "../../server/browser.ts";
import { webGet } from "../../server/network.ts";
import { ClassifiedFailure, classifyFailure, candidateFailure, type Failure } from "../../shared/failures.ts";
import { pickByImages, pickOne } from "../../server/agent-station.ts";
import type { StationContext, StationResult } from "../../server/runtime.ts";
import { KIND_ZH, PREVIEW_RULES, loadPublished } from "./env.ts";
import { scout } from "./scout.ts";
import { publicationImages, videoPreview } from "./preview.ts";
import { COMPONENT_TOOLS } from "./components.ts";
import { MEDIA_TOOLS } from "./media-lines.ts";
import { repoOf } from "../../server/repo.ts";
import {prioritizeCaptureCandidates} from './decisions.ts';
import { ALL_AXES, CHOSEN_AXES, derivedFacets, loadTaxonomy, validateV3, webpSize } from "./v3.ts";
import {
  VIEW, bestScrollFrame, checkImage, findStage, iframeEmpty, letterbox, links, motionFirst, previewsInViewport, breadthPreviewIssues, breadthRoleGuidance, recordScroll, sameSite,
  scoreLinks, shoot, stageClip, visit, pageKey, locateCaptureTarget, sampleBrowserCapture, openReadOnlyPreview, openReadOnlyDialog, dismissReadOnlyOverlay, waitProofCaptureReady,
  type BrowserCaptureState, type CaptureLocation, type BreadthVisual, type Link,
} from "./capture.ts";

export interface Services {
  store: EvidenceStore;
  workDir: string;
  publishDir: string;
  /** Identity keys of tokens past dedupe and still on the line (excluding `self`). */
  inFlight: (self: string) => Set<string>;
  tryBrowser?:()=>{release:()=>void}|null;
  acquireBrowser?:(signal:AbortSignal,timeoutMs:number)=>Promise<{release:()=>void}|null>;
}

type Tool = (ctx: StationContext, svc: Services) => Promise<StationResult>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function siteEntryThreeShots(ctx: StationContext): boolean {
  const external = ctx.token.data.externalResearch as Record<string, unknown> | undefined;
  return external?.publicationContract === 'site-entry-three-shots' ||
    external?.intakeId === 'vislexicon-20261014' && typeof external.entryId === 'string';
}

type CorrectedCaptureTarget = {url: string; locate: string; selector?: string; position?: 'below' | 'above' | 'center'; dismissOverlay?: string; interaction?: {kind: 'open-preview'; index: number} | {kind: 'open-dialog'; label: string}};

/** Keep an owner-validated entry target when another role invalidates this station. */
function correctedCaptureTarget(ctx: StationContext, host: string, role: 'breadth' | 'proof'): CorrectedCaptureTarget | undefined {
  let target: unknown;
  let explicit = false;
  if (ctx.redo?.byHuman && ctx.redo.note) {
    let note: unknown;
    try {note = JSON.parse(ctx.redo.note) as unknown;} catch { /* Unstructured owner notes are not targets. */ }
    if (note && typeof note === 'object' && Object.hasOwn(note, 'captureTarget')) {
      target = (note as Record<string, unknown>).captureTarget;
      explicit = true;
    }
  }
  if (!explicit) {
    const targets = ctx.token.data.ownerCaptureTargets as Record<string, unknown> | undefined;
    if (!targets || !Object.hasOwn(targets, role)) return undefined;
    const saved = targets[role];
    const entryId = (ctx.token.data.externalResearch as Record<string, unknown> | undefined)?.entryId ?? ctx.token.item;
    // An old entry binding must fail visibly, never become permission to select a sibling.
    if (saved && typeof saved === 'object' && typeof entryId === 'string' &&
        (saved as Record<string, unknown>).entryId === entryId) target = saved;
  }
  if (target && typeof target === 'object') {
    const requested = target as Record<string, unknown>;
    const position = requested.position;
    const dismissOverlay = requested.dismissOverlay;
    const selector = requested.selector;
    const interaction = requested.interaction as Record<string, unknown> | undefined;
    const validInteraction = interaction === undefined || role === 'proof' && interaction !== null && (
      interaction.kind === 'open-preview' && Number.isSafeInteger(interaction.index ?? 0) && Number(interaction.index ?? 0) >= 0 && Number(interaction.index ?? 0) <= 49 ||
      interaction.kind === 'open-dialog' && typeof interaction.label === 'string' && interaction.label.length >= 2 && interaction.label.length <= 120);
    if (requested.role === role && validInteraction && (selector === undefined || typeof selector === 'string' && selector.length >= 1 && selector.length <= 600) && (dismissOverlay === undefined || typeof dismissOverlay === 'string' && dismissOverlay.length >= 2 && dismissOverlay.length <= 150) && (position === undefined || ['below', 'above', 'center'].includes(String(position))) && typeof requested.url === 'string' && typeof requested.locate === 'string' &&
        requested.locate.trim().length >= 2 && requested.locate.length <= 1000) {
      try {
        const url = new URL(requested.url);
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && sameSite(url.href, host)) {
          return {url: url.href, locate: requested.locate.trim(), selector: selector as string | undefined, position: position as CorrectedCaptureTarget['position'], dismissOverlay: dismissOverlay as string | undefined,
            ...(interaction ? {interaction: interaction.kind === 'open-dialog' ? {kind: 'open-dialog', label: String(interaction.label)} : {kind: 'open-preview', index: Number(interaction.index ?? 0)}} : {})};
        }
      } catch { /* Invalid explicit target is rejected before opening a page. */ }
    }
  }
  throw new ClassifiedFailure({tag: 'needs_selection', category: 'system', owner: 'agent', retryable: true,
    message: `纠错取景目标必须是同站的 ${role} HTTP(S) 页面，并提供可在页面实际命中的 locate 文本；仅允许已核验的只读预览或弹框。`});
}

/** Called only after the requested DOM target and ordinary image gates succeeded. */
function ownerCaptureTargetPatch(ctx: StationContext, role: 'breadth' | 'proof',
  target: CorrectedCaptureTarget | undefined, capturedAt: string): Record<string, unknown> {
  const entryId = (ctx.token.data.externalResearch as Record<string, unknown> | undefined)?.entryId ?? ctx.token.item;
  if (!target || typeof entryId !== 'string') return {};
  return {ownerCaptureTargets: {...(ctx.token.data.ownerCaptureTargets as object ?? {}),
    [role]: {entryId, role, ...target, verifiedAt: capturedAt}}};
}

export function canonical(raw: string): string | null {
  try {
    raw=raw.trim().replace(/^git\+(https?:\/\/)/i,"$1").replace(/^https?:\/\/git\+https?\/+/i,"https://");
    if(/^[a-z][a-z\d+.-]*:/i.test(raw)&&!/^https?:\/\//i.test(raw))return null;
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if(!["http:","https:"].includes(u.protocol)||u.username||u.password||!u.hostname||/[+\s]/.test(u.hostname))return null;
    if(["github.com","gitlab.com"].includes(u.hostname))u.pathname=u.pathname.replace(/\.git$/i,"");
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|ref_|source$|fbclid|gclid|mc_)/i.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    return u.toString().replace(/\/$/, "");
  } catch { return null; }
}
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

let publishedHosts: Set<string> | null = null;
function published(dir: string) {
  if (!publishedHosts) publishedHosts = new Set(loadPublished().map((p) => p.domain.replace(/^www\./, "")));
  const local = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "").replace(/~/g, "/")) : [];
  return new Set([...publishedHosts, ...local]);
}

/* ------------------------------------------------------------------ layer 2 · candidates */

/** Resource type of a raw link (Spec §36). */
export function resourceType(url: string): "repo" | "npm" | "social" | "file" | "doc-page" | "website" {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, "");
    if (["github.com", "gitlab.com", "bitbucket.org"].includes(h) && u.pathname.split("/").filter(Boolean).length >= 2) return "repo";
    if (h === "npmjs.com" || h === "npmjs.org") return "npm";
    if (/(^|\.)(x|twitter|xiaohongshu|douyin|bilibili|weibo|instagram|youtube)\.com$|xhslink\.com$|b23\.tv$/.test(h)) return "social";
    if (/\.(md|pptx?|key|pdf|zip|psd|fig|sketch|json)$/i.test(u.pathname)) return "file";
    if (u.pathname.split("/").filter(Boolean).length >= 2) return "doc-page";
    return "website";
  } catch { return "website"; }
}

const tidy: Tool = async (ctx) => {
  const raw = ctx.token.url;
  const url = canonical(raw);
  if (!url) return { ok: false, summary: "网址无法解析", failure: classifyFailure(`无法解析的网址：${raw}`,{url:raw,stage:"url"}) };
  const type = resourceType(url);
  const repo = type === "repo" ? repoOf(url) : null;
  const entityKey = repo ? `github:${repo.owner}/${repo.name}`.toLowerCase() : hostOf(url);
  ctx.progress(`规范化：${url}（${({ repo: "代码仓库", npm: "npm 包", social: "社媒帖子", file: "文件", "doc-page": "文档单页", website: "网站" } as Record<string, string>)[type]}）`, { tool: "normalize", text: `原始：${raw}`, ok: true });
  // Health precheck: unhealthy links never take a line slot (Spec §36).
  let health: { status: number; finalUrl: string; checkedAt: string } | null = null;
  if (type !== "social") {
    try {
      const r = await webGet(url, { signal: ctx.signal, timeout: 15000 });
      health = { status: r.status, finalUrl: r.finalUrl, checkedAt: new Date().toISOString() };
      if (r.status === 404 || r.status === 410) return { ok: false, summary: `入口 HTTP ${r.status}`, failure: classifyFailure(`首页返回 HTTP ${r.status}`, { url, status: r.status }) };
      ctx.progress(`健康预检：HTTP ${r.status}${r.finalUrl !== url ? ` → ${r.finalUrl}` : ""}`, { tool: "health", text: r.finalUrl, ok: r.status < 400 });
    } catch (err) {
      ctx.signal.throwIfAborted();
      const f = classifyFailure(err, { url });
      if (f.tag === "network_tls" || f.tag === "network_dns") return { ok: false, summary: f.message, error: f.message, failure: f };
      ctx.progress(`健康预检未通过（${f.tag}），留给侦察员用浏览器再试`, { tool: "health", text: f.message.slice(0, 120), ok: false });
    }
  }
  const title = ctx.token.title?.trim() || hostOf(url);
  const candidate = { title, source: ctx.token.source, type, entityKey, repo: repo ? `${repo.owner}/${repo.name}` : null, raw: { url: raw, source: ctx.token.source, at: new Date().toISOString() }, health, searchText: `${title} ${hostOf(url)} ${url}`.toLowerCase() };
  return { ok: true, summary: `候选已准备：${title}（${type}）`, data: { canonical: health?.finalUrl && sameSite(health.finalUrl, hostOf(url)) ? canonical(health.finalUrl) ?? url : url, host: hostOf(url), candidate } };
};
const extract: Tool = async (ctx) => ({ ok: true, summary: ctx.token.title ? `标题：${ctx.token.title}` : "只有网址，标题留给首页抓取", data: {} });
const index: Tool = async (ctx) => ({ ok: true, summary: `按来源 ${ctx.token.source.split("/").pop()} 建索引`, data: {} });
const route: Tool = async (ctx) => {
  const u = String(ctx.token.data.canonical ?? ctx.token.url);
  const r = candidateRoute(u, ctx.token.data);
  const input = r === 'curation' ? {} : businessInput(r, u, ctx.token.data);
  const zh: Record<string, string> = {curation: '策展线', components: '组件入库线', skills: 'Skill 线', 'sci-figure': '科研绘图线', ppt: 'PPT 线', 'image-fx': '图像处理线'};
  return {ok: true, summary: `→ ${zh[r]}`, data: {...input, route: r}};
};

/* ------------------------------------------------------------------ ① dedupe */

/** Identity key: the host for a site root, host + path for a page or a repo (github.com/a/b ≠ github.com/c/d). */
export function itemKey(url: string) {
  try { const u = new URL(url); const p = u.pathname.replace(/\/+$/, ""); return u.hostname.replace(/^www\./, "") + (p && p !== "/" ? p.toLowerCase() : ""); } catch { return url; }
}

const dedupe: Tool = async (ctx, svc) => {
  const url = canonical(String(ctx.token.data.canonical ?? ctx.token.url));
  if (!url) return { ok: false, summary: "网址无法解析", failure:classifyFailure("网址无法解析",{url:ctx.token.url,stage:"url"}) };
  const host = hostOf(url), key = itemKey(url);
  if (!ctx.token.data.rerunPublished && published(svc.publishDir).has(key)) return { ok: true, summary: `${key} 已发布，合并`, data: { canonical: url, host, key }, finish: { status: "merged", reason: `${key} 已是发布条目（处置：合并到已发布条目，不重复入库）` } };
  const others = svc.inFlight(ctx.token.id);
  if (others.has(key)) return { ok: true, summary: `${key} 正在线上，合并`, data: { canonical: url, host, key }, finish: { status: "merged", reason: `${key} 已有另一件货在线上（处置：合并）` } };
  ctx.progress(`身份键 ${key}：不在已发布 ${published(svc.publishDir).size} 条里，也不在线上`, { tool: "dedupe", text: key, ok: true });
  return { ok: true, summary: `${key} 是新的`, data: { canonical: url, host, key } };
};

/* ------------------------------------------------------------------ ② fetch (HTTP only) */

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

export function parseHtml(html: string, base: string, max = 3000) {
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim()).slice(0, 160);
  const meta = (name: string) => decode(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i").exec(html)?.[1] ?? new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, "i").exec(html)?.[1] ?? "").trim();
  const description = (meta("description") || meta("og:description")).slice(0, 300);
  const navStart = html.search(/<(nav|header)[\s>]/i);
  const navEnd = navStart >= 0 ? html.indexOf("</header>", navStart) : -1;
  const links: { href: string; text: string; inNav: boolean }[] = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && links.length < 160) {
    let href: string;
    try { href = new URL(decode(m[1]), base).toString(); } catch { continue; }
    if (!/^https?:/.test(href)) continue;
    const text = decode(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 60);
    const inNav = navStart >= 0 && m.index >= navStart && (navEnd < 0 ? m.index < navStart + 20000 : m.index < navEnd);
    if (!links.some((l) => l.href === href)) links.push({ href, text, inNav });
  }
  const text = decode(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, max);
  return { title, description, links, text };
}

export async function httpGet(url: string, signal: AbortSignal, timeout = 20000) {
  const r = await webGet(url, { signal, timeout });
  const out: { status: number; finalUrl: string; body: string; via?: string } = { status: r.status, finalUrl: r.finalUrl, body: r.body, via: r.via };
  return out;
}

const fetchHome: Tool = async (ctx,svc) => {
  const url = String(ctx.token.data.canonical ?? ctx.token.url);
  ctx.progress(`GET ${url.replace(/^https:\/\//, "")}`, { tool: "http", text: "只发 HTTP，不开浏览器" });
  let r:Awaited<ReturnType<typeof httpGet>>|undefined,failed:ReturnType<typeof classifyFailure>|undefined;
  try { r = await httpGet(url, ctx.signal); } catch (err) {
    ctx.signal.throwIfAborted();
    const failure=classifyFailure(err,{url});
    failed=failure;
  }
  if(r&&r.status>=400)failed=classifyFailure(`首页返回 HTTP ${r.status}`,{url,status:r.status});
  if(failed&&['network_timeout','network_connection','auth_required'].includes(failed.tag)) {
    const lease=svc.tryBrowser?.();
    if(lease)try{
      ctx.progress('HTTP 未取得首页，改用共享浏览器现场补取一次',{tool:'recover',text:failed.message});
      const browser=await openPage(VIEW,'en-US',ctx.signal);
      try{await visit(browser.page,url,hostOf(url));r={status:200,finalUrl:browser.page.url(),body:await browser.page.content()};failed=undefined;}
      catch(error){ctx.signal.throwIfAborted();failed=(error as {failure?:ReturnType<typeof classifyFailure>}).failure??classifyFailure(error,{url});}
      finally{await browser.close();}
    }finally{lease.release();}
    else ctx.progress('浏览器名额正在使用，保留请求等待恢复，不突破全局配额',{tool:'recover',text:failed.message});
  }
  if(failed||!r){const failure=failed??classifyFailure('首页没有响应',{url});return {ok:false,summary:failure.message,error:failure.message,failure};}
  const p = parseHtml(r.body, r.finalUrl);
  const host = hostOf(r.finalUrl);
  const navLinks = p.links.filter((l) => sameSite(l.href, String(ctx.token.data.host ?? host)) || sameSite(l.href, host));
  ctx.progress(`HTTP ${r.status} · 标题「${p.title || "无"}」· 站内链接 ${navLinks.length} 个`, { tool: "http", text: `${r.body.length.toLocaleString()} 字节`, ok: true });
  ctx.addEvidence({ id: `ev-${ctx.attempt}`, kind: "text", label: "首页事实", verdict: p.title ? p.title.slice(0, 22) : host, tone: "ok", meta: { status: r.status, finalUrl: r.finalUrl, description: p.description, links: navLinks.length } });
  return {
    ok: true, summary: `「${p.title || host}」· ${navLinks.length} 个站内链接`,
    data: { home: { status: r.status, finalUrl: r.finalUrl, title: p.title, description: p.description, navLinks: navLinks.slice(0, 120), text: p.text }, title: p.title || ctx.token.title },
  };
};

/* ------------------------------------------------------------------ ④ kind join */

const kindJoin: Tool = async (ctx) => {
  const a = ctx.token.data.kind1 as { kind: string } | undefined, b = ctx.token.data.kind2 as { kind: string } | undefined;
  const agree = Boolean(a?.kind) && a?.kind === b?.kind;
  ctx.progress(agree ? `两人独立判定一致：${KIND_ZH[a!.kind]}` : `分类员 ${KIND_ZH[a?.kind ?? ""] ?? "?"} ≠ 复核员 ${KIND_ZH[b?.kind ?? ""] ?? "?"} → 仲裁`, { tool: "join", text: "", ok: agree });
  ctx.addEvidence({ id: `kj-${ctx.attempt}`, kind: "verdict", label: "分类复核", verdict: agree ? `${KIND_ZH[a!.kind]} ✓ 一致` : `${KIND_ZH[a?.kind ?? ""] ?? "?"} ≠ ${KIND_ZH[b?.kind ?? ""] ?? "?"}`, tone: agree ? "ok" : "warn", meta: { a, b } });
  const reviews = [...((ctx.token.data.reviews as unknown[]) ?? []), { station: "classify-review", verdict: agree ? "pass" : "disagree", reason: `③ ${a?.kind} / ④ ${b?.kind}`, at: new Date().toISOString() }];
  return { ok: true, summary: agree ? `一致：${KIND_ZH[a!.kind]}` : "不一致，交仲裁", data: { kindAgreed: agree, ...(agree ? { kind: a!.kind } : {}), reviews } };
};

/* ------------------------------------------------------------------ ⑤ plan (reader's shot plan + rules) */

const plan: Tool = async (ctx) => {
  const kind = String(ctx.token.data.kind || "work");
  const rules = PREVIEW_RULES.kinds[kind];
  const home = ctx.token.data.home as { navLinks: Link[] } | undefined;
  const ranked = rules?.roles.breadth ? scoreLinks(home?.navLinks ?? [], rules.roles.breadth).slice(0, 4) : [];
  const mode = kind === "work" && !siteEntryThreeShots(ctx) ? "video" : "shots";
  const reader = ctx.token.data.readerPlan as { breadth?: { url: string }; proof?: { url: string; locate?: string } } | undefined;
  if (reader) ctx.progress(`采用阅读员的拍摄单：目录 ${reader.breadth?.url ?? "-"}；特写 ${reader.proof?.url ?? "-"}${reader.proof?.locate ? `（${reader.proof.locate}）` : ""}`, { tool: "plan", text: "reader plan first, rules as fallback", ok: true });
  ctx.progress(`按 ${KIND_ZH[kind] ?? kind} 的规则选页：${mode === "video" ? "作品走录屏路线" : `目录候选 ${ranked.length} 个`}`, { tool: "rules", text: `preview-rules.kinds.${kind}` });
  return {
    ok: true, summary: mode === "video" ? "作品 → 录屏" : ranked.length ? `目录首选 ${new URL(ranked[0].href).pathname}` : "目录候选留给浏览器现场找",
    data: { mode, breadthCandidates: ranked, needsProof: Boolean(rules?.roles.proof) && mode !== "video" },
  };
};

/* ------------------------------------------------------------------ helpers for shots */

function workDir(svc: Services, ctx: StationContext) {
  const d = path.join(svc.workDir, ctx.token.id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function shotEvidence(ctx: StationContext, svc: Services, png: Buffer, role: string, meta: Record<string, unknown>): Promise<EvidenceRef> {
  const bytes = await EvidenceStore.webpAsync(png, 720, 80, {signal: ctx.signal});
  ctx.signal.throwIfAborted();
  const card = svc.store.put(bytes, 'webp');
  return ctx.addEvidence({ id: `img-${card.sha.slice(0, 12)}-${ctx.attempt.slice(2, 8)}`, kind: "image", src: card.src, card: card.src, label: ROLE_ZH[role] ?? role, meta: { role, ...meta } });
}
const ROLE_ZH: Record<string, string> = { identity: "首屏", breadth: "目录", proof: "组件特写" };
type ReadinessRef = {src: string; sha256: string};
type ShotData = { file: string; href: string; hash: string; evidence: string; framing?: string; content?: number; title?: string; previews?: number; visual?: BreadthVisual; location?: CaptureLocation; capturedAt?: string; captureState?: BrowserCaptureState; readiness?: ReadinessRef };
type ReaderPlan = { identity?: { url: string }; breadth?: { url: string; alternatives?: { url: string }[] }; proof?: { url: string; locate?: string; alternatives?: { url: string; locate?: string }[] } };
const readerPlanOf = (ctx: StationContext) => ctx.token.data.readerPlan as ReaderPlan | undefined;
const shotsOf = (ctx: StationContext) => ({ ...((ctx.token.data.shots as Record<string, ShotData>) ?? {}) });

async function visitCandidate(page:Parameters<typeof visit>[0],href:string,host:string,ctx:StationContext,errors:Failure[]):Promise<Awaited<ReturnType<typeof visit>> & {failure?:Failure;retainPage?:boolean}> {
  try{return await visit(page,href,host,t=>ctx.progress(t,{tool:"browser",text:t}));}
  catch(error){
    ctx.signal.throwIfAborted();
    const raw=(error as {failure?:Failure}).failure??classifyFailure(error,{url:href,requestedUrl:href});
    const entry=String(ctx.token.data.canonical??ctx.token.url);
    const failure=candidateFailure({...raw,requestedUrl:raw.requestedUrl??href},entry);
    if(["auth_required","network_tls"].includes(failure.tag))throw error;
    errors.push(failure);
    return {issues:[`${failure.tag}: ${failure.message}`],hidden:[],failure,retainPage:raw.tag==="auth_required"};
  }
}

/** Same-site links with text, one per page, for the numbered needsPick list. */
function dedupeLinks(links: Link[]) {
  const seen = new Set<string>();
  return links.filter((l) => {
    const k = pageKey(l.href);
    if (!l.text || seen.has(k) || /\.(pdf|zip|png|jpe?g|svg|mp4|txt|md|json|xml|js|css)(?:[?#]|$)/i.test(k) || /login|signin|sign-in|signup|register|account|cart|checkout/i.test(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ------------------------------------------------------------------ ⑥ identity */

const identity: Tool = async (ctx, svc) => {
  const url = String((ctx.token.data.home as { finalUrl?: string })?.finalUrl ?? ctx.token.data.canonical ?? ctx.token.url);
  const host = String(ctx.token.data.host ?? hostOf(url));
  const { page, close } = await openPage(VIEW, "en-US", ctx.signal);
  try {
    const home = await visit(page, url, host, (t) => ctx.progress(t, { tool: "browser", text: t }));
    if (home.issues.some((i) => i.startsWith("navigation") || i.startsWith("httpError") || i === "challenge" || i === "loginWall")) {
      return { ok: false, summary: "首页没打开", error: home.issues.join(", ") };
    }
    const motion = await motionFirst(page);
    let captureState = await sampleBrowserCapture(page);
    let png = await shoot(page, undefined, {signal: ctx.signal});
    let check = await checkImage(png, [], {signal: ctx.signal});
    if (check.issues.includes("flat-block")) {
      ctx.progress("首屏是大块单色：轻推滚动、等 4 秒再拍", { tool: "browser", text: "flat-block retry" });
      const firstHash = check.hash;
      await page.mouse.wheel(0, 2); await sleep(300); await page.mouse.wheel(0, -2); await sleep(4000);
      captureState = await sampleBrowserCapture(page);
      png = await shoot(page, undefined, {signal: ctx.signal});
      check = await checkImage(png, [], {signal: ctx.signal});
      // Unchanged after 4s: not a placeholder that never rendered, but a real solid-colour design.
      if (check.issues.includes("flat-block") && hamming(firstHash, check.hash) <= 3) {
        check.issues = check.issues.filter((i) => i !== "flat-block");
        ctx.progress("4 秒后画面没变：这是真实的大色块设计，不是没渲染出来，放行", { tool: "rules", text: "flat-block stable → accept", ok: true });
      }
    }
    const homeLinks = (await links(page)).filter((l) => sameSite(l.href, host));
    const issues = [...home.issues, ...check.issues];
    const file = path.join(workDir(svc, ctx), "identity.png");
    fs.writeFileSync(file, png);
    const ev = await shotEvidence(ctx, svc, png, "identity", { href: page.url(), issues, hidden: home.hidden.length, content: Number(check.stats.content.toFixed(3)), captureState });
    ctx.progress(`截首屏 ${issues.length ? `（问题：${issues.join("、")}）` : "✓"}`, { tool: "shot", text: "1280×800 视口", ok: !issues.length, evidence: [ev.id] });
    const motionVideo = !siteEntryThreeShots(ctx) && (motion.scrollHijacked || motion.canvasHero) && ctx.token.data.kind !== "component-source" && ctx.token.data.kind !== "design-system";
    const mode = !siteEntryThreeShots(ctx) && (ctx.token.data.mode === "video" || motionVideo) ? "video" : "shots";
    if (motionVideo) ctx.progress(`动效优先：${motion.scrollHijacked ? "滚动被劫持" : "画布盖住首屏"} → 改走录屏`, { tool: "rules", text: "motionFirstSignals" });
    const shots = shotsOf(ctx);
    shots.identity = { file, href: page.url(), hash: check.hash, evidence: ev.id, content: check.stats.content, title: await page.title().catch(() => ""), capturedAt: captureState.capturedAt, captureState };
    if (issues.length && mode === "shots" && !issues.every((i) => i === "consentOverlay")) {
      return { ok: false, summary: `首屏不合格：${issues.join("、")}`, error: issues.join(", "), data: { shots, homeLinks: homeLinks.slice(0, 150) } };
    }
    return { ok: true, summary: mode === "video" ? "首屏 ✓ · 动效站，转录屏" : "首屏 ✓", data: { shots, homeLinks: homeLinks.slice(0, 150), mode, motion } };
  } finally { await close(); }
};

/* ------------------------------------------------------------------ ⑦ breadth */

const pathOf = (u: string) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
const docsPath = (href: string) => { try { return new URL(href).searchParams.get("path")?.startsWith("/docs/") ?? false; } catch { return false; } };

/** Pages listed in sitemap.xml and llms.txt: a person who cannot find the catalogue in the
 *  navigation would look there next. llms.txt often links the Markdown twin of a page. */
function siteFileLinks(ctx: StationContext, host: string): Link[] {
  const d = ctx.token.data.dossier as { finalUrl?: string; files?: { sitemap?: string[]; llms?: string | null } } | undefined;
  if (!d?.finalUrl) return [];
  let origin: string;
  try { origin = new URL(d.finalUrl).origin; } catch { return []; }
  const hrefs = [
    ...(d.files?.sitemap ?? []).map((p) => { try { return new URL(p, origin).href; } catch { return ""; } }),
    ...((d.files?.llms ?? "").match(/https?:\/\/[^\s)\]>"'`]+/g) ?? []).map((h) => h.replace(/\.mdx?$/i, "")),
  ];
  const out: Link[] = [];
  for (const href of hrefs) {
    if (!href || !sameSite(href, host) || /\.(txt|json|xml|pdf|zip|png|jpe?g|svg|mp4)(?:[?#]|$)/i.test(href)) continue;
    let text = "";
    try { text = decodeURIComponent(new URL(href).pathname.split("/").filter(Boolean).pop() ?? "").replace(/[-_]+/g, " "); } catch { /* keep empty */ }
    out.push({ href, text, inNav: false, inMain: true, hasImage: false, visible: false, order: out.length });
  }
  return out;
}

export const breadthPageQuestion = (title: string, kind: string) => kind === 'tool'
  ? `Website "${title}" is a ${KIND_ZH[kind] ?? kind} (${kind}). Below is one screenshot per candidate page (some are scrolled down, as a person would scroll). Pick the ONE image where a person sees at a glance the actual functional RANGE of this tool.
${breadthRoleGuidance(kind)}
- Prefer actual rendered items or a qualifying workspace, with basis = "rendered-items". Workspace controls must belong to this tool and be shown together with the actual rendered result.
- Customer websites or "made with" showcases, company logos, testimonials, pricing and blog posts do not show this tool's functional range.
- Only if no image shows rendered items or a qualifying workspace, a catalogue visibly listing many actual item or function names can use basis = "name-list"; feature marketing text alone cannot.
- If no image shows the range, submit index 0 with basis "none".
In reason, say in one Chinese sentence what actual items or output and different functions or controls the chosen image shows.`
  : `Website "${title}" is a ${KIND_ZH[kind] ?? kind} (${kind}). Below is one screenshot per candidate page (some are scrolled down, as a person would scroll). Pick the ONE image where a person sees at a glance the RANGE of what this site offers: many of its actual items at once.
- Prefer an image where the items themselves are rendered: component previews or demos, works, icons or other assets, templates. Then basis = "rendered-items".
- Customer websites or "made with" showcases, company logos, testimonials, pricing, blog posts and marketing copy are NOT the site's items.
- Only if no image shows rendered items, pick the page that lists the most item names (for example an index of all components). Then basis = "name-list".
- If no image shows the range at all, submit index 0 with basis "none".
In reason, say in one Chinese sentence what the chosen image shows.`;

type Survey = { href: string; png: Buffer; hash: string; previews: number; y: number; file: string; links: Link[]; why: string; title: string; captureState: BrowserCaptureState };

const breadth: Tool = async (ctx, svc) => {
  const kind = String(ctx.token.data.kind || "work");
  const role = PREVIEW_RULES.kinds[kind]?.roles.breadth ?? {};
  const host = String(ctx.token.data.host);
  const title = String(ctx.token.data.title ?? host);
  const shots = shotsOf(ctx);
  const exclude = new Set<string>(((ctx.token.data.rejectedPages as string[]) ?? []).map(pageKey));
  const repair = (ctx.token.data.shotRepairs as Record<string, { action: string; url?: string; reason?: string }> | undefined)?.breadth;
  const corrected = correctedCaptureTarget(ctx, host, 'breadth');
  const explicit = corrected?.url ?? (ctx.token.data.previewChoices as Record<string, string> | undefined)?.breadth;
  if (explicit) exclude.delete(pageKey(explicit));
  if (ctx.redo && shots.breadth?.href && (!repair || repair.action === "replace-page")) exclude.add(pageKey(shots.breadth.href));
  // The home page's first screen is the identity shot. Further down it can still be the
  // best catalogue (a component wall on the home page), so it is surveyed scrolled.
  const homeUrl = String((ctx.token.data.home as { finalUrl?: string })?.finalUrl ?? shots.identity?.href ?? ctx.token.data.canonical ?? ctx.token.url);
  const homeKeys = new Set([shots.identity?.href, String(ctx.token.data.canonical ?? ""), homeUrl].filter(Boolean).map((h) => pageKey(h!)));
  const pool = [...((ctx.token.data.homeLinks as Link[]) ?? []), ...(((ctx.token.data.home as { navLinks?: Link[] })?.navLinks) ?? [])];
  if (!pool.some((l) => { try { return new URL(l.href).searchParams.has("path"); } catch { return false; } }) && title.toLowerCase().includes("storybook")) {
    const probe = await openPage(VIEW, "en-US", ctx.signal); try { await visit(probe.page, shots.identity?.href ?? ctx.token.url, host); pool.push(...await links(probe.page)); } finally { await probe.close(); }
  }
  let usage: Usage | undefined;
  const options = dedupeLinks(pool).filter((l) => !exclude.has(pageKey(l.href)) && !homeKeys.has(pageKey(l.href))).slice(0, 30);
  let { page, close } = await openPage(VIEW, "en-US", ctx.signal);
  let retainedPage = false;
  try {
    const hashes = [shots.identity?.hash ?? ""];
    const accessFailures: Failure[] = [];
    const save = async (png: Buffer, hash: string, href: string, reason: string, previews: number, captureState: BrowserCaptureState, visual?: BreadthVisual, compared?: { href: string; previews: number; y: number }[]) => {
      const file = path.join(workDir(svc, ctx), "breadth.png");
      fs.writeFileSync(file, png);
      const ev = await shotEvidence(ctx, svc, png, "breadth", { href, reason, previews, visual, compared, captureState });
      ctx.progress(`截目录 ✓ ${pathOf(href)}（${reason}）`, { tool: "shot", text: `程序数到首屏预览 ${previews} 个${visual ? ` · 判定：${visual.basis === "name-list" ? "名称目录" : visual.basis === "owner-choice" ? "站长指定" : "渲染出的内容"}` : ""}`, ok: true, evidence: [ev.id] });
      shots.breadth = { file, href, hash, evidence: ev.id, title: "", previews, visual, capturedAt: captureState.capturedAt, captureState };
    };

    // 1. A page the owner named, or the reviewer's "same page, reframe" request.
    const direct = explicit ? { href: explicit, why: "explicit-choice" } : repair && repair.action !== "replace-page" && repair.url && !exclude.has(pageKey(repair.url)) ? { href: repair.url, why: "review-reframe" } : null;
    if (direct) {
      const v = await visitCandidate(page, direct.href, host, ctx, accessFailures);
      retainedPage = Boolean(v.retainPage);
      if (!v.failure) {
        const actions: string[] = [];
        if (corrected?.dismissOverlay) actions.push(await dismissReadOnlyOverlay(page, corrected.dismissOverlay, ctx.signal));
        if (corrected) {
          const location = await locateCaptureTarget(page, [corrected.locate], corrected.position, corrected.selector);
          if (!location.matched) return {ok: false, summary: '指定目录目标未在页面命中',
            error: '需要重新选页：指定的目录定位文字未在原页实际命中，未使用默认680px取景。'};
          ctx.progress(`目录实际定位到「${location.matched}」（${Math.round(location.scrollY ?? 0)}px）`,
            {tool: 'browser', text: corrected.locate, ok: true});
        } else if (direct.why === "review-reframe") {
          const hints = [repair?.reason].filter((hint): hint is string => Boolean(hint));
          const location = hints.length ? await locateCaptureTarget(page, hints) : undefined;
          if (location?.matched) ctx.progress(`按目录返修定位到「${location.matched}」`, {tool: 'browser', text: hints.join('\n')});
          else if (location?.anchors.length) return {ok: false, summary: '目录返修目标未命中', error: '需要重新选页：指定目录内容未在原页找到，未重复拍摄旧画面'};
          else {
            const stage = await findStage(page);
            if (stage) await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 120)), stage.y);
          }
          await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
          await sleep(1000);
          ctx.progress("按复审保留原页，等待预览并重新取景", { tool: "browser", text: "保留 URL，更新画面" });
        }
        const captureState = {...await sampleBrowserCapture(page), actions};
        const png = await shoot(page, undefined, {signal: ctx.signal});
        const check = await checkImage(png, hashes, {signal: ctx.signal});
        const previews = await previewsInViewport(page);
        const previous = shots.breadth?.visual && pageKey(shots.breadth.href) === pageKey(page.url()) ? shots.breadth.visual : undefined;
        const visual: BreadthVisual | undefined = direct.why === "explicit-choice" ? { basis: "owner-choice", reason: "站长通过指定采集页给出", compared: 1 } : previous;
        const issues = [...v.issues, ...check.issues, ...breadthPreviewIssues(kind, previews, visual)];
        if (!issues.length) {
          const pageLinks = (await links(page)).filter((l) => sameSite(l.href, host));
          await save(png, check.hash, page.url(), direct.why === "explicit-choice" ? "已指定目录页" : "按复审重新取景", previews, captureState, visual);
          shots.breadth!.title = await page.title().catch(() => "");
          return { ok: true, summary: `目录 ✓ ${pathOf(page.url())}`, data: { shots, breadthLinks: pageLinks.slice(0, 200), candidateAccessFailures: accessFailures,
            ...ownerCaptureTargetPatch(ctx, 'breadth', corrected, captureState.capturedAt) } };
        }
        ctx.progress(`拒收 ${pathOf(direct.href)}：${issues.join("、")}`, { tool: "reject", text: issues.join(", "), ok: false });
      }
      if (explicit) return { ok: false, summary: "指定的目录页不合格", error: "所有候选都被拒收：指定页不合格", failure: accessFailures.at(-1), data: { needsPick: { breadth: options.map((l, i) => `${i + 1}. ${l.text} → ${l.href}`) }, candidateAccessFailures: accessFailures } };
      exclude.add(pageKey(direct.href));
    }

    // 2. Survey: open the likely pages, scroll each like a person, and compare the screens.
    const candidates: { href: string; why: string; home?: boolean }[] = [];
    const add = (href: string | undefined, why: string, home = false) => {
      if (!href || !sameSite(href, host)) return;
      const k = pageKey(href);
      if (exclude.has(k) || (!home && homeKeys.has(k)) || candidates.some((c) => pageKey(c.href) === k)) return;
      candidates.push({ href, why, home });
    };
    const plan = readerPlanOf(ctx)?.breadth;
    if (plan) for (const u of [plan.url, ...(plan.alternatives ?? []).map((a) => a.url)]) add(u, "阅读员拍摄单");
    for (const r of scoreLinks(pool, role).slice(0, 4)) add(r.href, `规则 ${r.score}`);
    for (const link of pool.filter((l) => docsPath(l.href)).slice(0, 2)) add(link.href, "Storybook 文档");
    for (const r of scoreLinks(siteFileLinks(ctx, host), role).slice(0, 3)) add(r.href, "sitemap / llms.txt");
    for (const l of options.filter((l) => l.inNav || l.inMain)) { if (candidates.length >= 6) break; add(l.href, "导航"); }
    add(homeUrl, "首页往下滚", true);
    if (!explicit && !repair) {
      const planned = new Set((plan ? [plan.url, ...(plan.alternatives ?? []).map(item => item.url)] : []).map(pageKey));
      const fixed = candidates.filter(candidate => planned.has(pageKey(candidate.href)));
      const fallback = candidates.filter(candidate => !planned.has(pageKey(candidate.href)));
      const ordered = await prioritizeCaptureCandidates(ctx, fallback, pool, 'breadth');
      candidates.splice(0, candidates.length, ...fixed, ...ordered);
    }
    ctx.progress(`目录候选 ${candidates.length} 个，逐页打开、往下滚、截图后一起比较：${candidates.map((c) => pathOf(c.href)).join("  ")}`, { tool: "rules", text: candidates.map((c) => `${pathOf(c.href)}（${c.why}）`).join("\n") });
    const seen: Survey[] = [];
    const deadline = Date.now() + 150_000;
    for (let i = 0; i < candidates.length && seen.length < 8; i++) {
      if (Date.now() > deadline && seen.length >= 2) { ctx.progress(`看页时间用完，按已看过的 ${seen.length} 页比较`, { tool: "rules", text: "150 秒" }); break; }
      if (retainedPage) { await close(); ({page,close}=await openPage(VIEW,"en-US",ctx.signal)); retainedPage=false; }
      const c = candidates[i];
      const v = await visitCandidate(page, c.href, host, ctx, accessFailures);
      retainedPage = Boolean(v.retainPage);
      if (v.failure || v.issues.some((x) => x === "notFound" || x === "offSite")) { ctx.progress(`略过 ${pathOf(c.href)}：${v.issues.join("、")}`, { tool: "reject", text: v.issues.join(", "), ok: false }); continue; }
      const key = pageKey(page.url());
      if (seen.some((s) => pageKey(s.href) === key) || (!c.home && homeKeys.has(key))) { ctx.progress(`${pathOf(c.href)} 跳到了已看过的页面，略过`, { tool: "rules", text: page.url() }); continue; }
      const frame = await bestScrollFrame(page, { skipFirst: Boolean(c.home) });
      if (!frame) continue;
      const captureState = await sampleBrowserCapture(page);
      const png = await shoot(page, undefined, {signal: ctx.signal});
      const check = await checkImage(png, [...hashes, ...seen.map((s) => s.hash)], {signal: ctx.signal});
      if (check.issues.length) { ctx.progress(`拒收 ${pathOf(page.url())}：${check.issues.join("、")}`, { tool: "reject", text: check.issues.join(", "), ok: false }); continue; }
      const file = path.join(workDir(svc, ctx), `breadth-look-${seen.length + 1}.png`);
      fs.writeFileSync(file, png);
      const pageLinks = (await links(page)).filter((l) => sameSite(l.href, host));
      seen.push({ href: page.url(), png, hash: check.hash, previews: frame.previews, y: frame.y, file, links: pageLinks, why: c.why, title: await page.title().catch(() => ""), captureState });
      ctx.progress(`看过 ${pathOf(page.url())}${frame.y ? `（下滚 ${frame.y}px）` : ""}：程序数到预览 ${frame.previews} 个`, { tool: "browser", text: c.why, ok: true });
      // Second hop, by eye: strong catalogue links inside the first pages join the comparison.
      if (i < 3) for (const r of scoreLinks(pageLinks, role).slice(0, 2)) if (candidates.length < 10) add(r.href, `第二跳（从 ${pathOf(c.href)}）`);
    }
    const compared = seen.map((s) => ({ href: s.href, previews: s.previews, y: s.y }));
    const cleanup = () => { for (const s of seen) fs.rmSync(s.file, { force: true }); };
    if (!seen.length) {
      return { ok: false, summary: "没有合格的目录页", error: candidates.length ? "所有候选都被拒收" : "需要重新选页：交阅读员重新查找公开目录页面", failure: accessFailures.length && accessFailures.length >= candidates.length ? accessFailures.at(-1) : undefined, data: { needsPick: { breadth: options.map((l, i) => `${i + 1}. ${l.text} → ${l.href}`) }, candidateAccessFailures: accessFailures } };
    }
    const pick = await pickByImages(ctx, breadthPageQuestion(title, kind), seen.map((s) => ({ file: s.file, label: `${pathOf(s.href)}${s.y ? `（下滚 ${s.y}px）` : ""}` })));
    if (pick) usage = pick.usage;
    let chosen: Survey | undefined, visual: BreadthVisual | undefined, reason = "";
    if (pick && pick.index >= 0 && pick.basis !== "none") {
      chosen = seen[pick.index]; visual = { basis: pick.basis, reason: pick.reason, compared: seen.length }; reason = `看图比较 ${seen.length} 页后选中：${pick.reason}`;
    } else if (!pick) {
      // Model unreachable: fall back to the program rules (rule order; component sources need the count).
      const counted = [...seen].sort((a, b) => b.previews - a.previews)[0];
      if (kind !== "component-source") { chosen = seen[0]; reason = `模型不可用，按规则顺序：${seen[0].why}`; }
      else if (counted.previews >= 4) { chosen = counted; reason = `模型不可用，按程序计数：预览 ${counted.previews} 个`; }
    }
    if (!chosen) {
      cleanup();
      const why = pick ? `看了 ${seen.length} 页截图，没有一页能体现范围：${pick.reason}` : `模型不可用，程序计数也不足 4 个预览（看过 ${seen.length} 页）`;
      return { ok: false, summary: "没有合格的目录页", error: `所有候选都被拒收：${why}`, usage, data: { needsPick: { breadth: [...seen.map((s) => s.href), ...options.map((l) => l.href)].filter((h, i, all) => all.indexOf(h) === i).map((h, i) => `${i + 1}. ${h}`) }, candidateAccessFailures: accessFailures, breadthCompared: compared } };
    }
    await save(chosen.png, chosen.hash, chosen.href, reason, chosen.previews, chosen.captureState, visual, compared);
    shots.breadth!.title = chosen.title;
    cleanup();
    return { ok: true, summary: `目录 ✓ ${pathOf(chosen.href)}`, data: { shots, breadthLinks: chosen.links.slice(0, 200), candidateAccessFailures: accessFailures }, usage };
  } finally { await close(); }
};

/* ------------------------------------------------------------------ ⑧ proof */

const proof: Tool = async (ctx, svc) => {
  const kind = String(ctx.token.data.kind || "component-source");
  const role = PREVIEW_RULES.kinds[kind]?.roles.proof ?? {};
  const host = String(ctx.token.data.host);
  const shots = shotsOf(ctx);
  const nativeViewport = siteEntryThreeShots(ctx) || Boolean(ctx.redo);
  const usesStage = ["component-source", "design-system"].includes(kind) || Boolean(role.stageSelectors);
  const breadthLinks = (ctx.token.data.breadthLinks as Link[]) ?? [];
  const homeLinks = (ctx.token.data.homeLinks as Link[]) ?? [];
  let candidates: string[];
  if (role.pathPatterns && kind !== "component-source") candidates = scoreLinks([...breadthLinks, ...homeLinks], role).slice(0, 8).map((c) => c.href);
  else {
    const base = shots.breadth ? new URL(shots.breadth.href).pathname.replace(/\/+$/, "") : "";
    const pool = breadthLinks.length ? breadthLinks : homeLinks;
    const under = pool.filter((l) => { try { const p = new URL(l.href).pathname; return base && p.startsWith(base + "/") && p !== base; } catch { return false; } });
    const inGrid = pool.filter((l) => l.inMain && (l.hasImage || usesStage));
    candidates = [...new Set((under.length ? under : inGrid).map((l) => l.href))].slice(0, 8);
  }
  const norm = pageKey;
  if(usesStage){const extra=scoreLinks([...breadthLinks,...homeLinks],{pathPatterns:['iframe[.]html','demo|example|playground','/components/'],linkText:['playground','examples','preview','demo','button','grid','dialog','table']}).map(l=>l.href);candidates=[...new Set([...extra,...candidates])];}
  const repair=(ctx.token.data.shotRepairs as Record<string,{action:string;url?:string;reason?:string}>|undefined)?.proof;
  const corrected = correctedCaptureTarget(ctx, host, 'proof');
  const explicit=corrected?.url ?? (ctx.token.data.previewChoices as Record<string,string>|undefined)?.proof;
  const rejected = new Set(((ctx.token.data.rejectedPages as string[]) ?? []).map(norm));
  const taken = new Set([norm(String(ctx.token.data.canonical)), norm(shots.breadth?.href ?? ""), norm(shots.identity?.href ?? ""), ...rejected]);
  const planned=readerPlanOf(ctx)?.proof;
  const locateOf=new Map<string,string>();
  const locatedPages = new Set<string>();
  if(planned&&!explicit){
    const picks=[planned,...(planned.alternatives??[])].filter(p=>p.url&&sameSite(p.url,host));
    for(const pick of picks)if(pick.locate){
      const key = norm(pick.url);
      locateOf.set(key,pick.locate);
      if(nativeViewport&&!rejected.has(key)){locatedPages.add(key);taken.delete(key);}
    }
    candidates=[...picks.map(p=>p.url),...candidates];
  }
  if(nativeViewport&&repair?.action==='reframe'&&repair.url&&repair.reason&&sameSite(repair.url,host)&&!rejected.has(norm(repair.url))){
    locatedPages.add(norm(repair.url));taken.delete(norm(repair.url));
  }
  if(repair&&repair.action!=="replace-page"&&repair.url)candidates=[repair.url];
  else if (ctx.redo && shots.proof?.href&&!locatedPages.has(norm(shots.proof.href))) taken.add(norm(shots.proof.href));
  if(corrected){locateOf.set(norm(corrected.url),corrected.locate);locatedPages.add(norm(corrected.url));}
  if(explicit){candidates=[explicit];taken.delete(norm(explicit));}
  candidates = [...new Set(candidates.map(norm))].filter((h) => !taken.has(h)).slice(0, 6);
  if (!explicit && !repair) {
    const fixed = new Set((planned ? [planned.url, ...(planned.alternatives ?? []).map(item => item.url)] : []).map(norm));
    const ordered = await prioritizeCaptureCandidates(ctx, candidates.filter(href => !fixed.has(href)).map(href => ({href})),
      [...breadthLinks, ...homeLinks].map(link => ({...link, href: norm(link.href)})), 'proof');
    candidates = [...candidates.filter(href => fixed.has(href)), ...ordered.map(candidate => candidate.href)];
  }
  let usage: Usage | undefined;
  if (!candidates.length) {
    const options = dedupeLinks(breadthLinks.length ? breadthLinks : homeLinks).filter((l) => !taken.has(norm(l.href))).slice(0, 30);
    const pick = await pickOne(ctx, `Website ${ctx.token.data.title} is a ${KIND_ZH[kind] ?? kind} (${kind}). Which link leads to ONE concrete item rendered for real (a single component demo / one work / one asset), not docs text or installation?`, options.map((l) => `${l.text} → ${l.href}`));
    if (pick) { usage = pick.usage; candidates = [norm(options[pick.index].href)]; }
  }
  ctx.progress(`特写候选 ${candidates.length} 页${usesStage ? "，只截舞台" : ""}`, { tool: "rules", text: candidates.map((c) => new URL(c).pathname).join("  ") });
  let { page, close } = await openPage(VIEW, "en-US", ctx.signal);
  let retainedPage = false;
  try {
    const hashes = [shots.identity?.hash ?? "", shots.breadth?.hash ?? ""];
    let best: { href: string; png: Buffer; content: number; hash: string; framing: string; title: string; location?: CaptureLocation; captureState: BrowserCaptureState; readiness?: ReadinessRef; imageCheck: Awaited<ReturnType<typeof checkImage>> } | null = null;
    let tried = 0;
    const accessFailures:Failure[]=[];
    for (const href of candidates) {
      if (ctx.signal.aborted) break;
      if (retainedPage) { await close(); ({page,close}=await openPage(VIEW,"en-US",ctx.signal)); retainedPage=false; }
      tried++;
      const v = await visitCandidate(page,href,host,ctx,accessFailures);
      retainedPage = Boolean(v.retainPage);
      if (v.issues.length) { ctx.progress(`拒收 ${new URL(href).pathname}：${v.issues.join("、")}`, { tool: "reject", text: v.issues.join(", "), ok: false }); continue; }
      let png: Buffer | null = null;
      let captureState: BrowserCaptureState | undefined;
      let framing = "viewport";
      const locate=locateOf.get(norm(href));
      const actions: string[] = [];
      if (corrected?.dismissOverlay) actions.push(await dismissReadOnlyOverlay(page, corrected.dismissOverlay, ctx.signal));
      const hints = (corrected ? [corrected.locate] : [repair?.action === "reframe" ? repair.reason : undefined, locate]).filter((hint):hint is string=>Boolean(hint));
      let location = hints.length ? await locateCaptureTarget(page, hints, corrected?.position, corrected?.selector) : undefined;
      const readinessDeadline = Date.now() + 20000;
      let readinessRef: ReadinessRef | undefined;
      if (location?.matched) {
        await sleep(800);
        framing = `定位到「${location.matched}」（滚动 ${Math.round(location.scrollY ?? 0)}px）`;
        ctx.progress(framing,{tool:"browser",text:hints.join("\n")});
      } else if (location && (location.anchors.length || repair?.action === "reframe" || locatedPages.has(norm(href)))) {
        const missing = location.anchors[0] ? `未找到指定文本「${location.anchors[0]}」` : '返修意见未提供可定位的页面文字';
        const failure = classifyFailure(`没有合格的特写取景：${missing}，需要阅读员重新定位公开页面，未使用首屏替代。`,{url:page.url(),requestedUrl:href});
        accessFailures.push(failure);
        ctx.progress(failure.message,{tool:"reject",text:hints.join("\n"),ok:false});
        continue;
      }
      if (corrected?.interaction) {
        ctx.signal.throwIfAborted();
        if (corrected.interaction.kind === 'open-dialog') {
          const opened = await openReadOnlyDialog(page, corrected.interaction.label, ctx.signal);
          actions.push(opened.action); location = opened.location;
        } else actions.push(await openReadOnlyPreview(page, corrected.interaction.index, ctx.signal));
        ctx.progress('已打开并核对原页预览，保留实际交互记录', {tool: 'browser', text: actions.at(-1)!, ok: true});
      }
      const stageDeadline = Date.now() + 45000;
      const stageWait = { deadline: stageDeadline, signal: ctx.signal, anchorY: location?.y };
      if (usesStage) ctx.progress("等待实际舞台与 iframe 内容就绪（共用最多 45 秒）", { tool: "browser", text: "stage discovery and rendering" });
      let stage = corrected?.interaction ? null : usesStage ? await findStage(page, stageWait) : kind === "tool" ? await findStage(page, { signal: ctx.signal, anchorY: location?.y }) : null;
      if (stage) {
        if(!nativeViewport||!location?.matched)await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 120)), stage.y);
        const settleBudget = Math.min(8000, stageDeadline - Date.now());
        if (settleBudget > 0) await page.waitForLoadState("networkidle", { timeout: settleBudget }).catch(() => {});
        stage = (await findStage(page, stageWait)) || stage;
        if (await iframeEmpty(page, stage, stageWait)) { ctx.progress(`拒收 ${new URL(href).pathname}：舞台 iframe 是空的`, { tool: "reject", text: "iframe-empty", ok: false }); continue; }
        const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        const clip = stageClip(stage, pageWidth);
        captureState = await sampleBrowserCapture(page, nativeViewport ? null : clip);
        png = nativeViewport ? await shoot(page, undefined, {signal: ctx.signal}) :
          await letterbox(await shoot(page, clip, {signal: ctx.signal}), clip, {signal: ctx.signal});
        framing = `${nativeViewport ? '原生视口；' : ''}舞台 ${stage.sel} ${Math.round(stage.w)}×${Math.round(stage.h)}`;
      }
      if (!png) {
        if (usesStage && !corrected?.interaction) { ctx.progress(`拒收 ${new URL(href).pathname}：没找到舞台`, { tool: "reject", text: "no-stage-found", ok: false }); continue; }
        if (location?.matched) {
          const readiness = await waitProofCaptureReady(page, location, {deadline: readinessDeadline, signal: ctx.signal});
          const raw = svc.store.put(Buffer.from(JSON.stringify(readiness)), 'json');
          readinessRef = {src: raw.src, sha256: raw.sha};
          const observed = ctx.addEvidence({id: `readiness-${ctx.attempt}-${tried}`, kind: 'text', src: raw.src,
            label: '原页渲染等待观测（待独审）', meta: {role: 'proof', href: page.url(), review: 'pending',
              readiness: readinessRef, status: readiness.status, elapsedMs: readiness.elapsedMs, budgetMs: readiness.budgetMs}});
          if (readiness.status !== 'ready') {
            ctx.progress('CAPTURE_NOT_READY：原页目标在有界等待内尚未就绪',
              {tool: 'reject', text: 'CAPTURE_NOT_READY', ok: false, evidence: [observed.id]});
            return {ok: false, summary: '原页特写尚未就绪', error: 'CAPTURE_NOT_READY',
              failure: {tag: 'browser_capture', category: 'system', code: 'CAPTURE_NOT_READY',
                message: '已定位的原页目标仍在淡入或等待媒体，未拍摄替代首屏', url: page.url(), requestedUrl: href,
                retryable: true, owner: 'system', nextAction: '保留该精确目标及原观察，按现有恢复策略处理渲染等待。'},
              data: {proofReadiness: readinessRef}, usage};
          }
        }
        captureState = await sampleBrowserCapture(page);
        png = await shoot(page, undefined, {signal: ctx.signal});
      }
      if (actions.length && captureState) captureState = {...captureState, actions};
      const previewRegion = corrected?.interaction?.kind === 'open-dialog' && location?.selector ? await page.locator(location.selector).evaluate(element => {
        const box = (element.querySelector('.modal-content') ?? element).getBoundingClientRect();
        const x = Math.max(0, Math.ceil(box.left)), y = Math.max(0, Math.ceil(box.top));
        return {x, y, width: Math.max(0, Math.min(innerWidth, Math.floor(box.right)) - x), height: Math.max(0, Math.min(innerHeight, Math.floor(box.bottom)) - y)};
      }) : undefined;
      const check = await checkImage(png, hashes, {stage: Boolean(stage), signal: ctx.signal, previewRegion});
      if (check.issues.length) { ctx.progress(`拒收 ${new URL(href).pathname}：${check.issues.join("、")}`, { tool: "reject", text: check.issues.join(", "), ok: false }); continue; }
      ctx.progress(`候选 ${new URL(href).pathname}：${framing}，内容占比 ${(check.stats.content * 100).toFixed(1)}%`, { tool: "shot", text: framing, ok: true });
      if (!best || check.stats.content > best.content || (locateOf.has(norm(href)) && !locateOf.has(norm(best.href)))) best = { href, png, content: check.stats.content, hash: check.hash, framing, title: await page.title().catch(() => ""), location, captureState: captureState!, readiness: readinessRef, imageCheck: check };
      if (locateOf.has(norm(href)) && check.stats.content > 0.05) break;
      if (!usesStage) break;
      if (best && tried >= 3 && best.content > 0.12) break;
    }
    if (!best) return { ok: false, summary: "没有合格的特写", error: tried ? `试了 ${tried} 页都不合格` : "需要重新选页：交阅读员重新查找公开特写页面",failure:accessFailures.length===tried?accessFailures.at(-1):undefined, data:{needsPick:{proof:candidates},candidateAccessFailures:accessFailures},usage };
    const file = path.join(workDir(svc, ctx), "proof.png");
    fs.writeFileSync(file, best.png);
    const ev = await shotEvidence(ctx, svc, best.png, "proof", { href: best.href, framing: best.framing, location: best.location, content: Number(best.content.toFixed(3)), tried, captureState: best.captureState, readiness: best.readiness, imageCheck: best.imageCheck });
    ctx.progress(`选中 ${new URL(best.href).pathname}（试 ${tried} 页，内容占比最高 ${(best.content * 100).toFixed(1)}%）`, { tool: "shot", text: best.framing, ok: true, evidence: [ev.id] });
    shots.proof = { file, href: best.href, hash: best.hash, evidence: ev.id, framing: best.framing, content: best.content, title: best.title, location: best.location, capturedAt: best.captureState.capturedAt, captureState: best.captureState, readiness: best.readiness };
    return { ok: true, summary: `特写 ✓ ${new URL(best.href).pathname}`, data: { shots, candidateAccessFailures: accessFailures,
      ...ownerCaptureTargetPatch(ctx, 'proof', corrected, best.captureState.capturedAt) }, usage };
  } finally { await close(); }
};

/* ------------------------------------------------------------------ ⑨ record */

const record: Tool = async (ctx, svc) => {
  const url = String((ctx.token.data.home as { finalUrl?: string })?.finalUrl ?? ctx.token.data.canonical);
  const dir = path.join(workDir(svc, ctx), "video");
  fs.mkdirSync(dir, { recursive: true });
  const { page, close } = await openPage(VIEW, "zh-CN", ctx.signal);
  let report, finalUrl = url;
  try { report = await recordScroll(page, url, dir, (t) => ctx.progress(t, { tool: "record", text: t }),ctx.signal); finalUrl = page.url(); } finally { await close(); }
  const put = (name: string, ext: string) => svc.store.put(fs.readFileSync(path.join(dir, name)), ext);
  const full = put("preview.mp4", "mp4"), card = put("preview.card.mp4", "mp4"), poster = put("poster.webp", "webp"), posterCard = put("poster.card.webp", "webp");
  const ev = ctx.addEvidence({ id: `vid-${card.sha.slice(0, 16)}`, kind: "video", src: full.src, card: card.src, poster: posterCard.src, label: "滚动录屏", tone: report.issues.length ? "bad" : "ok", meta: { ...report, posterFull: poster.src } });
  ctx.progress(`录屏 ${report.durationSec}s · 变化帧 ${Math.round((report.changedShare as number) * 100)}% · 卡片版 ${(((report.bytes as { card: number }).card) / 1048576).toFixed(2)}MB`, { tool: "gate", text: report.issues.join(", ") || "闸门通过", ok: !report.issues.length, evidence: [ev.id] });
  fs.rmSync(dir, { recursive: true, force: true });
  if (report.issues.length) return { ok: false, summary: `录屏闸门不过：${report.issues.join("、")}`, error: report.issues.join(", ") };
  return { ok: true, summary: `录屏 ✓ ${report.durationSec}s`, data: { video: { evidence: ev.id, url, finalUrl, src: full.src, card: card.src, poster: poster.src, posterCard: posterCard.src, sha256: card.sha, ...report } } };
};

/* ------------------------------------------------------------------ ⑩ process */

const processShots: Tool = async (ctx, svc) => {
  if (ctx.token.data.mode === "video") {
    const preview = videoPreview(ctx.token.data, svc.store);
    if (preview.issues.length) return { ok: false, summary: "录屏或封面校验失败", error: preview.issues.join("；"), data: { images: [] } };
    ctx.progress("录屏与封面内容摘要、格式及尺寸已核对，保留来源页", { tool: "webp", text: preview.images[0].href, ok: true });
    return { ok: true, summary: "录屏 + 封面就绪", data: { images: preview.images } };
  }
  const shots = shotsOf(ctx);
  const roles = ["identity", "breadth", "proof"].filter((r) => shots[r]);
  const images: { role: string; src: string; card: string; sha256: string; ahash: string; href: string; evidence: string; title?: string; capturedAt?: string; captureState?: BrowserCaptureState }[] = [];
  const t0 = Date.now();
  const previous = (ctx.token.data.images ?? []) as typeof images;
  const temporary:string[]=[];
  for (const role of roles) {
    ctx.signal.throwIfAborted();
    const s = shots[role];
    const reusable=previous.find(image=>image.role===role&&image.evidence===s.evidence&&fs.existsSync(svc.store.resolve(image.src)??""));
    if(reusable){
      const captureState = s.captureState ? {...s.captureState, sha256: reusable.sha256, finalWebPSha256: reusable.sha256} : reusable.captureState;
      images.push({...reusable, capturedAt: s.capturedAt ?? reusable.capturedAt, captureState});
      shots[role]={...s,file:svc.store.resolve(reusable.src)!,captureState};
      ctx.progress(`${ROLE_ZH[role]}沿用已验收的持久图像，无需重新拍摄`,{tool:"reuse",text:reusable.sha256,ok:true});continue;
    }
    if (!fs.existsSync(s.file)) return { ok: false, summary: `${ROLE_ZH[role]}原图丢失`, error: `${s.file} missing` };
    const png = fs.readFileSync(s.file);
    const fullBytes = await EvidenceStore.webpAsync(png, 1280, 82, {signal: ctx.signal});
    const cardBytes = await EvidenceStore.webpAsync(png, 720, 80, {signal: ctx.signal});
    const ahash = await aHashAsync(png, {signal: ctx.signal});
    ctx.signal.throwIfAborted();
    const full = svc.store.put(fullBytes, 'webp');
    const card = svc.store.put(cardBytes, 'webp');
    const captureState = s.captureState ? {...s.captureState, sha256: full.sha, finalWebPSha256: full.sha} : undefined;
    images.push({ role, src: full.src, card: card.src, sha256: full.sha, ahash, href: s.href, evidence: s.evidence, title: s.title, capturedAt: s.capturedAt, captureState });
    shots[role]={...s,file:full.file,captureState};
    if(path.resolve(s.file).startsWith(path.resolve(svc.workDir)+path.sep)&&path.extname(s.file)===".png")temporary.push(s.file);
  }
  const dupes: string[] = [];
  for (let i = 0; i < images.length; i++) for (let j = i + 1; j < images.length; j++) if (hamming(images[i].ahash, images[j].ahash) <= 6) dupes.push(`${ROLE_ZH[images[i].role]}≈${ROLE_ZH[images[j].role]}`);
  ctx.progress(`${images.length} 张 → WebP 1280 + 720，用时 ${Date.now() - t0}ms；PNG 不保留`, { tool: "webp", text: images.map((i) => i.sha256.slice(0, 8)).join(" "), ok: true });
  for (const file of temporary) fs.rmSync(file, { force: true });
  if (dupes.length) return { ok: false, summary: `图片重复：${dupes.join("、")}`, error: `duplicate images ${dupes.join(", ")}`, data: { images,shots } };
  return { ok: true, summary: `${images.length} 张互不重复 ✓`, data: { images,shots } };
};

/* ------------------------------------------------------------------ ⑰ assemble + gate: VisLexicon v3 record */

const slug = (v: string) => v.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

export function buildV3(d: Record<string, any>, token: { id: string; url: string }, store: EvidenceStore, tax: Awaited<ReturnType<typeof loadTaxonomy>>) {
  const copy = d.copy ?? {}, facts = d.facts ?? {}, cat = d.catalogV3 ?? {};
  const sourceEntryId = d.externalResearch?.entryId;
  const entryId = typeof sourceEntryId === 'string' && /^[a-zA-Z0-9_-]+$/.test(sourceEntryId) ?
    sourceEntryId : slug(copy.name || d.title || "") || slug(String(d.host));
  const derived = derivedFacets(facts, tax);
  const pages = publicationImages(d, store).map((im) => {
    const file = store.resolve(im.src);
    const size = file ? webpSize(file) : null;
    return {
      role: im.role, sourceUrl: im.href, finalUrl: im.href, title: im.title || d.title,
      selectionRationale: copy.rationale?.[im.role] ?? "",
      shot: { src: im.src, card: im.card, sha256: im.sha256, width: size?.width ?? null, height: size?.height ?? null, bytes: file && fs.existsSync(file) ? fs.statSync(file).size : null, alt: copy.alt?.[im.role] ?? "" },
    };
  });
  const factList = Object.entries(facts as Record<string, { value: string; sourceUrl: string; quote: string; evidence: string; scope: string }>).map(([field, f]) => ({
    field, value: f?.value ?? "unknown", sourceUrl: f?.sourceUrl && /^https?:/.test(f.sourceUrl) ? f.sourceUrl : d.canonical, evidence: [f?.evidence, f?.scope ? `适用范围：${f.scope}` : ""].filter(Boolean).join("；"), quote: f?.quote ?? "", confidence: f?.value && f.value !== "unknown" ? 1 : 0,
  }));
  const now = new Date().toISOString();
  return {
    schemaVersion: 3, entryId, entityId: `entity-${entryId}`, status: "APPROVED",
    official: { inputUrl: token.url, finalUrl: d.dossier?.finalUrl ?? d.home?.finalUrl ?? d.canonical, checkedAt: now },
    editorial: { name: copy.name || d.title, descriptionZh: copy.descriptionZh, descriptionEn: copy.descriptionEn, takeawayZh: copy.takeawayZh, noteZh: copy.noteZh, recommendation: null, pricing: d.pricingNote || facts.pricing?.value || "unknown", pricingNote: null },
    classification: {
      recordLevel: "entry", primaryCategory: cat.primaryCategory, subcategory: cat.subcategory, status: "confirmed", alternatives: [],
      reasons: copy.reasons ?? [], curatorId: "easy-workflow:curation/classify", reviewerId: d.kindAgreed ? "easy-workflow:curation/classify-review" : "easy-workflow:curation/arbiter", confirmedAt: now,
    },
    facets: Object.fromEntries(ALL_AXES.map((a) => [a, a === "access" ? derived.access : a === "licenses" ? derived.licenses : (cat.facets?.[a] ?? [])])),
    pages, facts: factList,
    ...(Array.isArray(d.offers) ? {offers: d.offers} : {}),
    curation: { atlasTerms: [], atlasTermsStatus: "editor-draft" },
    style: d.style ?? null,
    preview: d.mode === "video" ? { mode: "video", video: d.video } : { mode: "shots" },
    editorialVoice: { status: "written", writtenAt: now.slice(0, 10) },
    h2: { token: token.id, kindV1: d.kind, reviews: d.reviews ?? [], note: "Easy Workflow 产出；写入正式资料目录前需站长确认（Spec R4）" },
  };
}

const assemble: Tool = async (ctx, svc) => {
  const tax = await loadTaxonomy();
  const rec = buildV3(ctx.token.data as Record<string, any>, ctx.token, svc.store, tax);
  const problems = validateV3(rec, tax);
  ctx.progress(problems.length ? `结构校验 ${problems.length} 处问题：${problems.slice(0, 3).map((p) => p.field).join("、")}` : "v3 记录组装完成，结构校验全部通过", { tool: "schema", text: problems.map((p) => `${p.field}: ${p.problem}`).join("\n") || "VisLexicon assertBundle + taxonomy validators", ok: !problems.length });
  return { ok: true, summary: problems.length ? `结构问题 ${problems.length} 处，交终审分派` : `v3 记录就绪：${rec.entryId}`, data: { draftV3: rec, draftProblems: problems } };
};

const gate: Tool = async (ctx, svc) => {
  const d = ctx.token.data as Record<string, any>;
  // A retry can resume at audit/gate with an old shotReview=pass. Certify the current
  // capture evidence again here; legacy approval never substitutes for a missing count.
  const breadthIssues = d.mode === "video" ? [] : breadthPreviewIssues(String(d.kind), d.shots?.breadth?.previews, d.shots?.breadth?.visual);
  if (breadthIssues.length) {
    const reason = `${breadthIssues.join("；")}。历史截图审查通过不能覆盖当前目录证据，请重拍并复查受影响的风格、导览与终审。`;
    const shotRepairs = { ...d.shotRepairs, breadth: { action: typeof d.shots?.breadth?.previews === "number" ? "replace-page" : "reframe", url: d.shots?.breadth?.href, reason } };
    ctx.progress(`发布前拒收目录截图：${breadthIssues.join("；")}`, { tool: "gate", text: reason, ok: false });
    ctx.addEvidence({ id: `gate-breadth-${ctx.attempt}`, kind: "verdict", label: "发布闸门", verdict: "目录截图需重新验收", tone: "warn", meta: { previews: d.shots?.breadth?.previews ?? null, issues: breadthIssues } });
    return {
      ok: true, summary: "暂不发布：目录预览未通过当前门禁，直接退回摄影修复",
      data: { gate: "repair", digest: null, shotReview: "pending", "copy-reviewVerdict": "pending", auditVerdict: "pending", shotRepairs },
      verdict: { verdict: "fix", reason, fixes: [{ station: "curation/breadth", fields: ["shots.breadth", "images"], problem: reason, via: ["curation/process", "curation/shot-review", "curation/style", "curation/copy", "curation/copy-review", "curation/assemble", "curation/audit"] }] },
    };
  }
  const missing: string[] = [];
  if (!d.kind) missing.push("分类");
  if (!(d.kindAgreed || d.arbiterDecided)) missing.push("分类复核");
  if (d.mode === "video" ? !d.video : (d.images?.length ?? 0) < 3) missing.push(d.mode === "video" ? "录屏" : "三张图");
  if (d.mode === "video") missing.push(...videoPreview(d, svc.store).issues);
  if (d.shotReview !== "pass") missing.push("截图审查");
  for (const [k, label] of [["fact-reviewVerdict", "事实审查"], ["copy-reviewVerdict", "文案审查"], ["auditVerdict", "终审"]]) if (d[k] !== "pass") missing.push(label);
  const tax = await loadTaxonomy();
  const record = buildV3(d, ctx.token, svc.store, tax);
  const problems = validateV3(record, tax);
  if (problems.length) missing.push(`结构 ${problems.length} 处（${problems.slice(0, 2).map((p) => p.field).join("、")}）`);
  const digest = crypto.createHash("sha256").update(JSON.stringify({ ...record, official: { ...record.official, checkedAt: "" }, classification: { ...record.classification, confirmedAt: "" }, editorialVoice: null })).digest("hex");
  ctx.progress(`检查 ${missing.length ? "未通过" : "全部通过"}；内容摘要 ${digest.slice(0, 12)}`, { tool: "gate", text: missing.length ? `缺：${missing.join("、")}` : "审核与结构全部通过", ok: !missing.length });
  if (missing.length) return { ok: true, summary: `不发布：缺 ${missing.join("、")}`, data: { gate: "fail", manualReason: `发布闸门：缺 ${missing.join("、")}` } };
  const out = { ...record, h2: { ...record.h2, digest, publishedAt: new Date().toISOString() } };
  fs.mkdirSync(svc.publishDir, { recursive: true });
  fs.writeFileSync(path.join(svc.publishDir, `${String(d.key ?? d.host).replace(/[\/:*?"<>|]+/g, "~")}.json`), JSON.stringify(out, null, 2));
  ctx.addEvidence({ id: `gate-${digest.slice(0, 12)}`, kind: "verdict", label: "发布闸门", verdict: "可发布 ✓", tone: "ok", meta: { digest, entryId: record.entryId } });
  return { ok: true, summary: `发布 ✓ ${record.entryId}`, data: { gate: "pass", digest } };
};

export const TOOLS: Record<string, Tool> = {
  ...COMPONENT_TOOLS, ...MEDIA_TOOLS,
  "candidates.tidy": tidy, "candidates.extract": extract, "candidates.index": index, "candidates.route": route,
  "curation.dedupe": dedupe, "curation.fetch": fetchHome, "curation.scout": (ctx, svc) => scout(ctx, svc), "curation.kind-join": kindJoin, "curation.assemble": assemble,
  "curation.plan": plan, "curation.identity": identity,
  "curation.breadth": breadth, "curation.proof": proof, "curation.record": record, "curation.process": processShots, "curation.gate": gate,
};
