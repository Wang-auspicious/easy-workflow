import {apply, type AttemptState, type FactoryState} from './project.ts';
import type {AttemptMetrics, EvidenceRef, Stamped} from './types.ts';
import {compactToolMessage} from './conversation.ts';

/** UI-only cursors retain journal ordering without transporting recovery payloads. */
export type UiEvent = Stamped | {kind: 'ui.cursor'; seq: number; at: number; run: string};

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = object(value);
  return source ? Object.fromEntries(keys.filter(key => Object.hasOwn(source, key))
    .map(key => [key, source[key]])) : {};
}

/** Keep identity and status inputs as well as the board's visible business labels. */
function tokenData(data: Record<string, unknown>) {
  const summary = pick(data, [
    'retriedBy', 'channelDelivery', 'workflowPack', 'recoveryRoot', 'batchRecovery', 'failure',
    'title', 'kind', 'kindAgreed', 'mode', 'shotReview', 'factReview', 'copyReview',
  ]);
  if (Object.hasOwn(data, '__runtimeRecovery')) {
    const plan = object(data.__runtimeRecovery);
    const recovery = plan ? pick(plan, [
      'version', 'runId', 'kind', 'state', 'station', 'nextAt',
      'networkAttempts', 'modelFailures', 'failureAttempt', 'reason',
      'startedAt', 'deadlineAt', 'attempts',
    ]) : null;
    if (recovery && object(plan?.dependency)) {
      recovery.dependency = pick(plan?.dependency, ['key', 'adapter', 'provider', 'model']);
    }
    if (recovery && plan && Object.hasOwn(plan, 'policy')) {
      const policy = object(plan.policy);
      recovery.policy = plan.policy === null ? null : {
        ...pick(policy, ['tags', 'maxRetries', 'deadlineMs', 'exhausted']),
        backoff: pick(policy?.backoff, ['initialMs', 'factor', 'maxMs', 'jitter']),
      };
    }
    summary.__runtimeRecovery = recovery;
  }
  const nested = {
    style: ['applicable', 'subjectVisible', 'styles'],
    facts: ['price', 'license'],
    copy: ['takeawayZh', 'descriptionZh'],
  };
  for (const [key, keys] of Object.entries(nested)) {
    // A missing patch member means unchanged; an explicit null means cleared.
    if (!Object.hasOwn(data, key)) continue;
    const value = object(data[key]);
    if (!value) {
      summary[key] = data[key];
      continue;
    }
    const fields = pick(value, keys);
    if (key === 'style' && Array.isArray(fields.styles)) {
      fields.styles = fields.styles.map(style => pick(style, ['id']));
    }
    summary[key] = fields;
  }
  return summary;
}

function attemptMetrics(metrics: AttemptMetrics | undefined): AttemptMetrics | undefined {
  if (!metrics) return undefined;
  const summary = pick(metrics, [
    'execution', 'dependency', 'usageReported', 'usageComplete', 'cacheUsageComplete', 'modelTimeReported',
    'tokenUsage', 'costReported', 'costComplete',
  ]);
  return Object.keys(summary).length ? summary : undefined;
}

function attemptSummary(attempt: AttemptState): AttemptState {
  const {output: _output, ...summary} = attempt;
  return {...summary, steps: attempt.steps.slice(-1), metrics: attemptMetrics(attempt.metrics)};
}

function evidenceSummary(evidence: EvidenceRef): EvidenceRef {
  return {...evidence, meta: pick(evidence.meta, ['role', 'href', 'content', 'framing'])};
}

function projectUiState(state: FactoryState): FactoryState & {view: 'ui-v1'} {
  return {
    ...state,
    view: 'ui-v1' as const,
    tokens: Object.fromEntries(Object.entries(state.tokens).map(([id, token]) =>
      [id, {...token, data: tokenData(token.data)}])),
    attempts: Object.fromEntries(Object.entries(state.attempts).map(([id, attempt]) =>
      [id, attemptSummary(attempt)])),
    evidence: Object.fromEntries(Object.entries(state.evidence).map(([id, evidence]) =>
      [id, evidenceSummary(evidence)])),
    cases: {},
    contextNotes: {},
    conversation: state.conversation.map(entry => ({...entry, message: compactToolMessage(entry.message)})),
  };
}

/** A detached transport snapshot. The authoritative recovery projection is unchanged. */
export function uiState(state: FactoryState): FactoryState & {view: 'ui-v1'} {
  return structuredClone(projectUiState(state));
}

/** Serialize in the same synchronous turn, without retaining shared references. */
export function serializeUiState(state: FactoryState): string {
  return JSON.stringify(projectUiState(state));
}

export function isUiState(state: unknown): state is FactoryState & {view: 'ui-v1'} {
  return object(state)?.view === 'ui-v1';
}

/** This transform depends only on its event, so catch-up cannot observe future state. */
export function uiEvent(event: Stamped): UiEvent {
  switch (event.kind) {
    case 'chat.message':
      return {...event, message: compactToolMessage(event.message)};
    case 'attempt.activity':
    case 'case.noted':
    case 'context.noted':
    case 'chat.checkpoint':
    case 'channel.delivery':
    case 'operation.recorded':
    case 'source.configured':
    case 'source.requested':
    case 'source.polled':
    case 'source.candidate':
    case 'source.reputation':
    case 'control.executed':
      return {kind: 'ui.cursor', seq: event.seq, at: event.at, run: event.run};
    case 'token.data':
      return {...event, patch: tokenData(event.patch)};
    case 'attempt.finished': {
      const {output: _output, ...summary} = event;
      return {...summary, metrics: attemptMetrics(event.metrics)};
    }
    case 'evidence.added':
      return {...event, evidence: evidenceSummary(event.evidence)};
    case 'correction.created':
      return {...event, snapshot: event.snapshot ? {} : undefined};
    case 'correction.reverted':
      return {...event, snapshot: {
        ...pick(event.snapshot, ['status', 'at', 'touchedAt', 'finishedAt', 'finishedAtNode', 'reason']),
        data: tokenData(object(event.snapshot.data) ?? {}),
        checkpoint: pick(event.snapshot.checkpoint, ['rounds']),
      }};
    default:
      return event;
  }
}

/** Apply UI summaries only; full replay continues to use the authoritative apply(). */
export function applyUiEvent(state: FactoryState, event: UiEvent): FactoryState {
  if (event.seq <= state.seq) return state;
  const summary = event.kind === 'ui.cursor' ? event : uiEvent(event);
  if (summary.kind === 'ui.cursor') {
    state.seq = summary.seq;
    return state;
  }
  apply(state, summary);
  if (summary.kind === 'attempt.progress') {
    const attempt = state.attempts[summary.attempt];
    if (attempt) attempt.steps = attempt.steps.slice(-1);
  }
  return state;
}
