import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type {Attachment, StationAgentBinding} from './types.ts';
import {compactReport} from './report-summary.ts';

/** Pi's native ordered message stream, without system prompts or binary attachments. */
export type PiMessage = Exclude<Message, { role: "system" }>;
export interface ConversationEntry { id: string; turn: string; message: PiMessage; attachments?: Attachment[] }

export const TOOL_MESSAGE_BYTES = 32 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const compactedMessages = new WeakMap<object, PiMessage>();

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function excerpt(text: string, bytes: number): string {
  const encoded = encoder.encode(text);
  return encoded.length <= bytes ? text : decoder.decode(encoded.subarray(0, bytes)) + '\n[后续内容省略]';
}

/** Project oversized tool replies without modifying the durable original. */
export function compactToolMessage(message: PiMessage): PiMessage {
  if (message.role !== 'toolResult') return message;
  const cached = compactedMessages.get(message);
  if (cached) return cached;
  const originalBytes = encoder.encode(JSON.stringify(message)).length;
  if (originalBytes <= TOOL_MESSAGE_BYTES) return message;
  const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  let value: unknown;
  try { value = JSON.parse(text); } catch { /* Plain-text tools also receive an explicit excerpt. */ }
  const report = record(value) && value.tool === 'read_report' ? compactReport(value.result) : undefined;
  let projected: Record<string, unknown>;
  if (report && record(value)) {
    projected = {ok: value.ok, tool: value.tool, summary: value.summary, seq: value.seq, runId: value.runId,
      result: report, contextProjection: {originalBytes, completeResultInJournal: true}};
  } else {
    projected = {
      ...(record(value) ? Object.fromEntries(['ok', 'tool', 'summary', 'seq', 'runId', 'code']
        .filter(key => ['string', 'number', 'boolean'].includes(typeof value[key]))
        .map(key => [key, typeof value[key] === 'string' ? excerpt(value[key], 1024) : value[key]])) : {}),
      partial: true, originalBytes,
      note: '工具返回过长，下面仅为摘录，不能视为完整数据。原始回执保存在日志；请按具体任务、工位或 attempt 读取详情，不要重复已完成的写操作。',
      excerpt: excerpt(text, 12 * 1024),
    };
  }
  const compacted: PiMessage = {role: 'toolResult', toolCallId: message.toolCallId,
    toolName: message.toolName, timestamp: message.timestamp, isError: message.isError,
    content: [{type: 'text', text: JSON.stringify(projected)}],
    details: {summary: '工具结果摘要；完整回执保留在日志', compacted: true, originalBytes}};
  for (let budget = 8192; encoder.encode(JSON.stringify(compacted)).length > TOOL_MESSAGE_BYTES; budget /= 2) {
    compacted.content = [{type: 'text', text: JSON.stringify({partial: true, originalBytes,
      note: '这里只是有界摘录；完整原始回执保存在日志，请按任务或 attempt 读取。',
      excerpt: excerpt(text, Math.max(256, budget))})}];
    if (budget <= 256) break;
  }
  compactedMessages.set(message, compacted);
  return compacted;
}

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
