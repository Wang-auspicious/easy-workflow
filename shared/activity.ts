import type { ActivitySpan, AttemptActivity } from "./types.ts";

/** Merge boundary events and terminal snapshots without duplicating or reopening spans. */
export function mergeActivity(previous?: AttemptActivity, next?: AttemptActivity): AttemptActivity | undefined {
  if (!previous && !next) return undefined;
  const spans = new Map<string, ActivitySpan>();
  for (const span of [...previous?.spans ?? [], ...next?.spans ?? []]) {
    const prior = spans.get(span.id);
    if (!prior || prior.endedAt === undefined || span.endedAt !== undefined) spans.set(span.id, { ...span });
  }
  return { version: 1, modelTiming: previous?.modelTiming === "observed" || next?.modelTiming === "observed" ? "observed" : "unavailable",
    spans: [...spans.values()].sort((a, b) => a.startedAt - b.startedAt) };
}
