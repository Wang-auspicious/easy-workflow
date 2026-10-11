import type { Factory } from './factory.ts';
import { latestRunTokens } from '../shared/project.ts';
import { batchSummary, type BatchGoal, type BatchRecovery } from '../shared/batch.ts';
import { ControlError } from './errors.ts';

const TRANSIENT = new Set(['network_timeout', 'network_connection', 'network_dns', 'http_server', 'http_rate_limit', 'browser_capture', 'http_forbidden']);
const REPLAN = new Set(['needs_selection', 'page_unavailable', 'quality_rejected']);

/** Event driven, bounded admission. No model needs to stay in a polling chat. */
export class BatchSupervisor {
  private scheduled = false;
  private pumping = false;
  private factory: Factory;
  constructor(factory: Factory) {
    this.factory = factory;
    factory.journal.subscribe(event => {
      if (['batch.configured', 'run.resumed', 'token.finished', 'token.queued', 'candidate.disposition', 'alert.cleared'].includes(event.kind)) this.schedule();
    });
  }

  configure(options: { target: number; maxInFlight?: number; intakeWindow?: number; category?: string; query?: string }) {
    const f = this.factory;
    if (f.runtime.ending) throw new ControlError(409, 'run_ending', '正在结束上一轮，请等待报告');
    if (!Number.isSafeInteger(options.target) || options.target < 1 || options.target > 10000) throw new ControlError(400, 'invalid_target', '目标必须是 1–10000 个网站');
    const admitted = f.runtime.running ? latestRunTokens(f.state).length : 0;
    if (options.target < admitted) throw new ControlError(409, 'target_below_admitted', `本轮已经领取 ${admitted} 个，目标不能少于已领取数`);
    if (!f.runtime.running) f.runtime.start(`候选 × ${options.target}`);
    const goal: BatchGoal = { runId: f.state.run.id, target: options.target, maxInFlight: options.maxInFlight ?? 12,
      intakeWindow: options.intakeWindow ?? 6, maxRecoveries: 2, mode: 'running', startedAt: f.state.batch?.runId === f.state.run.id ? f.state.batch.startedAt : Date.now(),
      category: options.category, query: options.query };
    f.journal.append({ kind: 'batch.configured', batch: goal });
    f.runtime.resume();
    this.pump();
    return batchSummary(f.state);
  }

  setMode(mode: BatchGoal['mode']) {
    const f = this.factory;
    if (!f.state.batch || f.state.batch.runId !== f.state.run.id) throw new ControlError(409, 'no_batch', '本轮尚未设置托管目标');
    if (mode === 'running' && !f.runtime.running) throw new ControlError(409, 'run_ended', '本轮已经结束；请设置新一轮目标后开始');
    f.journal.append({ kind: 'batch.configured', batch: { ...f.state.batch, mode } });
    if (mode === 'paused') f.runtime.pause();
    if (mode === 'running') f.runtime.resume();
    this.pump();
    return batchSummary(f.state);
  }

  schedule() {
    if (this.scheduled || this.pumping) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }

  pump(now = Date.now()) {
    const f = this.factory, goal = f.state.batch;
    if (this.pumping || !goal || goal.runId !== f.state.run.id || goal.mode !== 'running' || !f.runtime.running || f.runtime.paused || f.runtime.ending || process.env.FACTORY_READONLY === '1') return;
    this.pumping = true;
    try {
      const items = latestRunTokens(f.state);
      let active = items.filter(t => t.status === 'active').length;
      // Reuse late-stage evidence first instead of filling every recovery slot
      // with early reading attempts while downstream review stations sit idle.
      const recoveryOrder = [...items].sort((a, b) =>
        f.compiled.nodes.findIndex(node => node.key === b.finishedAtNode) - f.compiled.nodes.findIndex(node => node.key === a.finishedAtNode));
      for (const token of recoveryOrder) {
        if (token.status !== 'parked') continue;
        const candidate = f.state.recoveries[token.item];
        if (!candidate || candidate.disposition !== 'retry' || candidate.token !== token.id) continue;
        const failure = candidate.failure;
        if (!failure) continue;
        const replan = REPLAN.has(failure.tag);
        if (!replan && !TRANSIENT.has(failure.tag)) continue;
        // Login/TLS/credentials and deterministic tool bugs never enter blind retries.
        const previous = token.data.batchRecovery as BatchRecovery | undefined;
        if (previous?.count && !previous.nextAt && previous.count >= goal.maxRecoveries) continue;
        let recovery = previous;
        if (!recovery?.nextAt) {
          const count = (recovery?.count ?? 0) + 1;
          if (count > goal.maxRecoveries) continue;
          recovery = { count, nextAt: now + (failure.tag === 'http_rate_limit' ? 60000 : 15000) * 2 ** (count - 1),
            tag: failure.tag, station: token.finishedAtNode ?? '', replan };
          f.journal.append({ kind: 'token.data', token: token.id, patch: { batchRecovery: recovery } });
          f.journal.append({ kind: 'dispatch.note', tone: 'info', node: token.finishedAtNode,
            text: `${token.title || token.item}：${replan ? '交阅读员重新查找公开页面' : '已安排从检查点恢复'}（${count}/${goal.maxRecoveries}），其余网站继续` });
        }
        if (recovery.nextAt > now || active >= goal.maxInFlight || f.broker.modelHold) continue;
        const got = f.retryCandidates({ items: [token.item], count: 1, automatic: true, replan: recovery.replan });
        active += got.length;
      }
      const latest = latestRunTokens(f.state);
      active = latest.filter(t => t.status === 'active').length;
      const upstream = latest.filter(t => t.status === 'active' && !f.runtime.tokens.get(t.id)?.done.has('curation/plan')).length;
      const want = Math.max(0, Math.min(goal.target - latest.length, goal.maxInFlight - active, goal.intakeWindow - upstream));
      if (want && !f.broker.modelHold) {
        const got = f.pull(want, { category: goal.category, query: goal.query });
        if ((got.length < want) !== Boolean(goal.supplyExhausted)) f.journal.append({ kind: 'batch.configured', batch: { ...goal, supplyExhausted: got.length < want } });
      }
    } finally { this.pumping = false; }
  }
}
