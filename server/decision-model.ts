import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn, type ChildProcess} from 'node:child_process';
import type {ActivitySpan} from '../shared/types.ts';
import type {Executor, StationContext, StationResult} from './runtime.ts';

export type DecisionQuestion =
  | {type: 'choice'; instructions: string; criteria: Record<string, string>}
  | {type: 'noul'; instructions: string; criteria?: {true: string; false: string}}
  | {type: 'score'; instructions: string; criteria: string[]};
export interface DecisionRequest {purpose: string; state: unknown; questions: Record<string, DecisionQuestion>}
export type DecisionAnswer =
  | {type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number}
  | {type: 'noul'; noul: number}
  | {type: 'score'; score: number; probabilities: Record<string, number>; confidence: number};
export interface DecisionResponse {
  answers: Record<string, DecisionAnswer>;
  model: string;
  usage: {inputTokens: number; outputTokens: number};
  latencyMs: number;
  requestId: string;
}
export interface DecisionClientLike {
  decide(request: DecisionRequest, options: {signal: AbortSignal}): Promise<DecisionResponse | null>;
}
export interface DecisionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxConcurrent?: number;
  maxQueued?: number;
  timeoutMs?: number;
  queueTimeoutMs?: number;
  ssh?: {host: string; user: string; port?: number; localPort: number; remotePort: number};
}
const scope = new AsyncLocalStorage<DecisionClientLike | null>();
type Attempt = {ctx: StationContext; spans: ActivitySpan[]; responses: DecisionResponse[]};
const attemptScope = new AsyncLocalStorage<Attempt>();
export function withDecisionClient<T>(client: DecisionClientLike | null, operation: () => Promise<T>): Promise<T> {
  return scope.run(client, operation);
}
const record = (x: unknown): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const probability = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
const safeInt = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0;

/** The whole input is checked. Oversized evidence is rejected, never silently truncated. */
function payload(request: DecisionRequest, model: string): string | null {
  if (!record(request) || typeof request.purpose !== 'string' || !request.purpose.trim() || request.purpose.length > 160 || !record(request.questions)) return null;
  const entries = Object.entries(request.questions);
  if (!entries.length || entries.length > 8) return null;
  let choices = 0;
  for (const [id, question] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(id) || ['constructor', 'prototype'].includes(id) || !record(question) ||
      Object.keys(question).some(key => !['type', 'instructions', 'criteria'].includes(key)) ||
      typeof question.instructions !== 'string' || !question.instructions.trim() || question.instructions.length > 2048) return null;
    if (question.type === 'choice') {
      if (!record(question.criteria)) return null;
      const options = Object.entries(question.criteria);
      if (options.length < 2 || options.length > 16 || options.some(([key, value]) =>
        !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || typeof value !== 'string' || !value.trim() || value.length > 512)) return null;
      choices += options.length;
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 16 ||
        question.criteria.some(value => typeof value !== 'string' || !value.trim() || value.length > 512)) return null;
      choices += question.criteria.length;
    } else if (question.type === 'noul') {
      if (question.criteria !== undefined && (!record(question.criteria) || Object.keys(question.criteria).length !== 2 ||
        typeof question.criteria.true !== 'string' || typeof question.criteria.false !== 'string' ||
        !question.criteria.true.trim() || !question.criteria.false.trim() || question.criteria.true.length > 512 || question.criteria.false.length > 512)) return null;
      choices += 2;
    } else return null;
  }
  if (choices > 64) return null;
  try {
    const state = typeof request.state === 'string' ? request.state : JSON.stringify(request.state);
    if (typeof state !== 'string' || !state.trim() || state.length > 12000) return null;
    const body = JSON.stringify({model, state, questions: request.questions});
    return Buffer.byteLength(body) <= 64 * 1024 ? body : null;
  } catch { return null; }
}

function probabilities(raw: unknown, keys: string[]): Record<string, number> | null {
  if (!record(raw) || Object.keys(raw).length !== keys.length || keys.some(key => !Object.hasOwn(raw, key) || !probability(raw[key]))) return null;
  const values = Object.fromEntries(keys.map(key => [key, raw[key] as number]));
  return Math.abs(Object.values(values).reduce((a, b) => a + b, 0) - 1) <= 0.02 ? values : null;
}
function response(raw: unknown, request: DecisionRequest, config: DecisionConfig, requestId: string): DecisionResponse | null {
  if (!record(raw) || !record(raw.answers) || !record(raw.usage) ||
    raw.deployment_model !== config.model ||
    !safeInt(raw.usage.input_tokens) || !safeInt(raw.usage.output_tokens) ||
    typeof raw.latency_ms !== 'number' || !Number.isFinite(raw.latency_ms) || raw.latency_ms < 0 ||
    Object.keys(raw.answers).length !== Object.keys(request.questions).length) return null;
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = raw.answers[id];
    if (!record(answer) || answer.type !== question.type) return null;
    if (question.type === 'noul') {
      if (!probability(answer.noul)) return null;
      answers[id] = {type: 'noul', noul: answer.noul};
    } else {
      const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
      const distribution = probabilities(answer.probabilities, keys);
      if (!distribution || !probability(answer.confidence)) return null;
      if (question.type === 'choice') {
        if (typeof answer.choice !== 'string' || !keys.includes(answer.choice) ||
          distribution[answer.choice] + 0.00001 < Math.max(...Object.values(distribution))) return null;
        answers[id] = {type: 'choice', choice: answer.choice, probabilities: distribution, confidence: answer.confidence};
      } else {
        if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > keys.length - 1) return null;
        answers[id] = {type: 'score', score: answer.score, probabilities: distribution, confidence: answer.confidence};
      }
    }
  }
  // The actual deployment must match the trusted configuration; a request alias
  // alone is not evidence of which deployed weights answered.
  return {answers, model: config.model, usage: {inputTokens: raw.usage.input_tokens, outputTokens: raw.usage.output_tokens}, latencyMs: raw.latency_ms, requestId};
}

class Admission {
  active = 0;
  failures = 0;
  retryAt = 0;
  private waiting: (() => void)[] = [];
  limit: number;
  maxQueued: number;
  constructor(limit: number, maxQueued: number) {
    this.limit = limit;
    this.maxQueued = maxQueued;
  }
  get queued() { return this.waiting.length; }
  async acquire(signal: AbortSignal, timeoutMs: number): Promise<(() => void) | null> {
    signal.throwIfAborted();
    if (this.active < this.limit) { this.active++; return this.release(); }
    if (this.waiting.length >= this.maxQueued) return null;
    return new Promise((resolve, reject) => {
      const remove = () => { const at = this.waiting.indexOf(start); if (at >= 0) this.waiting.splice(at, 1); clearTimeout(timer); signal.removeEventListener('abort', abort); };
      const abort = () => { remove(); reject(signal.reason); };
      const start = () => { remove(); this.active++; resolve(this.release()); };
      const timer = setTimeout(() => { remove(); resolve(null); }, timeoutMs);
      signal.addEventListener('abort', abort, {once: true});
      this.waiting.push(start);
      if (signal.aborted) abort();
    });
  }
  private release() { let released = false; return () => { if (released) return; released = true; this.active--; if (this.active < this.limit) this.waiting[0]?.(); }; }
}
// All projects using the same endpoint share admission and circuit state in this backend process.
const admissions = new Map<string, Admission>();
const tunnels = new Map<string, {opening?: Promise<boolean>; child?: ChildProcess}>();
function listening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({host: '127.0.0.1', port});
    const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(500); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
  });
}
async function transport(config: DecisionConfig, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const ssh = config.ssh;
  if (!ssh) return true;
  const key = `${ssh.user}@${ssh.host}:${ssh.port ?? 22}/${ssh.localPort}/${ssh.remotePort}`;
  const tunnel = tunnels.get(key) ?? {}; tunnels.set(key, tunnel);
  if (!tunnel.opening) tunnel.opening = (async () => {
    if (await listening(ssh.localPort)) return true;
    if (tunnel.child && tunnel.child.exitCode === null) tunnel.child.kill();
    const child = spawn('ssh', ['-N', '-p', String(ssh.port ?? 22), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
      '-L', `127.0.0.1:${ssh.localPort}:127.0.0.1:${ssh.remotePort}`, `${ssh.user}@${ssh.host}`],
    {stdio: 'ignore', windowsHide: true});
    tunnel.child = child; child.on('error', () => {}); child.unref();
    const stop = () => { if (tunnel.child === child) tunnel.child = undefined; };
    child.once('exit', stop);
    for (let i = 0; i < 40; i++) {
      if (await listening(ssh.localPort)) return true;
      if (child.exitCode !== null || !child.pid) return false;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    child.kill(); return false;
  })().finally(() => { tunnel.opening = undefined; });
  // Cancelling a station does not kill a shared connection needed by another station.
  return new Promise<boolean>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, {once: true});
    tunnel.opening!.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(signal.reason); else resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export function createDecisionClient(config: DecisionConfig): DecisionClientLike & {status(): Record<string, unknown>} {
  let url: URL;
  try {
    if (!record(config) || typeof config.baseUrl !== 'string') throw new Error('invalid');
    url = new URL(config.baseUrl);
  } catch { throw new Error('Invalid decision endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid decision endpoint');
  if (typeof config.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,95}$/.test(config.model) ||
      typeof config.apiKey !== 'string' || !config.apiKey.trim() || config.apiKey.length > 8192 || /[\r\n\0]/.test(config.apiKey) ||
      config.model.includes(config.apiKey)) throw new Error('Invalid decision configuration');
  for (const [key, minimum, maximum] of [['maxConcurrent', 1, 4], ['maxQueued', 0, 16],
    ['timeoutMs', 1, 60000], ['queueTimeoutMs', 1, 20000]] as const) {
    const value = config[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > maximum)) throw new Error('Invalid decision limits');
  }
  if (config.ssh && (url.hostname !== '127.0.0.1' || Number(url.port) !== config.ssh.localPort ||
    !/^[A-Za-z0-9_.-]+$/.test(config.ssh.host) || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(config.ssh.user) ||
    [config.ssh.localPort, config.ssh.remotePort, config.ssh.port ?? 22].some(n => !Number.isInteger(n) || n < 1 || n > 65535))) throw new Error('Invalid decision transport');
  config = {...config, ...(config.ssh ? {ssh: {...config.ssh}} : {})};
  const endpoint = url.origin;
  const quota = admissions.get(endpoint) ?? new Admission(Math.max(1, Math.min(4, config.maxConcurrent ?? 4)), Math.max(0, Math.min(16, config.maxQueued ?? 16)));
  // A second project may tighten the endpoint budget, never silently widen it.
  quota.limit = Math.min(quota.limit, config.maxConcurrent ?? 4);
  quota.maxQueued = Math.min(quota.maxQueued, config.maxQueued ?? 16);
  admissions.set(endpoint, quota);
  return {
    status: () => ({enabled: true, model: config.model, active: quota.active, queued: quota.queued, maxConcurrent: quota.limit,
      maxQueued: quota.maxQueued, circuitOpen: quota.retryAt > Date.now(), transport: config.ssh ? 'ssh' : 'http'}),
    async decide(request, {signal}) {
      signal.throwIfAborted();
      const body = payload(request, config.model);
      if (!body || quota.retryAt > Date.now()) return null;
      const release = await quota.acquire(signal, Math.max(1, Math.min(20000, config.queueTimeoutMs ?? 20000)));
      if (!release) {
        signal.throwIfAborted();
        return null;
      }
      try {
        signal.throwIfAborted();
        if (quota.retryAt > Date.now()) return null;
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(60000, config.timeoutMs ?? 60000)))]);
        if (!await transport(config, bounded)) throw new Error('transport');
        const requestId = randomUUID();
        const result = await fetch(`${endpoint}/v1/systemone`, {method: 'POST', signal: bounded,
          headers: {'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}`, 'x-typesafe-request-id': requestId}, body});
        signal.throwIfAborted();
        if (!result.ok) { await result.body?.cancel(); if (result.status >= 500 || result.status === 401 || result.status === 403) throw new Error('upstream'); return null; }
        // Bound even a misconfigured endpoint's response and never forward its error body or headers.
        const reader = result.body?.getReader(); if (!reader) return null;
        const chunks: Uint8Array[] = []; let bytes = 0;
        for (;;) { const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength; if (bytes > 128 * 1024) { await reader.cancel(); return null; } chunks.push(item.value); }
        signal.throwIfAborted();
        const answer = response(JSON.parse(Buffer.concat(chunks).toString('utf8')), request, config, requestId);
        if (!answer) throw new Error('invalid');
        quota.failures = 0; quota.retryAt = 0;
        return answer;
      } catch {
        signal.throwIfAborted();
        if (++quota.failures >= 3) quota.retryAt = Date.now() + 30000;
        return null;
      } finally { release(); }
    },
  };
}

/** Reading configuration is local only: no connection or probe during boot/replay/help. */
export function projectDecisionClient(directory: string) {
  if (process.env.FACTORY_READONLY === '1') return null;
  try {
    const filename = process.env.EASY_WORKFLOW_DECISION_MODEL_CONFIG ?? path.join(os.homedir(), '.pi', 'agent', 'easy-workflow', 'decision-model.json');
    const raw = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!record(raw) || raw.enabled !== true || !Array.isArray(raw.projects) ||
      !raw.projects.some(project => typeof project === 'string' && path.resolve(project).toLowerCase() === path.resolve(directory).toLowerCase())) return null;
    return createDecisionClient(raw as unknown as DecisionConfig);
  } catch { return null; }
}

export async function decide(ctx: StationContext, request: DecisionRequest): Promise<DecisionResponse | null> {
  ctx.signal.throwIfAborted();
  if (process.env.FACTORY_READONLY === '1' || !payload(request, 'validate-only')) return null;
  const client = scope.getStore(); if (!client) return null;
  const attempt = attemptScope.getStore();
  const span: ActivitySpan = {id: randomUUID(), kind: 'model_request', source: 'model-stream',
    operation: request.purpose, startedAt: Date.now(), status: 'running'};
  ctx.activity?.({...span});
  ctx.progress(`Kev-9B · ${request.purpose}`);
  let result: DecisionResponse | null = null;
  try {
    try {
      result = await client.decide(request, {signal: ctx.signal});
    } catch {
      ctx.signal.throwIfAborted();
    }
    span.status = result ? 'completed' : 'failed';
    if (result) {
      span.model = result.model; attempt?.responses.push(result);
      ctx.signal.throwIfAborted();
      ctx.addEvidence({id: `decision-${result.requestId}`, kind: 'verdict', label: `Kev-9B · ${request.purpose}`,
        verdict: Object.entries(result.answers).map(([id, answer]) => `${id}: ${answer.type === 'choice' ? answer.choice : answer.type === 'noul' ? answer.noul.toFixed(3) : answer.score.toFixed(3)}`).join('；'),
        meta: {model: result.model, requestId: result.requestId, latencyMs: result.latencyMs, answers: result.answers}});
    } else {
      ctx.signal.throwIfAborted();
      ctx.progress(`Kev-9B · ${request.purpose} 未取得可用判断，保留原有处理路径`);
    }
    return result;
  } finally {
    if (ctx.signal.aborted) span.status = 'cancelled'; else if (span.status === 'running') span.status = 'failed';
    span.endedAt = Date.now(); attempt?.spans.push({...span}); ctx.activity?.({...span});
  }
}

export async function decideInCurrentAttempt(request: DecisionRequest, signal: AbortSignal) {
  signal.throwIfAborted();
  const attempt = attemptScope.getStore();
  return attempt ? decide({...attempt.ctx, signal: AbortSignal.any([attempt.ctx.signal, signal])}, request) : null;
}

export function withDecisionAttempt(client: DecisionClientLike | null, ctx: StationContext, execute: Executor): Promise<StationResult> {
  const attempt: Attempt = {ctx, spans: [], responses: []};
  const merge = (result: StationResult): StationResult => {
    if (!attempt.spans.length) return result;
    const prior = result.metrics ?? {};
    const input = attempt.responses.reduce((n, r) => n + r.usage.inputTokens, 0);
    const output = attempt.responses.reduce((n, r) => n + r.usage.outputTokens, 0);
    const old = prior.tokenUsage ?? (result.usage ? {input: result.usage.input, output: result.usage.output} : undefined);
    result.metrics = {...prior,
      execution: prior.execution ?? (attempt.responses.length ? {adapter: 'system-one', model: attempt.responses.at(-1)!.model} : undefined),
      tokenUsage: old || attempt.responses.length ? {...old, input: (old?.input ?? 0) + input, output: (old?.output ?? 0) + output} : undefined,
      decisionUsage: {input: (prior.decisionUsage?.input ?? 0) + input,
        output: (prior.decisionUsage?.output ?? 0) + output,
        requests: (prior.decisionUsage?.requests ?? 0) + attempt.spans.length,
        reported: (prior.decisionUsage?.reported ?? 0) + attempt.responses.length},
      usageReported: Boolean(prior.usageReported || attempt.responses.length),
      usageComplete: (prior.usageComplete ?? true) && attempt.responses.length === attempt.spans.length,
      // These non-streaming receipts do not identify first/output-token phases.
      // Mixed totals cannot be divided by only the chat model's output duration.
      modelTimeReported: false,
      costReported: prior.costReported ?? false, costComplete: false,
      activity: {version: 1, modelTiming: prior.activity?.modelTiming ?? 'unavailable', spans: [...(prior.activity?.spans ?? []), ...attempt.spans]},
      time: {...(prior.time ?? {firstTokenMs: 0, outputMs: 0, toolMs: 0, programMs: 0, modelCalls: 0, toolCalls: 0}),
        modelCalls: (prior.time?.modelCalls ?? 0) + attempt.spans.length},
    };
    if (result.metrics.tokens) result.metrics.tokens = {...result.metrics.tokens, actualInput: result.metrics.tokens.actualInput + input, actualOutput: result.metrics.tokens.actualOutput + output};
    return result;
  };
  return withDecisionClient(client, () => attemptScope.run(attempt, async () => {
    try {
      return merge(await execute(ctx));
    } catch (reason) {
      // A later tool/contract failure cannot erase a completed inference receipt.
      const error = reason instanceof Error ? reason : new Error('工位执行未完成');
      const observed = error as Error & Pick<StationResult, 'metrics' | 'usage'>;
      const merged = merge({ok: false, summary: '工位执行未完成', metrics: observed.metrics, usage: observed.usage});
      if (merged.metrics) observed.metrics = merged.metrics;
      throw error;
    }
  }));
}
