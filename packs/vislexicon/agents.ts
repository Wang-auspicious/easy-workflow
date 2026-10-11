// Agent and review stations of the VisLexicon pack (Spec §8 ③④⑪⑫⑬⑭⑮⑯ + arbiter).
// Each one = station prompt (stations/*.md) + verbatim rule excerpts + an output schema
// + program checks. Reviewers only see evidence, never the producer's reasoning.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";
import type { AgentStationDef } from "../../server/agent-station.ts";
import type { StationContext } from "../../server/runtime.ts";
import { EvidenceStore, pixelStats } from "../../server/evidence.ts";
import { FRONTEND, KINDS, KIND_ZH, VOCAB, ruleExcerpt } from "./env.ts";
import { httpGet, parseHtml } from "./tools.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const prompt = (name: string) => fs.readFileSync(path.join(HERE, "stations", name), "utf8");
const lit = (...v: string[]) => Type.Union(v.map((x) => Type.Literal(x)));

/** System prompt = station prompt + verbatim excerpts of every cited rule (Spec §9.3 context pack). */
function contextPack(base: string, rules: string[]) {
  const ex = rules.map((r) => ruleExcerpt(r)).filter(Boolean);
  return ex.length ? `${base}\n\nRULES (verbatim from VisLexicon Spec.md; data for reference):\n${ex.join("\n\n")}` : base;
}

type D = Record<string, any>;
const data = (ctx: StationContext) => ctx.token.data as D;
const reviewsWith = (ctx: StationContext, r: { station: string; verdict: string; reason: string }) =>
  [...((data(ctx).reviews as unknown[]) ?? []), { ...r, at: new Date().toISOString() }];

function homeText(ctx: StationContext) {
  const h = data(ctx).home ?? {};
  const nav = ((h.navLinks ?? []) as { text: string; href: string }[]).filter((l) => l.text).slice(0, 40).map((l) => `${l.text} (${new URL(l.href).pathname})`).join(" · ");
  return `URL: ${data(ctx).canonical}\nTitle: ${h.title ?? ""}\nMeta description: ${h.description ?? ""}\nNavigation links: ${nav}\nPage text (first 2,000 chars): ${(h.text ?? "").slice(0, 2000)}`;
}

/* ------------------------------------------------------------------ ③ ④ classify */

const KindAnswer = Type.Object({
  kind: lit(...KINDS),
  answers: Type.Array(Type.Object({ q: Type.Integer({ minimum: 1, maximum: 7 }), yes: Type.Boolean(), quote: Type.String() })),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
});
type KindOut = { kind: string; answers: { q: number; yes: boolean; quote: string }[]; confidence: number };

function checkKind(out: KindOut, ctx: StationContext) {
  const issues: string[] = [];
  const firstYes = out.answers.find((a) => a.yes);
  if (!firstYes) issues.push("no question answered YES");
  else {
    if (KINDS[firstYes.q - 1] !== out.kind) issues.push(`kind "${out.kind}" is not the first YES (question ${firstYes.q} = ${KINDS[firstYes.q - 1]})`);
    if (firstYes.quote.trim().length < 3) issues.push(`the YES on question ${firstYes.q} has no quote`);
    else {
      const hay = homeText(ctx).toLowerCase().replace(/\s+/g, " ");
      const q = firstYes.quote.toLowerCase().replace(/\s+/g, " ").replace(/^["'“”]+|["'“”.…]+$/g, "").slice(0, 60);
      if (q.length >= 6 && !hay.includes(q.slice(0, Math.min(30, q.length)))) issues.push(`the quote for question ${firstYes.q} is not verbatim in the page data`);
    }
    const asked = out.answers.filter((a) => a.q < firstYes.q).map((a) => a.q);
    for (let q = 1; q < firstYes.q; q++) if (!asked.includes(q)) issues.push(`question ${q} was skipped (ask in order)`);
  }
  return issues;
}

const describeKind = (o: KindOut) => `判为 ${KIND_ZH[o.kind] ?? o.kind}（置信 ${o.confidence.toFixed(2)}；问到第 ${o.answers.find((a) => a.yes)?.q ?? "?"} 题停）`;

export const classify: AgentStationDef<KindOut> = {
  system: contextPack(prompt("classify.md"), ["vislexicon:Spec.md#2.3", "vislexicon:Spec.md#2.4"]),
  schema: KindAnswer,
  input: (ctx) => ({ text: homeText(ctx) }),
  check: checkKind,
  describe: describeKind,
  after: (out, ctx) => {
    const yes = out.answers.find((a) => a.yes);
    ctx.addEvidence({ id: `kind-${ctx.attempt}`, kind: "verdict", label: "分类", verdict: `${KIND_ZH[out.kind]} · 第${yes?.q}问`, tone: "ok", meta: { ...out } });
    return { ok: true, summary: describeKind(out), data: { kind1: out, kind: out.kind } };
  },
};

export const classifyReview: AgentStationDef<KindOut> = {
  ...classify,
  after: (out, ctx) => {
    const first = data(ctx).kind1 as KindOut | undefined;
    const agree = first?.kind === out.kind;
    ctx.addEvidence({ id: `kind2-${ctx.attempt}`, kind: "verdict", label: "分类复核", verdict: agree ? `${KIND_ZH[out.kind]} ✓ 一致` : `${KIND_ZH[out.kind]} ≠ ${KIND_ZH[first?.kind ?? ""] ?? "?"}`, tone: agree ? "ok" : "warn", meta: { ...out } });
    return {
      ok: true, summary: agree ? `独立复核一致：${KIND_ZH[out.kind]}` : `不一致：③ ${KIND_ZH[first?.kind ?? ""]} vs ④ ${KIND_ZH[out.kind]} → 仲裁`,
      data: { kind2: out, kindAgreed: agree, reviews: reviewsWith(ctx, { station: "classify-review", verdict: agree ? "pass" : "disagree", reason: `③ ${first?.kind} / ④ ${out.kind}` }) },
      verdict: { verdict: "pass", reason: agree ? "一致" : "不一致，交仲裁" },
    };
  },
};

/* ------------------------------------------------------------------ arbiter */

type ArbOut = { kind: string; reason: string; quote: string };
export const arbiter: AgentStationDef<ArbOut> = {
  system: contextPack(prompt("arbiter.md"), ["vislexicon:Spec.md#2.4"]),
  schema: Type.Object({ kind: lit(...KINDS, ""), reason: Type.String(), quote: Type.String() }),
  input: (ctx) => {
    const a = data(ctx).kind1 as KindOut, b = data(ctx).kind2 as KindOut;
    const fmt = (o: KindOut) => `${o.kind} (confidence ${o.confidence}); answers: ${o.answers.map((x) => `Q${x.q} ${x.yes ? "YES" : "no"} "${x.quote}"`).join("; ")}`;
    return { text: `${homeText(ctx)}\n\nClassifier A: ${fmt(a)}\nClassifier B: ${fmt(b)}` };
  },
  describe: (o) => (o.kind ? `裁定为 ${KIND_ZH[o.kind]}：${o.reason.slice(0, 60)}` : `裁不了，交人：${o.reason.slice(0, 60)}`),
  after: (out, ctx) => {
    ctx.addEvidence({ id: `arb-${ctx.attempt}`, kind: "verdict", label: "仲裁", verdict: out.kind ? `裁定 ${KIND_ZH[out.kind]}` : "交人", tone: out.kind ? "ok" : "warn", meta: { ...out } });
    return { ok: true, summary: out.kind ? `裁定 ${KIND_ZH[out.kind]}` : "交人裁定", data: { kind: out.kind, arbiterDecided: Boolean(out.kind), manualReason: out.kind ? undefined : `分类分歧未决：${out.reason}` } };
  },
};

/* ------------------------------------------------------------------ ⑪ shot review */

type ShotReviewOut = { perImage: { role: string; ok: boolean; reason: string }[]; verdict: "pass" | "return"; returnTo?: string; repair?:"reframe"|"replace-page"|"wait-for-render"; reason: string };
function imagesOf(ctx: StationContext, store: EvidenceStore) {
  const d = data(ctx);
  if (d.mode === "video") return d.video ? [{ file: store.resolve(d.video.posterCard)!, label: "video poster" }] : [];
  return ((d.images ?? []) as { role: string; card: string; href: string }[]).map((im) => ({ file: store.resolve(im.card)!, label: `${im.role} — ${im.href}` }));
}

export const shotReview = (store: EvidenceStore): AgentStationDef<ShotReviewOut> => ({
  system: contextPack(prompt("shot-review.md"), ["vislexicon:Spec.md#4.8"]),
  schema: Type.Object({
    perImage: Type.Array(Type.Object({ role: lit("identity", "breadth", "proof", "poster"), ok: Type.Boolean(), reason: Type.String() })),
    verdict: lit("pass", "return"), returnTo: Type.Optional(lit("identity", "breadth", "proof")), repair:Type.Optional(lit("reframe","replace-page","wait-for-render")), reason: Type.String(),
  }),
  input: (ctx) => {
    const imgs = imagesOf(ctx, store);
    return {
      text: `Site: ${data(ctx).title} (${data(ctx).canonical}). Kind: ${data(ctx).kind} (${KIND_ZH[data(ctx).kind]}). Mode: ${data(ctx).mode}.\n${imgs.map((im, i) => `image ${i + 1}: ${im.label}`).join("\n")}`,
      images: imgs,
    };
  },
  check: (o) => (o.verdict === "return" && (!o.returnTo || !o.repair || o.reason.trim().length < 6) ? ["a return must name returnTo, repair (reframe | replace-page | wait-for-render), and a concrete reason"] : []),
  describe: (o) => (o.verdict === "pass" ? `通过：${o.perImage.map((p) => `${p.role} ${p.ok ? "✓" : "✗"}`).join(" ")}` : `退回 ${o.returnTo}：${o.reason.slice(0, 70)}`),
  after: (out, ctx) => {
    const d = data(ctx);
    const rejected = out.verdict === "return" && out.repair==="replace-page" && out.returnTo ? [...((d.rejectedPages as string[]) ?? []), d.shots?.[out.returnTo]?.href].filter(Boolean) : d.rejectedPages;
    const shotRepairs={...d.shotRepairs};
    if(out.verdict==="return"&&out.returnTo)shotRepairs[out.returnTo]={action:out.repair,url:d.shots?.[out.returnTo]?.href,reason:out.reason};
    ctx.addEvidence({ id: `sr-${ctx.attempt}`, kind: "verdict", label: "截图审查", verdict: out.verdict === "pass" ? "三张图 ✓" : `退回 ${({ identity: "首屏", breadth: "目录", proof: "特写" } as D)[out.returnTo ?? ""] ?? ""}`, tone: out.verdict === "pass" ? "ok" : "warn", meta: { ...out } });
    if (d.mode === "video" && out.verdict === "return") return { ok: true, summary: "录屏封面不合格 → 交人", data: { shotReview: "escalate" }, verdict: { verdict: "escalate", reason: out.reason } };
    return {
      ok: true, summary: out.verdict === "pass" ? "截图通过" : `退回${out.returnTo}：${out.reason.slice(0, 60)}`,
      data: { shotReview: out.verdict, shotRepairs, rejectedPages: rejected, reviews: reviewsWith(ctx, { station: "shot-review", verdict: out.verdict, reason: out.reason }) },
      verdict: { verdict: out.verdict, returnTo: out.returnTo ? `curation/${out.returnTo}` : undefined, reason: out.reason },
    };
  },
});

/* ------------------------------------------------------------------ ⑫ style */

type StyleOut = { subjectVisible: boolean; mixed: boolean; styles: { id: string; images: number[]; evidenceZh: string }[]; signatureZh: string };
let styleLib: Promise<{ checkStyle: Function; salvage: Function }> | null = null;
const loadStyleLib = () => {
  const source = path.join(FRONTEND, "scripts/style/site-style.mjs");
  const fallback = path.join(process.env.VISLEXICON_BUNDLED ?? FRONTEND, "scripts/style/site-style.mjs");
  return (styleLib ??= import(pathToFileURL(fs.existsSync(source) ? source : fallback).href) as never);
};

const SUBJECT_RULE: Record<string, string> = {
  components: "SUBJECT = the library's COMPONENTS themselves: the rendered previews/demos inside the pages (cards, buttons, effects, blocks). IGNORE the documentation chrome (sidebar, top nav, code panels, docs typography) unless the components are absent. Image 3 is usually a single component page; image 2 a catalogue of previews.",
  "design-system": "SUBJECT = the design system's DEFAULT components and visual language as shown in its docs and examples (buttons, inputs, cards, colour usage). IGNORE marketing hero decoration.",
  assets: "SUBJECT = the assets themselves (glyphs, icons, illustrations, typefaces) as previewed, not the website around them. Many asset styles are outside this vocabulary; then return an empty list.",
};
const subjectOf = (kind: string) => (kind === "component-source" ? "components" : kind === "design-system" ? "design-system" : kind === "assets" ? "assets" : null);

export const style = (store: EvidenceStore): AgentStationDef<StyleOut> => ({
  system: prompt("style.md")
    .replace("{VOCAB}", VOCAB.styles.map((s) => `- ${s.id}: ${s.en} — looks like: ${s.plain}`).join("\n"))
    .replace("{SUBJECT}", "SUBJECT: see the user message."),
  schema: Type.Object({
    subjectVisible: Type.Boolean(), mixed: Type.Boolean(),
    styles: Type.Array(Type.Object({ id: lit(...VOCAB.styles.map((s) => s.id)), images: Type.Array(Type.Integer({ minimum: 1, maximum: 3 })), evidenceZh: Type.String() }), { maxItems: 3 }),
    signatureZh: Type.String(),
  }),
  skip: (ctx) => {
    const subject = subjectOf(data(ctx).kind);
    if (subject && data(ctx).mode !== "video") return null;
    ctx.progress(`${KIND_ZH[data(ctx).kind]}不打风格词（VisLexicon §2.6.1 只给组件源 / 设计规范 / 素材）`, { tool: "rules", text: "subjectOf(kind) = null" });
    return { ok: true, summary: "此类不打风格", data: { style: { applicable: false } } };
  },
  input: (ctx) => {
    const subject = subjectOf(data(ctx).kind)!;
    const imgs = ((data(ctx).images ?? []) as { role: string; card: string; href: string }[]).map((im) => ({ file: store.resolve(im.card)!, label: `${im.role}: ${new URL(im.href).pathname}` }));
    return { text: `${SUBJECT_RULE[subject]}\nSite: ${data(ctx).title} (${data(ctx).host}). Subject kind: ${subject}. Mixed allowed: no.\n${imgs.map((im, i) => `image ${i + 1}: ${im.label}`).join("\n")}`, images: imgs };
  },
  check: (out, ctx) => {
    const stats = ((data(ctx).images ?? []) as { card: string }[]).map((im) => pixelStats(store.resolve(im.card)!));
    const lib = (globalThis as D).__styleLib;
    return lib ? lib.checkStyle(out, stats, subjectOf(data(ctx).kind), false) : [];
  },
  salvage: (out, _issues, ctx) => {
    const stats = ((data(ctx).images ?? []) as { card: string }[]).map((im) => pixelStats(store.resolve(im.card)!));
    const lib = (globalThis as D).__styleLib;
    return lib ? lib.salvage(out, stats, subjectOf(data(ctx).kind), false).out : null;
  },
  describe: (o) => (o.subjectVisible ? `${o.styles.map((s) => `${VOCAB.styles.find((v) => v.id === s.id)?.zh ?? s.id}@${s.images.join(",")}`).join(" · ") || "无合适的词"}${o.signatureZh ? ` —— ${o.signatureZh}` : ""}` : "截图里看不到主体 → 未判定"),
  after: (out, ctx, meta) => {
    const words = out.styles.map((s) => VOCAB.styles.find((v) => v.id === s.id)?.zh ?? s.id);
    ctx.addEvidence({ id: `st-${ctx.attempt}`, kind: "verdict", label: "风格", verdict: out.subjectVisible ? (words.join(" · ") || "无合适的词") : "看不到组件", tone: out.subjectVisible ? "ok" : "warn", meta: { ...out, rounds: meta.rounds } });
    return { ok: true, summary: out.subjectVisible ? `${words.join(" · ") || "无合适的词"}${meta.rounds > 1 ? "（重答 1 次）" : ""}` : "看不到组件：截图需要重拍", data: { style: { applicable: true, ...out } } };
  },
});

/** Loads VisLexicon's style checks once (checkStyle / salvage are synchronous after that). */
export async function warmStyleLib() {
  try { (globalThis as D).__styleLib = await loadStyleLib(); } catch (err) { console.warn("style lib not loaded:", (err as Error).message); }
}

/* ------------------------------------------------------------------ ⑬ facts */

type FactsOut = { price: string; sourceCode: string; license: string; commercial: string; sources: { fact: string; url: string; quote: string }[] };
const pagesCache = new WeakMap<object, { url: string; text: string }[]>();

async function factPages(ctx: StationContext) {
  const d = data(ctx);
  const nav = ((d.home?.navLinks ?? []) as { href: string; text: string }[]);
  const all = [...nav, ...((d.homeLinks ?? []) as { href: string; text: string }[])];
  const pick = (re: RegExp) => all.find((l) => re.test(l.href) || re.test(l.text));
  const wanted = [pick(/pricing|price|plans|定价|价格/i), pick(/licen[sc]e|terms|许可/i), pick(/github\.com\/[^/]+\/[^/]+\/?$/i)].filter(Boolean) as { href: string }[];
  const pages: { url: string; text: string }[] = [{ url: d.canonical, text: String(d.home?.text ?? "").slice(0, 2500) }];
  for (const l of [...new Map(wanted.map((w) => [w.href, w])).values()].slice(0, 3)) {
    ctx.progress(`GET ${l.href.replace(/^https?:\/\//, "")}`, { tool: "http", text: "取定价 / 许可 / 仓库页" });
    try {
      const r = await httpGet(l.href, ctx.signal, 15000);
      if (r.status < 400) pages.push({ url: r.finalUrl, text: parseHtml(r.body, r.finalUrl).text.slice(0, 2500) });
    } catch { /* skip page */ }
  }
  return pages;
}

export const facts: AgentStationDef<FactsOut> = {
  system: prompt("facts.md"),
  schema: Type.Object({
    price: lit("free", "freemium", "paid", "unknown"), sourceCode: lit("open", "closed", "unknown"), license: Type.String(), commercial: lit("allowed", "restricted", "unknown"),
    sources: Type.Array(Type.Object({ fact: lit("price", "sourceCode", "license", "commercial"), url: Type.String(), quote: Type.String() })),
  }),
  input: async (ctx) => {
    const pages = await factPages(ctx);
    pagesCache.set(ctx.token, pages);
    return { text: `Site: ${data(ctx).title} (${data(ctx).canonical}), kind ${data(ctx).kind}.\n\n${pages.map((p, i) => `PAGE ${i + 1}: ${p.url}\n${p.text}`).join("\n\n")}` };
  },
  check: (out, ctx) => {
    const pages = pagesCache.get(ctx.token) ?? [];
    const issues: string[] = [];
    for (const f of ["price", "sourceCode", "license", "commercial"] as const) {
      const v = (out as D)[f];
      if (!v || v === "unknown") continue;
      const src = out.sources.find((s) => s.fact === f);
      if (!src) { issues.push(`${f}="${v}" has no source`); continue; }
      const page = pages.find((p) => p.url.replace(/\/+$/, "") === src.url.replace(/\/+$/, ""));
      if (!page) issues.push(`${f}: source url ${src.url} is not one of the fetched pages`);
      else if (src.quote.trim().length<3 || !page.text.toLowerCase().replace(/\s+/g," ").includes(src.quote.toLowerCase().trim().replace(/\s+/g," "))) issues.push(`${f}: complete quote is not verbatim in ${src.url}`);
    }
    return issues;
  },
  salvage: (out, issues) => {
    const bad = new Set(issues.map((i) => i.split(/[:=]/)[0].trim()));
    const fixed = { ...out } as D;
    for (const f of bad) if (f in fixed) fixed[f] = "unknown";
    fixed.sources = out.sources.filter((s) => !bad.has(s.fact));
    return fixed as FactsOut;
  },
  describe: (o) => `价格 ${o.price} · 源码 ${o.sourceCode} · 许可 ${o.license} · 商用 ${o.commercial}（${o.sources.length} 条出处）`,
  after: (out, ctx) => {
    ctx.addEvidence({ id: `fa-${ctx.attempt}`, kind: "verdict", label: "事实", verdict: `${out.price} · ${out.license}`, tone: out.sources.length ? "ok" : "warn", meta: { ...out, pages: (pagesCache.get(ctx.token) ?? []).map((p) => p.url) } });
    return { ok: true, summary: `${out.price} · ${out.sourceCode} · ${out.license} · ${out.commercial}`, data: { facts: out, factPages: structuredClone(pagesCache.get(ctx.token) ?? []) } };
  },
};

/* ------------------------------------------------------------------ ⑭ copy */

type CopyOut = { descriptionZh: string; takeawayZh: string; descriptionEn: string };
const BANNED = /精美|高级感|极致|强大的|一站式|赋能|海量|顶级/;
export const copy: AgentStationDef<CopyOut> = {
  system: prompt("copy.md"),
  schema: Type.Object({ descriptionZh: Type.String(), takeawayZh: Type.String(), descriptionEn: Type.String() }),
  input: (ctx) => {
    const d = data(ctx);
    return { text: `网站：${d.title}（${d.canonical}）\n分类：${KIND_ZH[d.kind]}\n首页描述：${d.home?.description ?? ""}\n风格：${d.style?.applicable ? `${(d.style.styles ?? []).map((s: D) => s.id).join(", ")}；${d.style.signatureZh ?? ""}` : "不适用"}\n事实：${JSON.stringify(d.facts ?? {})}\n首页文字摘录：${String(d.home?.text ?? "").slice(0, 1200)}` };
  },
  check: (o, ctx) => {
    const issues: string[] = [];
    const n = [...o.descriptionZh].length;
    if (n < 40 || n > 140) issues.push(`descriptionZh has ${n} characters; needs 40–120`);
    const t = [...o.takeawayZh].length;
    if (t < 8 || t > 34) issues.push(`takeawayZh has ${t} characters; needs 10–30`);
    if (BANNED.test(o.descriptionZh + o.takeawayZh)) issues.push(`banned word: ${(o.descriptionZh + o.takeawayZh).match(BANNED)![0]}`);
    const hay = JSON.stringify(data(ctx).home ?? {}) + JSON.stringify(data(ctx).facts ?? {});
    for (const num of (o.descriptionZh.match(/\d[\d,.]*\+?/g) ?? [])) if (!hay.includes(num.replace(/[+,]/g, "").slice(0, 4))) issues.push(`number ${num} is not in the evidence`);
    return issues;
  },
  describe: (o) => `「${o.takeawayZh}」`,
  after: (out, ctx) => {
    ctx.addEvidence({ id: `cp-${ctx.attempt}`, kind: "text", label: "文案", verdict: out.takeawayZh.slice(0, 18), tone: "ok", meta: { ...out } });
    return { ok: true, summary: out.takeawayZh, data: { copy: out } };
  },
};

/* ------------------------------------------------------------------ ⑮ ⑯ reviews */

type ReviewOut = { verdict: "pass" | "return"; problems: { item: string; why: string }[]; reason: string };
const ReviewSchema = Type.Object({ verdict: lit("pass", "return"), problems: Type.Array(Type.Object({ item: Type.String(), why: Type.String() })), reason: Type.String() });

const reviewer = (station: "fact-review" | "copy-review", field: "factReview" | "copyReview", back: string, label: string, text: (ctx: StationContext) => string): AgentStationDef<ReviewOut> => ({
  system: prompt(`${station}.md`),
  schema: ReviewSchema,
  input: (ctx) => ({ text: text(ctx) }),
  check: (o) => (o.verdict === "return" && !o.problems.length ? ["a return must list problems"] : []),
  describe: (o) => (o.verdict === "pass" ? "通过" : `退回：${o.problems.map((p) => `${p.item}（${p.why}）`).join("；").slice(0, 90)}`),
  after: (out, ctx) => {
    ctx.addEvidence({ id: `${station}-${ctx.attempt}`, kind: "verdict", label, verdict: out.verdict === "pass" ? "✓ 通过" : `退回 ${out.problems.length} 处`, tone: out.verdict === "pass" ? "ok" : "warn", meta: { ...out } });
    const reason = out.verdict === "pass" ? out.reason : out.problems.map((p) => `${p.item}：${p.why}`).join("；");
    return {
      ok: true, summary: out.verdict === "pass" ? `${label}通过` : `退回：${reason.slice(0, 60)}`,
      data: { [field]: out.verdict, reviews: reviewsWith(ctx, { station, verdict: out.verdict, reason }) },
      verdict: { verdict: out.verdict, returnTo: out.verdict === "return" ? `curation/${back}` : undefined, reason },
    };
  },
});

export const factReview = reviewer("fact-review", "factReview", "facts", "事实审查", (ctx) => {
  const d = data(ctx);
  return `Facts: ${JSON.stringify(d.facts)}\n\nFetched page excerpts:\n${((d.factPages ?? []) as { url: string; text: string }[]).map((p) => `URL ${p.url}\n${p.text}`).join("\n\n")}`;
});
export const copyReview = reviewer("copy-review", "copyReview", "copy", "文案审查", (ctx) => {
  const d = data(ctx);
  return `Copy: ${JSON.stringify(d.copy)}\n\nEvidence:\nkind ${d.kind}; title "${d.title}"; page description "${d.home?.description ?? ""}"\nfacts ${JSON.stringify(d.facts)}\nstyle ${JSON.stringify(d.style?.signatureZh ?? "")}\npage text excerpt: ${String(d.home?.text ?? "").slice(0, 1500)}`;
});

export function agentDefs(store: EvidenceStore): Record<string, AgentStationDef> {
  return {
    "curation/classify": classify, "curation/classify-review": classifyReview, "curation/arbiter": arbiter,
    "curation/shot-review": shotReview(store), "curation/style": style(store), "curation/facts": facts,
    "curation/copy": copy, "curation/fact-review": factReview, "curation/copy-review": copyReview,
  };
}
