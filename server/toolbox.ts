// The station toolbox (Spec §30.2): every station agent gets env_help / env_call next to
// submit. Tools are scoped to what the station needs, return structured results, and
// fail with a classified failure carrying nextAction and owner — never a bare stack.
import { Type, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import type { Journal } from "./journal.ts";
import type { Broker, Lease } from "./broker.ts";
import type { Docs } from "./docs.ts";
import { rememberRead, webGet } from "./network.ts";
import { fetchRepoMeta, RepoError } from "./repo.ts";
import { openPage } from "./browser.ts";
import { classifyFailure, type Failure } from "../shared/failures.ts";
import { visit } from "../packs/vislexicon/capture.ts";
import { parseHtml } from "../packs/vislexicon/tools.ts";

export interface EnvContext { node: string; token?: string; caseId?: string; signal: AbortSignal; progress?: (text: string, step?: { tool: string; text: string; ok?: boolean }) => void }
interface Def { name: string; description: string; parameters: TSchema; run: (a: any, c: EnvContext) => Promise<unknown> }

const S = (d: string, o: Record<string, unknown> = {}) => Type.String({ description: d, ...o });
const N = (d: string, min: number, max: number) => Type.Optional(Type.Integer({ description: d, minimum: min, maximum: max }));
const VIEW = { width: 1280, height: 800 };
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

export class ToolError extends Error { failure: Failure; constructor(f: Failure) { super(f.message); this.failure = f; } }
const fail = (err: unknown, url?: string, tried?: string[]) => {
  const f = classifyFailure(err, { url });
  return new ToolError({ ...f, tried: tried ?? (err as { tried?: string[] })?.tried });
};

export class Toolbox {
  private defs = new Map<string, Def>();
  private deps: { journal: Journal; broker: Broker; docs: () => Docs };
  constructor(deps: { journal: Journal; broker: Broker; docs: () => Docs }) {
    this.deps = deps;
    for (const d of this.definitions()) this.defs.set(d.name, d);
  }

  names() { return [...this.defs.keys()]; }

  help(allowed: string[], name?: string) {
    if (name) {
      const d = this.defs.get(name);
      if (!d || !allowed.includes(name)) return { ok: false, error: `本工位没有工具 ${name}`, available: allowed };
      return { ok: true, name, description: d.description, parameters: d.parameters };
    }
    return {
      ok: true,
      tools: allowed.map((n) => ({ name: n, description: this.defs.get(n)?.description.split("。")[0] })),
      environment: "网络走统一出口（自动代理、按主机限速、短暂错误自动重试一次、结果缓存 6 小时）。page_* 在共享浏览器里渲染页面，会自动拒绝 Cookie、隐藏浮层；遇到登录或验证会保留页面并亮红灯，你不需要也不能自己登录。证书错误不会被跳过。每次处理最多调用 10 次工具，用完请根据已有资料提交。",
    };
  }

  async call(allowed: string[], name: string, args: unknown, ctx: EnvContext) {
    const d = this.defs.get(name);
    if (!d || !allowed.includes(name)) return { ok: false, failure: { tag: "tool_error", message: `本工位没有工具 ${name}`, nextAction: `可用：${allowed.join("、")}`, owner: "agent" } };
    if (!Check(d.parameters, args ?? {})) return { ok: false, failure: { tag: "tool_error", message: "参数不符合 schema", details: [...Errors(d.parameters, args ?? {})].slice(0, 5).map((e) => `${e.instancePath} ${e.message}`), nextAction: `先 env_help({name:"${name}"}) 看参数`, owner: "agent" } };
    try { return { ok: true, ...(await d.run(args ?? {}, ctx)) as object }; }
    catch (err) {
      ctx.signal.throwIfAborted();
      const f = err instanceof ToolError ? err.failure : classifyFailure(err, {});
      return { ok: false, failure: f };
    }
  }

  /* ---------------------------------------------------------------- browser lease with a short wait */

  private async lease(signal: AbortSignal): Promise<Lease | null> {
    return this.deps.broker.acquire("browser", { signal, timeoutMs: 20000 });
  }

  private async fetchText(url: string, max: number, signal: AbortSignal) {
    let r;
    try { r = await webGet(url, { signal }); } catch (err) { throw fail(err, url); }
    if (r.status >= 400) throw fail(`HTTP ${r.status}`, url, r.tried);
    const html = /html/i.test(r.contentType) || /^\s*</.test(r.body);
    if (!html) { rememberRead(url, r.body); rememberRead(r.finalUrl, r.body); return { url, finalUrl: r.finalUrl, status: r.status, via: r.via, contentType: r.contentType, text: r.body.slice(0, max), truncated: r.body.length > max }; }
    const p = parseHtml(r.body, r.finalUrl, 60000);
    rememberRead(url, `${p.title}
${p.description}
${p.text}`); rememberRead(r.finalUrl, `${p.title}
${p.description}
${p.text}`);
    return { url, finalUrl: r.finalUrl, status: r.status, via: r.via, title: p.title, description: p.description, text: p.text.slice(0, max), links: p.links.slice(0, 120).map((l) => ({ text: l.text, href: l.href, region: l.inNav ? "nav" : "body" })) };
  }

  private definitions(): Def[] {
    return [
      {
        name: "page_text",
        description: "在共享浏览器里渲染页面，返回可见全文、标题、最终地址、标题层级、每个链接所在区域（nav / main / aside / footer），以及 media 计数（正文里较大的图片、画布、iframe、视频、SVG 各有多少，首屏有几个）。判断一页是不是有渲染出来的预览、是不是只有文字时看 media。浏览器名额满时自动退回 HTTP 读取并注明。",
        parameters: Type.Object({ url: S("完整网址"), max: N("最多返回多少字，默认 12000", 1000, 40000) }),
        run: async (a: { url: string; max?: number }, c) => {
          const max = a.max ?? 12000;
          const lease = await this.lease(c.signal);
          if (!lease) return { ...(await this.fetchText(a.url, max, c.signal)), via: "http（浏览器名额已满）" };
          let close: (() => Promise<void>) | undefined;
          try {
            c.progress?.(`渲染 ${a.url.replace(/^https?:\/\//, "")}`, { tool: "page_text", text: a.url });
            const browser = await openPage(VIEW, "en-US", c.signal); close = browser.close;
            const { page } = browser;
            let issues: string[] = [];
            try { issues = (await visit(page, a.url, hostOf(a.url))).issues; } catch (err) { throw fail(err, a.url, ["browser"]); }
            const data = await page.evaluate((max) => {
              const region = (el: Element) => el.closest("nav,header,[role=navigation]") ? "nav" : el.closest("footer") ? "footer" : el.closest("aside,[role=complementary]") ? "aside" : "main";
              const seen = new Set<string>();
              const links = [...document.querySelectorAll("a[href]")].map((a) => ({ text: (((a as HTMLElement).innerText || a.getAttribute("aria-label") || "").trim()).replace(/\s+/g, " ").slice(0, 80), href: (a as HTMLAnchorElement).href, region: region(a) }))
                .filter((l) => l.text && /^https?:/.test(l.href) && !seen.has(l.href) && seen.add(l.href)).slice(0, 250);
              const headings = [...document.querySelectorAll("h1,h2,h3")].slice(0, 80).map((h) => ({ level: Number(h.tagName[1]), text: ((h as HTMLElement).innerText || "").trim().slice(0, 120) })).filter((h) => h.text);
              const text = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n");
              // How visual the page is: rendered previews show up as images, canvases, iframes, videos and inline SVG in the main area.
              const main = document.querySelector("main,[role=main],article") ?? document.body;
              const big = (el: Element) => { const r = el.getBoundingClientRect(); return r.width >= 80 && r.height >= 60; };
              const media = { images: [...main.querySelectorAll("img,picture")].filter(big).length, canvases: [...main.querySelectorAll("canvas")].filter(big).length, iframes: [...main.querySelectorAll("iframe")].filter(big).length, videos: [...main.querySelectorAll("video")].filter(big).length, svgs: [...main.querySelectorAll("svg")].filter(big).length, firstScreen: [...main.querySelectorAll("img,picture,canvas,iframe,video,svg")].filter((el) => big(el) && el.getBoundingClientRect().top < innerHeight).length };
              return { title: document.title, text: text.slice(0, max), truncated: text.length > max, links, headings, media };
            }, max);
            rememberRead(a.url, `${data.title}
${data.text}`); rememberRead(page.url(), `${data.title}
${data.text}`);
            return { url: a.url, finalUrl: page.url(), via: "browser", issues, ...data };
          } finally { try { await close?.(); } finally { lease.release(); } }
        },
      },
      {
        name: "page_find",
        description: "在渲染后的页面里按文字查找（不区分大小写），返回最多 8 处命中：片段、所在的最近标题、元素标签、离页顶的像素位置、是否在代码块里。用来确认演示在页面哪里、某句话是否真的存在。",
        parameters: Type.Object({ url: S("完整网址"), query: S("要找的文字", { minLength: 2 }) }),
        run: async (a: { url: string; query: string }, c) => {
          const lease = await this.lease(c.signal);
          if (!lease) throw new ToolError({ tag: "tool_error", category: "system", message: "浏览器名额已满", retryable: true, owner: "agent", nextAction: "改用 fetch_text 读正文后自己查找，或稍后再试" });
          let close: (() => Promise<void>) | undefined;
          try {
            const browser = await openPage(VIEW, "en-US", c.signal); close = browser.close;
            const { page } = browser;
            try { await visit(page, a.url, hostOf(a.url)); } catch (err) { throw fail(err, a.url, ["browser"]); }
            const hits = await page.evaluate((q) => {
              const out: { snippet: string; heading: string; tag: string; y: number; inCode: boolean }[] = [];
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              const needle = q.toLowerCase();
              let n: Node | null;
              while ((n = walker.nextNode()) && out.length < 8) {
                const t = n.textContent ?? "";
                const i = t.toLowerCase().indexOf(needle);
                if (i < 0) continue;
                const el = n.parentElement!;
                let h: Element | null = el, heading = "";
                while (h && !heading) { let p: Element | null = h; while ((p = p.previousElementSibling)) { if (/^H[1-4]$/.test(p.tagName)) { heading = (p as HTMLElement).innerText.trim(); break; } const inner = p.querySelector?.("h1,h2,h3,h4"); if (inner) { heading = (inner as HTMLElement).innerText.trim(); break; } } h = h.parentElement; }
                const r = el.getBoundingClientRect();
                out.push({ snippet: t.slice(Math.max(0, i - 60), i + needle.length + 80).trim(), heading: heading.slice(0, 100), tag: el.tagName.toLowerCase(), y: Math.round(r.top + scrollY), inCode: Boolean(el.closest("pre,code")) });
              }
              return out;
            }, a.query);
            return { url: a.url, finalUrl: page.url(), query: a.query, hits };
          } finally { try { await close?.(); } finally { lease.release(); } }
        },
      },
      {
        name: "fetch_text",
        description: "只发 HTTP 读取网页或文本文件的正文（不渲染，快，有缓存）。适合 LICENSE、定价页、纯文本、静态文档。单页应用读到的内容可能很少，这时改用 page_text。",
        parameters: Type.Object({ url: S("完整网址"), max: N("最多返回多少字，默认 8000", 500, 40000) }),
        run: (a: { url: string; max?: number }, c) => { c.progress?.(`GET ${a.url.replace(/^https?:\/\//, "")}`, { tool: "fetch_text", text: a.url }); return this.fetchText(a.url, a.max ?? 8000, c.signal); },
      },
      {
        name: "site_files",
        description: "读取站点根目录给机器看的文件：llms.txt、llms-full.txt（截断）、sitemap.xml 里的路径清单、robots.txt。用来快速了解一个站有哪些页面。",
        parameters: Type.Object({ url: S("站点任意网址") }),
        run: async (a: { url: string }, c) => {
          const origin = new URL(a.url).origin;
          const get = async (p: string, max: number) => { try { const r = await webGet(origin + p, { signal: c.signal, timeout: 12000 }); return r.status < 400 && !/<html/i.test(r.body.slice(0, 300)) ? r.body.slice(0, max) : null; } catch { return null; } };
          c.progress?.(`读取 ${origin} 的 llms / sitemap / robots`, { tool: "site_files", text: origin });
          const [llms, llmsFull, robots, sitemap] = await Promise.all([get("/llms.txt", 6000), get("/llms-full.txt", 15000), get("/robots.txt", 3000), get("/sitemap.xml", 400000)]);
          let paths: string[] = [];
          const locs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
          if (sitemap) {
            const first = locs(sitemap);
            if (/<sitemapindex/i.test(sitemap)) {
              for (const child of first.slice(0, 3)) { try { const r = await webGet(child, { signal: c.signal, timeout: 12000 }); paths.push(...locs(r.body)); } catch { /* skip child */ } }
            } else paths = first;
          }
          const rel = [...new Set(paths.map((u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } }))];
          return { origin, llms, llmsFull, robots, sitemap: { count: rel.length, paths: rel.slice(0, 300), truncated: rel.length > 300 } };
        },
      },
      {
        name: "repo_meta",
        description: "读取 GitHub 仓库元数据：描述、主页、所有者类型（个人 / 组织）、星数、最近推送、是否归档、SPDX 许可与 LICENSE 原文节选（附原文网址）、package.json 的 name / license / author / repository / homepage。参数可以是 owner/name 或仓库网址。",
        parameters: Type.Object({ repo: S("owner/name 或 https://github.com/owner/name") }),
        run: async (a: { repo: string }, c) => {
          c.progress?.(`读取仓库 ${a.repo}`, { tool: "repo_meta", text: a.repo });
          try { return await fetchRepoMeta(a.repo, c.signal); } catch (err) { throw err instanceof RepoError ? new ToolError(err.failure) : fail(err); }
        },
      },
      {
        name: "case_read",
        description: "读取这件货的完整案卷 CASE.md：前面每个工位确认了什么、留下了什么提醒、审核往来。",
        parameters: Type.Object({}),
        run: async (_a, c) => { if (!c.caseId) throw new ToolError({ tag: "tool_error", category: "system", message: "当前没有案卷", retryable: false, owner: "agent" }); return { caseId: c.caseId, markdown: this.deps.docs().renderCase(c.caseId) }; },
      },
      {
        name: "case_note",
        description: "给这件货的案卷追加一段交接笔记，写给后面的工位：你确认了什么、拿不准什么、提醒谁注意什么。不要复述别人写过的内容。",
        parameters: Type.Object({ section: S("段名，如 站点理解 / 拍摄提醒 / 事实疑点", { maxLength: 30 }), text: S("笔记正文", { minLength: 4, maxLength: 1500 }) }),
        run: async (a: { section: string; text: string }, c) => {
          if (!c.caseId || !c.token) throw new ToolError({ tag: "tool_error", category: "system", message: "当前没有案卷", retryable: false, owner: "agent" });
          this.deps.journal.append({ kind: "case.noted", caseId: c.caseId, token: c.token, note: { station: c.node, section: a.section, text: a.text, by: c.node } });
          return { saved: true };
        },
      },
      {
        name: "context_read",
        description: "读取任意节点（如 curation/facts）或主调度（dispatcher）的 CONTEXT.md：版本、本轮进度、指示、最近交接、待解决问题。",
        parameters: Type.Object({ station: S("节点键，或 dispatcher") }),
        run: async (a: { station: string }) => ({ station: a.station, markdown: this.deps.docs().renderContext(a.station) }),
      },
      {
        name: "context_note",
        description: "在自己节点的 CONTEXT.md 里留一条：note（工作笔记）、issue（需要人或系统处理的问题）、lesson（建议写进经验的做法，待站长批准）。",
        parameters: Type.Object({ kind: Type.Union([Type.Literal("note"), Type.Literal("issue"), Type.Literal("lesson")]), text: S("内容", { minLength: 4, maxLength: 600 }) }),
        run: async (a: { kind: "note" | "issue" | "lesson"; text: string }, c) => { this.deps.journal.append({ kind: "context.noted", node: c.node, note: { kind: a.kind, text: a.text, by: c.node } }); return { saved: true }; },
      },
    ];
  }
}

/** The four document tools every station agent gets. */
export const BASE_TOOLS = ["case_read", "case_note", "context_read", "context_note"];
