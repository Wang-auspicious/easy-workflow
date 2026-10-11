// VisLexicon preset pack: the source layer, the candidate layer and seven lines
// (Spec §6.0, §6.1, §8). Rules cite VisLexicon `Spec.md` clauses instead of restating them.
import { chain, line, station, type Pack } from "../../server/spec/dsl.ts";

const V = "vislexicon:Spec.md";
const R = "vislexicon:preview-rules.json";

/* ------------------------------------------------------------------ layer 1 · sources (all dormant) */

const sources = line({
  id: "sources", name: "来源层", layer: 1, priority: "low", wired: false,
  blurb: "原始东西从哪里来。只拿回原始记录，不做判断；目前全部休眠。",
  stations: [
    station({ id: "watch", name: "新站监测", role: "source", kind: "source", dormant: true, blurb: "20 个合集源 · feed / sitemap", output: "RawItem", rules: [`${V}#6.6`] }),
    station({ id: "github", name: "GitHub 监测", role: "source", kind: "source", dormant: true, blurb: "DESIGN.md / Skill 仓库", output: "RawItem" }),
    station({ id: "x", name: "X（推特）", role: "social", kind: "source", dormant: true, blurb: "设计博主 · 列表 · 关键词", output: "RawItem", rules: ["spec:§6.5"] }),
    station({ id: "xhs", name: "小红书", role: "social", kind: "source", dormant: true, blurb: "设计 / 前端 / 科研绘图博主", output: "RawItem", rules: ["spec:§6.5"] }),
    station({ id: "douyin", name: "抖音", role: "social", kind: "source", dormant: true, blurb: "动效与设计分享", output: "RawItem" }),
    station({ id: "bilibili", name: "B 站", role: "social", kind: "source", dormant: true, blurb: "教程与作品集", output: "RawItem" }),
  ],
  edges: [],
});

/* ------------------------------------------------------------------ layer 2 · candidates */

const candidates = line({
  id: "candidates", name: "候选层", layer: 2, priority: "high", wired: true,
  blurb: "所有原始货先落到这里：整理、提取、索引，再分流到各条线。本地待处理清单都在这一层。",
  stations: [
    station({
      id: "tidy", name: "候选准备", role: "candidate", kind: "program", resource: "http", estimateSeconds: 6.6, input: "RawItem", output: "TidyItem",
      tool: "candidates.tidy", accept: ["merges keep a disposition record"], blurb: "规范化网址 · 拆一帖多链 · 合并重复",
      pseudo: "url = lower(host) - www - tracking params\nif seen(url): record merge disposition (never drop silently)",
    }),
    station({ id: "pool", name: "候选库", role: "candidate", kind: "store", input: "TidyItem", output: "Candidate", blurb: "VisLexicon 候选目录", rules: [`${V}#2.3`] }),
    station({
      id: "route", name: "分流员", num: "", role: "sort", kind: "program", resource: "none", estimateSeconds: 0.05, input: "Candidate", output: "Candidate",
      tool: "candidates.route", accept: ["unroutable items go to a human"], blurb: "决定这件货进哪条线",
      pseudo: "github DESIGN.md / SKILL.md → skills\nfigure code / paper → sci-figure\n.pptx / deck → ppt\nelse website → curation",
    }),
  ],
  edges: [...chain("tidy", "pool", "route")],
});

/* ------------------------------------------------------------------ layer 3 · curation v2 (Spec §35) */

const curation = line({
  id: "curation", name: "策展线", layer: 3, priority: "high", wired: true,
  blurb: "先进站读懂，再取证、核验、著录，最后逐字段终审。产出 VisLexicon v3 条目与 WebP 证据。",
  stations: [
    station({
      id: "dedupe", num: "①", name: "分拣去重", role: "sort", kind: "program", resource: "none", estimateSeconds: 0.1, input: "Candidate", output: "Site",
      tool: "curation.dedupe", accept: ["duplicates get a disposition record"],
      pseudo: "canonical = normalize(url)\nif canonical in published or in flight → merged (with disposition)",
    }),
    station({
      id: "scout", num: "②", name: "侦察员", role: "sort", kind: "program", resource: "http", estimateSeconds: 18, input: "Site", output: "Dossier",
      tool: "curation.scout", accept: ["rendered home text with link regions", "llms / sitemap / key pages / repository when present"],
      workers: { min: 1, max: 6, initial: 3, policy: "auto" },
      pseudo: "HTTP home (status, meta) → render home in the shared browser (text, headings, link regions, framework)\n∥ llms.txt, llms-full.txt, sitemap, robots · key pages over HTTP · GitHub API + LICENSE + package.json\nTLS / login → red alert, never bypass",
    }),
    station({
      id: "reader", num: "③", name: "阅读员", role: "judge", kind: "agent", input: "Dossier", output: "Understanding",
      rules: [`${V}#4.8`], accept: ["four questions answered with URLs", "shot plan: three distinct same-site pages, proof has a locate hint"], estimateSeconds: 25,
      workers: { min: 1, max: 6, initial: 3, policy: "auto" },
      pseudo: "read the dossier (+ up to 4 pages with page_text) → who / takeaway / size / terms\nplan identity · breadth(+alts) · proof(+alts, locate) · fact leads",
    }),
    station({
      id: "classify", num: "④", name: "分类员", role: "judge", kind: "agent", input: "Dossier", output: "Kind",
      rules: [`${V}#2.3`, `${V}#2.4`], accept: ["every answer quotes the dossier"], estimateSeconds: 8,
      workers: { min: 1, max: 4, initial: 2, policy: "auto" },
      pseudo: "seven questions top-down, stop at the first yes; quotes are verbatim",
    }),
    station({
      id: "classify-review", num: "④'", name: "分类复核员", role: "review", kind: "review", input: "Dossier", output: "Kind",
      rules: [`${V}#2.4`], accept: ["independent of the classifier: same dossier, run in parallel"], estimateSeconds: 8,
      workers: { min: 1, max: 4, initial: 2, policy: "auto" },
    }),
    station({
      id: "kind-join", name: "判定汇合", role: "sort", kind: "program", resource: "none", estimateSeconds: 0.05, input: "Kind", output: "Kind",
      tool: "curation.kind-join", accept: ["agree → catalog; disagree → arbiter"],
    }),
    station({
      id: "arbiter", name: "仲裁员", role: "arbiter", kind: "agent", input: "Kind", output: "Kind",
      rules: [`${V}#2.4`], accept: ["a verbatim quote supports the ruling, or the owner decides"], estimateSeconds: 15, workers: { min: 1, max: 2, initial: 1, policy: "auto" },
    }),
    station({
      id: "catalog", num: "⑤", name: "编目员", role: "judge", kind: "agent", input: "Kind|Understanding", output: "Facets",
      accept: ["primary category fits the kind", "10 facet axes use taxonomy ids only"], estimateSeconds: 10,
      workers: { min: 1, max: 4, initial: 2, policy: "auto" },
    }),
    station({
      id: "plan", num: "⑥", name: "拍摄规划", role: "sort", kind: "program", resource: "none", estimateSeconds: 0.2, input: "Facets", output: "PagePlan",
      tool: "curation.plan", rules: [`${V}#4.8`, R], accept: ["reader plan first, preview rules as fallback; mode by rule"],
    }),
    station({
      id: "identity", num: "⑦", name: "首屏摄影", role: "capture", kind: "program", resource: "browser", estimateSeconds: 12, input: "PagePlan", output: "Shot",
      tool: "curation.identity", rules: [`${R}#reject`], accept: ["no flat block", "no overlay", "not blank"],
      workers: { min: 1, max: 4, initial: 2, policy: "auto" },
    }),
    station({
      id: "breadth", num: "⑧", name: "目录摄影", role: "capture", kind: "program", resource: "browser", estimateSeconds: 15, input: "Shot", output: "Shot",
      tool: "curation.breadth", rules: [`${R}#kinds.*.roles.breadth`], accept: ["compare candidate screenshots side by side", "reader plan, rules, sitemap and home page all join the comparison"],
      workers: { min: 1, max: 4, initial: 2, policy: "auto" },
    }),
    station({
      id: "proof", num: "⑨", name: "组件特写摄影", role: "capture", kind: "program", resource: "browser", estimateSeconds: 35, input: "Shot", output: "Shot",
      tool: "curation.proof", rules: [`${V}#4.8`, `${R}#component-source.proof`], accept: ["content share ≥ 3%", "not a docs text page"],
      workers: { min: 1, max: 6, initial: 3, policy: "auto" },
      pseudo: "reader's proof page + locate first → stage crop → alternatives → rules\nstage only, letterboxed 16:10",
    }),
    station({
      id: "record", num: "⑩", name: "录屏员", role: "capture", kind: "program", resource: "browser", estimateSeconds: 50, input: "Shot", output: "Video",
      tool: "curation.record", rules: [`${V}#4.8`], accept: ["≥ 4s", "changed frames ≥ 15%", "card ≤ 1.5MB"],
    }),
    station({
      id: "process", num: "⑪", name: "图像处理", role: "process", kind: "program", resource: "cpu", estimateSeconds: 0.8, input: "Shot|Video", output: "ShotSet",
      tool: "curation.process", accept: ["three distinct images (aHash > 6)"],
    }),
    station({
      id: "shot-review", num: "⑫", name: "截图审查员", role: "review", kind: "review", input: "ShotSet", output: "Verdict", prompt: "stations/shot-review.md",
      rules: [`${V}#4.8`], accept: ["a return names the role, the repair and the reason"], estimateSeconds: 20,
      returnTo: [{ station: "identity", maxRounds: 2 }, { station: "breadth", maxRounds: 2 }, { station: "proof", maxRounds: 2 }],
    }),
    station({
      id: "facts", num: "⑬", name: "事实核验员", role: "verify", kind: "agent", input: "PagePlan", output: "Facts",
      rules: [`${V}#2.6`], accept: ["seven facts; every non-unknown value quotes its source verbatim"], estimateSeconds: 18,
      workers: { min: 1, max: 4, initial: 2, policy: "auto" },
      pseudo: "program: repository API + LICENSE + package.json + reader's fact leads\nmodel: seven separate facts with scope; tools for missing pages",
    }),
    station({
      id: "fact-review", num: "⑬'", name: "事实审查员", role: "review", kind: "review", input: "Facts", output: "Verdict",
      accept: ["each fact is supported by its source; problems go straight to the fact checker"], estimateSeconds: 10,
    }),
    station({
      id: "style", num: "⑭", name: "风格判定员", role: "judge", kind: "agent", input: "Verdict", output: "Style", prompt: "stations/style.md",
      rules: [`${V}#2.6.1`], accept: ["program vetoes all pass (recurrence, pixels, evidence words)"], estimateSeconds: 10,
      workers: { min: 1, max: 4, initial: 2, policy: "auto" },
    }),
    station({
      id: "copy", num: "⑮", name: "编辑", role: "write", kind: "agent", input: "Style|Verdict", output: "Copy",
      accept: ["handbook voice, lengths, no unsupported numbers, unknown facts not asserted"], estimateSeconds: 20,
      workers: { min: 1, max: 4, initial: 2, policy: "auto" },
    }),
    station({
      id: "copy-review", num: "⑮'", name: "文案审查员", role: "review", kind: "review", input: "Copy", output: "Verdict",
      accept: ["every claim has evidence; problems go straight to the editor"], estimateSeconds: 15,
    }),
    station({
      id: "assemble", name: "组装", role: "process", kind: "program", resource: "cpu", estimateSeconds: 0.3, input: "Verdict", output: "EntryDraft",
      tool: "curation.assemble", accept: ["VisLexicon v3 schema and taxonomy validators"],
    }),
    station({
      id: "audit", num: "⑯", name: "终审员", role: "review", kind: "review", input: "EntryDraft", output: "Verdict",
      accept: ["every field of the v3 record checked; fixes routed to field owners directly"], estimateSeconds: 20,
    }),
    station({
      id: "gate", num: "⑰", name: "发布闸门", role: "publish", kind: "gate", resource: "none", estimateSeconds: 0.2, input: "Verdict", output: "Entry",
      tool: "curation.gate", accept: ["all reviews passed", "v3 schema valid", "digest bound"],
      pseudo: "missing anything → manual queue, never publish",
    }),
    station({ id: "published", name: "已发布", role: "store", kind: "store", input: "Entry", output: "Entry", blurb: "VisLexicon v3 条目" }),
    station({ id: "manual", name: "待人工", role: "arbiter", kind: "store", input: "*", output: "*", blurb: "超出往来轮数 · 证据不全 · 需站长决定" }),
  ],
  edges: [
    ["dedupe", "scout"],
    ["scout", "reader"], ["scout", "classify"], ["scout", "classify-review"],
    ["classify", "kind-join"], ["classify-review", "kind-join"],
    ["kind-join", "catalog", "agree"], ["kind-join", "arbiter", "disagree"],
    ["arbiter", "catalog", "decided"], ["arbiter", "manual", "undecided"],
    ["reader", "catalog"],
    ["catalog", "plan"],
    ["plan", "identity"], ["plan", "facts"],
    ["identity", "breadth", "shots"], ["identity", "record", "video"], ["identity", "process", "shots"],
    ["breadth", "proof", "needsProof"], ["breadth", "process", "noProof"],
    ["proof", "process"], ["record", "process"],
    ["process", "shot-review"],
    ["facts", "fact-review"],
    ["shot-review", "style"],
    ["style", "copy"], ["fact-review", "copy"],
    ["copy", "copy-review"],
    ["copy-review", "assemble"],
    ["assemble", "audit"],
    ["audit", "gate"],
    ["gate", "published", "complete"], ["gate", "manual", "incomplete"],
  ],
});

/* ------------------------------------------------------------------ layer 3 · other lines (drawn, not wired yet) */

const simple = (id: string, name: string, priority: "high" | "mid" | "low", blurb: string, steps: [string, string, Parameters<typeof station>[0]["role"], Parameters<typeof station>[0]["kind"], string?][]) =>
  line({
    id, name, layer: 3, priority, wired: false, blurb,
    stations: [
      station({ id: "inbox", name: "收件箱", role: "channel", kind: "store", blurb: "等候分流或信道投递" }),
      ...steps.map(([sid, sname, role, kind, sblurb]) => station({ id: sid, name: sname, role, kind, blurb: sblurb, resource: kind === "agent" || kind === "review" ? "model" : "none" })),
      station({ id: "published", name: "已发布", role: "store", kind: "store" }),
    ],
    edges: chain("inbox", ...steps.map((s) => s[0]), "published"),
  });

const components = simple("components", "组件入库线", "mid", "一个已确认的组件源站 → 该站的组件实例（Jev 可检索）。规则全部引用 VisLexicon Spec §4（v5）。", [
  ["adapter", "适配器", "sort", "program", "选用或生成站点适配器"],
  ["discover", "发现", "sort", "program", "sitemap / registry / llms.txt / 侧栏"],
  ["stage", "舞台采集", "capture", "program", "只截舞台 · 浏览器"],
  ["capture-gate", "采集闸门", "review", "gate", "空舞台 / 弹层 / 重复"],
  ["describe", "描述员", "write", "agent", "一次视觉调用"],
  ["quality", "质量门禁与归并", "process", "program", "感知哈希 ≤3 才合并"],
  ["comp-review", "组件审查员", "review", "review", "抽样复核"],
]);
const atlasFeed = simple("atlas-feed", "图鉴反哺线", "low", "新发布的组件实例 → 图鉴每个单元的“真实网站里的这一类”列表。", [
  ["type-map", "类型映射", "sort", "program", "按 vocab.componentTypes"],
  ["aggregate", "聚合", "process", "program", "类型 → 网站集合"],
  ["change-review", "变更审查", "review", "review", "只看新增 / 删除"],
]);
const skills = simple("skills", "Skill / DESIGN.md 线", "mid", "仓库或文件链接 → 原始文件（字节不变）+ 出处、许可、提交号 + 简介。", [
  ["fetch-file", "原样取文件", "sort", "program", "字节不变 · 记提交号"],
  ["provenance", "出处与许可", "verify", "agent", "作者 · 许可 · 状态"],
  ["intro", "简介", "write", "agent", "短介绍，不改写原文"],
  ["skill-review", "审查", "review", "review"],
]);
const sciFigure = simple("sci-figure", "科研绘图线", "mid", "论文图 / 代码仓库 / 教程 → 可复现的绘图资源。", [
  ["reproduce", "复现代码", "process", "program", "跑通才算"],
  ["preview", "真实预览", "capture", "program"],
  ["scenario", "适用场景", "write", "agent"],
  ["fig-review", "审查", "review", "review"],
]);
const ppt = simple("ppt", "PPT 线", "low", "模板 / 原始 deck / Skill → 完整原始文件 + 预览 + 出处。", [
  ["fetch-deck", "取原始文件", "sort", "program"],
  ["deck-preview", "预览", "capture", "program"],
  ["deck-review", "审查", "review", "review"],
]);
const imageFx = simple("image-fx", "图像处理线", "low", "效果 / PSD 操作 → 可调用代码 + 真实前后对比 + 执行限制。", [
  ["fx-code", "可调用代码", "process", "program"],
  ["before-after", "前后对比", "capture", "program"],
  ["limits", "执行限制", "verify", "agent"],
  ["fx-review", "审查", "review", "review"],
]);

/* ------------------------------------------------------------------ pack */

const has = (d: Record<string, unknown>, k: string) => Boolean(d[k]);

export const pack: Pack = {
  id: "vislexicon", name: "VisLexicon 视元", version: "0.2.0",
  blurb: "视元的入库流水线：来源层、候选层与 7 条线。随应用自带的预设包。",
  lines: [sources, candidates, curation, components, atlasFeed, skills, sciFigure, ppt, imageFx],
  channels: [
    { id: "curation.component-source.confirmed", from: { line: "curation", station: "kind-join" }, to: { line: "components", station: "inbox" }, label: "组件源确认" },
    { id: "components.instances.published", from: { line: "components", station: "published" }, to: { line: "atlas-feed", station: "inbox" }, label: "组件实例发布" },
  ],
  links: [
    ...["watch", "github", "x", "xhs", "douyin", "bilibili"].map((s) => ({ from: `sources/${s}`, to: "candidates/tidy", kind: "flow" as const })),
    { from: "candidates/route", to: "curation/dedupe", kind: "flow", when: "website", label: "网站" },
    { from: "candidates/route", to: "skills/inbox", kind: "flow", when: "skill", label: "Skill" },
    { from: "candidates/route", to: "sci-figure/inbox", kind: "flow", when: "figure", label: "绘图" },
    { from: "candidates/route", to: "ppt/inbox", kind: "flow", when: "deck", label: "PPT" },
    { from: "candidates/route", to: "image-fx/inbox", kind: "flow", when: "fx", label: "图像处理" },
  ],
  resources: { browser: 8, model: 8, cpu: 4, http: 6 },
  conditions: {
    website: (d) => (d.route ?? "curation") === "curation",
    skill: (d) => d.route === "skills",
    figure: (d) => d.route === "sci-figure",
    deck: (d) => d.route === "ppt",
    fx: (d) => d.route === "image-fx",
    agree: (d) => d.kindAgreed === true,
    disagree: (d) => d.kindAgreed === false,
    decided: (d) => typeof d.kind === "string" && d.kind !== "",
    undecided: (d) => !(typeof d.kind === "string" && d.kind !== ""),
    shots: (d) => d.mode !== "video",
    video: (d) => d.mode === "video",
    needsProof: (d) => has(d, "needsProof"),
    noProof: (d) => d.mode !== "video" && !has(d, "needsProof"),
    complete: (d) => d.gate === "pass",
    incomplete: (d) => d.gate !== "pass",
  },
  order: ["sources", "candidates", "curation", "components", "atlas-feed", "skills", "sci-figure", "ppt", "image-fx"],
  collapsed: ["components", "atlas-feed", "skills", "sci-figure", "ppt", "image-fx"],
  hints: {
    sources: {
      mode: "stack",
      phases: [
        { name: "来源接入", stations: ["watch", "github", "x", "xhs", "douyin", "bilibili"] },
      ],
    },
    candidates: {
      mode: "layered",
      grid: { tidy: [-2.25, 0], pool: [-2.25, 1], route: [-1.25, 1] },
      phases: [
        { name: "候选与分流", stations: ["tidy", "pool", "route"] },
      ],
    },
    curation: {
      mode: "layered",
      grid: {
        dedupe: [0, 1], scout: [1, 1], reader: [2, 0], classify: [2, 1], "classify-review": [2, 2], "kind-join": [3, 1.5], arbiter: [3, 2.5], catalog: [4, 1],
        plan: [5.5, 1], identity: [6.5, 1], record: [7.5, 0], breadth: [7.5, 2], proof: [8.5, 2], process: [8.5, 1], "shot-review": [9.5, 1],
        facts: [11, 3], "fact-review": [12, 3], style: [11, 1], copy: [13, 2], "copy-review": [14, 2],
        assemble: [15.5, 2], audit: [16.5, 2], gate: [17.5, 2], published: [18.5, 1.5], manual: [18.5, 2.5],
      },
      focus: ["scout", "reader", "classify", "classify-review", "kind-join", "arbiter", "catalog", "plan", "identity", "breadth", "proof", "process", "shot-review"],
      wrap: 99,
      side: ["curation/arbiter->curation/manual"],
      phases: [
        { name: "读懂与判定", stations: ["dedupe", "scout", "reader", "classify", "classify-review", "kind-join", "arbiter", "catalog"] },
        { name: "资源采集", stations: ["plan", "identity", "breadth", "proof", "record", "process", "shot-review"] },
        { name: "核验与著录", stations: ["facts", "fact-review", "style", "copy", "copy-review"] },
        { name: "终审与发布", stations: ["assemble", "audit", "gate", "published", "manual"] },
      ],
    },
  },
};
