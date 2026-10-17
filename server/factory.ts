// The factory: compiles the packs, opens the journal, rebuilds state, restores any
// unfinished run after a crash (Spec F2.5, N3) and wires executors, the candidate pool,
// the dispatcher and the run report together.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {randomUUID} from 'node:crypto';
import type {CompiledFactory, CompiledNode, ProjectAgentDefaults, Stamped, StationAgentBinding} from '../shared/types.ts';
import { apply, initialState, latestRunTokens, tokenWorkKey, recoveryKey, validateState, serializeSnapshot, deserializeSnapshot, type FactoryState } from "../shared/project.ts";
import { compile, type Patch } from "./spec/compile.ts";
import { Journal } from "./journal.ts";
import { Broker } from "./broker.ts";
import { EvidenceStore } from "./evidence.ts";
import { Runtime, type Executor, type ExecutorRegistration, type TokenRun, type StationContext, type StationResult } from "./runtime.ts";
import { runAgentStation, runStationDialogue, type AgentStationDef } from "./agent-station.ts";
import { pack } from "../packs/vislexicon/pack.ts";
import { TOOLS, canonical, type Services } from "../packs/vislexicon/tools.ts";
import { agentDefs, warmStyleLib } from "../packs/vislexicon/agents.ts";
import {Kernel} from './kernel/kernel.ts';
import {kernelStreams} from './kernel/streams.ts';
import {asTokenRun} from './kernel/item.ts';
import {BoardStore} from './board.ts';
import {Collaboration, type CollaborationTurn} from './collaboration.ts';
import {collaborationView, collaborationImages, collaborationPixels, judgeCollaboration} from './collaboration-views.ts';
import type {EnvContext} from './toolbox.ts';
import type {BoardPostInput} from '../shared/board.ts';
import { loadCatalog, loadPublished, type CatalogEntry } from "../packs/vislexicon/env.ts";
import { ControlError } from "./errors.ts";
import { classifyFailure, type CandidateRecovery, type Failure } from "../shared/failures.ts";
import { readRole } from "./roles.ts";
import { ensureProject, projectPaths, synchronizeProjectPacks, type ProjectInfo } from "./workspace.ts";
import {withNetworkCache} from './network.ts';
import { Docs } from "./docs.ts";
import { Lessons } from "./lessons.ts";
import { Toolbox } from "./toolbox.ts";
import { preflight } from "./preflight.ts";
import type { Alert } from "../shared/types.ts";
import type { BrowserState } from "../shared/browser.ts";
import { BatchSupervisor } from './batch.ts';
import { browserCommand, openPage } from './browser.ts';
import {visit, VIEW} from '../packs/vislexicon/capture.ts';
import { loadWorkflowPacks, type LoadedWorkflowPacks } from './workflow-packs.ts';
import { flushAtlas } from '../packs/vislexicon/components.ts';
import { ChannelSupervisor } from './channels.ts';
import { SourceSupervisor } from './sources.ts';
import {agentCapabilities, closedModelDependency, parseAgentBinding, resolveNativeCommand} from './agent-bindings.ts';
import {models, piModelCatalog, piSelection, piStatus} from './pi.ts';
import {UnmanagedRecoverySupervisor} from './recovery.ts';
import {ModelCircuits} from './model-circuits.ts';
import {withModelAdmission} from './model-requests.ts';
import {importExternalIntake, readExternalIntake, type ExternalIntakeManifest} from './external-intake.ts';
import {continuationPriority, externalResearchFor, reuseExternalStation} from './intake-continuation.ts';
import {reuseExternalCapture} from './intake-captures.ts';
import {PublicationOutbox} from './publication-outbox.ts';
import {restoreSnapshots, saveSnapshots, snapshotVersion, type Snapshottable} from './snapshots.ts';
import {projectDecisionClient, withDecisionAttempt} from './decision-model.ts';

export const ROOT = process.env.FACTORY_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VAR = process.env.FACTORY_VAR ?? path.join(ROOT, "var");

export interface Settings { browser: number; model: number; modelWorkers: number; cpu: number; http: number; memoryFloorMB: number; socialPerMinute: number; socialPerDay: number; maxActiveItems: number; kernel?: 'v1' | 'v2' }

interface RecoveryProjection {
  done: Map<string, Set<string>>;
  removed: Map<string, Set<string>>;
  notes: Map<string, TokenRun['notes']>;
  checkpointed: Set<string>;
  arrivals: Map<string, number[]>;
  sampleTokens: Set<string>;
  run: string;
}

function initialRecoveryProjection(): RecoveryProjection {
  return {done: new Map(), removed: new Map(), notes: new Map(), checkpointed: new Set(),
    arrivals: new Map(), sampleTokens: new Set(), run: ''};
}

export class Factory {
  compiled!: CompiledFactory;
  journal: Journal;
  state!: FactoryState;
  runtime!: Runtime;
  broker!: Broker;
  store: EvidenceStore;
  catalog: CatalogEntry[] = [];
  taken = new Set<string>();
  patches: Patch[] = [];
  importing = false;
  externalIntake: ExternalIntakeManifest | null = null;
  publicationOutbox?: PublicationOutbox;
  settings: Settings;
  ephemeral = new Set<(e: Record<string, unknown>) => void>();
  project: ProjectInfo;
  docs!: Docs;
  lessons!: Lessons;
  toolbox!: Toolbox;
  batch!: BatchSupervisor;
  workflowPacks?: LoadedWorkflowPacks;
  channels?: ChannelSupervisor;
  sources!: SourceSupervisor;
  recovery!: UnmanagedRecoverySupervisor;
  modelCircuits!: ModelCircuits;
  private services!: Services;
  private stationAgents: Record<string, AgentStationDef> = {};
  board?: BoardStore;
  collaboration?: Collaboration;
  decisionModel: ReturnType<typeof projectDecisionClient> = null;
  private recoveryProjection = initialRecoveryProjection();
  private snapshotComponents: Snapshottable[] = [];
  private projectionVersion = '';
  private snapshotSeq = 0;
  private snapshotTimer?: ReturnType<typeof setTimeout>;
  private snapshotUnsubscribe?: () => void;
  private snapshotTask?: Promise<void>;
  private snapshotClosing?: Promise<void>;
  private snapshotsActive = false;

  get kernel(): 'v1' | 'v2' {
    return this.runtime instanceof Kernel ? 'v2' : this.runtime ? 'v1'
      : process.env.FACTORY_KERNEL === 'v1' ? 'v1'
      : process.env.FACTORY_KERNEL === 'v2' || this.settings.kernel === 'v2' ? 'v2' : 'v1';
  }

  private createRuntime(compiled: CompiledFactory, conditions: Runtime['conditions'], executors: Runtime['executors']): Runtime {
    if (this.kernel === 'v2') {
      const kernel = new Kernel(compiled, this.journal, this.broker, conditions, executors);
      kernel.maxActiveItems = this.settings.maxActiveItems;
      this.wireCollaboration(kernel, compiled);
      return kernel;
    }
    return new Runtime(compiled, this.journal, this.broker, conditions, executors);
  }

  private wireCollaboration(kernel: Kernel, compiled: CompiledFactory) {
    const contracts = Object.assign({}, ...this.workflowPacks!.packs.map(pack => pack.contracts ?? {}));
    const historical: Record<string, string[]> = {};
    for (const attempt of Object.values(this.state.attempts).filter(attempt => attempt.ok && attempt.output && !Object.hasOwn(attempt.output, 'dialogue'))
      .sort((left, right) => (left.endedAt ?? left.startedAt) - (right.endedAt ?? right.startedAt))) {
      historical[attempt.node] = Object.keys(attempt.output!);
    }
    const board = new BoardStore(this.journal, compiled, contracts, historical);
    const owner = (id: string, field: string) => {
      const item = kernel.store.get(id);
      if (!item) return undefined;
      if (field === 'kind' && item.nodes[`${item.line}/kind-join`]) return `${item.line}/kind-join`;
      return board.owners(item, field)[0];
    };
    const collaboration = new Collaboration(board, {
      compiled, getItem: id => kernel.store.get(id), owner,
      view: (id, node, field) => collaborationView(compiled, kernel.store.get(id)!.data, node, field),
      runTurn: turn => this.runCollaborationTurn(kernel, turn),
      programJudge: async (name, input) => {
        const node = owner(input.itemId, input.field);
        if (!node) return {decided: false};
        const context = this.collaborationContext(kernel, input.itemId, node, `rules-${randomUUID()}`, new AbortController().signal);
        return judgeCollaboration(name, context, input.posts, this.store);
      },
      evidenceText: (id, evidenceId) => {
        const evidence = this.state.evidence[evidenceId];
        if (!evidence || evidence.token !== id) return undefined;
        const fragments: string[] = [];
        const collect = (value: unknown, key = '') => {
          if (typeof value === 'string' && ['quote', 'text', 'excerpt', 'body', 'verdict'].includes(key)) fragments.push(value);
          else if (Array.isArray(value)) value.forEach(entry => collect(entry, key));
          else if (value && typeof value === 'object') Object.entries(value).forEach(([name, entry]) => collect(entry, name));
        };
        collect(evidence);
        const file = evidence.src && this.store.resolve(evidence.src);
        if (file && /\.(?:txt|md|json|html)$/i.test(file) && fs.statSync(file).size <= 1_048_576) fragments.push(fs.readFileSync(file, 'utf8'));
        return fragments.length ? fragments.join('\n') : undefined;
      },
      applyResolution: (id, field, value, node, room) => kernel.applyRoomResolution(id, field, value, node, room),
      park: (id, node, reason) => kernel.parkCollaboration(id, node, reason),
    });
    kernel.configureCollaboration({board, answer: (question, signal) => collaboration.answer(question, signal),
      runRoom: (room, signal) => collaboration.runRoom(room, signal),
      openRoom: (item, field, topic) => {
        const policy = compiled.rooms?.find(rule => rule.field === field || rule.field.endsWith('.*') && field.startsWith(rule.field.slice(0, -1)));
        if (!policy) throw new ControlError(422, 'room_policy_missing', '该字段没有讨论室配置');
        return board.createRoom({item, field, topic, participants: policy.participants, judge: policy.judge});
      }});
    this.board = board;
    this.collaboration = collaboration;
  }

  private collaborationContext(kernel: Kernel, id: string, key: string, attempt: string, signal: AbortSignal,
    validSession: () => boolean = () => true): StationContext {
    const item = kernel.store.get(id), node = kernel.nodes.get(key);
    if (!item || !node) throw new ControlError(404, 'collaboration_node_missing', '答疑节点或货不存在');
    return {token: asTokenRun(item), node, attempt, signal, session: item.nodes[key]?.session,
      checkpointSession: checkpoint => { if (validSession()) kernel.saveDialogueSession(id, key, {sessionCheckpoint: checkpoint}, true); },
      worker: {id: `dialogue-${attempt}`, node: key, label: node.name, busy: id, idleSince: 0},
      progress: (text, step) => { this.journal.append({kind: 'attempt.progress', attempt, text, ...(step ? {step} : {})}); },
      activity: activity => { this.journal.append({kind: 'attempt.activity', attempt, activity}); },
      addEvidence: input => {
        const evidence = {...input, station: key, token: id, attempt, at: Date.now()};
        this.journal.append({kind: 'evidence.added', evidence});
        return evidence;
      }};
  }

  private async runCollaborationTurn(kernel: Kernel, turn: CollaborationTurn): Promise<StationResult> {
    const signal = turn.signal ?? new AbortController().signal;
    await kernel.waitForStationIdle(turn.itemId, turn.node, signal);
    const node = kernel.nodes.get(turn.node);
    if (!node || !['agent', 'review'].includes(node.kind)) throw new ControlError(422, 'dialogue_not_agent', '只有 Agent 节点可以参加答疑');
    const attempt = `dialogue-${randomUUID()}`, startedAt = Date.now();
    const generation = kernel.store.get(turn.itemId)?.nodes[turn.node];
    const validSession = () => {
      const current = kernel.store.get(turn.itemId);
      const owner = current?.nodes[turn.node];
      return current?.status === 'active' && Boolean(generation && owner) && owner?.lastAttempt === generation?.lastAttempt &&
        owner?.rounds === generation?.rounds && (!turn.room || current.roomHolds?.[turn.room.id]?.field === turn.room.field);
    };
    const context = this.collaborationContext(kernel, turn.itemId, turn.node, attempt, signal, validSession);
    let view = turn.view;
    if (view.viewKind === 'dossier+home' && (!Array.isArray(view.images) || !view.images.length)) {
      let screenshot = Object.values(this.state.evidence).filter(evidence => evidence.token === turn.itemId && evidence.label === '讨论首页截图').at(-1);
      if (!screenshot) {
        const browserLease = await this.broker.acquire('browser', {signal});
        if (!browserLease) throw new ControlError(503, 'dialogue_resource', '讨论截图等待浏览器资源');
        let close: (() => Promise<void>) | undefined;
        try {
          const browser = await openPage(VIEW, 'zh-CN', signal);
          close = browser.close;
          const url = context.token.url;
          const result = await visit(browser.page, url, new URL(url).hostname);
          if (result.issues.length) throw new ControlError(422, 'dialogue_capture_failed', result.issues.join('；'));
          const bytes = await browser.page.screenshot({type: 'png'});
          const stored = this.store.put(await EvidenceStore.webpAsync(bytes, 1280, 82, {signal}), 'webp');
          screenshot = context.addEvidence({id: `room-home-${randomUUID()}`, kind: 'image', label: '讨论首页截图',
            src: stored.src, tone: 'ok', meta: {href: browser.page.url(), role: 'identity'}});
        } finally { try { await close?.(); } finally { browserLease.release(); } }
      }
      view = {...view, images: [{role: 'identity', src: screenshot.src, evidence: screenshot.id}], homeScreenshotAvailable: true};
    }
    const lease = await this.broker.acquire(node.resource, {signal});
    if (!lease) throw new ControlError(503, 'dialogue_resource', '答疑资源暂不可用');
    const request = {kind: turn.mode, prompt: turn.prompt, input: {text: JSON.stringify(view), images: collaborationImages(view, this.store)},
      post: turn.post ? (value: Parameters<NonNullable<CollaborationTurn['post']>>[0]) => {
        if (!validSession()) throw new ControlError(409, 'stale_dialogue', '原工位已退回或结束，本次协作发言已经失效');
        return turn.post!(value);
      } : undefined, posted: Boolean(turn.existingPost), read: () => turn.posts, model: turn.model, repairReason: turn.repairReason};
    try {
      request.input.text = JSON.stringify(await collaborationPixels(view, this.store, signal));
      this.journal.atomic(() => {
        kernel.store.saveAttempt({id: attempt, item: turn.itemId, node: turn.node, startedAt, status: 'running', body: {dialogue: turn.mode}});
        this.journal.append({kind: 'attempt.started', attempt, token: turn.itemId, node: turn.node, worker: context.worker.id, input: `${turn.mode} 协作回合`});
      });
      const run = (definition: AgentStationDef, ctx: StationContext) => runStationDialogue(this.bindAgent(turn.node, definition), ctx, request);
      const installed = this.workflowPacks?.executor(node, run);
      const definition = this.stationAgents[turn.node];
      const result = installed ? await installed(context) : definition ? await run(definition, context) : undefined;
      if (!result) throw new ControlError(422, 'dialogue_definition_missing', '答疑节点没有执行契约');
      const current = validSession();
      this.journal.atomic(() => {
        if (current) kernel.saveDialogueSession(turn.itemId, turn.node, result, true);
        kernel.store.saveAttempt({id: attempt, item: turn.itemId, node: turn.node, startedAt, endedAt: Date.now(),
          status: !current ? 'cancelled' : result.handoff ? 'handoff' : result.ok ? 'ok' : 'failed', body: {dialogue: turn.mode, ...result}});
        this.journal.append({kind: 'attempt.finished', attempt, ok: current && result.ok, cancelled: !current, summary: result.summary,
          ms: Date.now() - startedAt, queuedMs: 0, usage: result.usage, metrics: result.metrics, error: result.error});
      });
      return result;
    } catch (error) {
      const partial = error as Partial<StationResult>;
      const current = validSession();
      this.journal.atomic(() => {
        if (current && partial.sessionCheckpoint) kernel.saveDialogueSession(turn.itemId, turn.node, {sessionCheckpoint: partial.sessionCheckpoint}, true);
        kernel.store.saveAttempt({id: attempt, item: turn.itemId, node: turn.node, startedAt, endedAt: Date.now(),
          status: signal.aborted || !current ? 'cancelled' : 'failed', body: {dialogue: turn.mode, error: '协作回合未完成'}});
        this.journal.append({kind: 'attempt.finished', attempt, ok: false, cancelled: signal.aborted || !current, summary: '协作回合未完成', ms: Date.now() - startedAt, queuedMs: 0});
      });
      throw error;
    } finally { lease.release(); }
  }

  private async postBoard(context: EnvContext, input: BoardPostInput) {
    if (!(this.runtime instanceof Kernel) || !this.board || !this.collaboration || !context.token) throw new ControlError(410, 'kernel_v2_required', '黑板需要 v2 内核');
    const item = this.runtime.store.get(context.token);
    if (!item) throw new ControlError(404, 'item_not_found', '没有这件货');
    if (input.type === 'question') {
      const target = input.addressee && item.nodes[input.addressee];
      if (input.addressee === context.node || target && target.status === 'waiting' && target.waitingFor === 'room' && target.pendingQuestion) {
        throw new ControlError(409, 'question_cycle', '不能向自己或正在等待答疑的节点提问，请依据现有证据判断');
      }
      if (!context.attempt || !context.toolCallId || !context.questionCheckpoint) {
        throw new ControlError(409, 'question_checkpoint_required', '提问需要当前会话与工具回执检查点');
      }
    }
    const kernel = this.runtime;
    let post!: ReturnType<BoardStore['addPost']>;
    this.journal.atomic(() => {
      post = this.board!.addPost({...input, item, author: context.node});
      if (post.type === 'question') kernel.savePendingQuestion(item.id, context.node, context.attempt!, {
        id: post.id, toolCallId: context.toolCallId!, askedBy: context.node, addressee: post.addressee!,
      }, context.questionCheckpoint!);
    });
    if (post.type !== 'question') return {id: post.id};
    const answer = () => this.collaboration!.answer(post, context.signal);
    const reply = context.waitForRoom ? await context.waitForRoom(answer) : await answer();
    return {id: post.id, answer: reply};
  }

  constructor(projectDirectory = VAR, options: {projectionOnly?: boolean} = {}) {
    const readOnly = process.env.FACTORY_READONLY === "1";
    const initializeProject = !readOnly && !options.projectionOnly;
    const directory = path.resolve(projectDirectory);
    if (initializeProject) fs.mkdirSync(directory, { recursive: true });
    const projectFallback = {name: path.basename(directory), dir: directory, pack: 'vislexicon', createdAt: ''};
    this.project = initializeProject ? ensureProject(directory, process.env.FACTORY_PROJECT_NAME ?? path.basename(directory))
      : options.projectionOnly ? {...this.readJson<ProjectInfo>(path.join(directory, 'project.json'), projectFallback), dir: directory}
      : projectFallback;
    this.journal = new Journal(path.join(this.project.dir, 'journal.db'), readOnly);
    this.store = new EvidenceStore(path.join(this.project.dir, 'evidence'), !initializeProject);
    const settingsFile = path.join(this.project.dir, 'settings.json');
    const saved = this.readJson<Partial<Settings> & { browserCapV2?: boolean }>(settingsFile, {});
    if (saved.modelWorkers === undefined) {
      // Allow independent stations to run while Pi waits for tools.
      // Persist this independently so later model quota changes keep user intent.
      saved.modelWorkers = Math.max(3, saved.model ?? 8);
      if (initializeProject) fs.writeFileSync(settingsFile, JSON.stringify(saved, null, 2));
    }
    // Browser pages were capped at three before Spec §30.6; lift old saved caps once to the new default.
    if (!saved.browserCapV2 && (saved.browser ?? 0) <= 3) delete saved.browser;
    this.settings = { browser: 8, model: 8, modelWorkers: saved.modelWorkers, cpu: 4, http: 6, memoryFloorMB: 1024, socialPerMinute: 6, socialPerDay: 300, maxActiveItems: 12, ...saved };
    if (!Number.isSafeInteger(this.settings.maxActiveItems) || this.settings.maxActiveItems < 1) {
      this.settings.maxActiveItems = 12;
    }
    this.patches = this.readJson(path.join(this.project.dir, 'patches.json'), []);
  }

  private readJson<T>(file: string, fallback: T): T { try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return fallback; } }

  /** Offline migration reads the same projection without starting any consumers. */
  async projectState() {
    await this.prepareProjection();
    return {compiled: this.compiled, state: this.state};
  }

  private async prepareProjection() {
    const started = performance.now();
    console.log('BOOT_STAGE journal 0');
    this.workflowPacks = await this.loadWorkflowPacks();
    this.compiled = compile(this.workflowPacks.packs, this.patches);
    if (this.compiled.issues.length) throw new ControlError(422, "invalid_spec", "规格校验失败，未启动运行时", this.compiled.issues);
    console.log(`BOOT_STAGE compile ${Math.round(performance.now() - started)}`);
    this.state = initialState(this.compiled);
    this.recoveryProjection = initialRecoveryProjection();
    this.docs = new Docs(this, this.project.dir, this.project.name, {deferReplay: true});
    this.lessons = new Lessons(this, this.project.dir, {deferReplay: true});
    this.channels = new ChannelSupervisor(this, {deferReplay: true});
    this.sources = new SourceSupervisor(this, {deferReplay: true});
    if (this.compiled.nodes.some(node => node.key === 'curation/gate') &&
        this.compiled.nodes.some(node => node.key === 'curation/published')) {
      this.publicationOutbox = new PublicationOutbox(this.project.dir, this.journal, {deferReplay: true});
    }
    const factoryProjection: Snapshottable = {
      snapshotName: 'factory-state',
      serialize: () => serializeSnapshot({state: this.state, recovery: this.recoveryProjection}),
      restore: body => {
        const saved = deserializeSnapshot(body);
        if (!saved || typeof saved !== 'object' || !('state' in saved) ||
            !('recovery' in saved) || !saved.recovery || typeof saved.recovery !== 'object') {
          throw new Error('Invalid factory snapshot');
        }
        const state = validateState(saved.state);
        const index = saved.recovery as RecoveryProjection;
        if (!(index.done instanceof Map) || !(index.removed instanceof Map) || !(index.notes instanceof Map) ||
            !(index.checkpointed instanceof Set) || !(index.arrivals instanceof Map) ||
            !(index.sampleTokens instanceof Set) || typeof index.run !== 'string' ||
            [...index.done.values(), ...index.removed.values()].some(value => !(value instanceof Set)) ||
            [...index.notes.values()].some(value => !(value instanceof Map)) ||
            [...index.arrivals.values()].some(value => !Array.isArray(value))) {
          throw new Error('Invalid recovery snapshot');
        }
        this.state = state;
        this.recoveryProjection = index;
      },
      observe: event => {
        apply(this.state, event);
        this.observeRecovery(event);
      },
    };
    this.snapshotComponents = [factoryProjection, this.docs, this.lessons, this.channels, this.sources,
      ...(this.publicationOutbox ? [this.publicationOutbox] : [])];
    this.projectionVersion = snapshotVersion(this.compiled.digest);
    const restored = restoreSnapshots(this.journal, this.snapshotComponents, this.projectionVersion);
    this.journal.subscribeProjection(event => {
      for (const component of this.snapshotComponents) component.observe(event);
    });
    this.snapshotSeq = restored.through;
    return restored;
  }

  /** Offline upgrade: projection only, without workers, recovery or publication. */
  async snapshot() {
    await this.prepareProjection();
    await this.writeSnapshots();
  }

  private writeSnapshots(): Promise<void> {
    if (process.env.FACTORY_READONLY === '1' || !this.snapshotComponents.length) return Promise.resolve();
    if (this.snapshotTask) return this.snapshotTask;
    this.snapshotTask = new Promise<void>((resolve, reject) => {
      const write = () => {
        if (this.journal.inTransaction) {
          setImmediate(write);
          return;
        }
        try {
          if (this.projectionVersion !== snapshotVersion(this.compiled.digest)) this.rebuildCompiledProjection();
          saveSnapshots(this.journal, this.snapshotComponents, this.projectionVersion);
          this.snapshotSeq = this.journal.seq;
          this.scheduleSnapshotTimer();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      setImmediate(write);
    }).finally(() => { this.snapshotTask = undefined; });
    return this.snapshotTask;
  }

  private startSnapshots() {
    if (process.env.FACTORY_READONLY === '1') return;
    this.snapshotsActive = true;
    this.snapshotUnsubscribe = this.journal.subscribe(() => {
      if (this.journal.seq - this.snapshotSeq >= 5000) this.backgroundSnapshot();
    });
    this.scheduleSnapshotTimer();
  }

  private backgroundSnapshot(): void {
    void this.writeSnapshots().catch(() => {
      console.warn('boot.snapshot failed');
      this.scheduleSnapshotTimer();
    });
  }

  private scheduleSnapshotTimer(): void {
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = undefined;
    if (!this.snapshotsActive) return;
    this.snapshotTimer = setTimeout(() => this.backgroundSnapshot(), 600_000);
    this.snapshotTimer.unref();
  }

  /** Call after runtime and document writers settle, before closing the journal. */
  closeSnapshots(): Promise<void> {
    if (this.snapshotClosing) return this.snapshotClosing;
    this.snapshotsActive = false;
    this.snapshotUnsubscribe?.();
    this.snapshotUnsubscribe = undefined;
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = undefined;
    this.snapshotClosing = (async () => {
      if (process.env.FACTORY_READONLY === '1' || !this.snapshotComponents.length) return;
      // An earlier background capture may finish before a final writer's queued
      // microtask. Drain it, then capture again if the journal has advanced.
      do {
        await this.writeSnapshots();
      } while (this.snapshotSeq !== this.journal.seq);
    })().finally(() => { this.snapshotClosing = undefined; });
    return this.snapshotClosing;
  }

  async boot() {
    const started = performance.now();
    this.decisionModel = projectDecisionClient(this.project.dir);
    this.externalIntake = readExternalIntake(this.project.dir);
    const restored = await this.prepareProjection();
    if (restored.fullReplay) await this.writeSnapshots();
    this.docs.start();
    this.lessons.start();
    this.startSnapshots();
    if (process.env.FACTORY_READONLY !== '1') this.project = synchronizeProjectPacks(this.project.dir, this.workflowPacks!.packs.map(entry => entry.id));
    const completedRuns = this.journal.completedRuns();
    if (!this.state.agentDefaults) {
      const selection = piSelection();
      const binding: StationAgentBinding = {adapter: 'pi', provider: selection.provider, model: selection.id};
      const defaults = {station: {...binding}, dispatcher: {...binding}};
      if (process.env.FACTORY_READONLY === '1') this.state.agentDefaults = defaults;
      else this.journal.append({kind: 'agent.defaults', defaults});
    }
    if (process.env.FACTORY_READONLY !== "1" && this.state.digest !== this.compiled.digest) this.journal.append({ kind: "factory.loaded", digest: this.compiled.digest, specVersion: this.compiled.specVersion });
    this.broker = new Broker({ browser: this.settings.browser, model: this.settings.model, modelWorkers: this.settings.modelWorkers, cpu: this.settings.cpu, http: this.settings.http }, this.settings.memoryFloorMB);
    this.toolbox = new Toolbox({journal: this.journal, broker: this.broker, docs: () => this.docs,
      ...(this.kernel === 'v2' ? {board: {
        read: (context: EnvContext, options: {field?: string; openOnly?: boolean}) => this.board?.read(context.token ?? '', options) ?? [],
        post: (context: EnvContext, input: BoardPostInput) => this.postBoard(context, input),
      }} : {})});
    const services: Services = {
      store: this.store, workDir: path.join(this.project.dir, 'work'), publishDir: path.join(this.project.dir, 'published'),
      tryBrowser:()=>this.broker.tryAcquire("browser"),
      acquireBrowser:(signal,timeoutMs)=>this.broker.acquire("browser",{signal,timeoutMs}),
      inFlight: (self) => new Set([...this.runtime.tokens.values()].filter((t) => !t.finished && t.id !== self && t.data.key).map((t) => String(t.data.key))),
    };
    this.services = services;
    const defs = agentDefs(this.store, services);
    this.stationAgents = defs;
    const scoped = (execute: Executor): Executor => context => withDecisionAttempt(this.decisionModel, context, () => withNetworkCache(
      process.env.FACTORY_HTTP_CACHE === '0' ? null : projectPaths(this.project.dir).cache,
      async () => await reuseExternalCapture(context, this.store) ?? reuseExternalStation(context, execute)));
    const executors = (n: CompiledNode): Executor | ExecutorRegistration | null => {
      const installed = this.workflowPacks?.executor(n);
      if (installed) {
        const declared = this.agentDefault(n.key);
        if (!declared) return scoped(installed);
        return {
          prepare: () => {
            const captured = this.captureAgent(n.key, declared.binding);
            return {
              dependency: captured.dependency,
              execute: scoped(this.workflowPacks!.executor(n, (definition, context) =>
                runAgentStation({...definition, services: this.stationServices(), agent: captured.binding,
                  piRuntime: captured.piRuntime, piControl: captured.piControl}, context))!),
            };
          },
        };
      }
      if (n.tool && TOOLS[n.tool]) {
        const execute: Executor = scoped(ctx => TOOLS[n.tool!](ctx, services));
        if (!['curation.breadth', 'curation.proof'].includes(n.tool)) return execute;
        return {prepare: () => {
          try {
            const captured = this.captureAgent(n.key);
            const modelAssist = {binding: captured.binding, projectDirectory: this.project.dir,
              piRuntime: captured.piRuntime, piControl: captured.piControl};
            return {execute: ctx => execute({...ctx, piRuntime: captured.piRuntime, modelAssist}),
              dependency: captured.dependency};
          }
          catch (error) {
            return {execute: ctx => execute(Object.defineProperties({...ctx}, {
              piRuntime: {get: () => { throw error; }},
              modelAssist: {get: () => { throw error; }},
            }))};
          }
        }};
      }
      const def = defs[n.key];
      if (!def) return null;
      return {
        prepare: () => {
          try {
            const captured = this.captureAgent(n.key, def.agent);
            return {
              dependency: captured.dependency,
              execute: scoped(context => runAgentStation({...def, services: this.stationServices(), agent: captured.binding,
                piRuntime: captured.piRuntime, piControl: captured.piControl}, context)),
            };
          } catch (error) {
            // Deterministic rules still run without a configured model. If a
            // model is needed, preserve this attempt's original capture error.
            return {execute: scoped(async context => {
              context.signal.throwIfAborted();
              const skipped = await def.skip?.(context);
              if (skipped) return skipped;
              throw error;
            })};
          }
        },
      };
    };
    this.runtime = this.createRuntime(this.compiled, this.workflowPacks!.conditions, executors);
    this.runtime.roleResolver = key => this.workflowPacks?.role(key) ?? readRole(key);
    this.modelCircuits = new ModelCircuits(this);
    this.batch = new BatchSupervisor(this);
    this.recovery = new UnmanagedRecoverySupervisor(this);
    this.runtime.onTick = () => this.maintainRuntime();
    this.wireRecovery();
    if (process.env.FACTORY_READONLY === "1") {
      if (this.runtime instanceof Kernel) this.runtime.recover(this.state);
      this.catalog = this.runtime.nodes.has('candidates/pool') ? loadCatalog() : [];
      if (this.kernel === 'v1') this.channels!.start();
      this.sources.start();
      console.log(`BOOT_STAGE factory ${Math.round(performance.now() - started)}`);
      return;
    }
    this.wireStock();
    this.wireDocs();
    try { this.lessons.recoverApproved(); } catch (error) { this.lessonIssue(error); }
    for (const run of completedRuns) { try { this.lessons.draftRun(run); } catch (error) { this.lessonIssue(error); } }
    try { this.lessons.write(); } catch (error) { this.lessonIssue(error); }
    if (this.runtime.nodes.has('curation/style')) void warmStyleLib();
    this.loadStock();
    if (this.kernel === 'v1') this.recoverLegacyFailures();
    for(const c of Object.values(this.state.recoveries))if(this.kernel === 'v1' && c.failure?.tag==="tool_error") {
      const failure=classifyFailure(c.failure.message,{url:c.url});
      if(failure.tag!=="tool_error")this.journal.append({kind:"candidate.disposition",candidate:{...c,failure}});
    }
    this.reconcileFailureAlerts();
    if (this.kernel === 'v1') {
      this.batch.restoreModelCircuit();
      this.broker.modelHold = Object.values(this.state.alerts).find(a => a.kind === 'model' && !a.dependency)?.message ?? null;
    }
    this.restore();
    if (this.kernel === 'v1') this.modelCircuits.restore();
    this.reconcileManualStock();
    this.reconcileBusinessStock();
    if (this.kernel === 'v1') this.channels!.start();
    this.publicationOutbox?.start();
    if (this.kernel === 'v1') this.recovery.start();
    this.sources.start();
    this.runtime.tick();
    if (this.kernel === 'v1') this.batch.schedule();
    console.log(`BOOT_STAGE factory ${Math.round(performance.now() - started)}`);
  }

  /* -------------------------------------------------------------- stock (候选层 / 已发布) */

  private loadStock() {
    if (!this.runtime.nodes.has('candidates/pool')) {
      for (const [key, node] of Object.entries(this.state.nodes)) if (this.runtime.nodes.has(key)) this.runtime.stock.set(key, node.stock);
      return;
    }
    this.catalog = loadCatalog();
    if (this.externalIntake) {
      const present = new Set(this.catalog.map(candidate => candidate.id));
      for (const candidate of this.externalIntake.candidates) {
        if (candidate.disposition !== 'continue' || present.has(candidate.entryId)) continue;
        this.catalog.push({id: candidate.entryId, name: candidate.title, canonicalUrl: candidate.url});
        present.add(candidate.entryId);
      }
    }
    const external = new Map(this.externalIntake?.candidates.map(candidate => [candidate.entryId, candidate]));
    const publishedHosts = new Set(loadPublished().map((p) => p.domain.replace(/^www\./, "")));
    for (const t of Object.values(this.state.tokens)) if (t.source === "candidates/pool") this.taken.add(t.item);
    const left = this.catalog.filter((c) => !this.taken.has(c.id) &&
      (external.has(c.id) ? external.get(c.id)!.disposition === 'continue' : !publishedHosts.has(this.hostOf(c.canonicalUrl))));
    const pool = "candidates/pool";
    const localPublished = fs.existsSync(path.join(this.project.dir, 'published')) ? fs.readdirSync(path.join(this.project.dir, 'published'), { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.json')).length : 0;
    const deferred=Object.values(this.state.recoveries).filter(c=>c.disposition==="retry").length;
    const publishedIds = new Set(loadPublished().map(entry => entry.entryId));
    const externalPublished = this.externalIntake?.candidates.filter(candidate =>
      candidate.disposition === 'published' && !publishedIds.has(candidate.entryId)).length ?? 0;
    const want: Record<string, number> = { [pool]: left.length+deferred, "curation/published": publishedHosts.size + localPublished + externalPublished };
    for (const [node, stock] of Object.entries(want)) {
      this.runtime.stock.set(node, stock);
      if (this.state.nodes[node]?.stock !== stock) this.journal.append({ kind: "stock.set", node, stock, note: node === pool ? "VisLexicon 候选目录（去掉已发布、已取走）" : "VisLexicon 已发布 + 本工厂发布" });
    }
    for (const [k, n] of Object.entries(this.state.nodes)) if (!this.runtime.stock.has(k) && n.stock) this.runtime.stock.set(k, n.stock);
  }

  private hostOf(u: string) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } }

  private loadWorkflowPacks() {
    return loadWorkflowPacks(this.project.dir, { builtins: [pack], services: {
      journal: this.journal,
      runAgent: (definition, context) => runAgentStation(this.bindAgent(context.node.key, definition), context),
      callCapability: (name, args, context) => this.toolbox.call([name], name, args, { node: context.node.key, token: context.token.id, caseId: context.token.item, signal: context.signal, progress: context.progress }),
    } });
  }

  async reloadWorkflowPacks() {
    if (this.runtime.running || this.runtime.paused || this.runtime.ending || [...this.runtime.workers.values()].some(pool => pool.some(worker => worker.busy))) throw new ControlError(409, 'run_active', '请先结束本轮并等待在途工人退出，再加载流水线包');
    const loaded = await this.loadWorkflowPacks();
    const compiled = compile(loaded.packs, this.patches);
    if (compiled.issues.length) throw new ControlError(422, 'invalid_spec', '已安装流水线包未通过编译', compiled.issues);
    const previous = this.runtime;
    previous.dispose();
    for (const pool of previous.workers.values()) for (const worker of pool) this.journal.append({ kind: 'worker.retired', node: worker.node, worker: worker.id, reason: '流水线包更新，按新规格配员' });
    this.workflowPacks = loaded; this.compiled = compiled;
    this.project = synchronizeProjectPacks(this.project.dir, loaded.packs.map(entry => entry.id));
    this.rebuildCompiledProjection();
    this.runtime = this.createRuntime(compiled, loaded.conditions, previous.executors);
    this.runtime.roleResolver = key => loaded.role(key) ?? readRole(key);
    this.runtime.onTick = () => this.maintainRuntime();
    this.wireRecovery(); this.restore(); this.loadStock(); this.reconcileManualStock(); this.runtime.tick();
    this.journal.append({ kind: 'factory.loaded', digest: compiled.digest, specVersion: compiled.specVersion });
    this.lastPreflight = 0;
    return { digest: compiled.digest, packs: loaded.manifests, lines: compiled.lines };
  }

  private bindAgent(node: string, definition: AgentStationDef): AgentStationDef {
    const captured = this.captureAgent(node, definition.agent);
    return {...definition, services: this.stationServices(), agent: captured.binding,
      piRuntime: captured.piRuntime, piControl: captured.piControl};
  }

  private stationServices() {
    return {docs: () => this.docs, toolbox: () => this.toolbox, journal: this.journal,
      activeLessons: (node: string) => this.lessons.activeFor(node)};
  }

  continueAgentBudget(item: string, node: string) {
    if (!(this.runtime instanceof Kernel)) throw new ControlError(410, 'kernel_v2_required', '预算交接由 v2 内核处理');
    return this.runtime.continueBudget(item, node);
  }

  streamSnapshot() {
    if (!(this.runtime instanceof Kernel)) throw new ControlError(410, 'kernel_v2_required', '三流统计需要 v2 内核');
    return {kernel: 'v2' as const, ...kernelStreams(this.runtime.store, {now: Date.now(), runId: this.journal.run,
      alerts: this.state.alerts, patches: this.state.patches, nodeKeys: this.compiled.nodes.map(node => node.key)})};
  }

  streamEvents(since: number, includeProgress: boolean) {
    if (!(this.runtime instanceof Kernel)) throw new ControlError(410, 'kernel_v2_required', '三流记录需要 v2 内核');
    if (!Number.isSafeInteger(since) || since < 0) throw new ControlError(400, 'invalid_cursor', 'since 必须是非负整数');
    const conversation = "((kind = 'board.posted' AND json_extract(body, '$.post.type') != 'claim') OR kind LIKE 'room.%' OR kind LIKE 'chat.%' OR kind = 'supervisor.summary')";
    const progress = "kind IN ('attempt.started', 'attempt.progress', 'attempt.activity', 'attempt.finished', 'token.queued', 'token.data', 'token.created', 'evidence.added', 'resource.sample')";
    type Row = {seq: number; at: number; run: string; body: string};
    const read = (where: string, order: 'ASC' | 'DESC', limit: number) => this.journal.database.prepare(
      `SELECT seq, at, run, body FROM events WHERE seq > ? AND (${where}) ORDER BY seq ${order} LIMIT ?`
    ).all(since, limit) as Row[];
    const rows = since === 0
      ? [...read(conversation, 'DESC', 500), ...(includeProgress ? read(progress, 'DESC', 500) : [])].sort((a, b) => a.seq - b.seq)
      : read(includeProgress ? `${conversation} OR ${progress}` : conversation, 'ASC', 501);
    const hasMore = since > 0 && rows.length > 500;
    const selected = hasMore ? rows.slice(0, 500) : rows;
    return {events: selected.map(row => ({...JSON.parse(row.body), seq: row.seq, at: row.at, run: row.run}) as Stamped),
      seq: hasMore ? selected.at(-1)!.seq : this.journal.seq, hasMore};
  }

  private captureAgent(node: string, declared?: StationAgentBinding) {
    const binding = this.resolveAgentBinding(this.state.agentBindings?.[node] ?? declared ?? this.defaultAgentBinding());
    if (binding.adapter === 'pi') {
      const piRuntime = models(binding);
      return {
        binding: {adapter: 'pi' as const, provider: piRuntime.model.provider, model: piRuntime.model.id},
        piRuntime, dependency: piRuntime.dependency,
        piControl: {
          resolve: (current: ReturnType<typeof models>) => {
            const next = this.resolveAgentBinding(this.state.agentBindings?.[node] ?? declared ?? this.defaultAgentBinding());
            // A different harness needs its own process and starts on the next attempt.
            if (next.adapter !== 'pi' || next.provider === current.model.provider && next.model === current.model.id) return current;
            return models(next);
          },
          list: piModelCatalog,
          select: (selection: {provider: string; model: string}) => {
            const current = this.resolveAgentBinding(this.state.agentBindings?.[node] ?? declared ?? this.defaultAgentBinding());
            if (current.adapter !== 'pi') throw new ControlError(409, 'agent_binding_changed', '用户已为本节点选择其他运行底座；不能覆盖该配置');
            if (!piModelCatalog().some(option => option.provider === selection.provider && option.model === selection.model)) {
              throw new ControlError(422, 'model_not_connected', '只能选择本机已接入 Pi 供应商目录中的模型');
            }
            this.setAgentBinding(node, {adapter: 'pi', ...selection});
          },
        },
      };
    }
    const captured = binding.command ? {...binding, command: [...binding.command]}
      : {...binding, command: resolveNativeCommand(binding.adapter as 'claude-code' | 'opencode' | 'codex')};
    return {binding: captured, piRuntime: undefined, piControl: undefined, dependency: closedModelDependency(captured)};
  }

  private agentDefault(node: string): {binding?: StationAgentBinding; mode?: 'model-assist'} | undefined {
    const installed = this.workflowPacks?.manifests.find(manifest => manifest.bindings[node]);
    const execution = installed?.bindings[node].execute;
    if (execution) return execution.kind === 'agent' ? {binding: execution.agent} : undefined;
    const definition = this.stationAgents[node];
    const tool = this.compiled.nodes.find(current => current.key === node)?.tool;
    if (tool && ['curation.breadth', 'curation.proof'].includes(tool)) return {mode: 'model-assist'};
    return definition ? {binding: definition.agent} : undefined;
  }

  private defaultAgentBinding(): StationAgentBinding {
    return this.getAgentDefaults().station;
  }

  getStationAgentBinding(node: string): StationAgentBinding | null {
    const declared = this.agentDefault(node);
    if (!declared) return null;
    return this.resolveAgentBinding(this.state.agentBindings?.[node] ?? declared.binding ?? this.defaultAgentBinding());
  }

  private resolveAgentBinding(input: StationAgentBinding): StationAgentBinding {
    const binding = parseAgentBinding(input);
    if (binding.adapter !== 'pi') return binding;
    if (binding.provider && binding.model) return binding;
    const defaults = this.getAgentDefaults();
    const fallback = defaults.station.adapter === 'pi' ? defaults.station : defaults.dispatcher;
    if (fallback.adapter !== 'pi') throw new ControlError(422, 'explicit_pi_selection_required', '请为 Pi 工位配置明确的供应商和模型');
    return {...binding, provider: binding.provider ?? fallback.provider, model: binding.model ?? fallback.model};
  }

  getAgentDefaults(): ProjectAgentDefaults {
    if (!this.state.agentDefaults) throw new ControlError(409, 'project_not_ready', '项目模型选择尚未初始化');
    return structuredClone(this.state.agentDefaults);
  }

  dispatcherModelStatus() {
    const binding = this.getAgentDefaults().dispatcher;
    if (binding.adapter === 'pi') return {adapter: 'pi' as const, ...piStatus(binding)};
    return {
      adapter: binding.adapter,
      provider: 'provider' in binding ? binding.provider : undefined,
      id: binding.model ?? 'native-default',
      name: binding.model ?? `${binding.adapter} 客户端默认模型`,
      source: 'explicit' as const,
      ready: false,
      error: null,
      verification: 'client-managed' as const,
    };
  }

  setAgentDefaults(update: {station?: StationAgentBinding; dispatcher?: StationAgentBinding}): ProjectAgentDefaults {
    if (process.env.FACTORY_READONLY === '1') throw new ControlError(403, 'read_only', '只读项目不能配置 Agent');
    const defaults = this.getAgentDefaults();
    for (const key of ['station', 'dispatcher'] as const) {
      if (!update[key]) continue;
      let binding = parseAgentBinding(update[key]);
      if (binding.adapter === 'pi') {
        const prior = defaults[key].adapter === 'pi' ? defaults[key] : undefined;
        binding = {...binding, provider: binding.provider ?? prior?.provider, model: binding.model ?? prior?.model};
        if (!binding.provider || !binding.model) throw new ControlError(422, 'explicit_pi_selection_required', '请选择这个项目明确使用的 Pi 供应商和模型');
      }
      defaults[key] = binding;
    }
    if (JSON.stringify(defaults) !== JSON.stringify(this.state.agentDefaults)) {
      this.journal.append({kind: 'agent.defaults', defaults});
      this.lastPreflight = 0;
      if (update.station) {
        for (const node of this.compiled.nodes) if (this.agentDefault(node.key)) this.recovery?.bindingChanged(node.key);
        this.runtime.tick();
      }
    }
    return this.getAgentDefaults();
  }

  agentBindings(node?: string) {
    if (node && !this.runtime.nodes.has(node)) {
      throw new ControlError(404, 'node_not_found', '工位不存在');
    }
    const bindings = [];
    const latestModels = new Map<string, {at: number; model: string}>();
    for (const attempt of Object.values(this.state.attempts)) {
      const execution = attempt.metrics?.execution ?? attempt.metrics?.modelResponses?.at(-1);
      if (execution && (!node || attempt.node === node) &&
          attempt.startedAt >= (latestModels.get(attempt.node)?.at ?? 0)) {
        latestModels.set(attempt.node, {at: attempt.startedAt, model: execution.model});
      }
    }
    for (const current of this.compiled.nodes) {
      if (node && current.key !== node) continue;
      const declared = this.agentDefault(current.key);
      if (!declared) continue;
      const configured = this.state.agentBindings?.[current.key] ?? null;
      const source = configured ? 'project' as const : declared.binding ? 'workflow' as const : 'default' as const;
      let effective: StationAgentBinding | null = null;
      let error: string | undefined;
      try {
        const requested = this.resolveAgentBinding(configured ?? declared.binding ?? this.defaultAgentBinding());
        if (requested.adapter === 'pi') {
          const selection = piSelection(requested);
          effective = {adapter: 'pi', provider: selection.provider, model: selection.id};
        } else {
          effective = {...requested, requestTimeoutMs: requested.requestTimeoutMs ?? 180000};
        }
      } catch (reason) {
        error = reason instanceof Error ? reason.message : 'Agent 配置无效';
      }
      bindings.push({
        node: current.key, configured, effective, source, error,
        mode: declared.mode ?? 'agent',
        capabilities: effective ? {...agentCapabilities(effective),
          ...(declared.mode === 'model-assist' ? {resume: false} : {})}
          : {stream: false, cancel: false, resume: false, usage: 'unknown' as const},
        lastModel: latestModels.get(current.key)?.model,
      });
    }
    return {bindings, piModels: piModelCatalog()};
  }

  setAgentBinding(node: string, input: unknown) {
    if (process.env.FACTORY_READONLY === '1') throw new ControlError(403, 'read_only', '只读项目不能配置工位 Agent');
    if (!this.runtime.nodes.has(node)) throw new ControlError(404, 'node_not_found', '工位不存在');
    if (!this.agentDefault(node)) throw new ControlError(422, 'not_agent_station', '这个工位使用程序执行器，不支持 Agent 绑定');
    const binding = input === null ? null : parseAgentBinding(input);
    if (JSON.stringify(binding) !== JSON.stringify(this.state.agentBindings?.[node] ?? null)) {
      this.journal.append({kind: 'agent.binding', node, binding});
      this.lastPreflight = 0;
      this.recovery?.bindingChanged(node);
      this.runtime.tick();
    }
    return this.agentBindings(node);
  }

  private maintainRuntime() {
    if (this.kernel === 'v1') { this.resumeVerifiedCandidates(); this.batch.pump(); }
    if (this.compiled.lines.some(line => line.id === 'atlas-feed' && line.wired)) flushAtlas(this.services);
    this.reconcileBusinessStock();
  }

  private reconcileBusinessStock() {
    for (const line of this.compiled.lines.filter(line => !['sources', 'candidates', 'curation'].includes(line.id))) {
      const node = `${line.id}/published`;
      if (this.runtime.nodes.get(node)?.kind !== 'store') continue;
      const directory = path.join(this.project.dir, 'published', 'business', line.id);
      const stock = fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.json') && !['index.json', 'atlas.json'].includes(entry.name)).length : 0;
      if (!fs.existsSync(directory)) continue;
      this.runtime.stock.set(node, stock);
      if (this.state.nodes[node]?.stock !== stock) this.journal.append({ kind: 'stock.set', node, stock, note: '按当前业务发布文件校准库存，不混入网站发布计数' });
    }
  }

  private stockReconcileScheduled = false;
  private wireStock() {
    this.journal.subscribe(event => {
      if (!['token.finished', 'token.returned', 'candidate.disposition'].includes(event.kind) && !(event.kind === 'token.data' && event.patch.retriedBy)) return;
      if (this.stockReconcileScheduled) return;
      this.stockReconcileScheduled = true;
      queueMicrotask(() => { this.stockReconcileScheduled = false; this.reconcileManualStock(); });
    });
  }

  /** Manual stock is a current queue, while `plus` remains its historical arrivals.
   * Older migrations moved failures to recovery without removing this inventory. */
  reconcileManualStock() {
    const latest = new Map<string, FactoryState['tokens'][string]>();
    for (const id of this.state.tokenOrder) {
      const token = this.state.tokens[id];
      if (!token || typeof token.data.retriedBy === 'string' && this.state.tokens[token.data.retriedBy]?.item === token.item) continue;
      const key = tokenWorkKey(token), previous = latest.get(key);
      if (!previous || (token.touchedAt ?? token.createdAt) >= (previous.touchedAt ?? previous.createdAt)) latest.set(key, token);
    }
    for (const node of this.compiled.nodes.filter(node => node.kind === 'store' && node.key.endsWith('/manual'))) {
      const stock = [...latest.values()].filter(token => token.status === 'manual' && token.finishedAtNode === node.key).length;
      this.runtime.stock.set(node.key, stock);
      if (this.state.nodes[node.key]?.stock !== stock) this.journal.append({ kind: 'stock.set', node: node.key, stock, note: '按当前未解决任务校准待人工库存；历史到达与处置记录保留' });
    }
  }

  /* -------------------------------------------------------------- documents, alerts, preflight (Spec §30–§31) */

  private wireDocs() {
    this.journal.subscribe((e) => {
      if (e.kind === 'token.finished') queueMicrotask(() => this.resumeVerifiedCandidates());
      const a = e.kind === "attempt.finished" || e.kind === "attempt.started" || e.kind === "attempt.progress" ? this.state.attempts[e.attempt] : undefined;
      if (a) { if (e.kind !== "attempt.progress") this.docs.schedule("context", a.node); const t = this.state.tokens[a.token]; if (t) this.docs.schedule("case", t.item); }
      else if (e.kind === "case.noted") this.docs.schedule("case", e.caseId);
      else if (e.kind === "context.noted") this.docs.schedule("context", e.node);
      else if (e.kind === "report.ready") queueMicrotask(() => { try { this.lessons.draftRun(e.runId); } catch (error) { this.lessonIssue(error); } });
      else if (e.kind === "run.started" || e.kind === "run.paused" || e.kind === "run.resumed" || e.kind === "run.ended") {
        if (e.kind === 'run.resumed') queueMicrotask(() => this.resumeVerifiedCandidates());
        // Delay journal reads and disk work until the batch timer/flush, including
        // records that have notes but no token.created event (legacy tool calls).
        this.docs.scheduleAllCases();
      }
      else if (e.kind === "candidate.disposition") this.docs.schedule("case", e.candidate.item);
      else if (e.kind === "evidence.added") { const t = this.state.tokens[e.evidence.token]; if (t) this.docs.schedule("case", t.item); }
      else if (e.kind === "token.created" || e.kind === "token.queued" || e.kind === "token.data" || e.kind === "token.returned" || e.kind === "token.finished" || e.kind === "review.verdict" || e.kind === "correction.created" || e.kind === "consult.opened" || e.kind === "consult.replied" || e.kind === "consult.closed") { const t = this.state.tokens[e.token]; if (t) this.docs.schedule("case", t.item); }
    });
    try { this.docs.writeAllContexts(); } catch (err) { console.warn("contexts", (err as Error).message); }
    this.docs.scheduleAllCases();
  }

  /** Bind the whole rerun before Runtime's queued microtask may start a worker. */
  async startLessonValidation(id: string, options: { digest: string; regressionItems: string[] }) {
    if (this.runtime.running || this.runtime.ending) throw new ControlError(409, "run_active", "先结束当前轮次，再启动经验验证");
    const intake = this.compiled.nodes.find(node => node.key === "candidates/tidy");
    if (!intake || !this.runtime.runnable(intake)) throw new ControlError(409, "intake_unavailable", "候选准备工位当前不可执行，无法开始经验验证");
    const trial = this.lessons.beginValidation(id, options);
    this.runtime.start(`经验验证 ${id}`);
    const samples = [...trial.failures, ...trial.regressions];
    try {
      const tokens = samples.map(sample => this.runtime.create("candidates/tidy", {
        item: sample.item, url: sample.url, source: "manual",
        data: { express: true, rerunPublished: true },
      }));
      this.lessons.bindValidation(trial.id, tokens.map(token => token.id));
      return { trial, runId: this.state.run.id, tokens: tokens.map(token => ({ id: token.id, item: token.item })) };
    } catch (error) {
      // Stop synchronously, before the queued worker microtask can see unbound tasks.
      this.runtime.pause();
      const { endRun } = await import("./report.ts");
      await endRun(this);
      throw error;
    }
  }

  private lessonIssue(error: unknown) {
    this.journal.append({ kind: "context.noted", node: "dispatcher", note: { kind: "issue", by: "system", text: `复盘文档需要修复，原文已保留：${String((error as Error)?.message ?? error).slice(0, 500)}` } });
  }

  raiseAlert(alert: Alert) {
    if (alert.kind === 'model' && !alert.dependency) this.broker.modelHold = alert.message;
    if (this.state.alerts?.[alert.id]) return;
    this.journal.append({ kind: "alert.raised", alert });
    if (alert.kind === 'model' && !alert.dependency) this.broker.modelHold = alert.message;
  }

  clearAlert(id: string, reason: string) {
    const a = this.state.alerts?.[id];
    if (!a) return false;
    this.journal.append({ kind: "alert.cleared", id, reason });
    if (a.kind === 'model' && !Object.values(this.state.alerts ?? {}).some(x => x.kind === 'model' && !x.dependency)) { this.broker.modelHold = null; this.runtime.schedule(); }
    return true;
  }

  /** Old versions labeled every owner-facing problem as login. Keep the audit trail,
   * but make the live action list reflect the failure that actually occurred. */
  reconcileFailureAlerts() {
    for (const candidate of Object.values(this.state.recoveries)) {
      const old = candidate.failure;
      if (!old || !['auth_required', 'network_connection', 'network_timeout', 'tool_error'].includes(old.tag)) continue;
      const token = this.state.tokens[candidate.token];
      const attempt = token?.attempts.map(id => this.state.attempts[id]).reverse().find(a => a && !a.ok && !a.cancelled);
      // Use the operation recorded at the failing boundary. Being an Agent node
      // alone is insufficient: its tools can also encounter real site failures.
      const model = attempt && /模型(?:调用|重答)失败/.test(attempt.summary ?? '');
      const classified = classifyFailure(old.message, { url: model ? undefined : old.url ?? candidate.url, status: old.status, stage: model ? 'model' : undefined });
      if (classified.tag !== old.tag || classified.owner !== old.owner) {
        const failure = { ...old, ...classified };
        this.journal.append({ kind: 'candidate.disposition', candidate: { ...candidate, failure } });
        this.journal.append({ kind: 'token.data', token: candidate.token, patch: { failure, ...(failure.tag === 'model_transport' ? {batchRecovery:null} : {}) } });
        if (failure.tag === 'model_transport' && latestRunTokens(this.state).some(t => t.id === candidate.token) && candidate.disposition === 'retry') {
          this.raiseAlert({ id: 'model-transport', kind: 'model', level: 'red', message: '此前模型连接故障，已保留检查点；恢复前先验证一个真实工位', nextAction: failure.nextAction });
          this.batch.modelFailed();
        }
      }
    }
    for (const alert of Object.values(this.state.alerts)) {
      const candidate = this.recoveryForAlert(alert);
      if (alert.kind === 'auth' && candidate && (candidate.disposition !== 'retry' || candidate.failure?.tag !== 'auth_required')) {
        this.clearAlert(alert.id, '按实际失败原因重新核对：这不是需要用户登录的任务');
      }
    }
  }

  private recoveryForAlert(alert: Alert): CandidateRecovery | undefined {
    if (alert.token) {
      const token = this.state.tokens[alert.token];
      const candidate = token && this.state.recoveries[recoveryKey(token)];
      return candidate?.token === alert.token ? candidate : undefined;
    }
    if (!alert.item) return;
    const matches = this.candidateFailures().filter(candidate => candidate.item === alert.item);
    return matches.length === 1 ? matches[0] : undefined;
  }

  async recheckAlert(id: string) {
    const alert = this.state.alerts[id];
    if (!alert) throw new ControlError(404, 'alert_not_found', '该提醒已经解除');
    if (alert.kind === 'auth') {
      const sameSite = (url: string) => { try { const host = new URL(alert.url ?? '').hostname.replace(/^www\./, ''); const actual = new URL(url).hostname.replace(/^www\./, ''); return !!host && (actual === host || actual.endsWith('.' + host)); } catch { return false; } };
      let browser = await browserCommand({ action: 'state' }) as BrowserState;
      const matches = browser.tabs.filter(tab => (!alert.tab || tab.id === alert.tab) && sameSite(tab.url));
      if (!matches.length) return { cleared: false, resumed: false, message: '原验证页面已关闭，尚无成功访问的证据；请打开对应页面后重新检查' };
      for (const tab of matches) browser = await browserCommand({ action: 'attention.check', id: tab.id }) as BrowserState;
      const checked = browser.tabs.filter(tab => sameSite(tab.url) && matches.some(original => original.id === tab.id));
      if (!checked.length || checked.some(tab => tab.loading || tab.attention || !/^https?:/.test(tab.url))) return { cleared: false, resumed: false, message: '页面仍有访问限制或仍在加载，已保留现场与检查点' };
      const candidate = this.recoveryForAlert(alert);
      if (candidate?.disposition === 'retry') this.journal.append({ kind: 'token.data', token: candidate.token, patch: { accessVerified: { at: Date.now(), tab: checked[0].id, url: checked[0].url } } });
      this.clearAlert(id, '共享浏览器重新检查确认页面可访问，已保存恢复标记');
      if (this.runtime.paused) return { cleared: true, resumed: false, message: '页面可访问；已保存恢复标记，继续本轮后将从检查点恢复' };
      if (this.state.batch?.runId === this.state.run.id && this.state.batch.mode !== 'running') return { cleared: true, resumed: false, message: '页面可访问；托管已停止，恢复任务后再继续此条目' };
      if (!this.runtime.running) await this.ensureReady();
      const tasks = this.resumeVerifiedCandidates();
      const resumed = tasks.some(token => token.data.retryOf === candidate?.token);
      return { cleared: true, resumed, message: resumed ? '访问已恢复，已从失败工位继续' : candidate?.disposition === 'retry' ? '访问已恢复，已排入恢复队列；在途任务腾出空位后自动继续' : '访问已恢复，该任务已不在待重试队列' };
    }
    if (alert.kind === 'model' || alert.kind === 'preflight') {
      let checked = false;
      try { checked = (await this.ensureReady(true))?.ok === true; }
      catch { /* Preserve the concrete preflight result. */ }
      const cleared = !this.state.alerts[id];
      if (id === 'model-transport' && !cleared && checked) return {
        cleared: false, resumed: false,
        message: this.runtime.paused ? '连接体检通过；本轮仍暂停，恢复计划与检查点保留'
          : '连接体检通过；仍需原工位的真实模型响应才能解除暂停，请查看任务的恢复状态',
      };
      return { cleared, resumed: false, message: cleared ? '体检已通过，提醒已解除' : '体检仍未通过，请查看当前检测结果' };
    }
    return { cleared: false, resumed: false, message: alert.nextAction ?? '问题尚未有修复证据，提醒保持' };
  }

  /** Verification walls go to the owner: red light, page kept in the built-in browser.
   *  Once that page loads normally again (the owner passed the check), continue the
   *  candidate from its failed station instead of waiting for a manual retry. */
  private walled = new Set<string>();
  private resuming = false;
  resumeVerifiedCandidates() {
    if (!this.runtime.running || this.runtime.paused || this.runtime.ending) return [];
    if (this.state.batch?.runId === this.state.run.id && this.state.batch.mode !== 'running') return [];
    const tokens = this.candidateFailures({ disposition: 'retry' }).filter(candidate => candidate.failure?.tag === 'auth_required' && this.state.tokens[candidate.token]?.data.accessVerified).map(candidate => candidate.token);
    const goal = this.state.batch?.runId === this.state.run.id ? this.state.batch : undefined;
    const slots = goal ? Math.max(0, goal.maxInFlight - [...this.runtime.tokens.values()].filter(token => !token.finished).length) : 12;
    return tokens.length && slots ? this.retryCandidates({ tokens, count: Math.min(tokens.length, slots) }) : [];
  }
  async resumeVerified(browser: BrowserState) {
    const alerts = Object.values(this.state.alerts ?? {}).filter((a) => a.kind === "auth" && a.item && (a.url || a.tab));
    if (!alerts.length) { this.walled.clear(); return; }
    if (this.resuming) return;
    const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
    for (const a of alerts) {
      const tabs = browser.tabs.filter((t) => (!a.tab || t.id === a.tab) && a.url && hostOf(t.url) === hostOf(a.url));
      if (tabs.some((t) => t.attention)) { this.walled.add(a.id); continue; }
      if (!this.walled.has(a.id) || !tabs.some((t) => !t.loading)) continue;
      if (this.runtime.paused || this.state.batch?.runId === this.state.run.id && this.state.batch.mode !== 'running') continue;
      this.walled.delete(a.id);
      this.resuming = true;
      try {
        if (!this.runtime.running) await this.ensureReady();
        const candidate = this.recoveryForAlert(a);
        if (candidate?.disposition === 'retry') {
          this.journal.append({ kind: 'token.data', token: candidate.token, patch: { accessVerified: { at: Date.now(), tab: tabs[0].id, url: tabs[0].url } } });
          this.clearAlert(a.id, '内置浏览器里的验证已通过，已排入恢复队列');
          if (this.resumeVerifiedCandidates().some(token => token.data.retryOf === candidate.token)) this.journal.append({ kind: "dispatch.note", node: a.node, tone: "info", text: `${a.item}：内置浏览器里的验证已通过，自动从失败工位继续` });
        }
      } catch { /* Paused, preflight failed or no longer waiting: the red light and manual retry remain. */ }
      finally { this.resuming = false; }
    }
  }

  private lastPreflight = 0;
  private lastPreflightSignature = '';
  /** Runs the health check before a run starts or resumes; throws with the failed items. */
  async ensureReady(force = false) {
    if (process.env.FACTORY_PREFLIGHT === "0" || process.env.FACTORY_READONLY === "1") return null;
    const runnable = this.compiled.nodes.filter(node => this.runtime.runnable(node) && !this.runtime.scopePaused(node.key));
    const executions = (this.workflowPacks?.manifests ?? []).flatMap(manifest => Object.entries(manifest.bindings).filter(([key]) => runnable.some(node => node.key === key)).map(([, binding]) => binding.execute));
    const browser = runnable.some(node => node.resource === 'browser') || executions.some(execution => execution.kind === 'builtin' && execution.name === 'page-text' || execution.kind === 'agent' && execution.tools?.some(name => ['page_text', 'page_find'].includes(name)));
    const model = runnable.some(node => node.resource === 'model' || node.kind === 'agent' || node.kind === 'review') || executions.some(execution => execution.kind === 'agent');
    const network = browser || model || runnable.some(node => node.resource === 'http');
    const entries = this.agentBindings().bindings.filter(entry => runnable.some(node => node.key === entry.node));
    const invalid = entries.find(entry => !entry.effective);
    if (invalid) throw new ControlError(412, 'invalid_agent_binding', `${invalid.node}：${invalid.error}`);
    const selected = entries.flatMap(entry => entry.effective ? [entry.effective] : []);
    const agents = [...new Map(selected.map(binding => [JSON.stringify(binding), binding])).values()];
    const signature = JSON.stringify({nodes: runnable.map(node => node.key), agents});
    if (!force && this.state.preflight?.ok && signature === this.lastPreflightSignature &&
        Date.now() - this.lastPreflight < 10 * 60_000) return this.state.preflight;
    const configuration = JSON.stringify([this.state.agentDefaults, this.state.agentBindings, this.state.pausedScopes, this.compiled.digest]);
    const r = await withModelAdmission(() => null,
      () => preflight(this.project.dir, this.broker, {network, model, browser, agents}),
      (_dependency, signal) => this.broker.modelRequests.acquire(signal));
    if (configuration !== JSON.stringify([this.state.agentDefaults, this.state.agentBindings, this.state.pausedScopes, this.compiled.digest])) {
      throw new ControlError(409, 'agent_configuration_changed', '体检期间工位配置或暂停范围已变化，请按当前配置重新体检');
    }
    this.lastPreflightSignature = signature;
    this.lastPreflight = Date.now();
    this.journal.append({ kind: "preflight.checked", ok: r.ok, checks: r.checks });
    if (!r.ok) {
      const bad = r.checks.filter((c) => !c.ok);
      this.raiseAlert({ id: "preflight", level: "red", kind: "preflight", message: `开跑体检未通过：${bad.map((c) => `${c.label}（${c.detail}）`).join("；")}`, nextAction: bad.map((c) => c.fix).filter(Boolean).join("；") || "按 ENV.md 修复后重试" });
      throw new ControlError(412, "preflight_failed", `开跑体检未通过：${bad.map((c) => c.label).join("、")}`, bad);
    }
    this.clearAlert("preflight", "体检通过");
    if (r.checks.find((c) => c.id === "model")?.ok) for (const a of Object.values(this.state.alerts ?? {})) if (a.kind === "model") {
      if (a.dependency) {
        const probe = r.checks.flatMap(check => check.modelProbes ?? []).find(value =>
          value.dependency.key === a.dependency!.key && value.actuallyProbed && value.ok);
        if (probe) this.modelCircuits.probed(probe);
        continue;
      }
      if (a.id === 'model-transport' && (this.batch.permitModelTrial() || this.recovery?.permitModelTrial())) continue;
      this.clearAlert(a.id, "体检确认模型可用");
    }
    return r;
  }

  private wireRecovery() {
    if (this.kernel === 'v1') this.runtime.onRecovery = (token, failure) => this.recordRecovery(token, failure);
    this.runtime.onAlert = (token, node, failure, dependency) => {
      const kind: Alert["kind"] | undefined = failure.tag === "network_tls" ? "tls" : failure.tag === "model_unavailable" || failure.tag === "model_transport" ? "model" : failure.tag === "auth_required" ? "auth" : undefined;
      if (!kind) return;
      const current = this.state.tokens[token.id];
      const id = failure.tag === 'model_transport' ? 'model-transport' : kind === 'model' ? 'model' : `${kind}:${current ? recoveryKey(current) : token.item}`;
      this.raiseAlert({ id: kind === 'model' && dependency ? `${id}:${dependency.key}` : id,
        dependency: kind === 'model' ? dependency : undefined,
        level: "red", kind, message: `${token.title || token.item}：${failure.message}`.slice(0, 400), nextAction: failure.nextAction, token: token.id, item: token.item, node: node.key, url: kind === 'model' ? undefined : failure.url ?? token.url });
      if (this.kernel === 'v2') return;
      if (kind === 'model' && dependency) this.modelCircuits.failed(dependency, token.id, node.key, failure);
      if (failure.tag === 'model_transport') {
        if (!dependency) this.batch.modelFailed();
        this.recovery?.modelFailed();
      }
    };
    if (this.kernel === 'v1') this.runtime.onPark = token => this.recordRecovery(token, {tag:"run_ended",category:"system",message:"本轮结束，工作尚未完成",url:token.url,retryable:true});
  }

  private recordRecovery(token:Pick<TokenRun,"id"|"item"|"url"|"title"|"source">,failure:Failure) {
    // Channel children are independent jobs. Their failure must never overwrite
    // the website parent's recovery record or add fictitious candidate stock.
    if(this.state.tokens[token.id]?.data.channelDelivery||token.source.startsWith('channel:')){
      if(!this.state.tokens[token.id]?.data.failure)this.journal.append({kind:'token.data',token:token.id,patch:{failure}});
      return;
    }
    const current = this.state.tokens[token.id];
    const key = current ? recoveryKey(current) : token.item;
    const previous = this.state.recoveries[key], disposition = failure.retryable ? 'retry' : 'removed';
    if(previous?.token===token.id&&previous.disposition===disposition)return;
    if(!this.state.tokens[token.id]?.data.failure)this.journal.append({kind:"token.data",token:token.id,patch:{failure}});
    this.journal.append({kind:"candidate.disposition",candidate:{key,item:token.item,token:token.id,url:token.url,title:token.title||token.item,source:token.source,category:current?.category,disposition,failure}});
    const delta=Number(disposition==="retry")-Number(previous?.disposition==="retry");
    if(delta && this.runtime.nodes.has('candidates/pool'))this.runtime.stockDelta("candidates/pool",delta,`${token.item}：${disposition==="retry"?"退回待重试":"移除无效网址"}`);
  }

  private recoverLegacyFailures() {
    if (!this.runtime.nodes.has('candidates/pool')) return;
    // Repair the old "fetch failed → successful rejection" and exhausted capture
    // paths once, without rewriting evidence or rerunning paid model work.
    const latest = new Map(Object.values(this.state.tokens).sort((a,b)=>a.createdAt-b.createdAt).map(t=>[recoveryKey(t),t]));
    for(const token of latest.values()) {
      if(token.data.channelDelivery||token.source.startsWith('channel:'))continue;
      if(this.state.recoveries[recoveryKey(token)]||!["rejected","manual","parked"].includes(token.status))continue;
      const recorded = token.data.failure as Failure | undefined;
      if (recorded && (!recorded.retryable || recorded.code === 'EXTERNAL_OPERATION_UNKNOWN')) continue;
      const attempts=token.attempts.map(id=>this.state.attempts[id]).filter(Boolean);
      const failed=[...attempts].reverse().find(a=>a.ok===false||/^打不开[：:]|^HTTP [45]\d\d/.test(a.summary??""));
      if(!failed&&token.status!=="parked")continue;
      if(failed&&!/fetch|screenshot|navigation|ERR_|Timeout|打不开|HTTP|网址/i.test(failed.error??failed.summary??""))continue;
      const invalid=/^https?:\/\/git\+https?\//i.test(token.url)||!canonical(token.url);
      const failure:Failure=!failed&&token.status==="parked"
        ? {tag:"run_ended",category:"system",message:token.reason??"本轮结束，工作未完成",url:token.url,retryable:true}
        : classifyFailure(failed?.error??failed?.summary,{url:token.url,stage:invalid?"url":undefined});
      this.recordRecovery(token,failure);
    }
  }

  /** Transfer an exhausted recovery once, without counting it in both stores. */
  holdRecoveryForReview(tokenId: string, station: string, reason: string): void {
    const token = this.runtime.tokens.get(tokenId);
    const current = this.state.tokens[tokenId];
    const node = this.runtime.nodes.get(station);
    if (!token || !current || !node || !this.runtime.runnable(node) || !token.closure.has(station)) {
      throw new ControlError(409, 'recovery_station_missing', '人工复核必须保留原可执行工位与检查点');
    }
    if (current.status === 'manual') return;
    if (!['parked', 'failed'].includes(current.status) || token.inflight.size) {
      throw new ControlError(409, 'recovery_still_active', '等待原尝试结束并保存回执后再转人工复核');
    }
    const candidate = this.state.recoveries[recoveryKey(current)];
    this.runtime.atomicTransition(() => {
      if (candidate?.token === tokenId && candidate.disposition === 'retry') {
        this.journal.append({kind: 'candidate.disposition', candidate: {
          ...candidate, disposition: 'manual', recoveryStation: station,
        }});
        if (this.runtime.nodes.has('candidates/pool')) {
          this.runtime.stockDelta('candidates/pool', -1, `${token.item} 自动恢复耗尽，转人工复核`);
        }
      }
      this.runtime.toManual(token, node, reason);
    });
  }

  candidateFailures(filter:{tag?:string;disposition?:string}={}) {
    return Object.values(this.state.recoveries).filter(c=>(!filter.tag||c.failure?.tag===filter.tag)&&(!filter.disposition||c.disposition===filter.disposition)).sort((a,b)=>b.at-a.at);
  }

  /** Exact token selectors cannot drift to a newer attempt or a same-named workflow. */
  candidatesForRetry(filter: {tag?: string; items?: string[]; tokens?: string[]; count: number; includeManual?: boolean}) {
    if (filter.tokens?.length && filter.items?.length) {
      throw new ControlError(400, 'recovery_selector_conflict', '请按任务或条目标识选择，不要同时提供两种选择器');
    }
    const records = this.candidateFailures();
    if (filter.items) {
      for (const item of filter.items) {
        const matches = records.filter(candidate => candidate.item === item);
        if (matches.length > 1) {
          throw new ControlError(409, 'recovery_item_ambiguous', '同名条目属于多个工作流，请选择具体任务后继续', {
            item, candidates: matches.map(candidate => ({key: candidate.key, token: candidate.token,
              line: candidate.line, workflowPack: candidate.workflowPack, disposition: candidate.disposition})),
          });
        }
      }
    }
    return records.filter(candidate => candidate.disposition === 'retry' || filter.includeManual && candidate.disposition === 'manual')
      .filter(candidate => !filter.tag || candidate.failure?.tag === filter.tag)
      .filter(candidate => !filter.items || filter.items.includes(candidate.item))
      .filter(candidate => !filter.tokens || filter.tokens.includes(candidate.token))
      .slice(0, filter.count);
  }

  choosePreview(item:string,role:"breadth"|"proof",url:string) {
    const c = this.candidatesForRetry({items: [item], count: 1})[0];
    if(!c||c.disposition!=="retry")throw new ControlError(409,"candidate_not_waiting","该候选当前不在待处理队列");
    let selected:URL,entry:URL;
    try{selected=new URL(url);entry=new URL(c.url);}catch{throw new ControlError(400,"invalid_url","请输入完整网页地址");}
    const host=entry.hostname.replace(/^www\./,"");
    if(!["http:","https:"].includes(selected.protocol)||selected.username||selected.password||!(selected.hostname.replace(/^www\./,"")===host||selected.hostname.endsWith('.'+host)))throw new ControlError(400,"invalid_preview_page","采集页必须是该站点或其子域的 HTTP(S) 网页");
    if(/\.(txt|md|json|xml|zip|pdf|png|jpe?g|svg|mp4)$/i.test(selected.pathname))throw new ControlError(400,"not_visual_page","请选择可视页面，不能用数据文件或下载文件代替截图");
    if(!this.state.tokens[c.token]?.data.canonical)throw new ControlError(409,"missing_classification","请先完成首页抓取与分类，再指定采集页");
    return this.retryCandidates({tokens:[c.token],count:1,preview:{role,url:selected.href}})[0];
  }

  retryCandidates(filter: {
    tag?: string;
    items?: string[];
    tokens?: string[];
    count: number;
    preview?: {role: 'breadth' | 'proof'; url: string};
    automatic?: boolean;
    includeManual?: boolean;
    replan?: boolean;
    checkpointOnly?: boolean;
    onClaim?: (token: TokenRun) => void;
  }) {
    if (this.runtime.paused && this.runtime.running) {
      throw new ControlError(409, 'run_paused', '请先继续或结束当前暂停的轮次');
    }
    if (filter.includeManual && (filter.automatic || !filter.items?.length && !filter.tokens?.length)) {
      throw new ControlError(400, 'manual_retry_requires_items', '人工复核项仅能按明确指定的条目主动重试');
    }
    const selected = this.candidatesForRetry(filter);
    if (!selected.length) return [];
    if (filter.checkpointOnly) {
      if (!this.runtime.running || this.runtime.ending) throw new ControlError(409, 'run_inactive', '自动恢复只在当前运行中继续已有检查点');
      // Expected validation failures must occur before a journal transaction;
      // transaction failure deliberately stops the runtime to protect storage.
      const checkpoints = selected.map(candidate => this.candidateCheckpoint(candidate));
      const resumed: TokenRun[] = [];
      this.runtime.atomicTransition(() => {
        for (const [index, candidate] of selected.entries()) {
          const token = this.resumeCandidateCheckpoint(candidate, checkpoints[index]);
          filter.onClaim?.(token);
          resumed.push(token);
        }
      });
      return resumed;
    }
    const requestedCheckpoints = new Map<string, ReturnType<Factory['candidateCheckpoint']>>();
    if (!filter.automatic && !filter.preview && !filter.replan) {
      for (const candidate of selected) {
        const saved = this.state.tokens[candidate.token]?.data.runtimeCheckpoint;
        if (saved && typeof saved === 'object' && (saved as {version?: number}).version === 1) {
          requestedCheckpoints.set(candidate.token, this.candidateCheckpoint(candidate, true));
        } else if (candidate.disposition === 'manual') {
          throw new ControlError(409, 'recovery_checkpoint_missing', '人工复核项缺少完整检查点，不能回入口重做');
        }
      }
    }
    if (!filter.automatic) {
      for (const candidate of selected) {
        for (const kind of ['tls', 'auth', 'browser']) {
          const token = this.state.tokens[candidate.token];
          const id = `${kind}:${candidate.key ?? (token ? recoveryKey(token) : candidate.item)}`;
          const alert = this.state.alerts[id];
          if (alert && (!alert.token || alert.token === candidate.token)) this.clearAlert(id, '站长已处理，按原因重试');
        }
      }
    }
    if(!this.runtime.running)this.runtime.start(`失败重试 × ${selected.length}`);
    return selected.map(c=>{
      const previous=this.state.tokens[c.token];
      const prepared = requestedCheckpoints.get(c.token);
      if (prepared) {
        let requested!: TokenRun;
        this.runtime.atomicTransition(() => {
          requested = this.resumeCandidateCheckpoint(c, prepared);
          this.recovery?.requestedRetry(previous, requested);
        });
        return requested;
      }
      const legacy:Record<string,string>={"curation/fetch":"curation/scout"};
      const failedAt=filter.replan?'curation/reader':filter.preview?`curation/${filter.preview.role}`:previous?.finishedAtNode&&(legacy[previous.finishedAtNode]??previous.finishedAtNode);
      const legacyCandidate = !previous?.data.workflowPack && (previous?.line === 'candidates' || previous?.line === 'curation');
      const checkpoint=(!legacyCandidate || previous?.data.canonical)&&failedAt&&this.compiled.nodes.some(n=>n.key===failedAt&&this.runtime.runnable(n))?failedAt:legacyCandidate?'candidates/tidy':String((previous?.data.runtimeCheckpoint as {entry?:string})?.entry ?? previous?.at[0] ?? '');
      if (!this.runtime.nodes.has(checkpoint)) throw new ControlError(409, 'recovery_station_missing', '原检查点已不在当前流水线包中，请先恢复对应包版本');
      const data:Record<string,unknown>=checkpoint==="candidates/tidy"?(previous?.data.rerunPublished === true ? { rerunPublished: true } : {}):structuredClone(previous.data);
      delete data.failure;delete data.gate;delete data.digest;
      delete data.accessVerified;
      if (filter.automatic && previous?.data.batchRecovery) data.batchRecovery = { ...(previous.data.batchRecovery as object), nextAt: 0 };
      if (filter.replan) {
        data.repairContext = { failure: c.failure, tried: previous?.data.needsPick, plan: previous?.data.readerPlan, access: previous?.data.candidateAccessFailures };
        for (const key of ['previewChoices','shotRepairs','readerPlan','breadthVisual','breadthCompared','needsPick']) delete data[key];
      }
      if(filter.preview){
        data.previewChoices={...(data.previewChoices as object??{}),[filter.preview.role]:filter.preview.url};
        const repairs={...(data.shotRepairs as Record<string,unknown>??{})};delete repairs[filter.preview.role];data.shotRepairs=repairs;
      }
      const recoveryRoot=String(previous?.data.recoveryRoot??(previous&&this.state.attempts[previous.attempts[0]]?.node)??checkpoint);
      const completed=new Map((previous?.attempts??[]).map(id=>this.state.attempts[id]).filter(Boolean).map(a=>[a.node,a.ok]));
      const saved = previous?.data.runtimeCheckpoint as { version?: number; done: string[]; rounds: Record<string, number>; notes: [string, { reason: string; note?: string; byHuman: boolean }][] } | undefined;
      const t=this.runtime.create(checkpoint,{item:c.item,url:c.url,title:c.title,source:legacyCandidate?'candidates/pool':c.source,category:c.category,data:{...data,express:true,retryOf:c.token,retryTag:c.failure?.tag,recoveryStation:checkpoint,recoveryRoot}});
      if(checkpoint!=="candidates/tidy") {
        t.entry=recoveryRoot;t.closure=this.runtime.closureOf(recoveryRoot);
        const invalidated=this.runtime.descendants(t,checkpoint);
        const previousDone = saved?.version === 1 ? saved.done : [...(previous.data.checkpointDone as string[]??[]),...[...completed].filter(([,ok])=>ok).map(([key])=>key)];
        t.done=new Set(previousDone.filter(key=>!invalidated.has(key)));
        t.rounds = { ...(saved?.version === 1 ? saved.rounds : previous.rounds) };
        if (saved?.version === 1) t.notes = new Map(saved.notes);
        this.runtime.restoreFlow(t);
        this.runtime.resumeFrontier(t, checkpoint);
        t.data.checkpointDone=[...t.done];this.journal.append({kind:"token.data",token:t.id,patch:{checkpointDone:[...t.done]}});
        this.runtime.checkpoint(t);
      }
      if(previous&&checkpoint!=="candidates/tidy"){
        for(const id of previous.evidence){const ev=this.state.evidence[id];if(!ev)continue;this.journal.append({kind:"evidence.added",evidence:{...ev,id:`${ev.id}-${t.id}`,token:t.id,at:Date.now(),meta:{...ev.meta,reusedFrom:ev.id}}});}
        this.journal.append({kind:"token.data",token:previous.id,patch:{retriedBy:t.id}});
      }
      this.journal.append({kind:"dispatch.note",node:checkpoint,tone:"info",text:`${c.title} 从${this.compiled.nodes.find(n=>n.key===checkpoint)?.name??checkpoint}继续，保留此前成果`});
      this.journal.append({kind:"candidate.disposition",candidate:{...c,token:t.id,disposition:"claimed"}});
      if (c.disposition === 'retry' && this.runtime.nodes.has('candidates/pool')) this.runtime.stockDelta("candidates/pool",-1,`${c.item} 已取出重试`);
      if (!filter.automatic) this.recovery?.requestedRetry(previous, t);
      return t;
    });
  }

  private candidateCheckpoint(candidate: CandidateRecovery, allowPaused = false) {
    const previous = this.state.tokens[candidate.token];
    const raw = previous?.data.runtimeCheckpoint;
    const saved = raw && typeof raw === 'object' ? raw as {
      version?: unknown; entry?: unknown; done?: unknown; rounds?: unknown; notes?: unknown;
    } : undefined;
    if (!previous || !saved || saved.version !== 1 || typeof saved.entry !== 'string' ||
        !this.runtime.nodes.has(saved.entry) || !Array.isArray(saved.done) ||
        !saved.done.every(key => typeof key === 'string') ||
        !saved.rounds || typeof saved.rounds !== 'object' || Array.isArray(saved.rounds) ||
        !Object.values(saved.rounds).every(value => Number.isSafeInteger(value) && value >= 0) ||
        !Array.isArray(saved.notes) || !saved.notes.every(note => Array.isArray(note) &&
          note.length === 2 && typeof note[0] === 'string' && note[1] &&
          typeof note[1].reason === 'string' && typeof note[1].byHuman === 'boolean')) {
      throw new ControlError(409, 'recovery_checkpoint_missing', '缺少原失败工位的完整持久检查点；已保留成果，不能自动回入口重做');
    }
    const failedStation = candidate.disposition === 'manual' ? candidate.recoveryStation : previous.finishedAtNode;
    let node = failedStation ? this.runtime.nodes.get(failedStation) : undefined;
    if (candidate.disposition === 'manual' && (!node || saved.done.includes(node.key))) {
      throw new ControlError(409, 'recovery_checkpoint_missing', '人工复核项没有尚未完成的原工位，不能猜测恢复入口');
    }
    if (allowPaused && candidate.failure?.tag === 'run_ended' &&
        (!node || !this.runtime.runnable(node) || saved.done.includes(node.key))) {
      // Ending parks inventory at its source, which need not be its unfinished
      // station. Reconstruct from the saved decision, never historical success.
      const original = this.runtime.tokens.get(previous.id);
      node = undefined;
      if (original) {
        const snapshot = structuredClone(original);
        snapshot.data = structuredClone(previous.data);
        this.runtime.restoreCheckpoint(snapshot);
        this.runtime.restoreFlow(snapshot);
        const repair = snapshot.consult && (snapshot.consult.chain[0] ?? snapshot.consult.reviewer);
        const frontier = repair ? [repair] : !snapshot.done.has(snapshot.entry) && !snapshot.dead.has(snapshot.entry)
          ? [snapshot.entry] : this.runtime.readyFrontier(snapshot);
        node = frontier.map(key => this.runtime.nodes.get(key)).find(value => value && this.runtime.runnable(value));
      }
    }
    if (!node || !this.runtime.runnable(node) || !this.runtime.closureOf(saved.entry).has(node.key)) {
      throw new ControlError(409, 'recovery_checkpoint_missing', '原持久检查点没有可恢复的未完成工位；已保留成果，不能回入口重做或重复发布');
    }
    if (!allowPaused && this.runtime.scopePaused(node.key)) throw new ControlError(409, 'scope_paused', '原失败工位已局部暂停，自动恢复继续等待');
    if (previous.status === 'active' || typeof previous.data.retriedBy === 'string' &&
        this.state.tokens[previous.data.retriedBy]) {
      throw new ControlError(409, 'recovery_already_claimed', '原任务已有执行或恢复记录，不能重复领取');
    }
    return {previous, checkpoint: structuredClone(raw), node, entry: saved.entry};
  }

  /** Internal recovery never guesses an entry or discards a partially completed input. */
  private resumeCandidateCheckpoint(
    candidate: CandidateRecovery,
    prepared: ReturnType<Factory['candidateCheckpoint']>,
  ): TokenRun {
    const {previous, checkpoint, node, entry} = prepared;
    const data = structuredClone(previous.data);
    for (const key of ['failure', 'manualReason', 'retriedBy', 'gate', 'digest', 'accessVerified', 'capacityWait', 'browserRecoveries', 'published']) delete data[key];
    const token = this.runtime.create(node.key, {
      item: previous.item, url: previous.url, title: previous.title, source: previous.source,
      category: previous.category,
      data: {...data, express: true, retryOf: previous.id, retryTag: candidate.failure?.tag,
        recoveryStation: node.key, recoveryRoot: entry},
    });
    token.data.runtimeCheckpoint = checkpoint;
    this.runtime.restoreCheckpoint(token);
    for (const key of this.runtime.descendants(token, node.key)) token.done.delete(key);
    this.runtime.restoreFlow(token);
    this.runtime.resumeFrontier(token, node.key);
    token.data.checkpointDone = [...token.done];
    this.journal.append({kind: 'token.data', token: token.id, patch: {checkpointDone: [...token.done]}});
    this.runtime.checkpoint(token);
    for (const id of previous.evidence) {
      const evidence = this.state.evidence[id];
      if (evidence) this.journal.append({kind: 'evidence.added', evidence: {
        ...evidence, id: `${evidence.id}-${token.id}`, token: token.id, at: Date.now(),
        meta: {...evidence.meta, reusedFrom: evidence.id},
      }});
    }
    this.journal.append({kind: 'token.data', token: previous.id, patch: {retriedBy: token.id}});
    this.journal.append({kind: 'candidate.disposition', candidate: {...candidate, token: token.id, disposition: 'claimed'}});
    if (candidate.disposition === 'retry' && this.runtime.nodes.has('candidates/pool')) this.runtime.stockDelta('candidates/pool', -1, `${candidate.item} 从持久检查点恢复`);
    this.journal.append({kind: 'dispatch.note', node: node.key, tone: 'info', text: `${previous.title || previous.item} 从${node.name}继续，保留已完成成果与证据`});
    return token;
  }

  pull(count: number, filter: { category?: string; query?: string; includeRepos?: boolean; candidateIds?: readonly string[] } = {}) {
    if (!this.runtime.nodes.has('candidates/route')) throw new ControlError(409, 'candidate_pack_unavailable', '当前项目未启用策展候选包；请从本项目流水线入口投料');
    const publishedHosts = new Set(loadPublished().map((p) => p.domain.replace(/^www\./, "")));
    const external = new Map(this.externalIntake?.candidates.map(candidate => [candidate.entryId, candidate]));
    const q = filter.query?.toLowerCase();
    const cohort = filter.candidateIds ? new Set(filter.candidateIds) : undefined;
    const pick = this.catalog.filter((c) => !this.taken.has(c.id) &&
      (!cohort || cohort.has(c.id)) &&
      (external.has(c.id) ? external.get(c.id)!.disposition === 'continue' : !publishedHosts.has(this.hostOf(c.canonicalUrl)))
      && (!filter.category || c.category === filter.category || (c.subcategories ?? []).includes(filter.category))
      && (filter.includeRepos || !/^https?:\/\/(www\.)?(github\.com|gitlab\.com|npmjs\.com|www\.npmjs\.com)\//i.test(canonical(c.canonicalUrl)??c.canonicalUrl))
      && (!q || `${c.name} ${c.canonicalUrl} ${c.descriptionZh ?? ""} ${(c.tags ?? []).join(" ")}`.toLowerCase().includes(q)));
    // Spread the pick over the list so one run is not 20 sites from the same letter.
    if (this.externalIntake) pick.sort((a, b) => {
      const priority = (id: string) => {const candidate = external.get(id); return candidate ? 100 + continuationPriority(candidate) : 0;};
      return priority(b.id) - priority(a.id);
    });
    const step = this.externalIntake ? 1 : Math.max(1, Math.floor(pick.length / Math.max(1, count)));
    const chosen: CatalogEntry[] = [];
    for (let i = 0; i < pick.length && chosen.length < count; i += step) chosen.push(pick[i]);
    if (!chosen.length) return [];
    // Validate immutable attachments before changing stock or claiming identities.
    const prepared = chosen.map(candidate => ({candidate,
      research: this.externalIntake && external.has(candidate.id) ?
        externalResearchFor(this.externalIntake, external.get(candidate.id)!) : undefined}));
    if (!this.runtime.running) this.runtime.start(filter.category ? `${filter.category} × ${chosen.length}` : `候选 × ${chosen.length}`);
    const out: TokenRun[] = [];
    for (const {candidate: c, research} of prepared) {
      this.taken.add(c.id);
      this.runtime.stockDelta("candidates/pool", -1);
      const url = canonical(c.canonicalUrl) ?? c.canonicalUrl;
      out.push(this.runtime.create("candidates/route", {
        item: c.id, url, title: c.name, source: "candidates/pool", category: c.category,
        data: { canonical: url, host: this.hostOf(url), catalogEntry: { category: c.category, subcategories: c.subcategories, descriptionZh: c.descriptionZh },
          ...(research ? {externalResearch: research} : {}) },
      }));
    }
    return out;
  }

  /** Snapshot existing research without starting a new round or rewriting history. */
  syncExternalIntake(sourceRoot: string) {
    if (process.env.FACTORY_READONLY === '1' || this.runtime.running && !this.runtime.paused ||
        [...this.runtime.workers.values()].some(pool => pool.some(worker => worker.busy))) {
      throw new ControlError(409, 'project_busy', '请等待当前工位停稳后接回已有资料，原轮次与检查点保持不变');
    }
    this.externalIntake = importExternalIntake({sourceRoot, projectDir: this.project.dir});
    this.loadStock();
    this.journal.append({kind: 'dispatch.note', tone: 'info', text:
      `已接回 ${this.externalIntake.summary.rawObservations} 个原始候选、${this.externalIntake.summary.facts} 份事实资料；` +
      `${this.externalIntake.summary.published} 条有 main 回执的条目排除重投，已有轮次与审核保持原样`});
    return {intakeId: this.externalIntake.intakeId, inventorySha256: this.externalIntake.inventorySha256,
      alreadyPresent: this.externalIntake.alreadyPresent, summary: this.externalIntake.summary,
      warnings: this.externalIntake.warnings};
  }

  /** Hand-pasted URLs enter the candidate layer at 整理 and pass the pool express. */
  feed(urls: string[], opts: { rerunPublished?: boolean } = {}) {
    if (!this.runtime.nodes.has('candidates/tidy')) throw new ControlError(409, 'candidate_pack_unavailable', '当前项目未启用策展候选包；请从本项目流水线入口投料');
    const clean = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
    if (!clean.length) return [];
    if (!this.runtime.running) this.runtime.start(`手贴 × ${clean.length}`);
    return clean.map((u) => this.runtime.create("candidates/tidy", { item: this.hostOf(canonical(u) ?? u), url: u, source: "manual", data: { express: true, ...(opts.rerunPublished ? { rerunPublished: true } : {}) } }));
  }

  /* -------------------------------------------------------------- restart */

  /** A different graph changes initial nodes and which queued nodes are stores.
   * Rebuild both graph-dependent views before writing the new snapshot version.
   * The other components index event data without consulting the compiled graph. */
  private rebuildCompiledProjection(): void {
    const state = initialState(this.compiled);
    const through = this.journal.seq;
    for (const event of this.journal.read(0, undefined, through)) apply(state, event);
    const recovery = initialRecoveryProjection();
    recovery.run = state.run.id;
    // Legacy restore resolves attempts against the final state, not the state
    // at each historical receipt. Keep that behavior when replacing the graph.
    for (const event of this.journal.readKinds(['token.queued', 'token.finished', 'token.data',
      'token.returned', 'attempt.finished'], 0, through)) this.observeRecovery(event, state, recovery);
    this.state = state;
    this.recoveryProjection = recovery;
    if (this.broker) this.broker.modelCircuits = state.modelCircuits;
    this.projectionVersion = snapshotVersion(this.compiled.digest);
  }

  private observeRecovery(event: Stamped, state = this.state, index = this.recoveryProjection) {
    if (event.kind === 'run.started') {
      index.run = event.runId;
      index.arrivals.clear();
      index.sampleTokens.clear();
    }
    if (event.run === index.run && event.kind === 'token.queued') {
      const arrivals = index.arrivals.get(event.node) ?? [];
      arrivals.push(event.at);
      index.arrivals.set(event.node, arrivals);
    }
    if (event.run === index.run && event.kind === 'token.finished' &&
        ['published', 'manual', 'merged', 'rejected'].includes(event.status)) {
      index.sampleTokens.add(event.token);
    }
    if (event.kind === 'token.data' &&
        (event.patch.runtimeCheckpoint as {version?: number} | undefined)?.version === 1) {
      const checkpoint = event.patch.runtimeCheckpoint as {done: string[]; notes: [string, {reason: string; note?: string; byHuman: boolean}][]};
      index.done.set(event.token, new Set(checkpoint.done));
      index.notes.set(event.token, new Map(checkpoint.notes));
      index.checkpointed.add(event.token);
      index.removed.delete(event.token);
    } else if (event.kind === 'token.returned') {
      const notes = index.notes.get(event.token) ?? new Map();
      notes.set(event.to, {reason: event.reason, byHuman: event.byHuman});
      index.notes.set(event.token, notes);
    } else if (event.kind === 'attempt.finished' && event.ok && event.error !== 'restart' && event.error !== 'stale') {
      const attempt = state.attempts[event.attempt];
      if (attempt) index.notes.get(attempt.token)?.delete(attempt.node);
    }
    const markDone = (token: string, node: string) => {
      const done = index.done.get(token) ?? new Set();
      done.add(node);
      index.done.set(token, done);
      index.removed.get(token)?.delete(node);
    };
    if (event.kind === 'attempt.finished' && event.ok && event.error !== 'stale') {
      const attempt = state.attempts[event.attempt];
      if (attempt && !index.checkpointed.has(attempt.token)) markDone(attempt.token, attempt.node);
    } else if (event.kind === 'token.returned') {
      const removed = index.removed.get(event.token) ?? new Set();
      for (const node of event.reset ?? []) {
        index.done.get(event.token)?.delete(node);
        removed.add(node);
      }
      index.removed.set(event.token, removed);
    } else if (event.kind === 'token.queued' &&
        this.compiled.nodes.find(node => node.key === event.node)?.kind === 'store') {
      markDone(event.token, event.node);
    }
  }

  private restore() {
    const rt = this.runtime;
    if (rt instanceof Kernel) {
      rt.recover(this.state);
      return;
    }
    rt.locked = new Set(this.state.lockedStations);
    rt.pausedLines = new Set(this.state.pausedScopes?.lines ?? []);
    rt.pausedStations = new Set(this.state.pausedScopes?.stations ?? []);
    rt.measurement = this.state.measurement?.runId === this.state.run.id ? structuredClone(this.state.measurement) : undefined;
    for (const [key, node] of Object.entries(this.state.nodes)) if (rt.nodes.has(key)) rt.durations.set(key, [...node.durations]);
    const live = Object.values(this.state.workers).filter((w) => !w.retiredAt);
    rt.ensureWorkers(live.map((w) => ({ node: w.node, worker: w.id, label: w.label })));
    const run = this.state.run;
    const resumable=run.status === "running" || run.status === "paused";
    const managedResume = process.env.FACTORY_RESUME_MANAGED === '1' && this.state.batch?.runId === run.id && this.state.batch.mode === 'running';
    rt.running = resumable; rt.paused = resumable&&(run.status === "paused" || process.env.FACTORY_START_PAUSED === "1" && !managedResume); rt.runStartedAt = run.startedAt;
    if (rt.paused && this.state.run.status === "running") this.journal.append({ kind: "run.paused", runId: run.id });
    // Which nodes each token has finished, per the journal (returns reset descendants).
    const index = this.recoveryProjection;
    const done = new Map<string, Set<string>>();
    const notes = structuredClone(index.notes);
    const checkpointed = index.checkpointed;
    for (const token of Object.values(this.state.tokens)) {
      const completed = index.checkpointed.has(token.id) ? new Set<string>()
        : new Set((token.data.checkpointDone as string[]) ?? []);
      for (const node of index.removed.get(token.id) ?? []) completed.delete(node);
      for (const node of index.done.get(token.id) ?? []) completed.add(node);
      done.set(token.id, completed);
    }
    for (const [node, arrivals] of index.arrivals) rt.arrivals.set(node, [...arrivals]);
    for (const token of index.sampleTokens) {
      const item = this.state.tokens[token]?.item;
      if (item) rt.sampleItems.add(item);
    }
    let requeued = 0, voided = 0;
    for (const ts of Object.values(this.state.tokens)) {
      const entry = String(ts.data.recoveryRoot??this.state.attempts[ts.attempts[0]]?.node ?? (ts.source === "manual" ? "candidates/tidy" : "candidates/route"));
      const t: TokenRun = {
        id: ts.id, item: ts.item, url: ts.url, title: ts.title, source: ts.source, entry, data: { ...ts.data },
        closure: rt.closureOf(entry), done: done.get(ts.id) ?? new Set(), dead: new Set(), edgeLive: new Map(), inflight: new Set(),
        queuedAt: new Map(), failures: new Map(), rounds: { ...ts.rounds }, epoch: 0, finished: ts.status!=="active", notes: notes.get(ts.id)??new Map(),
        finishedStore:ts.finishedAtNode&&rt.nodes.get(ts.finishedAtNode)?.kind==="store"?ts.finishedAtNode:undefined,
      };
      rt.restoreCheckpoint(t);
      t.done = done.get(ts.id) ?? t.done;
      t.notes = notes.get(ts.id) ?? t.notes;
      rt.restoreFlow(t);
      rt.tokens.set(t.id, t);
      const legacyFrontier = ts.status === 'parked' && this.state.recoveries[recoveryKey(ts)]?.failure?.message.startsWith('恢复分支状态不完整');
      if ((ts.status === 'manual' || legacyFrontier) && ts.data.recoveryStation && !ts.data.retriedBy && ts.data.manualReason === '没有可走的下一步（分支条件都不成立）') {
        const frontier = rt.readyFrontier(t).filter(key=>rt.runnable(rt.nodes.get(key)!));
        if (frontier.length) {
          const failure: Failure = {tag:'tool_error',category:'system',code:'RESTORED_FRONTIER_MISSING',retryable:true,owner:'system',message:`恢复时遗漏的并行分支已找回：${frontier.join('、')}`,nextAction:'从待执行分支继续，保留已经通过的截图、事实和审查；无需人工替系统补结果。'};
          if (t.finishedStore) rt.stockDelta(t.finishedStore,-1,'修复恢复时遗漏的并行分支');
          t.finishedStore=undefined; t.data.failure=failure;
          this.journal.append({kind:'token.data',token:t.id,patch:{failure,manualReason:null}});
          this.journal.append({kind:'token.finished',token:t.id,node:frontier[0],status:'parked',reason:failure.message});
          const old = this.state.recoveries[recoveryKey(ts)];
          this.journal.append({kind:'candidate.disposition',candidate:{...old,item:t.item,token:t.id,url:t.url,title:t.title??t.item,source:t.source,disposition:'retry',failure,at:Date.now(),attempts:old?.attempts??1}});
          if (old?.disposition !== 'retry') rt.stockDelta('candidates/pool',1,'系统恢复缺失分支，重新进入可恢复候选');
        }
      }
      if(t.finished||!resumable)continue;
      for (const aid of ts.attempts) {
        const a = this.state.attempts[aid];
        if (a && a.endedAt === undefined) {
          this.journal.append({ kind: "attempt.finished", attempt: aid, ok: false, summary: "进程重启：这次处理作废，重新排队", ms: Date.now() - a.startedAt, queuedMs: 0, error: "restart" });
          voided++;
        }
      }
      const repairAt = t.consult && (t.consult.chain[0] ?? t.consult.reviewer);
      for (const old of new Set([...ts.at, ...(repairAt ? [repairAt] : [])])) {
        // Preparation's former pass-through stations were merged into tidy.
        // Resume any parked-in-flight legacy item there without losing its data.
        const k = old === "candidates/extract" || old === "candidates/index" ? "candidates/tidy" : old;
        if (k !== old) {
          t.done.delete(k);
          this.journal.append({ kind: "token.queued", token: t.id, node: k, from: old, returned: true });
        }
        if (k !== repairAt && (t.done.has(k) || rt.awaitingRepair(t, k))) continue;
        const q = rt.queues.get(k);
        if (q && !q.includes(t.id)) { q.push(t.id); t.queuedAt.set(k, Date.now()); requeued++; }
      }
      // A process can stop between saving a completed result and queuing its
      // successor. Exact scheduler checkpoints let us reconstruct that gap.
      if (checkpointed.has(t.id)) {
        // A cancelled entry attempt can clear the UI's `at` field before the
        // process exits. It has no predecessor for resumeFrontier to evaluate,
        // so restore its unfinished checkpoint directly on the same task.
        const entryNode = rt.nodes.get(t.entry);
        const entryQueue = rt.queues.get(t.entry);
        const incoming = (rt.inFlow.get(t.entry) ?? []).filter(edge => t.closure.has(edge.from));
        if (entryNode && rt.runnable(entryNode) && entryQueue && !incoming.length &&
            !t.done.has(t.entry) && !t.dead.has(t.entry) && !t.inflight.has(t.entry) &&
            !rt.awaitingRepair(t, t.entry) && !entryQueue.includes(t.id)) {
          rt.atomicTransition(() => {
            this.journal.append({kind: 'token.queued', token: t.id, node: t.entry, from: 'restart'});
            entryQueue.push(t.id);
            t.queuedAt.set(t.entry, Date.now());
          });
          requeued++;
        }
        rt.resumeFrontier(t, t.entry);
      }
    }
    if (requeued || voided) this.journal.append({ kind: "dispatch.note", tone: "warn", text: `重启后从日志续跑：${requeued} 件货重新排队，${voided} 次中断的处理作废重做；已完成的工位结果不重做` });
    rt.measurementProposal();
    rt.schedule();
  }

  /* -------------------------------------------------------------- settings / layout / patches */

  saveSettings(next: Partial<Settings>) {
    if (next.kernel !== undefined && next.kernel !== this.kernel && this.runtime?.running) {
      throw new ControlError(409, 'run_active', '结束本轮后再选择下次启动使用的内核');
    }
    this.settings = { ...this.settings, ...next };
    fs.writeFileSync(path.join(this.project.dir, 'settings.json'), JSON.stringify({ ...this.settings, browserCapV2: true }, null, 2));
    Object.assign(this.broker.limits, { browser: this.settings.browser, model: this.settings.model, modelWorkers: this.settings.modelWorkers, cpu: this.settings.cpu, http: this.settings.http });
    this.broker.modelRequests.notifyCapacityChanged();
    this.broker.memoryFloorMB = this.settings.memoryFloorMB;
    if (this.runtime instanceof Kernel) this.runtime.maxActiveItems = this.settings.maxActiveItems;
    this.runtime.schedule();
  }

  layoutFile() { return process.env.FACTORY_LAYOUT ?? path.join(ROOT, "layout", "factory.layout.json"); }
  readLayout() { return this.readJson<Record<string, unknown>>(this.layoutFile(), {}); }
  writeLayout(layout: Record<string, unknown>) {
    fs.mkdirSync(path.dirname(this.layoutFile()), { recursive: true });
    fs.writeFileSync(this.layoutFile(), JSON.stringify(layout, null, 2));
  }

  proposePatch(p: Omit<Patch, "status" | "at" | "id">) {
    const patch: Patch = { ...p, id: `p-${String(this.patches.length + 1).padStart(4, "0")}`, status: "proposed", at: new Date().toISOString() };
    const trial = compile(this.workflowPacks?.packs ?? [pack], [...this.patches, { ...patch, status: "accepted" }]);
    this.patches.push(patch);
    fs.writeFileSync(path.join(this.project.dir, 'patches.json'), JSON.stringify(this.patches, null, 2));
    this.journal.append({ kind: "spec.patched", patch: patch.id, summary: patch.summary, status: "proposed" });
    return { patch, issues: trial.issues, nodes: trial.nodes.length, digest: trial.digest };
  }

  decidePatch(id: string, accept: boolean) {
    const p = this.patches.find((x) => x.id === id);
    if (!p || p.status !== "proposed") throw new ControlError(409, "patch_not_proposed", "补丁不存在或已处理");
    let trial: CompiledFactory | undefined;
    if (accept) {
      trial = compile(this.workflowPacks?.packs ?? [pack], this.patches.map((x) => x.id === id ? { ...x, status: "accepted" as const } : x));
      if (trial.issues.length) throw new ControlError(422, "invalid_spec", "补丁校验未通过", trial.issues);
      const missing = trial.nodes.filter((n) => n.kind !== "source" && n.kind !== "store" && !n.dormant && trial!.lines.find((l) => l.id === n.line)?.wired && !this.runtime.executors(n));
      if (missing.length) throw new ControlError(422, "missing_executor", "新增工位缺少执行器，不能生效", missing.map((n) => n.key));
      const missingRoles=trial.nodes.filter(n=>{try{this.runtime.roleResolver(n.key);return false;}catch{return true;}});
      if(missingRoles.length)throw new ControlError(422,"missing_role","节点缺少 ROLE.md 职责契约，不能生效",missingRoles.map(n=>n.key));
      if (this.runtime.running || this.runtime.paused || this.runtime.ending || [...this.runtime.workers.values()].some((pool) => pool.some((w) => w.busy))) throw new ControlError(409, "run_active", "请先结束本轮并等待在途工人退出，再应用规格补丁");
    }
    p.status = accept ? "accepted" : "rejected";
    fs.writeFileSync(path.join(this.project.dir, 'patches.json'), JSON.stringify(this.patches, null, 2));
    this.journal.append({ kind: "spec.patched", patch: id, summary: p.summary, status: p.status });
    if (trial) {
      const previous = this.runtime;
      previous.dispose();
      for (const pool of previous.workers.values()) for (const w of pool) this.journal.append({ kind: "worker.retired", node: w.node, worker: w.id, reason: "规格新版本生效，重新配员" });
      this.compiled = trial;
      this.rebuildCompiledProjection();
      this.runtime = this.createRuntime(trial, this.workflowPacks?.conditions ?? pack.conditions, previous.executors);
      this.runtime.roleResolver = previous.roleResolver;
      this.runtime.onTick = () => this.maintainRuntime();
      this.wireRecovery();
      this.runtime.stock = previous.stock;
      if (this.runtime instanceof Kernel) this.runtime.recover(this.state);
      else {
        this.runtime.tokens = previous.tokens;
        for (const t of this.runtime.tokens.values()) t.closure = this.runtime.closureOf(t.entry);
      }
      this.runtime.locked = new Set([...previous.locked].filter((key) => this.runtime.nodes.has(key)));
      this.runtime.pausedLines = new Set(previous.pausedLines); this.runtime.pausedStations = new Set(previous.pausedStations);
      this.lastPreflight = 0;
      this.journal.append({ kind: "factory.loaded", digest: trial.digest, specVersion: trial.specVersion });
      if (this.kernel === 'v1') this.runtime.ensureWorkers([]);
      this.runtime.tick();
    }
    return true;
  }

  emit(e: Record<string, unknown>) { for (const l of this.ephemeral) l(e); }

  events(since: number): Stamped[] { return [...this.journal.read(since)]; }
}
