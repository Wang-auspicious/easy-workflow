import crypto from 'node:crypto';
import type { ChannelDelivery, Stamped } from '../shared/types.ts';
import type { Factory } from './factory.ts';
import type { TokenRun } from './runtime.ts';
import { ControlError } from './errors.ts';

type Host = Pick<Factory, 'journal' | 'runtime' | 'compiled' | 'state' | 'workflowPacks' | 'sources'>;
const internal = new Set(['runtimeCheckpoint', 'checkpointDone', 'recoveryRoot', 'recoveryStation', 'retryOf', 'retriedBy', 'retryTag', 'batchRecovery', 'capacityWait', 'browserRecoveries', 'published', 'gate', 'digest', 'failure', 'manualReason', 'accessVerified', 'workflowPack', 'channelDelivery', 'sourceCandidate']);
/** A delivery transfers business data, never its parent's scheduler identity. */
export function channelPayload(data: Record<string, unknown>) {
  return structuredClone(Object.fromEntries(Object.entries(data).filter(([key]) => !internal.has(key) && !key.startsWith('__runtime'))));
}
function stable(value: unknown): unknown { return Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, stable(value)])) : value; }
function deliveryId(channel: string, token: string, data: Record<string, unknown>) { return 'delivery-' + crypto.createHash('sha256').update(JSON.stringify([channel, token, stable(data)])).digest('hex').slice(0, 24); }

export class ChannelSupervisor {
  private f: Host;
  private deliveries = new Map<string, ChannelDelivery>();
  private snapshots = new Map<number, Record<string, unknown>>();
  private tokensByDelivery = new Map<string, Set<string>>();
  private deliveryByToken = new Map<string, string>();
  private unsubscribe: () => void;
  private scheduled = false;
  private closed = false;
  constructor(factory: Host) {
    this.f = factory;
    const replayData = new Map<string, Record<string, unknown>>();
    const emissions: Extract<Stamped, { kind: 'channel.emitted' }>[] = [];
    for (const event of factory.journal.read()) {
      this.project(event, replayData);
      if (event.kind === 'channel.emitted') emissions.push(event);
    }
    replayData.clear();
    this.unsubscribe = () => {};
    if (process.env.FACTORY_READONLY === '1') { this.snapshots.clear(); return; }
    const projection = factory.journal.subscribeProjection(event => this.project(event));
    const consumer = factory.journal.subscribe(event => this.observe(event));
    this.unsubscribe = () => { projection(); consumer(); };
    // Recover a crash after emission but before its consumer recorded a delivery.
    for (const event of emissions) this.receive(event);
    for (const delivery of this.deliveries.values()) {
      this.adoptCreated(delivery);
      const current = this.deliveries.get(delivery.id)!;
      if (current.targetToken) this.acknowledge(current.targetToken);
    }
    for (const token of Object.values(factory.state.tokens)) if (token.status === 'published') this.continueComponents(token.id);
    this.schedule();
  }
  /** Projections run for the complete committed batch before any consumer. This
   * keeps nested emissions deduplicated and captures data at the emission seq. */
  private project(event: Stamped, replayData?: Map<string, Record<string, unknown>>) {
    if (event.kind === 'token.data') {
      if (replayData) {
        const data = replayData.get(event.token) ?? {};
        Object.assign(data, event.patch);
        replayData.set(event.token, data);
      }
      if (typeof event.patch.channelDelivery === 'string') this.bindToken(event.patch.channelDelivery, event.token);
    }
    if (event.kind === 'channel.emitted') {
      // Factory's projection applies each event before this projection. Read
      // its state here, before the batch advances, instead of retaining a
      // second complete token-data projection for the lifetime of the app.
      const data = replayData ? replayData.get(event.token) : this.f.state.tokens[event.token]?.data;
      this.snapshots.set(event.seq, channelPayload(data ?? {}));
    }
    if (event.kind === 'channel.delivery') {
      this.deliveries.set(event.delivery.id, event.delivery);
      if (event.delivery.targetToken) this.bindToken(event.delivery.id, event.delivery.targetToken);
    }
  }
  private bindToken(delivery: string, token: string) {
    this.deliveryByToken.set(token, delivery);
    const tokens = this.tokensByDelivery.get(delivery) ?? new Set<string>(); tokens.add(token); this.tokensByDelivery.set(delivery, tokens);
  }
  status() { return [...this.deliveries.values()].map(delivery => structuredClone(delivery)); }
  private append(delivery: ChannelDelivery) { this.f.journal.append({ kind: 'channel.delivery', delivery: structuredClone(delivery) }); }
  private reservation(delivery: ChannelDelivery) {
    return delivery.inventory ?? { node: delivery.target, held: ['pending', 'blocked'].includes(delivery.status) && !delivery.targetToken && this.f.runtime.nodes.get(delivery.target)?.kind === 'store' };
  }
  private receive(event: Extract<Stamped, { kind: 'channel.emitted' }>) {
    const data = this.snapshots.get(event.seq);
    this.snapshots.delete(event.seq);
    if (!data) return;
    const id = deliveryId(event.channel, event.token, data);
    const previous = this.deliveries.get(id);
    if (previous?.emissions?.includes(event.seq)) return;
    const channel = this.f.compiled.channels.find(channel => channel.id === event.channel), token = this.f.state.tokens[event.token];
    const target = channel ? `${channel.to.line}/${channel.to.station}` : '';
    this.f.runtime.atomicTransition(() => {
      if (previous) {
        // Old emitters added one stock unit for EVERY emission. A duplicate
        // payload has only one consumer; remove its extra unit once, durably.
        if (!event.inventory && previous.emissions?.length && this.f.runtime.nodes.get(target)?.kind === 'store') this.f.runtime.stockDelta(target, -1, '旧信道重复事件去重，回收多记库存');
        this.append({ ...previous, emissions: [...(previous.emissions ?? []), event.seq], inventory: this.reservation(previous) });
        return;
      }
      const held = this.f.runtime.nodes.get(target)?.kind === 'store';
      if (event.inventory === 'consumer' && held) this.f.runtime.stockDelta(target, 1, '信道已持久排队，等待下游领取');
      this.append({ id, channel: event.channel, sourceToken: event.token, target, item: event.item, url: token?.url ?? '', title: token?.title, data, attempts: 0, emissions: [event.seq], inventory: { node: target, held }, status: target ? 'pending' : 'blocked', ...(target ? {} : { reason: '信道定义当前不可用，保留原始投递等待修复' }) });
    });
  }
  private observe(event: Stamped) {
    if (this.closed) return;
    if (event.kind === 'channel.emitted') this.receive(event);
    if (event.kind === 'channel.delivery') {
      if (event.delivery.targetToken) this.acknowledge(event.delivery.targetToken);
    }
    if (event.kind === 'token.finished') { this.acknowledge(event.token); if (event.status === 'published') this.continueComponents(event.token); }
    if (['channel.delivery', 'channel.emitted', 'run.started', 'run.resumed', 'scope.paused', 'factory.loaded', 'token.finished'].includes(event.kind)) this.schedule();
  }
  private continueComponents(tokenId: string) {
    const token = this.f.state.tokens[tokenId];
    if (!token || !token.finishedAtNode?.startsWith('components/')) return;
    const found = token.data.componentDiscovery as { all?: unknown[]; total?: number; cursor?: number; next?: number | null } | undefined;
    if (!found || !Array.isArray(found.all) || !Number.isSafeInteger(found.next) || Number(found.next) <= Number(found.cursor ?? 0) || Number(found.next) >= Number(found.total) || found.all.length !== found.total) return;
    const cursor = Number(found.next), root = String(token.data.componentRootToken ?? token.id), sourceItem = String(token.data.componentSourceItem ?? token.item);
    const id = deliveryId('components.continuation', root, { cursor, all: found.all });
    if (this.deliveries.has(id)) return;
    const data: Record<string, unknown> = {
      canonical: token.data.canonical ?? token.url, componentAdapter: token.data.componentAdapter,
      componentDiscovery: { all: structuredClone(found.all), total: found.total }, componentCursor: cursor,
      componentLimit: token.data.componentLimit ?? 20, componentRootToken: root, componentSourceItem: sourceItem,
      parentToken: token.id, input: { ...(token.data.input && typeof token.data.input === 'object' ? channelPayload(token.data.input as Record<string, unknown>) : {}), componentCursor: cursor },
    };
    this.f.runtime.atomicTransition(() => this.append({ id, channel: 'components.continuation', sourceToken: token.id, target: 'components/discover', item: `${sourceItem}#components-${cursor}`, url: token.url, title: token.title, data, attempts: 0, status: 'pending', inventory: { node: 'components/discover', held: false } }));
  }
  private acknowledge(tokenId: string) {
    const token = this.f.state.tokens[tokenId]; if (!token || token.status === 'active') return;
    const id = this.deliveryByToken.get(tokenId), delivery = id && this.deliveries.get(id);
    if (delivery) {
      if (!delivery.targetToken || !['delivered', 'failed'].includes(delivery.status)) return;
      let current: typeof token | undefined = token;
      const visited = new Set<string>();
      while (current && current.id !== delivery.targetToken && !visited.has(current.id)) { visited.add(current.id); current = this.f.state.tokens[String(current.data.retryOf ?? '')]; }
      if (!current || current.id !== delivery.targetToken) return;
      const status = token.status === 'published' || token.status === 'merged' ? 'acknowledged' : 'failed';
      if (delivery.status === status && delivery.targetToken === tokenId) return;
      this.f.runtime.atomicTransition(() => this.append({ ...delivery, targetToken: tokenId, status, reason: token.reason }));
    }
  }
  /** A durable child identity is sufficient to recover an old missing receipt;
   * URL/item equality is not, because another line may share the same case. */
  private adoptCreated(delivery: ChannelDelivery) {
    if (delivery.status === 'acknowledged') return;
    const tokens = [...(this.tokensByDelivery.get(delivery.id) ?? [])].map(id => this.f.state.tokens[id]).filter(Boolean);
    const token = tokens.at(-1);
    if (!token || token.id === delivery.targetToken) return;
    this.f.runtime.atomicTransition(() => this.append({ ...delivery, targetToken: token.id, attempts: Math.max(delivery.attempts, tokens.length), status: 'delivered', inventory: { ...this.reservation(delivery), held: false } }));
    this.acknowledge(token.id);
  }
  retry(id: string) {
    if (process.env.FACTORY_READONLY === '1') throw new ControlError(403, 'read_only', '只读项目不能重试信道投递');
    if (this.closed) throw new ControlError(409, 'channels_closed', '信道调度已关闭');
    const delivery = this.deliveries.get(id);
    if (!delivery) throw new ControlError(404, 'channel_delivery_not_found', '没有这次信道投递');
    if (delivery.status === 'acknowledged' || delivery.targetToken && this.f.state.tokens[delivery.targetToken]?.status === 'active') return structuredClone(delivery);
    if (delivery.status === 'failed') {
      this.retryPlan(delivery);
      this.f.runtime.atomicTransition(() => this.append({ ...delivery, status: 'pending', reason: undefined, inventory: { ...this.reservation(delivery), held: false } }));
    }
    this.pump();
    return structuredClone(this.deliveries.get(id)!);
  }

  /** Resume exactly this failed child; ordinary intake and its turn are separate. */
  resumeFailed(id: string, onClaim?: (token: TokenRun) => void): TokenRun | null {
    const f = this.f;
    if (process.env.FACTORY_READONLY === '1') throw new ControlError(403, 'read_only', '只读项目不能重试信道投递');
    if (this.closed || !f.runtime.running || f.runtime.paused || f.runtime.ending) return null;
    const delivery = this.deliveries.get(id);
    if (!delivery) throw new ControlError(404, 'channel_delivery_not_found', '没有这次信道投递');
    if (delivery.status !== 'failed') return null;
    const {failedAt, entry} = this.retryPlan(delivery);
    if (f.runtime.scopePaused(delivery.target) || f.runtime.scopePaused(failedAt)) return null;
    if (this.childOccupiesAdmission(entry)) return null;
    let token: TokenRun | null = null;
    f.runtime.atomicTransition(() => {
      token = this.resumeChild(delivery);
      this.append({...delivery, targetToken: token.id, attempts: delivery.attempts + 1,
        status: 'delivered', inventory: {...this.reservation(delivery), held: false}, reason: undefined});
      onClaim?.(token);
    });
    return token;
  }
  private retryPlan(delivery: ChannelDelivery) {
    const previous = delivery.targetToken && this.f.state.tokens[delivery.targetToken];
    const saved = previous && previous.data.runtimeCheckpoint as { version?: number; entry?: string; done?: string[]; notes?: unknown; rounds?: unknown } | undefined;
    const failedAt = previous && [previous.finishedAtNode, ...previous.attempts.map(id => this.f.state.attempts[id]?.node).reverse()].find(key => key && this.f.runtime.nodes.has(key) && this.f.runtime.runnable(this.f.runtime.nodes.get(key)!));
    if (!previous || !saved || saved.version !== 1 || !saved.entry || !Array.isArray(saved.done) ||
        !saved.done.every(key => typeof key === 'string') ||
        !Array.isArray(saved.notes) || !saved.rounds || typeof saved.rounds !== 'object' || Array.isArray(saved.rounds) ||
        !Object.values(saved.rounds).every(value => Number.isSafeInteger(value) && value >= 0) ||
        !saved.notes.every(note => Array.isArray(note) && note.length === 2 &&
          typeof note[0] === 'string' && note[1] && typeof note[1].reason === 'string' &&
          typeof note[1].byHuman === 'boolean') ||
        !this.f.runtime.nodes.has(saved.entry) || !failedAt || !this.f.runtime.closureOf(saved.entry).has(failedAt)) {
      throw new ControlError(409, 'channel_checkpoint_missing', '信道子任务缺少可恢复的持久检查点；请恢复原流水线包，不能从入口盲目重做');
    }
    return {previous, saved: structuredClone(previous.data.runtimeCheckpoint), failedAt, entry: saved.entry};
  }
  private resumeChild(delivery: ChannelDelivery): TokenRun {
    const { previous, saved, failedAt } = this.retryPlan(delivery), runtime = this.f.runtime;
    const data = structuredClone(previous.data);
    for (const key of ['failure', 'manualReason', 'retriedBy', 'capacityWait', 'browserRecoveries', 'published']) delete data[key];
    Object.assign(data, { express: true, channelDelivery: delivery.id, retryOf: previous.id, recoveryStation: failedAt });
    const token = runtime.create(failedAt, { item: previous.item, url: previous.url, title: previous.title, source: previous.source, data });
    token.data.runtimeCheckpoint = saved; runtime.restoreCheckpoint(token);
    const invalidated = runtime.descendants(token, failedAt);
    for (const key of invalidated) token.done.delete(key);
    runtime.restoreFlow(token); runtime.resumeFrontier(token, failedAt); runtime.checkpoint(token);
    for (const id of previous.evidence) {
      const evidence = this.f.state.evidence[id];
      if (evidence) this.f.journal.append({ kind: 'evidence.added', evidence: { ...evidence, id: `${evidence.id}-${token.id}`, token: token.id, at: Date.now(), meta: { ...evidence.meta, reusedFrom: evidence.id } } });
    }
    this.f.journal.append({ kind: 'token.data', token: previous.id, patch: { retriedBy: token.id } });
    return token;
  }
  schedule() {
    if (this.closed || this.scheduled) return;
    this.scheduled = true; queueMicrotask(() => { this.scheduled = false; if (!this.closed) try { this.pump(); } catch (error) { console.error('channel delivery', error); } });
  }

  private childOccupiesAdmission(targetEntry: string): boolean {
    for (const id of this.deliveryByToken.keys()) {
      const token = this.f.runtime.tokens.get(id);
      if (token && this.f.runtime.occupiesAdmission(token, targetEntry)) return true;
    }
    return false;
  }

  private sourceOccupiesAdmission(targetEntry: string): boolean {
    const f = this.f;
    if (f.state.batch?.runId === f.state.run.id) return false;
    if (f.sources) {
      const admission = f.sources.unmanagedAdmission(targetEntry, true);
      return admission.active >= admission.maxInFlight || admission.upstream >= admission.intakeWindow;
    }
    return [...f.runtime.tokens.values()].some(token =>
      (token.data.sourceCandidate || token.source.startsWith('source:')) &&
      f.runtime.occupiesAdmission(token, targetEntry));
  }

  pump(): number {
    const f = this.f;
    if (this.closed || process.env.FACTORY_READONLY === '1' || !f.runtime.running || f.runtime.paused || f.runtime.ending) return 0;
    // An unmanaged run shares its next free intake slot with new sources. This
    // direct admission does not call SourceSupervisor.pump, so neither feeder
    // can recursively delegate or yield to a peer that did not create a task.
    if (!f.sources?.channelHasNextTurn()) {
      const admitted = f.sources?.admitUnmanaged(1) ?? 0;
      if (admitted) return admitted;
    }
    for (const delivery of this.deliveries.values()) {
      if (!['pending', 'blocked'].includes(delivery.status)) continue;
      this.adoptCreated(delivery);
      if (this.deliveries.get(delivery.id)?.status !== delivery.status) return 0;
      const channel = f.compiled.channels.find(channel => channel.id === delivery.channel);
      const target = channel ? `${channel.to.line}/${channel.to.station}` : delivery.target;
      if (f.runtime.scopePaused(target)) continue;
      const node = f.runtime.nodes.get(target), line = node && f.compiled.lines.find(line => line.id === node.line);
      if (!node || !line?.wired || node.dormant) {
        if (delivery.status !== 'blocked') this.append({ ...delivery, status: 'blocked', reason: '下游工位尚未接线，消息保留等待接入' });
        continue;
      }
      let entry = target;
      if (delivery.targetToken) {
        try {
          const plan = this.retryPlan(delivery);
          if (f.runtime.scopePaused(plan.failedAt)) continue;
          entry = plan.entry;
        }
        catch (error) { if (delivery.status !== 'blocked') f.runtime.atomicTransition(() => this.append({ ...delivery, status: 'blocked', reason: (error as Error).message })); continue; }
      }
      // Keep one executing or ordinarily queued child. A locally paused child
      // only releases that slot for a target that cannot reach its bottleneck.
      if (this.childOccupiesAdmission(entry) || this.sourceOccupiesAdmission(entry)) continue;
      const pack = f.workflowPacks?.manifests.find(pack => pack.lines.some(line => line.id === node.line));
      f.runtime.atomicTransition(() => {
        const inventory = this.reservation(delivery);
        if (inventory.held) f.runtime.stockDelta(inventory.node, -1, '信道消息由下游工位领取');
        const token = delivery.targetToken ? this.resumeChild(delivery) : f.runtime.create(target, { item: delivery.item, url: delivery.url, title: delivery.title, source: `channel:${delivery.channel}`, data: { ...channelPayload(delivery.data), express: true, channelDelivery: delivery.id, ...(pack ? { workflowPack: pack.id } : {}) } });
        this.append({ ...delivery, target, targetToken: token.id, attempts: delivery.attempts + 1, status: 'delivered', inventory: { node: inventory.node, held: false }, reason: undefined });
      });
      return 1;
    }
    return 0;
  }
  close() { this.closed = true; this.unsubscribe(); }
}
