// Line runtime (Spec §5, §7, §12): tokens stream through stations; every station has a
// queue and a worker pool; branches, joins and bounded return loops follow the compiled
// spec; the balancer measures service times and forks or retires same-duty workers.
// Everything that changes state is journaled first.
import crypto from "node:crypto";
import type { ActivitySpan, AttemptMetrics, CompiledEdge, CompiledFactory, CompiledNode, EvidenceRef, StepDetail, TokenStatus, Usage } from "../shared/types.ts";
import { median } from "../shared/project.ts";
import { classifyFailure, candidateFailure, failureLabels, type Failure } from "../shared/failures.ts";
import { ControlError } from "./errors.ts";
import { readRole } from "./roles.ts";
import type { Broker, Lease } from "./broker.ts";
import type { Journal } from "./journal.ts";
import { browserAttemptScope, withBrowserAttempt, type BrowserPoolFault } from "./browser.ts";

export interface TokenRun {
  id: string;
  item: string;
  url: string;
  title?: string;
  source: string;
  entry: string;
  data: Record<string, unknown>;
  closure: Set<string>;
  done: Set<string>;
  dead: Set<string>;
  edgeLive: Map<string, boolean>;
  inflight: Set<string>;
  queuedAt: Map<string, number>;
  failures: Map<string, number>;
  rounds: Record<string, number>;
  /** Bumped on every return; attempts from an older epoch are void. */
  epoch: number;
  nodeEpochs?:Map<string,number>;
  finished: boolean;
  finishedStore?:string;
  notes: Map<string, { reason: string; note?: string; byHuman: boolean }>;
  /** Open direct consultation between a reviewer and field owners (Spec §34). */
  consult?: Consultation;
  pendingConsults?: { reviewer: string; fixes: Fix[]; reason: string }[];
}

interface Consultation {
  reviewer: string;
  queue: (Fix & { id: string })[];
  current?: Fix & { id: string };
  chain: string[];
  replies: string[];
  open: string[];
  /** An intermediate reviewer must approve its own repair before this chain resumes. */
  parent?: Consultation;
}

export interface Worker { id: string; label: string; node: string; busy: string | null; idleSince: number }

export interface StationContext {
  token: Readonly<TokenRun>;
  node: CompiledNode;
  attempt: string;
  worker: Worker;
  signal: AbortSignal;
  /** Set when this attempt re-runs a returned or corrected token. */
  redo?: { reason: string; note?: string; byHuman: boolean };
  progress(text: string, step?: StepDetail): void;
  /** Observations remain journaled even when cancellation invalidates the output. */
  activity?(activity: ActivitySpan): void;
  addEvidence(ev: Omit<EvidenceRef, "station" | "token" | "attempt" | "at">): EvidenceRef;
}

export interface StationResult {
  ok: boolean;
  summary: string;
  data?: Record<string, unknown>;
  usage?: Usage;
  metrics?: AttemptMetrics;
  /** Structured notes for the item's case file (Spec §33). */
  caseNotes?: { section: string; text: string }[];
  error?: string;
  failure?:Failure;
  verdict?: { verdict: "pass" | "return" | "escalate" | "fix"; returnTo?: string; reason: string; fixes?: Fix[] };
  /** Leave the line here (duplicate, unreachable site…). */
  finish?: { status: TokenStatus; reason: string };
}

export type Executor = (ctx: StationContext) => Promise<StationResult>;

/** A reviewer's request to the station that owns some fields (Spec §34). `via` lists the
 *  stations that must re-run after the owner before the reviewer looks again. */
export interface Fix { station: string; fields: string[]; problem: string; via?: string[] }
const MAX_CONSULT_ROUNDS = 3;
const MAX_BROWSER_RECOVERIES = 2;

const RHO = 0.8;
const FORK_BACKLOG_MS = 30_000;
const RETIRE_IDLE_MS = 120_000;
const DEBOUNCE_MS = 60_000;

const short = () => crypto.randomBytes(4).toString("hex");

export class Runtime {
  f: CompiledFactory;
  nodes = new Map<string, CompiledNode>();
  outFlow = new Map<string, CompiledEdge[]>();
  inFlow = new Map<string, CompiledEdge[]>();
  returns = new Map<string, CompiledEdge[]>();
  channelsOut = new Map<string, CompiledEdge[]>();
  tokens = new Map<string, TokenRun>();
  queues = new Map<string, string[]>();
  workers = new Map<string, Worker[]>();
  arrivals = new Map<string, number[]>();
  durations = new Map<string, number[]>();
  backlogSince = new Map<string, number>();
  lastAdjust = new Map<string, number>();
  locked = new Set<string>();
  waiting: Record<string, string> = {};
  paused = false;
  running = false;
  ending = false;
  runStartedAt = 0;
  private scheduling = false;
  private again = false;
  private aborts = new Map<string, AbortController>();
  private attemptTokens = new Map<string,string>();
  onRecovery?: (token:TokenRun,failure:Failure)=>void;
  /** Owner-facing problems (certificate, login, model quota) light the red alert. */
  onAlert?: (token:TokenRun,node:CompiledNode,failure:Failure)=>void;
  onPark?: (token:TokenRun)=>void;
  onTick?: () => void;
  private jobs = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private lastSample = 0;
  wiredLines: Set<string>;

  journal: Journal;
  broker: Broker;
  conditions: Record<string, (d: Record<string, unknown>) => boolean>;
  executors: (node: CompiledNode) => Executor | null;

  constructor(
    f: CompiledFactory,
    journal: Journal,
    broker: Broker,
    conditions: Record<string, (d: Record<string, unknown>) => boolean>,
    executors: (node: CompiledNode) => Executor | null,
  ) {
    this.journal = journal; this.broker = broker; this.conditions = conditions; this.executors = executors;
    this.f = f;
    this.wiredLines = new Set(f.lines.filter((l) => l.wired).map((l) => l.id));
    for (const n of f.nodes) { this.nodes.set(n.key, n); this.queues.set(n.key, []); this.workers.set(n.key, []); }
    for (const e of f.edges) {
      const map = e.kind === "flow" ? this.outFlow : e.kind === "return" ? this.returns : this.channelsOut;
      map.set(e.from, [...(map.get(e.from) ?? []), e]);
      if (e.kind === "flow") this.inFlow.set(e.to, [...(this.inFlow.get(e.to) ?? []), e]);
    }
    broker.onRelease = () => this.schedule();
  }

  /* -------------------------------------------------------------- lifecycle */

  runnable(n: CompiledNode) { return n.kind !== "source" && n.kind !== "store" && this.wiredLines.has(n.line) && !n.dormant; }

  /** Spawns the initial pools (fresh factory) or adopts the journaled ones (restart). */
  ensureWorkers(existing: { node: string; worker: string; label: string }[]) {
    for (const w of existing) this.workers.get(w.node)?.push({ id: w.worker, label: w.label, node: w.node, busy: null, idleSince: Date.now() });
    for (const n of this.f.nodes) {
      if (!this.runnable(n)) continue;
      const pool = this.workers.get(n.key)!;
      while (pool.length < Math.max(n.workers.initial, n.workers.min, 1)) this.spawn(n, "初始配员（规格 workers.initial）", false);
    }
  }

  private spawn(n: CompiledNode, reason: string, forked: boolean): Worker {
    const pool = this.workers.get(n.key)!;
    const used = new Set(pool.map((w) => w.label));
    let i = 1;
    while (used.has(`${n.name}-${i}`)) i++;
    const w: Worker = { id: `w-${n.key.split("/")[1]}-${short()}`, label: `${n.name}-${i}`, node: n.key, busy: null, idleSince: Date.now() };
    pool.push(w);
    this.journal.append({ kind: forked ? "worker.forked" : "worker.spawned", node: n.key, worker: w.id, label: w.label, reason });
    return w;
  }

  start(title: string) {
    if(this.ending)throw new ControlError(409,"run_ending","正在结束上一轮，请等待报告生成");
    // Starting an existing paused run must never reset its identity or counters.
    if (this.running) return this.journal.run;
    const runId = `run-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${short().slice(0, 4)}`;
    this.journal.append({ kind: "run.started", runId, title });
    this.running = true; this.paused = false; this.runStartedAt = Date.now();
    this.arrivals.clear(); this.durations.clear();
    this.backlogSince.clear(); this.lastAdjust.clear();
    for (const pool of this.workers.values()) for (const w of pool) if (!w.busy) w.idleSince = this.runStartedAt;
    this.tick();
    return runId;
  }

  pause() { if (!this.running || this.paused) return; this.paused = true; this.journal.append({ kind: "run.paused", runId: this.journal.run }); }
  resume() {
    if (!this.running || !this.paused) return;
    this.paused = false;
    const now = Date.now();
    for (const pool of this.workers.values()) for (const w of pool) if (!w.busy) w.idleSince = now;
    this.backlogSince.clear();
    this.journal.append({ kind: "run.resumed", runId: this.journal.run }); this.schedule();
  }

  /** Manual end only (Spec §10.12): crashes and network loss never end a run. */
  end() {
    if (!this.running) return null;
    for (const c of this.aborts.values()) c.abort();
    this.running = false; this.paused = false;
    const runId = this.journal.run;
    for (const t of this.tokens.values()) if (!t.finished) this.parkUnfinished(t);
    this.journal.append({ kind: "run.ended", runId, manual: true });
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    return runId;
  }

  private parkUnfinished(t: TokenRun) {
    for (const q of this.queues.values()) { const i = q.indexOf(t.id); if (i >= 0) q.splice(i, 1); }
    t.finished = true;
    const back = this.nodes.get(t.source)?.kind === "store" ? t.source : t.entry;
    this.journal.append({ kind: "token.finished", token: t.id, status: "parked", node: back, reason: "本轮结束时仍在途：退回候选层，下一轮接着做" });
    if(this.onPark)this.onPark(t);else if (back === t.source) this.stockDelta(back, +1, `${t.item} 退回候选库`);
  }

  tick() {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.balance(); this.onTick?.(); } catch (err) { console.error("balance", err); } }, 5000);
  }

  dispose() {
    this.paused = true;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const ctrl of this.aborts.values()) ctrl.abort();
  }

  async close() {
    this.dispose();
    await Promise.allSettled([...this.jobs]);
  }

  async settle() {
    // create/enqueue dispatch on a microtask; completed jobs can also enqueue the
    // next station or a browser recovery. Observe those before declaring quiescence.
    while (true) {
      await Promise.resolve();
      const jobs = [...this.jobs];
      if (!jobs.length) return;
      await Promise.allSettled(jobs);
    }
  }

  setWorkerLock(key: string, locked: boolean, reason: string) {
    const n = this.nodes.get(key);
    if (!n || !this.runnable(n)) return false;
    this.journal.append({ kind: "worker.locked", node: key, locked, reason });
    if (locked) this.locked.add(key); else this.locked.delete(key);
    return true;
  }

  /* -------------------------------------------------------------- tokens */

  closureOf(entry: string): Set<string> {
    const seen = new Set<string>([entry]);
    const stack = [entry];
    while (stack.length) for (const e of this.outFlow.get(stack.pop()!) ?? []) if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
    return seen;
  }

  /** Rebuild both live and skipped branches before a checkpoint or restart resumes.
   * A join must know that an unselected sibling (e.g. video vs screenshots) is
   * resolved; otherwise it waits forever for work that should never run. */
  restoreFlow(t:TokenRun) {
    t.dead.clear();t.edgeLive.clear();
    for(const key of t.done)for(const edge of this.outFlow.get(key)??[])
      t.edgeLive.set(edge.key,!edge.when||Boolean(this.conditions[edge.when]?.(t.data)));
    let changed=true;
    while(changed){changed=false;
      for(const key of t.closure){
        if(t.done.has(key)||t.dead.has(key))continue;
        const ins=(this.inFlow.get(key)??[]).filter(e=>t.closure.has(e.from));
        if(!ins.length||!ins.every(e=>t.edgeLive.get(e.key)===false))continue;
        t.dead.add(key);changed=true;
        for(const edge of this.outFlow.get(key)??[])t.edgeLive.set(edge.key,false);
      }
    }
  }

  create(entry: string, item: { item: string; url: string; title?: string; source: string; category?: string; data?: Record<string, unknown> }): TokenRun {
    const t: TokenRun = {
      id: `t-${short()}`, item: item.item, url: item.url, title: item.title, source: item.source, entry,
      data: { ...(item.data ?? {}) }, closure: this.closureOf(entry), done: new Set(), dead: new Set(), edgeLive: new Map(),
      inflight: new Set(), queuedAt: new Map(), failures: new Map(), rounds: {}, epoch: 0, finished: false, notes: new Map(),
    };
    this.tokens.set(t.id, t);
    this.journal.append({ kind: "token.created", token: t.id, line: this.nodes.get(entry)!.line, item: item.item, url: item.url, title: item.title, source: item.source, category: item.category });
    if (item.data && Object.keys(item.data).length) this.journal.append({ kind: "token.data", token: t.id, patch: item.data });
    this.enqueue(t, entry, item.source);
    return t;
  }

  private enqueue(t: TokenRun, key: string, from?: string, returned = false) {
    const n = this.nodes.get(key)!;
    this.journal.append({ kind: "token.queued", token: t.id, node: key, from, returned });
    (this.arrivals.get(key) ?? this.arrivals.set(key, []).get(key)!).push(Date.now());
    if (n.kind === "store") return this.arriveAtStore(t, n);
    if (!this.runnable(n)) {
      t.finished = true;
      this.journal.append({ kind: "token.finished", token: t.id, status: "parked", node: key, reason: "这条线还没接工具，货先停在这里" });
      return;
    }
    const q = this.queues.get(key)!;
    if (returned) q.unshift(t.id); else q.push(t.id);
    t.queuedAt.set(key, Date.now());
    this.schedule();
  }

  private arriveAtStore(t: TokenRun, n: CompiledNode) {
    // A store with outgoing edges is a buffer: express tokens (hand-pasted) pass straight through.
    if (t.data.express && (this.outFlow.get(n.key) ?? []).length) { this.complete(t, n.key); return; }
    t.finished = true;
    t.finishedStore=n.key;
    const status: TokenStatus = n.key.endsWith("/published") ? "published" : n.key.endsWith("/manual") ? "manual" : "parked";
    if (status === "published") t.data.published = true;
    this.journal.append({ kind: "token.finished", token: t.id, status, node: n.key, reason: status === "published" ? "通过发布闸门" : String(t.data.manualReason ?? "等候处理") });
    this.stockDelta(n.key, +1);
  }

  stock = new Map<string, number>();
  stockDelta(key: string, d: number, note?: string) {
    const v = Math.max(0, (this.stock.get(key) ?? 0) + d);
    this.stock.set(key, v);
    this.journal.append({ kind: "stock.set", node: key, stock: v, note });
  }

  /* -------------------------------------------------------------- scheduling */

  schedule() {
    if (this.scheduling) { this.again = true; return; }
    this.scheduling = true;
    queueMicrotask(() => {
      try {
        do { this.again = false; this.dispatch(); } while (this.again);
      } finally { this.scheduling = false; }
    });
  }

  private dispatch() {
    if (!this.running || this.paused) return;
    const prio = { high: 0, mid: 1, low: 2 } as const;
    const lines = new Map(this.f.lines.map((l) => [l.id, prio[l.priority]]));
    const keys = [...this.queues.keys()].filter((k) => this.queues.get(k)!.length)
      .sort((a, b) => lines.get(this.nodes.get(a)!.line)! - lines.get(this.nodes.get(b)!.line)! || (this.nodes.get(b)!.kind === "review" ? 1 : 0) - (this.nodes.get(a)!.kind === "review" ? 1 : 0));
    const waiting: Record<string, string> = {};
    for (const key of keys) {
      const n = this.nodes.get(key)!;
      const q = this.queues.get(key)!;
      for (const w of this.workers.get(key)!) {
        if (!q.length) break;
        if (w.busy) continue;
        const why = this.broker.blocked(n.resource, { review: n.kind === "review" });
        if (why) { waiting[key] = why; break; }
        const lease = this.broker.tryAcquire(n.resource, { review: n.kind === "review" })!;
        const tid = q.shift()!;
        const t = this.tokens.get(tid);
        if (!t || t.finished) { lease.release(); continue; }
        const job = this.run(w, t, n, lease);
        this.jobs.add(job);
        void job.finally(() => this.jobs.delete(job)).catch((error) => console.error("worker settlement", error));
      }
      if (q.length && !waiting[key] && this.workers.get(key)!.every((w) => w.busy)) waiting[key] = "工人都在忙";
    }
    this.waiting = waiting;
  }

  private describeInput(t: TokenRun, n: CompiledNode): string {
    const redo = t.notes.get(n.key);
    const base = t.title ? `${t.item} · ${t.title}` : t.item;
    return redo ? `${base}（${redo.byHuman ? "站长纠错" : "被退回"}：${redo.reason}）` : base;
  }

  private async run(w: Worker, t: TokenRun, n: CompiledNode, lease: Lease) {
    const attempt = `a-${short()}`;
    const epoch = t.nodeEpochs?.get(n.key)??0;
    const queuedMs = Date.now() - (t.queuedAt.get(n.key) ?? Date.now());
    const ctrl = new AbortController();
    const browserScope = browserAttemptScope(ctrl.signal, fault => ctrl.abort(fault));
    this.aborts.set(attempt, ctrl);
    this.attemptTokens.set(attempt,t.id);
    w.busy = attempt;
    t.inflight.add(n.key);
    this.journal.append({ kind: "attempt.started", attempt, token: t.id, node: n.key, worker: w.id, input: this.describeInput(t, n) });
    const t0 = Date.now();
    const exec = this.executors(n);
    let res: StationResult;
    try {
      if (!exec) throw new Error(`工位 ${n.key} 没有执行器`);
      const role=readRole(n.key);
      this.journal.append({kind:"attempt.progress",attempt,text:`按 ${n.name} 的 ROLE.md 执行`,step:{tool:"role",text:`${role.path} @ ${role.revision}`}});
      res = await withBrowserAttempt(browserScope, () => exec({
        token: t, node: n, attempt, worker: w, signal: ctrl.signal, redo: t.notes.get(n.key),
        progress: (text, step) => {
          if (!ctrl.signal.aborted && (t.nodeEpochs?.get(n.key)??0) === epoch && !t.finished) this.journal.append({ kind: "attempt.progress", attempt, text, step });
        },
        activity: activity => { this.journal.append({ kind: "attempt.activity", attempt, activity }); },
        addEvidence: (ev) => {
          ctrl.signal.throwIfAborted();
          if ((t.nodeEpochs?.get(n.key)??0) !== epoch || t.finished) throw new Error("stale attempt");
          const full: EvidenceRef = { ...ev, station: n.key, token: t.id, attempt, at: Date.now() };
          this.journal.append({ kind: "evidence.added", evidence: full });
          return full;
        },
      }));
    } catch (err) {
      const failure=(err as {failure?:Failure})?.failure ?? classifyFailure(err,{url:t.url});
      const observed = err as { usage?: Usage; metrics?: AttemptMetrics };
      res = { ok: false, summary: "工具出错", error: failure.message, failure, usage: observed?.usage, metrics: observed?.metrics };
    } finally {
      lease.release();
      this.aborts.delete(attempt);
      this.attemptTokens.delete(attempt);
      w.busy = null; w.idleSince = Date.now();
    }
    const ms = Date.now() - t0;
    if (browserScope.fault && this.running && !this.ending && !t.finished && (t.nodeEpochs?.get(n.key) ?? 0) === epoch) {
      this.recoverBrowserAttempt(t, n, attempt, browserScope.fault, res, ms, queuedMs);
      this.schedule();
      return;
    }
    if (ctrl.signal.aborted || (t.nodeEpochs?.get(n.key)??0) !== epoch || t.finished) {
      this.journal.append({ kind: "attempt.finished", attempt, ok: false, cancelled:true, summary: "已取消：任务已退回或本轮已结束", ms, queuedMs, usage: res.usage, metrics: res.metrics, error: "stale" });
      if((t.nodeEpochs?.get(n.key)??0)===epoch)t.inflight.delete(n.key);
      this.schedule();
      return;
    }
    if (res.data && Object.keys(res.data).length) { Object.assign(t.data, res.data); this.journal.append({ kind: "token.data", token: t.id, patch: res.data }); }
    const metrics = res.metrics ?? (n.kind === "agent" || n.kind === "review" ? undefined : { time: { firstTokenMs: 0, outputMs: 0, toolMs: 0, programMs: ms, modelCalls: 0, toolCalls: 0 } });
    this.journal.append({ kind: "attempt.finished", attempt, ok: res.ok, summary: res.summary, ms, queuedMs, usage: res.usage, error: res.error, metrics });
    for (const c of res.ok ? res.caseNotes ?? [] : []) this.journal.append({ kind: "case.noted", caseId: t.item, token: t.id, note: { station: n.key, section: c.section, text: c.text, by: n.key } });
    if (res.ok && n.kind !== "store") this.journal.append({ kind: "case.noted", caseId: t.item, token: t.id, note: { station: n.key, section: res.verdict ? `审核：${({ pass: "通过", return: "退回", escalate: "交人", fix: "要求修改" } as Record<string, string>)[res.verdict.verdict]}` : "结果", text: res.verdict?.reason && res.verdict.verdict !== "pass" ? `${res.summary}\n${res.verdict.reason}` : res.summary, by: "runtime" } });
    t.inflight.delete(n.key);
    t.notes.delete(n.key);
    if (res.ok) (this.durations.get(n.key) ?? this.durations.set(n.key, []).get(n.key)!).push(ms);

    if (!res.ok) {
      this.closeConsult(t, "manual", res.error ?? res.summary);
      const failure=candidateFailure(res.failure ?? classifyFailure(res.error??res.summary,{url:t.url,stage:n.kind==="agent"||n.kind==="review"?"model":undefined}),String(t.data.canonical??t.url));
      if(failure.owner==="user")this.onAlert?.(t,n,failure);
      t.finished=true;t.data.failure=failure;
      for(const [id,controller] of this.aborts)if(this.attemptTokens.get(id)===t.id)controller.abort();
      for(const q of this.queues.values()){const i=q.indexOf(t.id);if(i>=0)q.splice(i,1);}
      this.journal.append({kind:"token.data",token:t.id,patch:{failure}});
      const reason=failure.retryable?`已退回候选库，等待按标签重试：${failure.message}`:`已移出候选库：${failure.message}`;
      this.journal.append({kind:"token.finished",token:t.id,node:n.key,status:failure.retryable?"parked":"rejected",reason});
      this.onRecovery?.(t,failure);
      this.journal.append({kind:"dispatch.note",node:n.key,tone:"warn",text:`[${n.name}] ${t.title||t.item}：${failureLabels[failure.tag]}，${failure.retryable?"已退回候选库，可按原因重试":"已移除无效网址"}`});
    } else if (res.finish) {
      this.closeConsult(t, "manual", res.finish.reason);
      t.finished = true;
      for (const q of this.queues.values()) { const i = q.indexOf(t.id); if (i >= 0) q.splice(i, 1); }
      this.journal.append({ kind: "token.finished", token: t.id, status: res.finish.status, node: n.key, reason: res.finish.reason });
    } else if (t.consult && (t.consult.chain[0] === n.key || t.consult.reviewer === n.key)) {
      this.consultResult(t, n, res);
    } else if (res.verdict) {
      const v = res.verdict.verdict === "fix" ? "return" : res.verdict.verdict;
      this.journal.append({ kind: "review.verdict", token: t.id, node: n.key, verdict: v, returnTo: res.verdict.returnTo ?? res.verdict.fixes?.[0]?.station, reason: res.verdict.reason });
      if (res.verdict.verdict === "fix") this.openConsult(t, n, res.verdict.fixes ?? [], res.verdict.reason);
      else {
        if (t.consult?.reviewer === n.key) this.closeConsult(t, res.verdict.verdict === "pass" ? "resolved" : "manual", res.verdict.reason);
        if (res.verdict.verdict === "return" && res.verdict.returnTo) this.returnToken(t, n.key, res.verdict.returnTo, res.verdict.reason, false);
        else if (res.verdict.verdict === "escalate") this.toManual(t, n, res.verdict.reason);
        else this.complete(t, n.key);
      }
    } else {
      if (t.consult?.reviewer === n.key) this.closeConsult(t, "resolved", "复查通过");
      this.complete(t, n.key);
    }
    this.schedule();
  }

  /** Pool faults invalidate the whole attempt, even if a tool caught its page exception.
   * Requeue only this station; completed predecessors, parallel branches and consultations
   * retain their checkpoints. Persistent faults stay recoverable without a station failure. */
  private recoverBrowserAttempt(t: TokenRun, n: CompiledNode, attempt: string, fault: BrowserPoolFault, res: StationResult, ms: number, queuedMs: number) {
    const previous = t.data.browserRecoveries as Record<string, { token: string; count: number }> | undefined;
    const count = (previous?.[n.key]?.token === t.id ? previous[n.key].count : 0) + 1;
    const retry = count <= MAX_BROWSER_RECOVERIES;
    const summary = retry ? `浏览器处理作废（${fault.code}）：从本工位自动恢复 ${count}/${MAX_BROWSER_RECOVERIES}` : `浏览器恢复次数已满（${fault.code}）：已用完 ${MAX_BROWSER_RECOVERIES} 次自动恢复，保留检查点等待处理`;
    this.journal.append({ kind: "attempt.finished", attempt, ok: false, cancelled: true, summary, ms, queuedMs, usage: res.usage, metrics: res.metrics, error: "stale" });
    t.inflight.delete(n.key);
    const patch = { browserRecoveries: { ...previous, [n.key]: { token: t.id, count, code: fault.code, mode: fault.mode, at: Date.now(), nextAction: fault.nextAction } }, checkpointDone: [...t.done] };
    Object.assign(t.data, patch); this.journal.append({ kind: "token.data", token: t.id, patch });
    this.journal.append({ kind: "dispatch.note", node: n.key, tone: "warn", text: `${n.name} · ${t.title || t.item}：${summary}。${fault.nextAction}` });
    if (retry) {
      const note = t.notes.get(n.key);
      t.notes.set(n.key, { reason: `${note?.reason ? `${note.reason}\n` : ""}${summary}；复用此前工位的持久成果。`, byHuman: note?.byHuman ?? false, note: note?.note });
      this.enqueue(t, n.key, n.key, true);
      return;
    }
    const failure: Failure = { tag: "browser_capture", category: "system", code: "BROWSER_POOL_RECOVERY_EXHAUSTED", message: summary, url: t.url, retryable: true, owner: "system", nextAction: fault.nextAction, tried: [`${MAX_BROWSER_RECOVERIES} 次页面池自动恢复`, fault.code] };
    this.closeConsult(t, "manual", summary);
    t.finished = true; t.data.failure = failure;
    for (const [id, controller] of this.aborts) if (this.attemptTokens.get(id) === t.id) controller.abort();
    for (const q of this.queues.values()) { const at = q.indexOf(t.id); if (at >= 0) q.splice(at, 1); }
    this.journal.append({ kind: "token.data", token: t.id, patch: { failure } });
    this.journal.append({ kind: "token.finished", token: t.id, node: n.key, status: "parked", reason: summary });
    this.onRecovery?.(t, failure);
    this.journal.append({ kind: "alert.raised", alert: { id: `browser:${t.item}`, kind: "browser", level: "red", token: t.id, item: t.item, message: summary, nextAction: fault.nextAction } });
  }

  /* -------------------------------------------------------------- flow */

  private complete(t: TokenRun, key: string) {
    t.done.add(key);
    for (const e of this.outFlow.get(key) ?? []) {
      if (!t.closure.has(e.to)) continue;
      const live = !e.when || Boolean(this.conditions[e.when]?.(t.data));
      t.edgeLive.set(e.key, live);
    }
    for (const e of this.channelsOut.get(key) ?? []) this.emitChannel(t, e);
    for (const e of this.outFlow.get(key) ?? []) if (t.closure.has(e.to)) this.evaluate(t, e.to, key);
    this.checkStuck(t);
  }

  /** A node runs once every in-closure predecessor edge is resolved and at least one is live;
   *  if all are dead the node is dead too and the deadness propagates (Spec F2.3). */
  private evaluate(t: TokenRun, key: string, from: string) {
    if (t.finished || t.done.has(key) || t.dead.has(key) || t.inflight.has(key) || this.queues.get(key)?.includes(t.id)) return;
    const ins = (this.inFlow.get(key) ?? []).filter((e) => t.closure.has(e.from));
    if (ins.some((e) => !t.edgeLive.has(e.key))) return;
    if (!ins.some((e) => t.edgeLive.get(e.key))) {
      t.dead.add(key);
      const outs = (this.outFlow.get(key) ?? []).filter((e) => t.closure.has(e.to));
      for (const e of outs) t.edgeLive.set(e.key, false);
      for (const e of outs) this.evaluate(t, e.to, key);
      return;
    }
    this.enqueue(t, key, from);
  }

  private checkStuck(t: TokenRun) {
    if (t.finished || t.inflight.size) return;
    for (const q of this.queues.values()) if (q.includes(t.id)) return;
    const n = this.nodes.get([...t.done].pop() ?? t.entry)!;
    this.toManual(t, n, "没有可走的下一步（分支条件都不成立）");
  }

  private emitChannel(t: TokenRun, e: CompiledEdge) {
    const ch = this.f.channels.find((c) => `${c.from.line}/${c.from.station}` === e.from && `${c.to.line}/${c.to.station}` === e.to);
    if (!ch) return;
    if (ch.id === "curation.component-source.confirmed" && !(t.data.kind === "component-source" && t.data.kindAgreed)) return;
    this.journal.append({ kind: "channel.emitted", channel: ch.id, token: t.id, item: t.item });
    this.stockDelta(e.to, +1, `${t.item} 经信道 ${ch.label} 投递`);
  }

  toManual(t: TokenRun, at: CompiledNode, reason: string) {
    this.closeConsult(t, "manual", reason);
    t.data.manualReason = reason;
    this.journal.append({ kind: "token.data", token: t.id, patch: { manualReason: reason } });
    const manual = `${at.line}/manual`;
    for (const q of this.queues.values()) { const i = q.indexOf(t.id); if (i >= 0) q.splice(i, 1); }
    if (this.nodes.has(manual)) this.enqueue(t, manual, at.key);
    else { t.finished = true; this.journal.append({ kind: "token.finished", token: t.id, status: "manual", node: at.key, reason }); }
  }

  descendants(t: TokenRun, key: string): Set<string> {
    const seen = new Set([key]);
    const stack = [key];
    while (stack.length) for (const e of this.outFlow.get(stack.pop()!) ?? []) if (t.closure.has(e.to) && !seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
    return seen;
  }

  /** Review return or human correction: reset `to` and everything after it, then requeue `to`. */
  returnToken(t: TokenRun, from: string, to: string, reason: string, byHuman: boolean, note?: string): boolean {
    const edge = (this.returns.get(from) ?? []).find((e) => e.to === to);
    const max = byHuman ? 3 : edge?.maxRounds ?? 0;
    if (!byHuman && !edge) { this.toManual(t, this.nodes.get(from)!, `退回目标 ${to} 不在规格的退回边里：${reason}`); return false; }
    const round = (t.rounds[to] ?? 0) + 1;
    if (round > max) { this.toManual(t, this.nodes.get(from) ?? this.nodes.get(to)!, `退回 ${this.nodes.get(to)?.name} 已满 ${max} 轮：${reason}`); return false; }
    t.rounds[to] = round;
    t.epoch++;
    const reset = this.descendants(t, to);
    t.nodeEpochs??=new Map();
    for (const k of reset) {
      t.nodeEpochs.set(k,(t.nodeEpochs.get(k)??0)+1);
      for(const worker of this.workers.get(k)??[])if(worker.busy&&this.attemptTokens.get(worker.busy)===t.id)this.aborts.get(worker.busy)?.abort();
      t.done.delete(k); t.dead.delete(k); t.inflight.delete(k);
      const q = this.queues.get(k)!; const i = q.indexOf(t.id); if (i >= 0) q.splice(i, 1);
      for (const e of this.outFlow.get(k) ?? []) t.edgeLive.delete(e.key);
    }
    t.notes.set(to, { reason, note, byHuman });
    if (t.finished) {
      t.finished = false;
      const store=t.finishedStore??(t.data.published?`${this.nodes.get(to)!.line}/published`:undefined);
      if(store)this.stockDelta(store,-1,`${t.item} 被纠错撤回`);
      t.finishedStore=undefined;
    }
    this.journal.append({ kind: "token.returned", token: t.id, from, to, reason, round, byHuman, reset: [...reset] });
    this.enqueue(t, to, from, true);
    return true;
  }

  /* -------------------------------------------------------------- direct consultation (Spec §34) */

  /** A reviewer names fields and their owners; owners re-run in repair mode and reply straight back. */
  openConsult(t: TokenRun, reviewer: CompiledNode, fixes: Fix[], reason: string) {
    const existing = t.consult;
    // Parallel branches may request repairs together. Keep the second request pending;
    // it must not overwrite a chain whose owner is still running.
    if (existing && existing.reviewer !== reviewer.key && existing.chain[0] !== reviewer.key) {
      (t.pendingConsults ??= []).push({ reviewer: reviewer.key, fixes, reason });
      return;
    }
    const parent = existing?.reviewer === reviewer.key ? existing.parent : existing;
    const reviewers = new Set([reviewer.key]);
    for (let c = parent; c; c = c.parent) reviewers.add(c.reviewer);
    const runnable = (key: string) => { const n = this.nodes.get(key); return !!n && this.runnable(n) && t.closure.has(key) && !reviewers.has(key); };
    const usable = fixes.filter((f) => runnable(f.station) && (f.via ?? []).every(v => runnable(v) && v !== f.station) && new Set(f.via ?? []).size === (f.via ?? []).length);
    const unroutable = fixes.filter((f) => !usable.includes(f));
    if (!usable.length || unroutable.length) { this.closeConsult(t, "manual", "需要站长处理"); this.toManual(t, reviewer, `${reviewer.name}发现需要站长处理的问题：${(unroutable.length ? unroutable : fixes).map((f) => f.problem).join("；") || reason}`); return; }
    const queue: (Fix & { id: string })[] = [];
    for (const f of usable) {
      const key = `consult:${reviewer.key}>${f.station}`;
      const round = (t.rounds[key] ?? 0) + 1;
      if (round > MAX_CONSULT_ROUNDS) {
        const history = (t.consult?.replies ?? []).join("；");
        this.closeConsult(t, "manual", `${this.nodes.get(f.station)?.name} 与 ${reviewer.name} 来回 ${MAX_CONSULT_ROUNDS} 轮仍未解决`);
        this.toManual(t, reviewer, `审核往来已满 ${MAX_CONSULT_ROUNDS} 轮：${f.problem}${history ? `（往来：${history}）` : ""}`);
        return;
      }
      t.rounds[key] = round;
      const id = `k-${short()}`;
      this.journal.append({ kind: "consult.opened", consult: id, token: t.id, reviewer: reviewer.key, owner: f.station, fields: f.fields, problem: f.problem, round });
      queue.push({ ...f, id });
    }
    const previous = existing?.reviewer === reviewer.key ? existing : undefined;
    t.consult = { reviewer: reviewer.key, queue, chain: [], replies: [...(previous?.replies ?? [])], open: [...(previous?.open ?? []), ...queue.map((q) => q.id)], parent };
    this.nextConsult(t);
  }

  private nextConsult(t: TokenRun) {
    const c = t.consult!;
    const fix = c.queue.shift();
    if (!fix) {
      // Every owner has replied: the same reviewer looks again, with the replies in hand.
      const reviewer = c.reviewer;
      c.chain = [];
      this.redoAt(t, reviewer, `负责工位已按要求修改，请复查同一批字段。回复：${c.replies.join("；")}`);
      this.enqueue(t, reviewer, c.current?.station, true);
      return;
    }
    c.current = fix;
    c.chain = [fix.station, ...(fix.via ?? [])];
    this.redoAt(t, fix.station, `${this.nodes.get(c.reviewer)?.name} 要求修改字段 ${fix.fields.join("、")}：${fix.problem}`);
    this.enqueue(t, fix.station, c.reviewer, true);
  }

  /** Voids older attempts at a node and leaves a redo note for the next one. */
  private redoAt(t: TokenRun, key: string, reason: string) {
    t.nodeEpochs ??= new Map();
    t.nodeEpochs.set(key, (t.nodeEpochs.get(key) ?? 0) + 1);
    t.inflight.delete(key);
    const q = this.queues.get(key); const i = q?.indexOf(t.id) ?? -1; if (q && i >= 0) q.splice(i, 1);
    t.notes.set(key, { reason, byHuman: false });
  }

  private consultStep(t: TokenRun, n: CompiledNode, res: StationResult) {
    const c = t.consult!;
    c.chain.shift();
    if (c.chain.length) { this.redoAt(t, c.chain[0], `上游 ${n.name} 已按审核意见修改，请据此更新`); this.enqueue(t, c.chain[0], n.key, true); return; }
    const fix = c.current!;
    const reply = String((res.data as { reply?: string } | undefined)?.reply ?? res.summary);
    c.replies.push(`${this.nodes.get(fix.station)?.name}：${reply}`);
    this.journal.append({ kind: "consult.replied", consult: fix.id, token: t.id, owner: fix.station, reply, ok: res.ok });
    this.nextConsult(t);
  }

  private consultResult(t: TokenRun, n: CompiledNode, res: StationResult) {
    const c = t.consult!;
    const verdict = res.verdict;
    if (verdict) this.journal.append({ kind: "review.verdict", token: t.id, node: n.key, verdict: verdict.verdict === "fix" ? "return" : verdict.verdict, returnTo: verdict.returnTo ?? verdict.fixes?.[0]?.station, reason: verdict.reason });
    if (verdict?.verdict === "fix") { this.openConsult(t, n, verdict.fixes ?? [], verdict.reason); return; }
    if (verdict?.verdict === "escalate") { this.toManual(t, n, verdict.reason); return; }
    if (verdict?.verdict === "return") {
      const to = verdict.returnTo;
      const edge = (this.returns.get(n.key) ?? []).find(e => e.to === to);
      if (!to || !edge) { this.toManual(t, n, `退回目标 ${to ?? "未指定"} 不在规格的退回边里：${verdict.reason}`); return; }
      const round = (t.rounds[to] ?? 0) + 1;
      if (round > (edge.maxRounds ?? 0)) { this.toManual(t, n, `退回 ${this.nodes.get(to)?.name} 已满 ${edge.maxRounds ?? 0} 轮：${verdict.reason}`); return; }
      // Re-run only the route leading back to this reviewer. A normal pipeline return
      // would reset the original reviewer and lose its outstanding consultation.
      const paths = [[to]], seen = new Set<string>();
      let route: string[] | undefined;
      while (paths.length) {
        const p = paths.shift()!, key = p.at(-1)!;
        if (key === n.key) { route = p; break; }
        if (seen.has(key)) continue;
        seen.add(key);
        for (const e of this.outFlow.get(key) ?? []) if (t.closure.has(e.to) && (!e.when || this.conditions[e.when]?.(t.data))) paths.push([...p, e.to]);
      }
      if (!route) { this.toManual(t, n, `退回 ${to} 后没有回到 ${n.key} 的有效审查路径：${verdict.reason}`); return; }
      t.rounds[to] = round;
      this.openConsult(t, n, [{ station: to, fields: c.current?.fields ?? [], problem: verdict.reason, via: route.slice(1, -1) }], verdict.reason);
      return;
    }
    if (c.reviewer !== n.key) { this.consultStep(t, n, res); return; }
    this.closeConsult(t, "resolved", verdict?.reason ?? "复查通过");
    if (t.consult) { this.consultStep(t, n, res); return; }
    const pending = t.pendingConsults?.shift();
    if (pending) this.openConsult(t, this.nodes.get(pending.reviewer)!, pending.fixes, pending.reason);
    this.complete(t, n.key);
  }

  private closeConsult(t: TokenRun, outcome: "resolved" | "manual", reason: string) {
    do {
      const c = t.consult;
      for (const id of c?.open ?? []) this.journal.append({ kind: "consult.closed", consult: id, token: t.id, outcome, reason });
      t.consult = c?.parent;
    } while (outcome === "manual" && t.consult);
    if (outcome === "manual") t.pendingConsults = [];
  }

  correct(target: { token: string; node: string; evidence?: string }, reason: string, note?: string) {
    const t = this.tokens.get(target.token);
    if (!t) return { ok: false, message: "找不到这件货" };
    const n = this.nodes.get(target.node);
    if (!n || !this.runnable(n) || !t.closure.has(target.node)) return { ok: false, message: "纠错目标必须是这件货经过的可执行工位" };
    const correction = `c-${short()}`;
    if (!this.running) this.start("纠错重做");
    this.journal.append({ kind: "correction.created", correction, evidence: target.evidence, token: t.id, node: target.node, reason, note });
    const ok = this.returnToken(t, "human", target.node, note ? `${reason}：${note}` : reason, true, note);
    return { ok, message: ok ? `已退回 ${this.nodes.get(target.node)?.name}` : "已超过纠错轮数，转待人工" };
  }

  /* -------------------------------------------------------------- balancing */

  stationNumbers(key: string) {
    const n = this.nodes.get(key)!;
    const now = Date.now();
    const window = Math.min(300_000, Math.max(30_000, now - this.runStartedAt));
    const arr = (this.arrivals.get(key) ?? []).filter((t) => now - t <= window);
    const lambda = arr.length / (window / 1000);
    const ds = this.durations.get(key) ?? [];
    const s = (ds.length >= 3 ? median(ds.slice(-50)) : n.estimateSeconds * 1000) / 1000;
    const pool = this.workers.get(key)!;
    const need = Math.min(n.workers.max, Math.max(n.workers.min, Math.ceil((lambda * s) / RHO) || n.workers.min));
    return { lambda, s, need, workers: pool.length, queue: this.queues.get(key)!.length, takt: s / Math.max(1, pool.length), measured: ds.length >= 3 };
  }

  lineTakt(line: string) {
    let worst = 0, at = "";
    for (const n of this.f.nodes) if (n.line === line && this.runnable(n)) {
      const x = this.stationNumbers(n.key);
      if (x.measured && x.takt > worst) { worst = x.takt; at = n.key; }
    }
    return { takt: worst, at };
  }

  balance() {
    const now = Date.now();
    if (now - this.lastSample > 15_000) {
      this.lastSample = now;
      this.journal.append({ kind: "resource.sample", ...this.broker.sample(), waiting: this.waiting });
    }
    if (!this.running || this.paused) return;
    // Retry resource waits when memory recovers even if no worker releases a lease.
    this.schedule();
    for (const n of this.f.nodes) {
      if (!this.runnable(n) || n.workers.policy === "fixed" || this.locked.has(n.key)) continue;
      const x = this.stationNumbers(n.key);
      const pool = this.workers.get(n.key)!;
      const since = this.lastAdjust.get(n.key) ?? 0;
      if (x.queue >= 2 * Math.max(1, pool.length)) { if (!this.backlogSince.has(n.key)) this.backlogSince.set(n.key, now); }
      else this.backlogSince.delete(n.key);
      const backlog = this.backlogSince.get(n.key);
      const free = n.resource === "none" || (this.broker.used[n.resource] ?? 0) < (this.broker.limits[n.resource] ?? 1) - (n.resource === "model" ? 1 : 0);
      const busyEnough = n.resource !== "browser" || pool.filter((w) => w.busy).length >= pool.length;
      if (backlog && now - backlog >= FORK_BACKLOG_MS && pool.length < n.workers.max && free && busyEnough && now - since >= DEBOUNCE_MS) {
        const lt = this.lineTakt(n.line);
        const res = n.resource === "none" ? "" : `（${n.resource} ${this.broker.used[n.resource]}/${this.broker.limits[n.resource]}）`;
        const w = this.spawn(n, `队列 ${x.queue} ≥ 2×工人数 ${pool.length} 持续 ${Math.round((now - backlog) / 1000)}s；中位耗时 ${x.s.toFixed(1)}s、需要 ${x.need} 人`, true);
        this.lastAdjust.set(n.key, now);
        this.backlogSince.delete(n.key);
        this.journal.append({
          kind: "dispatch.note", node: n.key, tone: "fork",
          text: `[${n.name}] 队列 ${x.queue}、节拍 ${x.takt.toFixed(1)}s${lt.at && lt.at !== n.key ? `（线节拍 ${lt.takt.toFixed(1)}s）` : ""} → fork ${w.label}${res}`,
        });
        continue;
      }
      if (pool.length > Math.max(1, n.workers.min) && x.queue === 0 && now - since >= DEBOUNCE_MS) {
        const idle = pool.filter((w) => !w.busy && now - w.idleSince >= RETIRE_IDLE_MS);
        const victim = idle[idle.length - 1];
        if (victim) {
          pool.splice(pool.indexOf(victim), 1);
          this.lastAdjust.set(n.key, now);
          this.journal.append({ kind: "worker.retired", node: n.key, worker: victim.id, reason: `空闲 ${Math.round((now - victim.idleSince) / 1000)}s，队列为空` });
          this.journal.append({ kind: "dispatch.note", node: n.key, tone: "info", text: `[${n.name}] ${victim.label} 空闲 ${Math.round((now - victim.idleSince) / 1000)}s → 撤下（剩 ${pool.length} 人）` });
        }
      }
    }
  }

  fork(key: string, reason: string) {
    const n = this.nodes.get(key);
    if (!n || !this.runnable(n)) return null;
    if (this.workers.get(key)!.length >= n.workers.max) return null;
    const w = this.spawn(n, reason, true);
    this.lastAdjust.set(key, Date.now());
    this.journal.append({ kind: "dispatch.note", node: key, tone: "fork", text: `[${n.name}] ${reason} → fork ${w.label}` });
    this.schedule();
    return w;
  }

  retire(key: string, reason: string) {
    const pool = this.workers.get(key);
    const n = this.nodes.get(key);
    if (!pool || !n || pool.length <= Math.max(1, n.workers.min)) return null;
    const victim = [...pool].reverse().find((w) => !w.busy);
    if (!victim) return null;
    pool.splice(pool.indexOf(victim), 1);
    this.journal.append({ kind: "worker.retired", node: key, worker: victim.id, reason });
    this.journal.append({ kind: "dispatch.note", node: key, tone: "info", text: `[${n.name}] ${reason} → 撤下 ${victim.label}` });
    return victim;
  }
}
