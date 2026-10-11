// Journal → state projection. Pure and incremental: the server keeps one copy as its
// materialized view, the dashboard keeps another fed by SSE, and offline replay feeds
// a recorded journal through the very same function (Spec §10.11, §11).
import type {
  Alert, AttemptMetrics, Attachment, CaseNote, CompiledFactory, EvidenceRef, PreflightCheck, Stamped, StepDetail, TokenStatus, Usage,
} from "./types.ts";
import { legacyReply, type ConversationEntry } from "./conversation.ts";
import { mergeActivity } from "./activity.ts";

export interface WorkerState {
  id: string;
  label: string;
  node: string;
  busy: string | null;
  done: number;
  busyMs: number;
  spawnedAt: number;
  retiredAt?: number;
  forked: boolean;
  /** Busy intervals for the report's Gantt strip: [start, end?]. */
  spans: [number, number | null, string][];
}

export interface AttemptState {
  id: string;
  token: string;
  node: string;
  worker: string;
  input: string;
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
  cancelled?: boolean;
  summary?: string;
  error?: string;
  steps: { at: number; text: string; step?: StepDetail }[];
  usage: Usage;
  ms?: number;
  queuedMs?: number;
  output?: Record<string, unknown>;
  metrics?: AttemptMetrics;
}

export interface ConsultState { id: string; token: string; reviewer: string; owner: string; fields: string[]; problem: string; round: number; openedAt: number; reply?: string; replyOk?: boolean; closedAt?: number; outcome?: "resolved" | "manual"; reason?: string }

export interface TokenState {
  id: string;
  touchedAt?:number;
  line: string;
  item: string;
  url: string;
  title?: string;
  source: string;
  category?: string;
  status: TokenStatus;
  /** Nodes the token currently waits in or is being worked on at. */
  at: string[];
  attempts: string[];
  evidence: string[];
  rounds: Record<string, number>;
  corrections: number;
  data: Record<string, unknown>;
  createdAt: number;
  finishedAt?: number;
  finishedAtNode?: string;
  reason?: string;
}

export interface NodeCounters {
  /** Library size behind this node (sources, candidates, stores) or queue+active (stations). */
  stock: number;
  stockStart: number | null;
  inRun: number;
  processed: number;
  plus: number;
  sent: number;
  merged: number;
  rejected: number;
  failed: number;
  returned: number;
}

export interface NodeState extends NodeCounters {
  key: string;
  queue: string[];
  active: string[];
  workers: string[];
  passed: number;
  durations: number[];
  waits: number[];
  usage: Usage;
  strip: string[];
  summary: string;
  lastAt: number;
  lastFailAt: number;
  lastOkAt: number;
  forks: number;
  retires: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "note";
  text: string;
  at: number;
  attachments?: Attachment[];
  tools?: { name: string; summary: string }[];
  tone?: "info" | "fork" | "warn";
  node?: string;
}

export interface Transfer { seq: number; at: number; token: string; from: string; to: string; returned: boolean }

export interface FactoryState {
  batch?: import('./batch.ts').BatchGoal;
  seq: number;
  digest: string;
  run: { id: string; title: string; startedAt: number; endedAt?: number; pausedAt?: number; pausedMs: number; status: "idle" | "running" | "paused" | "ended"; manualEnd?: boolean };
  nodes: Record<string, NodeState>;
  tokens: Record<string, TokenState>;
  tokenOrder: string[];
  attempts: Record<string, AttemptState>;
  workers: Record<string, WorkerState>;
  evidence: Record<string, EvidenceRef>;
  evidenceOrder: string[];
  chat: ChatMessage[];
  conversation: ConversationEntry[];
  activity: ChatMessage[];
  recoveries: Record<string, import("./failures.ts").CandidateRecovery>;
  totals: { usage: Usage; published: number; manual: number; failed: number; rejected: number; merged: number; returned: number; corrections: number };
  resources: { used: Record<string, number>; limits: Record<string, number>; freeMemMB: number; at: number; waiting: Record<string, string> };
  /** Ring of the latest edge transfers; the canvas turns new ones into particles. */
  transfers: Transfer[];
  patches: { id: string; summary: string; status: string; at: number }[];
  reportReady: string | null;
  lockedStations: string[];
  alerts: Record<string, Alert & { at: number }>;
  preflight: { at: number; ok: boolean; checks: PreflightCheck[] } | null;
  /** Case files keyed by item, so retries continue the same dossier (Spec §33). */
  cases: Record<string, (CaseNote & { at: number; token: string })[]>;
  /** Notes, instructions and issues per node for CONTEXT.md (Spec §31). */
  contextNotes: Record<string, { kind: string; text: string; by: string; at: number }[]>;
  consults: Record<string, ConsultState>;
}

const zeroUsage = (): Usage => ({ input: 0, output: 0, cost: 0 });
const addUsage = (a: Usage, b?: Usage) => { if (b) { a.input += b.input; a.output += b.output; a.cost += b.cost; if (b.cacheRead) a.cacheRead = (a.cacheRead ?? 0) + b.cacheRead; if (b.cacheWrite) a.cacheWrite = (a.cacheWrite ?? 0) + b.cacheWrite; } };

export function emptyNode(key: string): NodeState {
  return {
    key, queue: [], active: [], workers: [], passed: 0, durations: [], waits: [], usage: zeroUsage(), strip: [], summary: "",
    lastAt: 0, lastFailAt: 0, lastOkAt: 0, forks: 0, retires: 0,
    stock: 0, stockStart: null, inRun: 0, processed: 0, plus: 0, sent: 0, merged: 0, rejected: 0, failed: 0, returned: 0,
  };
}

export function initialState(factory?: CompiledFactory): FactoryState {
  const nodes: Record<string, NodeState> = {};
  for (const n of factory?.nodes ?? []) nodes[n.key] = emptyNode(n.key);
  return {
    seq: 0, digest: factory?.digest ?? "",
    run: { id: "", title: "", startedAt: 0, pausedMs: 0, status: "idle" },
    nodes, tokens: {}, tokenOrder: [], attempts: {}, workers: {}, evidence: {}, evidenceOrder: [], chat: [], conversation: [], activity: [], recoveries: {},
    totals: { usage: zeroUsage(), published: 0, manual: 0, failed: 0, rejected: 0, merged: 0, returned: 0, corrections: 0 },
    resources: { used: {}, limits: {}, freeMemMB: 0, at: 0, waiting: {} },
    transfers: [], patches: [], reportReady: null, lockedStations: [],
    alerts: {}, preflight: null, cases: {}, contextNotes: {}, consults: {},
  };
}

const KEEP = 60;
const pushCap = <T>(arr: T[], v: T, cap = KEEP) => { arr.push(v); if (arr.length > cap) arr.splice(0, arr.length - cap); };
const remove = (arr: string[], v: string) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); };

/** Resets per-run counters when a new run starts; stock carries over. */
function resetRunCounters(s: FactoryState) {
  for (const n of Object.values(s.nodes)) {
    n.stockStart = n.stock; n.inRun = 0; n.processed = 0; n.plus = 0; n.sent = 0; n.merged = 0; n.rejected = 0; n.failed = 0; n.returned = 0; n.passed = 0;
    n.durations = []; n.waits = []; n.usage = zeroUsage(); n.forks = 0; n.retires = 0;
  }
  s.totals = { usage: zeroUsage(), published: 0, manual: 0, failed: 0, rejected: 0, merged: 0, returned: 0, corrections: 0 };
}

/** Applies one journal event in place and returns the same state object. */
export function apply(s: FactoryState, e: Stamped): FactoryState {
  s.seq = e.seq;
  const node = (key: string) => (s.nodes[key] ??= emptyNode(key));
  switch (e.kind) {
    case 'batch.configured':
      s.batch = e.batch;
      break;
    case "factory.loaded":
      s.digest = e.digest;
      break;
    case "worker.locked":
      if (e.locked && !s.lockedStations.includes(e.node)) s.lockedStations.push(e.node);
      else if (!e.locked) remove(s.lockedStations, e.node);
      break;
    case "run.started":
      s.run = { id: e.runId, title: e.title, startedAt: e.at, pausedMs: 0, status: "running" };
      s.reportReady = null;
      resetRunCounters(s);
      break;
    case "run.paused":
      s.run.status = "paused"; s.run.pausedAt = e.at;
      break;
    case "run.resumed":
      if (s.run.pausedAt) s.run.pausedMs += e.at - s.run.pausedAt;
      s.run.pausedAt = undefined; s.run.status = "running";
      break;
    case "run.ended":
      if (s.run.pausedAt) s.run.pausedMs += e.at - s.run.pausedAt;
      s.run.pausedAt = undefined; s.run.status = "ended"; s.run.endedAt = e.at; s.run.manualEnd = e.manual;
      break;
    case "stock.set": {
      const n = node(e.node);
      if (n.stockStart === null) n.stockStart = e.stock;
      n.stock = e.stock;
      break;
    }
    case "token.created": {
      s.tokens[e.token] = {
        id: e.token, line: e.line, item: e.item, url: e.url, title: e.title, source: e.source, category: e.category,
        status: "active", at: [], attempts: [], evidence: [], rounds: {}, corrections: 0, data: {}, createdAt: e.at,
      };
      s.tokenOrder.push(e.token);
      const src = s.nodes[e.source];
      if (src) { src.sent++; src.processed++; }
      break;
    }
    case "token.queued": {
      const t = s.tokens[e.token];
      if (!t) break;
      t.touchedAt=e.at;
      const n = node(e.node);
      if (e.from) {
        remove(t.at, e.from);
        const prev = s.nodes[e.from];
        if (prev) remove(prev.queue, e.token);
        if (prev && !e.returned) prev.sent++;
        pushCap(s.transfers, { seq: e.seq, at: e.at, token: e.token, from: e.from, to: e.node, returned: !!e.returned }, 200);
      }
      if (!t.at.includes(e.node)) t.at.push(e.node);
      if (!n.queue.includes(e.token)) n.queue.push(e.token);
      n.inRun++;
      n.lastAt = e.at;
      break;
    }
    case "attempt.started": {
      const n = node(e.node);
      remove(n.queue, e.token);
      n.active.push(e.attempt);
      s.attempts[e.attempt] = { id: e.attempt, token: e.token, node: e.node, worker: e.worker, input: e.input, startedAt: e.at, steps: [], usage: zeroUsage() };
      s.tokens[e.token]?.attempts.push(e.attempt);
      const w = s.workers[e.worker];
      if (w) { w.busy = e.attempt; w.spans.push([e.at, null, e.token]); if (w.spans.length > 400) w.spans.shift(); }
      n.summary = e.input;
      n.lastAt = e.at;
      break;
    }
    case "attempt.progress": {
      const a = s.attempts[e.attempt];
      if (!a) break;
      a.steps.push({ at: e.at, text: e.text, step: e.step });
      if (a.steps.length > 80) a.steps.splice(0, a.steps.length - 80);
      const n = s.nodes[a.node];
      if (n && n.active.includes(a.id)) { n.summary = e.text; n.lastAt = e.at; }
      break;
    }
    case "attempt.activity": {
      const a = s.attempts[e.attempt];
      if (a) a.metrics = { ...a.metrics, activity: mergeActivity(a.metrics?.activity, { version: 1, modelTiming: e.activity.source === "model-stream" ? "observed" : "unavailable", spans: [e.activity] }) };
      break;
    }
    case "attempt.finished": {
      const a = s.attempts[e.attempt];
      if (!a) break;
      const ok = e.ok && !/^(打不开[：:]|HTTP [45]\d\d|网址无法解析)/.test(e.summary);
      a.cancelled = e.cancelled || e.error === "stale";
      const activity = mergeActivity(a.metrics?.activity, e.metrics?.activity);
      a.endedAt = e.at; a.ok = ok; a.summary = e.summary; a.error = e.error; a.ms = e.ms; a.queuedMs = e.queuedMs; a.output = e.output; a.metrics = activity ? { ...e.metrics, activity } : e.metrics;
      addUsage(a.usage, e.usage);
      const n = node(a.node);
      remove(n.active, a.id);
      addUsage(n.usage, e.usage);
      addUsage(s.totals.usage, e.usage);
      if(ok) pushCap(n.durations, e.ms);
      pushCap(n.waits, e.queuedMs);
      if (ok) { n.processed++; n.lastOkAt = e.at; } else if(!e.cancelled && e.error!=="stale") { n.failed++; n.lastFailAt = e.at; }
      n.summary = ok || e.cancelled ? e.summary : `失败：${e.error ?? e.summary}`;
      n.lastAt = e.at;
      const w = s.workers[a.worker];
      if (w) {
        w.busy = null; w.done++; w.busyMs += e.ms;
        const span = w.spans[w.spans.length - 1];
        if (span && span[1] === null) span[1] = e.at;
      }
      break;
    }
    case "evidence.added": {
      const ev = e.evidence;
      s.evidence[ev.id] = ev;
      s.evidenceOrder.push(ev.id);
      s.tokens[ev.token]?.evidence.push(ev.id);
      const n = node(ev.station);
      n.strip.unshift(ev.id);
      if (n.strip.length > 3) n.strip.length = 3;
      break;
    }
    case "review.verdict": {
      const n = node(e.node);
      if (e.verdict === "pass") n.passed++;
      break;
    }
    case "token.returned": {
      const t = s.tokens[e.token];
      if (!t) break;
      t.rounds[e.to] = e.round;
      if (e.byHuman) t.corrections++;
      for (const k of e.reset ?? []) { remove(node(k).queue, t.id); remove(t.at, k); }
      if (t.status !== "active") { t.status = "active"; t.finishedAt = undefined; t.finishedAtNode = undefined; }
      s.totals.returned++;
      node(e.from).returned++;
      break;
    }
    case "token.data": {
      const t = s.tokens[e.token];
      if (t) Object.assign(t.data, e.patch);
      break;
    }
    case "token.finished": {
      const t = s.tokens[e.token];
      if (!t) break;
      t.status = e.status; t.finishedAt = e.at; t.finishedAtNode = e.node; t.reason = e.reason;
      if(s.recoveries[t.item]?.token===t.id && s.recoveries[t.item].disposition==="claimed" && e.status!=="parked")s.recoveries[t.item].disposition="resolved";
      for (const k of t.at) remove(node(k).queue, t.id);
      t.at = [];
      const n = node(e.node);
      if (e.status === "merged") { n.merged++; s.totals.merged++; }
      else if (e.status === "rejected") { n.rejected++; s.totals.rejected++; }
      else if (e.status === "failed") { s.totals.failed++; }
      else if (e.status === "manual") { s.totals.manual++; }
      else if (e.status === "published") { s.totals.published++; }
      if (e.status === "published" || e.status === "manual" || e.status === "parked") n.plus++;
      break;
    }
    case "candidate.disposition": {
      const prior=s.recoveries[e.candidate.item];
      s.recoveries[e.candidate.item]={...e.candidate,at:e.at,attempts:(prior?.attempts??0)+((e.candidate.disposition==="retry"||e.candidate.disposition==="removed")&&!(prior?.token===e.candidate.token&&prior.disposition===e.candidate.disposition)?1:0)};
      const t=s.tokens[e.candidate.token];
      if(t && t.status!=="active" && (e.candidate.disposition==="retry"||e.candidate.disposition==="removed")) {
        // Old versions rejected network failures as successes. Keep the immutable
        // log, but project the explicit recovery disposition for history and UI.
        const next=e.candidate.disposition==="retry"?"parked":"rejected";
        if(t.createdAt>=s.run.startedAt && t.status!==next) {
          if(t.status==="rejected")s.totals.rejected=Math.max(0,s.totals.rejected-1);
          if(t.status==="manual")s.totals.manual=Math.max(0,s.totals.manual-1);
          if(next==="rejected")s.totals.rejected++;
        }
        t.status=next;t.reason=`${next==="parked"?"已退回候选库":"已移除无效网址"}：${e.candidate.failure?.message??""}`;
      }
      break;
    }
    case "worker.spawned":
    case "worker.forked": {
      s.workers[e.worker] = { id: e.worker, label: e.label, node: e.node, busy: null, done: 0, busyMs: 0, spawnedAt: e.at, forked: e.kind === "worker.forked", spans: [] };
      const n = node(e.node);
      n.workers.push(e.worker);
      if (e.kind === "worker.forked") n.forks++;
      break;
    }
    case "worker.retired": {
      const w = s.workers[e.worker];
      if (w) w.retiredAt = e.at;
      const n = node(e.node);
      remove(n.workers, e.worker);
      n.retires++;
      break;
    }
    case "correction.created": {
      s.totals.corrections++;
      break;
    }
    case "dispatch.note":
      pushCap(s.activity, { id: `note-${e.seq}`, role: "note", text: e.text, at: e.at, tone: e.tone, node: e.node }, 100);
      break;
    case "chat.user":
      s.chat.push({ id: e.id, role: "user", text: e.text, at: e.at, attachments: e.attachments });
      s.conversation.push({ id: e.id, turn: e.id, message: { role: "user", content: e.text, timestamp: e.at }, attachments: e.attachments });
      break;
    case "chat.message":
      if (!s.conversation.some((m) => m.id === e.id)) s.conversation.push({ id: e.id, turn: e.turn, message: e.message });
      break;
    case "chat.assistant":
      s.chat.push({ id: e.id, role: "assistant", text: e.text, at: e.at, tools: e.tools });
      // Older journals only recorded final text. New turns already have native messages.
      if (!s.conversation.some((m) => m.turn === e.id.replace(/-r$/, "") && m.message.role === "assistant"))
        s.conversation.push({ id: e.id, turn: e.id.replace(/-r$/, ""), message: legacyReply(e.text, e.at) });
      break;
    case "spec.patched": {
      const p = s.patches.find((x) => x.id === e.patch);
      if (p) p.status = e.status; else s.patches.push({ id: e.patch, summary: e.summary, status: e.status, at: e.at });
      break;
    }
    case "resource.sample":
      s.resources = { used: e.used, limits: e.limits, freeMemMB: e.freeMemMB, at: e.at, waiting: e.waiting ?? {} };
      break;
    case "report.ready":
      s.reportReady = e.runId;
      break;
    case "channel.emitted":
      break;
    case "alert.raised":
      (s.alerts ??= {})[e.alert.id] = { ...e.alert, at: e.at };
      break;
    case "alert.cleared":
      if (s.alerts) delete s.alerts[e.id];
      break;
    case "preflight.checked":
      s.preflight = { at: e.at, ok: e.ok, checks: e.checks };
      break;
    case "case.noted":
      pushCap(((s.cases ??= {})[e.caseId] ??= []), { ...e.note, at: e.at, token: e.token }, 400);
      break;
    case "context.noted":
      pushCap(((s.contextNotes ??= {})[e.node] ??= []), { ...e.note, at: e.at }, 40);
      break;
    case "consult.opened":
      (s.consults ??= {})[e.consult] = { id: e.consult, token: e.token, reviewer: e.reviewer, owner: e.owner, fields: e.fields, problem: e.problem, round: e.round, openedAt: e.at };
      break;
    case "consult.replied": {
      const c = s.consults?.[e.consult];
      if (c) { c.reply = e.reply; c.replyOk = e.ok; }
      break;
    }
    case "consult.closed": {
      const c = s.consults?.[e.consult];
      if (c) { c.closedAt = e.at; c.outcome = e.outcome; c.reason = e.reason; }
      break;
    }
  }
  return s;
}

/* ------------------------------------------------------------------ derived */

export type Light = "green" | "yellow" | "red" | "gray" | "idle";

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(q * a.length))];
}

export function nodeLight(n: NodeState | undefined, dormant: boolean, now: number): Light {
  if (dormant) return "gray";
  if (!n) return "idle";
  if (n.lastFailAt && n.lastFailAt > n.lastOkAt && now - n.lastFailAt < 120_000) return "red";
  const workers = Math.max(1, n.workers.length);
  if (n.queue.length >= 2 * workers || (n.returned && now - n.lastAt < 30_000)) return "yellow";
  if (n.active.length) return "green";
  if (n.failed) return "yellow";
  if (n.processed || n.stock) return "green";
  return "idle";
}

/** A retry is another attempt at the same item, not another unresolved item. */
export function latestRunTokens(s:FactoryState) {
  const latest=new Map<string,TokenState>();
  for(const id of s.tokenOrder){const t=s.tokens[id];if(!t||(t.touchedAt??t.createdAt)<s.run.startedAt)continue;
    if (typeof t.data.retriedBy === 'string' && s.tokens[t.data.retriedBy]?.item === t.item) continue;
    const prior=latest.get(t.item);if(!prior||(t.touchedAt??t.createdAt)>=(prior.touchedAt??prior.createdAt))latest.set(t.item,t);
  }
  return [...latest.values()];
}

/** Station takt: median service time divided by worker count (Spec §7.2). */
export function takt(n: NodeState): number {
  const s = median(n.durations);
  return s / Math.max(1, n.workers.length);
}

export function elapsed(run: FactoryState["run"], now: number): number {
  if (!run.startedAt) return 0;
  const end = run.endedAt ?? now;
  const paused = run.pausedMs + (run.pausedAt ? end - run.pausedAt : 0);
  return Math.max(0, end - run.startedAt - paused);
}
