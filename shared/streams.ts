export type Stream = 'progress' | 'conversation' | 'attention' | 'none';

export const BUDGET_ATTENTION_MS = 10 * 60 * 1000;
export const ATTENTION_CODES: ReadonlySet<string> = new Set([
  'auth', 'tls', 'http_forbidden', 'EXTERNAL_OPERATION_UNKNOWN', 'room_unresolved', 'manual_store',
]);

export interface StreamSummary {
  running: number;
  waitingResource: number;
  waitingModel: number;
  published: number;
  needsUser: number;
}

export interface AttentionCard {
  id: string;
  item?: string;
  node?: string;
  title: string;
  reason: string;
  code: string;
  at: number;
  action: 'view' | 'continue_budget' | 'approval';
  patchId?: string;
}

export interface StationNumbers {
  ready: number;
  running: number;
  waiting: {model: number; budget: number; room: number; backoff: number; resource: number; supervisor: number};
  done: number;
  parked: number;
}

export interface KernelStreams {
  summary: StreamSummary;
  attention: AttentionCard[];
  stations: Record<string, StationNumbers>;
}

const progress = new Set([
  'attempt.started', 'attempt.progress', 'attempt.activity', 'attempt.finished',
  'token.queued', 'token.data', 'token.created', 'evidence.added', 'resource.sample',
]);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Classification uses only the receipt's timestamp, never the wall clock. */
export function streamOf(value: unknown): Stream {
  const event = object(value);
  if (!event || typeof event.kind !== 'string') return 'none';
  if (event.kind === 'alert.raised' || event.kind === 'spec.patched' && event.status === 'proposed') return 'attention';
  if (event.kind === 'token.data') {
    const kernel = object(object(object(event.patch)?.runtimeCheckpoint)?.kernel);
    if (kernel?.status === 'parked' && ATTENTION_CODES.has(String(object(kernel.parked)?.code))) return 'attention';
    const nodes = object(kernel?.nodes);
    if (kernel?.status === 'active' && nodes && typeof event.at === 'number' && Number.isFinite(event.at)) {
      const at = event.at;
      if (Object.values(nodes).some(value => {
        const node = object(value);
        return node?.status === 'waiting' && node.waitingFor === 'budget' &&
          typeof node.waitingSince === 'number' && Number.isFinite(node.waitingSince) &&
          at - node.waitingSince > BUDGET_ATTENTION_MS;
      })) return 'attention';
    }
  }
  if (event.kind === 'board.posted') {
    const post = object(event.post);
    return post && typeof post.type === 'string' && post.type !== 'claim' ? 'conversation' : 'none';
  }
  if (event.kind.startsWith('room.') || event.kind.startsWith('chat.') || event.kind === 'supervisor.summary') return 'conversation';
  return progress.has(event.kind) ? 'progress' : 'none';
}
