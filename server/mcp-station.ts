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
import type { ModelTokenUsage, StationAgentBinding, Usage } from "../shared/types.ts";
import { mcpText, type McpTool } from "./mcp-protocol.ts";
import { factorySecrets, launcherEnvironment, redactText, redactValue } from "./mcp-security.ts";
import { ClaudeCodeProtocol, validClaudeSession, type ClaudeSessionReference } from './claude-code.ts';
import {OpenCodeProtocol, validOpenCodeSession, type OpenCodeSessionReference} from './opencode.ts';
import {CodexProtocol, validCodexSession, type CodexSessionReference, type CodexToolReply} from './codex.ts';
import { classifyFailure, type Failure } from '../shared/failures.ts';
import {acquireModelRequest, checkModelAdmission, reportModelResponse, withModelTool} from './model-requests.ts';
import {closedModelDependency, resolveNativeCommand} from './agent-bindings.ts';

export interface StationTool {
  name: string; label: string; description: string; parameters: TSchema;
  /** The station submit handler validates and counts same-session repairs. */
  validateInTool?: boolean;
  execute: (id: string, args: any, signal?: AbortSignal) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;
}
export interface ClosedSessionScope { projectDirectory: string; workDirectory: string }
export interface ClosedAgentConfig {
  command: string[];
  model?: string;
  provider?: string;
  cwd: string;
  adapter?: 'launcher' | 'claude-code' | 'opencode' | 'codex';
  requestTimeoutMs?: number;
  sessionScope?: ClosedSessionScope;
}
export interface ClosedAgentReply {
  model: string;
  provider?: string;
  usage?: Usage;
  tokenUsage?: ModelTokenUsage;
  costReported?: boolean;
  costComplete?: boolean;
  modelCalls?: number;
  time?: { firstTokenMs: number; outputMs: number; modelCalls: number };
  error?: { type: 'transport' | 'credentials' | 'quota' | 'tls' | 'contract' };
  failure?: Failure;
}
type Message = { role: "user" | "assistant"; content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] };
export type ClosedSessionReference = ClaudeSessionReference | OpenCodeSessionReference | CodexSessionReference;

export function closedAgentConfig(cwd: string, sessionScope?: ClosedSessionScope, binding?: StationAgentBinding): ClosedAgentConfig | null {
  // An explicit Pi station never parses or inherits a global launcher setting.
  if (binding?.adapter === 'pi') return null;
  if (!binding && !process.env.FACTORY_STATION_COMMAND) return null;
  const adapter = binding?.adapter ?? (process.env.FACTORY_STATION_ADAPTER?.trim() || 'launcher');
  if (!['launcher', 'claude-code', 'opencode', 'codex'].includes(adapter)) throw new Error('Unsupported station agent adapter.');
  let command: unknown = binding?.command;
  if (!binding) {
    try { command = JSON.parse(process.env.FACTORY_STATION_COMMAND!); }
    catch { throw new Error('FACTORY_STATION_COMMAND must be a JSON argv array.'); }
  }
  if (command === undefined && adapter !== 'launcher') command = resolveNativeCommand(adapter as 'claude-code' | 'opencode' | 'codex');
  if (!Array.isArray(command) || !command.length || command.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('The station launcher command must be a nonempty argv array.');
  }
  const model = binding ? binding.model : process.env.FACTORY_STATION_MODEL;
  if (adapter === 'launcher' && !model?.trim()) throw new Error('Set the station launcher requested model.');
  const provider = binding && 'provider' in binding ? binding.provider : undefined;
  const requestTimeoutMs = binding ? binding.requestTimeoutMs ?? 180000 : Number(process.env.FACTORY_STATION_TIMEOUT_MS ?? 180000);
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 900000) throw new Error('FACTORY_STATION_TIMEOUT_MS must be an integer from 1 to 900000.');
  if (factorySecrets().some(secret => command.some(value => value.includes(secret)) || model?.includes(secret) || provider?.includes(secret))) throw new Error("Do not pass Easy Workflow control credentials to a station launcher.");
  return {command: [...command], ...(model ? {model} : {}), ...(provider ? {provider} : {}), cwd,
    adapter: adapter as ClosedAgentConfig['adapter'], requestTimeoutMs, sessionScope};
}

function dependencyOf(config: ClosedAgentConfig) {
  return closedModelDependency({adapter: config.adapter ?? 'launcher', command: config.command,
    ...(config.model ? {model: config.model} : {}), ...(config.provider ? {provider: config.provider} : {})});
}

function validSession(value: unknown, config: ClosedAgentConfig, signature: string): value is ClosedSessionReference {
  if (config.adapter === 'claude-code') return validClaudeSession(value, config.model, signature);
  const selection = {model: config.model, provider: config.provider};
  if (config.adapter === 'opencode') return validOpenCodeSession(value, selection, signature);
  if (config.adapter === 'codex') return validCodexSession(value, selection, signature);
  return false;
}

function inside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Validate before reading a checkpoint or starting a process in its directory. */
function ownedWorkDirectory(scope: ClosedSessionScope, candidate: string, mustExist: boolean) {
  const project = path.resolve(scope.projectDirectory);
  const work = path.resolve(scope.workDirectory);
  const target = path.resolve(candidate);
  if (!inside(project, work) || !inside(work, target)) return;
  let cursor = project;
  for (const component of ['', ...path.relative(project, target).split(path.sep)]) {
    if (component) cursor = path.join(cursor, component);
    try {
      const stat = fs.lstatSync(cursor);
      // This also rejects Windows junctions. Never follow a checkpoint through
      // a link to a different project, even when its lexical path is in work/.
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !mustExist) return target;
      return;
    }
  }
  return target;
}

export async function openStationMcp(tools: StationTool[], signal: AbortSignal) {
  signal.throwIfAborted();
  // No control token, Factory, or control registry is present in this server.
  const scoped = tools.filter(t => ["env_help", "env_call", "submit", "handoff", "submit_answer", "submit_turn", "board_read", "board_post"].includes(t.name));
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
      if (JSON.stringify(call.arguments ?? {}) !== JSON.stringify(redactValue(call.arguments ?? {}, secrets))) return send(400, { error: "Credentials cannot be submitted as tool arguments" });
      if (!Check(tool.parameters, call.arguments ?? {}) && !(['submit', 'submit_answer', 'submit_turn'].includes(tool.name) && tool.validateInTool)) return send(400, { error: "Tool arguments violate the station contract" });
      scopeSignal.throwIfAborted();
      const result = await tool.execute("station-mcp", call.arguments ?? {}, scopeSignal);
      // Only MCP content leaves the tool boundary; internal details are private.
      send(200, {content: result.content, ...(result.isError ? {isError: true} : {})});
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
    const call = async (name: string, args: unknown, signal: AbortSignal): Promise<CodexToolReply> => {
      scopeSignal.throwIfAborted();
      const response = await fetch(`http://127.0.0.1:${address.port}/call`, {method: 'POST',
        signal: AbortSignal.any([scopeSignal, signal]),
        headers: {authorization: `Bearer ${secret}`, 'content-type': 'application/json'},
        body: JSON.stringify({name, arguments: args})});
      if (!response.ok) throw new Error('The station scope rejected this native tool call');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !Array.isArray((result as CodexToolReply).content)) {
        throw new Error('The station scope returned an invalid tool receipt');
      }
      return result as CodexToolReply;
    };
    return { config: { command: process.execPath, args: [fileURLToPath(new URL("./mcp.ts", import.meta.url)), "--station"], env: { EASY_WORKFLOW_STATION_CONNECTION: file, H2_STATION_CONNECTION: file, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) } }, close, call,
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
  private session?: ClosedSessionReference;
  private sessionFile?: string;
  private signature = '';
  private readContext?: () => NonNullable<ClaudeSessionReference['context']>;
  private workingDirectory: string;
  constructor(config: ClosedAgentConfig, envelope: string, tools: StationTool[], onReply: (reply: ClosedAgentReply) => void) {
    this.config = config;
    this.envelope = redactText(envelope, factorySecrets());
    this.tools = tools;
    this.onReply = onReply;
    this.workingDirectory = config.cwd;
  }
  abort() { this.controller?.abort(); }
  messagesSnapshot(): unknown[] {
    return structuredClone(this.messages);
  }

  restoreMessages(messages: unknown[]): void {
    const valid = (value: unknown): value is Message => {
      if (!value || typeof value !== 'object') return false;
      const message = value as Record<string, unknown>;
      if (!['user', 'assistant'].includes(String(message.role)) || !Array.isArray(message.content)) return false;
      return message.content.every((part: unknown) => {
        if (!part || typeof part !== 'object') return false;
        const content = part as Record<string, unknown>;
        return content.type === 'text' && typeof content.text === 'string' ||
          content.type === 'image' && typeof content.data === 'string' && typeof content.mimeType === 'string';
      });
    };
    if (!messages.every(valid)) throw new TypeError('Invalid saved station messages');
    this.messages = structuredClone(messages);
  }

  configureSession(station: string, signature: string, saved?: unknown, readContext?: () => NonNullable<ClaudeSessionReference['context']>) {
    if (!['claude-code', 'opencode', 'codex'].includes(this.config.adapter ?? 'launcher')) return;
    this.signature = signature;
    this.readContext = readContext;
    this.session = undefined;
    const scope = this.config.sessionScope;
    this.workingDirectory = this.config.cwd;
    if (scope && !ownedWorkDirectory(scope, this.config.cwd, false)) {
      throw new Error('The closed station directory must stay inside the explicit project work root without symbolic links.');
    }
    this.sessionFile = path.join(this.config.cwd, 'closed-sessions', `${crypto.createHash('sha256').update(station).digest('hex').slice(0, 24)}.json`);
    if (scope && !ownedWorkDirectory(scope, path.dirname(this.sessionFile), false)) {
      throw new Error('The closed station checkpoint directory must stay inside the project without symbolic links.');
    }
    const restore = (value: unknown, local: boolean) => {
      if (!validSession(value, this.config, signature)) return false;
      let directory = this.config.cwd;
      if (value.workDirectory !== undefined) {
        if (!scope || !value.workDirectory || path.isAbsolute(value.workDirectory)
          || /^[a-z]:/i.test(value.workDirectory) || value.workDirectory.split(/[\\/]/).includes('..')) return false;
        const owned = ownedWorkDirectory(scope, path.resolve(scope.projectDirectory, value.workDirectory), true);
        if (!owned) return false;
        directory = owned;
      } else if (scope && !local) {
        // Legacy metadata can be recovered in its own directory, but cannot
        // safely locate a different token's vendor session on older CLIs.
        return false;
      }
      this.workingDirectory = directory;
      this.session = structuredClone(value);
      return true;
    };
    if (!restore(saved, false)) {
      try {
        const stat = fs.lstatSync(this.sessionFile);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          const local: unknown = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
          restore(local, true);
        }
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
  private saveSession(session: ClosedSessionReference) {
    const scope = this.config.sessionScope;
    this.session = {
      ...session,
      ...(scope ? { workDirectory: path.relative(scope.projectDirectory, this.workingDirectory).split(path.sep).join('/') } : {}),
      ...(this.readContext ? { context: this.readContext() } : {}),
    };
    if (!this.sessionFile) return;
    if (scope && !ownedWorkDirectory(scope, path.dirname(this.sessionFile), false)) {
      throw new Error('The closed station checkpoint directory is no longer inside the project.');
    }
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
    const pendingMessages: Message[] = [...this.messages, {role: 'user', content: [{type: 'text',
      text: redactText(first ? `${this.envelope}\n\n---\n# 本次输入\n${text}` : text, factorySecrets())}, ...(images ?? [])]}];
    this.controller = new AbortController();
    let releaseCapacity: () => void = () => {};
    let capacityFailure: Failure | undefined;
    const scopedTools = this.tools.map(tool => ({
      ...tool,
      execute: async (id: string, args: unknown, signal?: AbortSignal) => {
        try {
          const result = await withModelTool(releaseCapacity, () => tool.execute(id, args, signal), failure => {capacityFailure = failure;});
          if (['submit', 'handoff', 'submit_answer', 'submit_turn'].includes(tool.name)) this.messages.push({ role: 'assistant', content: [{ type: 'text', text: `${tool.name}: ${JSON.stringify(args)}` }] });
          if (['submit', 'submit_answer', 'submit_turn'].includes(tool.name) && result.isError) {
            this.messages.push({role: 'user', content: [{type: 'text',
              text: `程序校验错误（工具结果）：${redactText(JSON.stringify(result.content), factorySecrets())}`} ]});
          }
          return result;
        } finally {
          if (this.session) this.saveSession(this.session);
        }
      },
    }));
    const dependency = dependencyOf(this.config);
    const release = await acquireModelRequest(dependency, this.controller.signal);
    releaseCapacity = release;
    let session: Awaited<ReturnType<typeof openStationMcp>> | undefined;
    const native = this.config.adapter === 'opencode' || this.config.adapter === 'codex';
    const timeout = native ? setTimeout(() => this.controller!.abort(new Error('Native station request timed out; its process and scoped tools were cancelled.')),
      this.config.requestTimeoutMs ?? 180000) : undefined;
    timeout?.unref();
    try {
      session = await openStationMcp(scopedTools, this.controller.signal);
      const request = { product: "Easy Workflow", protocol: "h2-closed-agent/1", model: this.config.model, firstMessage: pendingMessages[0], messages: pendingMessages, mcpServers: { h2_station: session.config } };
      const vendor = this.config.adapter === 'claude-code' ? new ClaudeCodeProtocol(this.config.model, this.signature,
        this.session?.adapter === 'claude-code' ? this.session : undefined, reference => this.saveSession(reference), scopedTools.map(tool => tool.name)) : undefined;
      const scope = this.config.sessionScope;
      if (scope && !ownedWorkDirectory(scope, this.workingDirectory, !!this.session)) {
        throw new Error('The saved closed station working directory is no longer available inside this project.');
      }
      const config = {...this.config, cwd: this.workingDirectory};
      const started = () => {this.messages = pendingMessages;};
      let reply: ClosedAgentReply;
      if (this.config.adapter === 'opencode') {
        const protocol = new OpenCodeProtocol({model: this.config.model, provider: this.config.provider}, this.signature,
          this.session?.adapter === 'opencode' ? this.session : undefined, reference => this.saveSession(reference));
        reply = await runOpenCode(config, request, this.controller.signal, protocol, started);
      } else if (this.config.adapter === 'codex') {
        const protocol = new CodexProtocol({selection: {model: this.config.model, provider: this.config.provider},
          signature: this.signature, previous: this.session?.adapter === 'codex' ? this.session : undefined,
          checkpoint: reference => this.saveSession(reference), cwd: this.workingDirectory, tools: scopedTools,
          signal: this.controller.signal});
        reply = await runCodex(config, request.messages.at(-1)!, this.controller.signal, protocol, session.call, started);
      } else reply = await runLauncher(config, request, this.controller.signal, vendor, started);
      const safe = session.redact(reply);
      if (safe.model !== reply.model || safe.provider !== reply.provider) throw new Error("Launcher metadata contained credentials; it was not logged.");
      this.onReply(safe);
      if (!['unknown', 'unreported'].includes(safe.model) && !['model_transport', 'model_unavailable'].includes(safe.failure?.tag ?? '')) {
        reportModelResponse({dependency, model: safe.model, modelCalls: safe.modelCalls ?? safe.time?.modelCalls ?? 0,
          provider: safe.provider, usageReported: Boolean(safe.usage || safe.tokenUsage), usage: safe.usage,
          tokenUsage: safe.tokenUsage, costReported: safe.costReported ?? !!safe.usage,
          costComplete: safe.costComplete ?? !!safe.usage});
      }
      if (capacityFailure) throw Object.assign(new Error(capacityFailure.message), {failure: capacityFailure});
      if (safe.failure) throw Object.assign(new Error(safe.failure.message), { failure: safe.failure });
    } catch (err) {
      this.state.errorMessage = err instanceof Error ? err.message : "Closed agent launcher failed";
      // A submit alone does not certify a completed launcher or its actual model.
      throw err;
    } finally { clearTimeout(timeout); try { await session?.close(); } finally { release(); } }
  }
}

interface NativeProcessOptions {
  env?: Record<string, string>;
  maxBufferBytes: number;
  started?: () => void;
  input: (write: (line: string) => void, end: () => void) => string;
  interactive?: boolean;
  accept?: (line: string) => void | Promise<void>;
  interrupt?: () => void;
  modelRequest?: boolean;
}

/** Every native phase has the same kill-tree/close boundary as the launcher. */
async function runNativeProcess(config: ClosedAgentConfig, command: string[], signal: AbortSignal,
  options: NativeProcessOptions): Promise<{code: number | null; output: string}> {
  signal.throwIfAborted();
  if (options.modelRequest !== false) checkModelAdmission(dependencyOf(config), true);
  fs.mkdirSync(config.cwd, {recursive: true});
  const child = spawn(command[0], command.slice(1), {cwd: config.cwd,
    env: {...launcherEnvironment(), ...options.env}, shell: false, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
  if (options.started) child.once('spawn', options.started);
  const processClosed = new Promise<void>(resolve => child.once('close', () => resolve()));
  return new Promise((resolve, reject) => {
    let output = '';
    let size = 0;
    let done = false;
    let failure: unknown;
    let stopping: Promise<void> | undefined;
    let parsing = Promise.resolve();
    const finish = (error?: unknown, code?: number | null) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve({code: code ?? null, output});
    };
    const stop = (error: unknown) => {
      failure ??= error;
      stopping ??= (async () => {
        try { options.interrupt?.(); } catch { /* The owned process may already have closed. */ }
        try { await stopLauncher(child); } finally { await processClosed; }
      })();
      void stopping.then(() => finish(failure), () => finish(failure));
    };
    const abort = () => stop(signal.reason ?? new Error('Native station cancelled'));
    const parse = (line: string) => {
      parsing = parsing.then(async () => {
        if (!failure) await options.accept!(line);
      }).catch(error => stop(error));
    };
    signal.addEventListener('abort', abort, {once: true});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (failure) return;
      size += Buffer.byteLength(chunk);
      if (size > options.maxBufferBytes) return stop(new Error('Native station response exceeded its bounded output budget'));
      output += chunk;
      if (!options.accept) return;
      let end: number;
      while ((end = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, end);
        output = output.slice(end + 1);
        if (Buffer.byteLength(line) > 1024 * 1024) return stop(new Error('Native station stream line exceeded 1 MiB'));
        parse(line);
      }
      if (Buffer.byteLength(output) > 1024 * 1024) stop(new Error('Native station stream line exceeded 1 MiB'));
    });
    // Native logs/configuration can contain credentials or prompts. Never echo them.
    child.stderr.resume();
    child.once('error', () => stop(new Error('Native agent could not start; check its configured CLI executable.')));
    child.stdin.on('error', () => {if (!done && !failure) stop(new Error('Native agent did not accept its protocol input.'));});
    child.once('close', code => {
      void (async () => {
        if (failure) return;
        if (options.accept && output.trim()) { parse(output); output = ''; }
        await parsing;
        if (!failure) finish(undefined, code);
      })().catch(error => stop(error));
    });
    try {
      const input = options.input(line => {
        if (!failure && !child.stdin.destroyed) child.stdin.write(line);
      }, () => child.stdin.end());
      if (options.interactive) child.stdin.write(input); else child.stdin.end(input);
    } catch (error) { stop(error); }
    if (signal.aborted) abort();
  });
}

async function runOpenCode(config: ClosedAgentConfig, request: {messages: Message[]; mcpServers: Record<string, unknown>},
  signal: AbortSignal, protocol: OpenCodeProtocol, started: () => void): Promise<ClosedAgentReply> {
  const localCommand = async (description: ReturnType<OpenCodeProtocol['configurationCommand']>) => {
    const result = await runNativeProcess(config, description.argv,
      AbortSignal.any([signal, AbortSignal.timeout(description.timeoutMs)]), {
        env: description.env, maxBufferBytes: description.maxBufferBytes, input: () => '', modelRequest: false,
      });
    if (result.code !== 0) throw new Error('OpenCode could not read its local configuration or session receipt');
    try { return JSON.parse(result.output) as unknown; }
    catch { throw new Error('OpenCode returned an invalid local configuration or session receipt'); }
  };
  try {
    protocol.acceptConfiguration(await localCommand(protocol.configurationCommand(config.command)));
    signal.throwIfAborted();
    await protocol.prepareInput(request.messages.at(-1)!, config.cwd);
    const process = await runNativeProcess(config, protocol.argv(config.command), signal, {
      env: protocol.environment(request.mcpServers), maxBufferBytes: 16 * 1024 * 1024,
      started, input: () => protocol.input(request.messages.at(-1)!), accept: line => protocol.accept(line),
    });
    signal.throwIfAborted();
    const receipt = protocol.receiptCommand(config.command);
    if (receipt) protocol.acceptReceipt(await localCommand(receipt));
    const result = protocol.finish();
    if (process.code !== 0 && !result.failure) throw new Error(`OpenCode exited (${process.code ?? 'signal'}) without a failure receipt`);
    return {...result, costReported: !!result.usage};
  } finally {
    // All phases settle after child close; only our fresh input files are removed.
    protocol.disposeInput();
  }
}

async function runCodex(config: ClosedAgentConfig, message: Message, signal: AbortSignal,
  protocol: CodexProtocol, call: (name: string, args: unknown, signal: AbortSignal) => Promise<CodexToolReply>,
  started: () => void): Promise<ClosedAgentReply> {
  const process = await runNativeProcess(config, protocol.argv(config.command), signal, {
    maxBufferBytes: 16 * 1024 * 1024, interactive: true,
    input: (send, complete) => {
      protocol.bind({send, complete, call, beforeTurn: () => {checkModelAdmission(dependencyOf(config), true); started();}});
      return protocol.input(message);
    },
    accept: line => protocol.accept(line), interrupt: () => protocol.interrupt(),
  });
  signal.throwIfAborted();
  const result = protocol.finish();
  if (process.code !== 0 && !result.failure) throw new Error(`Codex app-server exited (${process.code ?? 'signal'})`);
  return {...result, costReported: false};
}

async function runLauncher(config: ClosedAgentConfig, request: { messages: Message[]; mcpServers: Record<string, unknown> }, signal: AbortSignal, vendor?: ClaudeCodeProtocol, started?: () => void): Promise<ClosedAgentReply> {
  signal.throwIfAborted();
  // The model hold can change while the attempt-scoped MCP server opens.
  checkModelAdmission(dependencyOf(config), true);
  fs.mkdirSync(config.cwd, { recursive: true });
  const command = vendor ? vendor.argv(config.command, request.mcpServers) : config.command;
  const child = spawn(command[0], command.slice(1), { cwd: config.cwd, env: { ...launcherEnvironment(), ...(vendor ? {
    ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // Older CLI versions can emit init before their local MCP tools are ready.
    // Wait for this one scoped server instead of spending a turn without submit.
    MCP_CONNECTION_NONBLOCKING: '0', MCP_CONNECT_TIMEOUT_MS: '10000', MCP_TIMEOUT: '10000',
  } : {}) }, shell: false, windowsHide: true,
    detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  if (started) child.once('spawn', started);
  const processClosed = new Promise<void>(resolve => child.once('close', () => resolve()));
  return new Promise<ClosedAgentReply>((resolve, reject) => {
    let output = "", size = 0, done = false, failure: Error | undefined;
    let stopping: Promise<void> | undefined;
    const finish = (error?: Error, reply?: ClosedAgentReply) => { if (done) return; done = true; clearTimeout(timeout); signal.removeEventListener("abort", abort); error ? reject(error) : resolve(reply!); };
    const stop = (error: Error) => {
      failure ??= error;
      stopping ??= (async () => {
        try { await stopLauncher(child); }
        finally { await processClosed; }
      })();
      void stopping.then(() => finish(failure), () => finish(failure));
    };
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
