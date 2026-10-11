// Program stations of the VisLexicon pack (Spec §8): deterministic steps that never call a
// model. Each returns a structured result; evidence is written to the content store and
// shows up next to its node on the canvas.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EvidenceRef, Usage } from "../../shared/types.ts";
import { EvidenceStore, aHash, hamming } from "../../server/evidence.ts";
import { openPage } from "../../server/browser.ts";
import { webGet } from "../../server/network.ts";
import { classifyFailure, type Failure } from "../../shared/failures.ts";
import { pickOne } from "../../server/agent-station.ts";
import type { StationContext, StationResult } from "../../server/runtime.ts";
import { KIND_ZH, PREVIEW_RULES, loadPublished } from "./env.ts";
import { scout } from "./scout.ts";
import { repoOf } from "../../server/repo.ts";
import { ALL_AXES, CHOSEN_AXES, derivedFacets, loadTaxonomy, validateV3, webpSize } from "./v3.ts";
import {
  VIEW, checkImage, findStage, iframeEmpty, letterbox, links, motionFirst, previewsInViewport, breadthPreviewIssues, recordScroll, sameSite,
  scoreLinks, shoot, stageClip, visit, pageKey, type Link,
} from "./capture.ts";

export interface Services {
  store: EvidenceStore;
  workDir: string;
  publishDir: string;
  /** Identity keys of tokens past dedupe and still on the line (excluding `self`). */
  inFlight: (self: string) => Set<string>;
  tryBrowser?:()=>{release:()=>void}|null;
}

type Tool = (ctx: StationContext, svc: Services) => Promise<StationResult>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  let r = "curation";
  if (/github\.com\/.+\/(DESIGN|SKILL)\.md$/i.test(u) || /\/(DESIGN|SKILL)\.md$/i.test(u)) r = "skills";
  else if (/\.(pptx?|key)$/i.test(u)) r = "ppt";
  const zh: Record<string, string> = { curation: "策展线", skills: "Skill 线", ppt: "PPT 线" };
  return { ok: true, summary: `→ ${zh[r]}`, data: { route: r } };
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
  const mode = kind === "work" ? "video" : "shots";
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

function shotEvidence(ctx: StationContext, svc: Services, png: Buffer, role: string, meta: Record<string, unknown>): EvidenceRef {
  const card = svc.store.put(EvidenceStore.webp(png, 720), "webp");
  return ctx.addEvidence({ id: `img-${card.sha.slice(0, 12)}-${ctx.attempt.slice(2, 8)}`, kind: "image", src: card.src, card: card.src, label: ROLE_ZH[role] ?? role, meta: { role, ...meta } });
}
const ROLE_ZH: Record<string, string> = { identity: "首屏", breadth: "目录", proof: "组件特写" };
type ShotData = { file: string; href: string; hash: string; evidence: string; framing?: string; content?: number; title?: string; previews?: number };
type ReaderPlan = { identity?: { url: string }; breadth?: { url: string; alternatives?: { url: string }[] }; proof?: { url: string; locate?: string; alternatives?: { url: string; locate?: string }[] } };
const readerPlanOf = (ctx: StationContext) => ctx.token.data.readerPlan as ReaderPlan | undefined;
const shotsOf = (ctx: StationContext) => ({ ...((ctx.token.data.shots as Record<string, ShotData>) ?? {}) });

async function visitCandidate(page:Parameters<typeof visit>[0],href:string,host:string,ctx:StationContext,errors:Failure[]) {
  try{return await visit(page,href,host,t=>ctx.progress(t,{tool:"browser",text:t}));}
  catch(error){ctx.signal.throwIfAborted();const failure=(error as {failure?:Failure}).failure??classifyFailure(error,{url:href});if(["auth_required","network_tls"].includes(failure.tag))throw error;errors.push(failure);return {issues:[`${failure.tag}: ${failure.message}`],hidden:[]};}
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
    let png = await shoot(page);
    let check = checkImage(png, []);
    if (check.issues.includes("flat-block")) {
      ctx.progress("首屏是大块单色：轻推滚动、等 4 秒再拍", { tool: "browser", text: "flat-block retry" });
      const firstHash = check.hash;
      await page.mouse.wheel(0, 2); await sleep(300); await page.mouse.wheel(0, -2); await sleep(4000);
      png = await shoot(page); check = checkImage(png, []);
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
    const ev = shotEvidence(ctx, svc, png, "identity", { href: page.url(), issues, hidden: home.hidden.length, content: Number(check.stats.content.toFixed(3)) });
    ctx.progress(`截首屏 ${issues.length ? `（问题：${issues.join("、")}）` : "✓"}`, { tool: "shot", text: "1280×800 视口", ok: !issues.length, evidence: [ev.id] });
    const motionVideo = (motion.scrollHijacked || motion.canvasHero) && ctx.token.data.kind !== "component-source" && ctx.token.data.kind !== "design-system";
    const mode = ctx.token.data.mode === "video" || motionVideo ? "video" : "shots";
    if (motionVideo) ctx.progress(`动效优先：${motion.scrollHijacked ? "滚动被劫持" : "画布盖住首屏"} → 改走录屏`, { tool: "rules", text: "motionFirstSignals" });
    const shots = shotsOf(ctx);
    shots.identity = { file, href: page.url(), hash: check.hash, evidence: ev.id, content: check.stats.content, title: await page.title().catch(() => "") };
    if (issues.length && mode === "shots" && !issues.every((i) => i === "consentOverlay")) {
      return { ok: false, summary: `首屏不合格：${issues.join("、")}`, error: issues.join(", "), data: { shots, homeLinks: homeLinks.slice(0, 150) } };
    }
    return { ok: true, summary: mode === "video" ? "首屏 ✓ · 动效站，转录屏" : "首屏 ✓", data: { shots, homeLinks: homeLinks.slice(0, 150), mode, motion } };
  } finally { await close(); }
};

/* ------------------------------------------------------------------ ⑦ breadth */

const breadth: Tool = async (ctx, svc) => {
  const kind = String(ctx.token.data.kind || "work");
  const role = PREVIEW_RULES.kinds[kind]?.roles.breadth ?? {};
  const host = String(ctx.token.data.host);
  const shots = shotsOf(ctx);
  const exclude = new Set<string>((ctx.token.data.rejectedPages as string[]) ?? []);
  const repair=(ctx.token.data.shotRepairs as Record<string,{action:string;url?:string}>|undefined)?.breadth;
  const explicit=(ctx.token.data.previewChoices as Record<string,string>|undefined)?.breadth;
  if(explicit)exclude.delete(pageKey(explicit));
  if (ctx.redo && shots.breadth?.href && (!repair||repair.action==="replace-page")) exclude.add(pageKey(shots.breadth.href));
  // The home page itself never counts as the catalogue.
  for (const h of [shots.identity?.href, String(ctx.token.data.canonical), (ctx.token.data.home as { finalUrl?: string })?.finalUrl]) if (h) exclude.add(pageKey(h));
  const pool = [...((ctx.token.data.homeLinks as Link[]) ?? []), ...(((ctx.token.data.home as { navLinks?: Link[] })?.navLinks) ?? [])];
  if(!pool.some(l=>new URL(l.href).searchParams.has('path'))&&String(ctx.token.data.title).toLowerCase().includes('storybook')) {
    const probe=await openPage(VIEW,'en-US',ctx.signal);try{await visit(probe.page,shots.identity?.href??ctx.token.url,host);pool.push(...await links(probe.page));}finally{await probe.close();}
  }
  const ranked: { href: string; score: number; reasons: string[]; text: string }[] = scoreLinks(pool, role).filter((c) => !exclude.has(c.href)).slice(0, 4);
  const plan=readerPlanOf(ctx)?.breadth;
  if(plan&&!explicit)for(const u of [plan.url,...(plan.alternatives??[]).map(a=>a.url)].reverse())if(u&&sameSite(u,host)&&!exclude.has(pageKey(u))){const i=ranked.findIndex(r=>pageKey(r.href)===pageKey(u));if(i>=0)ranked.splice(i,1);ranked.unshift({href:u,text:"阅读员拍摄单",score:20,reasons:['reader-plan']});}
  if(repair&&repair.action!=="replace-page"&&repair.url&&!exclude.has(pageKey(repair.url)))ranked.unshift({href:repair.url,text:"按复审重新取景",score:10,reasons:['review-reframe']});
  if(explicit)ranked.splice(0,ranked.length,{href:explicit,text:"已指定目录页",score:100,reasons:['explicit-choice']});
  for(const link of pool.filter(l=>new URL(l.href).searchParams.get('path')?.startsWith('/docs/')).slice(0,4))if(!exclude.has(pageKey(link.href))&&!ranked.some(r=>pageKey(r.href)===pageKey(link.href)))ranked.push({href:link.href,text:link.text,score:8,reasons:['storybook-docs']});
  ctx.progress(`目录候选 ${ranked.length} 个：${ranked.map((r) => new URL(r.href).pathname).join("  ") || "无"}`, { tool: "rules", text: "path +3 · text +2 · nav +1" });
  let usage: Usage | undefined;
  let selectionCalls=0;
  const options = dedupeLinks(pool).filter((l) => !exclude.has(l.href.replace(/\/+$/, "")) && l.href.replace(/\/+$/, "") !== String(ctx.token.data.canonical)).slice(0, 30);
  if (!ranked.length) {
    selectionCalls++;
    const pick = await pickOne(ctx, `Website ${ctx.token.data.title} is a ${KIND_ZH[kind] ?? kind} (${kind}). Which link leads to the catalogue / overview page that best shows the RANGE of what it offers?`, options.map((l) => `${l.text} → ${l.href}`));
    if (pick) { usage = pick.usage; ranked.push({ href: options[pick.index].href, score: 0, reasons: ["needsPick"], text: options[pick.index].text }); }
  }
  const { page, close } = await openPage(VIEW, "en-US", ctx.signal);
  try {
    const hashes = [shots.identity?.hash ?? ""];
    const tried = new Set<string>();
    const accessFailures:Failure[]=[];
    for (let i = 0; i < ranked.length; i++) {
      const c = ranked[i];
      tried.add(c.href.replace(/\/+$/, ""));
      const v = await visitCandidate(page,c.href,host,ctx,accessFailures);
      if(v.issues.some(i=>/^(network_|http_|page_)/.test(i))){ctx.progress(`候选访问失败，继续下一页：${c.href}`,{tool:"reject",text:v.issues.join(", "),ok:false});continue;}
      if(c.reasons.includes('review-reframe')){
        const stage=await findStage(page);
        if(stage)await page.evaluate(y=>window.scrollTo(0,Math.max(0,y-120)),stage.y);
        await page.waitForLoadState('networkidle',{timeout:5000}).catch(()=>{});
        await sleep(1000);
        ctx.progress('按复审保留原页，等待预览并重新取景',{tool:'browser',text:'保留 URL，更新画面'});
      }
      const png = await shoot(page);
      const check = checkImage(png, hashes);
      let previews = await previewsInViewport(page);
      const issues = [...v.issues, ...check.issues, ...breadthPreviewIssues(kind, previews)];
      if (issues.length) {
        ctx.progress(`拒收 ${new URL(c.href).pathname}：${issues.join("、")}`, { tool: "reject", text: issues.join(", "), ok: false });
        // Rules ran out: one needsPick round over the links not tried yet.
        tried.add(pageKey(page.url()));
        if (i === ranked.length - 1 && selectionCalls<2 && !explicit) {
          const rest = options.filter((l) => !tried.has(pageKey(l.href))&&!exclude.has(pageKey(l.href)));
          selectionCalls++;
          const pick = await pickOne(ctx, `Website ${ctx.token.data.title} is a ${KIND_ZH[kind] ?? kind}. Previous choice ${c.href} led to ${page.url()} and was rejected: ${issues.join(', ')}. Choose a DIFFERENT remaining catalogue, module overview or usage page that adds information beyond the home page. Return no choice if none exists.`, rest.map((l) => `${l.text} → ${l.href}`));
          if (pick) { usage = {input:(usage?.input??0)+pick.usage.input,output:(usage?.output??0)+pick.usage.output,cost:(usage?.cost??0)+pick.usage.cost}; ranked.push({ href: rest[pick.index].href, score: 0, reasons: ["needsPick"], text: rest[pick.index].text }); }
        }
        continue;
      }
      let chosen = { png, hash: check.hash, href: page.url(), reason: c.reasons.includes("reader-plan") ? "阅读员拍摄单" : c.reasons.includes("needsPick") ? "模型从编号列表选的（needsPick）" : `score ${c.score}（${c.reasons.join("+")}）` };
      const deeper = (await links(page)).filter((l) => sameSite(l.href, host));
      let breadthLinks=deeper;
      const better = scoreLinks(deeper, role).find((x) => x.score > c.score + 0.3 && x.href.replace(/\/+$/, "") !== c.href.replace(/\/+$/, "") && !exclude.has(x.href));
      if (better) {
        ctx.progress(`第二跳：${new URL(better.href).pathname} 分数 ${better.score} 高于 ${c.score}`, { tool: "rules", text: "second hop" });
        const hop = await visitCandidate(page,better.href,host,ctx,accessFailures);
        if(!hop.issues.length){const hopPng = await shoot(page);
          const hopCheck = checkImage(hopPng, hashes);
          const hopPreviews = await previewsInViewport(page);
          const hopIssues = [...hopCheck.issues, ...breadthPreviewIssues(kind, hopPreviews)];
          if (!hopIssues.length) {chosen = { png: hopPng, hash: hopCheck.hash, href: page.url(), reason: `第二跳 ${better.score} > ${c.score}` };breadthLinks=(await links(page)).filter(l=>sameSite(l.href,host));previews=hopPreviews;}
          else ctx.progress(`第二跳拒收：${hopIssues.join("、")}`, { tool: "reject", text: hopIssues.join(", "), ok: false });
        }
      }
      const file = path.join(workDir(svc, ctx), "breadth.png");
      fs.writeFileSync(file, chosen.png);
      const ev = shotEvidence(ctx, svc, chosen.png, "breadth", { href: chosen.href, reason: chosen.reason, previews });
      ctx.progress(`截目录 ✓ ${new URL(chosen.href).pathname}（${chosen.reason}）`, { tool: "shot", text: `首屏内预览 ${previews} 个`, ok: true, evidence: [ev.id] });
      shots.breadth = { file, href: chosen.href, hash: chosen.hash, evidence: ev.id, title: await page.title().catch(() => ""), previews };
      return { ok: true, summary: `目录 ✓ ${new URL(chosen.href).pathname}`, data: { shots, breadthLinks: breadthLinks.slice(0, 200) }, usage };
    }
    return { ok: false, summary: "没有合格的目录页", error: ranked.length ? "所有候选都被拒收" : "规则和模型都没找到目录页（needsPick 交人）", failure:accessFailures.length===tried.size?accessFailures.at(-1):undefined,usage, data: { needsPick: { breadth: options.map((l, i) => `${i + 1}. ${l.text} → ${l.href}`) },candidateAccessFailures:accessFailures } };
  } finally { await close(); }
};

/* ------------------------------------------------------------------ ⑧ proof */

const proof: Tool = async (ctx, svc) => {
  const kind = String(ctx.token.data.kind || "component-source");
  const role = PREVIEW_RULES.kinds[kind]?.roles.proof ?? {};
  const host = String(ctx.token.data.host);
  const shots = shotsOf(ctx);
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
  const repair=(ctx.token.data.shotRepairs as Record<string,{action:string;url?:string}>|undefined)?.proof;
  const explicit=(ctx.token.data.previewChoices as Record<string,string>|undefined)?.proof;
  const taken = new Set([norm(String(ctx.token.data.canonical)), norm(shots.breadth?.href ?? ""), norm(shots.identity?.href ?? ""), ...(((ctx.token.data.rejectedPages as string[]) ?? []).map(norm))]);
  const planned=readerPlanOf(ctx)?.proof;
  const locateOf=new Map<string,string>();
  if(planned&&!explicit){const picks=[planned,...(planned.alternatives??[])].filter(p=>p.url&&sameSite(p.url,host));for(const p of picks)if(p.locate)locateOf.set(norm(p.url),p.locate);candidates=[...picks.map(p=>p.url),...candidates];}
  if(repair&&repair.action!=="replace-page"&&repair.url)candidates=[repair.url];
  else if (ctx.redo && shots.proof?.href) taken.add(norm(shots.proof.href));
  if(explicit){candidates=[explicit];taken.delete(norm(explicit));}
  candidates = [...new Set(candidates.map(norm))].filter((h) => !taken.has(h)).slice(0, 6);
  let usage: Usage | undefined;
  if (!candidates.length) {
    const options = dedupeLinks(breadthLinks.length ? breadthLinks : homeLinks).filter((l) => !taken.has(norm(l.href))).slice(0, 30);
    const pick = await pickOne(ctx, `Website ${ctx.token.data.title} is a ${KIND_ZH[kind] ?? kind} (${kind}). Which link leads to ONE concrete item rendered for real (a single component demo / one work / one asset), not docs text or installation?`, options.map((l) => `${l.text} → ${l.href}`));
    if (pick) { usage = pick.usage; candidates = [norm(options[pick.index].href)]; }
  }
  ctx.progress(`特写候选 ${candidates.length} 页${usesStage ? "，只截舞台" : ""}`, { tool: "rules", text: candidates.map((c) => new URL(c).pathname).join("  ") });
  const { page, close } = await openPage(VIEW, "en-US", ctx.signal);
  try {
    const hashes = [shots.identity?.hash ?? "", shots.breadth?.hash ?? ""];
    let best: { href: string; png: Buffer; content: number; hash: string; framing: string; title: string } | null = null;
    let tried = 0;
    const accessFailures:Failure[]=[];
    for (const href of candidates) {
      if (ctx.signal.aborted) break;
      tried++;
      const v = await visitCandidate(page,href,host,ctx,accessFailures);
      if (v.issues.length) { ctx.progress(`拒收 ${new URL(href).pathname}：${v.issues.join("、")}`, { tool: "reject", text: v.issues.join(", "), ok: false }); continue; }
      let png: Buffer | null = null;
      let framing = "viewport";
      const locate=locateOf.get(norm(href));
      if(locate){const found=await page.evaluate((text)=>{const words=text.split(/[，,；;（）()]/).map(s=>s.trim()).filter(s=>s.length>=2);for(const w of words){const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n:Node|null;while((n=walker.nextNode())){if((n.textContent??"").toLowerCase().includes(w.toLowerCase())&&n.parentElement&&!n.parentElement.closest("nav,aside,footer,header")){n.parentElement.scrollIntoView({block:"start"});return w;}}}return null;},locate).catch(()=>null);if(found){await sleep(800);ctx.progress(`按阅读员提示定位到「${found}」附近`,{tool:"browser",text:locate});}}
      let stage = usesStage || kind==="tool" ? await findStage(page) : null;
      if (stage) {
        await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 120)), stage.y);
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        for (const frame of page.frames()) if (frame !== page.mainFrame()) await frame.waitForLoadState("load", { timeout: 8000 }).catch(() => {});
        await sleep(1500);
        stage = (await findStage(page)) || stage;
        if ((stage.sel.startsWith("iframe") || stage.media > 0) && (await iframeEmpty(page))) { ctx.progress(`拒收 ${new URL(href).pathname}：舞台 iframe 是空的`, { tool: "reject", text: "iframe-empty", ok: false }); continue; }
        const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        const clip = stageClip(stage, pageWidth);
        png = letterbox(await shoot(page, clip), clip);
        framing = `舞台 ${stage.sel} ${Math.round(stage.w)}×${Math.round(stage.h)}`;
      }
      if (!png) {
        if (usesStage) { ctx.progress(`拒收 ${new URL(href).pathname}：没找到舞台`, { tool: "reject", text: "no-stage-found", ok: false }); continue; }
        png = await shoot(page);
      }
      const check = checkImage(png, hashes, { stage: Boolean(stage) });
      if (check.issues.length) { ctx.progress(`拒收 ${new URL(href).pathname}：${check.issues.join("、")}`, { tool: "reject", text: check.issues.join(", "), ok: false }); continue; }
      ctx.progress(`候选 ${new URL(href).pathname}：${framing}，内容占比 ${(check.stats.content * 100).toFixed(1)}%`, { tool: "shot", text: framing, ok: true });
      if (!best || check.stats.content > best.content || (locateOf.has(norm(href)) && !locateOf.has(norm(best.href)))) best = { href, png, content: check.stats.content, hash: check.hash, framing, title: await page.title().catch(() => "") };
      if (locateOf.has(norm(href)) && check.stats.content > 0.05) break;
      if (!usesStage) break;
      if (best && tried >= 3 && best.content > 0.12) break;
    }
    if (!best) return { ok: false, summary: "没有合格的特写", error: tried ? `试了 ${tried} 页都不合格` : "规则和模型都没找到特写页（needsPick 交人）",failure:accessFailures.length===tried?accessFailures.at(-1):undefined, data:{needsPick:{proof:candidates},candidateAccessFailures:accessFailures},usage };
    const file = path.join(workDir(svc, ctx), "proof.png");
    fs.writeFileSync(file, best.png);
    const ev = shotEvidence(ctx, svc, best.png, "proof", { href: best.href, framing: best.framing, content: Number(best.content.toFixed(3)), tried });
    ctx.progress(`选中 ${new URL(best.href).pathname}（试 ${tried} 页，内容占比最高 ${(best.content * 100).toFixed(1)}%）`, { tool: "shot", text: best.framing, ok: true, evidence: [ev.id] });
    shots.proof = { file, href: best.href, hash: best.hash, evidence: ev.id, framing: best.framing, content: best.content, title: best.title };
    return { ok: true, summary: `特写 ✓ ${new URL(best.href).pathname}`, data: { shots }, usage };
  } finally { await close(); }
};

/* ------------------------------------------------------------------ ⑨ record */

const record: Tool = async (ctx, svc) => {
  const url = String((ctx.token.data.home as { finalUrl?: string })?.finalUrl ?? ctx.token.data.canonical);
  const dir = path.join(workDir(svc, ctx), "video");
  fs.mkdirSync(dir, { recursive: true });
  const { page, close } = await openPage(VIEW, "zh-CN", ctx.signal);
  let report;
  try { report = await recordScroll(page, url, dir, (t) => ctx.progress(t, { tool: "record", text: t }),ctx.signal); } finally { await close(); }
  const put = (name: string, ext: string) => svc.store.put(fs.readFileSync(path.join(dir, name)), ext);
  const full = put("preview.mp4", "mp4"), card = put("preview.card.mp4", "mp4"), poster = put("poster.webp", "webp"), posterCard = put("poster.card.webp", "webp");
  const ev = ctx.addEvidence({ id: `vid-${card.sha.slice(0, 16)}`, kind: "video", src: full.src, card: card.src, poster: posterCard.src, label: "滚动录屏", tone: report.issues.length ? "bad" : "ok", meta: { ...report, posterFull: poster.src } });
  ctx.progress(`录屏 ${report.durationSec}s · 变化帧 ${Math.round((report.changedShare as number) * 100)}% · 卡片版 ${(((report.bytes as { card: number }).card) / 1048576).toFixed(2)}MB`, { tool: "gate", text: report.issues.join(", ") || "闸门通过", ok: !report.issues.length, evidence: [ev.id] });
  fs.rmSync(dir, { recursive: true, force: true });
  if (report.issues.length) return { ok: false, summary: `录屏闸门不过：${report.issues.join("、")}`, error: report.issues.join(", ") };
  return { ok: true, summary: `录屏 ✓ ${report.durationSec}s`, data: { video: { evidence: ev.id, src: full.src, card: card.src, poster: poster.src, posterCard: posterCard.src, sha256: card.sha, ...report } } };
};

/* ------------------------------------------------------------------ ⑩ process */

const processShots: Tool = async (ctx, svc) => {
  if (ctx.token.data.mode === "video") {
    const v = ctx.token.data.video as { evidence: string } | undefined;
    if (!v) return { ok: false, summary: "没有录屏", error: "video missing" };
    ctx.progress("录屏路线：封面已是 WebP，校验字节与尺寸", { tool: "webp", text: "poster.webp + poster.card.webp", ok: true });
    return { ok: true, summary: "录屏 + 封面就绪", data: { images: [] } };
  }
  const shots = shotsOf(ctx);
  const roles = ["identity", "breadth", "proof"].filter((r) => shots[r]);
  const images: { role: string; src: string; card: string; sha256: string; ahash: string; href: string; evidence: string; title?: string }[] = [];
  const t0 = Date.now();
  const previous = (ctx.token.data.images ?? []) as typeof images;
  const temporary:string[]=[];
  for (const role of roles) {
    const s = shots[role];
    const reusable=previous.find(image=>image.role===role&&image.evidence===s.evidence&&fs.existsSync(svc.store.resolve(image.src)??""));
    if(reusable){images.push(reusable);shots[role]={...s,file:svc.store.resolve(reusable.src)!};ctx.progress(`${ROLE_ZH[role]}沿用已验收的持久图像，无需重新拍摄`,{tool:"reuse",text:reusable.sha256,ok:true});continue;}
    if (!fs.existsSync(s.file)) return { ok: false, summary: `${ROLE_ZH[role]}原图丢失`, error: `${s.file} missing` };
    const png = fs.readFileSync(s.file);
    const full = svc.store.put(EvidenceStore.webp(png, 1280, 82), "webp");
    const card = svc.store.put(EvidenceStore.webp(png, 720, 80), "webp");
    images.push({ role, src: full.src, card: card.src, sha256: full.sha, ahash: aHash(png), href: s.href, evidence: s.evidence, title: s.title });
    shots[role]={...s,file:full.file};
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
  const entryId = slug(copy.name || d.title || "") || slug(String(d.host));
  const derived = derivedFacets(facts, tax);
  const pages = ((d.images ?? []) as { role: string; src: string; card: string; sha256: string; href: string; title?: string }[]).map((im) => {
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
  const breadthIssues = d.mode === "video" ? [] : breadthPreviewIssues(String(d.kind), d.shots?.breadth?.previews);
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
  "candidates.tidy": tidy, "candidates.extract": extract, "candidates.index": index, "candidates.route": route,
  "curation.dedupe": dedupe, "curation.fetch": fetchHome, "curation.scout": (ctx, svc) => scout(ctx, svc), "curation.kind-join": kindJoin, "curation.assemble": assemble,
  "curation.plan": plan, "curation.identity": identity,
  "curation.breadth": breadth, "curation.proof": proof, "curation.record": record, "curation.process": processShots, "curation.gate": gate,
};
