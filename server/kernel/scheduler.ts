import type {CompiledFactory, CompiledNode} from '../../shared/types.ts';
import {topologicalOrder, type ItemState} from './item.ts';

export const DEFAULT_MAX_ACTIVE_ITEMS = 12;

export function admittedCandidates(items: readonly ItemState[], maxActiveItems = DEFAULT_MAX_ACTIVE_ITEMS): ItemState[] {
  if (!Number.isSafeInteger(maxActiveItems) || maxActiveItems < 1) throw new RangeError('maxActiveItems must be a positive integer');
  const slots = Math.max(0, maxActiveItems - items.filter(item => item.status === 'active').length);
  return items.filter(item => item.status === 'queued')
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .slice(0, slots);
}

export interface ReadyNode {item: ItemState; node: CompiledNode}

/** Resource acquisition happens after this ordering, using the existing Broker. */
export function sortReady(items: readonly ItemState[], compiled: CompiledFactory,
    admittedAt: (id: string) => number | undefined, scopePaused: (key: string) => boolean = () => false): ReadyNode[] {
  const positions = new Map(topologicalOrder(compiled).map((key, index) => [key, index]));
  const nodes = new Map(compiled.nodes.map(node => [node.key, node]));
  const ready: ReadyNode[] = [];
  for (const item of items) {
    if (item.status !== 'active') continue;
    for (const [key, state] of Object.entries(item.nodes)) {
      const node = nodes.get(key);
      if (state.status === 'ready' && node && !scopePaused(key)) ready.push({item, node});
    }
  }
  return ready.sort((left, right) =>
    (admittedAt(left.item.id) ?? left.item.createdAt) - (admittedAt(right.item.id) ?? right.item.createdAt) ||
    positions.get(left.node.key)! - positions.get(right.node.key)! || left.item.id.localeCompare(right.item.id));
}

export function wakeWaiting(item: ItemState, now = Date.now()): ItemState {
  const next = structuredClone(item);
  if (next.status !== 'active') return next;
  for (const node of Object.values(next.nodes)) {
    if (node.status !== 'waiting' || node.waitingFor !== 'backoff' || node.nextAt === undefined || node.nextAt > now) continue;
    node.status = 'ready';
    delete node.nextAt;
    delete node.waitingFor;
    next.updatedAt = now;
  }
  return next;
}
