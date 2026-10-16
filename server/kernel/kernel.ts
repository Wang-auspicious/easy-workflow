// v2 owns durable item/node transitions. Runtime is only the compatibility surface;
// none of its worker dispatch, balancing or recovery machinery is used here.
import crypto from 'node:crypto';
import {Runtime, type TokenRun, type Executor, type ExecutorRegistration, type PreparedExecutor,
  type StationResult, type Fix, type StationContext} from '../runtime.ts';
import type {AgentBudget, CompiledFactory, CompiledNode, CompiledEdge, EvidenceRef, ModelDependency,
  ModelCircuit, ModelResponse, JournalEvent, TokenStatus} from '../../shared/types.ts';
import type {BoardPost, Room} from '../../shared/board.ts';
import type {FactoryState} from '../../shared/project.ts';
import type {Broker, Lease} from '../broker.ts';
import type {Journal} from '../journal.ts';
import {ControlError} from '../errors.ts';
import {classifyFailure, candidateFailure, type Failure} from '../../shared/failures.ts';
import {withModelAdmission} from '../model-requests.ts';
import {browserAttemptScope, withBrowserAttempt} from '../browser.ts';
import {createItem, advanceItem, completeNode, returnItem, asTokenRun, topologicalOrder, closureOf,
  type ItemState} from './item.ts';
import {KernelStore} from './store.ts';
import {planFailure, nextModelFailure, claimModelProbe, modelProbeSucceeded, releaseModelProbe} from './retry.ts';
import {admittedCandidates, sortReady, wakeWaiting} from './scheduler.ts';
import type {BoardStore} from '../board.ts';

const uid = (prefix: string) => `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
const terminal = (item: ItemState) => !['queued', 'active'].includes(item.status);
const removed = (): never => { throw new ControlError(410, 'removed_in_v2', 'v2 不再按工人配比，并发由资源上限决定'); };
type Input = Parameters<Runtime['create']>[1];
type LiveAttempt = {item: string; node: string; attempt: string; controller: AbortController;
  dependency?: ModelDependency; evidence: string[]; startedAt: number; queuedMs: number; lease?: Lease};

export interface KernelCollaboration {
  board: BoardStore;
  /** Synchronous persistence only; the kernel supplies the transaction. */
  openRoom(item: ItemState, field: string, topic: string): Room;
  runRoom(room: Room, signal: AbortSignal): Promise<unknown>;
  answer(question: BoardPost, signal: AbortSignal): Promise<BoardPost>;
}

export class Kernel extends Runtime {
  readonly store: KernelStore;
  readonly kernel = 'v2' as const;
  private activeLimit = 12;
  private loop?: ReturnType<typeof setInterval>;
  private queuedPump = false;
  private pumpingV2 = false;
  private disposedV2 = false;
  private storageErrorV2?: unknown;
  private readonly workV2 = new Set<Promise<void>>();
  private readonly liveV2 = new Map<string, LiveAttempt>();
  private readonly circuitsV2 = new Map<string, ModelCircuit>();
  private readonly topo: Map<string, number>;
  private collaboration?: KernelCollaboration;
  private readonly roomControllers = new Map<string, AbortController>();

  constructor(compiled: CompiledFactory, journal: Journal, broker: Broker,
    conditions: Record<string, (data: Record<string, unknown>) => boolean>,
    executors: (node: CompiledNode) => Executor | ExecutorRegistration | null) {
    super(compiled, journal, broker, conditions, executors);
    this.store = new KernelStore(journal);
    this.topo = new Map(topologicalOrder(compiled).map((key, index) => [key, index]));
    for (const item of this.store.list()) this.syncView(item);
    // The v1 supervisor's circuit map must never block an unrelated v2 lease.
    broker.modelCircuits = {};
  }

  get maxActiveItems() { return this.activeLimit; }
  set maxActiveItems(value: number) {
    if (!Number.isSafeInteger(value) || value < 1) throw new ControlError(400, 'invalid_active_limit', '在途货上限必须为正整数');
    this.activeLimit = value;
    this.schedule();
  }

  configureCollaboration(services: KernelCollaboration): void {
    this.collaboration = services;
  }

  /** Called only after room creation and item holds are committed. */
  private driveRoom(room: Room): void {
    if (!this.collaboration || !this.running || this.paused || this.disposedV2 || this.roomControllers.has(room.id)) return;
    const item = this.store.get(room.item);
    if (!item || terminal(item) || !item.roomHolds?.[room.id] || this.collaboration.board.getRoom(room.id)?.status !== 'open') return;
    const controller = new AbortController();
    this.roomControllers.set(room.id, controller);
    const task = Promise.resolve().then(async () => {await this.collaboration!.runRoom(room, controller.signal);})
      .catch(error => {
        if (!controller.signal.aborted && this.store.get(room.item)?.roomHolds?.[room.id]) this.parkCollaboration(room.item, room.participants[0],
          error instanceof Error ? error.message : String(error));
      }).finally(() => {
        this.roomControllers.delete(room.id);
        this.workV2.delete(task);
        this.schedule();
      });
    this.workV2.add(task);
  }

  private holdRoom(item: ItemState, room: Room, owner: string): void {
    const affected = [...closureOf(this.f, owner)].filter(key => key !== owner && item.nodes[key]);
    item.roomHolds = {...item.roomHolds, [room.id]: {field: room.field, owner, nodes: affected}};
    for (const key of affected) {
      const state = item.nodes[key];
      state.status = 'pending';
      delete state.lastAttempt;
      delete state.waitingFor;
      delete state.nextAt;
    }
    this.journal.afterCommit(() => {
      for (const work of this.liveV2.values()) if (work.item === item.id && affected.includes(work.node)) {
        work.controller.abort(new Error('field discussion opened'));
      }
      this.driveRoom(room);
    });
  }

  openDiscussion(itemId: string, field: string, topic: string): Room {
    this.assertWritable();
    const before = this.store.get(itemId);
    if (!before || !this.collaboration) throw new ControlError(404, 'collaboration_unavailable', '找不到可讨论的货');
    const owner = field === 'kind' && before.nodes[`${before.line}/kind-join`] ? `${before.line}/kind-join`
      : this.collaboration.board.owners(before, field).sort((a, b) => (this.topo.get(a) ?? Infinity) - (this.topo.get(b) ?? Infinity))[0];
    if (!owner) throw new ControlError(422, 'field_owner_missing', '该字段没有归属工位');
    let room!: Room;
    this.atomicTransition(() => {
      const next = structuredClone(before);
      room = this.collaboration!.openRoom(next, field, topic);
      this.holdRoom(next, room, owner);
      this.persist(before, next);
    });
    return room;
  }

  applyRoomResolution(itemId: string, field: string, value: unknown, owner: string, roomId: string): void {
    const before = this.store.get(itemId);
    const hold = before?.roomHolds?.[roomId];
    const room = this.collaboration?.board.getRoom(roomId);
    if (!before || before.status !== 'active' || !hold || hold.field !== field || !room ||
        room.item !== itemId || room.field !== field || !['resolved', 'judged'].includes(room.status)) {
      throw new ControlError(409, 'stale_room', '该讨论室已失效，不能覆盖当前货物结果');
    }
    this.atomicTransition(() => {
      const next = structuredClone(before);
      const parts = field.split('.');
      let target = next.data;
      for (const part of parts.slice(0, -1)) {
        const prior = target[part];
        target[part] = prior && typeof prior === 'object' && !Array.isArray(prior) ? {...prior} : {};
        target = target[part] as Record<string, unknown>;
      }
      target[parts.at(-1)!] = structuredClone(value);
      const actualOwner = hold.owner || owner;
      if (field === 'kind' && actualOwner.endsWith('/kind-join')) next.data.kindAgreed = true;
      delete next.roomHolds![roomId];
      if (!Object.keys(next.roomHolds!).length) delete next.roomHolds;
      this.collaboration?.board.resolveChallenges(this.collaboration.board.openChallenges(next)
        .filter(post => post.field === field).map(post => post.id));
      for (const key of hold.nodes) {
        const state = next.nodes[key];
        state.status = 'pending';
        state.attempts = 0;
        delete state.lastAttempt;
        delete state.waitingFor;
        delete state.nextAt;
      }
      this.journal.append({kind: 'token.data', token: itemId, patch: {[parts[0]]: next.data[parts[0]],
        ...(field === 'kind' ? {kindAgreed: next.data.kindAgreed} : {})}});
      const advanced = advanceItem(next, this.f, this.conditions);
      this.persist(before, advanced, {from: actualOwner, returned: true});
      this.deliverCompletedStores(before, advanced);
      this.journal.afterCommit(() => this.schedule());
    });
  }

  parkCollaboration(itemId: string, node: string, reason: string, code = 'room_unresolved'): void {
    const item = this.store.get(itemId);
    if (!item || terminal(item)) return;
    this.atomicTransition(() => this.parkItem(item, node, reason, code));
  }

  saveDialogueSession(itemId: string, key: string, result: Pick<StationResult, 'sessionCheckpoint'>, allowShutdown = false): void {
    const before = this.store.get(itemId);
    const checkpoint = result.sessionCheckpoint;
    if (!before?.nodes[key] || !checkpoint) return;
    const save = () => {
      const next = structuredClone(before);
      const patch: Record<string, unknown> = {};
      if (checkpoint.pi) {
        next.nodes[key].session = structuredClone(checkpoint.pi);
        patch.stationSessions = {...next.data.stationSessions as object, [key]: checkpoint.pi};
      }
      if (checkpoint.closed) patch.closedStationSessions = {...next.data.closedStationSessions as object, [key]: checkpoint.closed};
      next.data = {...next.data, ...patch};
      this.journal.append({kind: 'token.data', token: itemId, patch});
      this.persist(before, next);
    };
    // Shutdown stops admissions first, but a still-valid room keeps its partial
    // transcript just as an interrupted ordinary attempt does in finishV2.
    if (allowShutdown && this.disposedV2) this.journal.atomic(save);
    else this.atomicTransition(save);
  }

  /** The question and the exact suspended tool call commit with its transcript. */
  savePendingQuestion(itemId: string, key: string, attempt: string, question: NonNullable<StationContext['pendingQuestion']>,
    checkpoint: NonNullable<StationResult['sessionCheckpoint']>): void {
    const before = this.store.get(itemId);
    if (before?.status !== 'active' || before.nodes[key]?.status !== 'running' || before.nodes[key].lastAttempt !== attempt) {
      throw new ControlError(409, 'stale_attempt', '当前工位已经变化，不能发起答疑');
    }
    this.atomicTransition(() => {
      this.saveDialogueSession(itemId, key, {sessionCheckpoint: checkpoint});
      const current = this.store.get(itemId)!;
      const next = structuredClone(current);
      next.nodes[key].pendingQuestion = structuredClone(question);
      this.persist(current, next);
    });
  }

  private assertWritable() {
    if (this.journal.readOnly || process.env.FACTORY_READONLY === '1') throw new ControlError(403, 'read_only', '只读项目不能改变运行状态');
    if (this.storageErrorV2) throw new ControlError(503, 'journal_commit_failed', '项目日志提交失败；请修复存储并重启后恢复');
    if (this.disposedV2) throw new ControlError(409, 'kernel_closed', '内核已关闭');
  }

  override atomicTransition(action: () => void) {
    this.assertWritable();
    try { this.journal.atomic(action); }
    catch (error) {
      this.storageErrorV2 = error;
      this.running = false; this.paused = true;
      if (this.loop) clearInterval(this.loop);
      this.loop = undefined;
      for (const work of this.liveV2.values()) work.controller.abort(error);
      // No failed SQL transition may survive only in compatibility memory.
      this.tokens.clear();
      for (const item of this.store.list()) this.syncView(item);
      throw error;
    }
  }

  private syncView(item: ItemState): TokenRun {
    const value = {...asTokenRun(item)} as TokenRun;
    const existing = this.tokens.get(item.id);
    const token = existing ? Object.assign(existing, value) : value;
    this.tokens.set(item.id, token);
    for (const [key, queue] of this.queues) {
      const previous = queue.indexOf(item.id);
      if (previous !== -1) queue.splice(previous, 1);
      if (!terminal(item) && item.nodes[key]?.status === 'ready') queue.push(item.id);
    }
    return token;
  }

  private persist(previous: ItemState | undefined, next: ItemState, options: {
    from?: string; returned?: boolean; status?: TokenStatus; reason?: string; admittedAt?: number;
  } = {}) {
    next.updatedAt = Date.now();
    this.retireRooms(previous, next, options.reason ?? next.parked?.reason ?? '货物状态已变化');
    if (terminal(next)) for (const node of Object.values(next.nodes)) {
      if (node.status === 'running') node.status = 'pending';
    }
    // Existing imports and correction tools use this host-owned checkpoint. It
    // also gives admission/wait transitions a journal receipt in the same commit.
    const checkpoint = {version: 1, entry: next.entry,
      done: Object.keys(next.nodes).filter(key => next.nodes[key].status === 'done'),
      rounds: Object.fromEntries(Object.entries(next.nodes).map(([key, value]) => [key, value.rounds])),
      notes: Object.entries(next.nodes).flatMap(([key, value]) => value.redo ? [[key, value.redo]] : []),
      kernel: {version: 2, status: next.status,
        nodes: Object.fromEntries(Object.entries(next.nodes).map(([key, value]) => [key, {
          status: value.status, attempts: value.attempts, waitingFor: value.waitingFor, nextAt: value.nextAt,
        }]))}};
    next.data.runtimeCheckpoint = checkpoint;
    this.store.save(next, options.admittedAt);
    if (!previous) {
      this.journal.append({kind: 'token.created', token: next.id, line: next.line, item: next.item,
        url: next.url, title: next.title, source: next.source,
        category: typeof next.data.category === 'string' ? next.data.category : undefined});
      if (Object.keys(next.data).length) this.journal.append({kind: 'token.data', token: next.id, patch: next.data});
    } else this.journal.append({kind: 'token.data', token: next.id, patch: {runtimeCheckpoint: checkpoint}});
    for (const [key, state] of Object.entries(next.nodes)) {
      const arrivedStore = state.status === 'done' && previous?.nodes[key]?.status !== 'done' && this.nodes.get(key)?.kind === 'store';
      if ((state.status === 'ready' || arrivedStore) && previous?.nodes[key]?.status !== 'ready') {
        this.journal.append({kind: 'token.queued', token: next.id, node: key, from: options.from ?? next.source, returned: options.returned});
      }
    }
    if (next.data.published === true && previous?.data.published !== true) this.journal.append({kind: 'token.data', token: next.id, patch: {published: true}});
    if (terminal(next) && (!previous || !terminal(previous) || previous.status !== next.status)) {
      const node = next.parked?.node ?? Object.keys(next.nodes).find(key =>
        key.endsWith('/published') && next.nodes[key].status === 'done') ?? next.entry;
      this.journal.append({kind: 'token.finished', token: next.id, node,
        status: options.status ?? (next.status === 'published' ? 'published' : next.status === 'excluded' ? 'rejected' : 'manual'),
        reason: options.reason ?? next.parked?.reason ?? (next.status === 'published' ? '通过发布闸门' : '任务已结束')});
      if (this.nodes.get(node)?.kind === 'store') this.stockDelta(node, 1);
      this.journal.afterCommit(() => {
        for (const work of this.liveV2.values()) if (work.item === next.id) work.controller.abort(new Error('item finished'));
      });
    }
    this.journal.afterCommit(() => this.syncView(next));
  }

  /** A room id is the generation of its hold. Removed holds never become valid
   * again, and their audit receipt commits with the item transition. */
  private retireRooms(previous: ItemState | undefined, next: ItemState, reason: string): void {
    const held = new Set([...Object.keys(previous?.roomHolds ?? {}), ...Object.keys(next.roomHolds ?? {})]);
    if (terminal(next)) delete next.roomHolds;
    const retired = [...held].filter(id => !next.roomHolds?.[id]);
    for (const id of retired) {
      const room = this.collaboration?.board.getRoom(id);
      if (room?.status === 'open') this.collaboration!.board.closeRoom(id, {status: 'parked', reason: `讨论已失效：${reason}`});
    }
    if (retired.length) this.journal.afterCommit(() => {
      for (const id of retired) this.roomControllers.get(id)?.abort(new Error('discussion hold invalidated'));
    });
  }

  /** Recovery changes no business output and never starts an executor. */
  recover(state?: FactoryState) {
    const lifecycle = state ? [] : [...this.journal.readKinds(['run.started', 'run.paused', 'run.resumed', 'run.ended', 'scope.paused'])];
    const last = lifecycle.findLast(event => event.kind.startsWith('run.'));
    this.running = state ? ['running', 'paused'].includes(state.run.status) : Boolean(last && last.kind !== 'run.ended');
    this.paused = state ? state.run.status === 'paused' || process.env.FACTORY_START_PAUSED === '1' : this.running;
    this.runStartedAt = state?.run.startedAt ?? lifecycle.findLast(event => event.kind === 'run.started')?.at ?? Date.now();
    this.pausedLines.clear(); this.pausedStations.clear();
    for (const event of lifecycle) if (event.kind === 'scope.paused') {
      const target = event.scope === 'line' ? this.pausedLines : this.pausedStations;
      event.paused ? target.add(event.key) : target.delete(event.key);
    }
    if (state) {
      for (const key of state.pausedScopes?.lines ?? []) this.pausedLines.add(key);
      for (const key of state.pausedScopes?.stations ?? []) this.pausedStations.add(key);
    }
    this.circuitsV2.clear();
    const savedCircuits = state ? Object.values(state.modelCircuits) : [...this.journal.readKinds(['model.circuit'])]
      .reduce((map, event) => { if (event.kind === 'model.circuit') event.circuit ? map.set(event.key, event.circuit) : map.delete(event.key); return map; }, new Map<string, ModelCircuit>()).values();
    for (const circuit of savedCircuits) this.circuitsV2.set(circuit.dependency.key,
      circuit.state === 'trial' ? {...circuit, state: 'open', trialToken: undefined, nextAt: Date.now()} : circuit);
    this.publishCircuits();
    if (!this.journal.readOnly && process.env.FACTORY_READONLY !== '1') this.atomicTransition(() => {
      for (const item of this.store.list(['active'])) {
        const before = structuredClone(item);
        let changed = false;
        for (const [key, node] of Object.entries(item.nodes)) if (node.status === 'running' || node.status === 'waiting' && node.waitingFor === 'room' && node.lastAttempt) {
          changed = true;
          if (node.lastAttempt) {
            const attempt = this.store.attempt(node.lastAttempt);
            if (attempt) this.store.saveAttempt({...attempt, endedAt: Date.now(), status: 'interrupted', body: {...attempt.body, interrupted: true}});
            this.journal.append({kind: 'attempt.finished', attempt: node.lastAttempt, ok: false, cancelled: true,
              summary: '进程中断，从同一工位检查点恢复', error: 'interrupted', ms: attempt ? Date.now() - attempt.startedAt : 0, queuedMs: 0});
          }
          node.status = 'ready'; delete node.waitingFor; delete node.nextAt;
        }
        if (changed) this.persist(before, item);
      }
    });
    for (const item of this.store.list()) this.syncView(item);
  }

  override start(title: string) {
    this.assertWritable();
    if (this.ending) throw new ControlError(409, 'run_ending', '正在结束上一轮');
    if (this.running) return this.journal.run;
    const runId = uid(`run-${new Date().toISOString().slice(0, 10)}`);
    this.atomicTransition(() => {
      this.journal.append({kind: 'run.started', runId, title});
      this.journal.afterCommit(() => { this.running = true; this.paused = false; this.runStartedAt = Date.now(); this.tick(); this.schedule(); });
    });
    return runId;
  }
  override pause() {
    this.assertWritable();
    if (!this.running || this.paused) return;
    this.atomicTransition(() => { this.journal.append({kind: 'run.paused', runId: this.journal.run}); this.journal.afterCommit(() => { this.paused = true; }); });
  }
  override resume() {
    this.assertWritable();
    if (!this.running || !this.paused) return;
    this.atomicTransition(() => { this.journal.append({kind: 'run.resumed', runId: this.journal.run}); this.journal.afterCommit(() => { this.paused = false; this.tick(); this.schedule(); }); });
  }
  override end() {
    this.assertWritable();
    if (!this.running) return null;
    const runId = this.journal.run;
    this.atomicTransition(() => {
      for (const item of this.store.list(['queued', 'active'])) this.parkItem(item, item.entry, '本轮结束，保留已完成工位', 'run_ended');
      this.journal.append({kind: 'run.ended', runId, manual: true});
      this.journal.afterCommit(() => {
        this.running = false; this.paused = false;
        if (this.loop) clearInterval(this.loop);
        this.loop = undefined;
        for (const controller of this.roomControllers.values()) controller.abort(new Error('run ended'));
      });
    });
    return runId;
  }
  override tick() {
    if (this.loop || this.disposedV2 || this.journal.readOnly) return;
    this.loop = setInterval(() => this.schedule(), 1000);
    this.loop.unref();
    this.schedule();
  }
  override dispose() {
    this.disposedV2 = true; this.running = false; this.paused = true;
    if (this.loop) clearInterval(this.loop);
    this.loop = undefined;
    for (const work of this.liveV2.values()) work.controller.abort(new Error('kernel shutdown'));
    for (const controller of this.roomControllers.values()) controller.abort(new Error('kernel shutdown'));
  }
  override async close() { this.dispose(); await this.settle(); }
  override async settle() {
    while (true) {
      await Promise.resolve();
      const jobs = [...this.workV2];
      if (!jobs.length && !this.queuedPump) return;
      if (jobs.length) await Promise.allSettled(jobs);
    }
  }
  override setScopePaused(options: Parameters<Runtime['setScopePaused']>[0]) {
    this.assertWritable();
    const exists = options.scope === 'line' ? this.f.lines.some(line => line.id === options.key) : this.nodes.has(options.key);
    if (!exists) throw new ControlError(404, 'scope_not_found', '没有这个流水线或工位');
    const scopes = options.scope === 'line' ? this.pausedLines : this.pausedStations;
    if (scopes.has(options.key) === options.paused) return false;
    this.atomicTransition(() => {
      this.journal.append({kind: 'scope.paused', ...options});
      this.journal.afterCommit(() => { options.paused ? scopes.add(options.key) : scopes.delete(options.key); this.schedule(); });
    });
    return true;
  }

  override create(entry: string, input: Input): TokenRun {
    this.assertWritable();
    let token!: TokenRun;
    this.atomicTransition(() => { token = this.insertItem(uid('t'), entry, input); });
    this.schedule();
    return token;
  }
  private insertItem(id: string, entry: string, input: Input): TokenRun {
    const existing = this.store.get(id);
    if (existing) return this.tokens.get(id) ?? asTokenRun(existing) as TokenRun;
    if (!this.nodes.has(entry)) throw new ControlError(404, 'station_not_found', '投料入口工位不存在');
    const item = createItem(this.f, {id, run: this.journal.run, entry, ...input,
      data: {...input.data, ...(input.category ? {category: input.category} : {})}});
    const token = this.syncView(item);
    this.persist(undefined, item);
    return token;
  }

  override schedule() {
    if (this.queuedPump || this.disposedV2 || this.storageErrorV2 || this.journal.readOnly) return;
    this.queuedPump = true;
    queueMicrotask(() => {
      this.queuedPump = false;
      try { this.pumpV2(); } catch (error) { console.error('kernel scheduler', error); }
    });
  }

  /** A question suspends only the calling attempt, not its conversation. */
  async waitForRoom<T>(itemId: string, key: string, attempt: string, action: () => Promise<T>): Promise<T> {
    const work = this.liveV2.get(attempt);
    const before = this.store.get(itemId);
    if (!work || work.item !== itemId || work.node !== key || before?.nodes[key]?.lastAttempt !== attempt ||
        before.nodes[key].status !== 'running') throw new ControlError(409, 'stale_attempt', '当前工位已经变化，不能等待答复');
    this.atomicTransition(() => {
      const next = structuredClone(before);
      next.nodes[key].status = 'waiting';
      next.nodes[key].waitingFor = 'room';
      next.nodes[key].waitingSince = Date.now();
      this.persist(before, next);
    });
    work.lease?.release();
    work.lease = undefined;
    this.schedule();
    try {
      return await action();
    } finally {
      work.controller.signal.throwIfAborted();
      let lease: Lease | null = null;
      while (!lease) {
        const current = this.store.get(itemId);
        if (current?.status !== 'active' || current.nodes[key]?.lastAttempt !== attempt ||
            current.nodes[key].status !== 'waiting' || current.nodes[key].waitingFor !== 'room') {
          throw new ControlError(409, 'stale_attempt', '等待答复期间工位已退回或结束');
        }
        const node = this.nodes.get(key)!;
        lease = await this.broker.acquire(node.resource, {review: node.kind === 'review' || node.kind === 'gate',
          dependency: work.dependency, token: itemId, signal: work.controller.signal});
      }
      work.lease = lease;
      try {
        const current = this.store.get(itemId)!;
        if (current.status !== 'active' || current.nodes[key]?.lastAttempt !== attempt ||
            current.nodes[key].status !== 'waiting' || current.nodes[key].waitingFor !== 'room') {
          throw new ControlError(409, 'stale_attempt', '答复返回时工位已变化');
        }
        this.atomicTransition(() => {
          const next = structuredClone(current);
          next.nodes[key].status = 'running';
          delete next.nodes[key].waitingFor;
          delete next.nodes[key].waitingSince;
          this.persist(current, next);
        });
      } catch (error) {
        work.lease.release();
        work.lease = undefined;
        throw error;
      }
    }
  }

  async waitForStationIdle(itemId: string, key: string, signal: AbortSignal): Promise<void> {
    while (true) {
      const state = this.store.get(itemId)?.nodes[key];
      if (state?.status !== 'running' && !(state?.status === 'waiting' && state.waitingFor === 'room' && state.pendingQuestion)) break;
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, 20);
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
        function done() { signal.removeEventListener('abort', abort); resolve(); }
        signal.addEventListener('abort', abort, {once: true});
      });
    }
    signal.throwIfAborted();
  }
  private prepareV2(node: CompiledNode): PreparedExecutor {
    const registration = this.executors(node);
    if (!registration) throw new Error(`工位 ${node.key} 没有执行器`);
    return typeof registration === 'function' ? {execute: registration} : registration.prepare();
  }
  private pumpV2() {
    if (this.pumpingV2 || !this.running || this.paused || this.ending || this.disposedV2 || this.storageErrorV2) return;
    this.pumpingV2 = true;
    try {
      const now = Date.now();
      for (const room of this.collaboration?.board.rooms(undefined, 'open') ?? []) {
        const item = this.store.get(room.item);
        if (item?.status === 'active' && item.roomHolds?.[room.id]) this.driveRoom(room);
      }
      for (const item of admittedCandidates(this.store.list(['queued', 'active']), this.maxActiveItems)) {
        this.atomicTransition(() => { const next = {...item, status: 'active' as const}; this.persist(item, next, {admittedAt: now}); });
      }
      for (const item of this.store.list(['active'])) {
        let next = wakeWaiting(item, now);
        for (const [key, node] of Object.entries(next.nodes)) if (node.status === 'waiting' && node.waitingFor === 'model') {
          const dependency = node.lastFailure?.dependency ?? this.selectedModelDependency(key);
          const circuit = dependency && this.circuitsV2.get(dependency.key);
          if (!circuit || circuit.state === 'open' && circuit.nextAt <= now) {
            node.status = 'ready'; delete node.waitingFor; delete node.nextAt;
          }
        }
        next = advanceItem(next, this.f, this.conditions, now);
        if (JSON.stringify(next) !== JSON.stringify(item)) this.atomicTransition(() => {
          this.persist(item, next);
          this.deliverCompletedStores(item, next);
        });
      }
      for (const {item: snapshot, node} of sortReady(this.store.list(['active']), this.f,
        id => this.store.admittedAt(id), key => this.scopePaused(key))) {
        const item = this.store.get(snapshot.id)!;
        if (item.status !== 'active' || item.nodes[node.key]?.status !== 'ready') continue;
        if (Object.values(item.roomHolds ?? {}).some(hold => hold.nodes.includes(node.key))) continue;
        if (node.kind === 'store') { this.atomicTransition(() => this.finishStore(item, node)); continue; }
        if (!this.runnable(node)) { this.atomicTransition(() => this.parkItem(item, node.key, '这条线还没接工具', 'station_unavailable')); continue; }
        let prepared: PreparedExecutor;
        try { prepared = this.prepareV2(node); }
        catch (error) { prepared = {execute: async () => { throw error; }}; }
        const dependency = prepared.dependency;
        const circuit = dependency && this.circuitsV2.get(dependency.key);
        if (circuit && (circuit.state !== 'open' || circuit.nextAt > now)) {
          this.atomicTransition(() => {
            const next = structuredClone(item), state = next.nodes[node.key];
            state.status = 'waiting'; state.waitingFor = 'model'; state.nextAt = circuit.nextAt;
            state.lastFailure = {...(state.lastFailure ?? classifyFailure(circuit.reason, {stage: 'model'})), dependency};
            this.persist(item, next);
          });
          continue;
        }
        // The breaker already selected the sole trial. Broker still owns all
        // capacity checks; bypassing only its old v1 circuit view is intentional.
        const lease = this.broker.tryAcquire(node.resource, {review: node.kind === 'review' || node.kind === 'gate', dependency, token: item.id});
        if (!lease) continue;
        if (circuit && dependency) {
          const probe = claimModelProbe(circuit, item.id, node.key, this.journal.run, now);
          if (!probe) { lease.release(); continue; }
          this.atomicTransition(() => this.saveCircuit(probe));
        }
        this.launchV2(item, node, prepared, lease);
      }
    } finally { this.pumpingV2 = false; }
  }

  private launchV2(item: ItemState, node: CompiledNode, prepared: PreparedExecutor, lease: Lease) {
    const work: LiveAttempt = {item: item.id, node: node.key, attempt: uid('a'), controller: new AbortController(), lease,
      dependency: prepared.dependency, evidence: [], startedAt: Date.now(), queuedMs: Math.max(0, Date.now() - item.updatedAt)};
    try {
      this.atomicTransition(() => {
        const next = structuredClone(item);
        next.nodes[node.key].status = 'running'; next.nodes[node.key].lastAttempt = work.attempt;
        delete next.nodes[node.key].nextAt; delete next.nodes[node.key].waitingFor;
        this.store.saveAttempt({id: work.attempt, item: item.id, node: node.key, startedAt: work.startedAt,
          status: 'running', body: {dependency: prepared.dependency, queuedMs: work.queuedMs}});
        this.persist(item, next);
        this.journal.append({kind: 'attempt.started', attempt: work.attempt, token: item.id, node: node.key,
          worker: `k-${work.attempt}`, input: item.title ?? item.item, dependency: prepared.dependency});
      });
    } catch (error) { lease.release(); throw error; }
    this.liveV2.set(work.attempt, work);
    const task = Promise.resolve().then(() => this.executeV2(work, node, prepared))
      .catch(error => { console.error('kernel attempt', error); })
      .finally(() => { this.liveV2.delete(work.attempt); work.lease?.release(); this.workV2.delete(task); this.schedule(); });
    this.workV2.add(task);
  }

  private async executeV2(work: LiveAttempt, node: CompiledNode, prepared: PreparedExecutor) {
    const initial = this.store.get(work.item)!;
    const worker = {id: `k-${work.attempt}`, label: node.name, node: node.key, busy: work.item, idleSince: 0};
    const browser = browserAttemptScope(work.controller.signal, fault => work.controller.abort(fault));
    const current = () => {
      const item = this.store.get(work.item);
      return item && item.status === 'active' && item.nodes[node.key]?.status === 'running' && item.nodes[node.key].lastAttempt === work.attempt;
    };
    const responses: ModelResponse[] = [];
    let actualDependency = prepared.dependency;
    const context: StationContext = {
      token: asTokenRun(initial), node, attempt: work.attempt, worker, signal: work.controller.signal,
      redo: initial.nodes[node.key].redo,
      agentBudget: initial.nodes[node.key].agentBudget,
      session: initial.nodes[node.key].session,
      pendingQuestion: initial.nodes[node.key].pendingQuestion,
      resumeQuestion: async signal => {
        const pending = this.store.get(work.item)?.nodes[node.key]?.pendingQuestion;
        const question = pending && this.collaboration?.board.getPost(pending.id);
        if (!pending || !question || question.item !== work.item || question.author !== node.key || question.type !== 'question') {
          throw new ControlError(409, 'question_checkpoint_invalid', '找不到待恢复的原答疑问题');
        }
        const answer = await this.waitForRoom(work.item, node.key, work.attempt,
          () => this.collaboration!.answer(question, signal ? AbortSignal.any([work.controller.signal, signal]) : work.controller.signal));
        return {ok: true, id: question.id, answer};
      },
      waitForRoom: action => this.waitForRoom(work.item, node.key, work.attempt, action),
      checkpointSession: checkpoint => {
        if (!current() || work.controller.signal.aborted) throw new ControlError(409, 'stale_attempt', '当前工位已经变化，不能保存会话');
        this.saveDialogueSession(work.item, node.key, {sessionCheckpoint: checkpoint});
      },
      progress: (text, step) => {
        if (!work.controller.signal.aborted && current()) this.journal.atomic(() => {
          const event = this.journal.append({kind: 'attempt.progress', attempt: work.attempt, text, step});
          this.store.touch(work.item, event.at);
        });
      },
      activity: activity => { this.journal.atomic(() => {
        const event = this.journal.append({kind: 'attempt.activity', attempt: work.attempt, activity});
        if (!work.controller.signal.aborted && current()) this.store.touch(work.item, event.at);
      }); },
      addEvidence: evidence => {
        work.controller.signal.throwIfAborted();
        if (!current()) throw new Error('stale attempt');
        const value: EvidenceRef = {...evidence, station: node.key, token: work.item, attempt: work.attempt, at: Date.now()};
        this.journal.atomic(() => { this.journal.append({kind: 'evidence.added', evidence: value}); });
        work.evidence.push(value.id);
        return value;
      },
    };
    let result: StationResult;
    try {
      work.controller.signal.throwIfAborted();
      result = await withModelAdmission((dependency, request) => {
        const selected = dependency ?? prepared.dependency;
        if (request) actualDependency = selected;
        const circuit = selected && this.circuitsV2.get(selected.key);
        if (circuit && !(circuit.state === 'trial' && circuit.trialToken === work.item && circuit.station === node.key)) return circuit.reason;
        return this.broker.modelHold;
      }, () => withBrowserAttempt(browser, () => prepared.execute(context)),
      (_dependency, signal) => this.broker.modelRequests.acquire(signal), response => responses.push(response));
    } catch (error) {
      const observed = error as Partial<StationResult>;
      const failure = observed?.failure ?? classifyFailure(error, {url: initial.url,
        stage: node.kind === 'agent' || node.kind === 'review' ? 'model' : undefined});
      result = {ok: false, summary: failure.message, error: failure.message, failure,
        usage: observed?.usage, metrics: observed?.metrics, sessionCheckpoint: observed?.sessionCheckpoint,
        agentContract: observed?.agentContract};
    }
    if (actualDependency) {
      result.metrics = {...result.metrics, dependency: actualDependency};
      if (result.failure) result.failure = {...result.failure, dependency: result.failure.dependency ?? actualDependency};
    }
    if (responses.length) result.metrics = {...result.metrics, modelResponses: responses};
    if (browser.fault) result = {...result, ok: false, failure: {tag: 'browser_capture', category: 'system',
      retryable: true, owner: 'system', code: browser.fault.code, message: browser.fault.message}};
    try {
      // Shutdown must still journal interrupted attempts after dispose has stopped
      // admissions. This synchronous transaction contains no executor or file I/O.
      this.journal.atomic(() => this.finishV2(work, node, result, Boolean(browser.fault)));
    } catch (error) { this.storageErrorV2 = error; this.dispose(); throw error; }
  }

  private finishV2(work: LiveAttempt, node: CompiledNode, result: StationResult, browserFault: boolean) {
    const before = this.store.get(work.item);
    if (!before) return;
    let item = structuredClone(before);
    const state = item.nodes[node.key];
    const live = item.status === 'active' && (state?.status === 'running' || state?.status === 'waiting' && state.waitingFor === 'room') && state.lastAttempt === work.attempt;
    const interrupted = live && this.disposedV2;
    const cancelled = !live || work.controller.signal.aborted && !browserFault;
    const handoff = !result.failure && !browserFault ? result.handoff : undefined;
    const ms = Date.now() - work.startedAt;
    const status = interrupted ? 'interrupted' : cancelled ? 'cancelled' : handoff ? 'handoff' : result.ok ? 'ok' : 'failed';
    this.store.saveAttempt({id: work.attempt, item: item.id, node: node.key, startedAt: work.startedAt,
      endedAt: Date.now(), status, body: {summary: result.summary, error: result.error,
        usage: result.usage, metrics: result.metrics, evidence: work.evidence, queuedMs: work.queuedMs,
        agentContract: result.agentContract, handoff: result.handoff,
        output: cancelled || handoff ? undefined : result.data}});
    this.journal.append({kind: 'attempt.finished', attempt: work.attempt, ok: result.ok && !cancelled && !handoff,
      cancelled: cancelled || interrupted || Boolean(handoff), summary: interrupted ? '进程关闭，工位保留待恢复' : cancelled ? '已取消过期执行结果' : result.summary,
      ms, queuedMs: work.queuedMs, error: interrupted ? 'interrupted' : cancelled ? 'stale' : handoff ? 'handoff' : result.error, usage: result.usage, metrics: result.metrics});
    if (interrupted || cancelled) {
      if (work.dependency) {
        const circuit = this.circuitsV2.get(work.dependency.key);
        if (circuit && modelProbeSucceeded(circuit, item.id, node.key)) this.saveCircuit(releaseModelProbe(circuit, item.id, node.key));
      }
      if (interrupted) {
        if (result.sessionCheckpoint?.pi) {
          state.session = structuredClone(result.sessionCheckpoint.pi);
          item.data.stationSessions = {...item.data.stationSessions as object, [node.key]: state.session};
          this.journal.append({kind: 'token.data', token: item.id, patch: {stationSessions: item.data.stationSessions}});
        }
        if (result.sessionCheckpoint?.closed) {
          item.data.closedStationSessions = {...item.data.closedStationSessions as object, [node.key]: result.sessionCheckpoint.closed};
          this.journal.append({kind: 'token.data', token: item.id, patch: {closedStationSessions: item.data.closedStationSessions}});
        }
        state.status = 'ready';
        this.persist(before, item);
      }
      return;
    }

    const data = handoff ? Object.fromEntries(['stationSessions', 'closedStationSessions']
      .flatMap(key => result.data?.[key] ? [[key, result.data[key]]] : [])) : {...result.data};
    if (result.agentContract) state.agentBudget = structuredClone(result.agentContract.budget);
    for (const key of ['stationSessions', 'closedStationSessions']) if (data[key]) {
      data[key] = {...item.data[key] as object, ...data[key] as object};
    }
    if (result.sessionCheckpoint?.pi) {
      state.session = result.sessionCheckpoint.pi;
      data.stationSessions = {...item.data.stationSessions as object, [node.key]: result.sessionCheckpoint.pi};
    }
    if (result.sessionCheckpoint?.closed) data.closedStationSessions = {...item.data.closedStationSessions as object, [node.key]: result.sessionCheckpoint.closed};
    const session = (data.stationSessions as Record<string, unknown> | undefined)?.[node.key];
    if (session) state.session = session as NonNullable<typeof state.session>;
    if (Object.keys(data).length) {
      item.data = {...item.data, ...data};
      this.journal.append({kind: 'token.data', token: item.id, patch: data});
    }
    for (const note of result.ok ? result.caseNotes ?? [] : []) this.journal.append({kind: 'case.noted', caseId: item.item,
      token: item.id, note: {station: node.key, section: note.section, text: note.text, by: node.key}});

    if (handoff) {
      state.status = 'waiting';
      state.waitingFor = 'budget';
      state.waitingSince = Date.now();
      state.handoff = structuredClone(handoff);
      delete state.nextAt;
      delete state.lastFailure;
      if (work.dependency && modelProbeSucceeded(this.circuitsV2.get(work.dependency.key), item.id, node.key)) {
        this.clearCircuit(work.dependency);
      }
      this.persist(before, item);
      return;
    }

    if (!result.ok) {
      const failure = candidateFailure(result.failure ?? classifyFailure(result.error ?? result.summary,
        {url: item.url, stage: node.kind === 'agent' || node.kind === 'review' ? 'model' : undefined}), String(item.data.canonical ?? item.url));
      state.lastFailure = failure;
      const outcome = planFailure(failure, state.attempts, node.recovery);
      state.attempts = outcome.attempts;
      if (outcome.kind === 'model') {
        const dependency = failure.dependency ?? work.dependency;
        let nextAt = outcome.nextAt ?? Date.now() + 30_000;
        if (dependency) {
          const previous = this.circuitsV2.get(dependency.key);
          const circuit = nextModelFailure(previous, dependency, item.id, node.key, this.journal.run, failure.message);
          nextAt = circuit.nextAt;
          this.saveCircuit(circuit);
          state.lastFailure = {...failure, dependency};
        }
        state.status = 'waiting'; state.waitingFor = 'model'; state.nextAt = nextAt;
        this.persist(before, item);
      } else if (outcome.kind === 'retry') {
        state.status = 'waiting'; state.waitingFor = 'backoff'; state.nextAt = outcome.nextAt;
        this.persist(before, item);
      } else if (outcome.kind === 'return') {
        this.persist(before, item);
        this.returnToken(asTokenRun(item) as TokenRun, node.key, outcome.target ?? 'curation/reader', failure.message, false);
      } else if (outcome.kind === 'exclude') {
        state.status = 'failed'; item.status = 'excluded';
        this.disposition(item, node.key, 'removed', failure);
        this.persist(before, item, {status: 'rejected', reason: failure.message});
      } else {
        state.status = 'failed';
        this.parkItem(item, node.key, failure.message, outcome.code ?? failure.tag, before);
        this.disposition(item, node.key, 'manual', failure);
        this.journal.afterCommit(() => this.onAlert?.(this.tokens.get(item.id)!, node, failure, failure.dependency));
      }
      return;
    }

    if (work.dependency) {
      const circuit = this.circuitsV2.get(work.dependency.key);
      if (modelProbeSucceeded(circuit, item.id, node.key)) this.clearCircuit(work.dependency);
    }
    const wasReturned = Boolean(state.redo);
    delete state.redo; delete state.lastFailure; delete state.handoff; delete state.waitingSince; delete state.pendingQuestion;
    if (this.collaboration) {
      const board = this.collaboration.board;
      board.autoClaim(item, node.key, result.summary, data, work.evidence);
      if (result.verdict?.verdict === 'fix') board.legacyFixes(item, node.key, result.verdict.fixes ?? []);
      const disputed = board.answeredChallenges(item, node.key);
      const fields = new Set<string>();
      for (const challenge of disputed) {
        if (fields.has(challenge.field)) continue;
        fields.add(challenge.field);
        const room = this.collaboration.openRoom(item, challenge.field, challenge.body);
        this.holdRoom(item, room, node.key);
      }
      if (wasReturned) board.resolveChallenges(board.openChallenges(item, node.key)
        .filter(challenge => !disputed.some(value => value.id === challenge.id)).map(challenge => challenge.id));
      if (node.id === 'kind-join' && data.kindAgreed === false) {
        const room = this.collaboration.openRoom(item, 'kind', result.summary);
        this.holdRoom(item, room, node.key);
      }
    }
    if (result.finish) {
      state.status = 'done'; item.status = 'excluded';
      this.disposition(item, node.key, result.finish.status === 'merged' ? 'resolved' : 'removed');
      this.persist(before, item, {status: result.finish.status, reason: result.finish.reason});
      return;
    }
    if (result.verdict && result.verdict.verdict !== 'pass') {
      const verdict = result.verdict;
      const fixes = verdict.fixes ?? [];
      const challenges = this.collaboration?.board.openChallenges(item) ?? [];
      const owner = challenges.filter(challenge => challenge.addressee)
        .sort((a, b) => (this.topo.get(a.addressee!) ?? Infinity) - (this.topo.get(b.addressee!) ?? Infinity))[0]?.addressee;
      const target = owner ?? (verdict.verdict === 'fix' ? [...fixes].sort((a, b) => (this.topo.get(a.station) ?? Infinity) - (this.topo.get(b.station) ?? Infinity))[0]?.station : verdict.returnTo);
      const reason = owner ? challenges.filter(challenge => challenge.addressee === owner).map(challenge => challenge.body).join('\n')
        : verdict.verdict === 'fix' ? fixes.map(fix => fix.problem).join('\n') || verdict.reason : verdict.reason;
      this.journal.append({kind: 'review.verdict', token: item.id, node: node.key, verdict: verdict.verdict === 'escalate' ? 'escalate' : 'return', returnTo: target, reason});
      this.persist(before, item);
      if (verdict.verdict === 'escalate' || !target) this.parkItem(item, node.key, reason, 'review_escalated');
      else this.returnToken(asTokenRun(item) as TokenRun, node.key, target, reason, false);
      return;
    }
    if (result.verdict) this.journal.append({kind: 'review.verdict', token: item.id, node: node.key, verdict: 'pass', reason: result.verdict.reason});
    item = completeNode(item, node.key, data, this.f, this.conditions);
    this.persist(before, item);
    this.deliverChannels(item, node.key, data);
    this.deliverCompletedStores(before, item);
  }

  private disposition(item: ItemState, node: string, disposition: 'removed' | 'manual' | 'resolved', failure?: Failure) {
    this.journal.append({kind: 'candidate.disposition', candidate: {item: item.item, token: item.id, line: item.line,
      url: item.url, title: item.title ?? item.item, source: item.source, recoveryStation: node, disposition, failure}});
  }
  private parkItem(item: ItemState, node: string, reason: string, code: string, previous = item) {
    const next = structuredClone(item);
    next.status = 'parked'; next.parked = {node, reason, code, at: Date.now()};
    this.persist(previous, next, {reason});
  }
  private finishStore(item: ItemState, node: CompiledNode) {
    if (terminal(item) || item.nodes[node.key]?.status !== 'ready') return;
    const next = structuredClone(item);
    next.nodes[node.key].status = 'done';
    if (node.key.endsWith('/published')) {
      next.status = 'published'; next.data.published = true;
      this.journal.append({kind: 'token.data', token: item.id, patch: {published: true}});
    } else if (node.key.endsWith('/manual')) {
      next.status = 'parked'; next.parked = {node: node.key, code: 'manual_store', reason: String(item.data.manualReason ?? '等候人工处理'), at: Date.now()};
    }
    const advanced = terminal(next) ? next : advanceItem(next, this.f, this.conditions);
    this.persist(item, advanced);
    this.deliverChannels(advanced, node.key, {});
  }
  private deliverChannels(item: ItemState, key: string, output: Record<string, unknown>) {
    for (const edge of this.channelsOut.get(key) ?? []) {
      const channel = this.f.channels.find(value => `${value.from.line}/${value.from.station}` === edge.from && `${value.to.line}/${value.to.station}` === edge.to);
      if (channel?.id === 'curation.component-source.confirmed' && (item.data.kind !== 'component-source' || !item.data.kindAgreed)) continue;
      if (edge.when && !this.conditions[edge.when]?.(item.data)) continue;
      const target = this.nodes.get(edge.to);
      if (!target) continue;
      const id = `${item.id}:${target.line}`;
      if (this.store.get(id)) continue;
      const mapping = (edge as CompiledEdge & {input?: Record<string, string | {path?: string; value?: unknown}>}).input;
      const source = {...item.data, ...output, item: item.item, url: item.url, title: item.title};
      const read = (key: string) => key.split('.').reduce<unknown>((value, part) => value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined, source);
      const data = mapping ? Object.fromEntries(Object.entries(mapping).map(([name, selector]) => [name,
        typeof selector === 'string' ? read(selector) : 'value' in selector ? selector.value : read(selector.path ?? '')]))
        : {item: item.item, url: item.url, title: item.title, ...output};
      this.insertItem(id, edge.to, {item: item.item, url: item.url, title: item.title, source: key, data});
    }
  }
  private deliverCompletedStores(previous: ItemState, next: ItemState) {
    for (const [key, state] of Object.entries(next.nodes)) {
      if (state.status === 'done' && previous.nodes[key]?.status !== 'done' && this.nodes.get(key)?.kind === 'store') this.deliverChannels(next, key, {});
    }
  }

  override returnToken(token: TokenRun, from: string, to: string, reason: string, byHuman: boolean, note?: string) {
    this.assertWritable();
    const before = this.store.get(token.id);
    if (!before) return false;
    if (!before.nodes[to]) {
      this.atomicTransition(() => this.parkItem(before, from, `退回目标 ${to} 不在本件流程内：${reason}`, 'invalid_return'));
      return false;
    }
    const edge = (this.returns.get(from) ?? []).find(value => value.to === to);
    // A fix can name any upstream field owner. Page repair has the same bounded
    // fallback when an older pack did not declare a dedicated browser return edge.
    const maximum = edge?.maxRounds ?? 3;
    let succeeded = false;
    this.atomicTransition(() => {
      const next = returnItem(before, this.f, to, {reason, note, byHuman, maxRounds: maximum});
      const reset = [...this.descendants(token, to)];
      this.journal.append({kind: 'token.returned', token: before.id, from, to, reason,
        round: next.nodes[to].rounds, byHuman, reset});
      if (terminal(before) && next.status !== 'parked') { next.status = 'queued'; delete next.parked; }
      if (terminal(before) && !terminal(next)) {
        const previousStore = asTokenRun(before).finishedStore;
        if (previousStore) this.stockDelta(previousStore, -1, '纠错撤回原结果');
      }
      this.persist(before, next, {from, returned: true, reason});
      this.journal.afterCommit(() => {
        for (const work of this.liveV2.values()) if (work.item === token.id && reset.includes(work.node)) work.controller.abort(new Error('returned'));
      });
      succeeded = next.parked?.code !== 'max_rounds';
    });
    this.schedule();
    return succeeded;
  }
  override toManual(token: TokenRun, node: CompiledNode, reason: string) {
    this.atomicTransition(() => { const item = this.store.get(token.id); if (item) this.parkItem(item, node.key, reason, 'manual'); });
  }

  continueBudget(itemId: string, key: string): {item: string; node: string; budget: AgentBudget} {
    this.assertWritable();
    const before = this.store.get(itemId);
    const state = before?.nodes[key];
    if (!before || !state) throw new ControlError(404, 'item_node_not_found', '找不到这件货的工位');
    if (before.status !== 'active' || state.status !== 'waiting' || state.waitingFor !== 'budget') {
      throw new ControlError(409, 'not_waiting_budget', '该工位当前没有等待预算继续');
    }
    if (!state.agentBudget) throw new ControlError(409, 'agent_budget_missing', '交接缺少原预算，无法安全继续');
    const budget = {maxTokens: state.agentBudget.maxTokens * 2, maxMs: state.agentBudget.maxMs * 2};
    if (!Number.isSafeInteger(budget.maxTokens) || !Number.isSafeInteger(budget.maxMs)) {
      throw new ControlError(409, 'agent_budget_limit', '预算已超过可表示的范围');
    }
    this.atomicTransition(() => {
      const next = structuredClone(before);
      next.nodes[key].agentBudget = budget;
      next.nodes[key].status = 'ready';
      delete next.nodes[key].waitingFor;
      delete next.nodes[key].waitingSince;
      delete next.nodes[key].handoff;
      delete next.nodes[key].nextAt;
      this.persist(before, next, {from: 'budget-continued'});
    });
    this.schedule();
    return {item: itemId, node: key, budget};
  }
  override parkRecovery(token: TokenRun, station: string, reason: string) {
    const item = this.store.get(token.id);
    if (!item || !item.nodes[station]) return false;
    this.atomicTransition(() => this.parkItem(item, station, reason, 'retries_exhausted'));
    return true;
  }
  override openConsult(token: TokenRun, reviewer: CompiledNode, fixes: Fix[], reason: string) {
    const target = [...fixes].sort((a, b) => (this.topo.get(a.station) ?? Infinity) - (this.topo.get(b.station) ?? Infinity))[0];
    if (target) this.returnToken(token, reviewer.key, target.station, fixes.map(fix => fix.problem).join('\n') || reason, false);
    else this.toManual(token, reviewer, reason);
  }
  override correct(target: {token: string; node: string; evidence?: string}, reason: string, note?: string) {
    const item = this.store.get(target.token), node = this.nodes.get(target.node);
    if (!item) return {ok: false, message: '找不到这件货'};
    if (!node || !this.runnable(node) || !item.nodes[target.node]) return {ok: false, message: '纠错目标必须是本件货的可执行工位'};
    if (!this.running) this.start('纠错重做');
    const correction = uid('c');
    const last = this.journal.database.prepare("SELECT at, body FROM events WHERE kind = 'token.finished' AND json_extract(body, '$.token') = ? ORDER BY seq DESC LIMIT 1").get(item.id) as {at: number; body: string} | undefined;
    const finished = last ? JSON.parse(last.body) as Extract<JournalEvent, {kind: 'token.finished'}> : undefined;
    const touched = this.journal.database.prepare("SELECT at FROM events WHERE kind IN ('token.created', 'token.queued') AND json_extract(body, '$.token') = ? ORDER BY seq DESC LIMIT 1").get(item.id) as {at: number} | undefined;
    const view = asTokenRun(item);
    let ok = false;
    this.atomicTransition(() => {
      this.journal.append({kind: 'correction.created', correction, ...target, reason, note,
        snapshot: {itemState: item, admittedAt: this.store.admittedAt(item.id), data: item.data,
          checkpoint: {version: 1, entry: item.entry, done: [...view.done], rounds: view.rounds, notes: [...view.notes]},
          status: terminal(item) ? finished?.status ?? 'manual' : 'active',
          touchedAt: touched?.at, finishedAt: terminal(item) ? last?.at : undefined,
          finishedAtNode: terminal(item) ? finished?.node : undefined, reason: terminal(item) ? finished?.reason : undefined,
          finished: terminal(item), finishedStore: view.finishedStore,
          at: Object.keys(item.nodes).filter(key => ['ready', 'running'].includes(item.nodes[key].status))}});
      ok = this.returnToken(this.tokens.get(item.id)!, 'human', target.node, reason, true, note);
    });
    return {ok, correction, message: ok ? `已退回 ${node.name}` : '纠错未执行'};
  }
  override undoCorrection(id: string) {
    const events = [...this.journal.readKinds(['correction.created', 'correction.reverted', 'attempt.started'])];
    const event = events.find(row => row.kind === 'correction.created' && row.correction === id);
    if (event?.kind !== 'correction.created' || !event.snapshot?.itemState) throw new ControlError(409, 'correction_not_reversible', '该纠错没有可撤销快照');
    if (events.some(row => row.seq > event.seq && (row.kind === 'attempt.started' && row.token === event.token || row.kind === 'correction.created' && row.token === event.token || row.kind === 'correction.reverted' && row.correction === id)) || [...this.liveV2.values()].some(work => work.item === event.token)) throw new ControlError(409, 'correction_already_executed', '纠错后已有工位执行，不能撤销');
    const item = event.snapshot.itemState as ItemState;
    if (Object.keys(item.roomHolds ?? {}).some(room => this.collaboration?.board.getRoom(room)?.status !== 'open')) {
      throw new ControlError(409, 'correction_not_reversible', '纠错前的讨论室已经关闭，不能恢复已失效的讨论');
    }
    this.atomicTransition(() => {
      const before = this.store.get(item.id);
      const restoredStore = asTokenRun(item).finishedStore;
      const currentStore = before && asTokenRun(before).finishedStore;
      if (restoredStore && restoredStore !== currentStore) this.stockDelta(restoredStore, 1, '撤销未执行纠错，恢复原库存');
      if (currentStore && currentStore !== restoredStore) this.stockDelta(currentStore, -1, '撤销未执行纠错');
      this.store.save(item, typeof event.snapshot!.admittedAt === 'number' ? event.snapshot!.admittedAt : undefined);
      this.journal.append({kind: 'correction.reverted', correction: id, token: item.id, snapshot: event.snapshot!});
      this.journal.afterCommit(() => this.syncView(item));
    });
    this.schedule();
    return {ok: true, correction: id, token: item.id, message: '已恢复纠错前的状态'};
  }

  // These helpers are retained for explicit import/retry integrations. Mutable
  // TokenRun views never control scheduling until checkpoint is called.
  override checkpoint(token: TokenRun) {
    const previous = this.store.get(token.id);
    if (!previous) throw new ControlError(404, 'token_not_found', '没有这件货');
    if (!this.nodes.has(token.entry)) throw new ControlError(422, 'invalid_checkpoint', '检查点入口不存在');
    const closure = closureOf(this.f, token.entry);
    if ([...token.done, ...token.dead, ...Object.keys(token.rounds), ...token.notes.keys()].some(key => !closure.has(key)) ||
        Object.values(token.rounds).some(rounds => !Number.isSafeInteger(rounds) || rounds < 0)) {
      throw new ControlError(422, 'invalid_checkpoint', '检查点包含流程外工位或无效轮数');
    }
    if (token.entry !== previous.entry && [...this.liveV2.values()].some(work => work.item === token.id)) {
      throw new ControlError(409, 'checkpoint_active', '工位执行期间不能改变检查点入口');
    }
    this.atomicTransition(() => {
      const next = structuredClone(previous);
      next.data = structuredClone(token.data);
      const fresh = createItem(this.f, {...previous, entry: token.entry, data: next.data, now: previous.createdAt});
      next.entry = fresh.entry;
      next.line = fresh.line;
      next.nodes = Object.fromEntries(Object.entries(fresh.nodes).map(([key, node]) =>
        [key, previous.nodes[key] ? structuredClone(previous.nodes[key]) : node]));
      for (const [key, node] of Object.entries(next.nodes)) {
        node.rounds = token.rounds[key] ?? node.rounds;
        node.redo = token.notes.get(key);
        if (token.done.has(key)) node.status = 'done';
        else if (token.dead.has(key)) node.status = 'skipped';
        else if (next.entry !== previous.entry || node.status === 'done' || node.status === 'skipped') {
          node.status = key === next.entry ? 'ready' : 'pending';
          delete node.waitingFor;
          delete node.nextAt;
          delete node.waitingSince;
          delete node.handoff;
        }
      }
      next.data.runtimeCheckpoint = {version: 1, entry: next.entry,
        done: Object.keys(next.nodes).filter(key => next.nodes[key].status === 'done'), rounds: token.rounds, notes: [...token.notes]};
      this.journal.append({kind: 'token.data', token: next.id, patch: next.data});
      this.persist(previous, advanceItem(next, this.f, this.conditions));
    });
  }
  override restoreCheckpoint(token: TokenRun) {
    const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
    const checkpoint = token.data.runtimeCheckpoint;
    if (!record(checkpoint) || checkpoint.version !== 1 || typeof checkpoint.entry !== 'string' ||
        !this.nodes.has(checkpoint.entry) || !Array.isArray(checkpoint.done) || !record(checkpoint.rounds)) return false;
    const closure = this.closureOf(checkpoint.entry);
    if (checkpoint.done.some(key => typeof key !== 'string' || !closure.has(key)) ||
        Object.entries(checkpoint.rounds).some(([key, rounds]) => !closure.has(key) || !Number.isSafeInteger(rounds) || Number(rounds) < 0)) return false;
    const notes = checkpoint.notes ?? [];
    if (!Array.isArray(notes) || notes.some(entry => !Array.isArray(entry) || entry.length !== 2 ||
        typeof entry[0] !== 'string' || !closure.has(entry[0]) || !record(entry[1]) ||
        typeof entry[1].reason !== 'string' || typeof entry[1].byHuman !== 'boolean' ||
        entry[1].note !== undefined && typeof entry[1].note !== 'string')) return false;
    const restored: TokenRun = {...token, entry: checkpoint.entry, closure,
      done: new Set(checkpoint.done), dead: new Set(), rounds: {...checkpoint.rounds} as Record<string, number>,
      notes: new Map(notes as [string, NonNullable<ItemState['nodes'][string]['redo']>][]) };
    this.checkpoint(restored);
    Object.assign(token, this.tokens.get(token.id));
    return true;
  }
  override restoreFlow(token: TokenRun) {
    this.checkpoint(token);
  }
  override resumeFrontier(token: TokenRun, _from: string) { this.checkpoint(token); this.schedule(); }
  override readyFrontier(token: TokenRun) { const item = this.store.get(token.id); return item ? Object.keys(item.nodes).filter(key => item.nodes[key].status === 'ready') : []; }
  override awaitingRepair(token: TokenRun, key: string) { return this.store.get(token.id)?.nodes[key]?.waitingFor === 'room'; }
  override occupiesAdmission(token: TokenRun, _targetEntry: string) { return this.store.get(token.id)?.status === 'active'; }
  override selectedModelDependency(key: string) { const node = this.nodes.get(key); try { return node ? this.prepareV2(node).dependency : undefined; } catch { return undefined; } }
  override intakeHold(_entry: string): string | null { return null; }
  override stockDelta(key: string, delta: number, note?: string) {
    this.journal.atomic(() => {
      const value = Math.max(0, (this.stock.get(key) ?? 0) + delta);
      this.journal.append({kind: 'stock.set', node: key, stock: value, note});
      this.journal.afterCommit(() => this.stock.set(key, value));
    });
  }
  override stationNumbers(key: string) {
    const items = this.store.list().filter(item => item.run === this.journal.run && item.nodes[key]);
    const count = (status: string) => items.filter(item => item.nodes[key].status === status).length;
    const ready = count('ready'), running = count('running'), waiting = count('waiting'), done = count('done');
    return {ready, running, waiting, done, parked: items.filter(item => item.status === 'parked' && item.parked?.node === key).length,
      lambda: 0, s: 0, need: 0, samples: done, workers: running, queue: ready, takt: 0, measured: false};
  }

  private saveCircuit(circuit: ModelCircuit) {
    this.journal.append({kind: 'model.circuit', key: circuit.dependency.key, circuit});
    this.journal.afterCommit(() => { this.circuitsV2.set(circuit.dependency.key, circuit); this.publishCircuits(); });
  }
  private clearCircuit(dependency: ModelDependency) {
    this.journal.append({kind: 'model.circuit', key: dependency.key, circuit: null});
    for (const item of this.store.list(['active'])) {
      const next = structuredClone(item);
      let changed = false;
      for (const node of Object.values(next.nodes)) if (node.status === 'waiting' && node.waitingFor === 'model' && node.lastFailure?.dependency?.key === dependency.key) {
        node.status = 'ready'; delete node.waitingFor; delete node.nextAt; changed = true;
      }
      if (changed) this.persist(item, next);
    }
    this.journal.afterCommit(() => { this.circuitsV2.delete(dependency.key); this.publishCircuits(); });
  }
  private publishCircuits() {
    // v2 performs admission by dependency and node, whereas the v1 broker only
    // identifies a trial by token. Capacity remains entirely broker-controlled.
    this.broker.modelCircuits = {};
    this.broker.recoveryToken = null;
  }

  override ensureWorkers(..._args: Parameters<Runtime['ensureWorkers']>): never { return removed(); }
  override setWorkerLock(..._args: Parameters<Runtime['setWorkerLock']>): never { return removed(); }
  override balance(..._args: Parameters<Runtime['balance']>): never { return removed(); }
  override fork(..._args: Parameters<Runtime['fork']>): never { return removed(); }
  override retire(..._args: Parameters<Runtime['retire']>): never { return removed(); }
  override measurementProposal(..._args: Parameters<Runtime['measurementProposal']>): never { return removed(); }
  override decideMeasurement(..._args: Parameters<Runtime['decideMeasurement']>): never { return removed(); }
  override lineTakt(..._args: Parameters<Runtime['lineTakt']>): never { return removed(); }
  override resourceAllocations(..._args: Parameters<Runtime['resourceAllocations']>): never { return removed(); }
}
