import crypto from 'node:crypto';
import type { ChannelDelivery, Stamped } from '../shared/types.ts';
import type { Factory } from './factory.ts';
import { ControlError } from './errors.ts';

type Host = Pick<Factory, 'journal' | 'runtime' | 'compiled' | 'state' | 'workflowPacks'>;
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
  private unsubscribe: () => void;
  private scheduled = false;
  private closed = false;
  constructor(factory: Host) {
    this.f = factory;
    const tokenData = new Map<string, Record<string, unknown>>(), emissions: { event: Extract<Stamped, { kind: 'channel.emitted' }>; data: Record<string, unknown> }[] = [];
    for (const event of factory.journal.read()) {
      if (event.kind === 'token.data') tokenData.set(event.token, { ...tokenData.get(event.token), ...structuredClone(event.patch) });
      if (event.kind === 'channel.delivery') this.deliveries.set(event.delivery.id, event.delivery);
      if (event.kind === 'channel.emitted') emissions.push({ event, data: channelPayload(tokenData.get(event.token) ?? {}) });
    }
    this.unsubscribe = process.env.FACTORY_READONLY === '1' ? () => {} : factory.journal.subscribe(event => this.observe(event));
    if (process.env.FACTORY_READONLY === '1') return;
    // Recover a crash after emission but before its consumer recorded a delivery.
    for (const { event, data } of emissions) this.receive(event, data, true);
    for (const delivery of this.deliveries.values()) if (delivery.targetToken) this.acknowledge(delivery.targetToken);
    for (const token of Object.values(factory.state.tokens)) if (token.status === 'published') this.continueComponents(token.id);
    this.schedule();
  }
  status() { return [...this.deliveries.values()].map(delivery => structuredClone(delivery)); }
  private append(delivery: ChannelDelivery) { this.f.journal.append({ kind: 'channel.delivery', delivery: structuredClone(delivery) }); }
  private receive(event: Extract<Stamped, { kind: 'channel.emitted' }>, data = channelPayload(this.f.state.tokens[event.token]?.data ?? {}), historical = false) {
    const id = deliveryId(event.channel, event.token, data);
    if (this.deliveries.has(id)) return;
    const channel = this.f.compiled.channels.find(channel => channel.id === event.channel), token = this.f.state.tokens[event.token];
    const target = channel ? `${channel.to.line}/${channel.to.station}` : '';
    this.f.runtime.atomicTransition(() => {
      this.append({ id, channel: event.channel, sourceToken: event.token, target, item: event.item, url: token?.url ?? '', title: token?.title, data, attempts: 0, status: target ? 'pending' : 'blocked', ...(target ? {} : { reason: '信道定义当前不可用，保留原始投递等待修复' }) });
      if (event.inventory === 'consumer' && this.f.runtime.nodes.get(target)?.kind === 'store') this.f.runtime.stockDelta(target, 1, '信道已持久排队，等待下游领取');
    });
  }
  private observe(event: Stamped) {
    if (this.closed) return;
    if (event.kind === 'channel.emitted') this.receive(event);
    if (event.kind === 'channel.delivery') {
      this.deliveries.set(event.delivery.id, event.delivery);
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
    this.append({ id, channel: 'components.continuation', sourceToken: token.id, target: 'components/discover', item: `${sourceItem}#components-${cursor}`, url: token.url, title: token.title, data, attempts: 0, status: 'pending' });
  }
  private acknowledge(tokenId: string) {
    const token = this.f.state.tokens[tokenId]; if (!token || token.status === 'active') return;
    for (const delivery of this.deliveries.values()) {
      if (!delivery.targetToken || delivery.status === 'acknowledged') continue;
      let current: typeof token | undefined = token;
      const visited = new Set<string>();
      while (current && current.id !== delivery.targetToken && !visited.has(current.id)) { visited.add(current.id); current = this.f.state.tokens[String(current.data.retryOf ?? '')]; }
      if (!current || current.id !== delivery.targetToken) continue;
      const status = token.status === 'published' || token.status === 'merged' ? 'acknowledged' : 'failed';
      if (delivery.status === status && delivery.targetToken === tokenId) continue;
      this.append({ ...delivery, targetToken: tokenId, status, reason: token.reason });
    }
  }
  retry(id: string) {
    if (process.env.FACTORY_READONLY === '1') throw new ControlError(403, 'read_only', '只读项目不能重试信道投递');
    const delivery = this.deliveries.get(id);
    if (!delivery) throw new ControlError(404, 'channel_delivery_not_found', '没有这次信道投递');
    if (delivery.status === 'acknowledged' || delivery.targetToken && this.f.state.tokens[delivery.targetToken]?.status === 'active') return structuredClone(delivery);
    this.f.runtime.atomicTransition(() => {
      if (delivery.status === 'failed' && this.f.runtime.nodes.get(delivery.target)?.kind === 'store') this.f.runtime.stockDelta(delivery.target, 1, '失败信道投递重新排队');
      this.append({ ...delivery, status: 'pending', targetToken: undefined, reason: undefined });
    }); this.pump();
    return structuredClone(this.deliveries.get(id)!);
  }
  schedule() {
    if (this.closed || this.scheduled) return;
    this.scheduled = true; queueMicrotask(() => { this.scheduled = false; if (!this.closed) try { this.pump(); } catch (error) { console.error('channel delivery', error); } });
  }
  pump() {
    const f = this.f;
    if (this.closed || !f.runtime.running || f.runtime.paused || f.runtime.ending) return;
    for (const delivery of this.deliveries.values()) {
      if (!['pending', 'blocked'].includes(delivery.status)) continue;
      const channel = f.compiled.channels.find(channel => channel.id === delivery.channel);
      const target = channel ? `${channel.to.line}/${channel.to.station}` : delivery.target;
      if (f.runtime.scopePaused(target)) continue;
      const node = f.runtime.nodes.get(target), line = node && f.compiled.lines.find(line => line.id === node.line);
      if (!node || !line?.wired || node.dormant) {
        if (delivery.status !== 'blocked') this.append({ ...delivery, status: 'blocked', reason: '下游工位尚未接线，消息保留等待接入' });
        continue;
      }
      const pack = f.workflowPacks?.manifests.find(pack => pack.lines.some(line => line.id === node.line));
      f.runtime.atomicTransition(() => {
        if (node.kind === 'store') f.runtime.stockDelta(target, -1, '信道消息由下游工位领取');
        const token = f.runtime.create(target, { item: delivery.item, url: delivery.url, title: delivery.title, source: `channel:${delivery.channel}`, data: { ...channelPayload(delivery.data), express: true, channelDelivery: delivery.id, ...(pack ? { workflowPack: pack.id } : {}) } });
        this.append({ ...delivery, target, targetToken: token.id, attempts: delivery.attempts + 1, status: 'delivered', reason: undefined });
      });
    }
  }
  close() { this.closed = true; this.unsubscribe(); }
}
