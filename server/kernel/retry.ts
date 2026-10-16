import type {Failure} from '../../shared/failures.ts';
import {recoveryDelay} from '../../shared/recovery-policy.ts';
import type {ModelCircuit, ModelDependency, StationRecoveryPolicy} from '../../shared/types.ts';

export interface RetryPlan {
  kind: 'retry' | 'model' | 'park' | 'exclude' | 'return';
  attempts: number;
  nextAt?: number;
  code?: string;
  target?: string;
}

const TRANSIENT = new Set(['network_timeout', 'network_connection', 'network_dns',
  'http_server', 'http_rate_limit', 'browser_capture', 'tool_error']);

/** attempts counts retries already scheduled, excluding the initial execution. */
export function planFailure(failure: Failure, attempts: number,
    policy?: StationRecoveryPolicy, now = Date.now()): RetryPlan {
  if (!Number.isSafeInteger(attempts) || attempts < 0) throw new RangeError('Invalid automatic retry count');
  if (failure.code === 'EXTERNAL_OPERATION_UNKNOWN') return {kind: 'park', attempts, code: failure.code};
  if (failure.tag === 'network_tls') return {kind: 'park', attempts, code: 'tls'};
  if (failure.category === 'auth' || failure.tag === 'auth_required') return {kind: 'park', attempts, code: 'auth'};
  if (failure.tag === 'http_forbidden') return {kind: 'park', attempts, code: 'http_forbidden'};
  if (failure.tag === 'model_transport' || failure.tag === 'model_unavailable') return {kind: 'model', attempts};
  if (failure.tag === 'invalid_url' || failure.tag === 'http_not_found' || failure.status === 404 || failure.status === 410) {
    return {kind: 'exclude', attempts, code: failure.tag};
  }
  if (failure.tag === 'needs_selection' || failure.tag === 'page_unavailable') {
    return {kind: 'return', attempts, target: 'curation/reader'};
  }
  if (!TRANSIENT.has(failure.tag) || !failure.retryable || failure.owner === 'user') {
    return {kind: 'park', attempts, code: failure.code ?? failure.tag};
  }
  const maxRetries = policy?.maxRetries ?? 3;
  if (attempts >= maxRetries) return {kind: 'park', attempts, code: 'retries_exhausted'};
  const delay = Math.min(600_000, policy ? recoveryDelay(policy, attempts) : 10_000 * 3 ** attempts);
  return {kind: 'retry', attempts: attempts + 1, nextAt: now + delay};
}

export function modelBackoff(failures: number): number {
  return Math.min(900_000, 30_000 * 2 ** Math.max(0, failures - 1));
}

/** These pure values are installed only after Kernel commits model.circuit. */
export function nextModelFailure(previous: ModelCircuit | undefined, dependency: ModelDependency,
    token: string, node: string, runId: string, reason: string, now = Date.now()): ModelCircuit {
  if (previous && (previous.state === 'open' || previous.state === 'blocked' ||
      previous.state === 'trial' && (previous.trialToken !== token || previous.station !== node))) {
    return structuredClone(previous);
  }
  const failures = (previous?.failures ?? 0) + 1;
  return {dependency: structuredClone(dependency), state: 'open', failures,
    nextAt: now + modelBackoff(failures), runId, station: node, reason};
}

export function claimModelProbe(previous: ModelCircuit | undefined, token: string,
    node: string, runId: string, now = Date.now()): ModelCircuit | null {
  if (!previous || previous.state !== 'open' || previous.nextAt > now) return null;
  return {...structuredClone(previous), state: 'trial', trialToken: token, station: node,
    runId, runEndedAt: undefined, nextAt: 0, reason: '只放行一个节点验证模型恢复'};
}

export function modelProbeSucceeded(previous: ModelCircuit | undefined, token: string, node: string): boolean {
  return previous?.state === 'trial' && previous.trialToken === token && previous.station === node;
}

export function releaseModelProbe(previous: ModelCircuit, token: string, node: string, now = Date.now()): ModelCircuit {
  if (!modelProbeSucceeded(previous, token, node)) return structuredClone(previous);
  return {...structuredClone(previous), state: 'open', trialToken: undefined,
    nextAt: now + modelBackoff(previous.failures), reason: '模型试探被中断，冷却后重新放行一个节点'};
}
