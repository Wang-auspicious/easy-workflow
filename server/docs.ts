// The agent document layer (Spec §31, §33): ROLE.md is the stable handbook in the pack;
// CONTEXT.md (per node) and CASE.md (per item) are rendered by the program from the
// journal projection, so weak models can append through tools but never break the
// format. envelope() composes what every agent reads before it works — the same text
// whether the agent is pi (system prompt) or a closed agent (first message).
import fs from "node:fs";
import path from "node:path";
import type { CompiledFactory, CompiledNode } from "../shared/types.ts";
import type { FactoryState } from "../shared/project.ts";
import { median } from "../shared/project.ts";
import { failureLabels } from "../shared/failures.ts";
import { readRole } from "./roles.ts";
import { digest, projectPaths } from "./workspace.ts";
import { piSelection } from "./pi.ts";

const time = (ms: number) => new Date(ms).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "~");

export const CONTEXT_HEADER = "> 这份 CONTEXT.md 由 H2 程序维护，每完成一次处理自动重写，段名和顺序固定。你不能直接改写它；要留笔记或报告问题，调用 env_call(\"context_note\", {kind, text})。版本信息只看这里，ROLE.md 不记版本。最新的条目在每段最上面。";
export const CASE_HEADER = "> 这份案卷随这件货走，所有工位共用。开始工作前读完它，完成后调用 env_call(\"case_note\", {section, text}) 给后面的人留一段交接笔记：你确认了什么、拿不准什么、提醒谁注意什么。案卷由程序按时间渲染，不要直接改写，也不要复述别人已经写过的内容。";

export class Docs {
  dir: string;
  name: string;
  private timers = new Map<string, NodeJS.Timeout>();
  private f: { state: FactoryState; compiled: CompiledFactory };
  constructor(f: { state: FactoryState; compiled: CompiledFactory }, dir: string, name: string) { this.f = f; this.dir = dir; this.name = name; }

  private node(key: string) { return this.f.compiled.nodes.find((n) => n.key === key); }

  /* ---------------------------------------------------------------- CONTEXT.md */

  contextFile(key: string) { return key === "dispatcher" ? path.join(projectPaths(this.dir).context, "dispatcher", "CONTEXT.md") : path.join(projectPaths(this.dir).context, ...key.split("/"), "CONTEXT.md"); }

  renderContext(key: string): string {
    const s = this.f.state, n = this.node(key), st = s.nodes[key];
    const name = key === "dispatcher" ? "主调度" : n?.name ?? key;
    let role = "（缺少 ROLE.md）";
    try { const r = readRole(key); role = `${r.path} @ ${r.revision}`; } catch { /* reported below */ }
    const model = key === "dispatcher" || n?.kind === "agent" || n?.kind === "review" ? `pi · ${piSelection().id}` : n?.kind === "store" ? "资源库（不执行）" : "程序执行";
    const notes = [...(s.contextNotes?.[key] ?? [])].reverse();
    const list = (kind: string, max: number) => notes.filter((x) => x.kind === kind).slice(0, max).map((x) => `- ${time(x.at)} · ${x.by}：${x.text}`).join("\n") || "- （无）";
    const attempts = Object.values(s.attempts).filter((a) => a.node === key && a.endedAt).sort((a, b) => b.endedAt! - a.endedAt!).slice(0, 8);
    const handoffs = attempts.map((a) => `- ${time(a.endedAt!)} · ${s.tokens[a.token]?.title || s.tokens[a.token]?.item || a.token} · ${a.cancelled ? "已取消" : a.ok ? "完成" : "失败"} · ${clip(a.ok ? a.summary ?? "" : a.error ?? a.summary ?? "", 120)}`).join("\n") || "- （本项目还没有处理记录）";
    const failures = Object.values(s.recoveries ?? {}).filter((c) => c.failure && s.tokens[c.token]?.finishedAtNode === key && c.disposition === "retry").slice(0, 6)
      .map((c) => `- ${c.title}：${failureLabels[c.failure!.tag]}——${clip(c.failure!.nextAction ?? c.failure!.message, 100)}`);
    const issues = [list("issue", 6), ...failures].filter((x) => x !== "- （无）").join("\n") || "- （无）";
    const run = s.run.id ? `${s.run.id}（${s.run.status}）` : "尚未开始";
    const progress = st ? `- 本轮 ${run}：处理 ${st.processed}，失败 ${st.failed}，退回 ${st.returned}，队列 ${st.queue.length}，在做 ${st.active.length}，中位耗时 ${(median(st.durations) / 1000).toFixed(1)}s` : `- 本轮 ${run}`;
    return [
      `# ${name} · CONTEXT`, "", CONTEXT_HEADER, "",
      "## 版本", `- 角色：${role}`, `- 执行：${model}`, `- 规格：${this.f.compiled.specVersion} · ${this.f.compiled.digest.slice(0, 12)}`, `- 项目：${this.name}（${this.dir}）`, "",
      "## 本轮进度", progress, "",
      "## 站长 / 主调度指示", list("instruction", 6), "",
      "## 最近交接", handoffs, "",
      "## 待解决问题", issues, "",
      "## 工作笔记", list("note", 8), "",
      "## 待批准的经验", list("lesson", 6), "",
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

  caseFile(caseId: string) { return path.join(projectPaths(this.dir).cases, safe(caseId), "CASE.md"); }

  renderCase(caseId: string): string {
    const s = this.f.state;
    const tokens = s.tokenOrder.map((id) => s.tokens[id]).filter((t) => t?.item === caseId);
    const t = tokens.at(-1);
    const d = (t?.data ?? {}) as Record<string, any>;
    const notes = s.cases?.[caseId] ?? [];
    const consults = Object.values(s.consults ?? {}).filter((c) => tokens.some((x) => x.id === c.token));
    const head = [
      `# 案卷 · ${t?.title || caseId}`, "", CASE_HEADER, "",
      "## 概况",
      `- 条目：${caseId}`, `- 网址：${d.canonical ?? t?.url ?? ""}`, `- 来源：${t?.source ?? ""}`,
      `- 当前：${t ? `${t.status}${t.at.length ? ` · 在 ${t.at.map((k) => this.node(k)?.name ?? k).join("、")}` : ""}${t.reason ? ` · ${clip(t.reason, 80)}` : ""}` : "未开始"}`,
      d.kind ? `- 分类：${d.kind}${d.kindAgreed === false ? "（分类员与复核员不一致，已交仲裁）" : ""}` : "- 分类：待定",
      tokens.length > 1 ? `- 处理次数：${tokens.length}（重试沿用同一份案卷）` : "",
      "",
    ].filter((x) => x !== "");
    const body = notes.map((x) => `### ${time(x.at)} · ${this.node(x.station)?.name ?? x.station} · ${x.section}\n${x.text}`);
    const talk = consults.map((c) => `- ${time(c.openedAt)} ${this.node(c.reviewer)?.name ?? c.reviewer} → ${this.node(c.owner)?.name ?? c.owner}（第 ${c.round} 轮，字段 ${c.fields.join("、")}）：${c.problem}${c.reply ? `\n  - 回复：${c.reply}` : ""}${c.outcome ? `\n  - 结果：${c.outcome === "resolved" ? "已解决" : "转人工"}${c.reason ? `（${c.reason}）` : ""}` : ""}`);
    return [...head, "", "## 交接记录（按时间）", ...(body.length ? body : ["（还没有）"]), "", "## 审核往来", ...(talk.length ? talk : ["（还没有）"]), ""].join("\n");
  }

  /** Newest material survives trimming; the summary block always stays. */
  caseBrief(caseId: string, max = 7000) {
    const full = this.renderCase(caseId);
    if (full.length <= max) return full;
    const [head, ...rest] = full.split("\n## 交接记录（按时间）\n");
    const body = rest.join("");
    const keep = body.slice(-(max - head.length - 80));
    return `${head}\n## 交接记录（按时间，较早的部分已裁剪）\n…${keep}`;
  }

  /* ---------------------------------------------------------------- files */

  schedule(kind: "context" | "case", id: string) {
    const k = `${kind}:${id}`;
    if (this.timers.has(k)) return;
    this.timers.set(k, setTimeout(() => { this.timers.delete(k); try { this.write(kind, id); } catch (e) { console.warn("docs", (e as Error).message); } }, 800));
  }

  write(kind: "context" | "case", id: string) {
    const file = kind === "context" ? this.contextFile(id) : this.caseFile(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, kind === "context" ? this.renderContext(id) : this.renderCase(id));
  }

  flush() { for (const [k, t] of this.timers) { clearTimeout(t); const [kind, ...id] = k.split(":"); try { this.write(kind as "context" | "case", id.join(":")); } catch { /* best effort */ } } this.timers.clear(); }

  writeAllContexts() {
    for (const n of this.f.compiled.nodes) if (n.kind !== "source") this.write("context", n.key);
    this.write("context", "dispatcher");
  }

  /* ---------------------------------------------------------------- envelope */

  /** Everything an agent reads before it works on one item at one node (Spec §31). */
  envelope(node: CompiledNode | "dispatcher", caseId?: string, tools?: string[]) {
    const key = node === "dispatcher" ? "dispatcher" : node.key;
    const role = readRole(key);
    const project = digest(projectPaths(this.dir).project, 900);
    const parts = [
      role.content.trim(),
      `---\n# 项目：${this.name}\n${project}`,
      `---\n# 你的 CONTEXT（节选，完整版 env_call("context_read", {station:"${key}"})）\n${this.contextBrief(key)}`,
    ];
    if (caseId) parts.push(`---\n${this.caseBrief(caseId)}`);
    if (tools?.length) parts.push(`---\n# 能力箱\n你可以调用 env_help 查看工具说明（带 name 看参数），用 env_call({name, arguments}) 执行。本工位可用：${tools.join("、")}。工具返回 ok:false 时读 failure.nextAction 和 failure.owner：owner=agent 按建议换方法，owner=user 或 system 就在提交里如实写明卡在哪，不要重复同一个调用。`);
    return { text: parts.join("\n\n"), role: role.revision, sizes: { role: role.content.length, project: project.length, context: parts[2].length, caseFile: caseId ? parts[3].length : 0 } };
  }
}
