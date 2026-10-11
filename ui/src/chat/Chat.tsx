// The fixed right column (Spec §10.2): always the main dispatcher. Resizable, collapses to an
// avatar. Above the input sits the attachment strip — evidence, nodes and items selected
// anywhere in the app arrive here like files attached to an agent chat.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Square, PanelRightClose, PanelRightOpen, X, Image as ImageIcon, Box, Package, ScrollText, GitFork, AlertTriangle, Info, Loader2 } from "lucide-react";
import type { Attachment } from "../../../shared/types.ts";
import { detach, getState, setState, useStore } from "../store.ts";
import { actions } from "../api.ts";
import { StationIcon } from "../canvas/StationIcon.tsx";
import { CorrectionPopover } from "../board/Correction.tsx";
import { toggleInspector } from "../canvas/Canvas.tsx";
import { PiConversation } from "./PiConversation.tsx";
import "./activity.css";
import {latestRunTokens} from "../../../shared/project.ts";



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
            <StationIcon role="dispatcher" size={22} />
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

function ChatHead() {
  const live = useStore((s) => s.live.id);
  const replay = useStore((s) => s.replay);
  const model = useStore((s) => s.model);
  return (
    <div className="chat-head">
      <div className="chat-avatar-wrap">
        <StationIcon role="dispatcher" size={20} />
        <i className="chat-online-dot" />
      </div>
      <div className="who">
        <b>主调度 · Easy Workflow <i className="light light--green" /></b>
        <span>{replay ? "回放中 · 只读" : live ? "正在回答…" : model || "当前工作区 · 网站入库"}</span>
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
  const patches = useStore((s) => s.fs.patches);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const followBottom = useCallback(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, []);
  useLayoutEffect(followBottom, [entries.length, live, followBottom]);
  const onScroll = () => { const el = ref.current!; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
  return (
    <div className="chat-log" ref={ref} onScroll={onScroll}>
      {!entries.length && !live.id && <Empty />}
      <PiConversation entries={entries} live={live} onResize={followBottom} />
      {live.id && !live.message && <div className="pi-waiting"><Loader2 size={12} className="spin-i" />主调度正在处理…</div>}
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

function Activity() {
  useStore((s) => s.version);
  const fs = getState().fs;
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState("");
  const notes = fs.activity.filter(n => n.at >= fs.run.startedAt);
  const warning = [...notes].reverse().find(n => n.tone === "warn" && (!n.node || (fs.nodes[n.node]?.lastOkAt ?? 0) <= n.at));
  const batch=latestRunTokens(fs);
  const blocked=batch.filter(t=>t.status==="parked"||t.status==="manual");
  const settled=batch.length>0&&batch.every(t=>t.status!=="active");
  if (!notes.length&&!settled) return null;
  return <div className="chat-activity">
    {settled&&<div className="batch-outcome"><b>本批已处理完{blocked.length?`，${blocked.length} 件需要处理`:""}</b><p>发布 {batch.filter(t=>t.status==="published").length} · 合并 {batch.filter(t=>t.status==="merged").length} · 排除 {batch.filter(t=>t.status==="rejected").length}</p>{blocked.length>0&&<button onClick={()=>setState({view:"candidates"})}>查看阻塞原因与下一步</button>}<small>本轮仍可继续投料，结束后生成报告。</small></div>}
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
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
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
    if (!text || live || replay || sending) return;
    const attachments = getState().attachments;
    setSending(true);
    setState({ draft: "", attachments: [] });
    try { await actions.chat(text, attachments); }
    catch {
      setState((s) => ({ draft: s.draft || text, attachments: [...s.attachments, ...attachments.filter((a) => !s.attachments.some((b) => b.type === a.type && b.id === a.id))] }));
    } finally { setSending(false); }
  };
  const evidence = atts.filter((a) => a.type === "evidence");
  const others = atts.filter((a) => a.type !== "evidence");
  const groupEvidence = evidence.length > 3 && !expanded;
  return (
    <div className="composer">
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
          placeholder={replay ? "回放中：对话只读" : "描述任务，或选择画布内容后提问…"}
          disabled={Boolean(replay)}
          onChange={(e) => setState({ draft: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
          rows={1}
        />
        <div className="composer-foot">
          <button className="icon-btn" data-tip="从证据板选择附件" onClick={() => setState({ view: "board" })}><ImageIcon size={16} /></button>
          <span className="composer-hint">Shift + Enter 换行</span>
          <span className="grow" />
          {live ? <button className="send send--stop" onClick={() => void actions.abortChat().catch(() => {})} aria-label="停止回答" data-tip="停止回答"><Square size={13} /></button>
            : <button className="send" disabled={!draft.trim() || Boolean(replay) || sending} onClick={send} data-tip="发送"><ArrowUp size={16} /></button>}
        </div>
      </div>
    </div>
  );
}
