// A closed agent gets a first user message and an attempt-scoped MCP connection.
// The local command is a vendor launcher, not a shell string or an assumed CLI API.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Check } from "typebox/value";
import type { TSchema } from "typebox";
import type { Usage } from "../shared/types.ts";
import { mcpText, type McpTool } from "./mcp-protocol.ts";
import { factorySecrets, launcherEnvironment, redactText, redactValue } from "./mcp-security.ts";
import { ClaudeCodeProtocol, validClaudeSession, type ClaudeSessionReference } from './claude-code.ts';
import { classifyFailure, type Failure } from '../shared/failures.ts';

export interface StationTool {
  name: string; label: string; description: string; parameters: TSchema;
  execute: (id: string, args: any, signal?: AbortSignal) => Promise<{ content: { type: "text"; text: string }[] }>;
}
export interface ClosedAgentConfig { command: string[]; model: string; cwd: string; adapter?: 'launcher' | 'claude-code'; requestTimeoutMs?: number }
export interface ClosedAgentReply {
  model: string;
  usage?: Usage;
  modelCalls?: number;
  time?: { firstTokenMs: number; outputMs: number; modelCalls: number };
  error?: { type: 'transport' | 'credentials' | 'quota' | 'tls' | 'contract' };
  failure?: Failure;
}
type Message = { role: "user" | "assistant"; content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] };

export function closedAgentConfig(cwd: string): ClosedAgentConfig | null {
  if (!process.env.FACTORY_STATION_COMMAND) return null;
  let command: unknown;
  try { command = JSON.parse(process.env.FACTORY_STATION_COMMAND); } catch { throw new Error("FACTORY_STATION_COMMAND must be a JSON argv array."); }
  if (!Array.isArray(command) || !command.length || command.some(x => typeof x !== "string" || !x.trim())) throw new Error("FACTORY_STATION_COMMAND must be a nonempty JSON argv array.");
  if (!process.env.FACTORY_STATION_MODEL?.trim()) throw new Error("Set FACTORY_STATION_MODEL to the launcher's requested model.");
  const adapter = process.env.FACTORY_STATION_ADAPTER?.trim() || 'launcher';
  if (!['launcher', 'claude-code'].includes(adapter)) throw new Error('FACTORY_STATION_ADAPTER must be launcher or claude-code.');
  const requestTimeoutMs = Number(process.env.FACTORY_STATION_TIMEOUT_MS ?? 180000);
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 900000) throw new Error('FACTORY_STATION_TIMEOUT_MS must be an integer from 1 to 900000.');
  if (factorySecrets().some(secret => command.some(x => x.includes(secret)) || process.env.FACTORY_STATION_MODEL!.includes(secret))) throw new Error("Do not pass Easy Workflow control credentials to a station launcher.");
  return { command, model: process.env.FACTORY_STATION_MODEL, cwd, adapter: adapter as ClosedAgentConfig['adapter'], requestTimeoutMs };
}

export async function openStationMcp(tools: StationTool[], signal: AbortSignal) {
  signal.throwIfAborted();
  // No control token, Factory, or control registry is present in this server.
  const scoped = tools.filter(t => ["env_help", "env_call", "submit"].includes(t.name));
  const definitions: McpTool[] = scoped.map(t => ({ name: t.name, title: t.label, description: t.description, inputSchema: t.parameters }));
  const secret = crypto.randomBytes(32).toString("hex");
  const secrets = [secret, ...factorySecrets()];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-station-mcp-"));
  const file = path.join(dir, "connection.json");
  const revoked = new AbortController(), scopeSignal = AbortSignal.any([signal, revoked.signal]);
  let closed = false;
  let closing: Promise<void> | undefined;
  const server = http.createServer(async (req, res) => {
    const send = (status: number, value: unknown) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(redactValue(value, secrets))); };
    const supplied = Buffer.from(req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1] ?? ""), expected = Buffer.from(secret);
    if (closed || scopeSignal.aborted || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return send(401, { error: "Station session unavailable" });
    if (req.headers.origin) return send(403, { error: "Browser origins are not allowed" });
    if (req.method === "GET" && req.url === "/tools") return send(200, { tools: definitions });
    if (req.method !== "POST" || req.url !== "/call") return send(404, { error: "Unknown station endpoint" });
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) return send(413, { error: "Request exceeds 1 MiB" }); chunks.push(chunk); }
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!call || typeof call !== "object" || Array.isArray(call) || Object.keys(call).some(k => !["name", "arguments"].includes(k))) return send(400, { error: "Invalid tool request" });
      const tool = scoped.find(t => t.name === call.name);
      if (!tool) return send(403, { error: "Tool is not available to this station" });
      if (!Check(tool.parameters, call.arguments ?? {})) return send(400, { error: "Tool arguments violate the station contract" });
      if (JSON.stringify(call.arguments ?? {}) !== JSON.stringify(redactValue(call.arguments ?? {}, secrets))) return send(400, { error: "Credentials cannot be submitted as tool arguments" });
      scopeSignal.throwIfAborted();
      const result = await tool.execute("station-mcp", call.arguments ?? {}, scopeSignal);
      // Only MCP content leaves the tool boundary; internal details are private.
      send(200, { content: result.content });
    } catch (err) {
      const text = redactText(err instanceof Error ? err.message : "Station tool failed", secrets);
      send(200, mcpText({ ok: false, error: text }, true));
    }
  });
  const close = () => {
    if (closing) return closing;
    closed = true;
    revoked.abort();
    signal.removeEventListener("abort", abort);
    server.closeAllConnections();
    closing = (async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      // This exact file and empty generated directory are owned by this attempt.
      fs.rmSync(file, { force: true }); fs.rmdirSync(dir);
    })();
    return closing;
  };
  const abort = () => { void close().catch(() => {}); };
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
    const address = server.address() as { port: number };
    fs.writeFileSync(file, JSON.stringify({ product: "Easy Workflow", protocol: "h2-station/1", url: `http://127.0.0.1:${address.port}`, token: secret }), { mode: 0o600 });
    signal.addEventListener("abort", abort, { once: true });
    signal.throwIfAborted();
    return { config: { command: process.execPath, args: [fileURLToPath(new URL("./mcp.ts", import.meta.url)), "--station"], env: { EASY_WORKFLOW_STATION_CONNECTION: file, H2_STATION_CONNECTION: file, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) } }, close,
      redact: <T>(value: T) => redactValue(value, secrets) };
  } catch (err) { await close(); throw err; }
}

/** The launcher translates this document into its vendor's actual first user message. */
export class ClosedStationAgent {
  state: { errorMessage?: string } = {};
  private config: ClosedAgentConfig;
  private envelope: string;
  private tools: StationTool[];
  private messages: Message[] = [];
  private controller?: AbortController;
  private onReply: (reply: ClosedAgentReply) => void;
  private session?: ClaudeSessionReference;
  private sessionFile?: string;
  private signature = '';
  private readContext?: () => NonNullable<ClaudeSessionReference['context']>;
  constructor(config: ClosedAgentConfig, envelope: string, tools: StationTool[], onReply: (reply: ClosedAgentReply) => void) { this.config = config; this.envelope = redactText(envelope, factorySecrets()); this.tools = tools; this.onReply = onReply; }
  abort() { this.controller?.abort(); }
  configureSession(station: string, signature: string, saved?: unknown, readContext?: () => NonNullable<ClaudeSessionReference['context']>) {
    if (this.config.adapter !== 'claude-code') return;
    this.signature = signature;
    this.readContext = readContext;
    this.session = undefined;
    this.sessionFile = path.join(this.config.cwd, 'closed-sessions', `${crypto.createHash('sha256').update(station).digest('hex').slice(0, 24)}.json`);
    if (validClaudeSession(saved, this.config.model, signature)) {
      this.session = structuredClone(saved);
    } else {
      try {
        const local: unknown = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
        if (validClaudeSession(local, this.config.model, signature)) this.session = local;
      } catch {
        // A new station has no saved vendor session.
      }
    }
  }
  sessionReference() {
    return this.session && structuredClone(this.session);
  }
  clearSession() {
    this.session = undefined;
    if (this.sessionFile) fs.rmSync(this.sessionFile, { force: true });
  }
  private saveSession(session: ClaudeSessionReference) {
    this.session = { ...session, ...(this.readContext ? { context: this.readContext() } : {}) };
    if (!this.sessionFile) return;
    fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
    const temporary = `${this.sessionFile}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.session), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.sessionFile);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  async prompt(text: string, images?: { type: "image"; data: string; mimeType: string }[]) {
    this.state.errorMessage = undefined;
    const first = this.messages.length === 0;
    this.messages.push({ role: "user", content: [{ type: "text", text: redactText(first ? `${this.envelope}\n\n---\n# 本次输入\n${text}` : text, factorySecrets()) }, ...(images ?? [])] });
    this.controller = new AbortController();
    const scopedTools = this.tools.map(tool => ({
      ...tool,
      execute: async (id: string, args: unknown, signal?: AbortSignal) => {
        try {
          const result = await tool.execute(id, args, signal);
          if (tool.name === 'submit') this.messages.push({ role: 'assistant', content: [{ type: 'text', text: `submit: ${JSON.stringify(args)}` }] });
          return result;
        } finally {
          if (this.session) this.saveSession(this.session);
        }
      },
    }));
    const session = await openStationMcp(scopedTools, this.controller.signal);
    try {
      const request = { product: "Easy Workflow", protocol: "h2-closed-agent/1", model: this.config.model, firstMessage: this.messages[0], messages: this.messages, mcpServers: { h2_station: session.config } };
      const vendor = this.config.adapter === 'claude-code' ? new ClaudeCodeProtocol(this.config.model, this.signature, this.session, reference => this.saveSession(reference)) : undefined;
      const reply = await runLauncher(this.config, request, this.controller.signal, vendor);
      const safe = session.redact(reply);
      if (safe.model !== reply.model) throw new Error("Launcher metadata contained credentials; it was not logged.");
      this.onReply(safe);
      if (safe.failure) throw Object.assign(new Error(safe.failure.message), { failure: safe.failure });
    } catch (err) {
      this.state.errorMessage = err instanceof Error ? err.message : "Closed agent launcher failed";
      // A submit alone does not certify a completed launcher or its actual model.
      throw err;
    } finally { await session.close(); }
  }
}

async function runLauncher(config: ClosedAgentConfig, request: { messages: Message[]; mcpServers: Record<string, unknown> }, signal: AbortSignal, vendor?: ClaudeCodeProtocol): Promise<ClosedAgentReply> {
  signal.throwIfAborted();
  fs.mkdirSync(config.cwd, { recursive: true });
  const command = vendor ? vendor.argv(config.command, request.mcpServers) : config.command;
  const child = spawn(command[0], command.slice(1), { cwd: config.cwd, env: { ...launcherEnvironment(), ...(vendor ? {
    ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // Older CLI versions can emit init before their local MCP tools are ready.
    // Wait for this one scoped server instead of spending a turn without submit.
    MCP_CONNECTION_NONBLOCKING: '0', MCP_CONNECT_TIMEOUT_MS: '10000', MCP_TIMEOUT: '10000',
  } : {}) }, shell: false, windowsHide: true,
    detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  return new Promise<ClosedAgentReply>((resolve, reject) => {
    let output = "", size = 0, done = false, failure: Error | undefined;
    let stopping: Promise<void> | undefined;
    const finish = (error?: Error, reply?: ClosedAgentReply) => { if (done) return; done = true; clearTimeout(timeout); signal.removeEventListener("abort", abort); error ? reject(error) : resolve(reply!); };
    const stop = (error: Error) => { failure ??= error; stopping ??= stopLauncher(child); void stopping.finally(() => finish(failure)); };
    const abort = () => stop(new Error("Closed agent cancelled"));
    const timeout = setTimeout(() => stop(new Error('Closed agent request timed out; its process tree and station scope were cancelled.')), config.requestTimeoutMs ?? 180000);
    timeout.unref();
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk); if (size > (vendor ? 16 : 1) * 1024 * 1024) return stop(new Error('Closed agent launcher response exceeded its bounded output budget'));
      output += chunk;
      if (!vendor) return;
      let end: number;
      try {
        while ((end = output.indexOf('\n')) !== -1) { vendor.accept(output.slice(0, end)); output = output.slice(end + 1); }
        if (Buffer.byteLength(output) > 1024 * 1024) stop(new Error('Claude Code stream line exceeded 1 MiB'));
      } catch { stop(new Error('Claude Code stream violated the station protocol or capability scope')); }
    });
    // Vendor logs may contain prompts or authentication; do not forward them to Easy Workflow logs.
    child.stderr.resume();
    child.once("error", () => finish(new Error("Closed agent launcher could not start; check the configured executable.")));
    child.stdin.on("error", () => stop(new Error("Closed agent launcher did not accept its input document.")));
    child.once("close", code => {
      if (failure) return;
      let reply: ClosedAgentReply;
      try {
        if (vendor) { if (output.trim()) vendor.accept(output); reply = vendor.finish(); }
        else reply = JSON.parse(output);
      } catch (error) { return finish(vendor && error instanceof Error ? error : new Error(code !== 0 ? `Closed agent launcher exited (${code ?? 'signal'}); no structured failure was reported.` : 'Closed agent launcher must return one JSON result.')); }
      if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return finish(new Error('Closed agent launcher returned an invalid result document.'));
      let reportedFailure: Failure | undefined = vendor ? reply.failure : undefined;
      if (!vendor && reply.error !== undefined) {
        const messages = {
          transport: 'Closed agent provider connection error',
          credentials: 'Closed agent API key or authentication unavailable',
          quota: 'Closed agent provider balance or quota unavailable',
          tls: 'Closed agent TLS certificate validation failed',
          contract: 'Closed agent could not complete the station contract',
        };
        const category = reply.error?.type;
        if (!Object.hasOwn(messages, category)) return finish(new Error('Invalid structured launcher failure category.'));
        reportedFailure = classifyFailure(messages[category], { stage: 'model' });
      }
      if (reportedFailure && !reply.model) return finish(Object.assign(new Error(reportedFailure.message), { failure: reportedFailure }));
      if (code !== 0 && !reportedFailure) return finish(new Error(`Closed agent launcher exited (${code ?? 'signal'}).`));
      const nonnegative = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
      const tokenCount = (v: unknown) => nonnegative(v) && Number.isSafeInteger(v);
      if (!reply || typeof reply.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@+ -]{0,199}$/.test(reply.model)) return finish(new Error("Closed agent launcher must report a valid actual model id."));
      if (reply.usage && (![reply.usage.input, reply.usage.output].every(tokenCount) || !nonnegative(reply.usage.cost) || [reply.usage.cacheRead, reply.usage.cacheWrite].some(v => v !== undefined && !tokenCount(v)))) return finish(new Error("Invalid launcher usage metrics."));
      if (reply.time && (![reply.time.firstTokenMs, reply.time.outputMs].every(nonnegative) || !tokenCount(reply.time.modelCalls))) return finish(new Error("Invalid launcher timing metrics."));
      if (reply.modelCalls !== undefined && !tokenCount(reply.modelCalls)) return finish(new Error('Invalid launcher model call count.'));
      finish(undefined, { model: reply.model, ...(reply.usage ? { usage: reply.usage } : {}), ...(reply.time ? { time: reply.time } : {}), ...(reply.modelCalls === undefined ? {} : { modelCalls: reply.modelCalls }), ...(reportedFailure ? { failure: reportedFailure } : {}) });
    });
    child.stdin.end(vendor ? vendor.input(request.messages.at(-1)!) : JSON.stringify(request));
    if (signal.aborted) abort();
  });
}

/** Only terminates the process tree started for this attempt. Never touches a shared service. */
async function stopLauncher(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>(resolve => {
      const killer = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      const timeout = setTimeout(() => { killer.kill(); child.kill(); resolve(); }, 3000);
      const done = () => { clearTimeout(timeout); resolve(); };
      killer.once("error", () => { child.kill(); done(); }); killer.once("close", done);
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}
