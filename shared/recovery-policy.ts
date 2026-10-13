import type {Failure} from './failures.ts';
import type {RecoveryFailureTag, StationRecoveryPolicy} from './types.ts';

export const RECOVERY_POLICY_KEY = '__runtimeRecoveryPolicies';
export const RECOVERY_PLAN_KEY = '__runtimeRecovery';

const TAGS: readonly RecoveryFailureTag[] = [
  'network_timeout', 'network_connection', 'network_dns', 'http_server',
  'http_rate_limit', 'http_forbidden', 'browser_capture', 'tool_error', 'model_transport',
];

export interface RecoveryPolicySnapshot {
  policy: StationRecoveryPolicy | null;
  capturedAt: number;
  attempt: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error('恢复策略包含不支持的字段');
  }
}

function integer(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name} 必须是 ${minimum}–${maximum} 范围内的整数`);
  }
  return Number(value);
}

/** Validate packages at the boundary and normalize the persisted policy. */
export function parseRecoveryPolicy(value: unknown): StationRecoveryPolicy {
  if (!isRecord(value)) throw new Error('恢复策略必须是对象');
  keys(value, ['tags', 'maxRetries', 'backoff', 'deadlineMs', 'exhausted']);
  if (!Array.isArray(value.tags) || value.tags.length > TAGS.length ||
      value.tags.some(tag => !TAGS.includes(tag)) || new Set(value.tags).size !== value.tags.length) {
    throw new Error('恢复标签必须是已支持的暂态错误，不能包含认证、TLS、取消或未知结果');
  }
  const maxRetries = integer(value.maxRetries, 0, 10, 'maxRetries');
  if (!isRecord(value.backoff)) throw new Error('恢复策略必须声明 backoff');
  keys(value.backoff, ['initialMs', 'factor', 'maxMs', 'jitter']);
  const initialMs = integer(value.backoff.initialMs, 1000, 86400000, 'backoff.initialMs');
  const maxMs = integer(value.backoff.maxMs, initialMs, 86400000, 'backoff.maxMs');
  const factor = value.backoff.factor;
  const jitter = value.backoff.jitter ?? 0;
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 1 || factor > 10) {
    throw new Error('backoff.factor 必须在 1–10 范围内');
  }
  if (typeof jitter !== 'number' || !Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new Error('backoff.jitter 必须在 0–1 范围内');
  }
  if (value.exhausted !== 'parked' && value.exhausted !== 'manual') {
    throw new Error('exhausted 必须是 parked 或 manual');
  }
  const deadlineMs = value.deadlineMs === undefined ? undefined
    : integer(value.deadlineMs, 1000, 604800000, 'deadlineMs');
  return {tags: [...value.tags] as RecoveryFailureTag[], maxRetries,
    backoff: {initialMs, factor, maxMs, jitter},
    ...(deadlineMs === undefined ? {} : {deadlineMs}), exhausted: value.exhausted};
}

export function recoverySnapshot(data: Record<string, unknown>, station: string): RecoveryPolicySnapshot | undefined {
  const snapshots = data[RECOVERY_POLICY_KEY];
  const saved = isRecord(snapshots) ? snapshots[station] : undefined;
  if (!isRecord(saved) || !Number.isSafeInteger(saved.capturedAt) || Number(saved.capturedAt) < 0 ||
      typeof saved.attempt !== 'string') return;
  try {
    return {policy: saved.policy === null ? null : parseRecoveryPolicy(saved.policy),
      capturedAt: Number(saved.capturedAt), attempt: saved.attempt};
  } catch {
    return;
  }
}

export function hasRecoveryPolicy(data: Record<string, unknown>, station: string): boolean {
  const snapshot = recoverySnapshot(data, station);
  return snapshot !== undefined && snapshot.policy !== null;
}

/** An active episode is frozen. Completion or an independent attempt recaptures. */
export function captureRecoveryPolicy(data: Record<string, unknown>, station: string,
  configured: StationRecoveryPolicy | undefined, attempt: string, now: number): RecoveryPolicySnapshot {
  const plan = data[RECOVERY_PLAN_KEY];
  const active = isRecord(plan) && plan.version === 1 &&
    ['waiting', 'trial'].includes(String(plan.state)) && [plan.station, plan.modelStation].includes(station);
  const policy = active && Object.hasOwn(plan, 'policy') ? plan.policy : configured ?? null;
  return {policy: policy === null ? null : parseRecoveryPolicy(policy), capturedAt: now, attempt};
}

export function allowsRecovery(policy: StationRecoveryPolicy, failure: Failure): boolean {
  return failure.retryable && failure.owner !== 'user' && failure.category !== 'auth' &&
    !['EXTERNAL_OPERATION_UNKNOWN', 'MODEL_CIRCUIT_OPEN', 'MODEL_CAPACITY_REENTRANT'].includes(failure.code ?? '') &&
    policy.tags.includes(failure.tag as RecoveryFailureTag) &&
    (failure.tag !== 'tool_error' || failure.category === 'system' && failure.owner === 'system');
}

/** Sample once when saving nextAt; never resample a persisted wait on restart. */
export function recoveryDelay(policy: StationRecoveryPolicy, attempts: number, random = Math.random): number {
  const {initialMs, maxMs, factor, jitter = 0} = policy.backoff;
  const base = Math.min(maxMs, initialMs * factor ** attempts);
  const multiplier = 1 - jitter + random() * 2 * jitter;
  return Math.max(1, Math.min(maxMs, Math.round(base * multiplier)));
}

/** Only automatic attempts carry a recovery deadline; normal work keeps its own timeout. */
export function recoveryDeadline(data: Record<string, unknown>, station: string): number | undefined {
  const plan = data[RECOVERY_PLAN_KEY];
  if (!isRecord(plan) || plan.version !== 1 || plan.state !== 'trial' ||
      ![plan.station, plan.modelStation].includes(station) ||
      !Number.isSafeInteger(plan.deadlineAt) || Number(plan.deadlineAt) < 0) return;
  return Number(plan.deadlineAt);
}
