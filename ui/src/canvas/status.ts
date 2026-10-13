import { batchSummary, type BatchRecovery } from '../../../shared/batch.ts';
import { latestRunTokens, type AttemptState, type FactoryState, type Light, type TokenState } from '../../../shared/project.ts';
import type { CompiledNode, ModelDependency, StationAgentBinding } from '../../../shared/types.ts';

export interface NodeExecution {
  readonly adapter: string;
  readonly model: string;
  readonly at: number;
}

export function recordNodeExecution(index: Record<string, NodeExecution>, attempt: AttemptState | undefined) {
  const execution = attempt?.metrics?.execution;
  if (attempt && execution && attempt.startedAt >= (index[attempt.node]?.at ?? 0)) {
    index[attempt.node] = {...execution, at: attempt.startedAt};
  }
}

export function executionIndex(state: FactoryState) {
  const index: Record<string, NodeExecution> = {};
  for (const attempt of Object.values(state.attempts)) {
    recordNodeExecution(index, attempt);
  }
  return index;
}

const adapterNames: Record<string, string> = {
  pi: 'Pi',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
  launcher: 'launcher',
  'closed-command': 'launcher',
};

export function nodeExecutionPresentation(
  node: Pick<CompiledNode, 'kind'>,
  actual: NodeExecution | undefined,
  metadata: {effective: StationAgentBinding | null; error?: string} | undefined,
  replay = false,
) {
  if (node.kind === 'source' || node.kind === 'store') {
    return {label: node.kind === 'store' ? '资源库' : '来源', usesModel: false};
  }
  const usesModel = Boolean(metadata) || node.kind === 'agent' || node.kind === 'review';
  if (!usesModel) {
    return {label: node.kind === 'gate' ? '规则门禁 · 程序' : '程序执行', usesModel: false};
  }
  if (actual) {
    const adapter = adapterNames[actual.adapter] ?? actual.adapter;
    const model = actual.model === 'unreported' ? '模型未回报' : actual.model;
    return {label: `${adapter} · ${model}（实际）`, usesModel};
  }
  if (replay) {
    return {label: 'Agent · 历史执行模型未记录', usesModel};
  }
  if (metadata?.error) {
    return {label: 'Agent · 配置错误', usesModel};
  }
  const binding = metadata?.effective;
  const adapter = binding ? adapterNames[binding.adapter] ?? binding.adapter : '';
  return {
    label: binding ? `${adapter} · ${binding.model || '默认模型'}（配置）` : 'Agent · 配置待同步',
    usesModel,
  };
}

export interface StatusPresentation { label: string; detail: string; light: Light; pulse?: boolean }
type NodeIdentity = Pick<CompiledNode, 'key' | 'line' | 'kind' | 'resource'>;

interface RuntimeRecovery {
  version: 1;
  runId: string;
  kind: 'network' | 'model';
  state: 'waiting' | 'trial' | 'completed' | 'exhausted' | 'blocked';
  station: string;
  nextAt: number;
  networkAttempts: number;
  modelFailures: number;
  failureAttempt: string;
  dependency?: ModelDependency;
  reason?: string;
}

function runtimeRecovery(token: TokenState, state: FactoryState): RuntimeRecovery | undefined {
  const value = token.data.__runtimeRecovery;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (token.touchedAt ?? token.createdAt) < state.run.startedAt ||
      typeof token.data.retriedBy === 'string' && state.tokens[token.data.retriedBy]?.item === token.item ||
      ['published', 'merged', 'rejected'].includes(token.status)) return;
  const plan = value as Record<string, unknown>;
  const dependency = plan.dependency as Partial<ModelDependency> | undefined;
  if (dependency !== undefined && (!dependency || typeof dependency !== 'object' ||
      typeof dependency.key !== 'string' || typeof dependency.model !== 'string' ||
      !['pi', 'claude-code', 'opencode', 'codex', 'launcher'].includes(String(dependency.adapter)) ||
      dependency.provider !== undefined && typeof dependency.provider !== 'string')) return;
  if (state.batch?.runId === state.run.id && !dependency) return;
  if (plan.version !== 1 || plan.runId !== state.run.id ||
      !['network', 'model'].includes(String(plan.kind)) ||
      !['waiting', 'trial', 'completed', 'exhausted', 'blocked'].includes(String(plan.state)) ||
      typeof plan.station !== 'string' || !plan.station || typeof plan.failureAttempt !== 'string' ||
      ![plan.nextAt, plan.networkAttempts, plan.modelFailures].every(value => Number.isSafeInteger(value) && Number(value) >= 0) ||
      plan.reason !== undefined && typeof plan.reason !== 'string') return;
  if (plan.state === 'completed') return;
  if (plan.state === 'waiting' && token.status !== 'active' && token.status !== 'parked') return;
  return plan as unknown as RuntimeRecovery;
}

/** Build once per relevant event batch, never once for each rendered station. */
export function runtimeRecoveryIndex(state: FactoryState): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  if (state.run.status !== 'running' && state.run.status !== 'paused') return index;
  for (const token of latestRunTokens(state)) {
    const plan = runtimeRecovery(token, state);
    if (plan) (index[plan.station] ??= []).push(token.id);
  }
  return index;
}

function runtimeRecoveryStatus(token: TokenState, state: FactoryState, now: number): StatusPresentation | undefined {
  const plan = runtimeRecovery(token, state);
  if (!plan) return;
  const circuit = plan.dependency ? state.modelCircuits?.[plan.dependency.key] : undefined;
  const reason = plan.reason || circuit?.reason || token.reason || '已保留原工位检查点与已有成果。';
  const service = plan.dependency ? `${plan.dependency.provider ?? adapterNames[plan.dependency.adapter]} / ${plan.dependency.model}。` : '';
  const attempts = plan.kind === 'network' ? `网络恢复已尝试 ${plan.networkAttempts}/2 次。`
    : `已记录 ${circuit?.failures ?? plan.modelFailures} 次模型暂态失败；每次只放行一个工位验证。`;
  const detail = `${service}${plan.station}：${reason} ${attempts}`;
  if (plan.state === 'exhausted') return {label: '自动恢复次数耗尽', detail, light: 'red'};
  if (plan.state === 'blocked') return {label: '自动恢复受阻', detail, light: 'red'};
  if (state.run.status === 'ended' || state.run.status === 'idle') {
    return {label: '自动恢复已停止', detail: `本轮未运行，自动恢复不会继续。${detail}`, light: 'yellow'};
  }
  const paused = state.run.status === 'paused' || state.pausedScopes?.stations.includes(plan.station) ||
    state.pausedScopes?.lines.includes(plan.station.split('/')[0]);
  if (paused) return {label: '恢复已暂停', detail: `领取已暂停，恢复计划和检查点保留；继续后仍需资源空位。${detail}`, light: 'yellow'};
  if (circuit?.state === 'blocked') return {label: '模型服务待处理', detail, light: 'red'};
  if (circuit?.state === 'trial' && circuit.trialToken !== token.id) {
    return {label: '等待服务验证', detail: `同一模型服务正由另一件任务验证，当前任务保留检查点等待。${detail}`, light: 'yellow'};
  }
  if (plan.state === 'waiting') {
    const seconds = Math.max(0, Math.ceil((Math.max(plan.nextAt, circuit?.nextAt ?? 0) - now) / 1000));
    return {
      label: seconds ? plan.kind === 'model' ? '模型冷却' : '等待自动恢复' : '等待恢复条件',
      detail: `${seconds ? `最早 ${seconds} 秒后具备恢复时间条件；仍需等待调度放行。` : '恢复时间已到，等待调度条件放行，尚未开始执行。'}${detail}`,
      light: 'yellow',
    };
  }
  if (token.status !== 'active') return {label: '恢复验证未完成', detail, light: 'yellow'};
  const executing = token.attempts.some(id => {
    const attempt = state.attempts[id];
    return attempt?.node === plan.station && attempt.endedAt === undefined;
  });
  return {label: executing ? plan.kind === 'model' ? '验证模型恢复' : '正在自动恢复' : '等待恢复验证',
    detail: `${executing ? '原工位正在执行恢复验证。' : '恢复任务已领取，尚未开始原工位验证。'}${detail}`,
    light: 'yellow', pulse: executing};
}

function recoveryPresentation(tokens: TokenState[], state: FactoryState, now: number) {
  const presentations = tokens.map(token => runtimeRecoveryStatus(token, state, now)).filter((value): value is StatusPresentation => Boolean(value));
  const chosen = presentations.find(value => value.pulse) ?? presentations.find(value => value.light === 'yellow') ?? presentations[0];
  if (!chosen) return;
  return {...chosen, detail: presentations.length > 1 ? `${presentations.length} 件带有恢复记录。${chosen.detail}` : chosen.detail};
}

function modelRecovery(state: FactoryState, now: number): StatusPresentation | undefined {
  const goal = state.batch?.runId === state.run.id ? state.batch : undefined;
  const circuit = goal?.modelCircuit;
  if (!circuit || goal?.mode !== 'running' || state.run.status !== 'running') return;
  const reason = '模型服务异常，网站检查点已保留；冷却后只用一个真实工位验证恢复。';
  if (circuit.state === 'trial') return { label: '验证模型恢复', detail: reason, light: 'yellow' };
  if (!circuit.nextAt) return { label: '模型待检查', detail: reason, light: 'red' };
  const seconds = Math.max(0, Math.ceil((circuit.nextAt - now) / 1000));
  return { label: seconds ? '模型冷却' : '等待恢复验证', detail: `${reason}${seconds ? `；最早 ${seconds} 秒后尝试` : ''}`, light: 'yellow' };
}

export function stationStatus(node: NodeIdentity, state: FactoryState, now: number, dormant = false, recoveryTokens: readonly string[] = []): StatusPresentation {
  const current = state.nodes[node.key], active = current?.active.length ?? 0, queued = current?.queue.length ?? 0;
  if (dormant) return { label: '待接入', detail: '当前不领取任务。', light: 'gray' };
  if (node.kind === 'store' || node.kind === 'source') return { label: '资源库', detail: `当前库存 ${current?.stock ?? 0} 件。库存与发布结果分别统计。`, light: 'idle' };
  const paused = state.run.status === 'paused' ? '本轮已暂停'
    : state.pausedScopes?.lines.includes(node.line) ? '所属流水线已暂停'
    : state.pausedScopes?.stations.includes(node.key) ? '此工位已暂停' : undefined;
  const recovery = recoveryPresentation(recoveryTokens.map(id => state.tokens[id]).filter(Boolean), state, now);
  if (active) return { label: paused ? '在途收尾' : recovery?.pulse ? recovery.label : '处理中', detail: `${active} 次正在执行${queued ? `，另有 ${queued} 件排队` : ''}。${paused ? `${paused}领取新任务，已开始的处理继续。` : current?.summary ?? ''}${recovery?.detail ?? ''}`, light: paused || recovery ? 'yellow' : 'green', pulse: true };
  if (paused) return { label: '已暂停', detail: `${paused}领取新任务；当前排队 ${queued} 件。${recovery?.detail ?? ''}`, light: 'yellow' };
  if (recovery && (!queued || recovery.light !== 'red')) return {...recovery, detail: `${recovery.detail} 当前排队 ${queued} 件。`};
  if (queued) {
    const waiting = state.resources.waiting?.[node.key];
    const model = modelRecovery(state, now);
    if (model && (node.resource === 'model' || waiting?.includes('模型'))) return { ...model, detail: `${model.detail}；当前排队 ${queued} 件。` };
    return { label: waiting ? '等待资源' : '排队中', detail: `${waiting ? `等待：${waiting}；当前排队 ${queued} 件。` : `当前排队 ${queued} 件，尚未开始执行。`}${recovery?.detail ?? ''}`, light: 'yellow' };
  }
  if (current?.lastFailAt && current.lastFailAt > current.lastOkAt) return { label: '最近执行异常', detail: current.summary || '最近一次执行异常，查看任务的当前处置与恢复状态。', light: 'red' };
  return { label: '待命', detail: `当前无排队和在途任务；本轮成功返回 ${current?.processed ?? 0} 次。工位返回结果不等于任务已发布。`, light: 'idle' };
}

export function runStatus(state: FactoryState, now: number) {
  const items = latestRunTokens(state), batch = batchSummary(state);
  const counts = { total: items.length, active: 0, published: 0, merged: 0, rejected: 0, parked: 0, manual: 0, failed: 0 };
  for (const item of items) counts[item.status]++;
  const unresolved = counts.parked + counts.manual + counts.failed;
  const executing = Object.values(state.nodes).reduce((sum, node) => sum + node.active.length, 0);
  const queued = Object.values(state.nodes).filter(node => node.queue.length);
  const allHeld = queued.length > 0 && queued.every(node => Boolean(state.resources.waiting[node.key]) || state.pausedScopes?.stations.includes(node.key) || state.pausedScopes?.lines.includes(node.key.split('/')[0]));
  let presentation: StatusPresentation;
  const recovery = modelRecovery(state, now);
  const automatic = recoveryPresentation(items, state, now);
  const allActiveRecovering = items.every(token => token.status !== 'active' || Boolean(runtimeRecovery(token, state)));
  if (state.run.status === 'idle') presentation = { label: '尚未运行', light: 'idle', detail: '本轮尚未开始。' };
  else if (state.run.status === 'ended') presentation = { label: '已结束', light: unresolved ? 'yellow' : 'idle', detail: unresolved ? `运行已结束，仍有 ${unresolved} 件未完成。` : '运行已结束。' };
  else if (state.run.status === 'paused' || batch?.status === 'paused') presentation = { label: executing ? '已暂停 · 收尾中' : '已暂停', light: 'yellow', detail: '停止领取新任务；已开始的处理继续，结果与检查点保留。' };
  else if (recovery) presentation = recovery;
  else if (automatic?.pulse) presentation = automatic;
  else if (automatic && !executing && (!counts.active || allActiveRecovering && automatic.light !== 'red')) presentation = automatic;
  else if (counts.active) presentation = { label: !executing && allHeld ? '等待调度条件' : '运行中', light: automatic || !executing && allHeld ? 'yellow' : 'green', detail: `${counts.active} 件在途，${executing} 次正在执行。${automatic?.detail ?? ''}${batch?.reason ?? ''}`, pulse: executing > 0 };
  else if (automatic) presentation = automatic;
  else if (batch?.status === 'recovering') presentation = { label: '等待自动重试', light: 'yellow', detail: batch.reason };
  else if (unresolved) presentation = { label: '有待处理项', light: 'yellow', detail: `${counts.parked} 件待重试，${counts.manual} 件待人工，${counts.failed} 件失败。` };
  else if (batch?.mode === 'stopped') presentation = { label: '托管已停止', light: 'idle', detail: batch.reason };
  else if (batch?.status === 'blocked') presentation = { label: batch.supplyExhausted && batch.remaining ? '候选不足' : '有待处理项', light: 'yellow', detail: batch.reason };
  else if (batch && batch.remaining && batch.mode === 'running') presentation = { label: '等待补料', light: 'idle', detail: batch.reason };
  else if (!items.length) presentation = { label: '等待投料', light: 'idle', detail: '当前没有本轮任务。' };
  else presentation = { label: counts.published === counts.total ? '已全部发布' : '本批处理结束', light: counts.published ? 'green' : 'idle', detail: '发布、合并与排除分别记录。' };
  const detail = `本轮 ${counts.total} 个独立任务：已发布 ${counts.published}，已合并 ${counts.merged}，已排除 ${counts.rejected}，在途 ${counts.active}，待重试 ${counts.parked}，待人工 ${counts.manual}，失败 ${counts.failed}。${batch ? `网站目标已领取 ${batch.admitted}/${batch.target} 件。` : ''}${presentation.detail}`;
  return { ...presentation, detail, counts, batch };
}

export function tokenStatus(token: TokenState, state: FactoryState, now: number): StatusPresentation {
  if (typeof token.data.retriedBy === 'string' && state.tokens[token.data.retriedBy]?.item === token.item) return { label: '已接续重试', detail: `本记录的检查点已交给 ${token.data.retriedBy}；此处保留原尝试历史。`, light: 'idle' };
  const automatic = runtimeRecoveryStatus(token, state, now);
  if (token.status === 'active') {
    if ((token.touchedAt ?? token.createdAt) < state.run.startedAt || state.run.status === 'ended' || state.run.status === 'idle') {
      return {label: '历史未完成', detail: '本轮未运行或这条记录属于旧轮次；保留原状态和检查点，不表示仍在工作。', light: 'yellow'};
    }
    const active = token.attempts.map(id => state.attempts[id]).filter(attempt => attempt && attempt.endedAt === undefined);
    const queued = token.at.filter(key => state.nodes[key]?.queue.includes(token.id));
    const finishing = state.run.status === 'paused' || active.length > 0 && active.every(attempt =>
      state.pausedScopes?.stations.includes(attempt.node) || state.pausedScopes?.lines.includes(attempt.node.split('/')[0]));
    if (active.length) return { label: finishing ? '在途收尾' : automatic?.pulse ? automatic.label : '处理中', detail: `正在执行：${active.map(attempt => attempt.node).join('、')}${queued.length ? `；另在 ${queued.join('、')} 排队` : ''}。${automatic?.detail ?? ''}`, light: finishing || automatic ? 'yellow' : 'green' };
    const paused = state.run.status === 'paused' || queued.length > 0 && queued.every(key => state.pausedScopes?.stations.includes(key) || state.pausedScopes?.lines.includes(key.split('/')[0]));
    if (paused) return { label: '已暂停', detail: `保留排队位置与已有成果：${queued.join('、') || '等待调度'}。${automatic?.detail ?? ''}`, light: 'yellow' };
    if (automatic) return automatic;
    const waiting = [...new Set(queued.map(key => state.resources.waiting[key]).filter(Boolean))];
    const recovery = modelRecovery(state, now);
    if (recovery && waiting.some(reason => reason.includes('模型'))) return recovery;
    if (waiting.length) return { label: '等待资源', detail: waiting.join('；'), light: 'yellow' };
    return { label: queued.length ? '排队中' : '等待调度', detail: queued.length ? `排队工位：${queued.join('、')}` : '当前没有执行中的工位，任务尚未结束；等待下一步调度。', light: 'yellow' };
  }
  if (token.status === 'parked') {
    if (automatic) return automatic;
    const recovery = modelRecovery(state, now);
    const disposition = state.recoveries[token.item];
    const failure = token.data.failure as { tag?: string } | undefined ?? (disposition?.token === token.id ? disposition.failure : undefined);
    const currentRun = (token.touchedAt ?? token.createdAt) >= state.run.startedAt;
    if (currentRun && recovery && failure?.tag === 'model_transport') return recovery;
    const batch = batchSummary(state), scheduled = token.data.batchRecovery as BatchRecovery | undefined;
    if (currentRun && batch?.mode === 'running' && state.run.status === 'running' && scheduled?.nextAt) return { label: '等待自动重试', detail: `已保留检查点；最早 ${Math.max(0, Math.ceil((scheduled.nextAt - now) / 1000))} 秒后按资源空位重试。${token.reason ?? ''}`, light: 'yellow' };
    return { label: '待重试', detail: token.reason || '已退回候选库，保留已完成成果与失败原因。', light: 'yellow' };
  }
  return { label: ({ published: '已发布', merged: '已合并', rejected: '已排除', manual: '待人工', failed: '失败' })[token.status], detail: automatic ? `${automatic.label}：${automatic.detail}` : token.reason ?? '', light: token.status === 'published' ? 'green' : token.status === 'failed' ? 'red' : token.status === 'manual' ? 'yellow' : 'idle' };
}

/** An unreported model response is unknown, even if initialized usage fields are zero. */
export function recordedUsage(attempts: AttemptState[]) {
  const reported = attempts.filter(attempt => attempt.metrics?.tokenUsage || attempt.metrics?.usageReported === true || attempt.metrics?.usageReported !== false && (attempt.usage.input > 0 || attempt.usage.output > 0));
  return {total: reported.length || !attempts.length ? reported.reduce((sum, attempt) => {
    const usage = attempt.metrics?.tokenUsage ?? attempt.usage;
    return sum + usage.input + usage.output;
  }, 0) : null, reported: reported.length, samples: attempts.length, partial: reported.length > 0 && reported.length < attempts.length};
}
