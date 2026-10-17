// 右侧栏（Spec §10.2）：固定是主调度，但内部再分成两栏——
//   左：群组栏（RoomRail）。流程上真正需要对话的地方，点谁展开谁的往来。
//   右：当前群组。主调度那一格还是原来的转录；其他群展示该群的工位往来。
// 输入框属于整个面板（消息只发给主调度），所以它活在两栏下面，切群不丢草稿。
//
// 顶部原来那块（批次卡片 / 注意力提示 / 运行记录）已去掉：批次控制在工作区工具条上，
// 工位的提示与去向已经作为对话行出现在转录里，不再重复一份。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Square, PanelRightClose, PanelRightOpen, X, Image as ImageIcon, Box, Package, ScrollText, RotateCw, Info, Loader2, Slash, ChevronLeft } from "lucide-react";
import type { Attachment } from "../../../shared/types.ts";
import { detach, getState, setState, useStore } from "../store.ts";
import { actions } from "../api.ts";
import { CorrectionPopover } from "../board/Correction.tsx";
import { Transcript } from "./Transcript.tsx";
import { Avatar } from "./Avatar.tsx";
import { RoomList, useRooms } from "./RoomRail.tsx";
import { RoomLog, KernelProgressLog } from "./RoomLog.tsx";
import { GroupAvatar } from "./GroupAvatar.tsx";
import { ROOT_ROOM } from "../../../shared/rooms.ts";
import { dispatcherState, DISPATCHER_HUE } from "./transcript.ts";
import { useNow } from "../util/useNow.ts";
import "./activity.css";
import "./composer.css";
import {KernelSummary, ProgressToggle} from '../KernelPanels.tsx';

const SUGGEST = [
  "从候选库取 10 个「UI 组件与设计系统」开始入库",
  "现在怎么样了？哪个工位是瓶颈？",
  "给组件特写摄影加一个人",
  "这一轮结束，出报告",
];

/** 输入框里的命令。只做界面真能做的事：要么发一句话给主调度，要么调用已有接口。 */
interface Command { cmd: string; title: string; hint: string; send?: string; run?: "abort" | "continue" | "pause" | "play" | "steer" | "followUp" | "clear" }

const COMMANDS: Command[] = [
  { cmd: "/status", title: "问主调度现在怎么样", hint: "瓶颈、在途、待恢复", send: "现在怎么样了？哪个工位是瓶颈？" },
  { cmd: "/resume", title: "从失败工位继续", hint: "复用已有产物与证据", send: "从失败工位继续，把剩下的处理完" },
  { cmd: "/report", title: "出这一轮的报告", hint: "结束本轮并打开报告", send: "这一轮结束，出报告" },
  { cmd: "/stop", title: "停止当前回答", hint: "已完成的工具结果保留", run: "abort" },
  { cmd: "/continue", title: "继续当前任务", hint: "从检查点恢复", run: "continue" },
  { cmd: "/pause", title: "暂停流水线", hint: "在途任务跑完再停", run: "pause" },
  { cmd: "/play", title: "恢复流水线", hint: "继续未完成的任务", run: "play" },
  { cmd: "/steer", title: "改成「立即补充」", hint: "插进当前回答", run: "steer" },
  { cmd: "/followup", title: "改成「完成后跟进」", hint: "等这轮结束再处理", run: "followUp" },
  { cmd: "/clear", title: "清空输入与附件", hint: "不发送任何内容", run: "clear" },
];

/** Older profiles saved a single-column width; keep both new columns readable. */
export function chatPanelWidth(width: number, _roomsOpen?: boolean): number {
  return Math.max(340, Math.min(720, Number.isFinite(width) ? width : 380));
}

export function Chat() {
  const open = useStore((s) => s.chatOpen);
  const width = useStore((s) => s.chatWidth);
  const roomsOpen = useStore((s) => s.roomRailOpen);
  const unread = useStore((s) => s.unread);
  const list = useStore((s) => s.chatList);
  const isRoot = useStore((s) => s.chatRoom === ROOT_ROOM);
  const [drag, setDrag] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const pendingFocus = useRef(false);
  const resizeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanup.current?.(), []);
  useLayoutEffect(() => {
    if (open && !list && isRoot && pendingFocus.current && composer.current) {
      composer.current.focus(); pendingFocus.current = false;
    }
  }, [open, list, isRoot]);
  useEffect(() => {
    const focus = () => {
      pendingFocus.current = true;
      const current = getState();
      const wasVisible = current.chatOpen && !current.chatList && current.chatRoom === ROOT_ROOM;
      setState({ chatOpen: true, chatList: false, chatRoom: ROOT_ROOM, unread: 0 });
      if (wasVisible && composer.current) { composer.current.focus(); pendingFocus.current = false; }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault(); focus();
      }
    };
    window.addEventListener("easy:focus-composer", focus);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("easy:focus-composer", focus); window.removeEventListener("keydown", onKey); };
  }, []);
  const startResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    resizeCleanup.current?.();
    setDrag(true);
    const x0 = e.clientX, w0 = chatPanelWidth(width, roomsOpen);
    const move = (ev: PointerEvent) => setState({ chatWidth: chatPanelWidth(w0 - (ev.clientX - x0), roomsOpen) });
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
      resizeCleanup.current = null;
    };
    const up = () => {
      setDrag(false);
      cleanup();
    };
    resizeCleanup.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
  };
  return (
    <aside className={`chat${open ? "" : " is-collapsed"}`}>
      {!open && <>
        <div className="chat-head" />
        <div className="chat-collapsed">
          <button className="chat-avatar-btn" aria-label="展开主调度" onClick={() => setState({ chatOpen: true, chatList: false, chatRoom: ROOT_ROOM, unread: 0 })} data-tip="展开主调度  Ctrl K" data-tip-side="right">
            <DispatcherAvatar size={26} />
            {unread > 0 && <i className="chat-unread" />}
          </button>
          <button className="icon-btn" aria-label="展开对话" onClick={() => setState({ chatOpen: true, unread: 0 })} data-tip="展开对话" data-tip-side="right"><PanelRightOpen size={16} /></button>
        </div>
      </>}
      {/* Collapsing is a view change. Keep the pending request ID and send mode
          alive so reopening cannot resend an unconfirmed operation as new. */}
      <div style={{ display: open ? "contents" : "none" }}>
        <div className={`chat-resize ${drag ? "is-drag" : ""}`} onPointerDown={startResize}
          role="separator" aria-label="调整对话宽度" aria-orientation="vertical" tabIndex={open ? 0 : -1}
          aria-valuemin={340} aria-valuemax={720} aria-valuenow={chatPanelWidth(width)}
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 340 : event.key === 'End' ? 720
              : chatPanelWidth(width) + (event.key === 'ArrowLeft' ? 24 : -24);
            setState({chatWidth: chatPanelWidth(next)});
          }} />
        <ChatHead />
        <KernelSummary />
        {list ? <RoomList /> : <ChatPane />}
        <div style={{display: !list && isRoot ? 'contents' : 'none'}}>
          <Composer inputRef={composer} visible={open && !list && isRoot} />
        </div>
      </div>
      <CorrectionPopover />
    </aside>
  );
}

/** 当前群组那一格：主调度走原来的转录，其他群走该群的工位往来。 */
function ChatPane() {
  const rooms = useRooms();
  const selected = useStore((s) => s.chatRoom);
  const entries = useStore((s) => s.fs.conversation);
  const live = useStore((s) => s.live);
  const dispatcher = useStore((s) => s.dispatcher);
  const room = rooms.find((r) => r.id === selected) ?? rooms[0]!;
  // 选中的群可能因流程补丁或新观测而改名：退回主调度，不显示空白。
  useEffect(() => {
    if (!rooms.some((r) => r.id === selected)) setState({ chatRoom: ROOT_ROOM });
  }, [rooms, selected]);
  return room.kind === "root"
    ? <RootLog entries={entries} live={live} dispatcher={dispatcher} />
    : <section className="chat-pane"><RoomLog room={room} rooms={rooms} /></section>;
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
  const list = useStore((s) => s.chatList);
  const rooms = useRooms();
  const selected = useStore((s) => s.chatRoom);
  const room = rooms.find((r) => r.id === selected) ?? rooms[0]!;
  const close = <button className="icon-btn" aria-label="收起对话" onClick={() => setState({ chatOpen: false })} data-tip="收起对话  Ctrl \"><PanelRightClose size={16} /></button>;
  if (list) return (
    <div className="chat-head chat-head--list">
      <b className="chat-title">对话</b>
      <span className="grow" />
      {close}
    </div>
  );
  const sub = room.kind === "root"
    ? (replay ? "回放中 · 只读" : !connected ? "正在重连…" : dispatcher.status === "recovering" ? "正在恢复…" : live ? "正在处理" : model || "在线")
    : room.subtitle;
  return (
    <div className="chat-head chat-head--talk">
      <button className="chat-round" onClick={() => setState({ chatList: true })} aria-label="所有对话" data-tip="所有对话"><ChevronLeft size={17} /></button>
      <span className="grow" />
      <div className="chat-pill" title={sub}>
        <span className="chat-avatar-wrap">
          {room.kind === "root"
            ? <DispatcherAvatar size={22} />
            : <GroupAvatar size={22} members={room.members.slice(0, 4).map((m) => ({ key: m.key, hue: 250, state: "idle" as const, title: m.name }))} />}
          <i className={`chat-online-dot ${connected ? "" : "is-offline"}`} />
        </span>
        <b>{room.kind === "root" ? "主调度" : room.name}</b>
      </div>
      <span className="grow" />
      {close}
    </div>
  );
}

/** 主调度那一格：还是原来那份转录，滚动跟随行为不变。 */
function RootLog({ entries, live, dispatcher }: {
  entries: Parameters<typeof Transcript>[0]["entries"]; live: Parameters<typeof Transcript>[0]["live"];
  dispatcher: Parameters<typeof Transcript>[0]["dispatcher"];
}) {
  const patches = useStore((s) => s.fs.patches);
  const kernel = useStore(state => state.replay ? 'v1' : state.kernel);
  const showProgress = useStore(state => state.showProgress);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const followBottom = useCallback(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, []);
  useLayoutEffect(followBottom, [entries.length, live, dispatcher, followBottom]);
  const onScroll = () => { const el = ref.current!; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
  return (
    <section className="chat-pane" aria-label="与主调度的对话">
      {kernel === 'v2' && <ProgressToggle />}
      <div className="chat-log" ref={ref} onScroll={onScroll}>
        {!entries.length && !live.id && <Empty />}
        <Transcript entries={entries} live={live} dispatcher={dispatcher} onResize={followBottom} />
        {kernel === 'v2' && showProgress && <KernelProgressLog />}
        <ChatRecovery />
        {live.id && !live.message && dispatcher.status !== "recovering" && <div className="pi-waiting"><Loader2 size={12} className="spin-i" />主调度正在处理，可继续补充要求…</div>}
        {patches.filter(patch => patch.status === 'proposed').map(patch => <PatchCard key={patch.id} patch={patch} />)}
      </div>
    </section>
  );
}

function PatchCard({patch}: {patch: {id: string; summary: string}}) {
  useStore(state => state.version);
  const connected = useStore(state => state.connected);
  const replay = useStore(state => Boolean(state.replay));
  const status = useStore(state => state.fs.run.status);
  const active = useStore(state => Object.values(state.fs.nodes).some(node => node.active.length > 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const flight = useRef(false);
  const readOnly = !connected || replay;
  const structureBlocked = status === 'running' || status === 'paused' || active;
  const decide = async (accept: boolean) => {
    const state = getState();
    if (flight.current || !state.connected || state.replay) return;
    if (accept && (['running', 'paused'].includes(state.fs.run.status) ||
      Object.values(state.fs.nodes).some(node => node.active.length > 0))) return;
    flight.current = true;
    setBusy(true);
    setError('');
    try {
      await actions.patch(patch.id, accept);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '补丁操作失败，请核对状态后重试。');
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  return <div className="patch-card">
    <div><b>规格补丁 {patch.id}</b> <span className="muted">待你确认</span></div>
    <div>{patch.summary}</div>
    {(readOnly || structureBlocked) && <p className="muted">{replay ? '回放为只读。' : !connected
      ? '连接恢复后可处理补丁。' : '结束当前轮次并等待在途工位回收后，可接受结构变更。'}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="row">
      <button className="btn btn--sm btn--primary" disabled={busy || readOnly || structureBlocked} onClick={() => void decide(true)}>{busy ? '正在处理…' : '接受'}</button>
      <button className="btn btn--sm" disabled={busy || readOnly} onClick={() => void decide(false)}>拒绝</button>
    </div>
  </div>;
}

function ChatRecovery() {
  const state = useStore(s => s.dispatcher);
  const connected = useStore(s => s.connected);
  const replay = useStore(s => s.replay);
  const [busy, setBusy] = useState(false);
  const now = useNow();
  if (replay) return null;
  // One quiet line, not a card: the conversation is saved either way.
  if (!connected) return <div className="chat-status" role="status"><Loader2 size={12} className="spin-i" />正在重新连接，已有回答都在</div>;
  if (!["recovering", "interrupted", "failed", "aborted"].includes(state.status)) return null;
  const recovering = state.status === "recovering";
  const seconds = state.nextRetryAt ? Math.max(0, Math.ceil((state.nextRetryAt - now) / 1000)) : 0;
  const resume = async () => { setBusy(true); try { await actions.continueChat(); } catch { /* API displays the reason; retain the checkpoint controls. */ } finally { setBusy(false); } };
  const text = recovering
    ? `正在自动恢复${seconds ? ` · ${seconds} 秒后重试` : ""}`
    : state.status === "aborted" ? "这次回答已停止，进度已保存" : "连接中断过，进度已保存";
  return <div className="chat-status" role="status" data-tip={[state.message, state.error].filter(Boolean).join("\n") || undefined}>
    {recovering ? <Loader2 size={12} className="spin-i" /> : <Info size={12} />}
    <span>{text}</span>
    {!state.busy && state.recoverable && <button className="chat-status-act" disabled={busy} onClick={() => void resume()}><RotateCw size={11} />{busy ? "恢复中" : "继续"}</button>}
  </div>;
}

function Empty() {
  const kernel = useStore(state => state.kernel);
  const suggestions = kernel === 'v2' ? SUGGEST.map(text => text === '给组件特写摄影加一个人' ? '查看等待预算和讨论的工位' : text) : SUGGEST;
  return (
    <div className="chat-intro">
      <div className="msg msg--assistant">
        <div className="msg-head"><b>把任务交给工厂。</b></div>
        <div className="body">贴入网址，描述你的目标。<br />我来编排工作，你随时查看过程。</div>
      </div>
      <div className="chat-suggest">
        {suggestions.map((s) => <button key={s} onClick={() => setState({ draft: s })}>{s}</button>)}
      </div>
    </div>
  );
}

export function AttChip({ a, onRemove }: { a: Attachment; onRemove?: () => void }) {
  const Icon = a.type === "evidence" ? ImageIcon : a.type === "node" ? Box : a.type === "token" ? Package : ScrollText;
  return (
    <span className="att" data-tip={a.label}>
      {a.thumb ? <img src={a.thumb} alt="" /> : <span className="att-ico"><Icon size={13} /></span>}
      <span className="att-label">{a.label}</span>
      {onRemove && <button className="att-x" aria-label={`移除附件：${a.label}`} onClick={onRemove}><X size={12} /></button>}
    </span>
  );
}

function Composer({inputRef, visible}: {inputRef: React.RefObject<HTMLTextAreaElement | null>; visible: boolean}) {
  const atts = useStore((s) => s.attachments);
  const draft = useStore((s) => s.draft);
  const history = useStore((s) => s.history);
  const live = useStore((s) => s.live.id);
  const replay = useStore((s) => s.replay);
  const connected = useStore((s) => s.connected);
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [mode, setMode] = useState<"steer" | "followUp">("steer");
  const [sendError, setSendError] = useState("");
  const [palette, setPalette] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [walk, setWalk] = useState<number | null>(null);
  const pendingSend = useRef<{ requestId: string; text: string; attachments: string } | null>(null);
  const ta = inputRef;
  useEffect(() => {if (draft && visible && ta.current) ta.current.focus();}, [draft, visible]);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el || !visible) return;
    // The sidebar animates from its collapsed width. Measure again as it opens,
    // otherwise a placeholder measured at 20px wide leaves an empty 180px box.
    let width = -1;
    const measure = () => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      el.style.height = '0px';
      el.style.height = `${Math.min(180, el.scrollHeight)}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [draft, visible]);
  const typedCommand = draft.startsWith("/") && !draft.includes(" ") && !draft.includes("\n");
  const matches = typedCommand
    ? COMMANDS.filter((c) => c.cmd.startsWith(draft.toLowerCase()) || c.title.includes(draft.slice(1)))
    : COMMANDS;
  const showPalette = palette && matches.length > 0;
  const remember = (text: string) => setState((s) => ({ history: [text, ...s.history.filter((h) => h !== text)].slice(0, 40) }));
  const send = async (override?: string, preserveDraft = false) => {
    const text = (override ?? draft).trim();
    if (!text || replay || sending || commandBusy || !connected) return;
    const attachments = preserveDraft ? [] : getState().attachments;
    const serialized = JSON.stringify(attachments);
    if (!pendingSend.current || pendingSend.current.text !== text || pendingSend.current.attachments !== serialized) pendingSend.current = { requestId: crypto.randomUUID(), text, attachments: serialized };
    setSending(true);
    setSendError("");
    setPalette(false);
    setWalk(null);
    if (!preserveDraft) setState({ draft: "", attachments: [] });
    remember(text);
    try { await actions.chat(text, attachments, { requestId: pendingSend.current.requestId, mode: live ? mode : "steer" }); pendingSend.current = null; }
    catch {
      setSendError("消息未确认送达，内容已保留。再次发送时会核验接收记录，避免重复执行。");
      setState((s) => ({ draft: s.draft || text, attachments: [...s.attachments, ...attachments.filter((a) => !s.attachments.some((b) => b.type === a.type && b.id === a.id))] }));
    } finally { setSending(false); }
  };
  const run = async (command: Command) => {
    const local = command.run === 'steer' || command.run === 'followUp' || command.run === 'clear';
    if (sending || commandBusy || (!local && (!connected || replay))) return;
    setPalette(false);
    if (command.send) { await send(command.send, !typedCommand); return; }
    if (typedCommand) setState({ draft: "" });
    setCommandBusy(true);
    try {
      if (command.run === "abort") await actions.abortChat();
      else if (command.run === "continue") await actions.continueChat();
      else if (command.run === "pause") await actions.run("pause");
      else if (command.run === "play") await actions.run("resume");
      else if (command.run === "steer") setMode("steer");
      else if (command.run === "followUp") setMode("followUp");
      else if (command.run === "clear") setState({ draft: "", attachments: [] });
    } catch { if (typedCommand) setState(s => ({ draft: s.draft || draft })); }
    finally { setCommandBusy(false); }
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (showPalette) {
      if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => (c + 1) % matches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => (c - 1 + matches.length) % matches.length); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); void run(matches[Math.min(cursor, matches.length - 1)]); return; }
      if (e.key === "Escape") { e.preventDefault(); setPalette(false); return; }
    }
    if (e.key === "Escape") return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); return; }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && history.length && !draft.includes("\n")) {
      if ((draft && (walk === null || draft !== history[walk])) || (walk === null && e.key === 'ArrowDown')) return;
      e.preventDefault();
      const next = e.key === "ArrowUp" ? (walk === null ? 0 : Math.min(walk + 1, history.length - 1)) : walk === null || walk <= 0 ? null : walk - 1;
      setWalk(next);
      setState({ draft: next === null ? "" : history[next] ?? "" });
    }
  };
  const evidence = atts.filter((a) => a.type === "evidence");
  const others = atts.filter((a) => a.type !== "evidence");
  const groupEvidence = evidence.length > 3 && !expanded;
  const stop = async () => { setStopping(true); try { await actions.abortChat(); } catch { /* API displays the reason. */ } finally { setStopping(false); } };
  return (
    <div className="composer">
      {sendError && <p className="composer-feedback" role="status">{sendError}</p>}
      <div className="composer-box">
        {showPalette && (
          <div id="composer-commands" className="cmd-palette" role="listbox" aria-label="命令">
            {matches.map((c, i) => (
              <button key={c.cmd} role="option" aria-selected={i === Math.min(cursor, matches.length - 1)}
                className={i === Math.min(cursor, matches.length - 1) ? "is-on" : ""}
                disabled={sending || commandBusy || ((!connected || Boolean(replay)) && !['steer', 'followUp', 'clear'].includes(c.run ?? ''))}
                onMouseEnter={() => setCursor(i)} onClick={() => void run(c)}>
                <code>{c.cmd}</code>
                <span className="cmd-title">{c.title}</span>
                <span className="cmd-hint">{c.hint}</span>
              </button>
            ))}
          </div>
        )}
        <div className="att-strip">
          {atts.length > 0 ? (
            <>
              {groupEvidence ? (
                <span className="att att--group" onClick={() => setExpanded(true)} data-tip="展开逐张移除">
                  <span className="stack">{evidence.slice(0, 3).map((a) => a.thumb ? <img key={a.id} src={a.thumb} alt="" /> : null)}</span>
                  <span className="att-label">证据卡 ×{evidence.length}</span>
                  <button className="att-x" aria-label="移除全部证据附件" onClick={(e) => { e.stopPropagation(); setState({ attachments: others }); }}><X size={12} /></button>
                </span>
              ) : evidence.map((a) => <AttChip key={a.id} a={a} onRemove={() => detach(a.type, a.id)} />)}
              {others.map((a) => <AttChip key={`${a.type}:${a.id}`} a={a} onRemove={() => detach(a.type, a.id)} />)}
            </>
          ) : null}
        </div>
        <textarea
          ref={ta}
          value={draft}
          placeholder={replay ? "回放中的对话只读" : live ? "补充要求，或安排后续任务…" : "给主调度布置任务…"}
          aria-label="给主调度的消息"
          aria-describedby="composer-shortcuts"
          disabled={Boolean(replay)}
          onChange={(e) => { setState({ draft: e.target.value }); setPalette(e.target.value.startsWith("/")); setCursor(0); setWalk(null); }}
          onKeyDown={onKeyDown}
          rows={1}
        />
        <div className="composer-foot">
          <div className="composer-tools">
            <button className="icon-btn composer-attach" disabled={Boolean(replay)} aria-label="选择证据附件" data-tip="从证据板选择附件" onClick={() => setState({ view: "board" })}><ImageIcon size={15} /></button>
            <button className={`composer-cmd${showPalette ? ' is-open' : ''}`} aria-label="命令" aria-expanded={showPalette} aria-controls="composer-commands" onClick={() => { setPalette(!showPalette); setCursor(0); ta.current?.focus(); }} data-tip="命令 · 也可以输入 /"><Slash size={12} /><span>命令</span></button>
          </div>
          {live && <select className="composer-delivery" aria-label="消息送达方式" value={mode} onChange={e => setMode(e.target.value as "steer" | "followUp")}><option value="steer">立即补充</option><option value="followUp">完成后跟进</option></select>}
          <div className="composer-actions">
            {live && <button className="send send--stop" disabled={stopping || !connected || Boolean(replay)} onClick={() => void stop()} aria-label="停止当前回答" data-tip="停止当前回答，流水线任务保留">{stopping ? <Loader2 size={13} className="spin-i" /> : <Square size={12} />}</button>}
            {(!live || draft.trim() || sending) && <button className="send" disabled={!draft.trim() || Boolean(replay) || sending || commandBusy || !connected} onClick={() => void send()} aria-label={live ? mode === "steer" ? "发送补充要求" : "安排后续跟进" : "发送消息"} data-tip={live ? mode === "steer" ? "发送补充要求" : "安排后续跟进" : "发送"}>{sending ? <Loader2 size={15} className="spin-i" /> : <ArrowUp size={16} />}</button>}
          </div>
        </div>
      </div>
      <div className="composer-meta" id="composer-shortcuts">
        <span>{replay ? '只读回放' : !connected ? '连接恢复后可发送' : commandBusy ? '正在执行命令…' : <><kbd>↵</kbd> 发送 <i>·</i> <kbd>Shift ↵</kbd> 换行</>}</span>
        <span className="composer-history-hint" data-tip="空输入时 ↑ 查看上一条消息；Esc 收起命令，草稿保留">↑ 历史</span>
      </div>
    </div>
  );
}
