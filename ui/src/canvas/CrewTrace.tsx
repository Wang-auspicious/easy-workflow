// 工位卡片里的"人和过程"。
//
// 一个工位可能同时有好几个人：固定的人、自动 fork 出来的人、被撤下的人。这里把他们分开显示，
// 每个人有自己的小人、状态和正在处理的条目；点谁就看谁的过程。
// 过程按 Grok Bot 的转录样式排：思考与工具各自折叠、内部滚动，工位记录按时间插在中间。
import { useMemo, useState } from "react";
import { ChevronRight, GitFork, UserMinus, Loader2, Check, AlertTriangle, CircleMinus, UserPlus, ExternalLink } from "lucide-react";
import type { CompiledNode, EvidenceRef } from "../../../shared/types.ts";
import type { AttemptState, ChatMessage, TokenState, WorkerState } from "../../../shared/project.ts";
import { roleColors } from "../../../shared/palette.ts";
import { getState } from "../store.ts";
import { Avatar, type AvatarState } from "../chat/Avatar.tsx";
import { grokShape } from "../chat/avatar-look.ts";
import { useHoverPreview, previewSet } from "../shell/HoverPreview.tsx";
import { openCorrection } from "../board/Correction.tsx";
import { fmt, secs } from "./Node.tsx";
import {useDetail} from '../details.ts';

/** 同一个工位的人共用形状，用色相区分开；撤下的人变灰。 */
export function crewLook(node: CompiledNode, index: number, retired: boolean) {
  const base = roleColors(node.role);
  return { shape: grokShape(node.bot.shape), hue: retired ? 250 : (base.h + index * 26) % 360 };
}

export function workerState(w: WorkerState, a: AttemptState | undefined): AvatarState {
  if (w.retiredAt) return "sleep";
  if (a && a.endedAt === undefined) return "work";
  if (a && a.ok === false) return "fail";
  if (a && a.ok) return "returned";
  return "idle";
}

const time = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

/** 人的一排：谁在忙、谁空着、谁被撤了。 */
export function CrewStrip({ node, workers, attempts, current, onPick }: {
  node: CompiledNode; workers: WorkerState[]; attempts: AttemptState[]; current?: string; onPick: (id: string) => void;
}) {
  return (
    <div className="crew">
      <div className="crew-title"><span>这个工位的人</span><span className="muted num">{workers.filter((w) => !w.retiredAt).length} 在岗{workers.some((w) => w.retiredAt) ? ` · ${workers.filter((w) => w.retiredAt).length} 已撤` : ""}</span></div>
      {workers.map((w, i) => {
        const a = w.busy ? getState().fs.attempts[w.busy] : [...attempts].reverse().find((x) => x.worker === w.id);
        const state = workerState(w, a);
        const look = crewLook(node, i, Boolean(w.retiredAt));
        const item = w.busy ? getState().fs.tokens[getState().fs.attempts[w.busy]?.token]?.item : undefined;
        return (
          <button key={w.id} className={`crew-row ${current === w.id ? "is-on" : ""} ${w.retiredAt ? "is-retired" : ""}`} onClick={() => onPick(w.id)}>
            <Avatar shape={look.shape} hue={look.hue} state={state} size={26} title={w.label} />
            <span className="crew-name">
              {w.label}
              {w.forked && <i className="crew-tag crew-tag--fork" data-tip="自动 fork 出来的"><GitFork size={9} />fork</i>}
              {w.retiredAt && <i className="crew-tag crew-tag--gone" data-tip={`${time(w.retiredAt)} 撤下`}><UserMinus size={9} />已撤</i>}
            </span>
            <span className="crew-now">{w.retiredAt ? <span className="muted">已离开</span> : item ? <span className="crew-item">{item}</span> : a && a.endedAt === undefined ? <span className="muted">刚开始</span> : <span className="muted">空闲</span>}</span>
            <span className="crew-done num muted">{w.done} 件</span>
          </button>
        );
      })}
    </div>
  );
}

/** 一个人此刻的过程：输入、逐步输出、工具与证据，末尾是状态。 */
export function WorkerTrace({ a, node, now }: { a: AttemptState; node: CompiledNode; now: number }) {
  const s = getState();
  const token = s.fs.tokens[a.token];
  const detail = useDetail<AttemptState>({kind: 'attempt', id: a.id}, a);
  const groups = groupSteps(detail.data?.steps ?? []);
  const running = a.endedAt === undefined;
  const c = roleColors(node.role).border;
  return (
    <div className="wt" style={{ ["--tc" as string]: c }}>
      <div className="wt-input">
        <span className="muted">处理</span>
        <span className="wt-item">{token?.item}</span>
        {token?.url && <a href={token.url} target="_blank" rel="noreferrer" className="muted"><ExternalLink size={11} /></a>}
        <span className="grow" />
        <span className="num muted">{running ? secs(now - a.startedAt) : secs(a.ms ?? 0)}</span>
      </div>
      <div className="wt-log">
        {detail.loading && <p className="muted" role="status">{detail.data ? '正在更新完整步骤…' : '正在读取完整步骤…'}</p>}
        {detail.error && <p role="alert">完整步骤读取失败：{detail.error} <button className="btn btn--sm" onClick={detail.retry}>重新读取</button></p>}
        {groups.map((g, gi) => g.kind === "say"
          ? g.items.map((st, i) => <SayRow key={`${gi}-${i}`} st={st} />)
          : g.kind === "think"
            ? <ThinkRow key={gi} items={g.items} />
            : <ToolGroup key={gi} items={g.items} />)}
        {detail.data && !groups.length && <div className="wt-empty muted">{running ? "刚开始，还没有输出…" : "这次没有留下步骤记录。"}</div>}
      </div>
      <div className={`wt-foot ${running ? "is-running" : a.cancelled ? "is-cancelled" : a.ok ? "is-ok" : "is-bad"}`}>
        {running ? <><Loader2 size={12} className="spin-i" /><span>{a.steps[a.steps.length - 1]?.text ?? "开始处理…"}</span></>
          : <>{a.cancelled ? <CircleMinus size={12} /> : a.ok ? <Check size={12} /> : <AlertTriangle size={12} />}
            <span>{a.ok ? a.summary : `${a.summary ?? "失败"}${a.error && a.error !== a.summary ? `：${a.error}` : ""}`}</span>
            <span className="num muted">{a.usage.input ? `${fmt(a.usage.input + a.usage.output)} tok` : ""}{a.queuedMs ? ` · 排队 ${secs(a.queuedMs)}` : ""}</span></>}
      </div>
    </div>
  );
}

function groupSteps(steps: AttemptState["steps"]) {
  const out: { kind: "say" | "tools" | "think"; items: AttemptState["steps"] }[] = [];
  for (const st of steps) {
    const tool = st.step?.tool ?? "say";
    const isTool = ["browser", "shot", "reject", "http", "record", "webp"].includes(tool);
    const kind = isTool ? "tools" : tool === "think" ? "think" : "say";
    const last = out[out.length - 1];
    // 流式推理是一小片一小片来的：同一段思考合成一块。
    if ((kind === "tools" || kind === "think") && last?.kind === kind) last.items.push(st);
    else out.push({ kind, items: [st] });
  }
  return out;
}

function SayRow({ st }: { st: AttemptState["steps"][number] }) {
  const tool = st.step?.tool;
  const cls = st.step?.ok === false ? "is-bad" : st.step?.ok === true ? "is-ok" : tool === "submit" ? "is-submit" : tool === "model" ? "is-model" : "";
  return (
    <div className={`wt-say ${cls}`}>
      <i className="wt-dot" />
      <span className="sel">{st.text}</span>
      {(st.step?.evidence ?? []).map((id, i) => <EvThumb key={`${id}-${i}`} id={id} />)}
    </div>
  );
}

/** 只把有内容的片段拼起来，丢掉"Hmm,""Actually"这类碎片。 */
const FILLER = /^(hmm+|actually|wait|ok(ay)?|so|but|well|right|good|fine|let me( think| see| check)?|hmm, but|[a-z]\.?|[a-z]\. ?\w{0,6})[\s,.:;!?…—-]*$/i;
const thought = (items: AttemptState["steps"]) => items.map((st) => st.text.trim()).filter((t) => t.length > 3 && !FILLER.test(t)).join(" ").replace(/\s+/g, " ").trim();

function ThinkRow({ items }: { items: AttemptState["steps"] }) {
  const [open, setOpen] = useState(false);
  const text = thought(items);
  if (!text) return null;
  const first = (text.match(/^.{12,}?[。.!?！？](\s|$)/)?.[0] ?? text).slice(0, 110);
  return (
    <div className={`wt-think ${open ? "is-open" : ""}`}>
      <button onClick={() => setOpen((o) => !o)}>
        <ChevronRight size={12} className={open ? "rot" : ""} />
        <span className="wt-think-label">思考</span>
        <span className="wt-think-text sel">{open ? "" : `${first}${first.length < text.length ? "…" : ""}`}</span>
      </button>
      {/* 展开也只在内部滚，不把卡片撑爆。 */}
      {open && <div className="wt-think-body sel">{text}</div>}
    </div>
  );
}

function ToolGroup({ items }: { items: AttemptState["steps"] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="wt-tools">
      <button className="wt-tools-sum" onClick={() => setOpen((o) => !o)}>
        <ChevronRight size={12} className={open ? "rot" : ""} />
        <span>{summarize(items)}</span>
        <span className="wt-thumbs">{items.flatMap((st) => st.step?.evidence ?? []).slice(0, 3).map((id, i) => <EvThumb key={`${id}-${i}`} id={id} small />)}</span>
      </button>
      {open && (
        <div className="wt-tools-body">
          {items.map((st, i) => (
            <div key={i} className={`wt-tool-line ${st.step?.ok === false ? "is-bad" : st.step?.ok ? "is-ok" : ""}`}>
              <span className="wt-tool-name mono">{st.step?.tool}</span>
              <span className="sel">{st.text}</span>
              {(st.step?.evidence ?? []).map((id, i) => <EvThumb key={`${id}-${i}`} id={id} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function summarize(items: AttemptState["steps"]) {
  const count = (t: string) => items.filter((x) => x.step?.tool === t).length;
  const opened = items.filter((x) => x.text.startsWith("打开") || x.step?.tool === "http").length;
  const parts = [opened && `打开 ${opened} 页`, count("shot") && `截图 ${count("shot")} 张`, count("reject") && `拒收 ${count("reject")} 张`, count("record") && `录屏 ${count("record")} 步`, count("webp") && "转 WebP"].filter(Boolean);
  return parts.join("、") || `${items.length} 步工具调用`;
}

/** 人员变动与工位记录：谁被 fork 出来、谁被撤下、什么时候恢复过。 */
export function CrewTimeline({ notes, workers, now }: { notes: ChatMessage[]; workers: WorkerState[]; now: number }) {
  const events = useMemo(() => {
    const rows: { id: string; at: number; kind: "fork" | "retire" | "join" | "note"; text: string; tone?: ChatMessage["tone"] }[] = [];
    for (const w of workers) {
      rows.push({ id: `spawn-${w.id}`, at: w.spawnedAt, kind: w.forked ? "fork" : "join", text: `${w.label}${w.forked ? " 自动 fork 出来" : " 到岗"}` });
      if (w.retiredAt) rows.push({ id: `retire-${w.id}`, at: w.retiredAt, kind: "retire", text: `${w.label} 撤下` });
    }
    for (const n of notes) rows.push({ id: n.id, at: n.at, kind: "note", text: n.text.replace(/^\[[^\]]+\]\s*/, ""), tone: n.tone });
    return rows.sort((a, b) => a.at - b.at);
  }, [notes, workers.map((w) => `${w.id}:${w.retiredAt ?? ""}`).join(",")]);
  if (!events.length) return null;
  const Icon = { fork: GitFork, retire: UserMinus, join: UserPlus, note: CircleMinus };
  return (
    <details className="crew-log" open={events.length <= 4}>
      <summary><span>人员与工位记录</span><span className="muted num">{events.length}</span></summary>
      <div className="crew-log-body">
        {events.map((e) => {
          const I = Icon[e.kind];
          return (
            <div key={e.id} className={`crew-event crew-event--${e.kind} ${e.tone ? `is-${e.tone}` : ""}`}>
              <I size={11} />
              <span className="sel">{e.text}</span>
              <time className="num muted">{time(e.at)}</time>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function EvThumb({ id, small }: { id: string; small?: boolean }) {
  const ev = getState().fs.evidence[id];
  if (!ev) return null;
  const tok = getState().fs.tokens[ev.token];
  return <EvThumbBody ev={ev} tok={tok} small={small} />;
}

function EvThumbBody({ ev, tok, small }: { ev: EvidenceRef; tok?: TokenState; small?: boolean }) {
  const hover = useHoverPreview(() => previewSet(ev));
  return (
    <span className={`ev-thumb ${small ? "is-small" : ""}`} {...(ev.kind === "image" || ev.kind === "video" ? hover : {})}>
      {ev.kind === "image" || ev.kind === "video" ? <img src={ev.poster ?? ev.card ?? ev.src} alt="" draggable={false} /> : <b>{ev.verdict}</b>}
      {!small && <button className="ev-wrong" onClick={(e) => { e.stopPropagation(); openCorrection([{ token: ev.token, node: ev.station, evidence: ev.id, label: `${tok?.item} · ${ev.label}` }], e.currentTarget); }}>不对</button>}
    </span>
  );
}
