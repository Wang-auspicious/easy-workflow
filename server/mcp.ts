// A real stdio MCP entry point. The existing HTTP registry remains authoritative.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { mcpText, serveStdio, type McpBackend, type McpTool } from "./mcp-protocol.ts";
import { redactText, redactValue } from "./mcp-security.ts";
import { CONTROL_HELP, CONTROL_CALL, CONTROL_PROTOCOL, findControlConnectionFile } from "./agent-connection.ts";

/** Only a private loopback rendezvous may receive authentication. Redirects are forbidden. */
export async function mcpRequest(file: string, protocol: "h2-agent/1" | "h2-station/1", route: string, body?: unknown, signal?: AbortSignal) {
  let connection: { url: string; protocol: string; token?: string };
  try { connection = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("Easy Workflow connection is unavailable; start the service or attach a current station session."); }
  let url: URL;
  try { url = new URL(connection.url); } catch { throw new Error("Invalid Easy Workflow connection."); }
  if (connection.protocol !== protocol || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || (connection.token !== undefined && typeof connection.token !== "string")) throw new Error("Invalid Easy Workflow loopback connection.");
  const timeout = AbortSignal.timeout(240_000);
  try {
    const response = await fetch(new URL(route, url), { method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { "content-type": "application/json", ...(connection.token ? { authorization: `Bearer ${connection.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const value = await response.json() as any;
    if (!response.ok) throw new Error(`${value.code ?? response.status}: ${value.error ?? "Easy Workflow request failed"}`);
    return redactValue(value, [connection.token]);
  } catch (err) { throw new Error(redactText(err instanceof Error ? err.message : "Easy Workflow request failed", [connection.token])); }
}

const controlTools: McpTool[] = [
  { name: CONTROL_HELP, title: "Easy Workflow 能力", description: "Read the current capability index, or one exact schema by name.", inputSchema: Type.Object({ name: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }) },
  { name: CONTROL_CALL, title: "调用 Easy Workflow", description: "Call a discovered Easy Workflow capability. Verify status before retrying an uncertain write. Patch approval remains with the owner.", inputSchema: Type.Object({ name: Type.String({ minLength: 1 }), arguments: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }) },
];
const compatibleTools = [...controlTools, ...controlTools.map((tool, i) => ({ ...tool, name: i === 0 ? "h2_help" : "h2_call", description: `Compatibility alias for ${tool.name}; prefer the canonical tool in new calls.` }))];

export function controlMcp(file?: string): McpBackend {
  return { name: "easy-workflow-control", instructions: "Call easy_workflow_help before work. It returns current Easy Workflow instructions; load detailed schemas only when needed. Do not expose connection credentials.",
    tools: () => compatibleTools,
    call: async (name, args, signal) => {
      const connection = file ?? findControlConnectionFile();
      if (name === CONTROL_HELP || name === "h2_help") return mcpText(await mcpRequest(connection, CONTROL_PROTOCOL, args.name ? `/api/agent/tools/${encodeURIComponent(String(args.name))}` : "/api/agent/bootstrap", undefined, signal));
      if (args.name === "decide_patch") return mcpText({ ok: false, code: "owner_decision_required", error: "主调度不能批准补丁；请站长在界面决定。" }, true);
      return mcpText(await mcpRequest(connection, CONTROL_PROTOCOL, `/api/tools/${encodeURIComponent(String(args.name))}`, args.arguments, signal));
    } };
}

export function stationMcp(file: string): McpBackend {
  return { name: "easy-workflow-station", instructions: "Follow the Easy Workflow station envelope in your first message. Only env_help, env_call and submit are available for this attempt.",
    tools: async signal => (await mcpRequest(file, "h2-station/1", "/tools", undefined, signal)).tools,
    call: async (name, args, signal) => mcpRequest(file, "h2-station/1", "/call", { name, arguments: args }, signal) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // A station worker must never fall back to global connection discovery.
  const stationFile = process.env.EASY_WORKFLOW_STATION_CONNECTION ?? process.env.H2_STATION_CONNECTION;
  const station = process.argv.includes("--station") || !!stationFile;
  if (station && !stationFile) { process.stderr.write("Missing station connection.\n"); process.exitCode = 1; }
  else try { await serveStdio(station ? stationMcp(stationFile!) : controlMcp()); }
  catch { process.stderr.write("Easy Workflow MCP transport closed.\n"); process.exitCode = 1; }
}
