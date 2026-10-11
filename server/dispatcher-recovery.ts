import crypto from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DispatcherCheckpoint } from "../shared/conversation.ts";
import { redactModelError } from "./pi.ts";

export function dispatcherError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactModelError(message).slice(0, 400);
}

export function transientDispatcherError(message: string): boolean {
  if (/\b(?:401|403)\b|invalid.?api.?key|unauthori[sz]ed|insufficient.?quota|billing|余额|凭据|额度|OAuth/i.test(message)) return false;
  return /timeout|timed out|超时|ECONN|ENET|EAI_AGAIN|UND_ERR|fetch failed|network|connection|socket|stream.*(?:closed|ended|reset)|\b(?:408|429|500|502|503|504|529)\b|rate.?limit|overloaded|temporar/i.test(message);
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
