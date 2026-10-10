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
      id: "tidy", name: "候选准备", role: "candidate", kind: "program", resource: "none", estimateSeconds: 0.1, input: "RawItem", output: "TidyItem",
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

/* ------------------------------------------------------------------ layer 3 · curation (17 stations) */

const curation = line({
  id: "curation", name: "策展线", layer: 3, priority: "high", wired: true,
  blurb: "输入网址，输出一条可发布的网站条目：分类、三张证据图或一段录屏、风格、事实、中文文案、审查记录。",
  stations: [
    station({
      id: "dedupe", num: "①", name: "分拣去重", role: "sort", kind: "program", resource: "none", estimateSeconds: 0.1, input: "Candidate", output: "Site",
      tool: "curation.dedupe", accept: ["duplicates get a disposition record"],
      pseudo: "canonical = normalize(url)\nif canonical in published or in flight → merged (with disposition)",
    }),
    station({
      id: "fetch", num: "②", name: "首页抓取", role: "sort", kind: "program", resource: "http", estimateSeconds: 2.5, input: "Site", output: "HomeFacts",
      tool: "curation.fetch", accept: ["2xx or leaves the line with a reason"],
      pseudo: "GET canonical (20s) → {status, finalUrl, title, description, navLinks[], textSample}\nHTTP only, no browser",
      workers: { min: 1, max: 4, initial: 2, policy: "auto" },
    }),
    station({
      id: "classify", num: "③", name: "分类员", role: "judge", kind: "agent", input: "HomeFacts", output: "Kind", prompt: "stations/classify.md",
      rules: [`${V}#2.3`, `${V}#2.4`], accept: ["every answer quotes the page"], estimateSeconds: 5,
      workers: { min: 1, max: 4, initial: 2, policy: "auto" },
      pseudo: "ask the seven questions top-down; stop at the first yes\nanswers[] carry a quote from textSample",
    }),
    station({
      id: "classify-review", num: "④", name: "分类复核员", role: "review", kind: "review", input: "Kind", output: "Kind", prompt: "stations/classify.md",
      rules: [`${V}#2.4`], accept: ["agrees with ③ or goes to the arbiter"], estimateSeconds: 5,
      pseudo: "same input as ③ but never sees ③'s reasoning\nagree → plan; disagree → arbiter",
    }),
    station({
      id: "arbiter", name: "仲裁", role: "arbiter", kind: "agent", input: "Kind", output: "Kind", prompt: "stations/arbiter.md", estimateSeconds: 6,
      rules: [`${V}#2.4`], accept: ["picks one of the two answers with a quote, or hands over"], workers: { min: 1, max: 2, initial: 1, policy: "auto" },
      pseudo: "sees both answers and their quotes; picks one or sends to a human",
    }),
    station({
      id: "plan", num: "⑤", name: "选页规划员", role: "sort", kind: "program", resource: "none", estimateSeconds: 0.2, input: "Kind", output: "PagePlan",
      tool: "curation.plan", rules: [`${V}#4.8`, R], accept: ["mode chosen by rule, not by model"],
      pseudo: "rules = preview-rules.kinds[kind]\nrank breadth candidates from navLinks (path +3, text +2, nav +1)\nmode = video when kind says so",
    }),
    station({
      id: "identity", num: "⑥", name: "首屏摄影", role: "capture", kind: "program", resource: "browser", estimateSeconds: 10, input: "PagePlan", output: "Shot",
      tool: "curation.identity", rules: [`${R}#reject`], accept: ["no flat block", "no overlay", "not blank"],
      pseudo: "open home 1280×800 · settle · decline cookies (never accept) · hide floating\nshot viewport; detect motion-first (scroll hijacked / canvas hero)",
    }),
    station({
      id: "breadth", num: "⑦", name: "目录摄影", role: "capture", kind: "program", resource: "browser", estimateSeconds: 15, input: "Shot", output: "Shot",
      tool: "curation.breadth", rules: [`${R}#kinds.*.roles.breadth`], accept: ["second hop when a better page appears"],
    }),
    station({
      id: "proof", num: "⑧", name: "组件特写摄影", role: "capture", kind: "program", resource: "browser", estimateSeconds: 60, input: "Shot", output: "Shot",
      tool: "curation.proof", rules: [`${V}#4.8`, `${R}#component-source.proof`], accept: ["content share ≥ 3%", "not a docs text page"],
      workers: { min: 1, max: 3, initial: 2, policy: "auto" },
      pseudo: "for url in candidates[0..6]:\n  open · find stage (largest painted preview) · iframe must render\n  crop stage + 16px, letterbox 16:10 with border colour\nkeep the highest non-background share",
    }),
    station({
      id: "record", num: "⑨", name: "录屏员", role: "capture", kind: "program", resource: "browser", estimateSeconds: 50, input: "Shot", output: "Video",
      tool: "curation.record", rules: [`${V}#4.8`], accept: ["≥ 4s", "changed frames ≥ 15%", "card ≤ 1.5MB"],
      pseudo: "real wheel events 120px / 140ms · stop at bottom or 2.5s still · cap 16s\nffmpeg → mp4 + card mp4 + posters",
    }),
    station({
      id: "process", num: "⑩", name: "图像处理", role: "process", kind: "program", resource: "cpu", estimateSeconds: 0.8, input: "Shot|Video", output: "ShotSet",
      tool: "curation.process", accept: ["three distinct images (aHash > 6)"],
      pseudo: "png → webp 1280 + card webp 720 · sha256 · aHash\nPNG is not kept (VisLexicon decision 2026-10-09)",
    }),
    station({
      id: "shot-review", num: "⑪", name: "截图审查员", role: "review", kind: "review", input: "ShotSet", output: "Verdict", prompt: "stations/shot-review.md",
      rules: [`${V}#4.8`], accept: ["a return names the station and the reason"], estimateSeconds: 7,
      returnTo: [{ station: "identity", maxRounds: 2 }, { station: "breadth", maxRounds: 2 }, { station: "proof", maxRounds: 2 }],
    }),
    station({
      id: "style", num: "⑫", name: "风格判定员", role: "judge", kind: "agent", input: "Verdict", output: "Style", prompt: "stations/style.md",
      rules: [`${V}#2.6.1`], accept: ["program vetoes all pass (recurrence, pixels, evidence words)"], estimateSeconds: 6,
      workers: { min: 1, max: 4, initial: 2, policy: "auto" },
    }),
    station({
      id: "facts", num: "⑬", name: "事实核验员", role: "verify", kind: "agent", input: "Verdict", output: "Facts", prompt: "stations/facts.md",
      rules: [`${V}#2.7`], accept: ["every non-unknown value has a source URL"], estimateSeconds: 8,
      pseudo: "fetch pricing / license / repo pages (HTTP)\nfour separate facts: price, sourceCode, license, commercial — missing = unknown",
    }),
    station({
      id: "copy", num: "⑭", name: "文案员", role: "write", kind: "agent", input: "Style|Facts", output: "Copy", prompt: "stations/copy.md",
      accept: ["length and banned words"], estimateSeconds: 6,
    }),
    station({
      id: "fact-review", num: "⑮", name: "事实审查员", role: "review", kind: "review", input: "Facts", output: "Verdict", prompt: "stations/fact-review.md",
      returnTo: [{ station: "facts", maxRounds: 2 }], accept: ["each fact is supported by its source excerpt"], estimateSeconds: 5,
    }),
    station({
      id: "copy-review", num: "⑯", name: "文案审查员", role: "review", kind: "review", input: "Copy", output: "Verdict", prompt: "stations/copy-review.md",
      returnTo: [{ station: "copy", maxRounds: 2 }], accept: ["every claim in the copy has evidence"], estimateSeconds: 5,
    }),
    station({
      id: "gate", num: "⑰", name: "发布闸门", role: "publish", kind: "gate", resource: "none", estimateSeconds: 0.1, input: "Verdict", output: "Entry",
      tool: "curation.gate", accept: ["three shots or one recording", "④⑪⑮⑯ passed", "reviews bound to content digest"],
      pseudo: "missing anything → manual queue, never publish",
    }),
    station({ id: "published", name: "已发布", role: "store", kind: "store", input: "Entry", output: "Entry", blurb: "VisLexicon 网站条目" }),
    station({ id: "manual", name: "待人工", role: "arbiter", kind: "store", input: "*", output: "*", blurb: "超出退回轮数 · 证据不全" }),
  ],
  edges: [
    ...chain("dedupe", "fetch", "classify", "classify-review"),
    ["classify-review", "plan", "agree"],
    ["classify-review", "arbiter", "disagree"],
    ["arbiter", "plan", "decided"],
    ["arbiter", "manual", "undecided"],
    ["plan", "identity"],
    ["identity", "breadth", "shots"],
    ["identity", "record", "video"],
    ["breadth", "proof", "needsProof"],
    ["identity", "process", "shots"],
    ["breadth", "process", "noProof"],
    ["proof", "process"],
    ["record", "process"],
    ["process", "shot-review"],
    ["shot-review", "style"],
    ["shot-review", "facts"],
    ["style", "copy"],
    ["facts", "copy"],
    ["facts", "fact-review"],
    ["copy", "copy-review"],
    ["fact-review", "gate"],
    ["copy-review", "gate"],
    ["gate", "published", "complete"],
    ["gate", "manual", "incomplete"],
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
  id: "vislexicon", name: "VisLexicon 视元", version: "0.1.0",
  blurb: "视元的入库流水线：来源层、候选层与 7 条线。随应用自带的预设包。",
  lines: [sources, candidates, curation, components, atlasFeed, skills, sciFigure, ppt, imageFx],
  channels: [
    { id: "curation.component-source.confirmed", from: { line: "curation", station: "classify-review" }, to: { line: "components", station: "inbox" }, label: "组件源确认" },
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
  resources: { browser: 3, model: 8, cpu: 4, http: 6 },
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
        dedupe: [0, 1], fetch: [1, 1], classify: [2, 1], "classify-review": [3, 1], arbiter: [3, 2],
        plan: [4.5, 1], identity: [4.5, 2], record: [5.5, 1], breadth: [5.5, 3], proof: [6.5, 3],
        process: [6.5, 2], "shot-review": [6.5, 1],
        style: [8, 1.5], facts: [8, 2.5], copy: [9, 1.5], "fact-review": [9, 2.5], "copy-review": [10, 1.5],
        gate: [11.5, 1.5], published: [12.5, 1], manual: [12.5, 2],
      },
      focus: ["classify-review", "arbiter", "plan", "identity", "record", "breadth", "proof", "process", "shot-review"],
      wrap: 99,
      side: ["curation/arbiter->curation/manual"],
      phases: [
        { name: "分类校验", stations: ["dedupe", "fetch", "classify", "classify-review", "arbiter"] },
        { name: "资源采集", stations: ["plan", "identity", "breadth", "proof", "record", "process", "shot-review"] },
        { name: "内容生成", stations: ["style", "facts", "copy", "fact-review", "copy-review"] },
        { name: "发布管理", stations: ["gate", "published", "manual"] },
      ],
    },
  },
};
