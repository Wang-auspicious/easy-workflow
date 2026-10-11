// Agent and review stations of the VisLexicon pack, curation line v2 (Spec §34, §35).
// Every station = ROLE.md handbook (injected by the envelope) + a short task contract here
// + an output schema + program checks. Reviewers only see evidence, never the producer's
// reasoning, and ask owners for fixes directly instead of replaying the pipeline.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";
import type { AgentStationDef } from "../../server/agent-station.ts";
import type { StationContext, StationResult, Fix } from "../../server/runtime.ts";
import { EvidenceStore, pixelStats } from "../../server/evidence.ts";
import { readText } from "../../server/network.ts";
import { repoSources, type RepoMeta } from "../../server/repo.ts";
import { FRONTEND, KINDS, KIND_ZH, VOCAB, ruleExcerpt } from "./env.ts";
import { dossierText, type Dossier } from "./scout.ts";
import { CHOSEN_AXES, KIND_CATEGORIES, loadTaxonomy, ownerOf, taxonomyLoaded } from "./v3.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const prompt = (name: string) => fs.readFileSync(path.join(HERE, "stations", name), "utf8");
const lit = (...v: string[]) => Type.Union(v.map((x) => Type.Literal(x)));
const rules = (...refs: string[]) => refs.map((r) => ruleExcerpt(r)).filter(Boolean).join("\n\n");
const withRules = (base: string, ...refs: string[]) => { const ex = rules(...refs); return ex ? `${base}\n\n规则原文（来自 VisLexicon Spec.md，作为资料）：\n${ex}` : base; };

type D = Record<string, any>;
const data = (ctx: StationContext) => ctx.token.data as D;
const dossier = (ctx: StationContext) => data(ctx).dossier as Dossier | undefined;
const reviewsWith = (ctx: StationContext, r: { station: string; verdict: string; reason: string }) =>
  [...((data(ctx).reviews as unknown[]) ?? []), { ...r, at: new Date().toISOString() }];
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/^["'“”「」]+|["'“”「」.…。]+$/g, "").trim();
const isHttp = (v: unknown) => { try { return ["http:", "https:"].includes(new URL(String(v)).protocol); } catch { return false; } };
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const sameSite = (u: string, host: string) => { const h = hostOf(u); return Boolean(h) && (h === host || h.endsWith(`.${host}`) || host.endsWith(`.${h}`)); };

/** Every text an agent may quote for this item: dossier, key pages, repo sources and pages it read. */
function corpus(ctx: StationContext) {
  const d = dossier(ctx);
  const parts = [d?.title ?? "", d?.description ?? "", d?.text ?? "", ...(d?.pages ?? []).map((p) => `${p.title}\n${p.text}`), d?.files.llms ?? "", ...(d?.repo ? repoSources(d.repo).map((s) => s.text) : []), String(data(ctx).home?.text ?? "")];
  return norm(parts.join("\n"));
}
const quoted = (quote: string, hay: string) => { const q = norm(quote); return q.length >= 3 && hay.includes(q.slice(0, Math.min(80, q.length))); };

/* ------------------------------------------------------------------ ③ reader */

type Pick = { url: string; reason: string; locate?: string };
type ReaderOut = {
  understanding: { who: { text: string; url: string }; takeaway: { text: string; url: string }; size: { text: string; url: string }; terms: { text: string; url: string } };
  plan: { identity: Pick; breadth: Pick & { alternatives: Pick[] }; proof: Pick & { alternatives: Pick[] } };
  factLeads: { field: string; url: string; why: string }[];
  blockers: string[];
  handoff: string;
};
const PickT = Type.Object({ url: Type.String(), reason: Type.String(), locate: Type.Optional(Type.String()) });
const Said = Type.Object({ text: Type.String(), url: Type.String() });

export const reader: AgentStationDef<ReaderOut> = {
  system: withRules(`读侦察卷宗（必要时用 page_text / page_find / site_files / repo_meta 补读，最多 4 页），回答四问并写出拍摄单。
- understanding：who 它是谁；takeaway 你能从它身上拿走什么；size 它有多大；terms 价格与许可写在哪里。每项一段中文，附一个 URL。
- plan：identity / breadth / proof 各一个首选 url + reason（中文一句）；breadth 与 proof 再给 0–2 个 alternatives。proof 必须写 locate：演示在页面上的位置（标题文字、在代码块上方或下方、是否 iframe）。三个首选 url 互不相同，都是本站页面。
- factLeads：author / organization / repository / license / pricing 最可能写在哪个 URL（可以是仓库或 LICENSE 文件），附 why。
- blockers：登录墙、证书、地区限制、找不到演示页等，没有就空数组。
- handoff：写给后面工位的一句提醒（中文，可空）。`, "vislexicon:Spec.md#4.8"),
  tools: ["page_text", "page_find", "fetch_text", "site_files", "repo_meta"],
  schema: Type.Object({
    understanding: Type.Object({ who: Said, takeaway: Said, size: Said, terms: Said }),
    plan: Type.Object({ identity: PickT, breadth: Type.Intersect([PickT, Type.Object({ alternatives: Type.Array(PickT, { maxItems: 2 }) })]), proof: Type.Intersect([PickT, Type.Object({ alternatives: Type.Array(PickT, { maxItems: 2 }) })]) }),
    factLeads: Type.Array(Type.Object({ field: lit("author", "organization", "repository", "license", "pricing"), url: Type.String(), why: Type.String() }), { maxItems: 8 }),
    blockers: Type.Array(Type.String(), { maxItems: 6 }),
    handoff: Type.String(),
  }),
  input: (ctx) => ({ text: `站点卷宗如下。\n\n${dossierText(dossier(ctx))}` }),
  check: (o, ctx) => {
    const host = String(data(ctx).host);
    const issues: string[] = [];
    const urls = [o.plan.identity.url, o.plan.breadth.url, o.plan.proof.url];
    urls.forEach((u, i) => { if (!isHttp(u) || !sameSite(u, host)) issues.push(`plan.${["identity", "breadth", "proof"][i]}.url 必须是本站（${host}）的完整网址：${u}`); });
    if (new Set(urls.map((u) => u.replace(/\/+$/, ""))).size < 3 && !o.blockers.length) issues.push("三个首选页必须互不相同；确实找不到就把原因写进 blockers");
    if (!o.plan.proof.locate?.trim() && !o.blockers.length) issues.push("plan.proof.locate 必须写演示在页面上的位置");
    for (const [k, v] of Object.entries(o.understanding)) if (!isHttp(v.url)) issues.push(`understanding.${k}.url 不是完整网址`);
    return issues;
  },
  describe: (o) => `拍摄单：目录 ${pathOf(o.plan.breadth.url)} · 特写 ${pathOf(o.plan.proof.url)}${o.blockers.length ? ` · 阻碍：${o.blockers.join("；").slice(0, 40)}` : ""}`,
  after: (o, ctx) => {
    ctx.addEvidence({ id: `reader-${ctx.attempt}`, kind: "text", label: "站点理解", verdict: o.understanding.takeaway.text.slice(0, 22), tone: o.blockers.length ? "warn" : "ok", meta: { ...o } });
    return {
      ok: true, summary: `${o.understanding.takeaway.text.slice(0, 50)}；拍摄单：目录 ${pathOf(o.plan.breadth.url)}，特写 ${pathOf(o.plan.proof.url)}`,
      data: { understanding: o.understanding, readerPlan: o.plan, factLeads: o.factLeads, readerBlockers: o.blockers },
      caseNotes: [
        { section: "站点理解", text: Object.entries({ 它是谁: o.understanding.who, 拿走什么: o.understanding.takeaway, 有多大: o.understanding.size, 取用条件: o.understanding.terms }).map(([k, v]) => `- ${k}：${v.text}（${v.url}）`).join("\n") },
        { section: "拍摄单", text: [`- 首屏：${o.plan.identity.url}（${o.plan.identity.reason}）`, `- 目录：${o.plan.breadth.url}（${o.plan.breadth.reason}）${o.plan.breadth.alternatives.map((a) => `；备选 ${a.url}`).join("")}`, `- 特写：${o.plan.proof.url}（${o.plan.proof.reason}；位置：${o.plan.proof.locate ?? "未写"}）${o.plan.proof.alternatives.map((a) => `；备选 ${a.url}${a.locate ? `（${a.locate}）` : ""}`).join("")}`, o.blockers.length ? `- 阻碍：${o.blockers.join("；")}` : "", o.handoff ? `- 提醒：${o.handoff}` : ""].filter(Boolean).join("\n") },
      ],
    };
  },
};
const pathOf = (u: string) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };

/* ------------------------------------------------------------------ ④ classify ∥ classify-review */

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
    if (!quoted(firstYes.quote, corpus(ctx))) issues.push(`the quote for question ${firstYes.q} is not verbatim in the dossier`);
    const asked = out.answers.filter((a) => a.q < firstYes.q).map((a) => a.q);
    for (let q = 1; q < firstYes.q; q++) if (!asked.includes(q)) issues.push(`question ${q} was skipped (ask in order)`);
  }
  return issues;
}
const describeKind = (o: KindOut) => `判为 ${KIND_ZH[o.kind] ?? o.kind}（置信 ${o.confidence.toFixed(2)}；问到第 ${o.answers.find((a) => a.yes)?.q ?? "?"} 题停）`;
const kindContract = withRules(`按 VisLexicon 七类的判定顺序，从上往下逐题回答是或否，第一个"是"就停。每个回答附一段卷宗原文的逐字引用（"是"必须有引用）。confidence 是你对停下的那一题有多确定（0–1）。只看卷宗与你用工具读到的页面。`, "vislexicon:Spec.md#2.3", "vislexicon:Spec.md#2.4");

const kindStation = (field: "kind1" | "kind2", label: string): AgentStationDef<KindOut> => ({
  system: kindContract,
  tools: ["page_text", "fetch_text"],
  schema: KindAnswer,
  input: (ctx) => ({ text: `站点卷宗如下。\n\n${dossierText(dossier(ctx), 12000)}` }),
  check: checkKind,
  describe: describeKind,
  after: (out, ctx) => {
    const yes = out.answers.find((a) => a.yes);
    ctx.addEvidence({ id: `${field}-${ctx.attempt}`, kind: "verdict", label, verdict: `${KIND_ZH[out.kind]} · 第${yes?.q}问`, tone: "ok", meta: { ...out } });
    return { ok: true, summary: describeKind(out), data: { [field]: out } };
  },
});
export const classify = kindStation("kind1", "分类");
export const classifyReview = kindStation("kind2", "分类复核");

/* ------------------------------------------------------------------ arbiter */

type ArbOut = { kind: string; reason: string; quote: string; sourceUrl: string };
export const arbiter: AgentStationDef<ArbOut> = {
  system: withRules(`分类员与复核员独立判定后不一致。读双方答案与引用，回到原页核对（可以用 page_text / fetch_text 再读两页），按同样的七题顺序裁定。
- 只有当一段逐字引用清楚支持某一类时才裁定，并给出引用所在的 sourceUrl。
- 一方的引用在原文里找不到，这一方作废。
- 证据不足就提交 kind 为空字符串，交站长决定，不要硬选。`, "vislexicon:Spec.md#2.4"),
  tools: ["page_text", "fetch_text"],
  schema: Type.Object({ kind: lit(...KINDS, ""), reason: Type.String(), quote: Type.String(), sourceUrl: Type.String() }),
  input: (ctx) => {
    const a = data(ctx).kind1 as KindOut, b = data(ctx).kind2 as KindOut;
    const fmt = (o: KindOut) => `${o.kind}（置信 ${o.confidence}）；${o.answers.map((x) => `Q${x.q} ${x.yes ? "是" : "否"} “${x.quote}”`).join("；")}`;
    return { text: `${dossierText(dossier(ctx), 10000)}\n\n分类员 A：${fmt(a)}\n复核员 B：${fmt(b)}` };
  },
  check: (o, ctx) => {
    if (!o.kind) return [];
    const issues: string[] = [];
    const hay = corpus(ctx) + norm(readText(o.sourceUrl) ?? "");
    if (!quoted(o.quote, hay)) issues.push("裁定引用不在卷宗或你读过的页面里；引用原文并给出 sourceUrl，或者提交空 kind 交人");
    return issues;
  },
  describe: (o) => (o.kind ? `裁定为 ${KIND_ZH[o.kind]}：${o.reason.slice(0, 60)}` : `裁不了，交人：${o.reason.slice(0, 60)}`),
  after: (out, ctx) => {
    ctx.addEvidence({ id: `arb-${ctx.attempt}`, kind: "verdict", label: "仲裁", verdict: out.kind ? `裁定 ${KIND_ZH[out.kind]}` : "交人", tone: out.kind ? "ok" : "warn", meta: { ...out } });
    return { ok: true, summary: out.kind ? `裁定 ${KIND_ZH[out.kind]}：${out.reason.slice(0, 60)}` : "交人裁定", data: { kind: out.kind, arbiterDecided: Boolean(out.kind), manualReason: out.kind ? undefined : `分类分歧未决：${out.reason}`, reviews: reviewsWith(ctx, { station: "arbiter", verdict: out.kind ? "pass" : "escalate", reason: out.reason }) } };
  },
};

/* ------------------------------------------------------------------ ⑤ catalog (facets) */

type CatalogOut = { primaryCategory: string; subcategory: string; facets: Record<string, string[]>; reply: string };
export const catalog: AgentStationDef<CatalogOut> = {
  system: `给条目定后台分类和 10 条标签轴（access 与 licenses 两轴由事实自动推导，不归你）。
- primaryCategory 只能从"可选大类"里选；subcategory 必须属于所选大类。
- 每条轴只能用给出的取值 id，可以空数组；宁缺勿滥，每个取值都要能在卷宗或站点理解里找到依据。
- 被审核员要求修改时，只改被点名的字段，并在 reply 里一句话说明改了什么。`,
  schema: Type.Object({ primaryCategory: Type.String(), subcategory: Type.String(), facets: Type.Record(Type.String(), Type.Array(Type.String())), reply: Type.String() }),
  input: async (ctx) => {
    const tax = await loadTaxonomy();
    const kind = String(data(ctx).kind);
    const cats = KIND_CATEGORIES[kind] ?? [];
    const axes = CHOSEN_AXES.map((a) => `${a}: ${tax.axes[a].map((v) => `${v.id}(${v.label})`).join(", ")}`).join("\n");
    const subs = cats.map((c) => `${c}（${tax.categories.find((x) => x.id === c)?.label}）：${tax.subcategories[c].map((s) => `${s.id}(${s.label})`).join(", ")}`).join("\n");
    const prev = data(ctx).catalogV3 ? `\n\n当前取值：${JSON.stringify(data(ctx).catalogV3)}` : "";
    return { text: `分类（七类）：${kind}（${KIND_ZH[kind]}）\n站点理解：${JSON.stringify(data(ctx).understanding ?? {})}\n\n可选大类与子类：\n${subs}\n\n标签轴可选取值：\n${axes}${prev}\n\n卷宗节选：\n${dossierText(dossier(ctx), 6000)}` };
  },
  check: (o, ctx) => {
    const tax = taxonomyLoaded();
    const issues: string[] = [];
    const cats = KIND_CATEGORIES[String(data(ctx).kind)] ?? [];
    if (!cats.includes(o.primaryCategory)) issues.push(`primaryCategory 必须是 ${cats.join(" / ")} 之一`);
    else if (tax && !tax.subcategories[o.primaryCategory]?.some((s) => s.id === o.subcategory)) issues.push(`subcategory ${o.subcategory} 不属于 ${o.primaryCategory}`);
    if (tax) {
      const facets = Object.fromEntries(CHOSEN_AXES.map((a) => [a, o.facets[a] ?? []]));
      for (const e of tax.facetsErrors(facets)) issues.push(e);
      for (const k of Object.keys(o.facets)) if (!(CHOSEN_AXES as readonly string[]).includes(k)) issues.push(`不要填 ${k}（只填 ${CHOSEN_AXES.join(", ")}）`);
    }
    return issues;
  },
  salvage: (o) => ({ ...o, facets: Object.fromEntries(CHOSEN_AXES.map((a) => [a, (o.facets[a] ?? []).filter((v) => taxonomyLoaded()?.axes[a].some((x) => x.id === v))])) }),
  describe: (o) => `${o.primaryCategory} / ${o.subcategory} · ${CHOSEN_AXES.map((a) => (o.facets[a] ?? []).length).reduce((x, y) => x + y, 0)} 个标签`,
  after: (o, ctx) => {
    const facets = Object.fromEntries(CHOSEN_AXES.map((a) => [a, o.facets[a] ?? []]));
    ctx.addEvidence({ id: `cat-${ctx.attempt}`, kind: "verdict", label: "编目", verdict: `${o.subcategory}`.slice(0, 22), tone: "ok", meta: { ...o, facets } });
    return { ok: true, summary: `${o.primaryCategory} / ${o.subcategory}${o.reply ? `；${o.reply}` : ""}`, data: { catalogV3: { primaryCategory: o.primaryCategory, subcategory: o.subcategory, facets }, reply: o.reply } };
  },
};

/* ------------------------------------------------------------------ ⑪ shot review (pipeline return kept: cheap, nothing downstream ran yet) */

type ShotReviewOut = { perImage: { role: string; ok: boolean; reason: string }[]; verdict: "pass" | "return"; returnTo?: string; repair?: "reframe" | "replace-page" | "wait-for-render"; reason: string };
function imagesOf(ctx: StationContext, store: EvidenceStore) {
  const d = data(ctx);
  if (d.mode === "video") return d.video ? [{ file: store.resolve(d.video.posterCard)!, label: "video poster" }] : [];
  return ((d.images ?? []) as { role: string; card: string; href: string }[]).map((im) => ({ file: store.resolve(im.card)!, label: `${im.role} — ${im.href}` }));
}

export const shotReview = (store: EvidenceStore): AgentStationDef<ShotReviewOut> => ({
  system: withRules(prompt("shot-review.md"), "vislexicon:Spec.md#4.8"),
  schema: Type.Object({
    perImage: Type.Array(Type.Object({ role: lit("identity", "breadth", "proof", "poster"), ok: Type.Boolean(), reason: Type.String() })),
    verdict: lit("pass", "return"), returnTo: Type.Optional(lit("identity", "breadth", "proof")), repair: Type.Optional(lit("reframe", "replace-page", "wait-for-render")), reason: Type.String(),
  }),
  input: (ctx) => {
    const imgs = imagesOf(ctx, store);
    const plan = data(ctx).readerPlan as ReaderOut["plan"] | undefined;
    return {
      text: `Site: ${data(ctx).title} (${data(ctx).canonical}). Kind: ${data(ctx).kind} (${KIND_ZH[data(ctx).kind]}). Mode: ${data(ctx).mode}.${plan ? `\nReader's shot plan: breadth ${plan.breadth.url}; proof ${plan.proof.url} (locate: ${plan.proof.locate ?? "-"}).` : ""}\n${imgs.map((im, i) => `image ${i + 1}: ${im.label}`).join("\n")}`,
      images: imgs,
    };
  },
  check: (o) => (o.verdict === "return" && (!o.returnTo || !o.repair || o.reason.trim().length < 6) ? ["a return must name returnTo, repair (reframe | replace-page | wait-for-render), and a concrete reason"] : []),
  describe: (o) => (o.verdict === "pass" ? `通过：${o.perImage.map((p) => `${p.role} ${p.ok ? "✓" : "✗"}`).join(" ")}` : `退回 ${o.returnTo}：${o.reason.slice(0, 70)}`),
  after: (out, ctx) => {
    const d = data(ctx);
    const rejected = out.verdict === "return" && out.repair === "replace-page" && out.returnTo ? [...((d.rejectedPages as string[]) ?? []), d.shots?.[out.returnTo]?.href].filter(Boolean) : d.rejectedPages;
    const shotRepairs = { ...d.shotRepairs };
    if (out.verdict === "return" && out.returnTo) shotRepairs[out.returnTo] = { action: out.repair, url: d.shots?.[out.returnTo]?.href, reason: out.reason };
    ctx.addEvidence({ id: `sr-${ctx.attempt}`, kind: "verdict", label: "截图审查", verdict: out.verdict === "pass" ? "三张图 ✓" : `退回 ${({ identity: "首屏", breadth: "目录", proof: "特写" } as D)[out.returnTo ?? ""] ?? ""}`, tone: out.verdict === "pass" ? "ok" : "warn", meta: { ...out } });
    if (d.mode === "video" && out.verdict === "return") return { ok: true, summary: "录屏封面不合格 → 交人", data: { shotReview: "escalate" }, verdict: { verdict: "escalate", reason: out.reason } };
    return {
      ok: true, summary: out.verdict === "pass" ? "截图通过" : `退回${out.returnTo}：${out.reason.slice(0, 60)}`,
      data: { shotReview: out.verdict, shotRepairs, rejectedPages: rejected, reviews: reviewsWith(ctx, { station: "shot-review", verdict: out.verdict, reason: out.reason }) },
      verdict: { verdict: out.verdict, returnTo: out.returnTo ? `curation/${out.returnTo}` : undefined, reason: out.reason },
    };
  },
});

/* ------------------------------------------------------------------ ⑫ style (VisLexicon §2.6.1 prompt kept verbatim) */

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
  system: prompt("style.md").replace("{VOCAB}", VOCAB.styles.map((s) => `- ${s.id}: ${s.en} — looks like: ${s.plain}`).join("\n")).replace("{SUBJECT}", "SUBJECT: see the user message."),
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

export async function warmStyleLib() {
  try { (globalThis as D).__styleLib = await loadStyleLib(); } catch (err) { console.warn("style lib not loaded:", (err as Error).message); }
  try { await loadTaxonomy(); } catch (err) { console.warn("taxonomy not loaded:", (err as Error).message); }
}

/* ------------------------------------------------------------------ ⑬ facts */

export const FACT_FIELDS = ["author", "organization", "repository", "license", "pricing", "sourceCode", "commercial"] as const;
type FactValue = { value: string; sourceUrl: string; quote: string; evidence: string; scope: string };
type FactsOut = Record<(typeof FACT_FIELDS)[number], FactValue> & { pricingNote: string; conflicts: string[]; reply: string };

/** Program legwork before the model: repository API, LICENSE, package.json and the pages the reader pointed to. */
async function factSources(ctx: StationContext) {
  const d = data(ctx);
  const dos = dossier(ctx);
  const pages: { url: string; text: string }[] = [];
  const add = (url: string, text: string) => { if (text && !pages.some((p) => p.url === url)) pages.push({ url, text: text.slice(0, 3500) }); };
  add(dos?.finalUrl ?? d.canonical, [dos?.title, dos?.description, dos?.text?.slice(0, 1800), dos?.text && dos.text.length > 1800 ? `…页脚：${dos.text.slice(-1500)}` : ""].filter(Boolean).join("\n"));
  for (const p of dos?.pages ?? []) add(p.url, `${p.title}\n${p.text}`);
  const repo = dos?.repo as RepoMeta | null | undefined;
  if (repo) for (const s of repoSources(repo)) add(s.url, s.text);
  const { webGet } = await import("../../server/network.ts");
  const { parseHtml } = await import("./tools.ts");
  for (const lead of ((d.factLeads ?? []) as { url: string }[]).slice(0, 4)) {
    if (pages.some((p) => p.url === lead.url) || !isHttp(lead.url)) continue;
    const known = readText(lead.url);
    if (known) { add(lead.url, known); continue; }
    try {
      const r = await webGet(lead.url, { signal: ctx.signal, timeout: 12000 });
      if (r.status < 400) { const h = /html/i.test(r.contentType) ? parseHtml(r.body, r.finalUrl, 20000) : null; add(lead.url, h ? `${h.title}\n${h.text}` : r.body); }
    } catch { /* the model can still read it with tools */ }
  }
  return pages;
}
const factCache = new WeakMap<object, { url: string; text: string }[]>();

const FactT = Type.Object({ value: Type.String(), sourceUrl: Type.String(), quote: Type.String(), evidence: Type.String(), scope: Type.String() });
export const facts: AgentStationDef<FactsOut> = {
  system: `核验七项独立事实：author、organization、repository、license、pricing、sourceCode、commercial。
- value：author / organization 写名字或 unknown；repository 写仓库网址或 unknown；license 写 SPDX 短名、custom 或 unknown；pricing 写 free / freemium / paid / unknown；sourceCode 写 open / closed / unknown；commercial 写 allowed / restricted / unknown。
- 每个不是 unknown 的值：sourceUrl 必须是资料里或你用工具读过的页面，quote 是该页原文里连续的一段（不改写、不翻译），evidence 用中文说清在哪里看到、说明了什么，scope 写适用范围（比如"只覆盖仓库源码"，没有就空字符串）。
- unknown 也要写 evidence：看了哪些页没找到。sourceUrl 可以写最后查看的那一页。
- pricingNote：价格的一句中文说明（比如"免费核心组件 + 付费 Pro"），没有就空。conflicts：两处说法矛盾时写出来。
- 被审核员要求修改时，只改被点名的项，在 reply 里一句话说明改了什么。`,
  tools: ["fetch_text", "page_text", "repo_meta", "site_files"],
  schema: Type.Object({ ...Object.fromEntries(FACT_FIELDS.map((f) => [f, FactT])), pricingNote: Type.String(), conflicts: Type.Array(Type.String()), reply: Type.String() } as Record<string, any>),
  input: async (ctx) => {
    const pages = await factSources(ctx);
    factCache.set(ctx.token, pages);
    const leads = ((data(ctx).factLeads ?? []) as { field: string; url: string; why: string }[]).map((l) => `- ${l.field}：${l.url}（${l.why}）`).join("\n");
    const prev = data(ctx).facts ? `\n\n当前取值（修改时只改被点名的项）：${JSON.stringify(data(ctx).facts)}` : "";
    return { text: `网站：${data(ctx).title}（${data(ctx).canonical}），分类 ${data(ctx).kind}。\n阅读员给的线索：\n${leads || "（无）"}${prev}\n\n已取到的资料：\n${pages.map((p, i) => `【资料 ${i + 1}】${p.url}\n${p.text}`).join("\n\n")}` };
  },
  check: (out, ctx) => {
    const pages = factCache.get(ctx.token) ?? [];
    const issues: string[] = [];
    for (const f of FACT_FIELDS) {
      const v = out[f];
      if (!v) { issues.push(`${f}: 缺少`); continue; }
      if (v.value === "unknown" || !v.value) continue;
      if (!isHttp(v.sourceUrl)) { issues.push(`${f}: sourceUrl 不是完整网址`); continue; }
      const text = pages.find((p) => p.url.replace(/\/+$/, "") === v.sourceUrl.replace(/\/+$/, ""))?.text ?? readText(v.sourceUrl);
      if (!text) issues.push(`${f}: ${v.sourceUrl} 不在资料里，也没有被你用工具读过`);
      else if (!quoted(v.quote, norm(text))) issues.push(`${f}: quote 不是 ${v.sourceUrl} 原文里的连续文字`);
    }
    if (out.pricing && !["free", "freemium", "paid", "unknown"].includes(out.pricing.value)) issues.push("pricing: value 只能是 free / freemium / paid / unknown");
    if (out.sourceCode && !["open", "closed", "unknown"].includes(out.sourceCode.value)) issues.push("sourceCode: value 只能是 open / closed / unknown");
    if (out.commercial && !["allowed", "restricted", "unknown"].includes(out.commercial.value)) issues.push("commercial: value 只能是 allowed / restricted / unknown");
    return issues;
  },
  salvage: (out, issues) => {
    const bad = new Set(issues.map((i) => i.split(":")[0].trim()));
    const fixed = { ...out } as D;
    for (const f of bad) if (f in fixed) fixed[f] = { ...fixed[f], value: "unknown", evidence: `${fixed[f]?.evidence ?? ""}（引用未能核实，按未知处理）` };
    return fixed as FactsOut;
  },
  describe: (o) => `作者 ${o.author?.value} · 仓库 ${o.repository?.value === "unknown" ? "未知" : "有"} · 许可 ${o.license?.value} · 价格 ${o.pricing?.value} · 商用 ${o.commercial?.value}`,
  after: (out, ctx) => {
    const facts = Object.fromEntries(FACT_FIELDS.map((f) => [f, out[f]]));
    const pages = factCache.get(ctx.token) ?? [];
    const read = FACT_FIELDS.map((f) => out[f]?.sourceUrl).filter((u) => u && !pages.some((p) => p.url === u)).map((u) => ({ url: u, text: (readText(u) ?? "").slice(0, 3500) })).filter((p) => p.text);
    ctx.addEvidence({ id: `fa-${ctx.attempt}`, kind: "verdict", label: "事实", verdict: `${out.pricing?.value} · ${out.license?.value}`, tone: FACT_FIELDS.some((f) => out[f]?.value !== "unknown") ? "ok" : "warn", meta: { ...facts, pricingNote: out.pricingNote, conflicts: out.conflicts } });
    return {
      ok: true, summary: `作者 ${out.author?.value} · 许可 ${out.license?.value} · 价格 ${out.pricing?.value} · 商用 ${out.commercial?.value}${out.reply ? `；${out.reply}` : ""}`,
      data: { facts, pricingNote: out.pricingNote, factConflicts: out.conflicts, factPages: [...pages, ...read], reply: out.reply },
      caseNotes: out.conflicts.length ? [{ section: "事实疑点", text: out.conflicts.join("\n") }] : undefined,
    };
  },
};

/* ------------------------------------------------------------------ reviewers with direct consultation */

type Problem = { field: string; problem: string };
type ReviewOut = { verdict: "pass" | "fix"; problems: Problem[]; reason: string };
const ReviewSchema = Type.Object({ verdict: lit("pass", "fix"), problems: Type.Array(Type.Object({ field: Type.String(), problem: Type.String() })), reason: Type.String() });

/** Groups field problems by owner station so each owner gets one consultation. */
function fixesOf(problems: Problem[], fallback: string, via?: string[]): Fix[] {
  const by = new Map<string, Problem[]>();
  for (const p of problems) { const o = ownerOf(p.field) ?? fallback; by.set(o, [...(by.get(o) ?? []), p]); }
  return [...by].map(([station, ps]) => ({ station, fields: ps.map((p) => p.field), problem: ps.map((p) => `${p.field}：${p.problem}`).join("；"), via }));
}

const reviewer = (station: string, label: string, fallbackOwner: string, system: string, text: (ctx: StationContext) => string, images?: (ctx: StationContext) => { file: string; label: string }[], tools?: string[], via?: string[]): AgentStationDef<ReviewOut> => ({
  system, schema: ReviewSchema, tools,
  input: (ctx) => ({ text: text(ctx), images: images?.(ctx) }),
  check: (o) => (o.verdict === "fix" && !o.problems.length ? ["要求修改时必须列出 problems（field + problem）"] : []),
  describe: (o) => (o.verdict === "pass" ? "通过" : `要求修改：${o.problems.map((p) => `${p.field}（${p.problem}）`).join("；").slice(0, 90)}`),
  after: (out, ctx) => {
    const reason = out.verdict === "pass" ? out.reason : out.problems.map((p) => `${p.field}：${p.problem}`).join("；");
    ctx.addEvidence({ id: `${station}-${ctx.attempt}`, kind: "verdict", label, verdict: out.verdict === "pass" ? "✓ 通过" : `要求修改 ${out.problems.length} 处`, tone: out.verdict === "pass" ? "ok" : "warn", meta: { ...out } });
    const res: StationResult = {
      ok: true, summary: out.verdict === "pass" ? `${label}通过` : `要求修改：${reason.slice(0, 60)}`,
      data: { [`${station}Verdict`]: out.verdict, reviews: reviewsWith(ctx, { station, verdict: out.verdict === "pass" ? "pass" : "fix", reason }) },
      verdict: out.verdict === "pass" ? { verdict: "pass", reason } : { verdict: "fix", reason, fixes: fixesOf(out.problems, fallbackOwner, via) },
    };
    return res;
  },
});

export const factReview = reviewer("fact-review", "事实审查", "curation/facts",
  `独立核对事实核验员交来的七项事实：每个不是 unknown 的值，它的 quote 是否真的出现在 sourceUrl 的资料里，并且真的支持这个值；覆盖范围是否写清（MIT 只管仓库、Pro 另收费等）。诚实的 unknown 可以通过。
有问题就 verdict=fix，problems 里逐项写 field（如 facts.license）和具体问题（缺什么来源、哪句不支持）。全部没问题就 pass。你可以用 fetch_text 打开原页核对。`,
  (ctx) => { const d = data(ctx); return `事实：${JSON.stringify(d.facts)}\n价格说明：${d.pricingNote ?? ""}\n\n资料：\n${((d.factPages ?? []) as { url: string; text: string }[]).map((p) => `URL ${p.url}\n${p.text}`).join("\n\n")}`; },
  undefined, ["fetch_text"]);

/* ------------------------------------------------------------------ ⑭ editor */

type CopyOut = { name: string; takeawayZh: string; noteZh: string; rationale: { identity: string; breadth: string; proof: string }; alt: { identity: string; breadth: string; proof: string }; descriptionZh: string; descriptionEn: string; reasons: { statement: string; evidenceUrl: string }[]; reply: string };
const BANNED = /精美|高级感|极致|强大的|一站式|赋能|海量|顶级|神器|必备/;
const imagesFor = (store: EvidenceStore) => (ctx: StationContext) => ((data(ctx).images ?? []) as { role: string; card: string; href: string }[]).map((im) => ({ file: store.resolve(im.card)!, label: `${im.role}: ${im.href}` }));

export const copy = (store: EvidenceStore): AgentStationDef<CopyOut> => ({
  system: `按 VisLexicon 编辑语气写六样东西（细则见你的 ROLE.md）：
- name：官方写法的名称。
- takeawayZh：不超过 28 字，回答"我从这里拿走什么"，不含数字。
- noteZh：编辑手记 120–180 字、2–4 句，用"我们"，依次写进去看到了什么 → 先点开哪里、为什么 → 适合谁或要注意什么；不用感叹号。
- rationale.identity / breadth / proof：每条不超过 40 字，写成导览。
- alt.identity / breadth / proof：画面里实际有什么，不是模板句。
- descriptionZh：中性、完整的 1–2 句；descriptionEn 是它的平实英文版。
- reasons：1–2 条收录理由，每条带一个证据网址。
- 被审核员要求修改时，只改被点名的字段，在 reply 里一句话说明改了什么。`,
  schema: Type.Object({
    name: Type.String(), takeawayZh: Type.String(), noteZh: Type.String(),
    rationale: Type.Object({ identity: Type.String(), breadth: Type.String(), proof: Type.String() }),
    alt: Type.Object({ identity: Type.String(), breadth: Type.String(), proof: Type.String() }),
    descriptionZh: Type.String(), descriptionEn: Type.String(),
    reasons: Type.Array(Type.Object({ statement: Type.String(), evidenceUrl: Type.String() }), { minItems: 1, maxItems: 2 }), reply: Type.String(),
  }),
  input: (ctx) => {
    const d = data(ctx);
    const shots = ((d.images ?? []) as { role: string; href: string }[]).map((im, i) => `图 ${i + 1}（${im.role}）：${im.href}`).join("\n");
    const prev = d.copy ? `\n\n当前文案（修改时只改被点名的字段）：${JSON.stringify(d.copy)}` : "";
    return {
      text: `网站：${d.title}（${d.canonical}）\n分类：${KIND_ZH[d.kind]}\n站点理解：${JSON.stringify(d.understanding ?? {})}\n事实：${JSON.stringify(Object.fromEntries(Object.entries(d.facts ?? {}).map(([k, v]: [string, any]) => [k, { value: v?.value, scope: v?.scope }])))}\n价格说明：${d.pricingNote ?? ""}\n风格：${d.style?.applicable ? `${(d.style.styles ?? []).map((s: D) => s.id).join(", ")}；${d.style.signatureZh ?? ""}` : "不适用"}\n三张图：\n${shots}${prev}\n\n卷宗节选：\n${dossierText(dossier(ctx), 4000)}`,
      images: imagesFor(store)(ctx),
    };
  },
  check: (o, ctx) => {
    const issues: string[] = [];
    const len = (s: string) => [...s].length;
    if (len(o.takeawayZh) > 28 || len(o.takeawayZh) < 6 || /\d/.test(o.takeawayZh)) issues.push(`takeawayZh 有 ${len(o.takeawayZh)} 字，需 6–28 字且不含数字`);
    if (len(o.noteZh) < 120 || len(o.noteZh) > 180) issues.push(`noteZh 有 ${len(o.noteZh)} 字，需 120–180`);
    if (/[!！]/.test(o.noteZh)) issues.push("noteZh 不用感叹号");
    if (!o.noteZh.includes("我们")) issues.push("noteZh 用第一人称复数“我们”");
    for (const k of ["identity", "breadth", "proof"] as const) {
      if (len(o.rationale[k]) > 40 || len(o.rationale[k]) < 6) issues.push(`rationale.${k} 需 6–40 字`);
      if (len(o.alt[k]) < 6 || /screenshot|evidence|截图$/i.test(o.alt[k])) issues.push(`alt.${k} 要写画面里有什么`);
    }
    const all = o.takeawayZh + o.noteZh + o.descriptionZh;
    if (BANNED.test(all)) issues.push(`禁用词：${all.match(BANNED)![0]}`);
    const hay = JSON.stringify(data(ctx).dossier ?? {}) + JSON.stringify(data(ctx).facts ?? {});
    for (const num of (o.descriptionZh + o.noteZh).match(/\d[\d,.]*\+?/g) ?? []) if (!hay.includes(num.replace(/[+,]/g, "").slice(0, 4))) issues.push(`数字 ${num} 在资料里找不到`);
    const price = data(ctx).facts?.pricing?.value;
    if ((!price || price === "unknown") && /免费|free/i.test(o.descriptionZh + o.noteZh + o.takeawayZh)) issues.push("价格未知时不能写免费");
    for (const r of o.reasons) if (!isHttp(r.evidenceUrl)) issues.push("reasons 的 evidenceUrl 必须是完整网址");
    return issues;
  },
  describe: (o) => `「${o.takeawayZh}」`,
  after: (out, ctx) => {
    ctx.addEvidence({ id: `cp-${ctx.attempt}`, kind: "text", label: "文案", verdict: out.takeawayZh.slice(0, 18), tone: "ok", meta: { ...out } });
    return { ok: true, summary: `「${out.takeawayZh}」${out.reply ? `；${out.reply}` : ""}`, data: { copy: out, reply: out.reply } };
  },
});

export const copyReview = (store: EvidenceStore) => reviewer("copy-review", "文案审查", "curation/copy",
  `独立审查编辑交来的文案。逐条核对：每个说法是否有卷宗、事实或截图支持；数字是否在资料里；价格与许可的说法是否和事实一致；手记是否像真的进去看过（具体到页面和元素，用"我们"，不用营销腔和感叹号）；三条导览与三条 alt 是否和对应截图一致。
不把自己的措辞偏好当问题。有问题就 verdict=fix，problems 里逐项写 field（editorial.noteZh、pages[2].shot.alt、pages[1].selectionRationale、editorial.takeawayZh、classification.reasons 等）和具体哪句、为什么、往哪改。全部没问题就 pass。`,
  (ctx) => { const d = data(ctx); return `文案：${JSON.stringify(d.copy)}\n\n事实：${JSON.stringify(Object.fromEntries(Object.entries(d.facts ?? {}).map(([k, v]: [string, any]) => [k, { value: v?.value, scope: v?.scope }])))}\n站点理解：${JSON.stringify(d.understanding ?? {})}\n截图顺序：pages[0]=identity，pages[1]=breadth，pages[2]=proof\n\n卷宗节选：\n${dossierText(dossier(ctx), 4000)}`; },
  imagesFor(store));

/* ------------------------------------------------------------------ ⑯ final audit */

export const audit = (store: EvidenceStore): AgentStationDef<ReviewOut> => {
  const base = reviewer("audit", "终审", "curation/copy",
    `你是发布前的最后一道关。下面是将要发布的整条 VisLexicon v3 记录，以及程序已经做过的结构校验结果（已通过）。逐字段做语义审核：
- 分类理由与证据一致；primaryCategory / subcategory 与站点实际相符；标签有依据。
- 每条事实的出处真的支持它，覆盖范围写清；事实之间、事实与文案之间不矛盾。
- 名称、takeaway、手记、简介与事实、截图一致；三条导览和 alt 对得上画面。
有问题就 verdict=fix，problems 逐项写字段路径（如 facts.license、classification.subcategory、editorial.noteZh、pages[2].shot.alt）和具体问题。拿不准可以用 fetch_text / page_text 打开原页核对。全部没问题就 pass。`,
    (ctx) => `待发布记录：\n${JSON.stringify(data(ctx).draftV3 ?? {}, null, 1).slice(0, 14000)}`,
    imagesFor(store), ["fetch_text", "page_text", "repo_meta"], ["curation/assemble"]);
  return {
    ...base,
    // Deterministic schema problems need no model: route them to their owners at once.
    skip: (ctx) => {
      const problems = (data(ctx).draftProblems ?? []) as Problem[];
      if (!problems.length) return null;
      ctx.progress(`结构校验发现 ${problems.length} 处问题，直接交负责工位修改`, { tool: "schema", text: problems.map((p) => `${p.field}: ${p.problem}`).join("\n"), ok: false });
      const reason = problems.map((p) => `${p.field}：${p.problem}`).join("；");
      return { ok: true, summary: `结构校验要求修改 ${problems.length} 处`, data: { reviews: reviewsWith(ctx, { station: "audit", verdict: "fix", reason }) }, verdict: { verdict: "fix", reason, fixes: fixesOf(problems, "curation/copy", ["curation/assemble"]) } };
    },
  };
};

export function agentDefs(store: EvidenceStore): Record<string, AgentStationDef> {
  return {
    "curation/reader": reader, "curation/classify": classify, "curation/classify-review": classifyReview, "curation/arbiter": arbiter,
    "curation/catalog": catalog, "curation/shot-review": shotReview(store), "curation/style": style(store), "curation/facts": facts,
    "curation/fact-review": factReview, "curation/copy": copy(store), "curation/copy-review": copyReview(store), "curation/audit": audit(store),
  };
}
