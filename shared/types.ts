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

export interface ChannelSpec { id: string; from: { line: string; station: string }; to: { line: string; station: string }; label: string }

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
  usageReported?: boolean;
  modelTimeReported?: boolean;
  usageComplete?: boolean;
  cacheUsageComplete?: boolean;
  execution?: { adapter: string; model: string };
  activity?: AttemptActivity;
  tokens?: { system: number; context: number; caseFile: number; input: number; images: number; toolDefs: number; toolResults: number; output: number; actualInput: number; actualOutput: number; cacheRead: number; cacheWrite: number };
  time?: { firstTokenMs: number; outputMs: number; toolMs: number; programMs: number; modelCalls: number; toolCalls: number };
}

export interface Alert { id: string; level: "red"; kind: "tls" | "auth" | "model" | "preflight" | "browser"; message: string; nextAction?: string; token?: string; item?: string; node?: string; url?: string; tab?: string }
export interface PreflightCheck { id: string; label: string; ok: boolean; detail: string; fix?: string; ms: number }
export interface CaseNote { station: string; section: string; text: string; by: string }

export type JournalEvent =
  | import("./lessons.ts").LessonEvent
  | { kind: "factory.loaded"; digest: string; specVersion: string }
  | { kind: "run.started"; runId: string; title: string }
  | { kind: "run.paused"; runId: string }
  | { kind: "run.resumed"; runId: string }
  | { kind: "run.ended"; runId: string; manual: boolean }
  | { kind: "stock.set"; node: string; stock: number; note?: string }
  | { kind: "token.created"; token: string; line: string; item: string; url: string; title?: string; source: string; category?: string }
  | { kind: "token.queued"; token: string; node: string; from?: string; returned?: boolean }
  | { kind: "attempt.started"; attempt: string; token: string; node: string; worker: string; input: string }
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
  | { kind: "correction.created"; correction: string; evidence?: string; token: string; node: string; reason: string; note?: string }
  | { kind: "channel.emitted"; channel: string; token: string; item: string }
  | { kind: "dispatch.note"; text: string; node?: string; tone?: "info" | "fork" | "warn" }
  | { kind: "chat.user"; id: string; text: string; attachments: Attachment[] }
  | { kind: "chat.assistant"; id: string; text: string; tools: { name: string; summary: string }[]; usage?: Usage }
  | { kind: "chat.message"; id: string; turn: string; message: import("./conversation.ts").PiMessage }
  | { kind: "spec.patched"; patch: string; summary: string; status: "proposed" | "accepted" | "rejected" }
  | { kind: "resource.sample"; used: Record<string, number>; limits: Record<string, number>; freeMemMB: number; waiting?: Record<string, string> }
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
