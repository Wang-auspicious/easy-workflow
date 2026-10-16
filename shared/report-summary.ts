/** Bounded report views for model context and persisted chat previews. */
type RecordValue = Record<string, unknown>;

const ATTEMPT_LIMIT = 6;
const STATION_LIMIT = 8;
const INSIGHT_LIMIT = 4;
const MODEL_CIRCUIT_LIMIT = 6;
const ITEM_GROUPS = ['published', 'manual', 'corrected', 'merged', 'rejected', 'parked'];
const USAGE_FIELDS = ['input', 'output', 'cost', 'cacheRead', 'cacheWrite'];
const COVERAGE_FIELDS = ['attempts', 'finished', 'tokenBreakdowns', 'usageReported',
  'usageComplete', 'costReported', 'costComplete', 'cacheUsageComplete',
  'timeBreakdowns', 'modelTimeReported'];
const ACTIVITY_COVERAGE_FIELDS = ['attempts', 'recordedAttempts', 'modelTimingObserved',
  'modelTimingUnknown', 'unclosedSpans'];

function record(value: unknown): RecordValue | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  return value as RecordValue;
}

function text(value: string, maximum = 240): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}… [truncated]`;
}

function fields(value: unknown, numeric: readonly string[], textual: readonly string[] = [],
  boolean: readonly string[] = []): RecordValue | undefined {
  const source = record(value);
  if (!source) return;
  const result: RecordValue = {};
  for (const key of numeric) {
    const item = source[key];
    if (item === null || typeof item === 'number' && Number.isFinite(item)) result[key] = item;
  }
  for (const key of textual) {
    if (typeof source[key] === 'string') result[key] = text(source[key]);
  }
  for (const key of boolean) {
    if (typeof source[key] === 'boolean') result[key] = source[key];
  }
  return result;
}

function reportMetrics(value: unknown): RecordValue | undefined {
  const source = record(value);
  if (!source || source.source !== 'run-journal') return;
  const tokens = record(source.tokens);
  const result: RecordValue = {
    source: 'run-journal',
    coverage: fields(source.coverage, COVERAGE_FIELDS),
    time: fields(source.time, ['attemptMs', 'queuedMs', 'firstTokenMs', 'outputMs',
      'toolMs', 'programMs', 'otherMs', 'modelCalls', 'toolCalls', 'outputTokensPerSecond'],
    ['aggregation']),
  };
  if (tokens) {
    result.tokens = {
      ...fields(tokens, ['cacheHitRate'], ['estimateBasis', 'cacheHitRateBasis']),
      estimated: tokens.estimated === null ? null : fields(tokens.estimated,
        ['system', 'context', 'caseFile', 'input', 'images', 'toolDefs', 'toolResults']),
      estimatedFields: Array.isArray(tokens.estimatedFields)
        ? tokens.estimatedFields.slice(0, 16).filter((field): field is string => typeof field === 'string')
          .map(field => text(field, 64)) : undefined,
      actual: tokens.actual === null ? null : fields(tokens.actual, USAGE_FIELDS),
    };
  }
  return result;
}

function batchSummary(value: unknown): RecordValue | null | undefined {
  if (value === null) return null;
  const source = record(value);
  if (!source) return;
  const circuits = Array.isArray(source.modelCircuits) ? source.modelCircuits : undefined;
  const circuitCount = circuits ? Math.max(circuits.length,
    Number.isSafeInteger(source.modelCircuitCount) ? Number(source.modelCircuitCount) : 0) : 0;
  return {
    ...fields(source, ['target', 'maxInFlight', 'intakeWindow', 'maxRecoveries', 'startedAt',
      'admitted', 'active', 'completed', 'blocked', 'remaining', 'published', 'merged',
      'rejected', 'retrying', 'nextRetryAt'],
    ['runId', 'mode', 'status', 'category', 'query', 'reason'], ['supplyExhausted']),
    admission: fields(source.admission, ['maxInFlightLimit', 'intakeWindowLimit'], ['mode']),
    modelCircuit: fields(source.modelCircuit, ['failures', 'nextAt'], ['state', 'trialToken', 'station']),
    ...(circuits ? {
      modelCircuits: circuits.slice(0, MODEL_CIRCUIT_LIMIT).map(value => {
        const circuit = record(value);
        const dependency = record(circuit?.dependency);
        return {
          ...fields(circuit, ['failures', 'nextAt', 'runEndedAt'], ['state', 'reason']),
          ...Object.fromEntries(['runId', 'trialToken', 'station'].flatMap(key =>
            identifier(circuit?.[key]) ? [[key, circuit[key]]] : [])),
          dependency: dependency ? {
            ...fields(dependency, [], ['adapter', 'provider', 'model']),
            ...(identifier(dependency.key) ? {key: dependency.key} : {}),
          } : undefined,
        };
      }),
      ...(circuitCount > MODEL_CIRCUIT_LIMIT ? {modelCircuitCount: circuitCount} : {}),
    } : {}),
  };
}

/** Keep exact identifiers for follow-up tools; never manufacture a truncated ID. */
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function attemptPreview(value: unknown): RecordValue | undefined {
  const source = record(value);
  if (!source || !identifier(source.id) || !identifier(source.node) || !identifier(source.token)) return;
  const metrics = record(source.metrics);
  return {
    ...fields(source, ['startedAt', 'endedAt', 'ms', 'queuedMs', 'input', 'output', 'cost', 'cacheRead', 'cacheWrite'],
      ['item', 'summary'], ['ok', 'cancelled']),
    id: source.id,
    node: source.node,
    token: source.token,
    metrics: metrics ? {
      ...fields(metrics, [], [], ['usageReported', 'usageComplete', 'costReported', 'costComplete',
        'cacheUsageComplete', 'modelTimeReported']),
      execution: fields(metrics.execution, [], ['adapter', 'model', 'provider']),
      tokenUsage: fields(metrics.tokenUsage, USAGE_FIELDS),
    } : undefined,
  };
}

function stationPreview(value: unknown): RecordValue | undefined {
  const source = record(value);
  if (!source || !identifier(source.key)) return;
  const metrics = reportMetrics(source.metrics);
  const tokens = record(metrics?.tokens);
  return {
    ...fields(source, ['layer', 'stockStart', 'stock', 'plus', 'sent', 'merged', 'rejected', 'failed',
      'returned', 'inRun', 'processed', 'medianMs', 'p90Ms', 'waitShare', 'tokens', 'cost',
      'timeShare', 'workers', 'forks', 'retires'], ['name', 'role', 'line']),
    key: source.key,
    metrics: metrics ? {source: metrics.source, coverage: metrics.coverage,
      tokens: {actual: tokens?.actual}, time: metrics.time} : undefined,
  };
}

function boundedLatest(values: unknown[], limit: number, score: (value: RecordValue) => number,
  preview: (value: unknown) => RecordValue | undefined): RecordValue[] {
  const selected: RecordValue[] = [];
  for (const value of values) {
    const source = record(value);
    if (!source) continue;
    const position = selected.findIndex(item => score(source) > score(item));
    if (position < 0) {
      if (selected.length < limit) selected.push(source);
    } else {
      selected.splice(position, 0, source);
      if (selected.length > limit) selected.pop();
    }
  }
  return selected.map(preview).filter((value): value is RecordValue => value !== undefined);
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Accepts a full run report, a station report, or this summary's own output.
 * Unknown shapes are left to the caller. No server imports or report mutation.
 */
export function compactReport(value: unknown): Record<string, unknown> | undefined {
  const report = record(value);
  if (!report || report.version !== 3 || !identifier(report.runId) ||
    typeof report.status !== 'string' || !['idle', 'running', 'paused', 'ended'].includes(report.status) ||
    typeof report.startedAt !== 'number' || !Number.isFinite(report.startedAt) ||
    typeof report.endedAt !== 'number' || !Number.isFinite(report.endedAt) ||
    !Array.isArray(report.attempts)) return;
  const station = report.station;
  const alreadySummary = report.view === 'summary' && report.summaryVersion === 1;
  if (station !== undefined && !identifier(station)) return;
  if (!station && !alreadySummary && (!Array.isArray(report.layers) || !record(report.totals))) return;
  if (station && !alreadySummary && record(report.metrics)?.source !== 'run-journal') return;
  if (alreadySummary && !record(report.counts)) return;

  const attempts = report.attempts;
  const stations: unknown[] = [];
  if (alreadySummary && Array.isArray(report.stations)) stations.push(...report.stations);
  else if (Array.isArray(report.layers)) {
    for (const layer of report.layers) {
      const nodes = record(layer)?.nodes;
      if (Array.isArray(nodes)) stations.push(...nodes);
    }
  }
  const activity = record(report.activity);
  const items = record(report.items);
  const workers = Array.isArray(report.workers) ? report.workers : undefined;
  const insights = Array.isArray(report.insights) ? report.insights : [];
  const counts = alreadySummary ? {
    ...fields(report.counts, ['attempts', 'stations', 'workers', 'workerSpans', 'flows', 'steps',
      'activityIntervals', 'unrecordedAttempts', 'insights', 'suggestions']),
    items: fields(record(report.counts)?.items, ITEM_GROUPS),
  } : {
    attempts: attempts.length,
    stations: station ? 1 : stations.length,
    workers: workers?.length,
    workerSpans: workers?.reduce((count, worker) => {
      const spans = record(worker)?.spans;
      return count + (Array.isArray(spans) ? spans.length : 0);
    }, 0),
    flows: Array.isArray(report.flows) ? report.flows.length : undefined,
    steps: attempts.reduce((count, attempt) => {
      const steps = record(attempt)?.steps;
      return count + (Array.isArray(steps) ? steps.length : 0);
    }, 0),
    activityIntervals: Array.isArray(activity?.intervals) ? activity.intervals.length : undefined,
    unrecordedAttempts: Array.isArray(activity?.unrecordedAttempts) ? activity.unrecordedAttempts.length : undefined,
    insights: Array.isArray(report.insights) ? insights.length : undefined,
    suggestions: Array.isArray(report.suggestions) ? report.suggestions.length : undefined,
    items: items ? Object.fromEntries(ITEM_GROUPS.flatMap(key =>
      Array.isArray(items[key]) ? [[key, items[key].length]] : [])) : undefined,
  };
  const totals = record(report.totals);
  const latestAttempts = boundedLatest(attempts, ATTEMPT_LIMIT,
    attempt => numeric(attempt.endedAt ?? attempt.startedAt), attemptPreview);
  const busiestStations = boundedLatest(stations, STATION_LIMIT,
    node => numeric(node.timeShare), stationPreview);
  const selectedInsights = boundedLatest(insights, INSIGHT_LIMIT,
    insight => numeric(insight.score), insight => fields(insight, ['score'],
      ['id', 'title', 'value', 'detail', 'tone', 'node', 'token']));
  return {
    version: 3,
    view: 'summary',
    summaryVersion: 1,
    runId: report.runId,
    station,
    ...fields(report, ['startedAt', 'endedAt', 'netMs'], ['title', 'status']),
    // A station report never borrows global totals or batch counts.
    ...(station ? {} : {
      batch: batchSummary(report.batch),
      totals: totals ? {
        ...fields(totals, ['published', 'manual', 'failed', 'rejected', 'merged', 'returned', 'corrections',
          'created', 'parked', 'failedAttempts', 'perPublishedMs', 'perPublishedCost', 'perPublishedTokens']),
        usage: fields(totals.usage, USAGE_FIELDS),
      } : undefined,
    }),
    metrics: reportMetrics(report.metrics),
    activity: activity ? {
      ...fields(activity, ['version'], ['source', 'runId', 'station', 'clock', 'aggregation']),
      coverage: fields(activity.coverage, ACTIVITY_COVERAGE_FIELDS),
    } : undefined,
    counts,
    included: {attempts: latestAttempts.length, stations: busiestStations.length, insights: selectedInsights.length},
    attempts: latestAttempts,
    stations: busiestStations,
    insights: selectedInsights,
    detail: {
      note: 'Summary only. counts are full record totals; arrays are bounded previews. Steps, intervals and worker spans are omitted. Text previews may be marked truncated.',
      measurements: 'Legacy numeric cost is a known subtotal. metrics.coverage and metrics.tokens.actual preserve unreported or incomplete usage and cost; unknown is not zero.',
      report: {tool: 'read_report', arguments: {runId: report.runId, ...(station ? {station} : {}), view: 'full'}},
      station: {tool: 'read_report', arguments: {runId: report.runId, station: station ?? '<station key>', view: 'summary'}},
      attempt: {tool: 'inspect', arguments: {attempt: latestAttempts[0]?.id ?? '<attempt id>'}},
    },
  };
}
