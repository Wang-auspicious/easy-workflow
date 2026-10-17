import type {CompiledFactory, Stamped} from '../../shared/types.ts';
import {deriveRooms, memberOf, type RoomSpec} from '../../shared/rooms.ts';
import {streamOf, type KernelStreams, type StationNumbers, type AttentionCard} from '../../shared/streams.ts';
import type {RoomContext, RoomLine, RoomActor} from './chat/rooms.ts';

export type KernelStationNumbers = StationNumbers;
export type KernelAttention = AttentionCard;
export interface KernelSnapshot extends KernelStreams {kernel: 'v2'}

const fieldNames: Record<string, string> = {kind: '分类', 'shots.*': '三屏', style: '风格', 'facts.*': '事实', copy: '文案'};
export const waitingNames = {model: '模型', budget: '预算', room: '讨论', backoff: '退避', resource: '资源', supervisor: '主调度'};
export const fieldMatches = (pattern: string, field: string) => pattern === field || pattern.endsWith('.*') &&
  (field === pattern.slice(0, -2) || field.startsWith(pattern.slice(0, -1)));

export function kernelRooms(factory: CompiledFactory | null): RoomSpec[] {
  const root = deriveRooms(factory)[0];
  if (!factory) return [root];
  return [root, ...(factory.rooms ?? []).map(policy => {
    const keys = [...new Set([...policy.participants, policy.judge].filter(key => !key.startsWith('program:')))];
    const members = keys.flatMap(key => {
      const node = factory.nodes.find(value => value.key === key);
      return node ? [memberOf(node)] : [];
    });
    return {id: `field:${policy.field}`, kind: 'part' as const, name: fieldNames[policy.field] ?? policy.field,
      subtitle: '围绕这一字段的质疑、答复与讨论', line: members[0]?.line ?? null, peerLine: null,
      members, signal: [policy.field], solo: members.filter(member => member.talks).length < 2, observed: false};
  })];
}

export function mergeKernelEvents(previous: readonly Stamped[], incoming: readonly Stamped[]): Stamped[] {
  const events = new Map(previous.map(event => [event.seq, event]));
  for (const event of incoming) if (['conversation', 'progress'].includes(streamOf(event))) events.set(event.seq, event);
  const sorted = [...events.values()].sort((a, b) => a.seq - b.seq);
  return [...sorted.filter(event => streamOf(event) === 'conversation').slice(-1000),
    ...sorted.filter(event => streamOf(event) === 'progress').slice(-1000)].sort((a, b) => a.seq - b.seq);
}

export function kernelRoomLines(room: RoomSpec, ctx: RoomContext, events: readonly Stamped[], showProgress: boolean): RoomLine[] {
  const actor = (key: string): RoomActor => {
    const clean = key.replace(/^program:/, '');
    const node = ctx.factory?.nodes.find(value => value.key === clean);
    const look = node && ctx.look(clean);
    return node ? {key: clean, name: node.name, kind: node.kind, node: clean, line: node.line,
      shape: look?.shape ?? 'blob', hue: look?.hue ?? 250, state: look?.state ?? 'idle'}
      : {key, name: key === 'user' ? '你' : '主调度', kind: key === 'user' ? 'user' : 'dispatcher', shape: 'blob', hue: 256, state: 'idle'};
  };
  const rows: RoomLine[] = [];
  const postRows = new Map<string, RoomLine>();
  for (const event of events) {
    const stream = streamOf(event);
    if (stream === 'progress' && !showProgress || !['progress', 'conversation'].includes(stream)) continue;
    if (event.kind === 'board.posted') {
      const post = event.post;
      if (post.type === 'claim' || room.kind === 'root' || !fieldMatches(room.signal[0], post.field)) continue;
      postRows.set(post.id, {id: post.id, at: post.at, actor: actor(post.author), to: post.addressee ? actor(post.addressee) : null,
        kind: 'note', label: ({challenge: '质疑', answer: '答复', question: '提问', evidence: '证据', resolve: '解决', note: '备注'} as Record<string, string>)[post.type],
        text: post.body, token: post.item, note: post.status, tone: post.type === 'challenge' ? 'warn' : undefined});
    } else if (event.kind === 'room.opened' || event.kind === 'room.round' || event.kind === 'room.closed') {
      if (room.kind === 'root' || !fieldMatches(room.signal[0], event.room.field)) continue;
      rows.push({id: `event-${event.seq}`, at: event.at, actor: actor('supervisor'), to: null, kind: 'note',
        label: event.kind === 'room.opened' ? '开会' : event.kind === 'room.round' ? '下一轮' : '结束讨论', token: event.room.item,
        text: `${event.room.topic} · 第 ${event.room.round}/${event.room.maxRounds} 轮${event.room.outcome?.reason ? ` · ${event.room.outcome.reason}` : ''}`,
        note: event.room.status});
    } else if (stream === 'progress') {
      const attempt = 'attempt' in event ? ctx.state.attempts[event.attempt] : undefined;
      const key = 'node' in event && typeof event.node === 'string' ? event.node : attempt?.node ??
        (event.kind === 'evidence.added' ? event.evidence.station : undefined);
      if (room.kind !== 'root' && !room.members.some(member => member.key === key)) continue;
      const token = 'token' in event && typeof event.token === 'string' ? event.token : attempt?.token ?? '';
      const text = event.kind === 'attempt.progress' ? event.text : event.kind === 'attempt.finished' ? event.summary :
        event.kind === 'attempt.started' ? '开始处理' : event.kind === 'token.queued' ? '进入待处理队列' :
          event.kind === 'evidence.added' ? `新增证据：${event.evidence.label}` : event.kind === 'token.created' ? `新货：${event.title ?? event.item}` :
            event.kind === 'token.data' ? '任务数据已更新' : event.kind === 'resource.sample' ? '资源状态已更新' :
              event.kind === 'attempt.activity' ? `${event.activity.toolName ?? '模型'} · ${event.activity.status}` : undefined;
      if (text) rows.push({id: `event-${event.seq}`, at: event.at, actor: actor(key ?? 'supervisor'), to: null,
        kind: 'note', label: '进展', token, text});
    }
  }
  return [...rows, ...postRows.values()].sort((a, b) => a.at - b.at);
}
