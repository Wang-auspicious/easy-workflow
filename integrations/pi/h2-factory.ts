// H2's local Pi adapter. Auto-loaded from ~/.pi/agent/extensions/.
// Only two stable tools are advertised; full schemas are requested on demand.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";

const connectionFile = () => process.env.FACTORY_AGENT_CONNECTION ?? path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "h2", "connection.json");

export async function requestH2(route: string, input?: unknown, signal?: AbortSignal) {
  let c: { url: string; token?: string; protocol: string };
  try { c = JSON.parse(fs.readFileSync(connectionFile(), "utf8")); }
  catch { throw new Error("H2 未连接：请打开 Pi Factory GUI 或启动 H2 独立服务。"); }
  const url = new URL(c.url);
  if (c.protocol !== "h2-agent/1" || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("H2 本地连接信息无效。");
  const timer = AbortSignal.timeout(8000);
  const response = await fetch(new URL(route, url), {
    method: input === undefined ? "GET" : "POST", redirect: "error",
    headers: { "content-type": "application/json", ...(c.token ? { authorization: `Bearer ${c.token}` } : {}) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    signal: signal ? AbortSignal.any([signal, timer]) : timer,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${value.code ?? response.status}: ${value.error ?? "H2 请求失败"}`);
  return value;
}

const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });

// A structural interface keeps this source usable with the user's installed Pi
// without bundling a second coding-agent CLI or relying on a global package path.
export default function h2Extension(pi: { registerTool: (tool: any) => void; on: (event: string, handler: (...args: any[]) => any) => void }) {
  pi.registerTool({
    name: "h2_help", label: "H2 能力", description: "H2 factory capability index; pass name for one tool's exact JSON schema. Works without UI navigation or reading source.",
    parameters: Type.Object({ name: Type.Optional(Type.String({ minLength: 1 })) }),
    async execute(_id: string, params: { name?: string }, signal?: AbortSignal) {
      return result(await requestH2(params.name ? `/api/agent/tools/${encodeURIComponent(params.name)}` : "/api/agent/bootstrap", undefined, signal));
    },
  });
  pi.registerTool({
    name: "h2_call", label: "调用 H2", description: "Execute a discovered H2 tool. Use h2_help(name) for its schema. Never retry an uncertain write without inspecting status/journal first.",
    parameters: Type.Object({ name: Type.String({ minLength: 1 }), arguments: Type.Record(Type.String(), Type.Unknown()) }),
    async execute(_id: string, params: { name: string; arguments: Record<string, unknown> }, signal?: AbortSignal) {
      return result(await requestH2(`/api/tools/${encodeURIComponent(params.name)}`, params.arguments, signal));
    },
  });
  pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
    if (!fs.existsSync(connectionFile())) return;
    try {
      const bootstrap = await requestH2("/api/agent/bootstrap", undefined, AbortSignal.timeout(1500));
      const base = event.systemPrompt.replace(/\n<h2-agent>[\s\S]*?<\/h2-agent>/g, "");
      return { systemPrompt: `${base}\n<h2-agent>\n${bootstrap.instructions}\n协议 ${bootstrap.protocol}；版本 ${bootstrap.revision}。\n</h2-agent>` };
    } catch { /* A stopped service never blocks an unrelated Pi session. h2_help explains reconnecting. */ }
  });
}
