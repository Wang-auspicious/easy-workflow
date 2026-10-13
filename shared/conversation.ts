import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type {Attachment, StationAgentBinding} from './types.ts';

/** Pi's native ordered message stream, without system prompts or binary attachments. */
export type PiMessage = Exclude<Message, { role: "system" }>;
export interface ConversationEntry { id: string; turn: string; message: PiMessage; attachments?: Attachment[] }

export interface DispatcherStatus {
  turn: string;
  status: "idle" | "running" | "recovering" | "interrupted" | "failed" | "completed" | "aborted";
  busy: boolean;
  attempt: number;
  maxAttempts: number;
  recoverable: boolean;
  message: string;
  updatedAt: number;
  nextRetryAt?: number;
  error?: string;
}

/** Private recovery metadata; native messages and user input remain in the journal. */
export interface DispatcherCheckpoint {
  agent?: StationAgentBinding;
  state: DispatcherStatus;
  prompted: boolean;
  messageNumber: number;
  request: { text: string; attachments: Attachment[] };
  scope: string;
  inputs: { id: string; text: string; attachments: Attachment[]; timestamp: number; delivered: boolean; mode: "steer" | "followUp" }[];
  operations: {
    key: string; scope: string; callId: string; name: string; phase: "started" | "completed" | "uncertain";
    result?: { content: { type: "text"; text: string }[]; details: Record<string, unknown> };
  }[];
}

export function legacyReply(text: string, timestamp: number): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp,
    api: "openai-completions", provider: "legacy", model: "legacy", stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

export function transcriptMessage(message: PiMessage): PiMessage {
  const copy = structuredClone(message);
  if (Array.isArray(copy.content)) copy.content = copy.content.map((part) => part.type === "image"
    ? { type: "text" as const, text: "[图像见证据附件]" } : part) as typeof copy.content;
  return copy;
}
