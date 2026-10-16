import type {FactoryState, TokenState} from './project.ts';
import { latestRunTokens } from './project.ts';
import type {CompiledFactory, ModelCircuit} from './types.ts';

export interface FlowAdmission {
  mode: 'flow';
  maxInFlightLimit: number;
  intakeWindowLimit: number;
}

export interface FlowObservation {
  serviceSeconds: number;
  workers: number;
  samples: number;
}

type FlowFactory = Pick<CompiledFactory, 'nodes' | 'edges' | 'lines'>;

function flowGraph(factory: FlowFactory, entry: string) {
  const next = new Map<string, string[]>();
  for (const edge of factory.edges) {
    if (edge.kind !== 'flow') continue;
    const successors = next.get(edge.from) ?? [];
    successors.push(edge.to);
    next.set(edge.from, successors);
  }
  const closure = new Set<string>();
  const pending = [entry];
  while (pending.length) {
    const key = pending.pop()!;
    if (closure.has(key)) continue;
    closure.add(key);
    pending.push(...(next.get(key) ?? []));
  }
  const wired = new Set(factory.lines.filter(line => line.wired).map(line => line.id));
  const executable = new Map(factory.nodes.filter(node => closure.has(node.key) && wired.has(node.line) &&
    !node.dormant && node.kind !== 'source' && node.kind !== 'store').map(node => [node.key, node]));
  return {next, executable};
}

/** Stores and source nodes pass through to the first executable stage(s). */
export function intakeFrontier(factory: FlowFactory, entry: string): string[] {
  const {next, executable} = flowGraph(factory, entry);
  const frontier: string[] = [];
  const visited = new Set<string>();
  const pending = [entry];
  while (pending.length) {
    const key = pending.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    if (executable.has(key)) frontier.push(key);
    else pending.push(...(next.get(key) ?? []));
  }
  return frontier;
}

export function occupiesIntake(factory: FlowFactory, targetEntry: string,
  token: {entry: string; done: ReadonlySet<string>; dead: ReadonlySet<string>}): boolean {
  const target = new Set(intakeFrontier(factory, targetEntry));
  const frontier = intakeFrontier(factory, token.entry);
  if (!target.size || !frontier.length) return true;
  return frontier.some(key => target.has(key) && !token.done.has(key) && !token.dead.has(key));
}

/** A small work window fills the pipeline without increasing any resource quota. */
export function flowWindow(factory: FlowFactory, entry: string, resources: Record<string, number>,
  observations: ReadonlyMap<string, FlowObservation>, limits: Partial<FlowAdmission> = {}) {
  const maximum = Math.max(1, Math.min(40, limits.maxInFlightLimit ?? 6));
  const intakeMaximum = Math.max(1, Math.min(20, limits.intakeWindowLimit ?? 2));
  const {next, executable} = flowGraph(factory, entry);
  if (!executable.size) return {maxInFlight: 1, intakeWindow: 1};
  const times = new Map<string, number>();
  const workers = new Map<string, number>();
  const resourceWork = new Map<string, number>();
  let takt = 0;
  let parallelism = 1;
  for (const node of executable.values()) {
    const observation = observations.get(node.key);
    const observed = observation && observation.samples >= 10 && Number.isFinite(observation.serviceSeconds);
    const seconds = Math.max(0.001, observed ? observation.serviceSeconds : node.estimateSeconds);
    const count = Math.max(1, Math.min(node.workers.max, observation?.workers ?? node.workers.initial));
    times.set(node.key, seconds);
    workers.set(node.key, count);
    takt = Math.max(takt, seconds / count);
    if (node.resource !== 'none') {
      const capacity = Math.max(0, resources[node.resource] ?? 1);
      if (!capacity) return {maxInFlight: 1, intakeWindow: 1};
      resourceWork.set(node.resource, (resourceWork.get(node.resource) ?? 0) + seconds);
      // Production cannot borrow the review reserve to justify more intake.
      const production = node.resource === 'model' && node.kind !== 'review' && capacity > 1 ? capacity - 1 : capacity;
      parallelism = Math.max(parallelism, Math.min(production, node.workers.max));
    }
  }
  for (const [resource, work] of resourceWork) takt = Math.max(takt, work / Math.max(1, resources[resource] ?? 1));
  const paths = new Map<string, number>();
  const visiting = new Set<string>();
  const pathTime = (key: string): number => {
    if (paths.has(key)) return paths.get(key)!;
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const successors = (next.get(key) ?? []).map(pathTime);
    const seconds = (times.get(key) ?? 0) + Math.max(0, ...successors);
    visiting.delete(key);
    paths.set(key, seconds);
    return seconds;
  };
  const needed = Math.max(Math.min(3, parallelism + 1), Math.ceil(pathTime(entry) / Math.max(0.001, takt)) + 1);
  const maxInFlight = Math.min(maximum, needed);
  const firstWorkers = intakeFrontier(factory, entry).reduce((sum, key) => sum + (workers.get(key) ?? 1), 0);
  return {maxInFlight, intakeWindow: Math.max(1, Math.min(maxInFlight, intakeMaximum, firstWorkers))};
}

/** The goal survives the chat turn and process restart; attempts are not extra sites. */
export interface BatchGoal {
  runId: string;
  target: number;
  maxInFlight: number;
  intakeWindow: number;
  maxRecoveries: number;
  mode: 'running' | 'paused' | 'stopped';
  startedAt: number;
  category?: string;
  query?: string;
  /** An exact retained cohort takes precedence over unrelated fresh sources. */
  candidateIds?: string[];
  supplyExhausted?: boolean;
  /** Missing means an existing or explicitly chosen fixed admission policy. */
  admission?: FlowAdmission;
  /** Shared provider outage, separate from each website's recovery allowance. */
  modelCircuit?: { state: 'open' | 'trial'; failures: number; nextAt: number; trialToken?: string; station?: string };
}

export interface BatchRecovery {
  count: number;
  nextAt: number;
  tag: string;
  station: string;
  replan: boolean;
}

/** Fast initial checks become a single, slow probe during a prolonged outage. */
export function modelRecoveryDelay(failures: number) {
  return failures <= 3 ? 30000 * 2 ** Math.max(0, failures - 1) : 15 * 60 * 1000;
}

/** Website goals own their roots, not independent packs or channel deliveries. */
export function isBatchToken(token: Pick<TokenState, 'data' | 'source' | 'line'>): boolean {
  return !token.data.channelDelivery && !token.data.workflowPack && !token.source.startsWith('channel:') &&
    ['candidates', 'curation'].includes(token.line);
}

/** A website goal counts its own roots; downstream deliveries have their own lifecycle. */
export function latestBatchTokens(s: FactoryState) {
  return latestRunTokens(s).filter(isBatchToken);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Saved recovery choices supersede failed attempts when a station changes model. */
function batchModelCircuits(s: FactoryState, items: readonly TokenState[]): ModelCircuit[] {
  const keys = new Set<string>();
  const add = (value: unknown) => {
    const key = record(value)?.key;
    if (typeof key === 'string') keys.add(key);
  };
  for (const token of items) {
    if (['published', 'merged', 'rejected'].includes(token.status) || token.data.retriedBy) continue;
    const recovery = record(token.data.__runtimeRecovery);
    if (recovery?.runId === s.run.id) {
      if (recovery.kind === 'model' && ['waiting', 'trial', 'blocked'].includes(String(recovery.state))) {
        add(recovery.dependency);
      }
    } else if (token.status !== 'active') {
      const failure = record(token.data.failure);
      if (['model_transport', 'model_unavailable'].includes(String(failure?.tag))) add(failure?.dependency);
    }
    const waiting = record(token.data.modelWait);
    for (const node of token.at) add(record(waiting?.[node])?.dependency);
    for (const id of token.attempts) {
      const attempt = s.attempts[id];
      if (attempt && !attempt.endedAt && token.at.includes(attempt.node)) {
        add(attempt.metrics?.dependency ?? attempt.dependency);
      }
    }
    for (const circuit of Object.values(s.modelCircuits)) {
      if (circuit.state === 'trial' && circuit.trialToken === token.id) add(circuit.dependency);
    }
  }
  return Object.values(s.modelCircuits).filter(circuit => keys.has(circuit.dependency.key));
}

export function batchSummary(s: FactoryState) {
  const goal = s.batch;
  if (!goal || goal.runId !== s.run.id) return null;
  const items = latestBatchTokens(s);
  const active = items.filter(t => t.status === 'active').length;
  const completed = items.filter(t => ['published', 'merged', 'rejected'].includes(t.status)).length;
  const blocked = items.filter(t => ['manual', 'parked', 'failed'].includes(t.status)).length;
  const recovery = items.filter(t => t.status === 'parked').map(t => t.data.batchRecovery as BatchRecovery | undefined).filter((r): r is BatchRecovery => !!r && r.nextAt > 0);
  const modelCircuits = batchModelCircuits(s, items);
  const modelBlocked = Boolean(goal.modelCircuit || modelCircuits.length);
  const modelDeadlines = [goal.modelCircuit, ...modelCircuits]
    .filter(circuit => circuit?.state === 'open' && circuit.nextAt > 0)
    .map(circuit => circuit!.nextAt);
  const remaining = Math.max(0, goal.target - items.length);
  const paused = goal.mode === 'paused' || s.run.status === 'paused';
  const status = goal.mode === 'stopped' || s.run.status === 'ended' ? 'stopped'
    : paused ? 'paused' : modelBlocked ? 'blocked' : active ? 'running' : recovery.length ? 'recovering'
    : completed >= goal.target ? 'completed' : blocked || goal.supplyExhausted ? 'blocked' : 'running';
  const reason = status === 'completed' ? '目标已处理完，发布、合并与排除分别记录'
    : status === 'paused' ? '本轮已暂停；目标和检查点已保存'
    : status === 'stopped' ? '托管已停止；保留已有成果'
    : status === 'recovering' ? '按退避时间自动从检查点继续'
    : goal.modelCircuit ? `模型服务异常，已停止投料；${goal.modelCircuit.state === 'trial' ? '正在用一个真实工位验证恢复' : goal.modelCircuit.nextAt ? goal.modelCircuit.failures > 3 ? '每 15 分钟只用一个真实工位试恢复' : '冷却后用一个真实工位试恢复' : '等待确认模型凭据、额度或证书问题'}，网站检查点已保留`
    : modelCircuits.length ? `模型服务异常，已停止投料；${modelCircuits.some(circuit => circuit.state === 'trial')
      ? '正在用一个真实工位验证恢复' : modelDeadlines.length ? '冷却后用一个真实工位验证恢复'
      : '等待确认模型凭据、额度或证书问题'}；${modelCircuits.map(circuit =>
      `${circuit.dependency.provider ?? circuit.dependency.adapter}/${circuit.dependency.model}：${circuit.reason}`).join('；')}；网站检查点已保留`
    : status === 'blocked' ? `${blocked} 件仍未完成${goal.supplyExhausted && remaining ? `；候选库存不足，还缺 ${remaining} 件` : '；已保存具体原因与恢复记录'}`
    : goal.admission?.mode === 'flow'
      ? `入口工位有空位时持续补料，当前窗口 ${goal.maxInFlight} 件，上限 ${goal.admission.maxInFlightLimit} 件；共享资源配额不变`
      : `前段有空位时自动补料，最多 ${goal.maxInFlight} 件同时在途`;
  return { ...goal, modelCircuits, status, admitted: items.length, active, completed, blocked, remaining,
    published: items.filter(t => t.status === 'published').length,
    merged: items.filter(t => t.status === 'merged').length,
    rejected: items.filter(t => t.status === 'rejected').length,
    retrying: recovery.length, nextRetryAt: modelDeadlines.length ? Math.min(...modelDeadlines)
      : modelBlocked ? undefined : recovery.length ? Math.min(...recovery.map(r => r.nextAt)) : undefined, reason };
}
