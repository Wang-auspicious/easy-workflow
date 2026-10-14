import type {FactoryState} from '../shared/project.ts';
import type {Runtime} from './runtime.ts';

/** A retry must not add another task behind the same explicitly paused frontier.
 * Channel children retain their independent admission from ordinary parents. */
export function pausedFrontierBlocksRecovery(runtime: Runtime, entry: string, automaticOnly = false): boolean {
  for (const token of runtime.tokens.values()) {
    if (token.finished || token.inflight.size) continue;
    if (automaticOnly && !token.data.sourceCandidate && !token.data.channelDelivery &&
        !token.source.startsWith('source:') && !token.source.startsWith('channel:')) continue;
    const frontier = [...token.closure].filter(key =>
      !token.done.has(key) && !token.dead.has(key) && runtime.queues.get(key)?.includes(token.id));
    if (frontier.length && frontier.every(key => runtime.scopePaused(key)) &&
        runtime.occupiesAdmission(token, entry)) return true;
  }
  return false;
}

/** Alternate actual checkpoint claims with fresh automatic roots. The journal's
 * creation order is the cursor, so an empty offer never consumes a turn and a
 * process restart cannot reset it. Resource limits remain with each supervisor. */
export function recoveryHasNextTurn(state: FactoryState): boolean {
  for (let index = state.tokenOrder.length - 1; index >= 0; index--) {
    const token = state.tokens[state.tokenOrder[index]];
    if (!token || token.createdAt < state.run.startedAt) continue;
    if (typeof token.data.retryOf === 'string') return false;
    if (token.source === 'candidates/pool' || token.source.startsWith('source:') ||
        token.source.startsWith('channel:') || token.data.sourceCandidate || token.data.channelDelivery) return true;
  }
  return true;
}
