// The agent document layer (Spec §31, §33): ROLE.md is the stable handbook in the pack;
// CONTEXT.md (per node) and CASE.md (per item) are rendered by the program from the
// journal projection, so weak models can append through tools but never break the
// format. envelope() composes what every agent reads before it works — the same text
// whether the agent is pi (system prompt) or a closed agent (first message).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { CompiledFactory, CompiledNode, Stamped } from "../shared/types.ts";
import type { FactoryState } from "../shared/project.ts";
import { apply, initialState, median } from "../shared/project.ts";
import { failureLabels } from "../shared/failures.ts";
import { readRole } from "./roles.ts";
import { digest, projectPaths } from "./workspace.ts";
import { piSelection } from "./pi.ts";
import type { Journal } from "./journal.ts";
import { redactText } from "./mcp-security.ts";

const time = (ms: number) => new Date(ms).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
// Preserve ordinary existing item folders. The reserved ~ prefix prevents unsafe
// IDs, Windows aliases and case-insensitive names from colliding with ordinary IDs.
const segment = (s: string) => /^[a-z0-9][a-z0-9._-]{0,99}$/.test(s) && !s.endsWith(".") && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s) ? s : `~${hash(s)}`;
type Host = { state: FactoryState; compiled: CompiledFactory; journal: Pick<Journal, "read"> };
export type CaseScope = { token: string; attempt: string };
type Of<K extends Stamped["kind"]> = Extract<Stamped, { kind: K }>;
const of = <K extends Stamped["kind"]>(events: Stamped[], kind: K) => events.filter((e): e is Of<K> => e.kind === kind);
const stamp = (e: Stamped) => ({ seq: e.seq, at: e.at, runId: e.run || null });
const credentialKey = /^(?:authorization|proxy[-_]?authorization|headers?|cookies?|set[-_]?cookie|password|passwd|secret|credentials?|auth|api[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?id|endpoint|cdp(?:[-_]?endpoint)?|browser[-_]?endpoint|webSocketDebuggerUrl)$/i;

/** Redact credentials at the document boundary, including echoes in free text.
 * Task token/attempt IDs are provenance; token fields inside payloads are secrets. */
function caseRedactor(events: Stamped[]) {
  const secrets = Object.entries(process.env).filter(([key, value]) => value && value.length >= 4 && /(?:TOKEN|PASSWORD|SECRET|API_?KEY|COOKIE|CDP)/i.test(key)).map(([, value]) => value!);
  const collect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if ((credentialKey.test(key) || /^token$/i.test(key)) && typeof child === "string" && child.length >= 4) secrets.push(child);
      else collect(child);
    }
  };
  for (const e of events) {
    if (e.kind === "token.data") collect(e.patch);
    if (e.kind === "attempt.finished") collect(e.output);
    if (e.kind === "evidence.added") collect(e.evidence.meta);
  }
  const text = (value: string) => redactText(value, secrets)
    .replace(/\b(?:wss?):\/\/[^\s<>"']+/gi, "[redacted endpoint]")
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        let changed = false;
        if (url.username || url.password) { url.username = ""; url.password = ""; changed = true; }
        for (const key of [...url.searchParams.keys()]) if (credentialKey.test(key) || /^(?:token|key|signature|sig)$/i.test(key)) { url.searchParams.set(key, "[redacted]"); changed = true; }
        return changed ? url.href : raw;
      } catch { return raw; }
    })
    .replace(/\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*[:=]\s*[^\r\n]+/gi, "[redacted credentials]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "[redacted credentials]")
    .replace(/\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|cdp(?:[-_]?endpoint)?)\b["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, "[redacted credentials]");
  const value = (v: unknown, payload = false): unknown => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map((child) => value(child, payload));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([key, child]) => [text(key), credentialKey.test(key) || (payload && /^token$/i.test(key)) ? "[redacted]" : value(child, payload || ["data", "patch", "output", "meta"].includes(key))]));
    return v;
  };
  return value;
}

const artifactGroups = [
  ["侦察卷宗", ["dossier", "home", "candidate"]],
  ["站点理解与拍摄单", ["understanding", "readerPlan", "factLeads"]],
  ["分类及理由", ["kind", "kindAgreed", "kind1", "kind2", "classification", "catalogV3", "reviews"]],
  ["拍摄与选择理由", ["shots", "images", "video", "mode", "breadthCandidates", "shotRepairs"]],
  ["事实与出处", ["facts", "factPages", "pricingNote"]],
  ["风格与文案", ["style", "copy", "draftV3"]],
] as const;

function unresolved(s: FactoryState, tokenIds: Set<string>) {
  const issues: { token: string; field: string; reason: string; status: "unknown" | "unresolved" }[] = [];
  for (const id of tokenIds) {
    const t = s.tokens[id];
    if (!t) continue;
    if (["parked", "failed", "manual"].includes(t.status)) issues.push({ token: id, field: "status", reason: t.reason ?? "未记录原因", status: "unresolved" });
    for (const key of ["readerBlockers", "factConflicts", "manualReason", "needsPick"]) {
      const v = t.data[key];
      if (v && (!Array.isArray(v) || v.length)) issues.push({ token: id, field: key, reason: typeof v === "string" ? v : JSON.stringify(v), status: "unresolved" });
    }
    const facts = t.data.facts;
    if (facts && typeof facts === "object") for (const [key, value] of Object.entries(facts)) {
      const fact = value as { field?: string; value?: unknown; sourceUrl?: string; evidence?: string; quote?: string } | null;
      if (!fact || typeof fact !== "object") continue;
      const field = `facts.${fact.field ?? key}`;
      if (fact.value == null || /^(?:unknown|未知|未确认|)$/i.test(String(fact.value).trim())) issues.push({ token: id, field, reason: "事实值未知；保留原始未确认状态", status: "unknown" });
      else if (!fact.sourceUrl || !(fact.evidence || fact.quote)) issues.push({ token: id, field, reason: "已记录声明，但缺少出处或证据；不能视为已核实", status: "unknown" });
    }
  }
  for (const c of Object.values(s.consults)) if (tokenIds.has(c.token) && c.outcome !== "resolved") issues.push({ token: c.token, field: c.fields.join(", "), reason: `${c.problem}（${c.outcome === "manual" ? "已转人工" : "尚未闭环"}）`, status: "unresolved" });
  return issues;
}

/** A run snapshot is built before applying any later run's events. No successful
 * retry can rewrite a failure, missing evidence or review result in this snapshot. */
function caseRun(s: FactoryState, events: Stamped[], prior: Stamped[], run: { id: string; title: string | null; startedAt: number | null; endedAt: number | null; status: string }, current: boolean) {
  const tokenIds = new Set(events.flatMap((e) => "token" in e && typeof e.token === "string" ? [e.token] : e.kind === "evidence.added" ? [e.evidence.token] : e.kind === "candidate.disposition" ? [e.candidate.token] : "attempt" in e && s.attempts[e.attempt] ? [s.attempts[e.attempt].token] : []));
  const starts = of(prior, "attempt.started"), created = of(prior, "token.created");
  const ids = new Set(events.flatMap((e) => "attempt" in e ? [e.attempt] : []));
  const attempts = [...ids].map((id) => {
    const a = s.attempts[id], start = starts.find((e) => e.attempt === id);
    const result = of(events, "attempt.finished").findLast((e) => e.attempt === id);
    return {
      id, token: a?.token ?? null, station: a?.node ?? null, startedSeq: start?.seq ?? null, startedInRun: start?.run || null,
      startedAt: a?.startedAt ?? null, endedAt: result?.at ?? null,
      input: a?.input ?? null, status: result ? result.cancelled || result.error === "stale" ? "cancelled" : a?.ok ? "completed" : "failed" : a?.endedAt ? "completed" : "running",
      actions: of(events, "attempt.progress").filter((e) => e.attempt === id).map((e) => ({ ...stamp(e), text: e.text, tool: e.step?.tool ?? null, detail: e.step?.text ?? null, ok: e.step?.ok ?? null, evidence: e.step?.evidence ?? [] })),
      result: result ? { ...stamp(result), ok: a?.ok ?? result.ok, summary: result.summary, error: result.error ?? null, output: result.output ?? null } : null,
      evidence: of(prior, "evidence.added").filter((e) => e.evidence.attempt === id).map((e) => e.evidence.id),
    };
  }).sort((a, b) => (a.startedSeq ?? Infinity) - (b.startedSeq ?? Infinity));
  return {
    ...run, current, firstSeq: events[0]?.seq ?? null, lastSeq: events.at(-1)?.seq ?? null,
    stationOrder: attempts.map((a) => ({ station: a.station, attempt: a.id, token: a.token, seq: a.startedSeq })),
    tokens: [...tokenIds].map((id) => {
      const t = s.tokens[id], origin = created.find((e) => e.token === id);
      return {
        id, createdInRun: origin?.run || null, createdAt: origin?.at ?? null,
        title: t?.title ?? null, url: t?.url ?? null, source: t?.source ?? null, status: t?.status ?? "unknown", at: [...t?.at ?? []], reason: t?.reason ?? null,
        data: structuredClone(t?.data ?? {}),
        dataChanges: of(events, "token.data").filter((e) => e.token === id).map((e) => ({ ...stamp(e), patch: e.patch })),
      };
    }),
    attempts,
    notes: of(events, "case.noted").map((e) => ({ ...stamp(e), token: e.token, ...e.note })),
    evidence: of(events, "evidence.added").map((e) => ({ ...e.evidence, ...stamp(e) })),
    decisions: events.filter((e) => ["review.verdict", "token.finished", "candidate.disposition"].includes(e.kind)),
    returns: of(events, "token.returned"), corrections: of(events, "correction.created"),
    consultations: events.filter((e) => ["consult.opened", "consult.replied", "consult.closed"].includes(e.kind)),
    unresolved: unresolved(s, tokenIds),
  };
}

export const CONTEXT_HEADER = "> 这份 CONTEXT.md 由 Easy Workflow 程序维护，每完成一次处理自动重写，段名和顺序固定。你不能直接改写它；要留笔记或报告问题，调用 env_call(\"context_note\", {kind, text})。版本信息只看这里，ROLE.md 不记版本。最新的条目在每段最上面。";
export const CASE_HEADER = "> 这份案卷随这件货走，所有工位共用。开始工作前读完它，完成后调用 env_call(\"case_note\", {section, text}) 给后面的人留一段交接笔记：你确认了什么、拿不准什么、提醒谁注意什么。案卷由程序按时间渲染，不要直接改写，也不要复述别人已经写过的内容。";

export class Docs {
  dir: string;
  name: string;
  private timers = new Map<string, NodeJS.Timeout>();
  private f: Host;
  private readOnly: boolean;
  private indexedSeq = 0;
  private caseEvents = new Map<string, Stamped[]>();
  private tokenCases = new Map<string, string>();
  private attemptTokens = new Map<string, string>();
  private runs = new Map<string, { id: string; title: string | null; startedAt: number | null; endedAt: number | null; status: string }>();
  private currentRun = "";
  private runSeq = 0;
  private lessons?: { pendingContext(station: string): string; validationContext(station: string, item: string, scope: CaseScope): string };
  constructor(f: Host, dir: string, name: string, options: { readOnly?: boolean } = {}) {
    this.f = f; this.dir = dir; this.name = name; this.readOnly = options.readOnly ?? process.env.FACTORY_READONLY === "1";
  }

  setLessons(source: { pendingContext(station: string): string; validationContext(station: string, item: string, scope: CaseScope): string }) { this.lessons = source; }

  private node(key: string) { return this.f.compiled.nodes.find((n) => n.key === key); }

  /* ---------------------------------------------------------------- CONTEXT.md */

  contextFile(key: string) {
    // Historical/removed stations still have context and lessons. Validate the
    // identifier independently of the currently compiled graph.
    if (!/^(dispatcher|[a-z0-9-]+\/[a-z0-9-]+)$/.test(key)) throw new Error("Unknown context station path");
    return path.join(projectPaths(this.dir).context, ...key.split("/").map(segment), "CONTEXT.md");
  }

  renderContext(key: string): string {
    const s = this.f.state, n = this.node(key), st = s.nodes[key];
    const name = key === "dispatcher" ? "主调度" : n?.name ?? key;
    let role = "（缺少 ROLE.md）";
    try { const r = readRole(key); role = `${r.path} @ ${r.revision}`; } catch { /* reported below */ }
    const isAgent = key === 'dispatcher' || n?.kind === 'agent' || n?.kind === 'review';
    const closed = key !== 'dispatcher' && Boolean(process.env.FACTORY_STATION_COMMAND);
    const executionLabel = (label: string) => caseRedactor([])(label) as string;
    const model = isAgent ? closed
      ? `closed-command · ${executionLabel(process.env.FACTORY_STATION_MODEL?.trim() || '未配置请求模型')}（请求配置，实际以回执为准）`
      : `pi · ${piSelection().id}（当前配置）`
      : n?.kind === 'store' ? '资源库（不执行）' : '程序执行';
    const notes = [...(s.contextNotes?.[key] ?? [])].reverse();
    const list = (kind: string, max: number) => notes.filter((x) => x.kind === kind).slice(0, max).map((x) => `- ${time(x.at)} · ${x.by}：${x.text}`).join("\n") || "- （无）";
    const attempts = Object.values(s.attempts).filter((a) => a.node === key && a.endedAt).sort((a, b) => b.endedAt! - a.endedAt!).slice(0, 8);
    const actual = isAgent ? attempts[0]?.metrics?.execution : undefined;
    const lastExecution = actual ? `- 最近执行回执：${executionLabel(actual.adapter)} · ${actual.model === 'unreported' ? '模型未回报' : executionLabel(actual.model)}` : '';
    const handoffs = attempts.map((a) => `- ${time(a.endedAt!)} · ${s.tokens[a.token]?.title || s.tokens[a.token]?.item || a.token} · ${a.cancelled ? "已取消" : a.ok ? "完成" : "失败"} · ${clip(a.ok ? a.summary ?? "" : a.error ?? a.summary ?? "", 120)}`).join("\n") || "- （本项目还没有处理记录）";
    const failures = Object.values(s.recoveries ?? {}).filter((c) => c.failure && s.tokens[c.token]?.finishedAtNode === key && c.disposition === "retry").slice(0, 6)
      .map((c) => `- ${c.title}：${failureLabels[c.failure!.tag]}——${clip(c.failure!.nextAction ?? c.failure!.message, 100)}`);
    const issues = [list("issue", 6), ...failures].filter((x) => x !== "- （无）").join("\n") || "- （无）";
    const run = s.run.id ? `${s.run.id}（${s.run.status}）` : "尚未开始";
    const progress = st ? `- 本轮 ${run}：处理 ${st.processed}，失败 ${st.failed}，退回 ${st.returned}，队列 ${st.queue.length}，在做 ${st.active.length}，中位耗时 ${(median(st.durations) / 1000).toFixed(1)}s` : `- 本轮 ${run}`;
    return [
      `# ${name} · CONTEXT`, "", CONTEXT_HEADER, "",
      "## 版本", `- 角色：${role}`, `- 执行：${model}`, ...(lastExecution ? [lastExecution] : []), `- 规格：${this.f.compiled.specVersion} · ${this.f.compiled.digest.slice(0, 12)}`, `- 项目：${this.name}（${this.dir}）`, "",
      "## 本轮进度", progress, "",
      "## 站长 / 主调度指示", list("instruction", 6), "",
      "## 最近交接", handoffs, "",
      "## 待解决问题", issues, "",
      "## 工作笔记", list("note", 8), "",
      "## 待批准的经验", [list("lesson", 6), this.lessons?.pendingContext(key)].filter((text) => text && text !== "- （无）").join("\n") || "- （无）", "",
    ].join("\n");
  }

  /** Short form for envelopes: version, progress, instructions, issues. */
  contextBrief(key: string, max = 1600) {
    const full = this.renderContext(key);
    const keep = ["## 版本", "## 本轮进度", "## 站长 / 主调度指示", "## 待解决问题"];
    const parts = full.split(/\n(?=## )/).filter((p) => keep.some((k) => p.startsWith(k)));
    return clip(parts.join("\n"), max);
  }

  /* ---------------------------------------------------------------- CASE.md */

  caseFile(caseId: string) { return path.join(projectPaths(this.dir).cases, segment(caseId), "CASE.md"); }
  caseJsonFile(caseId: string) { return path.join(path.dirname(this.caseFile(caseId)), "case.json"); }

  /** Index only new journal rows. Progress never reads or writes a file synchronously
   * in the event listener; batched writes and envelopes consume this small tail. */
  private refresh() {
    for (const e of this.f.journal.read(this.indexedSeq)) {
      this.indexedSeq = e.seq;
      if (e.kind.startsWith("run.")) {
        this.runSeq = e.seq;
        const id = e.run;
        const run = this.runs.get(id) ?? { id, title: null, startedAt: null, endedAt: null, status: "unknown" };
        if (e.kind === "run.started") { this.currentRun = e.runId; run.title = e.title; run.startedAt = e.at; run.status = "running"; }
        if (e.kind === "run.paused") run.status = "paused";
        if (e.kind === "run.resumed") run.status = "running";
        if (e.kind === "run.ended") { run.status = "ended"; run.endedAt = e.at; }
        this.runs.set(id, run);
      }
      if (e.kind === "token.created") this.tokenCases.set(e.token, e.item);
      if (e.kind === "attempt.started") this.attemptTokens.set(e.attempt, e.token);
      const token = "token" in e && typeof e.token === "string" ? e.token : e.kind === "evidence.added" ? e.evidence.token : e.kind === "candidate.disposition" ? e.candidate.token : "attempt" in e ? this.attemptTokens.get(e.attempt) : undefined;
      const item = e.kind === "case.noted" ? e.caseId : e.kind === "candidate.disposition" ? this.tokenCases.get(e.candidate.token) ?? e.candidate.item : token ? this.tokenCases.get(token) : undefined;
      // Activity spans and channel dispatch are not case findings. Keep the full
      // progress stream here, unlike the intentionally capped UI state projection.
      if (item !== undefined && e.kind !== "attempt.activity" && e.kind !== "channel.emitted") {
        const list = this.caseEvents.get(item) ?? [];
        list.push(e); this.caseEvents.set(item, list);
      }
    }
  }

  caseIds() { this.refresh(); return [...this.caseEvents.keys()]; }

  caseData(caseId: string) {
    this.refresh();
    const events = this.caseEvents.get(caseId) ?? [], state = initialState(this.f.compiled);
    // Item IDs and old journal identifiers are data, including names such as
    // __proto__. Use dictionaries without inherited properties during replay.
    for (const key of ["tokens", "attempts", "nodes", "evidence", "cases", "consults", "recoveries"] as const) Object.setPrototypeOf(state[key], null);
    const groups = new Map<string, Stamped[]>();
    for (const e of events) { const list = groups.get(e.run) ?? []; list.push(e); groups.set(e.run, list); }
    const prior: Stamped[] = [], runs: ReturnType<typeof caseRun>[] = [];
    for (const [id, group] of groups) {
      for (const e of group) {
        apply(state, e);
        if (e.kind === "token.created") Object.setPrototypeOf(state.tokens[e.token].data, null);
        prior.push(e);
      }
      const run = this.runs.get(id) ?? { id, title: null, startedAt: null, endedAt: null, status: "unknown" };
      runs.push(caseRun(state, group, prior, run, Boolean(this.currentRun) && id === this.currentRun));
    }
    const value = {
      schemaVersion: 1 as const, caseId, currentRunId: this.currentRun || null,
      journal: { source: "journal.db", throughSeq: Math.max(events.at(-1)?.seq ?? 0, this.runSeq) },
      latest: runs.length ? { runId: runs.at(-1)!.id || null, token: runs.at(-1)!.tokens.at(-1)?.id ?? null } : null,
      runs,
    };
    const clean = caseRedactor(events)(value) as typeof value;
    return { ...clean, digest: hash(JSON.stringify(clean)) };
  }

  renderCase(caseId: string): string { return this.caseMarkdown(this.caseData(caseId)); }

  private caseMarkdown(doc: ReturnType<Docs["caseData"]>): string {
    const latestRun = doc.runs.at(-1), t = latestRun?.tokens.at(-1);
    const lines = [
      `# 案卷 · ${t?.title || doc.caseId}`, "", CASE_HEADER, "",
      `> journal.db #${doc.journal.throughSeq} · case.json 案卷快照摘要 ${doc.digest}。null / 未记录表示未知，不能补作已核实事实。`, "",
      "## 概况", `- 条目：${doc.caseId}`, `- 网址：${t?.data.canonical ?? t?.url ?? "未记录"}`, `- 来源：${t?.source ?? "未记录"}`,
      `- 项目当前轮次：${doc.currentRunId ?? "尚未开始"}`,
      `- 本件最近轮次：${latestRun?.id || "未记录"}（${latestRun?.current ? "当前轮次" : "历史轮次"}）`,
      `- 最近状态：${t?.status ?? "未开始"}${t?.reason ? ` · ${t.reason}` : ""}`,
      `- 本轮记录：${doc.runs.some((r) => r.current) ? "见本轮段落" : "本件尚未参与项目当前轮次；下方保留历史"}`, "",
      "## 交接记录（按时间）",
    ];
    if (!doc.runs.length) lines.push("（还没有）");
    const json = (v: unknown) => JSON.stringify(v, null, 2).split("\n").map((line) => `    ${line}`).join("\n");
    for (const run of doc.runs) {
      lines.push("", `### ${run.current ? "当前轮次" : "历史轮次"} · ${run.id || "轮次未知"} · ${run.title ?? "未记录标题"}（${run.status}）`);
      for (const task of run.tokens) {
        lines.push("", `#### 累积产物 · ${task.id}`, "", "以下是该轮结束位置的资料快照；沿用的旧资料不算本轮重新核验。case.json 的 dataChanges 保留本轮逐次修改及事件序号。");
        for (const [label, keys] of artifactGroups) {
          const fields = Object.fromEntries(keys.filter((key) => key in task.data).map((key) => [key, task.data[key]]));
          lines.push("", `##### ${label}`, Object.keys(fields).length ? json(fields) : "（未记录；未知）");
        }
      }
      lines.push("", "#### 工位过程（按开始事件顺序；并行工位不表示依赖）");
      for (const a of run.attempts) {
        lines.push(`- #${a.startedSeq ?? "?"} ${a.station ? this.node(a.station)?.name ?? a.station : "工位未知"} · ${a.id} · 任务 ${a.token ?? "未知"} · ${a.status}`);
        for (const action of a.actions) lines.push(`  - #${action.seq} ${action.tool ? `[${action.tool}] ` : ""}${action.text}${action.detail && action.detail !== action.text ? `；${action.detail}` : ""}${action.evidence.length ? `（证据 ${action.evidence.join("、")}）` : ""}`);
        if (a.result) lines.push(`  - 结果：${a.result.summary}${a.result.error ? `；错误：${a.result.error}` : ""}`);
      }
      if (!run.attempts.length) lines.push("（未记录工位执行）");
      lines.push("", "#### 工位交接");
      for (const note of run.notes) lines.push(`- #${note.seq} ${time(note.at)} · ${this.node(note.station)?.name ?? note.station} · ${note.section} · 任务 ${note.token}\n${note.text}`);
      if (!run.notes.length) lines.push("（还没有）");
      lines.push("", "#### 审核往来");
      for (const e of run.consultations) {
        if (e.kind === "consult.opened") lines.push(`- #${e.seq} ${e.reviewer} → ${e.owner}（第 ${e.round} 轮，字段 ${e.fields.join("、")}，${e.consult}）：${e.problem}`);
        if (e.kind === "consult.replied") lines.push(`- #${e.seq} ${e.consult} · ${e.owner} 回复（${e.ok ? "处理完成，待复查" : "未完成"}）：${e.reply}`);
        if (e.kind === "consult.closed") lines.push(`- #${e.seq} ${e.consult} · ${e.outcome === "resolved" ? "已解决" : "转人工"}：${e.reason}`);
      }
      if (!run.consultations.length) lines.push("（还没有）");
      lines.push("", "#### 决定、退回与修复");
      const decisions = [...run.decisions, ...run.returns, ...run.corrections].sort((a, b) => a.seq - b.seq);
      for (const e of decisions) {
        if (e.kind === "review.verdict") lines.push(`- #${e.seq} ${e.node} · ${e.verdict}${e.returnTo ? ` → ${e.returnTo}` : ""}：${e.reason}`);
        if (e.kind === "token.finished") lines.push(`- #${e.seq} ${e.node} · ${e.token} · ${e.status}：${e.reason}`);
        if (e.kind === "candidate.disposition") lines.push(`- #${e.seq} 候选处置 · ${e.candidate.disposition}：${e.candidate.failure?.message ?? e.candidate.title}`);
        if (e.kind === "token.returned") lines.push(`- #${e.seq} ${e.from} → ${e.to}（退回第 ${e.round} 次）：${e.reason}`);
        if (e.kind === "correction.created") lines.push(`- #${e.seq} 纠错 ${e.correction} → ${e.node}：${e.reason}${e.note ? `；${e.note}` : ""}${e.evidence ? `（证据 ${e.evidence}）` : ""}`);
      }
      if (!decisions.length) lines.push("（还没有）");
      lines.push("", "#### 证据索引（日志记录的引用，不代替内容核验）");
      for (const e of run.evidence) {
        lines.push(`- #${e.seq} ${e.id} · ${e.station} · ${e.label}${e.src ? ` · ${e.src}` : ""}${e.verdict ? ` · ${e.verdict}` : ""}`);
        if (e.meta) lines.push(json(e.meta));
      }
      if (!run.evidence.length) lines.push("（未记录证据；未知）");
      lines.push("", "#### 待解决问题");
      for (const issue of run.unresolved) lines.push(`- ${issue.token} · ${issue.field} · ${issue.status}：${issue.reason}`);
      if (!run.unresolved.length) lines.push("（日志未记录未解决项；不代表所有未知已获验证）");
    }
    return lines.join("\n") + "\n";
  }

  /** Newest material survives trimming; the summary block always stays. */
  caseBrief(caseId: string, max = 7000) {
    const full = this.renderCase(caseId);
    if (full.length <= max) return full;
    const [head, ...rest] = full.split("\n## 交接记录（按时间）\n");
    const body = rest.join("");
    const marker = "\n## 交接记录（按时间，较早的部分已裁剪；完整内容请 case_read）\n…";
    const briefHead = clip(head, Math.max(0, Math.min(head.length, Math.floor(max / 2))));
    const remaining = Math.max(0, max - briefHead.length - marker.length);
    const keep = remaining ? body.slice(-remaining) : "";
    return `${briefHead}${marker}${keep}`.slice(0, max);
  }

  /* ---------------------------------------------------------------- files */

  schedule(kind: "context" | "case", id: string) {
    if (this.readOnly) return;
    const k = `${kind}:${id}`;
    if (this.timers.has(k)) return;
    this.timers.set(k, setTimeout(() => { this.timers.delete(k); try { this.write(kind, id); } catch (e) { console.warn("docs", (e as Error).message); } }, 800));
  }

  write(kind: "context" | "case", id: string) {
    if (this.readOnly) return;
    if (kind === "context") { this.atomicWrite(this.contextFile(id), this.renderContext(id)); return; }
    const doc = this.caseData(id);
    // Each replacement is atomic. The shared digest identifies a pair interrupted
    // between the two renames; journal replay on boot repairs it. JSON is the last
    // commit marker, never a second source of truth or an agent-writable document.
    this.atomicWrite(this.caseFile(id), this.caseMarkdown(doc));
    this.atomicWrite(this.caseJsonFile(id), JSON.stringify(doc, null, 2) + "\n");
  }

  private assertOwnedPath(file: string) {
    const root = path.resolve(this.dir), rel = path.relative(root, path.resolve(file));
    if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Document path leaves the project");
    let cursor = root;
    for (const part of rel.split(path.sep)) {
      cursor = path.join(cursor, part);
      let st: fs.Stats;
      try { st = fs.lstatSync(cursor); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (st.isSymbolicLink()) throw new Error("Document path contains a symbolic link or junction");
      if (cursor !== path.resolve(file) && !st.isDirectory()) throw new Error("Document parent is not a directory");
      if (cursor === path.resolve(file) && !st.isFile()) throw new Error("Document target is not a regular file");
    }
  }

  private atomicWrite(file: string, content: string) {
    this.assertOwnedPath(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.assertOwnedPath(file);
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(12).toString("hex")}.tmp`);
    let owned = false;
    try {
      const fd = fs.openSync(temp, "wx", 0o600); owned = true;
      try { fs.writeFileSync(fd, content, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.assertOwnedPath(file);
      fs.renameSync(temp, file);
      owned = false;
    } finally { if (owned) fs.unlinkSync(temp); }
  }

  flush() { for (const [k, t] of this.timers) { clearTimeout(t); const [kind, ...id] = k.split(":"); try { this.write(kind as "context" | "case", id.join(":")); } catch { /* best effort */ } } this.timers.clear(); }

  writeAllContexts() {
    if (this.readOnly) return;
    for (const n of this.f.compiled.nodes) if (n.kind !== "source") this.write("context", n.key);
    this.write("context", "dispatcher");
  }

  writeAllCases() {
    if (this.readOnly) return;
    for (const id of this.caseIds()) {
      try { this.write("case", id); } catch (error) { console.warn("case document", (error as Error).message); }
    }
  }

  /* ---------------------------------------------------------------- envelope */

  /** Everything an agent reads before it works on one item at one node (Spec §31). */
  envelope(node: CompiledNode | "dispatcher", caseId?: string, tools?: string[], scope?: CaseScope) {
    const key = node === "dispatcher" ? "dispatcher" : node.key;
    const role = readRole(key);
    const project = digest(projectPaths(this.dir).project, 900);
    const parts = [
      role.content.trim(),
      `---\n# 项目：${this.name}\n${project}`,
      `---\n# 你的 CONTEXT（节选，完整版 env_call("context_read", {station:"${key}"})）\n${this.contextBrief(key)}`,
    ];
    if (caseId) parts.push(`---\n${this.caseBrief(caseId)}`);
    const trial = caseId && scope && !this.readOnly ? this.lessons?.validationContext(key, caseId, scope) : "";
    if (trial) parts.push(trial);
    if (tools?.length) parts.push(`---\n# 能力箱\n你可以调用 env_help 查看工具说明（带 name 看参数），用 env_call({name, arguments}) 执行。本工位可用：${tools.join("、")}。工具返回 ok:false 时读 failure.nextAction 和 failure.owner：owner=agent 按建议换方法，owner=user 或 system 就在提交里如实写明卡在哪，不要重复同一个调用。`);
    return { text: parts.join("\n\n"), role: role.revision, sizes: { role: role.content.length, project: project.length, context: parts[2].length, caseFile: caseId ? parts[3].length : 0 } };
  }
}
