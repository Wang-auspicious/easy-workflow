import crypto from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DispatcherCheckpoint } from "../shared/conversation.ts";
import {compactToolMessage} from '../shared/conversation.ts';
import { redactModelError } from "./pi.ts";

export function dispatcherError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactModelError(message).slice(0, 400);
}

export function transientDispatcherError(message: string): boolean {
  if (/\b(?:401|403)\b|invalid.?api.?key|unauthori[sz]ed|insufficient.?quota|billing|余额|凭据|额度|OAuth/i.test(message)) return false;
  return /timeout|timed out|超时|ECONN|ENET|EAI_AGAIN|UND_ERR|fetch failed|network|connection|socket|stream.*(?:closed|ended|reset)|\b(?:408|429|500|502|503|504|529)\b|rate.?limit|overloaded|temporar/i.test(message);
}

/** Bound the model projection, keeping user input and complete call/result pairs. */
export function dispatcherContext(messages: AgentMessage[], currentRequest: string, contextWindow: number): AgentMessage[] {
  const limit = Math.max(4096, Math.min(128 * 1024, Number.isFinite(contextWindow) ? contextWindow : 32000));
  const encoder = new TextEncoder();
  const bytes = (message: AgentMessage) => encoder.encode(JSON.stringify({...message, details: undefined,
    content: Array.isArray(message.content) ? message.content.map(part => part.type === 'image'
      ? {...part, data: '[image data has its own attachment size limit]'} : part) : message.content})).length;
  const text = (message: AgentMessage) => typeof message.content === 'string' ? message.content
    : message.content?.filter(part => part.type === 'text').map(part => part.text).join('') ?? '';
  let projected = messages.map(message => message.role === 'toolResult' ? compactToolMessage(message) : message);
  let total = projected.reduce((sum, message) => sum + bytes(message), 0);
  if (total <= limit) return projected;

  // Drop complete old turns first. Repeated prompts must anchor the latest user
  // turn, not an earlier occurrence of the same short request such as “继续”.
  let active = projected.findLastIndex(message => message.role === 'user' && text(message).startsWith(currentRequest));
  while (total > limit && active > 0) {
    const first = projected.findIndex(message => message.role === 'user');
    const next = projected.findIndex((message, index) => index > first && message.role === 'user');
    if (first < 0 || next < 0 || next > active) break;
    const removed = projected.splice(first, next - first);
    total -= removed.reduce((sum, message) => sum + bytes(message), 0);
    active -= removed.length;
  }
  if (total <= limit) return projected;

  const groups: AgentMessage[][] = [];
  for (let index = 0; index < projected.length; index++) {
    const group = [projected[index]];
    if (projected[index].role === 'assistant') {
      while (projected[index + 1]?.role === 'toolResult') group.push(projected[++index]);
    }
    groups.push(group);
  }
  let omitted = 0;
  const note: AgentMessage = {role: 'system', timestamp: messages[0]?.timestamp ?? 0, content:
    '较早的工具往来已从本次模型上下文压缩，完整原始记录仍保存在日志。用户输入保留；需要旧细节时按任务或 attempt 读取。已完成写操作的回执仍有效，不要因上下文省略而重复执行。'};
  for (let index = 0; index < groups.length - 1 && total + bytes(note) > limit; index++) {
    const group = groups[index];
    if (group.some(message => message.role === 'user' || message.role === 'system')) continue;
    total -= group.reduce((sum, message) => sum + bytes(message), 0);
    omitted += group.length;
    groups[index] = [];
  }
  if (total + (omitted ? bytes(note) : 0) > limit) {
    throw new Error('当前输入与附件超过模型可用上下文；原对话和操作回执已保存，请缩短输入或选择上下文更大的模型后继续。');
  }
  return [...(omitted ? [note] : []), ...groups.flat()];
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Canonical aliases must share a key: a regenerated tool call ID is not a new write. */
export function dispatcherOperationKey(name: string, args: unknown): string {
  const canonical = name === "h2_call" ? "easy_workflow_call" : name === "h2_help" ? "easy_workflow_help" : name;
  return crypto.createHash("sha256").update(stable([canonical, args])).digest("hex");
}

export function uncertainToolResult(name: string) {
  return { content: [{ type: "text" as const, text: `上次 ${name} 的写请求已开始，但中断时没有完整回执。可能已经生效；先读取 status、任务 ID 和 journal 核对。系统不会再次执行同一写请求。` }], details: { summary: `${name} 的执行结果待核对`, uncertain: true } };
}

/** Remove failed model fragments, preserve completed tools, repair orphaned call/result pairs. */
export function recoverDispatcherMessages(messages: AgentMessage[], operations: DispatcherCheckpoint["operations"]): AgentMessage[] {
  const clean = messages.filter(m => m.role !== "assistant" || m.stopReason !== "error" && m.stopReason !== "aborted");
  const restored: AgentMessage[] = [];
  for (let i = 0; i < clean.length; i++) {
    const message = clean[i]!;
    restored.push(message);
    if (message.role !== "assistant") continue;
    const calls = message.content.filter(c => c.type === "toolCall");
    if (!calls.length) continue;
    const results = new Map<string, AgentMessage>();
    while (clean[i + 1]?.role === "toolResult") {
      const result = clean[++i]!;
      if (result.role === "toolResult") results.set(result.toolCallId, result);
    }
    for (const call of calls) {
      const existing = results.get(call.id);
      if (existing) { restored.push(existing); continue; }
      const operation = operations.find(o => o.callId === call.id);
      const result = operation?.result ?? (operation ? uncertainToolResult(operation.name) : {
        content: [{ type: "text" as const, text: "服务中断前没有此调用的执行回执。请先核对当前状态；必要时重新调用。" }], details: { summary: "调用中断" },
      });
      restored.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content,
        details: JSON.parse(JSON.stringify(result.details)), isError: operation?.phase !== "completed", timestamp: Date.now() });
    }
  }
  return restored;
}
