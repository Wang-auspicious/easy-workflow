// The fixed right column (Spec §10.2): always the main dispatcher. Resizable, collapses to an
// avatar. Above the input sits the attachment strip — evidence, nodes and items selected
// anywhere in the app arrive here like files attached to an agent chat.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Square, PanelRightClose, PanelRightOpen, X, Image as ImageIcon, Box, Package, ScrollText, GitFork, AlertTriangle, Info, Loader2, RotateCw } from "lucide-react";
import type { Attachment } from "../../../shared/types.ts";
import { detach, getState, setState, useStore } from "../store.ts";
import { actions, api } from "../api.ts";

import { CorrectionPopover } from "../board/Correction.tsx";
import { toggleInspector } from "../canvas/Canvas.tsx";
import { Transcript } from "./Transcript.tsx";
import { Avatar } from "./Avatar.tsx";
import { dispatcherState, DISPATCHER_HUE } from "./transcript.ts";
import "./activity.css";
import {latestRunTokens} from "../../../shared/project.ts";
import { batchSummary } from "../../../shared/batch.ts";
import { useNow } from "../util/useNow.ts";



const SUGGEST = [
  "从候选库取 10 个「UI 组件与设计系统」开始入库",
  "现在怎么样了？哪个工位是瓶颈？",
  "给组件特写摄影加一个人",
  "这一轮结束，出报告",
];

export function Chat() {
  const open = useStore((s) => s.chatOpen);
  const width = useStore((s) => s.chatWidth);
  const unread = useStore((s) => s.unread);
  const [drag, setDrag] = useState(false);
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    setDrag(true);
    const x0 = e.clientX, w0 = width;
    const move = (ev: PointerEvent) => setState({ chatWidth: Math.max(320, Math.min(720, w0 - (ev.clientX - x0))) });
    const up = () => { setDrag(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  if (!open) {
    return (
      <aside className="chat is-collapsed">
        <div className="chat-head" />
        <div className="chat-collapsed">
          <button className="chat-avatar-btn" onClick={() => setState({ chatOpen: true, unread: 0 })} data-tip="展开主调度  Ctrl \" data-tip-side="right">
            <DispatcherAvatar size={26} />
            {unread > 0 && <i className="chat-unread" />}
          </button>
          <button className="icon-btn" onClick={() => setState({ chatOpen: true, unread: 0 })} data-tip="展开" data-tip-side="right"><PanelRightOpen size={16} /></button>
        </div>
        <CorrectionPopover />
      </aside>
    );
  }
  return (
    <aside className="chat">
      <div className={`chat-resize ${drag ? "is-drag" : ""}`} onPointerDown={startResize} />
      <ChatHead />
      <Activity />
      <Log />
      <Composer />
      <CorrectionPopover />
    </aside>
  );
}

/** 主调度的小人：走的是和对话行里同一套动作判定，收起来时也能看出他在干什么。 */
export function DispatcherAvatar({ size = 26 }: { size?: number }) {
  const live = useStore((s) => s.live);
  const dispatcher = useStore((s) => s.dispatcher);
  const entries = useStore((s) => s.fs.conversation);
  const last = [...entries].reverse().find((e) => e.message.role === "assistant")?.message ?? null;
  return <Avatar shape="blob" hue={DISPATCHER_HUE} state={dispatcherState(live, dispatcher, last)} size={size} title="主调度" />;
}

function ChatHead() {
  const live = useStore((s) => s.live.id);
  const replay = useStore((s) => s.replay);
  const model = useStore((s) => s.model);
  const connected = useStore((s) => s.connected);
  const dispatcher = useStore((s) => s.dispatcher);
  return (
    <div className="chat-head">
      <div className="chat-avatar-wrap">
        <DispatcherAvatar size={24} />
        <i className={`chat-online-dot ${connected ? "" : "is-offline"}`} />
      </div>
      <div className="who">
        <b>主调度 · Easy Workflow</b>
        <span>{replay ? "回放中 · 只读" : !connected ? "正在重连工厂…" : dispatcher.status === "recovering" ? "正在恢复当前任务…" : live ? "正在处理 · 可补充要求" : model || "当前工作区 · 网站入库"}</span>
      </div>
      <span className="grow" />
      <button className="icon-btn" onClick={() => setState({ chatOpen: false })} data-tip="收起到右侧，只留头像  Ctrl \"><PanelRightClose size={16} /></button>
    </div>
  );
}

function Log() {
  useStore((s) => s.version);
  const entries = useStore((s) => s.fs.conversation);
  const live = useStore((s) => s.live);
  const dispatcher = useStore((s) => s.dispatcher);
  const patches = useStore((s) => s.fs.patches);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const followBottom = useCallback(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, []);
  useLayoutEffect(followBottom, [entries.length, live, dispatcher, followBottom]);
  const onScroll = () => { const el = ref.current!; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
  return (
    <div className="chat-log" ref={ref} onScroll={onScroll}>
      {!entries.length && !live.id && <Empty />}
      <Transcript entries={entries} live={live} dispatcher={dispatcher} onResize={followBottom} />
      <ChatRecovery />
      {live.id && !live.message && dispatcher.status !== "recovering" && <div className="pi-waiting"><Loader2 size={12} className="spin-i" />主调度正在处理，可继续补充要求…</div>}
      {patches.filter((p) => p.status === "proposed").map((p) => (
        <div key={p.id} className="patch-card">
          <div><b>规格补丁 {p.id}</b> <span className="muted">待你确认</span></div>
          <div>{p.summary}</div>
          <div className="row">
            <button className="btn btn--sm btn--primary" onClick={() => void actions.patch(p.id, true).catch(() => {})}>接受</button>
            <button className="btn btn--sm" onClick={() => void actions.patch(p.id, false).catch(() => {})}>拒绝</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ChatRecovery() {
  const state = useStore(s => s.dispatcher);
  const connected = useStore(s => s.connected);
  const replay = useStore(s => s.replay);
  const [busy, setBusy] = useState(false);
  const now = useNow();
  if (replay) return null;
  if (!connected) return <div className="chat-recovery" role="status"><Loader2 size={14} className="spin-i" /><div><b>正在重新连接工厂</b><p>已有回答保留。连接恢复后同步任务进度。</p></div></div>;
  if (!["recovering", "interrupted", "failed", "aborted"].includes(state.status)) return null;
  const recovering = state.status === "recovering";
  const seconds = state.nextRetryAt ? Math.max(0, Math.ceil((state.nextRetryAt - now) / 1000)) : 0;
  const resume = async () => { setBusy(true); try { await actions.continueChat(); } catch { /* API displays the reason; retain the checkpoint controls. */ } finally { setBusy(false); } };
  return <div className="chat-recovery" role="status">
    {recovering ? <Loader2 size={14} className="spin-i" /> : <Info size={14} />}
    <div><b>{recovering ? "正在自动恢复" : state.status === "aborted" ? "本次回答已停止" : "当前对话已保留检查点"}</b>
      <p>{state.message || (recovering ? "从中断处继续处理。" : "已有结果和工具记录保留，可继续当前任务。")}</p>
      {recovering && <small>{state.maxAttempts > 0 ? `第 ${state.attempt} / ${state.maxAttempts} 次尝试` : "正在重连"}{state.nextRetryAt ? seconds ? ` · ${seconds} 秒后重试` : " · 正在准备继续" : ""}</small>}
      {!state.busy && state.recoverable && <button className="btn btn--sm" disabled={busy} onClick={() => void resume()}><RotateCw size={12} />{busy ? "正在恢复…" : "继续当前任务"}</button>}
      {state.error && <details><summary>技术详情</summary><pre>{state.error}</pre></details>}
    </div>
  </div>;
}

function Activity() {
  useStore((s) => s.version);
  const replay = useStore(s => s.replay);
  const connected = useStore(s => s.connected);
  const fs = getState().fs;
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState("");
  const [busy, setBusy] = useState(false);
  const notes = fs.activity.filter(n => n.at >= fs.run.startedAt);
  const warning = [...notes].reverse().find(n => n.tone === "warn" && (!n.node || (fs.nodes[n.node]?.lastOkAt ?? 0) <= n.at));
  const batch=latestRunTokens(fs);
  const blocked=batch.filter(t=>t.status==="parked"||t.status==="manual");
  const settled=batch.length>0&&batch.every(t=>t.status!=="active");
  const goal = batchSummary(fs);
  const canResumeGoal = goal && fs.run.status !== "ended" && ["paused", "stopped", "blocked"].includes(goal.status);
  const changeBatch = async (action: "pause" | "resume") => { if (replay || !connected) return; setBusy(true); try { await api.post("/api/tools/run_batch", { action }); } catch { /* API displays the reason. */ } finally { setBusy(false); } };
  if (!notes.length&&!settled&&!goal) return null;
  return <div className="chat-activity">
    {goal ? <div className="batch-outcome" aria-label="持续任务进度"><b>目标 {goal.target} 个网站 · 已完成 {goal.completed}</b><p>已领取 {goal.admitted} · 在途 {goal.active} · 尚未领取 {goal.remaining}</p><p>发布 {goal.published} · 合并 {goal.merged} · 排除 {goal.rejected}{goal.blocked ? ` · 待恢复 ${goal.blocked}` : ""}</p><small>{goal.reason}{goal.retrying ? ` · ${goal.retrying} 件已安排重试` : ""}</small><div className="batch-actions">{["running", "recovering"].includes(goal.status) && <button disabled={busy || Boolean(replay) || !connected} onClick={() => void changeBatch("pause")}>暂停任务</button>}{canResumeGoal && <button disabled={busy || Boolean(replay) || !connected} onClick={() => void changeBatch("resume")}>{busy ? "正在恢复…" : "恢复任务"}</button>}{goal.blocked > 0 && <button onClick={() => setState({ view: "candidates" })}>查看恢复记录</button>}</div></div>
      : settled&&<div className="batch-outcome"><b>已领取 {batch.length} 件{blocked.length ? ` · 待恢复 ${blocked.length}` : " · 已处理"}</b><p>发布 {batch.filter(t=>t.status==="published").length} · 合并 {batch.filter(t=>t.status==="merged").length} · 排除 {batch.filter(t=>t.status==="rejected").length}</p>{blocked.length>0&&<button onClick={()=>setState({view:"candidates"})}>查看恢复记录</button>}<small>这里只统计已领取条目，不代表整项任务已完成。</small></div>}
    {warning && warning.id !== dismissed && <div className="chat-attention"><AlertTriangle size={13} /><button onClick={() => { if (warning.node) { setState({ view: "canvas" }); toggleInspector(warning.node); } else setOpen(true); }}>{warning.text}</button><button aria-label="收起提示" onClick={() => setDismissed(warning.id)}><X size={12} /></button></div>}
    <button className="activity-toggle" onClick={() => setOpen(!open)} aria-expanded={open}><ScrollText size={12} />运行记录 <span>{notes.length}</span></button>
    {open && <div className="activity-log">{notes.slice(-15).map(m => <Note key={m.id} m={m} />)}</div>}
  </div>;
}

function Empty() {
  return (
    <div className="chat-intro">
      <div className="msg msg--assistant">
        <div className="msg-head"><b>把任务交给工厂。</b></div>
        <div className="body">贴入网址，描述你的目标。<br />我来编排工作，你随时查看过程。</div>
      </div>
      <div className="chat-suggest">
        {SUGGEST.map((s) => <button key={s} onClick={() => setState({ draft: s })}>{s}</button>)}
      </div>
    </div>
  );
}

function Note({ m }: { m: ReturnType<typeof getState>["fs"]["chat"][number] }) {
  const Icon = m.tone === "fork" ? GitFork : m.tone === "warn" ? AlertTriangle : Info;
  const node = m.node ? getState().factory?.nodes.find((n) => n.key === m.node) : undefined;
  const text = node ? m.text.replace(`[${node.name}] `, "") : m.text;
  return (
    <div className={`note note--${m.tone ?? "info"}`}>
      <Icon size={13} style={{ marginTop: 2, flex: "none" }} />
      <span>{node && <b className="note-node" onClick={() => { setState({ view: "canvas" }); toggleInspector(node.key); }}>{node.name}</b>}{node ? " · " : ""}{text}</span>
      <span className="note-time num">{time(m.at)}</span>
    </div>
  );
}

const time = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

export function AttChip({ a, onRemove }: { a: Attachment; onRemove?: () => void }) {
  const Icon = a.type === "evidence" ? ImageIcon : a.type === "node" ? Box : a.type === "token" ? Package : ScrollText;
  return (
    <span className="att" data-tip={a.label}>
      {a.thumb ? <img src={a.thumb} alt="" /> : <span className="att-ico"><Icon size={13} /></span>}
      <span className="att-label">{a.label}</span>
      {onRemove && <button className="att-x" onClick={onRemove}><X size={12} /></button>}
    </span>
  );
}

function Composer() {
  const atts = useStore((s) => s.attachments);
  const draft = useStore((s) => s.draft);
  const live = useStore((s) => s.live.id);
  const replay = useStore((s) => s.replay);
  const connected = useStore((s) => s.connected);
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [mode, setMode] = useState<"steer" | "followUp">("steer");
  const [sendError, setSendError] = useState("");
  const pendingSend = useRef<{ requestId: string; text: string; attachments: string } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (draft && ta.current) { ta.current.focus(); } }, [draft]);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(180, el.scrollHeight)}px`;
  }, [draft]);
  const send = async () => {
    const text = draft.trim();
    if (!text || replay || sending || !connected) return;
    const attachments = getState().attachments;
    const serialized = JSON.stringify(attachments);
    if (!pendingSend.current || pendingSend.current.text !== text || pendingSend.current.attachments !== serialized) pendingSend.current = { requestId: crypto.randomUUID(), text, attachments: serialized };
    setSending(true);
    setSendError("");
    setState({ draft: "", attachments: [] });
    try { await actions.chat(text, attachments, { requestId: pendingSend.current.requestId, mode: live ? mode : "steer" }); pendingSend.current = null; }
    catch {
      setSendError("消息未确认送达，内容已保留。再次发送时会核验接收记录，避免重复执行。");
      setState((s) => ({ draft: s.draft || text, attachments: [...s.attachments, ...attachments.filter((a) => !s.attachments.some((b) => b.type === a.type && b.id === a.id))] }));
    } finally { setSending(false); }
  };
  const evidence = atts.filter((a) => a.type === "evidence");
  const others = atts.filter((a) => a.type !== "evidence");
  const groupEvidence = evidence.length > 3 && !expanded;
  const stop = async () => { setStopping(true); try { await actions.abortChat(); } catch { /* API displays the reason. */ } finally { setStopping(false); } };
  return (
    <div className="composer">
      {sendError && <p className="composer-feedback" role="status">{sendError}</p>}
      <div className="composer-box">
        <div className="att-strip">
          {atts.length > 0 ? (
            <>
              {groupEvidence ? (
                <span className="att att--group" onClick={() => setExpanded(true)} data-tip="展开逐张移除">
                  <span className="stack">{evidence.slice(0, 3).map((a) => a.thumb ? <img key={a.id} src={a.thumb} alt="" /> : null)}</span>
                  <span className="att-label">证据卡 ×{evidence.length}</span>
                  <button className="att-x" onClick={(e) => { e.stopPropagation(); setState({ attachments: others }); }}><X size={12} /></button>
                </span>
              ) : evidence.map((a) => <AttChip key={a.id} a={a} onRemove={() => detach(a.type, a.id)} />)}
              {others.map((a) => <AttChip key={`${a.type}:${a.id}`} a={a} onRemove={() => detach(a.type, a.id)} />)}
            </>
          ) : null}
        </div>
        <textarea
          ref={ta}
          value={draft}
          placeholder={replay ? "回放中：对话只读" : live ? "可补充要求，或安排完成后跟进…" : "描述任务，或选择画布内容后提问…"}
          disabled={Boolean(replay)}
          onChange={(e) => setState({ draft: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
          rows={1}
        />
        <div className="composer-foot">
          <button className="icon-btn" data-tip="从证据板选择附件" onClick={() => setState({ view: "board" })}><ImageIcon size={16} /></button>
          {live ? <select className="composer-delivery" aria-label="消息送达方式" value={mode} onChange={e => setMode(e.target.value as "steer" | "followUp")}><option value="steer">立即补充</option><option value="followUp">完成后跟进</option></select> : <span className="composer-hint">Shift + Enter 换行</span>}
          <span className="grow" />
          {live && <button className="send send--stop" disabled={stopping || !connected || Boolean(replay)} onClick={() => void stop()} aria-label="停止当前回答" data-tip="停止当前回答，流水线任务保留">{stopping ? <Loader2 size={13} className="spin-i" /> : <Square size={13} />}</button>}
          {(!live || draft.trim() || sending) && <button className="send" disabled={!draft.trim() || Boolean(replay) || sending || !connected} onClick={send} aria-label={live ? mode === "steer" ? "发送补充要求" : "安排后续跟进" : "发送消息"} data-tip={live ? mode === "steer" ? "发送补充要求" : "安排后续跟进" : "发送"}>{sending ? <Loader2 size={15} className="spin-i" /> : <ArrowUp size={16} />}</button>}
        </div>
      </div>
    </div>
  );
}
