// Shared vocabulary of the factory: spec shapes (what the Spec layer compiles to),
// journal events (the only source of truth), and the projected state both the
// server and the dashboard derive from those events. Spec.md §4, §9, §11.

/* ------------------------------------------------------------------ spec */

/** Role decides a node's hue on the canvas (Spec §10.3). Packs may add their own. */
export type Role =
  | "source" | "social" | "candidate" | "sort" | "judge" | "capture" | "process"
  | "write" | "verify" | "review" | "arbiter" | "publish" | "channel" | "store";

/** How a station is executed. `source` and `store` hold stock and never run workers. */
export type StationKind = "agent" | "program" | "review" | "gate" | "source" | "store";

/** Global resource classes the broker hands out (Spec §6.3). */
export type ResourceClass = "browser" | "model" | "cpu" | "http" | "none";

export interface WorkerPolicy { min: number; max: number; initial: number; policy: "auto" | "fixed" }

export interface BotLook { shape: BotShape; hue: number; eyes: "dot" | "round" | "wide" | "sleepy"; seed: number }
export type BotShape = "circle" | "squircle" | "drop" | "capsule" | "star" | "hex" | "bean";

/** Policies can narrow transient recovery; they cannot authorize unsafe retries. */
export type RecoveryFailureTag = 'network_timeout' | 'network_connection' | 'network_dns' |
  'http_server' | 'http_rate_limit' | 'http_forbidden' | 'browser_capture' |
  'tool_error' | 'model_transport';

export interface StationRecoveryPolicy {
  tags: RecoveryFailureTag[];
  /** Automatic attempts after the original failure, excluding explicit user retries. */
  maxRetries: number;
  backoff: {initialMs: number; factor: number; maxMs: number; jitter?: number};
  /** Wall-clock recovery window from the first failure, including pauses and queues. */
  deadlineMs?: number;
  exhausted: 'parked' | 'manual';
}

export interface StationSpec {
  id: string;
  name: string;
  /** Circled number shown on the node (①…⑰); optional. */
  num?: string;
  role: Role;
  kind: StationKind;
  /** Contract names; the compiler checks both ends of every flow edge agree. */
  input: string;
  output: string;
  rules: string[];
  accept: string[];
  resource: ResourceClass;
  estimateSeconds: number;
  workers: WorkerPolicy;
  recovery?: StationRecoveryPolicy;
  /** Pseudo-code that states I/O boundaries and side effects (never executed). */
  pseudo?: string;
  /** Station prompt file (agent stations), relative to the pack. */
  prompt?: string;
  /** Tool id the runtime calls (program stations) or exposes (agent stations). */
  tool?: string;
  /** Dormant nodes cost nothing and are drawn faded (Spec §6.4). */
  dormant?: boolean;
  /** Return edge for reviewers: where a "return" verdict sends the token and how often. */
  returnTo?: { station: string; maxRounds: number }[];
  /** Short line under the name when nothing is running. */
  blurb?: string;
  bot?: Partial<BotLook>;
}

export interface EdgeSpec {
  from: string;
  to: string;
  /** Named predicate over the token's accumulated data; absent = always. */
  when?: string;
  label?: string;
  kind?: "flow" | "return" | "channel";
}

export interface LineSpec {
  id: string;
  name: string;
  /** 1 = sources, 2 = candidates, 3 = lines (Spec §6.0). */
  layer: 1 | 2 | 3;
  priority: "high" | "mid" | "low";
  blurb: string;
  stations: StationSpec[];
  edges: EdgeSpec[];
  /** Whether the runtime has tools for this line yet; lines without are drawn but never run. */
  wired: boolean;
}

export type ChannelInput = Record<string, string | {path?: string; value?: unknown}>;
export interface ChannelSpec { id: string; from: { line: string; station: string }; to: { line: string; station: string }; label: string; input?: ChannelInput }

export interface PackSpec {
  id: string;
  name: string;
  version: string;
  blurb: string;
  lines: LineSpec[];
  channels: ChannelSpec[];
  resources: Record<Exclude<ResourceClass, "none">, number>;
}

/** What the compiler hands to the runtime and the canvas (Spec §9.3). */
export interface CompiledFactory {
  specVersion: string;
  packs: { id: string; name: string; version: string; blurb: string }[];
  lines: LineSpec[];
  nodes: CompiledNode[];
  edges: CompiledEdge[];
  channels: ChannelSpec[];
  resources: PackSpec["resources"];
  issues: { at: string; message: string }[];
  /** Hash of the compiled runtime graph; layout never changes it (acceptance A11). */
  digest: string;
  /** Default-layout hints from the packs; visual only, outside the digest. */
  ui: { order: string[]; collapsed: string[]; hints: Record<string, { mode: "stack" | "layered"; wrap?: number; side?: string[]; phases?: { name: string; stations: string[] }[]; grid?: Record<string, [number, number]>; focus?: string[] }> };
}

export interface CompiledNode extends StationSpec {
  /** Globally unique: `${line}/${station}`. */
  key: string;
  line: string;
  layer: 1 | 2 | 3;
  bot: BotLook;
}

export interface CompiledEdge {
  key: string;
  from: string;
  to: string;
  kind: "flow" | "return" | "channel";
  when?: string;
  label?: string;
  maxRounds?: number;
  input?: ChannelInput;
}

/* ------------------------------------------------------------------ journal */

export interface Usage { input: number; output: number; cost: number; cacheRead?: number; cacheWrite?: number }

export interface EvidenceRef {
  id: string;
  kind: "image" | "video" | "verdict" | "text";
  /** Served path, e.g. /evidence/ab/abcd….webp */
  src?: string;
  /** Smaller card image (720 wide) when the evidence is visual. */
  card?: string;
  poster?: string;
  label: string;
  /** Short verdict text for non-visual evidence ("组件源 ✓"). */
  verdict?: string;
  tone?: "ok" | "warn" | "bad";
  station: string;
  token: string;
  attempt: string;
  at: number;
  meta?: Record<string, unknown>;
}

export type StepDetail = { tool: string; text: string; ok?: boolean; evidence?: string[] };

/** Observed client-side boundaries, never reconstructed from duration proportions. */
export interface ActivitySpan {
  id: string;
  kind: "model_request" | "first_token" | "model_output" | "tool";
  source: "model-stream" | "tool-executor";
  startedAt: number;
  endedAt?: number;
  status: "running" | "completed" | "failed" | "cancelled";
  /** The enclosing model request; its wait/output children must not be double-counted. */
  requestId?: string;
  model?: string;
  toolName?: string;
  operation?: string;
}

export interface AttemptActivity {
  version: 1;
  /** Aggregate durations from a closed launcher do not establish real intervals. */
  modelTiming: "observed" | "unavailable";
  spans: ActivitySpan[];
}

/** Token and time breakdown of one attempt (Spec §37). Estimated parts are char-based. */
export interface AttemptMetrics {
  /** Dependency captured for this execution; separate from the reported actual model. */
  dependency?: ModelDependency;
  modelResponses?: ModelResponse[];
  /** Actual token receipts, including clients that disclose no monetary cost. */
  tokenUsage?: ModelTokenUsage;
  /** Dedicated typed-inference receipts; added exactly once to chat-model totals. */
  decisionUsage?: {input: number; output: number; requests: number; reported: number};
  costReported?: boolean;
  costComplete?: boolean;
  usageReported?: boolean;
  modelTimeReported?: boolean;
  usageComplete?: boolean;
  cacheUsageComplete?: boolean;
  execution?: { adapter: string; model: string; provider?: string };
  activity?: AttemptActivity;
  tokens?: { system: number; context: number; caseFile: number; input: number; images: number; toolDefs: number; toolResults: number; output: number; actualInput: number; actualOutput: number; cacheRead: number; cacheWrite: number };
  time?: { firstTokenMs: number; outputMs: number; toolMs: number; programMs: number; modelCalls: number; toolCalls: number };
}

export interface Alert { id: string; level: "red"; kind: "tls" | "auth" | "model" | "preflight" | "browser"; message: string; nextAction?: string; token?: string; item?: string; node?: string; url?: string; tab?: string; dependency?: ModelDependency }
export interface ModelProbeResult { dependency: ModelDependency; actuallyProbed: boolean; ok: boolean }
export interface PreflightCheck { id: string; label: string; ok: boolean; detail: string; fix?: string; ms: number; modelProbes?: ModelProbeResult[] }
export interface CaseNote { station: string; section: string; text: string; by: string }

export interface ChannelDelivery {
  id: string; channel: string; sourceToken: string; target: string; item: string;
  url: string; title?: string; data: Record<string, unknown>;
  status: 'pending' | 'delivered' | 'acknowledged' | 'blocked' | 'failed';
  targetToken?: string; attempts: number; reason?: string;
  emissions?: number[];
  inventory?: { node: string; held: boolean };
}
export interface SourceSpec {
  id: string; name: string; url: string; platform: string; format: 'rss' | 'json' | 'browser';
  target: string; enabled: boolean; intervalMs: number;
  perMinute?: number; perDay?: number; limit?: number; externalLinksOnly?: boolean;
  input?: Record<string, string>; constants?: Record<string, unknown>;
}
export interface SourceCandidate {
  id: string; source: string; platform: string; sourceUrl: string; url: string; title: string;
  author?: string; publishedAt?: string; excerpt?: string; images?: string[];
  discoveredAt: number; status: 'pending' | 'delivered' | 'acknowledged' | 'rejected' | 'blocked' | 'failed';
  targetToken?: string; reason?: string;
  origins?: Array<Pick<SourceCandidate, 'source' | 'sourceUrl' | 'platform' | 'author' | 'publishedAt' | 'excerpt' | 'images'>>;
}

/** Durable intent and receipt for an external effect. Unknown outcomes use the
 * same `uncertain` phase as dispatcher tool operations. Inputs and credentials
 * are represented only by hashes, never copied into the audit event. */
export interface OperationReceipt {
  key: string;
  scope: string;
  token: string;
  node: string;
  revision: string;
  name: string;
  inputHash: string;
  phase: import('./conversation.ts').DispatcherCheckpoint['operations'][number]['phase'];
  result?: unknown;
  reason?: 'interrupted' | 'execution_failed' | 'receipt_failed';
}

/** Host-selected executor settings. Credentials remain in the vendor profile. */
export type StationAgentBinding =
  | {adapter: 'pi'; provider?: string; model?: string}
  | {adapter: 'launcher'; command: string[]; model: string; requestTimeoutMs?: number}
  | {adapter: 'claude-code' | 'opencode' | 'codex'; command?: string[]; provider?: string; model?: string; requestTimeoutMs?: number};

export interface ProjectAgentDefaults {
  station: StationAgentBinding;
  dispatcher: StationAgentBinding;
}

/** Public fault-domain identity. Endpoints, command arguments and credentials are private. */
export interface ModelDependency {
  readonly key: string;
  readonly adapter: 'pi' | 'claude-code' | 'launcher' | 'opencode' | 'codex';
  readonly provider?: string;
  readonly model: string;
}

export interface ModelResponse {
  dependency: ModelDependency;
  model: string;
  provider?: string;
  modelCalls: number;
  usageReported: boolean;
  usage?: Usage;
  tokenUsage?: ModelTokenUsage;
  costReported?: boolean;
  costComplete?: boolean;
}

export interface ModelTokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

export interface ModelCircuit {
  dependency: ModelDependency;
  state: 'open' | 'trial' | 'blocked';
  failures: number;
  nextAt: number;
  runId: string;
  /** Derived from the owning run.ended event during journal replay. */
  runEndedAt?: number;
  trialToken?: string;
  station?: string;
  reason: string;
}

export type JournalEvent =
  | import("./lessons.ts").LessonEvent
  | { kind: "factory.loaded"; digest: string; specVersion: string }
  | { kind: 'agent.binding'; node: string; binding: StationAgentBinding | null }
  | { kind: 'agent.defaults'; defaults: ProjectAgentDefaults }
  | { kind: 'model.circuit'; key: string; circuit: ModelCircuit | null }
  | { kind: "run.started"; runId: string; title: string }
  | { kind: "run.paused"; runId: string }
  | { kind: "run.resumed"; runId: string }
  | { kind: "run.ended"; runId: string; manual: boolean }
  | { kind: "scope.paused"; scope: "line" | "station"; key: string; paused: boolean; reason: string }
  | { kind: "measurement.proposed"; proposal: { id: string; runId: string; sampleItems: number; at: number; stations: Array<{ node: string; samples: number; serviceSeconds: number; lambda: number; need: number; allocated: number; resource: string; measured: boolean }> } }
  | { kind: "measurement.decided"; id: string; accepted: boolean }
  | { kind: "batch.configured"; batch: import("./batch.ts").BatchGoal }
  | { kind: "stock.set"; node: string; stock: number; note?: string }
  | { kind: "token.created"; token: string; line: string; item: string; url: string; title?: string; source: string; category?: string }
  | { kind: "token.queued"; token: string; node: string; from?: string; returned?: boolean }
  | { kind: "attempt.started"; attempt: string; token: string; node: string; worker: string; input: string; dependency?: ModelDependency }
  | { kind: "attempt.progress"; attempt: string; text: string; step?: StepDetail }
  | { kind: "attempt.activity"; attempt: string; activity: ActivitySpan }
  | { kind: "attempt.finished"; attempt: string; ok: boolean; summary: string; ms: number; queuedMs: number; usage?: Usage; error?: string; output?: Record<string, unknown>; cancelled?:boolean; metrics?: AttemptMetrics }
  | { kind: "candidate.disposition"; candidate: Omit<import("./failures.ts").CandidateRecovery,"at"|"attempts"> }
  | { kind: "evidence.added"; evidence: EvidenceRef }
  | { kind: "review.verdict"; token: string; node: string; verdict: "pass" | "return" | "escalate"; returnTo?: string; reason: string }
  | { kind: "token.returned"; token: string; from: string; to: string; reason: string; round: number; byHuman?: boolean; reset?: string[] }
  | { kind: "token.finished"; token: string; status: TokenStatus; node: string; reason: string }
  | { kind: "token.data"; token: string; patch: Record<string, unknown> }
  | { kind: "worker.spawned"; node: string; worker: string; label: string; reason: string }
  | { kind: "worker.retired"; node: string; worker: string; reason: string }
  | { kind: "worker.forked"; node: string; worker: string; label: string; reason: string }
  | { kind: "worker.locked"; node: string; locked: boolean; reason: string }
  | { kind: "control.executed"; tool: string; actor: "agent" | "dispatcher" | "user"; summary: string }
  | { kind: "correction.created"; correction: string; evidence?: string; token: string; node: string; reason: string; note?: string; snapshot?: Record<string, unknown> }
  | { kind: "correction.reverted"; correction: string; token: string; snapshot: Record<string, unknown> }
  | { kind: "channel.emitted"; channel: string; token: string; item: string; inventory?: 'consumer' }
  | { kind: 'channel.delivery'; delivery: ChannelDelivery }
  | { kind: 'source.configured'; source: SourceSpec }
  | { kind: 'source.requested'; source: string; platform: string; requestedAt: number; nextRequestAt?: number }
  | { kind: 'source.polled'; source: string; nextAt: number; count: number; duplicates: number; invalid?: number; attention?: string; failure?: import('./failures.ts').Failure }
  | { kind: 'source.candidate'; candidate: SourceCandidate }
  | { kind: 'source.reputation'; platform: string; author: string; accepted: number; rejected: number }
  | { kind: 'operation.recorded'; operation: OperationReceipt }
  | { kind: "dispatch.note"; text: string; node?: string; tone?: "info" | "fork" | "warn" }
  | { kind: "chat.user"; id: string; text: string; attachments: Attachment[] }
  | { kind: "chat.assistant"; id: string; text: string; tools: { name: string; summary: string }[]; usage?: Usage }
  | { kind: "chat.message"; id: string; turn: string; message: import("./conversation.ts").PiMessage }
  | { kind: "chat.checkpoint"; checkpoint: import("./conversation.ts").DispatcherCheckpoint }
  | { kind: "spec.patched"; patch: string; summary: string; status: "proposed" | "accepted" | "rejected" }
  | { kind: "resource.sample"; used: Record<string, number>; limits: Record<string, number>; freeMemMB: number; waiting?: Record<string, string>; modelRequests?: {active: number; queued: number; limit: number} }
  | { kind: "report.ready"; runId: string }
  | { kind: "alert.raised"; alert: Alert }
  | { kind: "alert.cleared"; id: string; reason: string }
  | { kind: "preflight.checked"; ok: boolean; checks: PreflightCheck[] }
  | { kind: "case.noted"; caseId: string; token: string; note: CaseNote }
  | { kind: "context.noted"; node: string; note: { kind: "note" | "instruction" | "lesson" | "issue"; text: string; by: string } }
  | { kind: "consult.opened"; consult: string; token: string; reviewer: string; owner: string; fields: string[]; problem: string; round: number }
  | { kind: "consult.replied"; consult: string; token: string; owner: string; reply: string; ok: boolean }
  | { kind: "consult.closed"; consult: string; token: string; outcome: "resolved" | "manual"; reason: string };

export type Stamped<E extends JournalEvent = JournalEvent> = E & { seq: number; at: number; run: string };

export type TokenStatus = "active" | "published" | "merged" | "rejected" | "manual" | "failed" | "parked";

/** Something the user attached to a chat message (Spec §10.2). */
export interface Attachment {
  type: "evidence" | "node" | "token" | "events";
  id: string;
  label: string;
  thumb?: string;
  tone?: "ok" | "warn" | "bad" | "idle";
}
