import type {Factory} from './factory.ts';
import type {Failure} from '../shared/failures.ts';
import type {ModelCircuit, ModelDependency, ModelProbeResult} from '../shared/types.ts';
import {modelRecoveryDelay} from '../shared/batch.ts';

/** Durable fault domains. Existing supervisors still choose and resume tasks. */
export class ModelCircuits {
  private readonly factory: Factory;

  constructor(factory: Factory) {
    this.factory = factory;
    factory.broker.modelCircuits = factory.state.modelCircuits;
  }

  get(dependency: ModelDependency) {
    return this.factory.state.modelCircuits[dependency.key];
  }

  private save(circuit: ModelCircuit) {
    this.factory.journal.append({kind: 'model.circuit', key: circuit.dependency.key, circuit});
  }

  failed(dependency: ModelDependency, token: string, station: string, failure: Failure) {
    const old = this.get(dependency);
    const transient = failure.tag === 'model_transport' && failure.owner !== 'user';
    // Concurrent failures from the original outage are one incident. A late
    // result from that incident cannot cancel a different token's trial.
    if (transient && (old?.state === 'open' || old?.state === 'blocked' ||
        old?.state === 'trial' && old.trialToken !== token)) return;
    const failures = (old?.failures ?? 0) + Number(transient);
    this.save({dependency, state: transient ? 'open' : 'blocked', failures,
      nextAt: transient ? Date.now() + modelRecoveryDelay(failures) : 0,
      runId: this.factory.state.run.id, station, reason: failure.message});
  }

  restore(now = Date.now()) {
    if (process.env.FACTORY_READONLY === '1') return;
    for (const circuit of Object.values(this.factory.state.modelCircuits)) {
      if (circuit.state !== 'trial') continue;
      this.save({...circuit, state: 'open',
        nextAt: Math.max(circuit.nextAt, now + modelRecoveryDelay(circuit.failures)),
        trialToken: circuit.trialToken && this.factory.state.tokens[circuit.trialToken]?.status === 'active'
          ? circuit.trialToken : undefined,
        reason: '恢复验证被中断，冷却后继续同一个持久检查点'});
    }
  }

  claim(dependency: ModelDependency, token: string, station: string, now = Date.now()) {
    const circuit = this.get(dependency);
    if (!circuit || circuit.state !== 'open' || circuit.nextAt > now ||
        circuit.trialToken && circuit.trialToken !== token) return false;
    this.save({...circuit, state: 'trial', trialToken: token, station,
      runId: this.factory.state.run.id, runEndedAt: undefined, nextAt: 0, reason: '只放行这个原工位验证实际模型响应'});
    return true;
  }

  defer(dependency: ModelDependency, nextAt: number, reason: string, blocked = false) {
    const circuit = this.get(dependency);
    if (!circuit) return;
    this.save({...circuit, state: blocked ? 'blocked' : 'open', nextAt,
      trialToken: undefined, reason});
  }

  requested(dependency: ModelDependency) {
    const circuit = this.get(dependency);
    if (!circuit || circuit.state === 'trial') return;
    // A user retry does not resolve credential, quota or TLS failures.
    const alert = Object.values(this.factory.state.alerts).find(value =>
      value.dependency?.key === dependency.key && value.id.startsWith('model:'));
    if (alert) return;
    this.save({...circuit, state: 'open', nextAt: Date.now(), trialToken: undefined,
      reason: '已接受显式重试，仍需原工位真实模型响应'});
  }

  probed(probe: ModelProbeResult) {
    if (!probe.actuallyProbed || !probe.ok) return;
    const {dependency} = probe;
    const circuit = this.get(dependency);
    if (!circuit) return;
    const currentTrial = circuit.state === 'trial' && circuit.runId === this.factory.state.run.id &&
      this.factory.runtime.running;
    if (circuit.runEndedAt !== undefined && !currentTrial) {
      this.clear(dependency, '旧轮次已结束；本模型已通过实际认证推理检查，解除遗留服务暂停；业务结果保持原记录');
      return;
    }
    if (circuit.state === 'trial') return;
    // Connectivity is evidence for this dependency only, not business success.
    this.save({...circuit, state: 'open', nextAt: Date.now(),
      reason: '本模型连接检查通过，等待一个真实工位验证'});
  }

  recovered(dependency: ModelDependency, token: string, station: string) {
    const circuit = this.get(dependency);
    if (!circuit || circuit.state !== 'trial' || circuit.trialToken !== token || circuit.station !== station) return false;
    this.clear(dependency, '该模型的原工位已返回真实响应，解除这一依赖的暂停');
    return true;
  }

  private clear(dependency: ModelDependency, reason: string) {
    this.factory.journal.append({kind: 'model.circuit', key: dependency.key, circuit: null});
    for (const alert of Object.values(this.factory.state.alerts)) {
      if (alert.kind === 'model' && alert.dependency?.key === dependency.key) {
        this.factory.clearAlert(alert.id, reason);
      }
    }
    this.factory.runtime.schedule();
  }
}
