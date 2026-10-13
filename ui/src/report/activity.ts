import type { AttemptMetrics } from "../../../shared/types.ts";

export interface ActivityAttempt {
  id: string; node: string; startedAt: number; endedAt?: number; ms: number; queuedMs: number;
  input: number; output: number; cost: number; cacheRead?: number; cacheWrite?: number; metrics?: AttemptMetrics;
}
export type TimeKey = "first" | "output" | "tool" | "program" | "other" | "queue" | "unknown";
export interface DisplayInterval {
  id: string; attempt: string; from: number; to?: number;
  /** A live display bound, never an observed end timestamp. */
  through?: number;
  key: TimeKey; quality: "observed" | "estimated" | "unknown";
  state: "ended" | "running" | "unknown_end";
  label?: string; weights?: Partial<Record<TimeKey, number>>;
}
export interface TimeSegment { from: number; to: number; keys: TimeKey[]; intervals: DisplayInterval[] }
export interface TimeStrip { start: number; end: number; segments: TimeSegment[]; markers: DisplayInterval[] }
const priority: TimeKey[] = ["tool", "output", "first", "program", "queue", "other", "unknown"];
const endOf = (span: DisplayInterval) => span.to ?? span.through ?? span.from;
const positive = (n: number | undefined) => Number.isFinite(n) ? Math.max(0, n!) : 0;

/** Exact endpoint sweep; parallel instances of one category never multiply wall time. */
export function timeStrip(intervals: DisplayInterval[]): TimeStrip | null {
  if (!intervals.length) return null;
  const events = new Map<number, { start: DisplayInterval[]; end: DisplayInterval[] }>();
  const event = (at: number) => { let value = events.get(at); if (!value) { value = { start: [], end: [] }; events.set(at, value); } return value; };
  for (const span of intervals) {
    if (!Number.isFinite(span.from) || !Number.isFinite(endOf(span))) continue;
    event(span.from); event(endOf(span));
    if (endOf(span) > span.from) { event(span.from).start.push(span); event(endOf(span)).end.push(span); }
  }
  const bounds = [...events.keys()].sort((a, b) => a - b);
  if (!bounds.length) return null;
  const segments: TimeSegment[] = [];
  const present = new Set<DisplayInterval>();
  for (let i = 1; i < bounds.length; i++) {
    const from = bounds[i - 1], to = bounds[i];
    for (const span of events.get(from)!.end) present.delete(span);
    for (const span of events.get(from)!.start) present.add(span);
    if (to <= from) continue;
    const active = [...present];
    const keys = [...new Set(active.map(span => span.weights
      ? Object.entries(span.weights).sort((a, b) => b[1]! - a[1]!)[0]?.[0] as TimeKey ?? "unknown" : span.key))];
    keys.sort((a, b) => priority.indexOf(a) - priority.indexOf(b));
    segments.push({ from, to, keys, intervals: active });
  }
  return { start: bounds[0], end: bounds.at(-1)!, segments, markers: intervals.filter(span => span.to === undefined && span.through === undefined) };
}

export function buildTimeView(attempts: ActivityAttempt[], options: { live: boolean; observedUntil: number; programNodes?: ReadonlySet<string> }) {
  const intervals: DisplayInterval[] = [];
  const coverage = { attempts: attempts.length, observed: 0, estimated: 0, unknown: 0, running: 0, unknownEnd: 0 };
  for (const a of attempts) {
    const metrics = a.metrics, activity = metrics?.activity;
    const live = options.live && a.endedAt === undefined;
    const end = a.endedAt !== undefined && a.endedAt >= a.startedAt ? a.endedAt : undefined;
    const through = live ? Math.max(a.startedAt, options.observedUntil) : undefined;
    const bound = end ?? through;
    const state = end !== undefined ? "ended" : live ? "running" : "unknown_end";
    const closed = metrics?.execution?.adapter === "closed-command";
    // The current graph can identify a still-running worker only. Finished and
    // historical attempts keep their own recorded execution identity after edits.
    const program = !metrics?.execution && (positive(metrics?.time?.programMs) > 0 || (live && options.programNodes?.has(a.node)));
    const add = (span: Omit<DisplayInterval, "attempt">) => intervals.push({ ...span, attempt: a.id });
    if (end !== undefined && a.queuedMs > 0) add({ id: `${a.id}:queue`, from: a.startedAt - a.queuedMs, to: a.startedAt, key: "queue", quality: "observed", state: "ended" });

    if (!activity && !program && !closed && metrics?.time && bound !== undefined) {
      const t = metrics.time;
      const weights = { first: metrics.modelTimeReported === false ? 0 : positive(t.firstTokenMs), output: metrics.modelTimeReported === false ? 0 : positive(t.outputMs), tool: positive(t.toolMs), program: positive(t.programMs) };
      const known = Object.values(weights).reduce((sum, n) => sum + n, 0);
      const remainder = Math.max(0, bound - a.startedAt - known);
      add({ id: `${a.id}:legacy`, from: a.startedAt, to: end, through, key: "unknown", quality: "estimated", state,
        weights: { ...weights, [metrics.modelTimeReported === false || known === 0 ? "unknown" : "other"]: remainder } });
      coverage.estimated++;
    } else {
      const leaves: DisplayInterval[] = (activity?.spans ?? []).filter(span => span.kind !== "model_request").map(span => ({
        id: span.id, attempt: a.id, from: span.startedAt, to: span.endedAt,
        through: span.endedAt === undefined && live ? Math.max(span.startedAt, options.observedUntil) : undefined,
        key: span.kind === "first_token" ? "first" : span.kind === "model_output" ? "output" : "tool",
        quality: "observed", state: span.endedAt !== undefined ? "ended" : live ? "running" : "unknown_end",
        label: span.kind === "tool" ? [span.toolName, span.operation].filter(Boolean).join(" · ") : span.model,
      }));
      intervals.push(...leaves);
      if (program || leaves.length) coverage.observed++; else coverage.unknown++;
      if (bound !== undefined) {
        const requests = (activity?.spans ?? []).filter(span => span.kind === "model_request");
        const points = [...new Set([a.startedAt, bound, ...leaves.flatMap(span => [span.from, endOf(span)]), ...requests.flatMap(span => [span.startedAt, span.endedAt ?? bound])])]
          .filter(at => at >= a.startedAt && at <= bound).sort((a, b) => a - b);
        for (let i = 1; i < points.length; i++) {
          const from = points[i - 1], to = points[i];
          if (to <= from || leaves.some(span => span.from < to && endOf(span) > from)) continue;
          const missingEnd = leaves.some(span => span.state === "unknown_end" && span.from < to);
          const missingModelPhase = requests.some(span => span.startedAt < to && (span.endedAt ?? bound) > from);
          const unknown = missingEnd || missingModelPhase || (!program && (closed || activity?.modelTiming !== "observed"));
          add({ id: `${a.id}:gap:${i}`, from, ...(end === undefined && to === through ? { through: to } : { to }),
            key: unknown ? "unknown" : program ? "program" : "other", quality: unknown ? "unknown" : "observed",
            state: end === undefined && to === through ? "running" : "ended" });
        }
      } else if (!leaves.length) {
        add({ id: `${a.id}:unclosed`, from: a.startedAt, key: program ? "program" : "unknown", quality: "unknown", state: "unknown_end" });
      }
    }
    if (live) coverage.running++;
    if (!live && (end === undefined || activity?.spans.some(span => span.endedAt === undefined))) coverage.unknownEnd++;
  }
  const totals = Object.fromEntries(priority.map(key => [key, 0])) as Record<TimeKey, number>;
  const estimated = new Set<TimeKey>();
  // Sum attempt wall time, unioning parallel tools inside each attempt. Concurrent
  // stations still contribute separate worker time, as the existing ring states.
  const byAttempt = new Map<string, DisplayInterval[]>();
  for (const span of intervals) { const list = byAttempt.get(span.attempt) ?? []; list.push(span); byAttempt.set(span.attempt, list); }
  for (const list of byAttempt.values()) for (const segment of timeStrip(list)?.segments ?? []) {
    const duration = segment.to - segment.from;
    const legacy = segment.intervals.find(span => span.weights);
    if (legacy?.weights) {
      const total = Object.values(legacy.weights).reduce((sum, n) => sum + (n ?? 0), 0);
      if (!total) totals.unknown += duration;
      else for (const [key, value] of Object.entries(legacy.weights)) if (value) { totals[key as TimeKey] += duration * value / total; estimated.add(key as TimeKey); }
    } else if (segment.keys[0]) totals[segment.keys[0]] += duration;
  }
  return { intervals, strip: timeStrip(intervals), totals, estimated, coverage };
}

export const hasReportedUsage = (a: ActivityAttempt) => Boolean(a.metrics?.tokenUsage) || a.metrics?.usageReported === true || (a.metrics?.usageReported !== false && (a.input > 0 || a.output > 0 || a.cost > 0));

/** A default zero in a projection or missing cache field is not a provider report. */
export function usageSummary(attempts: ActivityAttempt[]) {
  const reported = attempts.filter(hasReportedUsage).map(attempt => ({...attempt,
    input: attempt.metrics?.tokenUsage?.input ?? attempt.input,
    output: attempt.metrics?.tokenUsage?.output ?? attempt.output,
    cacheRead: attempt.metrics?.tokenUsage ? attempt.metrics.tokenUsage.cacheRead : attempt.cacheRead,
    cacheWrite: attempt.metrics?.tokenUsage ? attempt.metrics.tokenUsage.cacheWrite : attempt.cacheWrite,
  }));
  const complete = reported.filter(attempt => attempt.metrics?.usageComplete === true);
  const sum = (key: 'input' | 'output') => reported.length ? reported.reduce((total, a) => total + a[key], 0) : null;
  const costs = reported.filter(attempt => attempt.metrics?.costReported !== false);
  const costComplete = costs.length > 0 && costs.length === reported.length && costs.every(attempt => attempt.metrics?.costComplete !== false && attempt.metrics?.usageComplete !== false);
  const cacheComplete = reported.length > 0 && reported.every(a => a.metrics?.usageComplete === true && a.metrics?.cacheUsageComplete === true && a.cacheRead !== undefined && a.cacheWrite !== undefined);
  const cacheRead = cacheComplete ? reported.reduce((total, a) => total + a.cacheRead!, 0) : null;
  const cacheWrite = cacheComplete ? reported.reduce((total, a) => total + a.cacheWrite!, 0) : null;
  const input = sum('input'), output = sum('output');
  const cost = costs.length ? costs.reduce((total, attempt) => total + attempt.cost, 0) : null;
  const denominator = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  const speedSamples = complete.filter(a => a.metrics?.modelTimeReported !== false && positive(a.metrics?.time?.outputMs) > 0);
  const outputMs = speedSamples.reduce((total, a) => total + a.metrics!.time!.outputMs, 0);
  return { input, output, cost, total: input === null || output === null ? null : input + output,
    reported: reported.length, complete: complete.length, attempts: attempts.length,
    costReported: costs.length, costComplete,
    cacheHitRate: cacheComplete && denominator > 0 ? cacheRead! / denominator : null,
    outputPerSecond: outputMs > 0 ? speedSamples.reduce((total, a) => total + a.output, 0) * 1000 / outputMs : null };
}
