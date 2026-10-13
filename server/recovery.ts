import type {Factory} from './factory.ts';
import type {TokenRun} from './runtime.ts';
import type {TokenState} from '../shared/project.ts';
import type {ModelDependency, Stamped, StationRecoveryPolicy} from '../shared/types.ts';
import {latestRunTokens} from '../shared/project.ts';
import {classifyFailure, type Failure} from '../shared/failures.ts';
import {isBatchToken, modelRecoveryDelay} from '../shared/batch.ts';
import {ControlError} from './errors.ts';
import {allowsRecovery, hasRecoveryPolicy, parseRecoveryPolicy,
  recoveryDelay, recoverySnapshot} from '../shared/recovery-policy.ts';

const KEY = '__runtimeRecovery';
const NETWORK_RETRIES = 2;
const TRANSIENT = new Set([
  'network_timeout', 'network_connection', 'network_dns', 'http_server',
  'http_rate_limit', 'browser_capture', 'http_forbidden',
]);

export interface RecoveryPlan {
  version: 1;
  runId: string;
  kind: 'network' | 'model';
  state: 'waiting' | 'trial' | 'completed' | 'exhausted' | 'blocked';
  station: string;
  nextAt: number;
  networkAttempts: number;
  modelFailures: number;
  failureAttempt: string;
  /** A local tool can fail before the provider verification is reached. */
  modelStation?: string;
  networkRetry?: boolean;
  reason?: string;
  dependency?: ModelDependency;
  /** Missing on legacy plans; null explicitly freezes the existing defaults. */
  policy?: StationRecoveryPolicy | null;
  startedAt?: number;
  deadlineAt?: number;
  attempts?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Recovery supervises existing tasks; it never creates an intake goal. */
export class UnmanagedRecoverySupervisor {
  private readonly factory: Factory;
  private readonly unsubscribe: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private closed = false;
  private scheduled = false;
  private pumping = false;

  constructor(factory: Factory) {
    this.factory = factory;
    this.unsubscribe = factory.journal.subscribe(event => this.observe(event));
  }

  start() {
    if (this.started || this.closed || process.env.FACTORY_READONLY === '1') return;
    this.started = true;
    // A crashed trial already owns a task and its saved conversation. Cool down
    // that same task before releasing its restored queue, without cloning it.
    {
      for (const token of this.tokens()) {
        const plan = this.plan(token);
        if (plan?.kind !== 'model' || plan.state !== 'trial') continue;
        if (this.delegated(token, plan.kind, plan.dependency)) continue;
        if (token.status === 'active') {
          this.save(token.id, {...plan, state: 'waiting',
            nextAt: plan.dependency ? this.factory.modelCircuits.get(plan.dependency)?.nextAt ?? plan.nextAt
              : Math.max(plan.nextAt, Date.now() + modelRecoveryDelay(plan.modelFailures))});
          if (!plan.dependency) this.factory.broker.modelHold = '模型恢复验证被中断，冷却后从原检查点继续';
        }
      }
    }
    this.timer = setInterval(() => this.schedule(), 5000);
    this.timer.unref();
    this.schedule();
  }

  private managed(token: TokenState) {
    const f = this.factory;
    return f.state.batch?.runId === f.state.run.id && isBatchToken(token);
  }

  private delegated(token: TokenState, kind: RecoveryPlan['kind'], dependency?: ModelDependency) {
    const f = this.factory;
    if (f.state.batch?.runId !== f.state.run.id) return false;
    const plan = this.plan(token);
    if (plan?.policy || hasRecoveryPolicy(token.data, token.finishedAtNode ?? plan?.station ?? '')) return false;
    // An unidentified legacy model outage still belongs to the global batch
    // circuit. Known model keys use this supervisor; website network work does not.
    return kind === 'model' ? !dependency : isBatchToken(token);
  }

  private writable() {
    return this.started && !this.closed && process.env.FACTORY_READONLY !== '1';
  }

  private running() {
    const runtime = this.factory.runtime;
    return this.writable() && runtime.running && !runtime.paused && !runtime.ending;
  }

  private tokens() {
    return latestRunTokens(this.factory.state);
  }

  private plan(token: TokenState, allowPreviousRun = false): RecoveryPlan | undefined {
    const value = token.data[KEY];
    if (!record(value) || value.version !== 1 || typeof value.runId !== 'string' ||
        (!allowPreviousRun && value.runId !== this.factory.state.run.id) ||
        !['network', 'model'].includes(String(value.kind)) ||
        !['waiting', 'trial', 'completed', 'exhausted', 'blocked'].includes(String(value.state)) ||
        typeof value.station !== 'string' || typeof value.failureAttempt !== 'string' ||
        !Number.isSafeInteger(value.nextAt) || Number(value.nextAt) < 0 ||
        !Number.isSafeInteger(value.networkAttempts) || Number(value.networkAttempts) < 0 ||
        !Number.isSafeInteger(value.modelFailures) || Number(value.modelFailures) < 0) return;
    if (['startedAt', 'deadlineAt', 'attempts'].some(key => value[key] !== undefined &&
        (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0))) return;
    if (value.policy !== undefined && value.policy !== null) {
      try { parseRecoveryPolicy(value.policy); } catch { return; }
    }
    return value as unknown as RecoveryPlan;
  }

  private failure(token: TokenState): Failure | undefined {
    const value = token.data.failure;
    return record(value) && typeof value.tag === 'string' && typeof value.message === 'string'
      ? value as unknown as Failure : undefined;
  }

  private save(id: string, plan: RecoveryPlan, note?: string) {
    const f = this.factory;
    f.runtime.atomicTransition(() => {
      const token = f.runtime.tokens.get(id);
      if (token) token.data[KEY] = structuredClone(plan);
      f.journal.append({kind: 'token.data', token: id, patch: {[KEY]: plan}});
      if (note) f.journal.append({kind: 'dispatch.note', tone: 'warn', node: plan.station, text: note});
    });
  }

  private checkpoint(token: TokenState): string | undefined {
    const f = this.factory;
    const saved = token.data.runtimeCheckpoint;
    const station = token.finishedAtNode;
    const node = station && f.runtime.nodes.get(station);
    if (!record(saved) || saved.version !== 1 || typeof saved.entry !== 'string' ||
        !Array.isArray(saved.done) || !Array.isArray(saved.notes) || !record(saved.rounds) ||
        !node || !f.runtime.runnable(node) ||
        !f.runtime.nodes.has(saved.entry) || !f.runtime.closureOf(saved.entry).has(node.key)) return;
    return node.key;
  }

  private sourceEnabled(token: TokenState) {
    if (!token.data.sourceCandidate) return true;
    const source = record(token.data.sourceRecord) ? token.data.sourceRecord.source
      : token.source.startsWith('source:') ? token.source.slice(7) : undefined;
    return typeof source === 'string' && Boolean(this.factory.sources?.list().find(value => value.id === source)?.enabled);
  }

  private exhaustion(plan: RecoveryPlan, now: number): string | undefined {
    if (!plan.policy) return;
    if (plan.deadlineAt !== undefined && now >= plan.deadlineAt) {
      return '已达到声明的自动恢复总期限；保留检查点与成果，等待明确处理';
    }
    if ((plan.attempts ?? 0) >= plan.policy.maxRetries) {
      return `已用完声明的 ${plan.policy.maxRetries} 次自动恢复；保留检查点与成果`;
    }
  }

  private releasePolicyTrial(token: TokenState, plan: RecoveryPlan, now: number) {
    if (!plan.policy) return;
    const f = this.factory;
    const circuit = plan.dependency && f.modelCircuits.get(plan.dependency);
    if (plan.dependency && circuit?.state === 'trial' && circuit.trialToken === token.id) {
      f.modelCircuits.defer(plan.dependency,
        Math.max(circuit.nextAt, now + modelRecoveryDelay(circuit.failures)),
        '本任务未能完成验证；同依赖其他任务仍按原冷却等待真实响应');
    }
    const batch = f.state.batch;
    if (!plan.dependency && plan.kind === 'model' && batch?.modelCircuit?.state === 'trial' &&
        batch.modelCircuit.trialToken === token.id) {
      f.journal.append({kind: 'batch.configured', batch: {...batch, modelCircuit: {
        ...batch.modelCircuit, state: 'open', trialToken: undefined,
        nextAt: Math.max(batch.modelCircuit.nextAt, now + modelRecoveryDelay(batch.modelCircuit.failures)),
      }}});
    }
    if (f.broker.recoveryToken === token.id) {
      f.broker.recoveryToken = null;
      f.broker.modelHold ??= '该任务验证未完成；服务仍待真实模型响应';
    }
  }

  private exhaust(token: TokenState, plan: RecoveryPlan, reason: string, now: number) {
    const f = this.factory;
    const runtimeToken = f.runtime.tokens.get(token.id);
    if (!runtimeToken || runtimeToken.inflight.size) return;
    if (!runtimeToken.finished) {
      // Factory's candidate validation reads committed projections. Persist the
      // queued task's terminal receipt before atomically recording exhaustion
      // and transferring its inventory to review.
      f.runtime.atomicTransition(() => f.runtime.parkRecovery(runtimeToken, plan.station, reason));
    }
    f.runtime.atomicTransition(() => {
      this.save(token.id, {...plan, state: 'exhausted', nextAt: 0, reason}, reason);
      if (plan.policy?.exhausted === 'manual') f.holdRecoveryForReview(token.id, plan.station, reason);
      // A task's budget must not close another task's provider circuit. Release
      // only this task's unfinished trial and retain the service cooldown.
      this.releasePolicyTrial(token, plan, now);
    });
  }

  private prepare(now: number) {
    const f = this.factory;
    for (const token of this.tokens()) {
      if (token.status !== 'parked') continue;
      const failure = this.failure(token);
      if (!failure?.retryable) continue;
      const attempt = token.attempts.map(id => f.state.attempts[id]).findLast(value =>
        value && value.node === token.finishedAtNode && value.ok === false && !value.cancelled &&
        !['stale', 'restart'].includes(value.error ?? ''));
      if (!attempt) continue;
      const old = this.plan(token);
      if (old?.failureAttempt === attempt.id && old.state !== 'trial') continue;
      const continuing = old?.state === 'trial' && [old.station, old.modelStation].includes(attempt.node);
      const snapshot = recoverySnapshot(token.data, attempt.node);
      const policy = continuing && Object.hasOwn(old, 'policy') ? old.policy ?? null
        : snapshot?.attempt === attempt.id ? snapshot.policy : null;
      const dependency = failure.dependency ?? attempt.metrics?.dependency ?? attempt.dependency ?? old?.dependency;
      const circuit = dependency && f.modelCircuits.get(dependency);
      const legacy = !dependency && f.state.batch?.runId === f.state.run.id ? f.state.batch.modelCircuit : undefined;
      const model = failure.tag === 'model_transport' &&
        classifyFailure(failure.message, {stage: 'model', status: failure.status}).tag === 'model_transport' ||
        failure.tag === 'model_unavailable' && circuit?.state === 'open';
      const localTool = failure.tag === 'tool_error' && failure.category === 'system' && failure.owner === 'system';
      if (failure.owner === 'user' && !model || !model && !TRANSIENT.has(failure.tag) && !localTool) continue;
      const verifying = old?.kind === 'model' && old.state === 'trial' &&
        Boolean(old.dependency ? f.modelCircuits.get(old.dependency) : f.state.alerts['model-transport'] || f.broker.modelHold);
      const kind = model || verifying ? 'model' : 'network';
      const recoveryDependency = model ? dependency : verifying ? old.dependency : undefined;
      if (this.delegated(token, kind, recoveryDependency)) continue;
      const station = this.checkpoint(token);
      const plan: RecoveryPlan = {
        version: 1, runId: f.state.run.id, kind,
        state: station ? 'waiting' : 'blocked', station: station ?? token.finishedAtNode ?? '',
        nextAt: 0, networkAttempts: policy && !continuing ? 0 : old?.networkAttempts ?? 0,
        modelFailures: circuit?.failures ?? legacy?.failures ?? (old?.modelFailures ?? 0) + Number(model), failureAttempt: attempt.id,
        dependency: recoveryDependency,
        modelStation: model ? station : verifying ? old.modelStation ?? old.station : undefined,
        networkRetry: !model,
        policy,
        startedAt: continuing ? old.startedAt ?? attempt.endedAt ?? now : attempt.endedAt ?? now,
        attempts: continuing ? old.attempts ?? 0 : 0,
      };
      if (policy?.deadlineMs !== undefined) plan.deadlineAt = continuing
        ? old.deadlineAt ?? plan.startedAt! + policy.deadlineMs : plan.startedAt! + policy.deadlineMs;
      let reason = station ? undefined : '缺少原工位的持久检查点；保留成果，不能从入口自动重做';
      if (policy && failure.code !== 'RECOVERY_DEADLINE' && !allowsRecovery(policy, failure)) {
        plan.state = 'blocked';
        reason = `声明的恢复策略不允许自动重试 ${failure.tag}；保留检查点等待明确处理`;
      }
      const exhausted = policy && (failure.code === 'RECOVERY_DEADLINE'
        ? '已达到声明的自动恢复总期限；保留检查点与成果' : this.exhaustion(plan, now));
      if (station && exhausted) {
        this.exhaust(token, plan, exhausted, now);
        continue;
      }
      if (!policy && !model && plan.networkAttempts >= NETWORK_RETRIES) {
        plan.state = 'exhausted';
        reason = '已完成两次从检查点恢复的尝试；保留具体错误与成果，等待故障修复';
      }
      if (plan.state === 'waiting') {
        const delay = policy ? recoveryDelay(policy, plan.attempts ?? 0) : model ? modelRecoveryDelay(plan.modelFailures)
          : (failure.tag === 'http_rate_limit' ? 60000 : 15000) * 2 ** plan.networkAttempts;
        // A policy stores its own sampled wait. Dispatch also checks the shared
        // provider circuit; no task may shorten that service cooldown.
        plan.nextAt = !policy && model && circuit ? circuit.nextAt : now + delay;
      }
      plan.reason = reason;
      if (plan.dependency && !model && verifying) {
        const nextAt = policy ? Math.max(plan.nextAt, now + modelRecoveryDelay(plan.modelFailures)) : plan.nextAt;
        const currentCircuit = f.modelCircuits.get(plan.dependency);
        if (!policy || currentCircuit?.state === 'trial' && currentCircuit.trialToken === token.id) {
          f.modelCircuits.defer(plan.dependency, nextAt, reason ?? '验证模型之前的工具尚未恢复，按原预算等待', !policy && plan.state !== 'waiting');
        }
      } else if (policy && !model && verifying) {
        this.releasePolicyTrial(token, plan, now);
      }
      this.save(token.id, plan, `${token.title || token.item}：${reason ?? (model
        ? '模型暂态故障已保存；到期只放行一个真实工位验证恢复'
        : `已安排从 ${plan.station} 恢复，最多 ${policy?.maxRetries ?? NETWORK_RETRIES} 次；其他任务继续`)}`);
    }
  }

  private schedule() {
    if (!this.started || this.closed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      try { this.pump(); } catch (error) { console.error('unmanaged recovery', error); }
    });
  }

  /** Called inside result handling; inspect the failure only after its commit. */
  modelFailed() {
    this.schedule();
  }

  /** A new user request owns this already-created token, not another clone. */
  requestedRetry(previous: TokenState | undefined, token: TokenRun) {
    const f = this.factory;
    if (!previous || !this.writable() || token.data.retryOf !== previous.id) return;
    let old = this.plan(previous, true);
    if (!old) {
      const attempt = previous.attempts.map(id => f.state.attempts[id]).findLast(value =>
        value?.node === previous.finishedAtNode && value.ok === false && !value.cancelled);
      const dependency = this.failure(previous)?.dependency ?? attempt?.metrics?.dependency ?? attempt?.dependency;
      const circuit = dependency && f.modelCircuits.get(dependency);
      if (attempt && dependency && circuit) old = {
        version: 1, runId: f.state.run.id, kind: 'model', state: 'waiting', station: attempt.node,
        nextAt: circuit.nextAt, networkAttempts: 0, modelFailures: circuit.failures,
        failureAttempt: attempt.id, dependency,
      };
    }
    if (!old) return;
    const station = typeof token.data.recoveryStation === 'string' ? token.data.recoveryStation : old.station;
    const configured = f.runtime.nodes.get(station)?.recovery;
    const policy = configured === undefined ? null : parseRecoveryPolicy(configured);
    if (!policy && this.delegated(previous, old.kind, old.dependency)) return;
    const verifying = old.kind === 'model' && Boolean(old.dependency
      ? f.modelCircuits.get(old.dependency) : f.state.alerts['model-transport'] || f.broker.modelHold);
    if (verifying && old.dependency) f.modelCircuits.requested(old.dependency);
    this.save(token.id, {
      ...old, runId: f.state.run.id, kind: verifying ? 'model' : 'network',
      state: verifying ? 'waiting' : 'trial', station, nextAt: verifying ? Date.now() : 0,
      networkAttempts: 0, modelStation: verifying ? old.modelStation ?? old.station : undefined,
      networkRetry: false, reason: undefined,
      policy, attempts: 0, startedAt: undefined, deadlineAt: undefined,
    }, verifying ? '已接受显式重试；重置本次工具恢复预算，原工位的真实模型响应仍须通过验证'
      : '已接受显式重试；保留原检查点与成果，为本次请求重新计工具恢复预算');
    this.schedule();
  }

  permitModelTrial() {
    const runtime = this.factory.runtime;
    if (!this.writable() || !runtime.running || runtime.ending ||
        !this.factory.state.alerts['model-transport']) return false;
    this.prepare(Date.now());
    const token = this.tokens().find(value => {
      const plan = this.plan(value);
      return plan?.kind === 'model' && plan.state === 'waiting' && !this.delegated(value, plan.kind, plan.dependency);
    });
    if (token) this.save(token.id, {...this.plan(token)!, nextAt: Date.now()});
    this.schedule();
    // A missing/paused sample is not a successful model response. Keep the
    // transport alert even when the user-requested connection check succeeded.
    return true;
  }

  private observe(event: Stamped) {
    if (!this.writable()) return;
    const f = this.factory;
    if (event.kind === 'attempt.finished') {
      const attempt = f.state.attempts[event.attempt];
      const token = attempt && f.state.tokens[attempt.token];
      const plan = token && this.plan(token);
      if (token && this.delegated(token, plan?.kind ?? 'network', plan?.dependency)) return;
      if (token && plan?.state === 'trial' &&
          [plan.station, plan.modelStation].includes(attempt.node) &&
          !event.cancelled && !['stale', 'restart'].includes(event.error ?? '')) {
        const failure = this.failure(token);
        if (plan.kind === 'model') {
          if (attempt.node !== (plan.modelStation ?? plan.station)) {
            if (event.ok) this.save(token.id, {...plan, station: plan.modelStation!, networkRetry: false});
            return;
          }
          const failedDependency = failure?.dependency ?? event.metrics?.dependency ?? attempt.dependency;
          const failedThisModel = ['model_transport', 'model_unavailable'].includes(failure?.tag ?? '') &&
            (!plan.dependency || failedDependency?.key === plan.dependency.key);
          const responded = event.metrics?.modelResponses ? event.metrics.modelResponses.some(response =>
            response.usageReported && response.modelCalls > 0 && (!plan.dependency || response.dependency.key === plan.dependency.key))
            : event.metrics?.usageReported && (event.metrics.time?.modelCalls ?? 0) > 0 &&
              (!plan.dependency || event.metrics.dependency?.key === plan.dependency.key);
          if (!failedThisModel && responded) {
            // Provider health and station success are separate facts. A paid
            // reply followed by a tool failure keeps this policy's retry budget.
            this.save(token.id, {...plan, state: plan.policy && !event.ok ? 'trial' : 'completed', nextAt: 0});
            if (plan.dependency) {
              if (f.modelCircuits.recovered(plan.dependency, token.id, attempt.node)) {
                for (const peer of this.tokens()) {
                  const waiting = this.plan(peer);
                  if (waiting?.dependency?.key === plan.dependency.key && waiting.state === 'waiting') {
                    this.save(peer.id, {...waiting, nextAt: waiting.policy ? waiting.nextAt : Date.now()});
                  }
                }
              }
            }
            else {
              const batch = f.state.batch;
              if (plan.policy && batch?.modelCircuit?.trialToken === token.id) {
                f.journal.append({kind: 'batch.configured', batch: {...batch, modelCircuit: undefined}});
              }
              f.broker.recoveryToken = null;
              f.clearAlert('model-transport', '原检查点工位已返回可核验的真实模型响应，恢复排队任务');
              f.broker.modelHold = Object.values(f.state.alerts).find(alert => alert.kind === 'model' && !alert.dependency)?.message ?? null;
            }
            f.runtime.schedule();
          } else if (event.ok) {
            this.save(token.id, {...plan, state: 'blocked', nextAt: 0,
              reason: '恢复工位没有真实模型响应回执；保留模型暂停，不能将程序完成当成模型已恢复'},
            '恢复工位没有真实模型响应回执；保留模型暂停，等待核查');
            if (plan.policy) this.releasePolicyTrial(token, plan, Date.now());
            else if (plan.dependency) f.modelCircuits.defer(plan.dependency, 0, '恢复工位没有同一模型的真实响应回执', true);
            else {f.broker.recoveryToken = null; f.broker.modelHold = '恢复工位没有真实模型响应回执';}
          }
        } else if (event.ok) {
          this.save(token.id, {...plan, state: 'completed', nextAt: 0});
        }
      }
    }
    if (event.kind === 'token.finished') {
      const token = f.state.tokens[event.token];
      const plan = token && this.plan(token);
      if (plan?.state === 'trial' && plan.kind === 'model') {
        if (this.delegated(token, plan.kind, plan.dependency)) return;
        if (!plan.dependency) {
          f.broker.recoveryToken = null;
          f.broker.modelHold ??= '模型恢复验证尚未通过，已保留检查点';
        }
        const failure = this.failure(token);
        if (!failure || failure.owner === 'user' || failure.tag === 'run_ended' || !failure.retryable) {
          this.save(token.id, {...plan, state: 'blocked', nextAt: 0,
            reason: failure?.message ?? token.reason ?? '验证未完成；保留实际结果'});
          if (plan.policy) this.releasePolicyTrial(token, plan, Date.now());
          else if (plan.dependency) f.modelCircuits.defer(plan.dependency, 0, failure?.message ?? '验证未完成，保留实际结果', true);
        }
      }
    }
    if (event.kind === 'run.ended') f.broker.recoveryToken = null;
    if (['run.started', 'run.resumed', 'run.ended', 'scope.paused', 'token.finished',
      'attempt.finished', 'alert.cleared', 'candidate.disposition', 'channel.delivery', 'model.circuit'].includes(event.kind)) this.schedule();
  }

  private resume(token: TokenState, plan: RecoveryPlan, now: number): TokenRun | null {
    const f = this.factory;
    const channel = token.data.channelDelivery;
    const candidate = f.state.recoveries[token.item];
    if (typeof channel !== 'string' && (candidate?.token !== token.id || candidate.disposition !== 'retry')) {
      this.save(token.id, {...plan, state: 'blocked', nextAt: 0,
        reason: '当前恢复记录关联另一件任务；保留本件检查点，不能认领不同工作流'},
      '当前恢复记录关联另一件任务；没有自动恢复另一条流水线');
      return null;
    }
    const onClaim = (next: TokenRun) => {
      if (next.data.retryOf !== token.id) throw new ControlError(409, 'recovery_claim_mismatch', '恢复认领的任务与原检查点不一致');
      this.save(next.id, {...plan, state: 'trial', nextAt: 0,
        attempts: (plan.attempts ?? 0) + 1,
        networkAttempts: plan.networkAttempts + Number(plan.kind === 'network' || plan.networkRetry)});
      if (plan.dependency) f.modelCircuits.claim(plan.dependency, next.id, plan.modelStation ?? plan.station, now);
    };
    try {
      return typeof channel === 'string' ? f.channels?.resumeFailed(channel, onClaim) ?? null
        : f.retryCandidates({items: [token.item], count: 1, automatic: true, checkpointOnly: true, onClaim})[0] ?? null;
    } catch (error) {
      // Expected plan validation happens before either claim transaction. A
      // rolled-back runtime is stopped and must never be written to again here.
      if (!(error instanceof ControlError) || error.status >= 500 || !f.runtime.running) throw error;
      if (error.code === 'scope_paused') return null;
      this.save(token.id, {...plan, state: 'blocked', nextAt: 0, reason: error.message}, error.message);
      return null;
    }
  }

  pump(now = Date.now()) {
    if (!this.running() || this.pumping) return;
    this.pumping = true;
    const f = this.factory;
    try {
      this.prepare(now);
      const tokens = this.tokens();
      for (const token of tokens) {
        const plan = this.plan(token);
        if (!plan?.policy || !['waiting', 'trial'].includes(plan.state)) continue;
        const reason = plan.deadlineAt !== undefined && now >= plan.deadlineAt
          ? '已达到声明的自动恢复总期限；保留检查点与成果，等待明确处理' : undefined;
        if (reason) this.exhaust(token, plan, reason, now);
      }
      if (tokens.some(token => this.plan(token)?.state === 'trial' && !this.plan(token)?.dependency && token.status === 'active')) return;
      const modelHold = Boolean(f.state.alerts['model-transport'] || f.broker.modelHold);
      if (Object.values(f.state.alerts).some(alert => alert.kind === 'model' && !alert.dependency && alert.id !== 'model-transport')) return;
      const waiting = tokens.filter(token => {
        const plan = this.plan(token);
        const circuit = plan?.dependency && f.modelCircuits.get(plan.dependency);
        const legacy = plan?.policy && plan.kind === 'model' && !plan.dependency &&
          f.state.batch?.runId === f.state.run.id ? f.state.batch.modelCircuit : undefined;
        return plan?.state === 'waiting' && !this.delegated(token, plan.kind, plan.dependency) &&
          (!this.managed(token) || f.state.batch?.mode === 'running') &&
          (!plan.policy || plan.nextAt <= now) &&
          (circuit ? circuit.state === 'open' && circuit.nextAt <= now && (!circuit.trialToken || circuit.trialToken === token.id) : plan.nextAt <= now) &&
          (!legacy || legacy.state === 'open' && legacy.nextAt <= now && (!legacy.trialToken || legacy.trialToken === token.id)) &&
          (!modelHold || plan.kind === 'model' && !plan.dependency) && !f.runtime.scopePaused(plan.station) &&
          (token.status === 'active' || this.sourceEnabled(token));
      }).sort((a, b) => this.plan(a)!.nextAt - this.plan(b)!.nextAt);
      for (const token of waiting) {
        const plan = this.plan(token)!;
        if (plan.kind === 'model' && !plan.dependency && f.broker.used.model > 0) continue;
        const saved = token.data.runtimeCheckpoint;
        const entry = this.checkpoint(token) && record(saved) && typeof saved.entry === 'string' ? saved.entry : undefined;
        if (plan.kind === 'network' && !token.data.channelDelivery &&
            [...f.runtime.tokens.values()].some(value => entry
              ? f.runtime.occupiesAdmission(value, entry) : !value.finished)) continue;
        const hold = f.broker.modelHold;
        if (plan.kind === 'model' && !plan.dependency) {
          f.broker.recoveryToken = 'pending-unmanaged-trial';
          f.broker.modelHold = null;
        }
        try {
          const next = token.status === 'active' ? f.runtime.tokens.get(token.id) ?? null : this.resume(token, plan, now);
          if (!next) continue;
          if (token.status === 'active') {
            this.save(token.id, {...plan, state: 'trial', nextAt: 0});
            if (plan.dependency) f.modelCircuits.claim(plan.dependency, next.id, plan.modelStation ?? plan.station, now);
          }
          if (plan.kind === 'model' && !plan.dependency) f.broker.recoveryToken = next.id;
          const batch = f.state.batch;
          if (plan.policy && plan.kind === 'model' && !plan.dependency && batch?.modelCircuit) {
            f.journal.append({kind: 'batch.configured', batch: {...batch, modelCircuit: {
              ...batch.modelCircuit, state: 'trial', trialToken: next.id, station: plan.modelStation ?? plan.station,
            }}});
          }
          f.runtime.schedule();
          return;
        } finally {
          if (f.broker.recoveryToken === 'pending-unmanaged-trial') {
            f.broker.recoveryToken = null;
            f.broker.modelHold = hold;
          }
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe();
  }
}
