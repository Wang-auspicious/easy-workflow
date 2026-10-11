import type { ConversationEntry, PiMessage } from "../../../shared/conversation.ts";
import type { Attachment } from "../../../shared/types.ts";
import type { DispatcherStatus, LiveChat } from "./live.ts";

export interface FailureNotice { label: string; detail: string; recovering: boolean }
export type DisplayMessage = PiMessage & { h2Attachments?: Attachment[]; h2Failure?: FailureNotice | null };

const failed = (message: PiMessage) => message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted");

/** Annotate the view, keeping the native Pi journal and tool/result pairs intact. */
export function conversationView(entries: ConversationEntry[], live: LiveChat, dispatcher: DispatcherStatus) {
  const start = entries.length > 200 ? entries.findIndex((e, i) => i >= entries.length - 200 && e.message.role === "user") : 0;
  const shown = entries.slice(Math.max(0, start));
  const partial = live.message && !entries.some(e => e.id === live.messageId);
  if (partial) shown.push({ id: live.messageId ?? "live", turn: live.id ?? dispatcher.turn, message: live.message! });
  const lastFailure = new Map<string, number>();
  shown.forEach((entry, index) => { if (failed(entry.message)) lastFailure.set(entry.turn, index); });
  const messages: DisplayMessage[] = shown.map((entry, index) => {
    const message: DisplayMessage = { ...entry.message, ...(entry.attachments?.length ? { h2Attachments: entry.attachments } : {}) };
    if (!failed(message)) return message;
    message.h2Failure = null;
    // A provider can emit aborted and then an error for the same interruption.
    // Show one explanation, preserving both recorded messages and their content.
    if (lastFailure.get(entry.turn) !== index) return message;
    const current = entry.turn === dispatcher.turn;
    const recovered = shown.slice(index + 1).some(e => e.turn === entry.turn && e.message.role === "assistant" && e.message.stopReason === "stop") || current && dispatcher.status === "completed";
    const recovering = current && dispatcher.busy;
    const details = [...new Set(shown.filter(e => e.turn === entry.turn && failed(e.message)).map(e => e.message.role === "assistant" ? e.message.errorMessage : "").filter(Boolean))].join("\n");
    message.h2Failure = {
      label: recovered ? "连接中断后已恢复" : recovering ? "响应中断，主调度正在恢复" : current && dispatcher.status === "aborted" ? "本次回答已由你停止" : "回答在此中断，已有内容已保留",
      detail: details,
      recovering,
    };
    return message;
  });
  const completed = new Set(messages.filter(m => m.role === "toolResult").map(m => m.toolCallId));
  const currentCalls = shown.filter(e => e.turn === live.id).flatMap(e => e.message.role === "assistant" ? e.message.content.filter(c => c.type === "toolCall") : []);
  return {
    messages,
    streamingMessage: partial && live.id ? messages[messages.length - 1] : undefined,
    pendingToolCalls: new Set(live.id ? currentCalls.filter(c => !completed.has(c.id)).map(c => c.id) : []),
  };
}
