import type { Factory } from './factory.ts';
import {batchSummary, flowWindow, latestBatchTokens, modelRecoveryDelay, occupiesIntake,
  type BatchGoal, type BatchRecovery, type FlowObservation} from '../shared/batch.ts';
import { ControlError } from './errors.ts';
import { classifyFailure } from '../shared/failures.ts';

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
      if (factory.importing) return;
      const circuit = factory.state.batch?.modelCircuit;
      if (event.kind === 'attempt.finished' && !event.cancelled &&
          !['stale', 'restart'].includes(event.error ?? '') && circuit?.state === 'trial') {
        const attempt = factory.state.attempts[event.attempt];
        const token = attempt && factory.state.tokens[attempt.token];
        const failure = token?.data.failure as {tag?: string} | undefined;
        const responded = event.metrics?.usageReported && (event.metrics.time?.modelCalls ?? 0) > 0;
        if (attempt?.token === circuit.trialToken && attempt.node === circuit.station && responded &&
            !['model_transport', 'model_unavailable'].includes(failure?.tag ?? '')) {
          this.modelRecovered(event.ok ? undefined : '真实工位已收到模型回答；该任务的业务检查仍未通过，保留单独的失败原因');
        }
      }
      if (event.kind === 'token.finished' && event.token === circuit?.trialToken && circuit.state === 'trial') {
        // A transport-healthy answer may still fail a content check. Keep that
        // item's failure; do not leave the entire provider locked to a dead token.
        const token = factory.state.tokens[event.token];
        if (!['model_transport', 'model_unavailable'].includes((token?.data.failure as {tag?: string})?.tag ?? '')) {
          const attempt = token?.attempts.map(id => factory.state.attempts[id]).reverse()
            .find(value => value?.node === circuit.station && !value.cancelled &&
              !['stale', 'restart'].includes(value.error ?? ''));
          if (attempt?.metrics?.usageReported && (attempt.metrics.time?.modelCalls ?? 0) > 0) {
            this.modelRecovered('真实工位已收到模型回答；该任务的业务检查仍未通过，保留单独的失败原因');
          } else {
            factory.broker.modelHold = '恢复验证尚未完成；等待另一个真实模型工位';
            this.modelFailed();
          }
        }
      }
      if (['batch.configured', 'run.resumed', 'token.finished', 'token.queued', 'candidate.disposition',
        'alert.cleared', 'model.circuit', 'worker.forked', 'worker.retired'].includes(event.kind)) this.schedule();
    });
  }

  modelFailed() {
    const f = this.factory, goal = f.state.batch;
    if (!goal || goal.runId !== f.state.run.id) return;
    const old = goal.modelCircuit;
    // Several workers may finish their failing requests together. That is ONE
    // dependency incident, not several more recovery attempts.
    if (old?.state === 'open') return;
    const failures = (old?.failures ?? 0) + 1;
    f.broker.recoveryToken = null;
    f.journal.append({ kind: 'batch.configured', batch: { ...goal, modelCircuit: {
      state: 'open', failures, nextAt: Date.now() + modelRecoveryDelay(failures),
    } } });
  }

  /** Restore deadlines without a restart shortening a long outage's cooldown. */
  restoreModelCircuit(now = Date.now()) {
    const f = this.factory, goal = f.state.batch, circuit = goal?.modelCircuit;
    if (!goal || goal.runId !== f.state.run.id || !circuit) return;
    const blocked = Object.values(f.state.alerts).some(alert => alert.kind === 'model' && alert.id !== 'model-transport');
    const transport = Object.values(f.state.recoveries).some(candidate => candidate.failure?.tag === 'model_transport' && classifyFailure(candidate.failure.message, { stage: 'model', status: candidate.failure.status }).tag !== 'model_unavailable');
    if (circuit.state === 'open' && (circuit.nextAt > 0 || blocked || !transport)) return;
    const pending = circuit.trialToken && f.state.tokens[circuit.trialToken]?.status === 'active' ? circuit.trialToken : undefined;
    f.journal.append({ kind: 'batch.configured', batch: { ...goal, modelCircuit: {
      ...circuit, state: 'open', trialToken: pending,
      nextAt: circuit.state === 'trial' ? Math.max(circuit.nextAt, now + modelRecoveryDelay(circuit.failures)) : now + modelRecoveryDelay(4),
    } } });
  }

  /** A tiny connectivity probe can permit a trial, never reopen bulk intake. */
  permitModelTrial() {
    const f = this.factory, goal = f.state.batch;
    if (!goal?.modelCircuit || goal.runId !== f.state.run.id || !f.runtime.running) return false;
    f.journal.append({ kind: 'batch.configured', batch: { ...goal, modelCircuit: {
      ...goal.modelCircuit, state: 'open', failures: 0, nextAt: Date.now(), trialToken: undefined,
    } } });
    this.schedule();
    return true;
  }

  private modelRecovered(reason = '真实工位已完成模型任务与提交校验，恢复已有检查点') {
    const f = this.factory, goal = f.state.batch;
    if (!goal?.modelCircuit) return;
    f.journal.append({ kind: 'batch.configured', batch: { ...goal, modelCircuit: undefined } });
    f.broker.recoveryToken = null;
    f.clearAlert('model-transport', reason);
    f.runtime.schedule();
    this.schedule();
  }

  private admission(options: {flow?: boolean; maxInFlight?: number; intakeWindow?: number}, previous?: BatchGoal) {
    if (options.flow !== undefined && typeof options.flow !== 'boolean') throw new ControlError(400, 'invalid_admission', 'flow 必须是布尔值');
    for (const [key, maximum] of [['maxInFlight', 40], ['intakeWindow', 20]] as const) {
      const value = options[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) {
        throw new ControlError(400, 'invalid_admission', `${key} 必须是 1–${maximum} 的整数`);
      }
    }
    const explicit = options.maxInFlight !== undefined || options.intakeWindow !== undefined;
    const flow = options.flow ?? (explicit ? false : !previous || previous.admission?.mode === 'flow');
    if (!flow) return {maxInFlight: options.maxInFlight ?? previous?.maxInFlight ?? 6,
      intakeWindow: options.intakeWindow ?? previous?.intakeWindow ?? 2, admission: undefined};
    const admission = {mode: 'flow' as const,
      maxInFlightLimit: options.maxInFlight ?? previous?.admission?.maxInFlightLimit ?? 6,
      intakeWindowLimit: options.intakeWindow ?? previous?.admission?.intakeWindowLimit ?? 2};
    const f = this.factory;
    const observations = new Map<string, FlowObservation>();
    for (const node of f.compiled.nodes) {
      if (!f.runtime.runnable(node)) continue;
      const numbers = f.runtime.stationNumbers(node.key);
      observations.set(node.key, {serviceSeconds: numbers.s, workers: numbers.workers, samples: numbers.samples});
    }
    const limits = {...f.broker.limits, browser: f.broker.effectiveBrowser()};
    return {...flowWindow(f.compiled, 'candidates/route', limits, observations, admission), admission};
  }

  /** Adjust the existing goal without starting or resuming its run. */
  updateAdmission(options: {flow?: boolean; maxInFlight?: number; intakeWindow?: number}) {
    const f = this.factory;
    const goal = f.state.batch;
    if (options.flow === undefined && options.maxInFlight === undefined && options.intakeWindow === undefined) {
      throw new ControlError(400, 'missing_admission', '请指定 flow、maxInFlight 或 intakeWindow');
    }
    if (!goal || goal.runId !== f.state.run.id) throw new ControlError(409, 'no_batch', '本轮尚未设置托管目标');
    if (!f.runtime.running || f.runtime.ending) throw new ControlError(409, 'run_ended', '本轮已结束或正在结束，不能修改其入场策略');
    const next = {...goal, ...this.admission(options, goal)};
    f.journal.append({kind: 'batch.configured', batch: next});
    if (!f.runtime.paused && next.mode === 'running') this.schedule();
    return batchSummary(f.state);
  }

  configure(options: { target: number; flow?: boolean; maxInFlight?: number; intakeWindow?: number; category?: string; query?: string }) {
    const f = this.factory;
    if (!f.runtime.nodes.has('candidates/route') || !f.runtime.nodes.has('candidates/pool')) throw new ControlError(409, 'candidate_pack_unavailable', '网站批次需要策展候选包；请从当前项目的工作流入口投料');
    if (f.runtime.ending) throw new ControlError(409, 'run_ending', '正在结束上一轮，请等待报告');
    if (!Number.isSafeInteger(options.target) || options.target < 1 || options.target > 10000) throw new ControlError(400, 'invalid_target', '目标必须是 1–10000 个网站');
    const admitted = f.runtime.running ? latestBatchTokens(f.state).length : 0;
    if (options.target < admitted) throw new ControlError(409, 'target_below_admitted', `本轮已经领取 ${admitted} 个，目标不能少于已领取数`);
    const previous = f.state.batch?.runId === f.state.run.id && f.runtime.running ? f.state.batch : undefined;
    const admission = this.admission(options, previous);
    if (!f.runtime.running) f.runtime.start(`候选 × ${options.target}`);
    const goal: BatchGoal = { runId: f.state.run.id, target: options.target, ...admission,
      maxRecoveries: 2, mode: 'running', startedAt: f.state.batch?.runId === f.state.run.id ? f.state.batch.startedAt : Date.now(),
      modelCircuit: f.state.batch?.runId === f.state.run.id ? f.state.batch.modelCircuit : undefined,
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

  private sourceHasNextTurn() {
    const state = this.factory.state;
    for (let i = state.tokenOrder.length - 1; i >= 0; i--) {
      const token = state.tokens[state.tokenOrder[i]];
      if (!token || token.createdAt < state.run.startedAt || token.data.retryOf ||
          token.data.channelDelivery || token.data.workflowPack ||
          !['candidates', 'curation'].includes(token.line)) continue;
      if (token.data.sourceCandidate || token.source.startsWith('source:')) return false;
      if (token.source === 'candidates/pool') return true;
    }
    return true;
  }

  pump(now = Date.now()) {
    const f = this.factory;
    let goal = f.state.batch;
    if (this.pumping || !goal || goal.runId !== f.state.run.id || goal.mode !== 'running' || !f.runtime.running || f.runtime.paused || f.runtime.ending || process.env.FACTORY_READONLY === '1') return;
    this.pumping = true;
    try {
      if (goal.admission?.mode === 'flow') {
        const next = this.admission({flow: true}, goal);
        if (next.maxInFlight !== goal.maxInFlight || next.intakeWindow !== goal.intakeWindow) {
          goal = {...goal, ...next};
          f.journal.append({kind: 'batch.configured', batch: goal});
        }
      }
      const items = latestBatchTokens(f.state);
      let active = items.filter(t => t.status === 'active').length;
      // Reuse late-stage evidence first instead of filling every recovery slot
      // with early reading attempts while downstream review stations sit idle.
      const recoveryOrder = [...items].sort((a, b) =>
        f.compiled.nodes.findIndex(node => node.key === b.finishedAtNode) - f.compiled.nodes.findIndex(node => node.key === a.finishedAtNode));
      if (goal.modelCircuit) {
        const circuit = goal.modelCircuit;
        if (circuit.state === 'trial' || !circuit.nextAt || now < circuit.nextAt || f.broker.used.model > 0) return;
        if (Object.values(f.state.alerts).some(a => a.kind === 'model' && a.id !== 'model-transport')) return;
        const pending = circuit.trialToken ? f.state.tokens[circuit.trialToken] : undefined;
        if (pending?.status === 'active') {
          const node = circuit.station && f.runtime.nodes.get(circuit.station);
          if (!node || f.runtime.scopePaused(node.key)) return;
          f.broker.recoveryToken = pending.id; f.broker.modelHold = null;
          f.journal.append({ kind: 'batch.configured', batch: { ...goal, modelCircuit: { ...circuit, state: 'trial' } } });
          f.runtime.schedule(); return;
        }
        const candidate = recoveryOrder.find(t => {
          const recovery = f.state.recoveries[t.item], failure = recovery?.failure;
          return t.status === 'parked' && recovery?.token === t.id && recovery.disposition === 'retry' && failure?.tag === 'model_transport' && classifyFailure(failure.message, { stage: 'model', status: failure.status }).tag !== 'model_unavailable';
        });
        if (!candidate) return;
        const node = candidate.finishedAtNode && f.runtime.nodes.get(candidate.finishedAtNode);
        if (!node || f.runtime.scopePaused(node.key)) return;
        // Hold all newly scheduled tasks until retryCandidates returns the new
        // token ID. Existing requests drain naturally and keep their results.
        f.broker.recoveryToken = 'pending-model-trial';
        f.broker.modelHold = null;
        try {
          const [trial] = f.retryCandidates({ items: [candidate.item], count: 1, automatic: true });
          if (!trial) { f.broker.recoveryToken = null; f.broker.modelHold = '模型恢复样本尚未就绪'; return; }
          f.broker.recoveryToken = trial.id;
          f.journal.append({ kind: 'batch.configured', batch: { ...goal, modelCircuit: { ...circuit, state: 'trial', trialToken: trial.id, station: candidate.finishedAtNode } } });
          f.runtime.schedule();
        } catch (error) { f.broker.recoveryToken = null; f.broker.modelHold = '模型恢复样本尚未就绪'; throw error; }
        return;
      }
      for (const token of recoveryOrder) {
        if (token.status !== 'parked') continue;
        const candidate = f.state.recoveries[token.item];
        if (!candidate || candidate.disposition !== 'retry' || candidate.token !== token.id) continue;
        const failure = candidate.failure;
        if (!failure) continue;
        if (failure.tag === 'model_transport') {
          const failed = token.attempts.map(id => f.state.attempts[id]).reverse().find(attempt =>
            attempt && !attempt.cancelled && attempt.ok === false &&
            (!token.finishedAtNode || attempt.node === token.finishedAtNode));
          const planned = token.data.__runtimeRecovery as {dependency?: {key?: unknown}} | undefined;
          const dependency = failure.dependency ?? failed?.metrics?.dependency ?? failed?.dependency ?? planned?.dependency;
          // A keyed circuit owns its single trial. The legacy batch loop cannot
          // claim another retry just because the global compatibility hold is clear.
          if (typeof dependency?.key === 'string' && dependency.key) continue;
          if (active < goal.maxInFlight && !f.broker.modelHold) active += f.retryCandidates({ items: [token.item], count: 1, automatic: true }).length;
          continue;
        }
        const replan = REPLAN.has(failure.tag);
        if (!replan && !TRANSIENT.has(failure.tag) && failure.code !== 'RESTORED_FRONTIER_MISSING') continue;
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
      const latest = latestBatchTokens(f.state);
      active = latest.filter(t => t.status === 'active').length;
      const flowing = goal.admission?.mode === 'flow';
      const upstream = latest.filter(token => {
        if (token.status !== 'active') return false;
        const live = f.runtime.tokens.get(token.id);
        if (!live) return true;
        if (!flowing) return !live.done.has('curation/plan');
        return occupiesIntake(f.compiled, 'candidates/route', live);
      }).length;
      const want = Math.max(0, Math.min(goal.target - latest.length, goal.maxInFlight - active, goal.intakeWindow - upstream));
      if (want && (goal.admission || !f.broker.blocked('browser'))) {
        let catalogChecked = false;
        let admittedTotal = 0;
        for (let slot = 0; slot < want; slot++) {
          // Both feeders share this admission decision. Merely reversing their
          // journal subscriptions would starve the catalog instead of sources.
          let admitted = this.sourceHasNextTurn() ? f.sources?.admitManaged(1) ?? 0 : 0;
          if (!admitted && !f.runtime.scopePaused('candidates/route') && !f.runtime.intakeHold('candidates/route')) {
            admitted = f.pull(1, {category: goal.category, query: goal.query}).length;
            catalogChecked = true;
          }
          if (!admitted) admitted = f.sources?.admitManaged(1) ?? 0;
          if (!admitted) break;
          admittedTotal += admitted;
        }
        const supplyExhausted = admittedTotal < want;
        if ((catalogChecked || admittedTotal > 0) && supplyExhausted !== Boolean(goal.supplyExhausted)) {
          f.journal.append({kind: 'batch.configured', batch: {...goal, supplyExhausted}});
        }
      }
    } finally { this.pumping = false; }
  }
}
