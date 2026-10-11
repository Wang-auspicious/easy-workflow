import type { FactoryState } from './project.ts';
import { latestRunTokens } from './project.ts';

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
  supplyExhausted?: boolean;
}

export interface BatchRecovery {
  count: number;
  nextAt: number;
  tag: string;
  station: string;
  replan: boolean;
}

export function batchSummary(s: FactoryState) {
  const goal = s.batch;
  if (!goal || goal.runId !== s.run.id) return null;
  const items = latestRunTokens(s);
  const active = items.filter(t => t.status === 'active').length;
  const completed = items.filter(t => ['published', 'merged', 'rejected'].includes(t.status)).length;
  const blocked = items.filter(t => ['manual', 'parked', 'failed'].includes(t.status)).length;
  const recovery = items.filter(t => t.status === 'parked').map(t => t.data.batchRecovery as BatchRecovery | undefined).filter((r): r is BatchRecovery => !!r && r.nextAt > 0);
  const remaining = Math.max(0, goal.target - items.length);
  const paused = goal.mode === 'paused' || s.run.status === 'paused';
  const status = goal.mode === 'stopped' || s.run.status === 'ended' ? 'stopped'
    : paused ? 'paused' : active ? 'running' : recovery.length ? 'recovering'
    : completed >= goal.target ? 'completed' : blocked || goal.supplyExhausted ? 'blocked' : 'running';
  const reason = status === 'completed' ? '目标已处理完，发布、合并与排除分别记录'
    : status === 'paused' ? '本轮已暂停；目标和检查点已保存'
    : status === 'stopped' ? '托管已停止；保留已有成果'
    : status === 'recovering' ? '按退避时间自动从检查点继续'
    : status === 'blocked' ? `${blocked} 件仍未完成${goal.supplyExhausted && remaining ? `；候选库存不足，还缺 ${remaining} 件` : '；已保存具体原因与恢复记录'}`
    : `前段有空位时自动补料，最多 ${goal.maxInFlight} 件同时在途`;
  return { ...goal, status, admitted: items.length, active, completed, blocked, remaining,
    published: items.filter(t => t.status === 'published').length,
    merged: items.filter(t => t.status === 'merged').length,
    rejected: items.filter(t => t.status === 'rejected').length,
    retrying: recovery.length, nextRetryAt: recovery.length ? Math.min(...recovery.map(r => r.nextAt)) : undefined, reason };
}
