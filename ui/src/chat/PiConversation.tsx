import { useLayoutEffect, useRef } from "react";
import type { ConversationEntry, PiMessage } from "../../../shared/conversation.ts";
import type { LiveChat } from "../store.ts";
import "./PiBlocks.ts";
import "../vendor/pi-web-ui/components/Messages.js";
import "../vendor/pi-web-ui/components/MessageList.js";
import styles from "./pi-conversation.css?inline";

type PiList = HTMLElement & { messages: PiMessage[]; pendingToolCalls: Set<string>; streamingMessage?: PiMessage; requestUpdate(): void };

export function PiConversation({ entries, live, onResize }: { entries: ConversationEntry[]; live: LiveChat; onResize: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const list = useRef<PiList | null>(null);
  useLayoutEffect(() => {
    const root = host.current!.shadowRoot ?? host.current!.attachShadow({ mode: "open" });
    const sheet = document.createElement("style"); sheet.textContent = styles;
    const messages = document.createElement("message-list") as PiList;
    root.replaceChildren(sheet, messages); list.current = messages;
    const observer = new ResizeObserver(onResize); observer.observe(host.current!);
    return () => { observer.disconnect(); list.current = null; root.replaceChildren(); };
  }, [onResize]);
  useLayoutEffect(() => {
    if (!list.current) return;
    // Never cut through a turn: the tool result must remain paired with its call.
    const start = entries.length > 200 ? entries.findIndex((e, i) => i >= entries.length - 200 && e.message.role === "user") : 0;
    const messages = entries.slice(Math.max(0, start)).map(e => e.attachments?.length ? { ...e.message, h2Attachments: e.attachments } : e.message);
    const streaming = live.message && !entries.some(e => e.id === live.messageId) ? live.message : undefined;
    if (streaming) messages.push(streaming);
    const completed = new Set(messages.filter(m => m.role === "toolResult").map(m => m.toolCallId));
    const current = entries.filter(e => e.turn === live.id).flatMap(e => e.message.role === "assistant" ? e.message.content.filter(c => c.type === "toolCall") : []);
    list.current.streamingMessage = streaming;
    list.current.pendingToolCalls = new Set(live.id ? current.filter(c => !completed.has(c.id)).map(c => c.id) : []);
    list.current.messages = messages;
    list.current.requestUpdate();
  }, [entries, entries.length, live]);
  return <div className="pi-conversation" ref={host} aria-label="与 Easy Workflow 主调度的对话" />;
}
