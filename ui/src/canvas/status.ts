import { batchSummary, type BatchRecovery } from '../../../shared/batch.ts';
import { latestRunTokens, type AttemptState, type FactoryState, type Light, type TokenState } from '../../../shared/project.ts';
import type { CompiledNode } from '../../../shared/types.ts';

export interface StatusPresentation { label: string; detail: string; light: Light; pulse?: boolean }
type NodeIdentity = Pick<CompiledNode, 'key' | 'line' | 'kind' | 'resource'>;

function modelRecovery(state: FactoryState, now: number): StatusPresentation | undefined {
  const batch = batchSummary(state), circuit = batch?.modelCircuit;
  if (!circuit || batch.status === 'paused' || batch.status === 'stopped') return;
  if (circuit.state === 'trial') return { label: '验证模型恢复', detail: batch.reason, light: 'yellow' };
  if (!circuit.nextAt) return { label: '模型待检查', detail: batch.reason, light: 'red' };
  const seconds = Math.max(0, Math.ceil((circuit.nextAt - now) / 1000));
  return { label: seconds ? '模型冷却' : '等待恢复验证', detail: `${batch.reason}${seconds ? `；最早 ${seconds} 秒后尝试` : ''}`, light: 'yellow' };
}

export function stationStatus(node: NodeIdentity, state: FactoryState, now: number, dormant = false): StatusPresentation {
  const current = state.nodes[node.key], active = current?.active.length ?? 0, queued = current?.queue.length ?? 0;
  if (dormant) return { label: '待接入', detail: '当前不领取任务。', light: 'gray' };
  if (node.kind === 'store' || node.kind === 'source') return { label: '资源库', detail: `当前库存 ${current?.stock ?? 0} 件。库存与发布结果分别统计。`, light: 'idle' };
  const paused = state.run.status === 'paused' ? '本轮已暂停'
    : state.pausedScopes?.lines.includes(node.line) ? '所属流水线已暂停'
    : state.pausedScopes?.stations.includes(node.key) ? '此工位已暂停' : undefined;
  if (active) return { label: paused ? '在途收尾' : '处理中', detail: `${active} 次正在执行${queued ? `，另有 ${queued} 件排队` : ''}。${paused ? `${paused}领取新任务，已开始的处理继续。` : current?.summary ?? ''}`, light: paused ? 'yellow' : 'green', pulse: true };
  if (paused) return { label: '已暂停', detail: `${paused}领取新任务；当前排队 ${queued} 件。`, light: 'yellow' };
  if (queued) {
    const waiting = state.resources.waiting?.[node.key];
    const recovery = modelRecovery(state, now);
    if (recovery && (node.resource === 'model' || waiting?.includes('模型'))) return { ...recovery, detail: `${recovery.detail}；当前排队 ${queued} 件。` };
    return { label: waiting ? '等待资源' : '排队中', detail: waiting ? `等待：${waiting}；当前排队 ${queued} 件。` : `当前排队 ${queued} 件，尚未开始执行。`, light: 'yellow' };
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
  if (state.run.status === 'idle') presentation = { label: '尚未运行', light: 'idle', detail: '本轮尚未开始。' };
  else if (state.run.status === 'ended') presentation = { label: '已结束', light: unresolved ? 'yellow' : 'idle', detail: unresolved ? `运行已结束，仍有 ${unresolved} 件未完成。` : '运行已结束。' };
  else if (state.run.status === 'paused' || batch?.status === 'paused') presentation = { label: executing ? '已暂停 · 收尾中' : '已暂停', light: 'yellow', detail: '停止领取新任务；已开始的处理继续，结果与检查点保留。' };
  else if (recovery) presentation = recovery;
  else if (counts.active) presentation = { label: !executing && allHeld ? '等待调度条件' : '运行中', light: !executing && allHeld ? 'yellow' : 'green', detail: `${counts.active} 件在途，${executing} 次正在执行。${batch?.reason ?? ''}`, pulse: executing > 0 };
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
  if (token.status === 'active') {
    const active = token.attempts.map(id => state.attempts[id]).filter(attempt => attempt && attempt.endedAt === undefined);
    const queued = token.at.filter(key => state.nodes[key]?.queue.includes(token.id));
    if (active.length) return { label: state.run.status === 'paused' ? '在途收尾' : '处理中', detail: `正在执行：${active.map(attempt => attempt.node).join('、')}${queued.length ? `；另在 ${queued.join('、')} 排队` : ''}`, light: state.run.status === 'paused' ? 'yellow' : 'green' };
    const paused = state.run.status === 'paused' || queued.length > 0 && queued.every(key => state.pausedScopes?.stations.includes(key) || state.pausedScopes?.lines.includes(key.split('/')[0]));
    if (paused) return { label: '已暂停', detail: `保留排队位置与已有成果：${queued.join('、') || '等待调度'}`, light: 'yellow' };
    const waiting = [...new Set(queued.map(key => state.resources.waiting[key]).filter(Boolean))];
    const recovery = modelRecovery(state, now);
    if (recovery && waiting.some(reason => reason.includes('模型'))) return recovery;
    if (waiting.length) return { label: '等待资源', detail: waiting.join('；'), light: 'yellow' };
    return { label: queued.length ? '排队中' : '等待调度', detail: queued.length ? `排队工位：${queued.join('、')}` : '当前没有执行中的工位，任务尚未结束；等待下一步调度。', light: 'yellow' };
  }
  if (token.status === 'parked') {
    const recovery = modelRecovery(state, now);
    const disposition = state.recoveries[token.item];
    const failure = token.data.failure as { tag?: string } | undefined ?? (disposition?.token === token.id ? disposition.failure : undefined);
    if (recovery && failure?.tag === 'model_transport') return recovery;
    const batch = batchSummary(state), scheduled = token.data.batchRecovery as BatchRecovery | undefined;
    if (batch?.mode === 'running' && state.run.status === 'running' && scheduled?.nextAt) return { label: '等待自动重试', detail: `已保留检查点；最早 ${Math.max(0, Math.ceil((scheduled.nextAt - now) / 1000))} 秒后按资源空位重试。${token.reason ?? ''}`, light: 'yellow' };
    return { label: '待重试', detail: token.reason || '已退回候选库，保留已完成成果与失败原因。', light: 'yellow' };
  }
  return { label: ({ published: '已发布', merged: '已合并', rejected: '已排除', manual: '待人工', failed: '失败' })[token.status], detail: token.reason ?? '', light: token.status === 'published' ? 'green' : token.status === 'failed' ? 'red' : token.status === 'manual' ? 'yellow' : 'idle' };
}

/** An unreported model response is unknown, even if initialized usage fields are zero. */
export function recordedUsage(attempts: AttemptState[]) {
  const reported = attempts.filter(attempt => attempt.metrics?.usageReported === true || attempt.metrics?.usageReported !== false && (attempt.usage.input > 0 || attempt.usage.output > 0));
  return { total: reported.length || !attempts.length ? reported.reduce((sum, attempt) => sum + attempt.usage.input + attempt.usage.output, 0) : null, reported: reported.length, samples: attempts.length, partial: reported.length > 0 && reported.length < attempts.length };
}
