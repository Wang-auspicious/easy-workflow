// 右侧栏的对话渲染，参考 Grok Bot 的转录样式：每行一只小人 + 说的人 + 时间 + 状态，
// 正文是可折叠的思考、工具卡片和 Markdown。渲染在 shadow root 里，复用 pi-web-ui 的
// markdown-block / code-block（marked + DOMPurify），模型文本始终按不可信内容处理。
//
// 数据来自 transcript.ts；这里只负责显示和展开交互。
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, GitFork, Info, Wrench, Loader2, Check, X, User } from "lucide-react";
import type { CompiledFactory, Role } from "../../../shared/types.ts";
import type { ConversationEntry } from "../../../shared/conversation.ts";
import type { ChatMessage } from "../../../shared/project.ts";
import { getState, setState, useStore } from "../store.ts";
import { botFor } from "../../../shared/palette.ts";
import { botState } from "../canvas/Node.tsx";
import { toggleInspector } from "../canvas/Canvas.tsx";
import { Avatar, STATE_TEXT, grokShape } from "./Avatar.tsx";
import { buildTranscript, DISPATCHER_HUE, type AvatarState, type TranscriptItem, type TranscriptPart } from "./transcript.ts";
import { useNow } from "../util/useNow.ts";
import type { DispatcherStatus, LiveChat } from "./live.ts";
import "./PiBlocks.ts";
import base from "./pi-conversation.css?inline";
import styles from "./transcript.css?inline";
import avatar from "./avatar.css?inline";

export function Transcript({ entries, live, dispatcher, onResize }: {
  entries: ConversationEntry[]; live: LiveChat; dispatcher: DispatcherStatus; onResize: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useStore((s) => s.version);
  const now = useNow(2000);
  const state = getState();
  const items = useMemo(
    () => buildTranscript({
      entries, live, dispatcher, notes: state.fs.activity, factory: state.factory, station: stationLook(state.factory, state.layout.bots, now),
    }),
    [entries, entries.length, live, dispatcher, state.fs.activity, state.factory, state.version, now],
  );
  useLayoutEffect(() => {
    const el = host.current!;
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    const sheet = document.createElement("style");
    sheet.textContent = `${base}\n${styles}\n${avatar}`;
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
      {container ? createPortal(<div className="tr">{items.map((item) => <Row key={item.id} item={item} />)}</div>, container) : null}
    </>
  );
}

/** 工位小人：形状与颜色取自画布上的同一只（botFor），动作取自 Node.tsx 的 botState。 */
function stationLook(factory: CompiledFactory | null, bots: Record<string, number>, now: number) {
  return (key: string) => {
    const node = factory?.nodes.find((n) => n.key === key);
    if (!node) return undefined;
    const s = getState();
    const n = s.fs.nodes[key];
    const wired = factory?.lines.find((l) => l.id === node.line)?.wired;
    const state: AvatarState = botState(n, Boolean(node.dormant) || (!wired && node.kind !== "store"), now, s.fs.resources.waiting?.[key]);
    const look = botFor(key, node.role as Role, bots[key] !== undefined ? { seed: bots[key] } : undefined);
    return { shape: look.shape, hue: look.hue, state };
  };
}

const time = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

function Row({ item }: { item: TranscriptItem }) {
  const station = item.actor.kind === "station";
  const open = () => { const key = item.actor.node; if (!key) return; setState({ view: "canvas" }); toggleInspector(key); };
  return (
    <article className={`tr-row tr-row--${item.actor.kind}${item.tone ? ` tr-row--${item.tone}` : ""}`} style={{ ["--hue" as string]: item.actor.hue }}>
      <div className="tr-av">
        {item.actor.kind === "user"
          ? <span className="tr-av-user" title="你"><User size={15} /></span>
          : <Avatar shape={item.actor.shape} hue={item.actor.hue} state={item.actor.state} size={34} title={`${item.actor.name} · ${STATE_TEXT[item.actor.state]}`} />}
      </div>
      <div className="tr-main">
        <header className="tr-head">
          {station
            ? <button className="tr-who tr-who--link" onClick={open} data-tip="在画布上打开这个工位">{item.actor.name}</button>
            : <b className="tr-who">{item.actor.name}</b>}
          <time className="tr-time num">{time(item.at)}</time>
          {item.actor.kind !== "user" && <span className={`tr-state tr-state--${item.actor.state}`}>{STATE_TEXT[item.actor.state]}</span>}
          {item.tone === "fork" && <GitFork size={11} className="tr-tone" />}
          {item.tone === "warn" && <AlertTriangle size={11} className="tr-tone" />}
          {item.tone === "info" && station && <Info size={11} className="tr-tone" />}
        </header>
        {item.notice !== undefined
          ? <p className="tr-notice">{item.notice}</p>
          : (item.parts ?? []).map((part, i) => <Part key={i} part={part} streaming={Boolean(item.streaming) && i === (item.parts?.length ?? 0) - 1} />)}
      </div>
    </article>
  );
}

function Part({ part, streaming }: { part: TranscriptPart; streaming?: boolean }) {
  if (part.type === "text") return <div className={`tr-text${streaming ? " is-streaming" : ""}`}><Markdown text={part.text} /></div>;
  if (part.type === "attachments") {
    return <div className="tr-atts">{part.items.map((a) => <span key={`${a.type}:${a.id}`} className="tr-att" title={a.label}>{a.label}</span>)}</div>;
  }
  if (part.type === "thinking") {
    return (
      <details className="tr-think" open={part.streaming}>
        <summary><span className={`tr-arrow${part.streaming ? " is-live" : ""}`}>›</span><span className={part.streaming ? "is-live" : ""}>思考过程</span></summary>
        <Markdown text={part.text} />
      </details>
    );
  }
  if (part.type === "failure") {
    return <div className="pi-turn-notice" role="status"><span>{part.label}</span>
      {part.detail ? <details><summary>技术详情</summary><pre>{part.detail}</pre></details> : null}</div>;
  }
  const Icon = part.status === "pending" ? Loader2 : part.status === "error" ? X : Check;
  return (
    <details className={`tr-tool tr-tool--${part.status}`} open={part.status === "error"}>
      <summary>
        <span className={`tr-tool-status${part.status === "pending" ? " spin-i" : ""}`}><Icon size={12} /></span>
        <Wrench size={11} className="tr-tool-wrench" />
        <span className="tr-tool-name">{part.label}</span>
        <span className="tr-tool-state">{part.status === "pending" ? "执行中" : part.status === "error" ? "未返回" : "完成"}</span>
      </summary>
      <div className="tr-tool-body">
        <span className="tr-label">调用参数</span>
        <Code code={part.args || "{}"} />
        {part.result !== undefined ? <><span className="tr-label">返回结果</span><Code code={part.result} /></> : null}
        {part.detail ? <p className="tr-tool-note">{part.detail}</p> : null}
      </div>
    </details>
  );
}

/** Lit 组件的属性只能通过实例赋值，用 ref 同步，避免 React 把它当成属性字符串。 */
/**
 * 自定义元素可能还没升级完成（PiBlocks.ts 的 define 晚于 React 首次渲染）。
 * 直接把值写成普通属性会被随后的 upgrade 忽略，所以先 upgrade，再落到 Lit 的访问器上。
 */
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
