import type {Failure} from '../../shared/failures.ts';
import type {TokenState} from '../../shared/project.ts';
import type {AgentBudget, AgentHandoff, CompiledFactory} from '../../shared/types.ts';
import type {TokenRun} from '../runtime.ts';
import type {SessionRef} from '../station-session.ts';

export type NodeStatus = 'pending' | 'ready' | 'running' | 'waiting' | 'done' | 'skipped' | 'failed';
export type ItemStatus = 'queued' | 'active' | 'published' | 'parked' | 'excluded' | 'cancelled';
export type Conditions = Record<string, (data: Record<string, unknown>) => boolean>;

export interface NodeState {
  status: NodeStatus;
  attempts: number;
  rounds: number;
  nextAt?: number;
  waitingFor?: 'backoff' | 'model' | 'resource' | 'budget' | 'room' | 'supervisor';
  lastFailure?: Failure;
  lastAttempt?: string;
  session?: SessionRef;
  agentBudget?: AgentBudget;
  handoff?: AgentHandoff;
  waitingSince?: number;
  pendingQuestion?: {id: string; toolCallId: string; askedBy: string; addressee: string};
  redo?: {reason: string; note?: string; byHuman: boolean};
}

export interface ItemState {
  version: 1;
  id: string;
  run: string;
  line: string;
  entry: string;
  item: string;
  url: string;
  title?: string;
  source: string;
  data: Record<string, unknown>;
  nodes: Record<string, NodeState>;
  roomHolds?: Record<string, {field: string; owner: string; nodes: string[]}>;
  status: ItemStatus;
  parked?: {node: string; reason: string; code: string; at: number};
  canary?: string;
  createdAt: number;
  updatedAt: number;
}

export interface NewItem {
  id: string;
  run: string;
  entry: string;
  item: string;
  url: string;
  title?: string;
  source: string;
  data?: Record<string, unknown>;
  now?: number;
}

/** Exactly the v1 flow closure; return/channel edges do not expand an item. */
export function closureOf(compiled: CompiledFactory, entry: string): Set<string> {
  if (!compiled.nodes.some(node => node.key === entry)) throw new Error('Unknown item entry');
  const outgoing = new Map<string, string[]>();
  for (const edge of compiled.edges) if (edge.kind === 'flow') {
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  const seen = new Set([entry]);
  const stack = [entry];
  while (stack.length) for (const target of outgoing.get(stack.pop()!) ?? []) {
    if (seen.has(target)) continue;
    seen.add(target);
    stack.push(target);
  }
  return seen;
}

export function topologicalOrder(compiled: CompiledFactory): string[] {
  const incoming = new Map(compiled.nodes.map(node => [node.key, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of compiled.edges) if (edge.kind === 'flow') {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  const ready = compiled.nodes.filter(node => incoming.get(node.key) === 0).map(node => node.key);
  const ordered: string[] = [];
  for (let index = 0; index < ready.length; index++) {
    const key = ready[index];
    ordered.push(key);
    for (const target of outgoing.get(key) ?? []) {
      const count = incoming.get(target)! - 1;
      incoming.set(target, count);
      if (count === 0) ready.push(target);
    }
  }
  if (ordered.length !== compiled.nodes.length) throw new Error('Item graph contains a flow cycle');
  return ordered;
}

export function createItem(compiled: CompiledFactory, input: NewItem): ItemState {
  const now = input.now ?? Date.now();
  const entry = compiled.nodes.find(node => node.key === input.entry);
  if (!entry) throw new Error('Unknown item entry');
  const nodes = Object.fromEntries([...closureOf(compiled, input.entry)].map(key => [key,
    {status: key === input.entry ? 'ready' : 'pending', attempts: 0, rounds: 0} as NodeState]));
  const sessions = input.data?.stationSessions;
  if (record(sessions)) for (const [key, session] of Object.entries(sessions)) {
    if (Object.hasOwn(nodes, key) && record(session) && typeof session.file === 'string' && typeof session.signature === 'string') {
      nodes[key].session = {file: session.file, signature: session.signature};
    }
  }
  return {version: 1, id: input.id, run: input.run, line: entry.line, entry: input.entry,
    item: input.item, url: input.url, ...(input.title === undefined ? {} : {title: input.title}),
    source: input.source, data: structuredClone(input.data ?? {}), nodes, status: 'queued',
    createdAt: now, updatedAt: now};
}

function advanceMutable(item: ItemState, compiled: CompiledFactory, conditions: Conditions, now: number): void {
  if (!['queued', 'active'].includes(item.status)) return;
  const nodes = new Map(compiled.nodes.map(node => [node.key, node]));
  const incoming = new Map<string, typeof compiled.edges>();
  const held = new Set(Object.values(item.roomHolds ?? {}).flatMap(room => room.nodes));
  for (const edge of compiled.edges) if (edge.kind === 'flow' && Object.hasOwn(item.nodes, edge.from) && Object.hasOwn(item.nodes, edge.to)) {
    const edges = incoming.get(edge.to) ?? [];
    edges.push(edge);
    incoming.set(edge.to, edges);
  }
  for (const key of topologicalOrder(compiled)) {
    if (!Object.hasOwn(item.nodes, key)) continue;
    const state = item.nodes[key];
    if (held.has(key)) continue;
    if (state.status === 'pending') {
      const edges = incoming.get(key) ?? [];
      if (!edges.length || edges.some(edge => !['done', 'skipped'].includes(item.nodes[edge.from].status))) continue;
      const live = edges.some(edge => item.nodes[edge.from].status === 'done' &&
        (!edge.when || Boolean(conditions[edge.when]?.(item.data))));
      state.status = live ? 'ready' : 'skipped';
      item.updatedAt = now;
    }
    const node = nodes.get(key)!;
    if (state.status !== 'ready' || node.kind !== 'store') continue;
    state.status = 'done';
    item.updatedAt = now;
    const hasDownstream = compiled.edges.some(edge => edge.kind === 'flow' && edge.from === key);
    if (hasDownstream && !key.endsWith('/published') && !key.endsWith('/manual')) continue;
    if (key.endsWith('/published')) {
      item.status = 'published';
      item.data.published = true;
    } else {
      item.status = 'parked';
      item.parked = {node: key, reason: String(item.data.manualReason ?? '等候处理'), code: 'manual_store', at: now};
    }
    break;
  }
}

export function advanceItem(item: ItemState, compiled: CompiledFactory, conditions: Conditions, now = Date.now()): ItemState {
  const next = structuredClone(item);
  advanceMutable(next, compiled, conditions, now);
  return next;
}

export function completeNode(item: ItemState, key: string, data: Record<string, unknown> | undefined,
    compiled: CompiledFactory, conditions: Conditions, now = Date.now()): ItemState {
  const next = structuredClone(item);
  if (!Object.hasOwn(next.nodes, key)) throw new Error('Node is outside item closure');
  next.data = {...next.data, ...structuredClone(data ?? {})};
  next.nodes[key].status = 'done';
  delete next.nodes[key].nextAt;
  delete next.nodes[key].waitingFor;
  delete next.nodes[key].redo;
  next.updatedAt = now;
  advanceMutable(next, compiled, conditions, now);
  return next;
}

export function returnItem(item: ItemState, compiled: CompiledFactory, target: string,
    options: {reason: string; note?: string; byHuman?: boolean; maxRounds: number}, now = Date.now()): ItemState {
  if (!Object.hasOwn(item.nodes, target)) throw new Error('Return target is outside item closure');
  if (!Number.isSafeInteger(options.maxRounds) || options.maxRounds < 0) throw new Error('Invalid return limit');
  const next = structuredClone(item);
  const rounds = next.nodes[target].rounds + Number(!options.byHuman);
  next.nodes[target].rounds = rounds;
  next.updatedAt = now;
  const reset = closureOf(compiled, target);
  for (const [id, hold] of Object.entries(next.roomHolds ?? {})) {
    if (reset.has(hold.owner) || hold.nodes.some(key => reset.has(key))) delete next.roomHolds![id];
  }
  if (next.roomHolds && !Object.keys(next.roomHolds).length) delete next.roomHolds;
  if (!options.byHuman && rounds > options.maxRounds) {
    next.status = 'parked';
    next.nodes[target].status = 'failed';
    next.parked = {node: target, reason: options.reason, code: 'max_rounds', at: now};
    delete next.roomHolds;
    return next;
  }
  for (const key of reset) {
    if (!Object.hasOwn(next.nodes, key)) continue;
    const previous = next.nodes[key];
    next.nodes[key] = {status: key === target ? 'ready' : 'pending', attempts: 0, rounds: previous.rounds,
      ...(previous.session ? {session: previous.session} : {}),
      ...(previous.agentBudget ? {agentBudget: previous.agentBudget} : {})};
  }
  next.nodes[target].redo = {reason: options.reason, byHuman: Boolean(options.byHuman),
    ...(options.note === undefined ? {} : {note: options.note})};
  next.status = item.status === 'active' ? 'active' : 'queued';
  delete next.parked;
  return next;
}

/** Detached compatibility data: executor mutations cannot alter durable state. */
export function asTokenRun(item: ItemState): Readonly<TokenRun> {
  const data = structuredClone(item.data);
  const sessions: Record<string, SessionRef> = {};
  const done = new Set<string>();
  const dead = new Set<string>();
  const inflight = new Set<string>();
  const queuedAt = new Map<string, number>();
  const failures = new Map<string, number>();
  const rounds: Record<string, number> = {};
  const notes: TokenRun['notes'] = new Map();
  for (const [key, node] of Object.entries(item.nodes)) {
    if (node.status === 'done') done.add(key);
    if (node.status === 'skipped') dead.add(key);
    if (node.status === 'running') inflight.add(key);
    if (node.status === 'ready') queuedAt.set(key, item.updatedAt);
    if (node.attempts) failures.set(key, node.attempts);
    rounds[key] = node.rounds;
    if (node.redo) notes.set(key, structuredClone(node.redo));
    if (node.session) sessions[key] = structuredClone(node.session);
  }
  if (Object.keys(sessions).length) data.stationSessions = {...(data.stationSessions as object ?? {}), ...sessions};
  const finishedStore = item.parked?.code === 'manual_store' ? item.parked.node
    : item.status === 'published' ? [...done].findLast(key => key.endsWith('/published')) : undefined;
  return Object.freeze({id: item.id, item: item.item, url: item.url, title: item.title,
    source: item.source, entry: item.entry, data, closure: new Set(Object.keys(item.nodes)),
    done, dead, inflight, queuedAt, failures, rounds, notes, epoch: 0, edgeLive: new Map<string, boolean>(),
    finished: !['queued', 'active'].includes(item.status), finishedStore});
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function validateItem(value: unknown): ItemState {
  if (!record(value) || value.version !== 1 || !['queued', 'active', 'published', 'parked', 'excluded', 'cancelled'].includes(String(value.status)) ||
      !['id', 'run', 'line', 'entry', 'item', 'url', 'source'].every(key => typeof value[key] === 'string') ||
      !count(value.createdAt) || !count(value.updatedAt) || !record(value.data) || !record(value.nodes) || !Object.hasOwn(value.nodes, String(value.entry))) {
    throw new TypeError('Invalid kernel item');
  }
  for (const node of Object.values(value.nodes)) {
    if (!record(node) || !['pending', 'ready', 'running', 'waiting', 'done', 'skipped', 'failed'].includes(String(node.status)) ||
        !count(node.attempts) || !count(node.rounds) || node.nextAt !== undefined && !count(node.nextAt) ||
        node.session !== undefined && (!record(node.session) || typeof node.session.file !== 'string' || typeof node.session.signature !== 'string') ||
        node.agentBudget !== undefined && (!record(node.agentBudget) || typeof node.agentBudget.maxTokens !== 'number' ||
          !Number.isFinite(node.agentBudget.maxTokens) || node.agentBudget.maxTokens <= 0 ||
          typeof node.agentBudget.maxMs !== 'number' || !Number.isFinite(node.agentBudget.maxMs) || node.agentBudget.maxMs < 180_000) ||
        node.waitingSince !== undefined && !count(node.waitingSince)) {
      throw new TypeError('Invalid kernel node');
    }
    const handoff = node.handoff;
    if (handoff !== undefined && (!record(handoff) || typeof handoff.suggestion !== 'string' ||
        !['done', 'evidence', 'remaining'].every(key => Array.isArray(handoff[key]) &&
          (handoff[key] as unknown[]).every(value => typeof value === 'string')))) {
      throw new TypeError('Invalid kernel handoff');
    }
    const pending = node.pendingQuestion;
    if (pending !== undefined && (!record(pending) || !['id', 'toolCallId', 'askedBy', 'addressee'].every(key =>
      typeof pending[key] === 'string' && Boolean((pending[key] as string).trim())))) {
      throw new TypeError('Invalid pending board question');
    }
  }
  if (value.roomHolds !== undefined && (!record(value.roomHolds) || Object.values(value.roomHolds).some(hold =>
    !record(hold) || typeof hold.field !== 'string' || typeof hold.owner !== 'string' ||
    !Object.hasOwn(value.nodes as object, hold.owner) || !Array.isArray(hold.nodes) ||
    hold.nodes.some(key => typeof key !== 'string' || !Object.hasOwn(value.nodes as object, key))))) {
    throw new TypeError('Invalid item discussion hold');
  }
  if (value.status === 'parked' && (!record(value.parked) || typeof value.parked.node !== 'string' ||
      typeof value.parked.reason !== 'string' || typeof value.parked.code !== 'string' || !count(value.parked.at))) {
    throw new TypeError('Invalid parked kernel item');
  }
  return value as unknown as ItemState;
}

export function migrateToken(compiled: CompiledFactory, token: TokenState, run: string,
    conditions: Conditions, now = Date.now()): ItemState {
  const raw = token.data.runtimeCheckpoint;
  const fallback = typeof token.data.recoveryRoot === 'string' && compiled.nodes.some(node => node.key === token.data.recoveryRoot)
    ? token.data.recoveryRoot : token.at.find(key => compiled.nodes.some(node => node.key === key)) ??
      (compiled.nodes.some(node => node.key === `${token.line}/reader`) ? `${token.line}/reader` :
        compiled.nodes.find(node => node.line === token.line && node.kind !== 'source' && node.kind !== 'store')?.key);
  const checkpointEntry = record(raw) && typeof raw.entry === 'string' && compiled.nodes.some(node => node.key === raw.entry) ? raw.entry : undefined;
  const checkpointClosure = checkpointEntry ? closureOf(compiled, checkpointEntry) : new Set<string>();
  const valid = record(raw) && raw.version === 1 && checkpointEntry !== undefined && Array.isArray(raw.done) &&
    raw.done.every(key => typeof key === 'string' && checkpointClosure.has(key)) && record(raw.rounds) &&
    Object.entries(raw.rounds).every(([key, value]) => checkpointClosure.has(key) && count(value));
  const entry = valid ? checkpointEntry : fallback;
  if (!entry) throw new Error('Cannot determine migration entry');
  let item = createItem(compiled, {id: token.id, run, entry, item: token.item, url: token.url,
    title: token.title, source: token.source, data: token.data, now: token.createdAt});
  if (valid) {
    for (const key of raw.done as string[]) item.nodes[key].status = 'done';
    for (const [key, rounds] of Object.entries(raw.rounds as Record<string, number>)) item.nodes[key].rounds = rounds;
    item = advanceItem(item, compiled, conditions, now);
  }
  item.updatedAt = now;
  if (token.status === 'manual') {
    item.status = 'parked';
    item.parked = {node: token.finishedAtNode ?? entry, code: 'manual_store', reason: token.reason ?? String(token.data.manualReason ?? '等候处理'), at: now};
  }
  return item;
}
