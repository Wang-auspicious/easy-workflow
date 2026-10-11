// 对话面板的数据层：把日志里的原生 Pi 消息、流式回答和工位提示整理成一行行可渲染的条目。
// 只做整理与判定，不碰 DOM，方便单测（ui/test/transcript.test.ts）。
//
// 谁能出现在右侧栏：
//   user        你。消息只发给主调度，工位不会直接收到你的话。
//   dispatcher  主调度的原生长回答（含思考、工具调用、中断说明）。
//   station     工位的提示与去向记录（dispatch.note），带该工位的小人和真实状态。
import type { Attachment, BotShape, CompiledFactory, Role } from "../../../shared/types.ts";
import type { ConversationEntry, PiMessage } from "../../../shared/conversation.ts";
import type { ChatMessage } from "../../../shared/project.ts";
import type { DispatcherStatus, LiveChat } from "./live.ts";
import type { AvatarState } from "./avatar-look.ts";
import { grokShape } from "./avatar-look.ts";
import type { GrokShapeName } from "./grokbot-shapes.ts";
import { conversationView, type DisplayMessage } from "./presentation.ts";

export type { AvatarState } from "./avatar-look.ts";

export interface TranscriptActor {
  kind: "user" | "dispatcher" | "station";
  name: string;
  role?: Role;
  shape?: BotShape | GrokShapeName;
  hue: number;
  state: AvatarState;
  /** 工位行的节点键，用于点开检查器。 */
  node?: string;
}

export type TranscriptPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; streaming: boolean }
  | { type: "tool"; id: string; name: string; label: string; args: string; result?: string; status: "pending" | "done" | "error"; detail?: string }
  | { type: "failure"; label: string; detail: string }
  | { type: "attachments"; items: Attachment[] };

export interface TranscriptItem {
  id: string;
  at: number;
  actor: TranscriptActor;
  tone?: "info" | "fork" | "warn";
  /** 主调度的一轮回答。 */
  parts?: TranscriptPart[];
  streaming?: boolean;
  /** 一行短提示（工位记录），与 parts 互斥。 */
  notice?: string;
}

/** 主调度小人的颜色：取界面的强调色（--accent #3274ea）在 OKLCH 里的位置。 */
export const DISPATCHER_HUE = 256;

/** 工位小人的外观与动作由调用方给出：外观取自画布同一只（botFor），动作取自 Node.tsx 的 botState。 */
export interface StationLook { shape: BotShape | GrokShapeName; hue: number; state: AvatarState }

/** 工具中文名，与 vendor/pi-web-ui/tools/index.js 的渲染器保持一致。 */
const TOOL_LABEL: Record<string, string> = {
  status: "查看运行状态", inspect: "查看详情", run_control: "控制运行", feed_urls: "投料",
  pull_candidates: "取候选", workers: "调整工位", correct: "纠错", propose_patch: "起草规格补丁",
  settings: "工作设置", journal: "读取过程", report: "读取报告", read_report: "读取报告", candidates: "查询候选",
};

export function toolLabel(name: string, args?: Record<string, unknown>): string {
  const target = (args?.name ?? args?.tool) as string | undefined;
  if (name === "easy_workflow_help" || name === "h2_help") return `了解能力${target ? ` · ${TOOL_LABEL[target] ?? target}` : ""}`;
  if (name === "easy_workflow_call" || name === "h2_call") return target ? TOOL_LABEL[target] ?? `调用 Easy Workflow · ${target}` : "调用 Easy Workflow";
  return TOOL_LABEL[name] ?? name;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

function pretty(value: unknown): string {
  if (value === undefined) return "";
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return typeof value === "string" ? value : String(value);
  }
}

/** 主调度现在处于什么动作：决定他什么时候动、什么时候说。 */
export function dispatcherState(live: LiveChat, dispatcher: DispatcherStatus, last?: PiMessage | null): AvatarState {
  const failed = last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted");
  if (dispatcher.status === "recovering" || dispatcher.status === "interrupted") return "wait";
  if (failed && !dispatcher.busy) return "fail";
  if (live.tools.some((t) => t.status === "start")) return "work";
  const streaming = Boolean(live.message) || Boolean(live.text);
  if (streaming) return live.text && !live.message ? "thinking" : "speaking";
  if (dispatcher.busy || live.id) return "thinking";
  return "idle";
}

/** 工位的动作沿用画布上的同一套判定（Node.tsx 的 botState 由调用方传入，避免两处标准不一致）。 */
export function noticeState(tone: ChatMessage["tone"]): AvatarState {
  return tone === "warn" ? "fail" : tone === "fork" ? "work" : "idle";
}

export interface BuildTranscriptInput {
  entries: ConversationEntry[];
  live: LiveChat;
  dispatcher: DispatcherStatus;
  notes: ChatMessage[];
  factory: CompiledFactory | null;
  /** 工位的小人外观与当前动作；缺省时只显示记录，不显示小人。 */
  station?: (nodeKey: string) => StationLook | undefined;
}

/**
 * 把消息、流式回答和工位记录拼成一行行条目，按时间排序。
 * 用户消息只出现在主调度这条线上；工位只以自己的名义发提示。
 */
export function buildTranscript(input: BuildTranscriptInput): TranscriptItem[] {
  const { entries, live, dispatcher, notes, factory } = input;
  const view = conversationView(entries, live, dispatcher);
  const messages = view.messages;
  type ToolOutput = Extract<DisplayMessage, { role: "toolResult" }>;
  const results = new Map<string, ToolOutput>();
  for (const m of messages) if (m.role === "toolResult") results.set(m.toolCallId, m);
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant") ?? null;
  const dState = dispatcherState(live, dispatcher, lastAssistant);
  const station = input.station;

  const userActor: TranscriptActor = { kind: "user", name: "你", hue: 250, state: "idle" };
  const dispatcherActor: TranscriptActor = {
    kind: "dispatcher", name: "主调度", hue: DISPATCHER_HUE, shape: grokShape("blob"), state: dState,
  };

  const items: TranscriptItem[] = [];
  const streamingIndex = view.streamingMessage ? messages.length - 1 : -1;
  messages.forEach((message, index) => {
    if (message.role === "toolResult") return;
    const streaming = index === streamingIndex;
    if (message.role === "user") {
      const body = typeof message.content === "string"
        ? message.content
        : message.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
      const parts: TranscriptPart[] = body.trim() ? [{ type: "text", text: body }] : [];
      if (message.h2Attachments?.length) parts.push({ type: "attachments", items: message.h2Attachments });
      items.push({ id: `m${index}`, at: message.timestamp, actor: userActor, parts });
      return;
    }
    if (message.role !== "assistant") return;
    const parts: TranscriptPart[] = [];
    for (const chunk of message.content) {
      if (chunk.type === "text" && text(chunk.text).trim()) parts.push({ type: "text", text: chunk.text });
      else if (chunk.type === "thinking" && text(chunk.thinking).trim()) parts.push({ type: "thinking", text: chunk.thinking, streaming: streaming && !message.stopReason });
      else if (chunk.type === "toolCall") {
        const result = results.get(chunk.id);
        const output = result?.content?.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n") ?? "";
        const pending = view.pendingToolCalls.has(chunk.id);
        parts.push({
          type: "tool", id: chunk.id, name: chunk.name, label: toolLabel(chunk.name, chunk.arguments),
          args: pretty(chunk.arguments), result: result ? pretty(output) || "(无输出)" : undefined,
          status: result?.isError ? "error" : result ? "done" : pending ? "pending" : "error",
          detail: message.stopReason === "aborted" && !result ? "回答被停止，这个调用没有返回结果。" : undefined,
        });
      }
    }
    if (message.h2Failure) parts.push({ type: "failure", label: message.h2Failure.label, detail: message.h2Failure.detail });
    if (parts.length) items.push({ id: `m${index}`, at: message.timestamp, actor: dispatcherActor, parts, streaming });
  });

  // 工位记录：只收已经落到某个工位上的提示，避免把全局广播伪装成某个工位在说话。
  for (const note of notes) {
    if (!note.node) continue;
    const node = factory?.nodes.find((n) => n.key === note.node);
    if (!node) continue;
    const body = note.text.startsWith(`[${node.name}] `) ? note.text.slice(node.name.length + 3) : note.text;
    const look = station?.(node.key);
    items.push({
      id: note.id, at: note.at, tone: note.tone, notice: body,
      actor: {
        kind: "station", name: node.name, role: node.role, node: node.key,
        shape: look?.shape ?? grokShape(undefined), hue: look?.hue ?? 250,
        state: look?.state ?? noticeState(note.tone),
      },
    });
  }

  return items.sort((a, b) => a.at - b.at);
}
