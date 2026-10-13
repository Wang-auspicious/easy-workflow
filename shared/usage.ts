import type {AttemptMetrics, Usage} from './types.ts';

export type ObservedUsage = Omit<Usage, 'cost'> & {cost: number | null};

/** Real token receipts are independent of whether the client reports a price. */
export function observedUsage(usage: Usage | undefined, metrics?: AttemptMetrics): ObservedUsage | null {
  const tokens = metrics?.tokenUsage ?? (metrics?.usageReported === false ? undefined : usage);
  if (!tokens) return null;
  return {
    input: tokens.input,
    output: tokens.output,
    ...(tokens.cacheRead === undefined ? {} : {cacheRead: tokens.cacheRead}),
    ...(tokens.cacheWrite === undefined ? {} : {cacheWrite: tokens.cacheWrite}),
    cost: metrics?.costReported === false || usage?.cost === undefined ? null : usage.cost,
  };
}
