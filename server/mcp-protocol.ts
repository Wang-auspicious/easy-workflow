// MCP 2025-06-18: JSON-RPC lifecycle and newline-delimited stdio. No stdout logs.
import { Check, Errors } from "typebox/value";
import type { TSchema } from "typebox";
import type { Readable, Writable } from "node:stream";

export const MCP_VERSION = "2025-06-18";
export interface McpTool {
  name: string; title?: string; description: string; inputSchema: TSchema;
}
export interface McpResult { content: { type: "text"; text: string }[]; isError?: boolean }
export interface McpBackend {
  name: string; instructions: string;
  tools: (signal?: AbortSignal) => Promise<McpTool[]> | McpTool[];
  call: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<McpResult>;
}
export const mcpText = (value: unknown, isError = false): McpResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
type Id = string | number;
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
class RpcError extends Error { code: number; constructor(code: number, message: string) { super(message); this.code = code; } }

/** One peer per client. Tool errors stay tool results; malformed RPC stays RPC error. */
export class McpPeer {
  private initialized = false;
  private ready = false;
  private requests = new Map<Id, AbortController>();
  backend: McpBackend;
  constructor(backend: McpBackend) { this.backend = backend; }
  close() { for (const c of this.requests.values()) c.abort(); this.requests.clear(); }
  async receive(message: unknown): Promise<unknown | null> {
    let id: Id | null = null;
    try {
      if (!obj(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || (message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number")) throw new RpcError(-32600, "Invalid JSON-RPC request");
      const notification = message.id === undefined;
      id = notification ? null : message.id;
      if (notification) {
        if (message.method === "notifications/initialized" && this.initialized) this.ready = true;
        if (message.method === "notifications/cancelled") this.requests.get(message.params?.requestId)?.abort();
        return null;
      }
      const params = message.params ?? {};
      if (!obj(params)) throw new RpcError(-32602, "Parameters must be an object");
      let result: unknown;
      if (message.method === "initialize") {
        if (this.initialized) throw new RpcError(-32600, "Already initialized");
        if (typeof params.protocolVersion !== "string" || !obj(params.capabilities) || !obj(params.clientInfo) || typeof params.clientInfo.name !== "string" || typeof params.clientInfo.version !== "string") throw new RpcError(-32602, "Missing initialize parameters");
        this.initialized = true;
        result = { protocolVersion: MCP_VERSION, capabilities: { tools: {} }, serverInfo: { name: this.backend.name, version: "1.0.0" }, instructions: this.backend.instructions };
      } else if (message.method === "ping") result = {};
      else {
        if (!this.ready) throw new RpcError(-32002, "Initialize the MCP session first");
        if (["tools/list", "tools/call"].includes(message.method)) {
          if (this.requests.has(id!)) throw new RpcError(-32600, "Duplicate active request id");
          const controller = new AbortController();
          this.requests.set(id!, controller);
          try {
            if (message.method === "tools/list") {
              if (params.cursor !== undefined) throw new RpcError(-32602, "This server has one tools page; omit cursor");
              result = { tools: await this.backend.tools(controller.signal) };
            } else {
              if (typeof params.name !== "string" || !obj(params.arguments ?? {})) throw new RpcError(-32602, "Expected tool name and arguments object");
              const tool = (await this.backend.tools(controller.signal)).find(t => t.name === params.name);
              if (!tool) throw new RpcError(-32602, "Unknown tool");
              const args = params.arguments ?? {};
              if (!Check(tool.inputSchema, args)) throw new RpcError(-32602, [...Errors(tool.inputSchema, args)].slice(0, 4).map(e => `${e.instancePath}: ${e.message}`).join("; "));
              controller.signal.throwIfAborted();
              try { result = await this.backend.call(tool.name, args as Record<string, unknown>, controller.signal); }
              catch (err) { result = mcpText({ ok: false, error: err instanceof Error ? err.message : "Tool execution failed" }, true); }
            }
          }
          finally { this.requests.delete(id!); }
        } else throw new RpcError(-32601, "Method not found");
      }
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      return { jsonrpc: "2.0", id, error: { code: err instanceof RpcError ? err.code : -32603, message: err instanceof RpcError ? err.message : "Internal error" } };
    }
  }
}

export async function serveStdio(backend: McpBackend, input: Readable = process.stdin, output: Writable = process.stdout) {
  const peer = new McpPeer(backend), pending = new Set<Promise<void>>();
  const emit = (v: unknown) => { if (v !== null && !output.destroyed) output.write(`${JSON.stringify(v)}\n`); };
  let buffer = "";
  input.setEncoding("utf8");
  try {
    for await (const chunk of input) {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
        if (line.length > 1024 * 1024) throw new Error("MCP message exceeds 1 MiB");
        if (!line.trim()) continue;
        let value: unknown;
        try { value = JSON.parse(line); }
        catch { emit({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
        const task = peer.receive(value).then(emit).finally(() => pending.delete(task));
        pending.add(task);
      }
      if (buffer.length > 1024 * 1024) throw new Error("MCP message exceeds 1 MiB");
    }
  } finally { peer.close(); await Promise.allSettled(pending); }
}
