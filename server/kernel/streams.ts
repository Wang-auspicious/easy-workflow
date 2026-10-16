import type {FactoryState} from '../../shared/project.ts';
import {ATTENTION_CODES, BUDGET_ATTENTION_MS, type AttentionCard, type KernelStreams,
  type StationNumbers} from '../../shared/streams.ts';
import type {ItemState} from './item.ts';
import type {KernelStore} from './store.ts';

export interface KernelStreamsOptions {
  now: number;
  runId: string;
  alerts?: Readonly<FactoryState['alerts']>;
  patches?: readonly Readonly<FactoryState['patches'][number]>[];
  nodeKeys?: readonly string[];
}

const emptyStation = (): StationNumbers => ({ready: 0, running: 0,
  waiting: {model: 0, budget: 0, room: 0, backoff: 0, resource: 0, supervisor: 0}, done: 0, parked: 0});
const titleOf = (item: ItemState): string => item.title || item.item;
const live = (item: ItemState): boolean => item.status === 'active' || item.status === 'queued';

/** Active work spans runs; published and done are counts for the selected run.
 * Summary waiting categories can overlap when independent branches run together. */
export function kernelStreams(store: Pick<KernelStore, 'list'>, options: KernelStreamsOptions): KernelStreams {
  if (!Number.isFinite(options.now) || options.now < 0 || typeof options.runId !== 'string') {
    throw new TypeError('Kernel stream statistics require an explicit time and run');
  }
  const items = store.list();
  const byId = new Map(items.map(item => [item.id, item]));
  const stations = new Map((options.nodeKeys ?? []).map(key => [key, emptyStation()]));
  const summary = {running: 0, waitingResource: 0, waitingModel: 0, published: 0, needsUser: 0};
  const attention: AttentionCard[] = [];

  for (const item of items) {
    const active = item.status === 'active';
    const nodes = Object.values(item.nodes);
    if (active && nodes.some(node => node.status === 'running')) summary.running++;
    if (active && nodes.some(node => node.status === 'waiting' && node.waitingFor === 'resource')) summary.waitingResource++;
    if (active && nodes.some(node => node.status === 'waiting' && node.waitingFor === 'model')) summary.waitingModel++;
    if (item.run === options.runId && item.status === 'published') summary.published++;

    for (const [key, node] of Object.entries(item.nodes)) {
      const count = stations.get(key) ?? emptyStation();
      stations.set(key, count);
      if (live(item) && node.status === 'ready') count.ready++;
      if (active && node.status === 'running') count.running++;
      if (active && node.status === 'waiting' && node.waitingFor && Object.hasOwn(count.waiting, node.waitingFor)) {
        count.waiting[node.waitingFor]++;
      }
      if (item.run === options.runId && node.status === 'done') count.done++;
      if (item.status === 'parked' && item.parked?.node === key) count.parked++;
      if (active && node.status === 'waiting' && node.waitingFor === 'budget' &&
          node.waitingSince !== undefined && options.now - node.waitingSince > BUDGET_ATTENTION_MS) {
        attention.push({id: `budget:${item.id}:${key}`, item: item.id, node: key, title: titleOf(item),
          reason: '等待预算继续已超过 10 分钟', code: 'budget', at: node.waitingSince + BUDGET_ATTENTION_MS,
          action: 'continue_budget'});
      }
    }
    if (item.status === 'parked' && item.parked && ATTENTION_CODES.has(item.parked.code)) {
      attention.push({id: `parked:${item.id}`, item: item.id, node: item.parked.node, title: titleOf(item),
        reason: item.parked.reason, code: item.parked.code, at: item.parked.at, action: 'view'});
    }
  }

  for (const alert of Object.values(options.alerts ?? {})) {
    const item = alert.token ? byId.get(alert.token) : undefined;
    // A terminal result supersedes a task-scoped reminder, even before an old
    // UI alert projection is cleared. Unscoped reminders remain actionable.
    if (item && !live(item) && item.status !== 'parked') continue;
    const itemKey = item?.id ?? alert.token;
    const sameProblem = attention.some(card => card.item !== undefined && card.item === itemKey &&
      card.id.startsWith('parked:') && (!alert.node || card.node === alert.node));
    if (sameProblem) continue;
    attention.push({id: `alert:${alert.id}`, ...(itemKey ? {item: itemKey} : {}),
      ...(alert.node ? {node: alert.node} : {}), title: item ? titleOf(item) : alert.item || '工作流提醒',
      reason: alert.message, code: alert.kind, at: alert.at, action: 'view'});
  }
  for (const patch of options.patches ?? []) if (patch.status === 'proposed') {
    attention.push({id: `patch:${patch.id}`, title: '补丁待批准', reason: patch.summary,
      code: 'patch_approval', at: patch.at, action: 'approval', patchId: patch.id});
  }
  attention.sort((left, right) => right.at - left.at || left.id.localeCompare(right.id));
  summary.needsUser = attention.length;
  return {summary, attention, stations: Object.fromEntries(stations)};
}
