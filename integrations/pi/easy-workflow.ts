// Easy Workflow's standalone Pi adapter. Copy this file into Pi's extensions directory.
// Only two stable tools are advertised; full schemas are requested on demand.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";

const connectionFile = () => {
  const explicit = process.env.EASY_WORKFLOW_AGENT_CONNECTION ?? process.env.FACTORY_AGENT_CONNECTION;
  if (explicit) return explicit;
  const directory = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const current = path.join(directory, "easy-workflow", "connection.json"), legacy = path.join(directory, "h2", "connection.json");
  return fs.existsSync(current) ? current : fs.existsSync(legacy) ? legacy : current;
};

export async function requestEasyWorkflow(route: string, input?: unknown, signal?: AbortSignal) {
  let c: { url: string; token?: string; protocol: string };
  try { c = JSON.parse(fs.readFileSync(connectionFile(), "utf8")); }
  catch { throw new Error("Easy Workflow 未连接：请打开桌面应用或启动独立服务。"); }
  let url: URL;
  try { url = new URL(c.url); } catch { throw new Error("Easy Workflow 本地连接信息无效。"); }
  // Keep the established wire version for installed clients.
  if (c.protocol !== "h2-agent/1" || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || c.token !== undefined && typeof c.token !== "string") throw new Error("Easy Workflow 本地连接信息无效。");
  const timer = AbortSignal.timeout(8000);
  const redact = (text: string) => c.token ? text.split(c.token).join("[redacted]").split(JSON.stringify(c.token).slice(1, -1)).join("[redacted]") : text;
  try {
  const response = await fetch(new URL(route, url), {
    method: input === undefined ? "GET" : "POST", redirect: "error",
    headers: { "content-type": "application/json", ...(c.token ? { authorization: `Bearer ${c.token}` } : {}) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    signal: signal ? AbortSignal.any([signal, timer]) : timer,
  });
  const value = JSON.parse(redact(await response.text()));
  if (!response.ok) throw new Error(`${value.code ?? response.status}: ${value.error ?? "Easy Workflow 请求失败"}`);
  return value;
  } catch (error) { throw new Error(redact(error instanceof Error ? error.message : "Easy Workflow 请求失败")); }
}

const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
export const requestH2 = requestEasyWorkflow; // Source-level compatibility.

// A structural interface keeps this source usable with the user's installed Pi
// without bundling a second coding-agent CLI or relying on a global package path.
export default function easyWorkflowExtension(pi: { registerTool: (tool: any) => void; on: (event: string, handler: (...args: any[]) => any) => void }) {
  const help = {
    name: "easy_workflow_help", label: "Easy Workflow 能力", description: "Easy Workflow capability index; pass name for one tool's exact JSON schema. Works without UI navigation or reading source.",
    parameters: Type.Object({ name: Type.Optional(Type.String({ minLength: 1 })) }),
    async execute(_id: string, params: { name?: string }, signal?: AbortSignal) {
      return result(await requestEasyWorkflow(params.name ? `/api/agent/tools/${encodeURIComponent(params.name)}` : "/api/agent/bootstrap", undefined, signal));
    },
  };
  const call = {
    name: "easy_workflow_call", label: "调用 Easy Workflow", description: "Execute a discovered Easy Workflow tool. Use easy_workflow_help(name) for its schema. Never retry an uncertain write without inspecting status/journal first.",
    parameters: Type.Object({ name: Type.String({ minLength: 1 }), arguments: Type.Record(Type.String(), Type.Unknown()) }),
    async execute(_id: string, params: { name: string; arguments: Record<string, unknown> }, signal?: AbortSignal) {
      return result(await requestEasyWorkflow(`/api/tools/${encodeURIComponent(params.name)}`, params.arguments, signal));
    },
  };
  for (const tool of [help, call]) pi.registerTool(tool);
  for (const [index, tool] of [help, call].entries()) pi.registerTool({ ...tool, name: index === 0 ? "h2_help" : "h2_call", label: `${tool.label}（兼容入口）`, description: `Compatibility alias for ${tool.name}; prefer the canonical name in new calls.` });
  pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
    if (!fs.existsSync(connectionFile())) return;
    try {
      const bootstrap = await requestEasyWorkflow("/api/agent/bootstrap", undefined, AbortSignal.timeout(1500));
      const base = event.systemPrompt.replace(/\n<(?:h2-agent|easy-workflow-agent)>[\s\S]*?<\/(?:h2-agent|easy-workflow-agent)>/g, "");
      return { systemPrompt: `${base}\n<easy-workflow-agent>\n${bootstrap.instructions}\n版本 ${bootstrap.revision}。\n</easy-workflow-agent>` };
    } catch { /* A stopped service never blocks an unrelated Pi session. The help tool explains reconnecting. */ }
  });
}
