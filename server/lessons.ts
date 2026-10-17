// Lessons are a projection of the same journal as runs and cases. A draft is never
// a production instruction: an isolated, pre-bound trial must exercise it first,
// and only an explicit owner decision may append it to the stable role handbook.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CompiledFactory, Stamped } from "../shared/types.ts";
import type { FactoryState, TokenState } from "../shared/project.ts";
import {apply, initialState, serializeSnapshot, deserializeSnapshot} from '../shared/project.ts';
import type {Snapshottable} from './snapshots.ts';
import { classifyFailure, failureLabels } from "../shared/failures.ts";
import type { LessonArtifact, LessonDraft, LessonEvent, LessonObservation, LessonSample, LessonTrial, LessonValidation, LessonView } from "../shared/lessons.ts";
import type { CaseScope, Docs } from "./docs.ts";
import { Journal } from "./journal.ts";
import { EvidenceStore } from "./evidence.ts";
import { ControlError } from "./errors.ts";
import { projectPaths } from "./workspace.ts";

type Actor = "agent" | "dispatcher" | "user";
/** The dispatcher acts with the owner's authority; station agents only draft and validate. */
const isOwner = (actor: Actor) => actor === "user" || actor === "dispatcher";
type Host = { journal: Journal; compiled: CompiledFactory; state: FactoryState; docs?: Docs; store?: EvidenceStore };
type LessonStamp = LessonEvent & { seq: number; at: number; run: string };
const roleRoot = fileURLToPath(new URL("../packs/vislexicon/roles/", import.meta.url));
const hash = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const unique = <T>(values: T[]) => [...new Set(values)];
const clean = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
const blockStart = "<!-- H2:LESSONS:START -->";
const blockEnd = "<!-- H2:LESSONS:END -->";
const isLesson = (e: Stamped): e is Stamped & LessonStamp => e.kind.startsWith("lesson.");
function fail(message: string, details?: unknown): never { throw new ControlError(409, "lesson_validation_required", message, details); }

function sampleURL(value: string) {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return fail("验证样本需要完整的 HTTP(S) 入口，先修正无效网址再建立批次"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) fail("验证样本只能使用不含凭据的 HTTP(S) 入口");
  return parsed.href;
}

function inferredFailure(message: string) {
  const tag = classifyFailure(message).tag;
  return tag === "tool_error" ? "review_feedback" : tag;
}

function frameworkOf(token: TokenState | undefined) {
  const d = token?.data ?? {}, dossier = d.dossier as { framework?: unknown } | undefined;
  const values = dossier?.framework ?? d.framework;
  return frameworkNames(values);
}

function frameworkNames(values: unknown): string[] {
  const names = unique((Array.isArray(values) ? values : typeof values === "string" ? [values] : [])
    .filter((x): x is string => typeof x === "string" && Boolean(x.trim())).map((x) => x.trim().toLowerCase())).sort();
  return names.length ? names : ["unknown"];
}

interface ObservationLookup {
  token(id: string): {item: string; url: string; station?: string; framework: string[]} | undefined;
  consult(id: string): {owner: string; problem: string} | undefined;
}

function lessonObservation(e: Stamped, lookup: ObservationLookup,
    consults: Map<string, LessonObservation>): LessonObservation | undefined {
  let token: string, station: string, message: string, failureType: string, nextAction: string | undefined;
  if (e.kind === 'candidate.disposition') {
    if (!['retry', 'removed'].includes(e.candidate.disposition) || !e.candidate.failure) return;
    token = e.candidate.token;
    station = lookup.token(token)?.station ?? 'dispatcher';
    message = e.candidate.failure.message;
    failureType = e.candidate.failure.tag;
    nextAction = e.candidate.failure.nextAction;
  } else if (e.kind === 'token.returned') {
    token = e.token;
    station = e.to;
    message = e.reason;
    failureType = inferredFailure(message);
  } else if (e.kind === 'consult.opened') {
    token = e.token;
    station = e.owner;
    message = e.problem;
    failureType = inferredFailure(message);
  } else if (e.kind === 'consult.replied' || e.kind === 'consult.closed') {
    const origin = consults.get(e.consult);
    if (origin) return {...origin, seq: e.seq, at: e.at, kind: e.kind,
      message: e.kind === 'consult.replied' ? e.reply : `${e.outcome}: ${e.reason}`};
    const prior = lookup.consult(e.consult);
    token = e.token;
    station = prior?.owner ?? (e.kind === 'consult.replied' ? e.owner : 'dispatcher');
    message = e.kind === 'consult.replied' ? e.reply : `${e.outcome}: ${e.reason}`;
    failureType = inferredFailure(prior?.problem ?? message);
  } else return;
  const item = lookup.token(token);
  const observation: LessonObservation = {seq: e.seq, at: e.at, kind: e.kind, token, station, message,
    failureType, framework: item?.framework ?? ['unknown'],
    item: item?.item ?? (e.kind === 'candidate.disposition' ? e.candidate.item : token),
    url: item?.url ?? (e.kind === 'candidate.disposition' ? e.candidate.url : ''),
    ...(nextAction ? {nextAction} : {})};
  if (e.kind === 'consult.opened') consults.set(e.consult, observation);
  return observation;
}

function observationGroups(observations: readonly LessonObservation[]): LessonObservation[][] {
  const groups = new Map<string, LessonObservation[]>();
  for (const observation of observations) {
    const key = JSON.stringify([observation.station, observation.failureType, observation.framework]);
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Pure replay: a later retry or framework observation cannot rewrite an old run. */
export function groupLessonObservations(events: Stamped[], runId: string, compiled?: CompiledFactory) {
  const s = initialState(compiled);
  const observations: LessonObservation[] = [];
  const consults = new Map<string, LessonObservation>();
  const lookup: ObservationLookup = {
    token: id => {
      const token = s.tokens[id];
      if (!token) return;
      return {item: token.item, url: token.url, framework: frameworkOf(token),
        station: token.finishedAtNode ?? (token.attempts.at(-1) ? s.attempts[token.attempts.at(-1)!]?.node : undefined)};
    },
    consult: id => s.consults[id],
  };
  for (const e of events) {
    if (e.kind === "run.started" && e.runId !== runId && observations.length && s.run.id === runId) break;
    apply(s, e);
    if (e.run !== runId) continue;
    const observation = lessonObservation(e, lookup, consults);
    if (observation) observations.push(observation);
  }
  return observationGroups(observations);
}

function draftDigest(d: Omit<LessonDraft, "digest"> | LessonDraft) {
  const { digest: _digest, ...body } = d as LessonDraft;
  return hash(JSON.stringify(body));
}

/** Replay-only views; no role mutations or validation decisions are made here. */
export function projectLessons(events: Stamped[]) {
  const lessons = new Map<string, LessonView>();
  for (const e of events.filter(isLesson)) {
    if (e.kind === "lesson.proposed" || e.kind === "lesson.revised") {
      const prior = lessons.get(e.draft.id);
      lessons.set(e.draft.id, { ...e.draft, status: "pending", proposedSeq: prior?.proposedSeq ?? e.seq, updatedAt: e.at });
    } else if (e.kind === "lesson.validated") {
      const l = lessons.get(e.validation.lessonId);
      if (l && l.digest === e.validation.digest && ["pending", "validated"].includes(l.status)) Object.assign(l, { validation: e.validation, status: "validated", updatedAt: e.at });
    } else if (e.kind === "lesson.approved" || e.kind === "lesson.rejected") {
      const l = lessons.get(e.lessonId);
      if (l && l.digest === e.digest) Object.assign(l, { status: e.kind === "lesson.approved" ? "approved" : "rejected", decision: e, updatedAt: e.at });
    } else if (e.kind === "lesson.applied") {
      const l = lessons.get(e.lessonId);
      if (l && l.digest === e.digest && l.decision?.kind === "lesson.approved") Object.assign(l, { status: "applied", updatedAt: e.at });
    }
  }
  return [...lessons.values()];
}

function changedFields(before: unknown, after: unknown, prefix = ""): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
    return unique([...Object.keys(a), ...Object.keys(b)]).flatMap((key) => changedFields(a[key], b[key], prefix ? `${prefix}.${key}` : key));
  }
  return [prefix];
}

interface ObservationToken {
  item: string;
  url: string;
  status: TokenState['status'];
  framework: string[];
  dossierFramework: string[] | null;
  lastAttempt?: string;
  finishedAtNode?: string;
}

function projectFramework(token: ObservationToken, patch: Record<string, unknown>): void {
  if ('framework' in patch) token.framework = frameworkNames(patch.framework);
  if ('dossier' in patch) {
    const dossier = patch.dossier;
    const value = dossier && typeof dossier === 'object' ? (dossier as Record<string, unknown>).framework : undefined;
    token.dossierFramework = value == null ? null : frameworkNames(value);
  }
}

export class Lessons implements Snapshottable {
  readonly snapshotName = 'lessons';
  private host: Host;
  private dir: string;
  private roles: string;
  private store: EvidenceStore;
  private unsubscribe?: () => void;
  private indexedSeq = 0;
  private lessonSeq = 0;
  private readonly cachedLessonEvents: LessonStamp[] = [];
  private viewSeq = -1;
  private cachedViews: LessonView[] = [];
  private observationTokens = new Map<string, ObservationToken>();
  private attemptNodes = new Map<string, string>();
  private consultContext = new Map<string, {owner: string; problem: string}>();
  private observations = new Map<string, LessonObservation[]>();
  private consultOrigins = new Map<string, Map<string, LessonObservation>>();
  private endedRuns = new Set<string>();
  private frozenRuns = new Set<string>();
  private currentRun = '';

  constructor(host: Host, dir: string, options: {rolesRoot?: string; deferReplay?: boolean} = {}) {
    this.host = host; this.dir = dir; this.roles = options.rolesRoot ?? roleRoot;
    this.store = host.store ?? new EvidenceStore(path.join(dir, "evidence"), process.env.FACTORY_READONLY === "1");
    host.docs?.setLessons(this);
    if (!options.deferReplay) this.start();
  }

  start(): void {
    if (this.unsubscribe) return;
    this.refresh();
    const projection = this.host.journal.subscribeProjection(event => this.observe(event));
    const consumer = this.host.journal.subscribe(event => {
      if (isLesson(event) && process.env.FACTORY_READONLY !== '1') this.write();
    });
    this.unsubscribe = () => {
      projection();
      consumer();
    };
  }

  close() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  serialize(): string {
    return serializeSnapshot({indexedSeq: this.indexedSeq, lessonSeq: this.lessonSeq,
      cachedLessonEvents: this.cachedLessonEvents, observationTokens: this.observationTokens,
      attemptNodes: this.attemptNodes, consultContext: this.consultContext,
      observations: this.observations, consultOrigins: this.consultOrigins,
      endedRuns: this.endedRuns, frozenRuns: this.frozenRuns, currentRun: this.currentRun});
  }

  restore(body: string): void {
    const record = (value: unknown): value is Record<string, unknown> =>
      Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    const strings = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every(entry => typeof entry === 'string');
    const stringSet = (value: unknown): value is Set<string> =>
      value instanceof Set && [...value].every(entry => typeof entry === 'string');
    const stringMap = (value: unknown, valid: (entry: unknown) => boolean): value is Map<string, unknown> =>
      value instanceof Map && [...value].every(([key, entry]) => typeof key === 'string' && valid(entry));
    const observation = (value: unknown): boolean => record(value) &&
      Number.isSafeInteger(value.seq) && Number(value.seq) > 0 && typeof value.at === 'number' &&
      ['candidate.disposition', 'token.returned', 'consult.opened', 'consult.replied', 'consult.closed'].includes(String(value.kind)) &&
      ['token', 'item', 'url', 'station', 'failureType', 'message'].every(key => typeof value[key] === 'string') &&
      strings(value.framework) && (value.nextAction === undefined || typeof value.nextAction === 'string');
    const saved = deserializeSnapshot(body);
    if (!record(saved) || !Number.isSafeInteger(saved.indexedSeq) || Number(saved.indexedSeq) < 0 ||
        !Number.isSafeInteger(saved.lessonSeq) || Number(saved.lessonSeq) < 0 || Number(saved.lessonSeq) > Number(saved.indexedSeq) ||
        !Array.isArray(saved.cachedLessonEvents) || !saved.cachedLessonEvents.every(event => record(event) &&
          typeof event.kind === 'string' && event.kind.startsWith('lesson.') && Number.isSafeInteger(event.seq)) ||
        !stringMap(saved.observationTokens, token => record(token) && typeof token.item === 'string' &&
          typeof token.url === 'string' && typeof token.status === 'string' && strings(token.framework) &&
          (token.dossierFramework === null || strings(token.dossierFramework)) &&
          (token.lastAttempt === undefined || typeof token.lastAttempt === 'string') &&
          (token.finishedAtNode === undefined || typeof token.finishedAtNode === 'string')) ||
        !stringMap(saved.attemptNodes, node => typeof node === 'string') ||
        !stringMap(saved.consultContext, consult => record(consult) && typeof consult.owner === 'string' && typeof consult.problem === 'string') ||
        !stringMap(saved.observations, entries => Array.isArray(entries) && entries.every(observation)) ||
        !stringMap(saved.consultOrigins, origins => stringMap(origins, observation)) ||
        !stringSet(saved.endedRuns) || !stringSet(saved.frozenRuns) || typeof saved.currentRun !== 'string') {
      throw new Error('Invalid lessons snapshot');
    }
    this.indexedSeq = Number(saved.indexedSeq);
    this.lessonSeq = Number(saved.lessonSeq);
    this.cachedLessonEvents.length = 0;
    for (const event of saved.cachedLessonEvents as LessonStamp[]) this.cachedLessonEvents.push(event);
    this.observationTokens = saved.observationTokens as Map<string, ObservationToken>;
    this.attemptNodes = saved.attemptNodes as Map<string, string>;
    this.consultContext = saved.consultContext as Map<string, {owner: string; problem: string}>;
    this.observations = saved.observations as Map<string, LessonObservation[]>;
    this.consultOrigins = saved.consultOrigins as Map<string, Map<string, LessonObservation>>;
    this.endedRuns = saved.endedRuns;
    this.frozenRuns = saved.frozenRuns;
    this.currentRun = saved.currentRun;
    this.viewSeq = -1;
    this.cachedViews = [];
  }

  observe(event: Stamped): void {
    if (event.seq <= this.indexedSeq) return;
    this.indexedSeq = event.seq;
    if (isLesson(event)) {
      this.cachedLessonEvents.push(event);
      this.lessonSeq = event.seq;
    }
    if (event.kind === 'run.started') {
      if (event.runId !== this.currentRun && this.observations.get(this.currentRun)?.length) {
        this.frozenRuns.add(this.currentRun);
      }
      this.currentRun = event.runId;
    } else if (event.kind === 'run.ended') {
      this.endedRuns.add(event.runId);
    } else if (event.kind === 'token.created') {
      this.observationTokens.set(event.token, {item: event.item, url: event.url,
        status: 'active', framework: ['unknown'], dossierFramework: null});
    } else if (event.kind === 'token.data') {
      const token = this.observationTokens.get(event.token);
      if (token) projectFramework(token, event.patch);
    } else if (event.kind === 'attempt.started') {
      this.attemptNodes.set(event.attempt, event.node);
      const token = this.observationTokens.get(event.token);
      if (token) token.lastAttempt = event.attempt;
    } else if (event.kind === 'token.finished') {
      const token = this.observationTokens.get(event.token);
      if (token) {
        token.status = event.status;
        token.finishedAtNode = event.node;
      }
    } else if (event.kind === 'token.returned') {
      const token = this.observationTokens.get(event.token);
      if (token && token.status !== 'active') {
        token.status = 'active';
        token.finishedAtNode = undefined;
      }
    } else if (event.kind === 'candidate.disposition') {
      const token = this.observationTokens.get(event.candidate.token);
      if (token && token.status !== 'active' && ['retry', 'removed'].includes(event.candidate.disposition)) {
        token.status = event.candidate.disposition === 'retry' ? 'parked' : 'rejected';
      }
    } else if (event.kind === 'correction.reverted') {
      const token = this.observationTokens.get(event.token);
      if (token) {
        const snapshot = event.snapshot as {data: Record<string, unknown>; status: TokenState['status']; finishedAtNode?: string};
        token.framework = ['unknown'];
        token.dossierFramework = null;
        projectFramework(token, snapshot.data);
        token.status = snapshot.status;
        token.finishedAtNode = snapshot.status === 'active' ? undefined : snapshot.finishedAtNode;
      }
    } else if (event.kind === 'consult.opened') {
      this.consultContext.set(event.consult, {owner: event.owner, problem: event.problem});
    }
    if (this.frozenRuns.has(event.run) || !['candidate.disposition', 'token.returned',
      'consult.opened', 'consult.replied', 'consult.closed'].includes(event.kind)) return;
    const origins = this.consultOrigins.get(event.run) ?? new Map<string, LessonObservation>();
    const observation = lessonObservation(event, {
      token: id => {
        const token = this.observationTokens.get(id);
        if (!token) return;
        return {item: token.item, url: token.url, framework: token.dossierFramework ?? token.framework,
          station: token.finishedAtNode ?? (token.lastAttempt ? this.attemptNodes.get(token.lastAttempt) : undefined)};
      },
      consult: id => this.consultContext.get(id),
    }, origins);
    this.consultOrigins.set(event.run, origins);
    if (observation) {
      const observations = this.observations.get(event.run) ?? [];
      observations.push(observation);
      this.observations.set(event.run, observations);
    }
  }

  private refresh(): void {
    if (this.indexedSeq === this.host.journal.seq) return;
    for (const event of this.host.journal.read(this.indexedSeq)) this.observe(event);
  }

  /** Ordinary context reads retain only lesson records, never business payloads. */
  private lessonEvents() {
    this.refresh();
    return this.cachedLessonEvents;
  }

  /** Audited review and validation need full history only for that operation. */
  private history(through = this.host.journal.seq) {
    return [...this.host.journal.read(0, undefined, through)];
  }

  /** Internal rendering reads the cache without exposing it to callers. */
  private views(): readonly LessonView[] {
    const events = this.lessonEvents();
    if (this.viewSeq !== this.lessonSeq) {
      this.cachedViews = projectLessons(events);
      this.viewSeq = this.lessonSeq;
    }
    return this.cachedViews;
  }
  list(): LessonView[] {
    return structuredClone(this.views()) as LessonView[];
  }

  sharedLessons(node?: string): import('../shared/lessons.ts').SharedLesson[] {
    const lessons = new Map<string, import('../shared/lessons.ts').SharedLesson>();
    for (const event of this.lessonEvents()) {
      if (event.kind === 'lesson.shared') lessons.set(event.lesson.id, structuredClone(event.lesson));
      else if (event.kind === 'lesson.deleted') {
        const lesson = lessons.get(event.id);
        if (lesson) lesson.status = 'deleted';
      }
    }
    return [...lessons.values()].filter(lesson => (!node || lesson.node === node) && lesson.status !== 'deleted')
      .sort((left, right) => right.at - left.at || left.id.localeCompare(right.id));
  }

  activeFor(node: string): string[] {
    return this.sharedLessons(node).filter(lesson => lesson.status === 'active').slice(0, 5)
      .map(lesson => lesson.text.slice(0, 300));
  }

  writeShared(lesson: import('../shared/lessons.ts').SharedLesson): void {
    if (process.env.FACTORY_READONLY === '1') throw new ControlError(403, 'read_only', '只读项目不能写经验');
    if (!lesson.id || !this.host.compiled.nodes.some(node => node.key === lesson.node) ||
        !lesson.text.trim() || lesson.text.length > 300 || !Number.isSafeInteger(lesson.at) || lesson.at < 0 || !['active', 'canary'].includes(lesson.status) ||
        !lesson.evidence.length || lesson.evidence.some(id => !this.host.state.attempts[id])) {
      throw new ControlError(422, 'invalid_lesson', '经验必须关联真实工位、尝试证据，正文不超过 300 字');
    }
    this.host.journal.atomic(() => this.host.journal.append({kind: 'lesson.shared', lesson: structuredClone(lesson)}));
  }

  deleteShared(id: string, actor: 'user' | 'dispatcher' = 'user'): {id: string; deleted: true} {
    if (process.env.FACTORY_READONLY === '1') throw new ControlError(403, 'read_only', '只读项目不能删除经验');
    if (!this.sharedLessons().some(lesson => lesson.id === id)) throw new ControlError(404, 'lesson_not_found', '找不到这条跨货经验');
    this.host.journal.atomic(() => this.host.journal.append({kind: 'lesson.deleted', id, actor}));
    return {id, deleted: true};
  }
  get(id: string) {
    const found = this.views().find((l) => l.id === id);
    if (!found) throw new ControlError(404, "lesson_not_found", "找不到这条经验草案");
    return structuredClone(found);
  }
  private emit(event: LessonEvent) { return this.host.journal.append(event); }
  private role(station: string) {
    if (!/^(dispatcher|[a-z0-9-]+\/[a-z0-9-]+)$/.test(station)) throw new ControlError(400, "invalid_station", "无效的工位标识");
    const file = path.join(this.roles, station, "ROLE.md");
    const content = fs.readFileSync(file, "utf8");
    return { file, content, revision: hash(content).slice(0, 12) };
  }
  private current(id: string, digest: string) {
    const l = this.get(id);
    if (l.digest !== digest) fail("草案已经改变，请重新读取并验证当前内容");
    if (!["pending", "validated"].includes(l.status)) fail("这条经验已经作出决定，不能改写或重复验证");
    if (this.role(l.station).revision !== l.roleRevision) fail("ROLE.md 已变化，需要修订草案并重新验证");
    if (this.host.compiled.digest !== l.specDigest) fail("流水线规格已变化，需要修订草案并重新验证");
    return l;
  }

  /** Called after report.ready (cleanup is complete); idempotent across restarts. */
  draftRun(runId: string) {
    // The compact replay index captures each observation at its original event.
    // It also retains runs whose draft write was interrupted before a snapshot.
    this.refresh();
    if (!this.endedRuns.has(runId)) throw new ControlError(409, "run_not_ended", "本轮尚未结束，不能提前复盘");
    const existing = this.list().filter((l) => l.runId === runId);
    const groups = observationGroups(this.observations.get(runId) ?? []);
    for (const group of groups) {
      const first = group[0], id = `lesson-${hash(JSON.stringify([runId, first.station, first.failureType, first.framework])).slice(0, 16)}`;
      if (existing.some((l) => l.id === id)) continue;
      let roleRevision = "missing";
      try { roleRevision = this.role(first.station).revision; } catch { /* missing roles block approval, not evidence conservation */ }
      const label = failureLabels[first.failureType as keyof typeof failureLabels] ?? "审核修改";
      const actions = unique(group.map((o) => o.nextAction).filter((x): x is string => Boolean(x)));
      const problem = `${label}；${unique(group.map((o) => o.item)).length} 件样本，${group.length} 条事件。${first.message}`;
      const suggestion = actions.length ? actions.join("\n") : "收到审核修改请求时，先核对本次输入和原始证据，只修复审核点名的问题，保留已完成的产物；修复后交原审核工位复查。";
      const body = { id, runId, station: first.station, failureType: first.failureType, framework: first.framework, observations: group, problem, suggestion, roleRevision, specDigest: this.host.compiled.digest };
      this.emit({ kind: "lesson.proposed", draft: { ...body, digest: draftDigest(body) } });
    }
    return this.list().filter((l) => l.runId === runId);
  }

  revise(id: string, args: { digest: string; suggestion: string; problem?: string }, actor: Actor) {
    const l = this.get(id);
    if (l.digest !== args.digest || !["pending", "validated"].includes(l.status)) fail("只能修订当前版本的待批准草案");
    if (!args.suggestion.trim() || args.suggestion.length > 4000 || args.suggestion.includes("<!--")) throw new ControlError(400, "invalid_lesson", "经验正文需为 1–4000 字，不能包含文档管理标记");
    const body: LessonDraft = { id: l.id, runId: l.runId, station: l.station, failureType: l.failureType, framework: l.framework, observations: l.observations, problem: args.problem?.trim() || l.problem, suggestion: args.suggestion.trim(), roleRevision: this.role(l.station).revision, specDigest: this.host.compiled.digest, digest: "" };
    body.digest = draftDigest(body);
    this.emit({ kind: "lesson.revised", draft: body, by: actor });
    return this.get(id);
  }

  private replay(events: Stamped[]) { const s = initialState(this.host.compiled); for (const e of events) apply(s, e); return s; }
  private artifact(src: string): LessonArtifact {
    const file = this.store.resolve(src);
    if (!file || !fs.existsSync(file)) fail("验证引用的持久证据不存在", { src });
    const sha256 = hash(fs.readFileSync(file!));
    if (!path.basename(file!).startsWith(`${sha256}.`)) fail("证据文件内容与寻址摘要不一致", { src });
    return { src, sha256 };
  }
  private assertArtifacts(sample: LessonSample) {
    for (const a of [sample.record, ...sample.assets]) if (this.artifact(a.src).sha256 !== a.sha256) fail("验证之后证据已发生变化", { item: sample.item, src: a.src });
  }
  private sample(token: string, events: Stamped[]): LessonSample {
    const s = this.replay(events), t = s.tokens[token];
    const end = events.findLast((e) => e.kind === "token.finished" && e.token === token);
    if (!t || t.status !== "published" || end?.kind !== "token.finished") fail("验证样本必须真正通过发布闸门", { token });
    const gate = events.findLast((e) => e.kind === "evidence.added" && e.evidence.token === token && e.evidence.station.endsWith("/gate") && e.evidence.tone === "ok" && e.evidence.meta?.digest === t.data.digest);
    if (!gate || t.data.gate !== "pass" || typeof t.data.digest !== "string") fail("缺少发布闸门的真实通过记录", { token });
    const key = String(t.data.key ?? t.data.host ?? t.item).replace(/[\\/:*?"<>|]+/g, "~");
    const file = path.join(this.dir, "published", `${key}.json`);
    if (!fs.existsSync(file)) fail("已发布样本缺少本项目的持久 JSON", { token });
    const bytes = fs.readFileSync(file), record = JSON.parse(bytes.toString("utf8"));
    if (record.h2?.token !== token || record.h2?.digest !== t.data.digest) fail("发布文件与本次处理或闸门摘要不一致", { token });
    const { digest: _digest, publishedAt: _publishedAt, ...h2 } = record.h2;
    const contentDigest = hash(JSON.stringify({ ...record, h2, official: { ...record.official, checkedAt: "" }, classification: { ...record.classification, confirmedAt: "" }, editorialVoice: null }));
    if (contentDigest !== t.data.digest) fail("发布 JSON 内容与闸门核验的摘要不一致", { token });
    const refs = new Set<string>();
    const collect = (v: unknown) => {
      if (typeof v === "string" && v.startsWith("/evidence/")) refs.add(v);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === "object") Object.values(v).forEach(collect);
    };
    collect(record.pages); collect(record.preview);
    if (!refs.size) fail("发布样本没有可核验的图片或视频证据", { token });
    const assets = [...refs].map((src) => this.artifact(src));
    const copy = this.store.put(bytes, "json");
    return { item: t.item, token, url: t.url, finishedSeq: end.seq, record: { src: copy.src, sha256: copy.sha }, assets };
  }

  /** Reserve samples before reruns. Regression baselines are copied immutably now. */
  beginValidation(id: string, args: { digest: string; regressionItems: string[] }) {
    const l = this.current(id, args.digest), events = this.history();
    const failures = unique(l.observations.map((o) => o.item)).map((item) => ({ item, url: l.observations.find((o) => o.item === item)!.url }));
    const items = unique(args.regressionItems);
    if (items.length < 2 || items.some((item) => failures.some((f) => f.item === item))) fail("验证需要全部失败样本，以及另外至少两个不同的已发布站点");
    const s = this.replay(events);
    const regressions = items.map((item) => {
      const t = s.tokenOrder.map((token) => s.tokens[token]).findLast((token) => token.item === item && token.status === "published");
      if (!t) return fail("回归条目没有历史已发布记录", { item });
      return this.sample(t.id, events);
    });
    // Validate the complete sample set before Factory creates a run or any token.
    // In particular, old invalid_url observations must not fail halfway through
    // binding while otherwise healthy regression tasks have already been queued.
    for (const sample of [...failures, ...regressions]) sampleURL(sample.url);
    const trial: LessonTrial = { id: `lesson-trial-${crypto.randomUUID()}`, lessonId: id, digest: l.digest, roleRevision: l.roleRevision, specDigest: l.specDigest, failures, regressions };
    this.emit({ kind: "lesson.validation.started", trial });
    return trial;
  }

  private trial(id: string) {
    const e = this.lessonEvents().find((e) => e.kind === "lesson.validation.started" && e.trial.id === id);
    if (!e || e.kind !== "lesson.validation.started") throw new ControlError(404, "lesson_trial_not_found", "找不到经验验证批次");
    return e;
  }

  /** Call immediately after creating each token, before the first attempt starts. */
  bindValidation(trialId: string, tokens: string[]) {
    const started = this.trial(trialId), trial = started.trial;
    this.current(trial.lessonId, trial.digest);
    const events = this.history();
    const allowed = [...trial.failures, ...trial.regressions];
    const pending = unique(tokens).map((token) => {
      const created = events.find((e) => e.kind === "token.created" && e.token === token);
      const bound = events.find((e) => e.kind === "lesson.validation.bound" && e.token === token);
      if (bound?.kind === "lesson.validation.bound" && bound.trialId === trialId) return null;
      if (!created || created.kind !== "token.created" || created.seq <= started.seq || bound || events.some((e) => e.kind === "attempt.started" && e.token === token)) fail("只能绑定验证开始后新建且尚未执行的任务", { token });
      const expected = allowed.find((s) => s.item === created.item);
      if (!expected || sampleURL(expected.url) !== sampleURL(created.url)) fail("重跑任务必须对应预先选定的站点与入口", { token });
      return { token, item: created.item };
    }).filter((x): x is { token: string; item: string } => x !== null);
    if (unique(pending.map((p) => p.item)).length !== pending.length || pending.some((p) => events.some((e) => e.kind === "lesson.validation.bound" && e.trialId === trialId && e.item === p.item))) fail("同一个验证批次每件样本只能绑定一个任务；再次试验请建立新批次");
    for (const item of pending) this.emit({ kind: "lesson.validation.bound", trialId, ...item });
    return { trialId, tokens: unique(tokens) };
  }

  /** Only bound trial attempts receive a candidate rule; production roles stay intact. */
  validationContext(station: string, item: string, scope: CaseScope) {
    if (process.env.FACTORY_READONLY === "1") return "";
    const attempt = this.host.state.attempts[scope.attempt];
    if (!attempt || attempt.token !== scope.token || attempt.node !== station || attempt.endedAt || this.host.state.tokens[scope.token]?.item !== item) return "";
    const events = this.lessonEvents();
    const bound = events.find((e) => e.kind === "lesson.validation.bound" && e.token === attempt.token);
    if (bound?.kind !== "lesson.validation.bound") return "";
    const trial = this.trial(bound.trialId).trial, l = this.get(trial.lessonId);
    if (l.station !== station) return "";
    this.current(l.id, trial.digest);
    if (!events.some((e) => e.kind === "lesson.validation.exposed" && e.trialId === trial.id && e.attempt === attempt.id)) this.emit({ kind: "lesson.validation.exposed", trialId: trial.id, digest: l.digest, token: attempt.token, attempt: attempt.id, station });
    return `---\n# 仅本次验证使用的候选经验（尚未批准）\n草案 ${l.id} @ ${l.digest}；验证 ${trial.id}。保留 ROLE.md 的全部铁律；若候选经验与铁律冲突，报告冲突，不执行冲突内容。\n${l.suggestion}`;
  }

  private evaluateValidation(trialId: string, throughSeq?: number) {
    const started = this.trial(trialId), trial = started.trial;
    const l = this.current(trial.lessonId, trial.digest), events = this.history(throughSeq), s = this.replay(events);
    const bound = events.filter((e): e is Stamped<Extract<LessonEvent, { kind: "lesson.validation.bound" }>> => e.kind === "lesson.validation.bound" && e.trialId === trialId);
    const check = (item: string) => {
      const binding = bound.findLast((e) => e.item === item);
      if (!binding) return fail("验证样本尚未创建并绑定重跑任务", { item });
      const t = s.tokens[binding.token];
      const ended = events.findLast((e) => e.kind === "token.finished" && e.token === binding.token);
      if (!t || ended?.kind !== "token.finished" || ended.status !== "published") return fail("验证样本没有成功发布", { item });
      const runEnded = events.find((e) => e.kind === "run.ended" && e.runId === ended.run && e.seq > ended.seq);
      if (!runEnded) return fail("验证轮次未完成，不能把当前进度当回归结果", { item });
      const attempts = t.attempts.map((id) => s.attempts[id]).filter((a) => a.node === l.station && a.startedAt);
      if (!attempts.length || attempts.some((a) => !a.ok || !a.endedAt || a.cancelled)) return fail("失败工位尚未经过成功的重新执行", { item, station: l.station });
      const needsExposure = ["agent", "review"].includes(this.host.compiled.nodes.find((n) => n.key === l.station)?.kind ?? "");
      if (needsExposure && attempts.some((a) => !events.some((e) => e.kind === "lesson.validation.exposed" && e.trialId === trialId && e.digest === l.digest && e.attempt === a.id && e.token === t.id))) return fail("工位没有实际读到这个版本的候选经验", { item });
      const recurrence = groupLessonObservations(events, ended.run, this.host.compiled).flat().filter((o) => o.token === t.id && o.seq > binding.seq && o.station === l.station && o.failureType === l.failureType);
      if (recurrence.length) return fail("验证中再次出现同类失败或审核退回", { item, seqs: recurrence.map((o) => o.seq) });
      return this.sample(t.id, events);
    };
    const failures = trial.failures.map((sample) => check(sample.item));
    const regressions = trial.regressions.map((baseline) => {
      this.assertArtifacts(baseline);
      const sample = check(baseline.item);
      const before = JSON.parse(fs.readFileSync(this.store.resolve(baseline.record.src)!, "utf8"));
      const after = JSON.parse(fs.readFileSync(this.store.resolve(sample.record.src)!, "utf8"));
      const changes = changedFields(before, after).filter((key) => !["h2.token", "h2.publishedAt", "h2.digest", "official.checkedAt", "classification.confirmedAt", "editorialVoice.writtenAt"].includes(key));
      return { ...sample, baselineToken: baseline.token, changedFields: changes };
    });
    const body = { trialId, lessonId: l.id, digest: l.digest, roleRevision: l.roleRevision, specDigest: l.specDigest, failures, regressions, throughSeq: events.at(-1)?.seq ?? 0 };
    const evidenceDigest = hash(JSON.stringify({ ...body, events: events.filter((e) => e.seq >= started.seq && !isLesson(e)) }));
    const validation: LessonValidation = { ...body, evidenceDigest };
    return validation;
  }

  validate(trialId: string) {
    const validation = this.evaluateValidation(trialId);
    this.emit({ kind: "lesson.validated", validation });
    return validation;
  }

  approve(id: string, args: { digest: string; validationDigest: string }, actor: Actor) {
    if (!isOwner(actor)) throw new ControlError(403, "user_approval_required", "只有站长或主调度明确批准后才能把经验写入 ROLE.md；工位 Agent 只能起草与验证");
    if (["running", "paused"].includes(this.host.state.run.status)) throw new ControlError(409, "run_active", "先结束当前轮次，再更新生产手册");
    const l = this.current(id, args.digest), v = l.validation;
    if (!v || v.evidenceDigest !== args.validationDigest) fail("缺少当前草案的失败重跑与已发布回归证据");
    for (const sample of [...v.failures, ...v.regressions]) this.assertArtifacts(sample);
    // Re-check the bound run so a stale or superseded validation never authorizes a write.
    const again = this.evaluateValidation(v.trialId, v.throughSeq);
    if (again.evidenceDigest !== v.evidenceDigest) fail("验证之后样本发生了变化，请查看新证据再决定");
    const role = this.role(l.station);
    const lastSection = [...role.content.matchAll(/^## (.+)$/gm)].at(-1)?.[1].trim();
    const addition = `${role.content.endsWith("\n") ? "" : "\n"}\n${lastSection === "已知坑" ? "" : "## 已知坑\n\n"}<!-- H2:LESSON:${l.id}:${l.digest} -->\n- ${l.suggestion.replace(/\r?\n/g, "\n  ")}\n`;
    const roleResultDigest = hash(role.content + addition);
    // The owner decision is durable before mutation; recoverApproved finishes a
    // interrupted append, and verifies exact bytes before ever writing again.
    this.emit({ kind: "lesson.approved", lessonId: id, digest: l.digest, validationDigest: args.validationDigest, actor, roleRevision: l.roleRevision, roleResultDigest, addition });
    this.applyApproved(this.get(id));
    return this.get(id);
  }

  reject(id: string, args: { digest: string; reason: string }, actor: Actor) {
    if (!isOwner(actor)) throw new ControlError(403, "user_approval_required", "只有站长或主调度可以决定拒绝经验草案");
    const l = this.get(id);
    if (l.digest !== args.digest || !["pending", "validated"].includes(l.status)) fail("只能拒绝当前版本的待批准草案");
    if (!args.reason.trim()) throw new ControlError(400, "invalid_lesson", "请保留拒绝原因");
    this.emit({ kind: "lesson.rejected", lessonId: id, digest: l.digest, actor, reason: args.reason.trim() });
    return this.get(id);
  }

  private applyApproved(l: LessonView) {
    if (l.status !== "approved" || l.decision?.kind !== "lesson.approved") return;
    const decision = l.decision, role = this.role(l.station);
    if (hash(role.content) !== decision.roleResultDigest) {
      if (role.revision !== decision.roleRevision || hash(role.content + decision.addition) !== decision.roleResultDigest) fail("已批准的 ROLE 追加遇到并发编辑，保留决定，停止写入");
      fs.appendFileSync(role.file, decision.addition, "utf8");
    }
    this.emit({ kind: "lesson.applied", lessonId: l.id, digest: l.digest, roleResultDigest: decision.roleResultDigest });
  }

  recoverApproved() {
    const result: { applied: string[]; issues: { id: string; message: string }[] } = { applied: [], issues: [] };
    if (["running", "paused"].includes(this.host.state.run.status)) return result;
    for (const l of this.list()) if (l.status === "approved") {
      try { this.applyApproved(l); result.applied.push(l.id); }
      catch (error) {
        const message = `经验恢复 ${l.id}：${(error as Error).message}。原 ROLE 已保留；核对角色版本后由站长或主调度处理。`;
        result.issues.push({ id: l.id, message });
        if (!this.host.state.contextNotes?.dispatcher?.some((note) => note.kind === "issue" && note.text === message)) this.host.journal.append({ kind: "context.noted", node: "dispatcher", note: { kind: "issue", text: message, by: "Easy Workflow 复盘恢复" } });
      }
    }
    return result;
  }

  pendingContext(station: string) {
    const lessons = this.views().filter((l) => (station === "dispatcher" || l.station === station) && ["pending", "validated", "approved"].includes(l.status)).sort((a, b) => b.updatedAt - a.updatedAt);
    const shown = lessons.slice(0, 8).map((l) => `- [${l.id}] ${l.station} · ${l.failureType} · ${clean(l.framework.join(" / "))}（${l.status === "validated" ? "验证已齐，待批准" : l.status === "approved" ? "已批准，待写入角色" : "待验证与批准"}；未写入 ROLE 前不作为生产规则）\n  ${clean(l.suggestion)}\n  证据：${l.runId}，事件 ${l.observations.slice(0, 8).map((o) => o.seq).join(", ")}${l.observations.length > 8 ? `…共 ${l.observations.length} 条，见 LESSONS.md` : ""}；草案 ${l.digest}`);
    if (lessons.length > 8) shown.push(`- 较早的 ${lessons.length - 8} 条经验已省略，完整记录见 LESSONS.md。`);
    return shown.join("\n");
  }

  render() {
    const labels = { pending: "待验证与批准", validated: "验证已齐，待批准", approved: "已批准，待写入角色", applied: "已批准并写入 ROLE", rejected: "已拒绝" };
    return [blockStart, "## 复盘记录", "", "> 以下内容由 Easy Workflow 从 journal 渲染。未批准经验不是生产规则；批准必须绑定草案摘要、失败样本重跑和至少两个已发布站点的回归证据。", "", ...this.views().flatMap((l) => [
      `### ${l.id} · ${labels[l.status]}`, "", `- 工位：${l.station}；失败类型：${l.failureType}；站点框架：${clean(l.framework.join(" / "))}`,
      `- 轮次：${l.runId}；草案摘要：${l.digest}；角色版本：${l.roleRevision}`,
      `- 现象：${clean(l.problem)}`, `- 候选经验：${clean(l.suggestion)}`,
      `- 原始事件：${l.observations.map((o) => `${o.kind}#${o.seq}`).join("、")}`,
      `- 样本：${clean(unique(l.observations.map((o) => o.item)).join("、"))}`,
      ...(l.validation ? [`- 验证摘要：${l.validation.evidenceDigest}；失败样本 ${l.validation.failures.length}；已发布回归 ${l.validation.regressions.length}`, ...l.validation.regressions.map((sample) => `  - ${clean(sample.item)}：${sample.baselineToken} → ${sample.token}；字段变化：${clean(sample.changedFields.join("、")) || "无"}；${sample.record.src}`)] : []),
      ...(l.decision?.kind === "lesson.rejected" ? [`- 拒绝原因：${clean(l.decision.reason)}`] : []), "",
    ]), blockEnd].join("\n");
  }

  write() {
    const file = projectPaths(this.dir).lessons;
    const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# 经验（LESSONS）\n";
    const first = old.indexOf(blockStart), last = old.indexOf(blockEnd);
    if ((first < 0) !== (last < 0) || (first >= 0 && (last < first || old.indexOf(blockStart, first + blockStart.length) >= 0 || old.indexOf(blockEnd, last + blockEnd.length) >= 0))) throw new ControlError(409, "lesson_document_conflict", "LESSONS.md 的程序段标记损坏；保留原文件，等待修复");
    const rendered = this.render();
    const content = first < 0 ? `${old.trimEnd()}\n\n${rendered}\n` : `${old.slice(0, first)}${rendered}${old.slice(last + blockEnd.length)}`;
    if (content !== old) fs.writeFileSync(file, content);
    for (const station of unique(this.views().map((l) => l.station).concat("dispatcher"))) this.host.docs?.write("context", station);
  }
}
