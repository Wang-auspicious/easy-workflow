import type { DispatcherStatus, PiMessage } from "../../../shared/conversation.ts";
export type { DispatcherStatus } from "../../../shared/conversation.ts";

export interface LiveChat {
  id: string | null;
  text: string;
  messageId?: string;
  message?: PiMessage | null;
  tools: { name: string; status: string; summary?: string }[];
}

export interface ChatEvent {
  kind: string;
  id?: string;
  turn?: string;
  message?: PiMessage | null;
  delta?: string;
  name?: string;
  status?: string;
  summary?: string;
}

export const emptyLive = (): LiveChat => ({ id: null, text: "", tools: [] });

export const idleDispatcher = (): DispatcherStatus => ({ turn: "", status: "idle", attempt: 0, maxAttempts: 0, message: "", recoverable: false, busy: false, updatedAt: 0 });

/** Reconnection receives the server's current status, including when chat.end was missed. */
export function reconcileChatLive(live: LiveChat, state: DispatcherStatus): LiveChat {
  if (state.busy && state.turn !== live.id) return { ...emptyLive(), id: state.turn };
  return { ...live, id: state.busy ? state.turn : null, tools: state.busy ? live.tools : [] };
}

/** Transient Pi messages complement, but never replace, the journal transcript. */
export function reduceChatLive(live: LiveChat, e: ChatEvent): LiveChat {
  if (e.kind === 'chat.reset') {
    if (e.turn && live.id && e.turn !== live.id) return live;
    // A catch-up snapshot replaces lossy activity indicators. Keep the last Pi
    // message until its durable journal event reaches the projection frame.
    return { ...live, text: '', tools: [] };
  }
  if (e.kind === "chat.start") return live.id === e.id ? live : { id: e.id ?? "x", text: "", tools: [] };
  if (e.kind === "chat.pi") {
    if (live.id && e.turn && live.id !== e.turn) return live;
    // Persisted events are applied on the next animation frame. Keep the last
    // snapshot until the transcript can match it by id to the journal entry.
    return e.message ? { ...live, id: e.turn ?? live.id, messageId: e.id, message: e.message } : live;
  }
  if (e.kind === "chat.delta") return { ...live, text: live.text + (e.delta ?? "") };
  if (e.kind === "chat.tool") {
    const tools = e.status === "start" ? [...live.tools, { name: e.name!, status: "start" }] : live.tools.map((t, i) => (i === live.tools.map((x) => x.name).lastIndexOf(e.name!) ? { ...t, status: "end", summary: e.summary } : t));
    return { ...live, tools };
  }
  if (e.kind === "chat.end") return e.id && live.id && e.id !== live.id ? live : { ...live, id: null, tools: [] };
  return live;
}
