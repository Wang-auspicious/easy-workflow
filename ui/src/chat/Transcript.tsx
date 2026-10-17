// 右侧栏的对话渲染，参考 Grok Bot 的转录样式：每行一只小人 + 说的人 + 时间 + 状态，
// 正文是可折叠的思考、工具卡片和 Markdown。渲染在 shadow root 里，复用 pi-web-ui 的
// markdown-block / code-block（marked + DOMPurify），模型文本始终按不可信内容处理。
//
// 数据来自 transcript.ts；这里只负责显示和展开交互。
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, GitFork, Info, Wrench, Loader2, Check, X, ChevronsDownUp, ChevronsUpDown, Copy } from "lucide-react";
import type { ConversationEntry } from "../../../shared/conversation.ts";
import type { ChatMessage } from "../../../shared/project.ts";
import { getState, setState, useStore } from "../store.ts";
import { toggleInspector } from "../canvas/Canvas.tsx";
import { Avatar, STATE_TEXT, grokShape } from "./Avatar.tsx";
import { buildTranscript, DISPATCHER_HUE, type TranscriptItem, type TranscriptPart } from "./transcript.ts";
import { stationLook } from "./station-look.ts";
import { USER_AVATARS, userAvatarSrc } from "./user-avatars.ts";
import { useNow } from "../util/useNow.ts";
import { CorrectionUndo } from '../board/CorrectionUndo.tsx';
import type { DispatcherStatus, LiveChat } from "./live.ts";
import "./PiBlocks.ts";
import base from "./pi-conversation.css?inline";
import styles from "./transcript.css?inline";
import avatar from "./avatar.css?inline";
import correctionStyles from '../board/correction.css?inline';

export function Transcript({ entries, live, dispatcher, onResize }: {
  entries: ConversationEntry[]; live: LiveChat; dispatcher: DispatcherStatus; onResize: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [picker, setPicker] = useState(false);
  const pick = (id?: string) => { if (id) { setState({ userAvatar: id }); setPicker(false); } else setPicker((p) => !p); };
  /** null = 每张卡片各记各的；true/false = 全部展开 / 全部收起。 */
  const [toolsOpen, setToolsOpen] = useState<boolean | null>(null);
  useStore((s) => s.version);
  const kernel = useStore(state => state.replay ? 'v1' : state.kernel);
  const now = useNow(2000);
  const state = getState();
  const items = useMemo(
    () => buildTranscript({
      // 主调度这一格只放你和主调度的对话；工位的播报在各自的群和画布上。
      entries, live, dispatcher, notes: [], factory: state.factory, station: stationLook(state.factory, state.fs, state.layout.bots, now),
    }),
    [entries, entries.length, live, dispatcher, state.fs.activity, state.factory, state.version, now, kernel],
  );
  const tools = items.reduce((n, item) => n + (item.parts?.filter((p) => p.type === "tool").length ?? 0), 0);
  useLayoutEffect(() => {
    const el = host.current!;
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    const sheet = document.createElement("style");
    sheet.textContent = `${base}\n${styles}\n${avatar}\n${correctionStyles}`;
    const slot = document.createElement("div");
    slot.className = "tr-root";
    shadow.replaceChildren(sheet, slot);
    setContainer(slot);
    const observer = new ResizeObserver(onResize);
    observer.observe(el);
    return () => { observer.disconnect(); shadow.replaceChildren(); };
  }, [onResize]);
  return (
    <>
      <div className="pi-conversation" ref={host} aria-label="与 Easy Workflow 主调度的对话" />
      {container ? createPortal(
        <div className="tr">
          {tools > 0 && (
            <div className="tr-bar">
              <span className="muted">{tools} 次工具调用</span>
              <span className="grow" />
              <button className="tr-bar-btn" onClick={() => setToolsOpen(toolsOpen === false ? true : false)}>
                {toolsOpen === false ? <ChevronsUpDown size={12} /> : <ChevronsDownUp size={12} />}
                {toolsOpen === false ? "全部展开" : "全部收起"}
              </button>
            </div>
          )}
          {items.map((item) => (
            <Row key={item.id} item={item} toolsOpen={toolsOpen}
              picker={picker && item.actor.kind === "user"} onPick={pick} />
          ))}
        </div>, container) : null}
    </>
  );
}


const time = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

function Row({ item, toolsOpen, picker, onPick }: {
  item: TranscriptItem; toolsOpen: boolean | null; picker: boolean; onPick: (id?: string) => void;
}) {
  const station = item.actor.kind === "station";
  const me = item.actor.kind === "user";
  const userAvatar = useStore((s) => s.userAvatar);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const copyText = (item.parts ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n\n');
  const copy = async () => {
    try {await navigator.clipboard.writeText(copyText); setCopied(true); setCopyError('');}
    catch {setCopyError('复制失败，可选中文字手动复制');}
  };
  const open = () => { const key = item.actor.node; if (!key) return; setState({ view: "canvas" }); toggleInspector(key); };
  return (
    <article className={`tr-row tr-row--${item.actor.kind}${item.tone ? ` tr-row--${item.tone}` : ""}`} style={{ ["--hue" as string]: item.actor.hue }}>
      <div className="tr-av">
        {me ? (
          <span className="tr-av-pick">
            <button onClick={() => onPick()} data-tip="换一张你的头像" aria-label="换一张你的头像" aria-expanded={picker}>
              <img src={userAvatarSrc(userAvatar)} alt="" draggable={false} />
            </button>
            {picker && (
              <span className="tr-av-menu" role="menu">
                <span className="tr-av-menu-title">选一张你的头像</span>
                {USER_AVATARS.map((a) => (
                  <button key={a.id} role="menuitemradio" aria-checked={a.id === userAvatar} className={a.id === userAvatar ? "is-on" : ""}
                    onClick={() => onPick(a.id)} title={a.hint}>
                    <img src={userAvatarSrc(a.id)} alt="" draggable={false} />
                    <span>{a.name}</span>
                  </button>
                ))}
              </span>
            )}
          </span>
        ) : (
          <Avatar shape={item.actor.shape} hue={item.actor.hue} state={item.actor.state} size={34} title={`${item.actor.name} · ${STATE_TEXT[item.actor.state]}`} />
        )}
      </div>
      <div className="tr-main">
        <header className="tr-head">
          {station
            ? <button className="tr-who tr-who--link" onClick={open} data-tip="在画布上打开这个工位">{item.actor.name}</button>
            : <b className="tr-who">{item.actor.name}</b>}
          <time className="tr-time num">{time(item.at)}</time>
          {!me && <span className={`tr-state tr-state--${item.actor.state}`}>{STATE_TEXT[item.actor.state]}</span>}
          {item.tone === "fork" && <GitFork size={11} className="tr-tone" />}
          {item.tone === "warn" && <AlertTriangle size={11} className="tr-tone" />}
          {item.tone === "info" && station && <Info size={11} className="tr-tone" />}
        </header>
        {item.notice !== undefined
          ? <p className="tr-notice">{item.notice}</p>
          : (item.parts ?? []).map((part, i) => (
            <Part key={i} part={part} toolsOpen={toolsOpen} streaming={Boolean(item.streaming) && i === (item.parts?.length ?? 0) - 1} />
          ))}
        {copyText && !item.streaming && <div className="tr-actions"><button onClick={() => void copy()} aria-label="复制消息">{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? '已复制' : '复制'}</button>{me && <button onClick={() => {setState({draft: copyText}); window.dispatchEvent(new Event('easy:focus-composer'));}}>再次编辑</button>}{copyError && <small role="status">{copyError}</small>}</div>}
      </div>
    </article>
  );
}

function Part({ part, streaming, toolsOpen }: { part: TranscriptPart; streaming?: boolean; toolsOpen: boolean | null }) {
  if (part.type === 'text') return <TextPart text={part.text} streaming={streaming} />;
  if (part.type === "attachments") {
    return <div className="tr-atts">{part.items.map((a) => <span key={`${a.type}:${a.id}`} className="tr-att" title={a.label}>{a.label}</span>)}</div>;
  }
  if (part.type === "thinking") {
    return (
      <details className="tr-think" open={part.streaming}>
        <summary><span className={`tr-arrow${part.streaming ? " is-live" : ""}`}>›</span><span className={part.streaming ? "is-live" : ""}>思考过程</span></summary>
        {/* 内部滚动：思考再长也只占一小块，不把整屏推开。 */}
        <div className="tr-think-body"><Markdown text={part.text} /></div>
      </details>
    );
  }
  if (part.type === "failure") {
    return <div className="pi-turn-notice" role="status"><span>{part.label}</span>
      {part.detail ? <details><summary>技术详情</summary><pre>{part.detail}</pre></details> : null}</div>;
  }
  return <ToolCard part={part} toolsOpen={toolsOpen} />;
}

function TextPart({text, streaming}: {text: string; streaming?: boolean}) {
  const [expanded, setExpanded] = useState(false);
  const long = !streaming && text.length > 650;
  return <div className="tr-text-group"><div className={`tr-text${streaming ? ' is-streaming' : ''}${long && !expanded ? ' is-folded' : ''}`}><Markdown text={text} /></div>
    {long && <button className="tr-read-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起长消息' : `展开完整消息 · ${text.length.toLocaleString()} 字`}</button>}</div>;
}

/** 工具卡片：默认收起；报错也不自动展开，只在摘要下面留一行原因。 */
function ToolCard({ part, toolsOpen }: { part: Extract<TranscriptPart, { type: "tool" }>; toolsOpen: boolean | null }) {
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {if (toolsOpen !== null) setOpen(toolsOpen);}, [toolsOpen]);
  const isOpen = open;
  const Icon = part.status === "pending" ? Loader2 : part.status === "error" ? X : Check;
  const reason = part.detail ?? (part.status === "error" ? firstLine(part.result) : "");
  return (
    <div className={`tr-tool-wrap tr-tool--${part.status}`}>
      <details className="tr-tool" open={isOpen}>
        <summary onClick={event => {event.preventDefault(); setOpen(!open);}}>
          <span className={`tr-tool-status${part.status === "pending" ? " spin-i" : ""}`}><Icon size={12} /></span>
          <Wrench size={11} className="tr-tool-wrench" />
          <span className="tr-tool-name">{part.label}</span>
          <span className="tr-tool-state">{part.status === "pending" ? "执行中" : part.status === "error" ? "未返回" : "完成"}</span>
        </summary>
        <div className="tr-tool-body">
          <span className="tr-label">调用参数</span>
          <Code code={part.args || "{}"} />
          {part.result !== undefined ? <><span className="tr-label">返回结果</span><Code code={part.result} /></> : null}
        </div>
      </details>
      {/* 收起时也要能看到原因，所以放在 details 外面（details 收起时内容不显示）。 */}
      {reason && !isOpen ? <p className="tr-tool-reason">{reason}</p> : null}
      {part.correction && <CorrectionUndo id={part.correction} />}
    </div>
  );
}

const firstLine = (text?: string) => {
  const line = (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
};

/** Lit 组件的属性只能通过实例赋值，用 ref 同步，避免 React 把它当成属性字符串。 */
function bindProp(el: HTMLElement | null, prop: "content" | "code", value: string) {
  if (!el) return;
  if (!el.hasAttribute("data-upgraded") && customElements.get(el.localName)) {
    customElements.upgrade(el);
    el.setAttribute("data-upgraded", "");
  }
  (el as unknown as Record<string, unknown>)[prop] = value;
}
function Markdown({ text }: { text: string }) {
  return <markdown-block ref={(el: HTMLElement | null) => bindProp(el, "content", text)} />;
}
function Code({ code }: { code: string }) {
  return <code-block ref={(el: HTMLElement | null) => bindProp(el, "code", code)} />;
}

export { DISPATCHER_HUE, grokShape };
