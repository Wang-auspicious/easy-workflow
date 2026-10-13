import type { CompiledNode } from '../../../shared/types.ts';
import type { FactoryState, NodeState } from '../../../shared/project.ts';

/** Stock is measured in items; station activity is measured in attempts, including retries. */
export function nodeCountPresentation(node: Pick<CompiledNode, 'key' | 'kind'>, state: NodeState | undefined, factory: Pick<FactoryState, 'attempts' | 'consults' | 'run'>) {
  const resource = node.kind === 'store' || node.kind === 'source';
  const stock = state?.stock ?? 0, added = state?.plus ?? 0, sent = state?.sent ?? 0;
  if (resource) return {
    resource, footer: `流入 ${added.toLocaleString('en-US')} 件`,
    detail: `当前库存 ${stock} 件 · 本轮流入 ${added} 件 · 本轮转出 ${sent} 件`,
  };
  const since = factory.run.startedAt;
  const attempts = Object.values(factory.attempts).filter(attempt => attempt.node === node.key && attempt.startedAt >= since);
  const changes = Object.values(factory.consults).filter(consult => consult.reviewer === node.key && consult.openedAt >= since).length;
  const completed = state?.processed ?? 0, failed = state?.failed ?? 0, passed = state?.passed ?? 0, returned = state?.returned ?? 0;
  const cancelled = attempts.filter(attempt => attempt.cancelled).length;
  return {
    resource, footer: `尝试 ${attempts.length.toLocaleString('en-US')} 次`,
    detail: [
      `本轮尝试 ${attempts.length} 次（含重试）`, `返回结果 ${completed} 次`,
      ...(node.kind === 'review' ? [`审核通过 ${passed} 次`] : []),
      `退回 ${returned} 次`, ...(changes ? [`要求修改 ${changes} 项`] : []), `执行异常 ${failed} 次`,
      ...(cancelled ? [`取消 ${cancelled} 次`] : []), `当前排队 ${state?.queue.length ?? 0} 件`, `进行中 ${state?.active.length ?? 0} 次`,
    ].join(' · '),
  };
}
