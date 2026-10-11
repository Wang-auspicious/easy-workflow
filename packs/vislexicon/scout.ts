// ② Scout (Spec §35): the "go in and read it" legwork, done by a program so the reader
// agent starts from a full dossier — rendered home text with link regions, llms.txt /
// sitemap, key pages, build framework and repository metadata. One browser page, the rest
// over the shared network exit.
import type { StationContext, StationResult } from "../../server/runtime.ts";
import { openPage } from "../../server/browser.ts";
import { diagnoseReach, rememberRead, webGet } from "../../server/network.ts";
import { fetchRepoMeta, repoOf, repoSources, type RepoMeta } from "../../server/repo.ts";
import { classifyFailure, type Failure } from "../../shared/failures.ts";
import { VIEW, links as pageLinks, sameSite, visit, type Link } from "./capture.ts";
import { parseHtml } from "./tools.ts";

export interface Dossier {
  url: string; finalUrl: string; status: number; title: string; description: string;
  text: string; headings: { level: number; text: string }[];
  links: { text: string; href: string; region: string }[];
  framework: string[];
  files: { llms: string | null; llmsFull: string | null; sitemap: string[]; sitemapCount: number };
  pages: { url: string; title: string; text: string; why: string }[];
  repo: RepoMeta | null; repoError?: string;
  via: string[];
}

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

const KEY_PAGES: [RegExp, string][] = [
  [/\/(docs\/)?components?\/?$|\/(ui|blocks|library|gallery|browse|explore|showcase|examples|templates|catalog|icons|fonts)\/?$/i, "目录候选"],
  [/\/about|\/team|\/company/i, "关于"],
  [/\/pricing|\/plans|\/price|\/buy|\/pro\b/i, "定价"],
  [/\/licen[sc]e|\/terms|\/legal/i, "许可 / 条款"],
  [/\/(docs|documentation|getting-started|introduction)\/?$/i, "文档首页"],
];

async function siteFiles(origin: string, signal: AbortSignal) {
  const get = async (p: string, max: number) => { try { const r = await webGet(origin + p, { signal, timeout: 10000 }); return r.status < 400 && !/<html/i.test(r.body.slice(0, 300)) ? r.body.slice(0, max) : null; } catch { return null; } };
  const [llms, llmsFull, sitemap] = await Promise.all([get("/llms.txt", 6000), get("/llms-full.txt", 12000), get("/sitemap.xml", 400000)]);
  const locs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  let paths: string[] = [];
  if (sitemap) {
    const first = locs(sitemap);
    if (/<sitemapindex/i.test(sitemap)) { for (const child of first.slice(0, 3)) { try { paths.push(...locs((await webGet(child, { signal, timeout: 10000 })).body)); } catch { /* skip */ } } }
    else paths = first;
  }
  const rel = [...new Set(paths.map((u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } }))];
  return { llms, llmsFull, sitemap: rel.slice(0, 300), sitemapCount: rel.length };
}

/** Framework from the rendered page: markers each build tool leaves behind. */
const FRAMEWORK_PROBE = () => {
  const out: string[] = [];
  const gen = document.querySelector("meta[name=generator]")?.getAttribute("content") ?? "";
  if (gen) out.push(`generator: ${gen.slice(0, 40)}`);
  if (document.querySelector("#__docusaurus, [class*=docusaurus]")) out.push("Docusaurus");
  if ((window as any).__NEXT_DATA__ || document.querySelector("#__next")) out.push("Next.js");
  if (document.querySelector(".VPDoc, .VPNav, #VPContent")) out.push("VitePress");
  if (document.querySelector("#storybook-preview-iframe") || /storybook/i.test(document.title)) out.push("Storybook");
  if (document.querySelector("[class*=nextra]")) out.push("Nextra");
  if (document.querySelector("astro-island, [data-astro-cid]")) out.push("Astro");
  if (/mintlify/i.test(document.documentElement.innerHTML.slice(0, 20000))) out.push("Mintlify");
  if (document.querySelector(".gitbook-root, [class*=gitbook]")) out.push("GitBook");
  if (/\.github\.io$/.test(location.hostname)) out.push("GitHub Pages");
  if (document.querySelector("iframe[src*=sandpack], [class*=sp-preview]")) out.push("Sandpack 演示");
  return out;
};

/** Compare one direct request with the configured exit, retaining uncertainty when
 * both fail. A transient failure is still system work, not a request to log in. */
async function explainUnreachable(f: Failure, url: string, ctx: StationContext): Promise<Failure> {
  if (!["network_connection", "network_timeout"].includes(f.tag)) return f;
  const probe = await diagnoseReach(url, ctx.signal).catch(() => null);
  if (!probe) return f;
  const host = hostOf(url);
  const nextAction = probe.directOk
    ? `配置出口 ${probe.proxy} 的本次请求失败，${probe.direct}。系统稍后从当前工位重试并核对共享浏览器；这次探测只说明两条请求结果不同，不能证明需要登录。`
    : `配置出口 ${probe.proxy} 与本次直连探测都未成功（${probe.direct}）。系统稍后从当前工位重试并保留已有成果；暂不能确定是站点、出口还是临时连接问题，不要求用户登录或修改代理。`;
  ctx.progress(`网络诊断：${nextAction}`, { tool: "network", text: f.message.slice(0, 160), ok: false });
  return { ...f, message: `${host} 本次连接失败（${probe.directOk ? "直连探测收到响应" : "配置出口与直连均未成功"}）：${f.message.slice(0, 160)}`, owner: "system", nextAction, tried: [...(f.tried ?? []), "经配置出口访问", probe.direct] };
}

export async function scout(ctx: StationContext, svc: {
  tryBrowser?: () => { release: () => void } | null;
  acquireBrowser?: (signal: AbortSignal, timeoutMs: number) => Promise<{ release: () => void } | null>;
}): Promise<StationResult> {
  const url = String(ctx.token.data.canonical ?? ctx.token.url);
  const host = String(ctx.token.data.host ?? hostOf(url));
  const via: string[] = [];
  let failure: Failure | undefined;
  // 1. HTTP first: status, final address, meta — fast and cached.
  let status = 0, finalUrl = url, http: ReturnType<typeof parseHtml> | null = null;
  ctx.progress(`GET ${url.replace(/^https?:\/\//, "")}`, { tool: "http", text: "首页状态与元信息" });
  try {
    const r = await webGet(url, { signal: ctx.signal });
    status = r.status; finalUrl = r.finalUrl; via.push(r.via);
    if (r.status >= 400) failure = classifyFailure(`首页返回 HTTP ${r.status}`, { url, status: r.status });
    else http = parseHtml(r.body, r.finalUrl, 20000);
  } catch (err) { ctx.signal.throwIfAborted(); failure = classifyFailure(err, { url }); }
  if (failure && (failure.category === "invalid" || failure.tag === "network_tls")) return { ok: false, summary: failure.message, error: failure.message, failure };

  // 2. Render the home page in the shared browser: what a person actually sees.
  let rendered: { title: string; text: string; headings: { level: number; text: string }[]; links: { text: string; href: string; region: string }[]; framework: string[] } | null = null;
  let homeLinks: Link[] = [];
  let lease = svc.tryBrowser?.();
  if (!lease && !http && svc.acquireBrowser) {
    ctx.progress("HTTP 未取得正文，等待共享浏览器名额（最多 60 秒）", { tool: "resource", text: "等待 browser；可取消" });
    lease = await svc.acquireBrowser(ctx.signal, 60000);
    if (!lease) {
      ctx.signal.throwIfAborted();
      const f: Failure = { tag: "tool_error", category: "system", code: "BROWSER_CAPACITY_TIMEOUT", message: "共享浏览器名额等待超过 60 秒，浏览器补取尚未开始", url, retryable: true, owner: "system", nextAction: "等待在途页面释放，或检查内存与浏览器并发上限后，从侦察工位继续。此前 HTTP 失败不代表站点不可用。", tried: [failure?.message ?? "HTTP 未取得正文", "等待共享浏览器名额 60 秒"] };
      return { ok: false, summary: f.message, error: f.message, failure: f };
    }
  }
  if (lease) {
    try {
      const { page, close } = await openPage(VIEW, "en-US", ctx.signal);
      try {
        await visit(page, finalUrl, host, (t) => ctx.progress(t, { tool: "browser", text: t }));
        rendered = await page.evaluate(() => {
          const region = (el: Element) => el.closest("nav,header,[role=navigation]") ? "nav" : el.closest("footer") ? "footer" : el.closest("aside,[role=complementary]") ? "aside" : "main";
          const seen = new Set<string>();
          const links = [...document.querySelectorAll("a[href]")].map((a) => ({ text: (((a as HTMLElement).innerText || a.getAttribute("aria-label") || "").trim()).replace(/\s+/g, " ").slice(0, 80), href: (a as HTMLAnchorElement).href, region: region(a) }))
            .filter((l) => l.text && /^https?:/.test(l.href) && !seen.has(l.href) && seen.add(l.href)).slice(0, 260);
          const headings = [...document.querySelectorAll("h1,h2,h3")].slice(0, 80).map((h) => ({ level: Number(h.tagName[1]), text: ((h as HTMLElement).innerText || "").trim().slice(0, 120) })).filter((h) => h.text);
          return { title: document.title, text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 20000), headings, links, framework: [] as string[] };
        });
        rendered.framework = await page.evaluate(FRAMEWORK_PROBE).catch(() => []);
        homeLinks = (await pageLinks(page)).filter((l) => sameSite(l.href, host));
        finalUrl = page.url(); if (!status) status = 200;
        via.push("browser"); failure = undefined;
      } finally { await close(); }
    } catch (err) {
      ctx.signal.throwIfAborted();
      const f = (err as { failure?: Failure }).failure ?? classifyFailure(err, { url: finalUrl });
      if (f.tag === "auth_required" || f.tag === "network_tls" || f.category === "invalid") return { ok: false, summary: f.message, error: f.message, failure: f };
      if (!http) { const g = await explainUnreachable(f, finalUrl, ctx); return { ok: false, summary: g.message, error: g.message, failure: g }; }
      ctx.progress(`浏览器渲染失败，改用 HTTP 正文继续：${f.message.slice(0, 80)}`, { tool: "recover", text: f.tag, ok: false });
    } finally { lease.release(); }
  } else if (http) ctx.progress("浏览器名额已满：先用已取得的 HTTP 正文建卷宗", { tool: "recover", text: "no browser lease" });
  if (!rendered && !http) { const f = await explainUnreachable(failure ?? classifyFailure("首页没有响应", { url }), url, ctx); return { ok: false, summary: f.message, error: f.message, failure: f }; }

  const text = rendered?.text || http!.text;
  const allLinks = rendered?.links ?? http!.links.map((l) => ({ text: l.text, href: l.href, region: l.inNav ? "nav" : "main" }));
  rememberRead(finalUrl, `${rendered?.title ?? http?.title ?? ""}\n${http?.description ?? ""}\n${text}`);

  // 3. Machine-readable site files and key pages, in parallel over HTTP.
  const origin = new URL(finalUrl).origin;
  ctx.progress("读取 llms.txt / sitemap / 关键页 / 仓库", { tool: "http", text: origin });
  const sameHost = allLinks.filter((l) => sameSite(l.href, host));
  const picked: { url: string; why: string }[] = [];
  for (const [re, why] of KEY_PAGES) {
    const hit = sameHost.find((l) => { try { const u = new URL(l.href); return re.test(u.pathname) && !picked.some((p) => p.url === l.href); } catch { return false; } });
    if (hit) picked.push({ url: hit.href, why });
  }
  const repoLink = [url, finalUrl, ...allLinks.map((l) => l.href)].find((h) => /github\.com\/[^/]+\/[^/#?]+/i.test(h) && repoOf(h));
  const [files, pages, repo] = await Promise.all([
    siteFiles(origin, ctx.signal),
    Promise.all(picked.slice(0, 6).map(async (p) => {
      try {
        const r = await webGet(p.url, { signal: ctx.signal, timeout: 12000 });
        if (r.status >= 400) return null;
        const h = parseHtml(r.body, r.finalUrl, 20000);
        rememberRead(r.finalUrl, `${h.title}\n${h.description}\n${h.text}`); rememberRead(p.url, `${h.title}\n${h.description}\n${h.text}`);
        return { url: r.finalUrl, title: h.title, text: h.text.slice(0, 2500), why: p.why };
      } catch { return null; }
    })),
    repoLink ? fetchRepoMeta(repoLink, ctx.signal).then((m) => m, (e: Error) => e) : Promise.resolve(null),
  ]);
  const dossier: Dossier = {
    url, finalUrl, status, title: rendered?.title || http?.title || host, description: http?.description ?? "",
    text, headings: rendered?.headings ?? [], links: allLinks, framework: rendered?.framework ?? [],
    files, pages: pages.filter(Boolean) as Dossier["pages"],
    repo: repo instanceof Error ? null : repo, repoError: repo instanceof Error ? repo.message : undefined, via,
  };
  if (dossier.repo) for (const s of repoSources(dossier.repo)) rememberRead(s.url, s.text);
  const navLinks = sameHost.slice(0, 120).map((l) => ({ href: l.href, text: l.text, inNav: l.region === "nav", inMain: l.region === "main", hasImage: false, visible: true, order: 0 }));
  if (!homeLinks.length) homeLinks = navLinks;
  const facts = [
    dossier.framework.length ? `框架 ${dossier.framework.join(" / ")}` : "",
    `链接 ${allLinks.length}（站内 ${sameHost.length}）`,
    files.llms ? "有 llms.txt" : "", files.sitemapCount ? `sitemap ${files.sitemapCount} 页` : "",
    dossier.pages.length ? `关键页 ${dossier.pages.map((p) => p.why).join("、")}` : "",
    dossier.repo ? `仓库 ${dossier.repo.repo}${dossier.repo.license?.spdx ? ` · ${dossier.repo.license.spdx}` : ""}` : dossier.repoError ? `仓库读取失败：${dossier.repoError.slice(0, 60)}` : "",
  ].filter(Boolean);
  ctx.progress(`卷宗：${facts.join(" · ")}`, { tool: "dossier", text: `${text.length} 字正文`, ok: true });
  ctx.addEvidence({ id: `dossier-${ctx.attempt}`, kind: "text", label: "侦察卷宗", verdict: (dossier.title || host).slice(0, 22), tone: "ok", meta: { status, finalUrl, framework: dossier.framework, links: allLinks.length, sitemap: files.sitemapCount, llms: Boolean(files.llms), pages: dossier.pages.map((p) => p.url), repo: dossier.repo?.repo } });
  return {
    ok: true, summary: `「${dossier.title}」· ${facts.slice(0, 3).join(" · ")}`,
    data: {
      dossier, title: dossier.title || ctx.token.title, homeLinks: homeLinks.slice(0, 150),
      home: { status, finalUrl, title: dossier.title, description: dossier.description, navLinks, text: text.slice(0, 6000) },
    },
    caseNotes: [{ section: "侦察卷宗", text: `${dossier.title}（${finalUrl}）\n${facts.join("\n")}${dossier.headings.length ? `\n首页标题层级：${dossier.headings.slice(0, 12).map((h) => h.text).join(" / ")}` : ""}` }],
  };
}

/** Dossier as plain text for agents: everything the reader needs, nothing it does not. */
export function dossierText(d: Dossier | undefined, budget = 14000): string {
  if (!d) return "（没有侦察卷宗）";
  const byRegion = (r: string, n: number) => d.links.filter((l) => l.region === r).slice(0, n).map((l) => `${l.text} → ${l.href}`).join("\n");
  const parts = [
    `网址：${d.finalUrl}（HTTP ${d.status}）\n标题：${d.title}\n描述：${d.description}\n框架：${d.framework.join(" / ") || "未识别"}`,
    d.headings.length ? `首页标题层级：\n${d.headings.slice(0, 30).map((h) => `${"  ".repeat(h.level - 1)}${h.text}`).join("\n")}` : "",
    `导航链接：\n${byRegion("nav", 60)}`,
    `正文链接：\n${byRegion("main", 60)}`,
    byRegion("footer", 30) ? `页脚链接：\n${byRegion("footer", 30)}` : "",
    d.files.llms ? `llms.txt：\n${d.files.llms.slice(0, 2500)}` : "",
    d.files.sitemapCount ? `sitemap（${d.files.sitemapCount} 页，前 120）：\n${d.files.sitemap.slice(0, 120).join("\n")}` : "",
    d.pages.length ? `关键页摘录：\n${d.pages.map((p) => `【${p.why}】${p.url}\n${p.title}\n${p.text.slice(0, 1200)}`).join("\n\n")}` : "",
    d.repo ? `仓库：${d.repo.repo}（${d.repo.url}）\n描述：${d.repo.description ?? ""}\n所有者：${d.repo.ownerLogin}（${d.repo.ownerType}）· 星 ${d.repo.stars} · 最近推送 ${d.repo.pushedAt}${d.repo.archived ? " · 已归档" : ""}\n许可：${d.repo.license?.spdx ?? "未知"}${d.repo.license?.url ? `（${d.repo.license.url}）` : ""}${d.repo.packageJson ? `\npackage.json：${JSON.stringify({ name: d.repo.packageJson.name, license: d.repo.packageJson.license, author: d.repo.packageJson.author })}` : ""}` : d.repoError ? `仓库读取失败：${d.repoError}` : "",
  ].filter(Boolean).join("\n\n");
  const rest = Math.max(2000, budget - parts.length);
  return `${parts}\n\n首页可见全文（节选）：\n${d.text.slice(0, rest)}`;
}
