// 群组（Room）从流程图上推出来，不是写死的一张表。
//
// 一个群组存在的唯一理由是：**这件活干完之后，必须有人对另一个人说话**。
// 把编译好的图走一遍，只有这几种结构会强制产生对话：
//
//   返工/复审环   审阅工位能把活退回去 → 它必须说清楚哪里不行。            → loop（规格声明的退回边）
//   实际咨询      审阅工位点名字段负责人改，负责人回话再复查。（运行期）    → loop（观测到的 consult）
//   同一段工序    同一段 part 里的几个工位共享同一份输入，口径必须对齐。    → part
//   跨段移交      一条活从一条线交给另一条线，接口要当面讲清。              → bridge
//
// 程序工位不是 Agent，也不说话；这里如实标注它们的 kind，外观交由界面区分，
// 不把程序节点伪装成 Agent（AGENTS.md）。你（站长）永远在每一个群里。
import type { CompiledFactory, CompiledNode, Role, StationKind } from './types.ts';

export type RoomKind = 'root' | 'part' | 'loop' | 'bridge';

/** 群里一个成员。`kind` 保持原样：程序工位就是程序工位。 */
export interface RoomMember {
  key: string;
  name: string;
  role: Role;
  kind: StationKind;
  line: string;
  /** 会说话的工位（agent / review）才进头像栈。 */
  talks: boolean;
}

export interface RoomSpec {
  id: string;
  kind: RoomKind;
  name: string;
  /** 一句话说明这个群为什么存在。 */
  subtitle: string;
  line: string | null;
  /** 跨段移交的对面那条线。 */
  peerLine: string | null;
  members: RoomMember[];
  /** 推导依据：命中相位 / 边键 / 信道 id。 */
  signal: string[];
  /** 只有一个人会说话（其余是程序工位），界面上标成值守而不是讨论。 */
  solo: boolean;
  /** 运行期观测到的咨询才成立的群，静态图上没有。 */
  observed: boolean;
}

export const ROOT_ROOM = 'root';

/** 会说话的工位：Agent 与审阅是模型在说话；program / gate / store / source 是机器。 */
export const talks = (node: Pick<CompiledNode, 'kind'>): boolean => node.kind === 'agent' || node.kind === 'review';

export const memberOf = (node: CompiledNode): RoomMember => ({
  key: node.key, name: node.name, role: node.role, kind: node.kind, line: node.line, talks: talks(node),
});

/** 观测到的一次咨询（来自运行日志的 consult 记录），用来补上静态图没声明的往来。 */
export interface ObservedConsult { reviewer: string; owner: string }

/** 相位名 → part 名；包没给 phases 的线，整条线算一个 part。 */
function partsOf(factory: CompiledFactory): { line: string; name: string; index: number; stations: string[] }[] {
  const parts: { line: string; name: string; index: number; stations: string[] }[] = [];
  for (const line of factory.lines) {
    const phases = factory.ui.hints[line.id]?.phases;
    if (phases?.length) phases.forEach((phase, index) => parts.push({ line: line.id, name: phase.name, index, stations: [...phase.stations] }));
    else parts.push({ line: line.id, name: line.name, index: 0, stations: line.stations.map((s) => s.id) });
  }
  return parts;
}

/** 从一端出发找"负责人"：向前/向后走，第一个会说话的工位；找不到就还是它自己。 */
function owner(
  byKey: Map<string, CompiledNode>, incoming: Map<string, string[]>, outgoing: Map<string, string[]>,
  from: string, direction: 'back' | 'forward',
): CompiledNode | undefined {
  const seen = new Set<string>([from]);
  const queue = [from];
  let fallback = byKey.get(from);
  while (queue.length) {
    const key = queue.shift()!;
    const node = byKey.get(key);
    if (!node) continue;
    if (talks(node)) return node;
    fallback ??= node;
    for (const next of (direction === 'back' ? incoming : outgoing).get(key) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return fallback;
}

const signature = (members: readonly RoomMember[]): string => members.map((m) => m.key).sort().join('|');

/**
 * 把编译好的工厂走一遍，列出所有"需要说话"的地方。
 * 同一个工位可以出现在多个群里：跨段移交本来就是两个群的交集。
 *
 * `observed` 是运行期真实发生的 reviewe↔owner 咨询；它只补静态图没有的往来，
 * 不会削掉规格里声明过的群。
 */
export function deriveRooms(factory: CompiledFactory | null, observed: readonly ObservedConsult[] = []): RoomSpec[] {
  const root: RoomSpec = {
    id: ROOT_ROOM, kind: 'root', name: '主调度', line: null, peerLine: null, members: [], solo: false, observed: false,
    subtitle: '你和主调度。所有工位的编排、纠错与报告都从这里进出。',
    signal: ['root'],
  };
  if (!factory) return [root];

  const byKey = new Map(factory.nodes.map((n) => [n.key, n]));
  const lineName = (id: string | null) => factory.lines.find((l) => l.id === id)?.name ?? id ?? '';
  const wiredLine = (id: string | null) => Boolean(factory.lines.find((l) => l.id === id)?.wired);
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const link = (index: Map<string, string[]>, key: string, value: string) => {
    const list = index.get(key);
    if (list) list.push(value);
    else index.set(key, [value]);
  };
  for (const edge of factory.edges) {
    link(outgoing, edge.from, edge.to);
    link(incoming, edge.to, edge.from);
  }

  const rooms: RoomSpec[] = [root];
  const seen = new Set<string>();
  const push = (room: Omit<RoomSpec, 'peerLine' | 'observed' | 'solo'> & Partial<Pick<RoomSpec, 'peerLine' | 'observed' | 'solo'>>) => {
    if (room.members.length < 2) return;
    const key = signature(room.members);
    if (seen.has(key)) return;
    seen.add(key);
    rooms.push({ peerLine: null, observed: false, solo: false, ...room } as RoomSpec);
  };

  /* ---------------------------------------------------------------- part：一段工序 */
  for (const part of partsOf(factory)) {
    const members = part.stations
      .map((id) => byKey.get(id.includes('/') ? id : `${part.line}/${id}`))
      .filter((n): n is CompiledNode => Boolean(n)).map(memberOf);
    if (!members.length) continue;
    const speakers = members.filter((m) => m.talks);
    if (!speakers.length) continue;
    push({
      id: `part:${part.line}:${part.index}`, kind: 'part', name: part.name, line: part.line, members,
      solo: speakers.length === 1,
      subtitle: speakers.length === 1
        ? `${lineName(part.line)} · 只有 ${speakers[0]!.name} 会说话，其余是程序工位。`
        : `${lineName(part.line)} · ${speakers.length} 个工位共享同一份输入，判断需要彼此对齐。`,
      signal: [`part:${part.line}:${part.name}`],
    });
  }

  /* ---------------------------------------------------------------- loop：声明的返工环 */
  const returns = new Map<string, { to: string; signal: string }[]>();
  for (const edge of factory.edges) {
    if (edge.kind !== 'return') continue;
    const list = returns.get(edge.from);
    if (list) list.push({ to: edge.to, signal: edge.key });
    else returns.set(edge.from, [{ to: edge.to, signal: edge.key }]);
  }
  for (const [reviewerKey, targets] of returns) {
    const reviewer = byKey.get(reviewerKey);
    if (!reviewer || !talks(reviewer)) continue;
    const members = [memberOf(reviewer)];
    for (const target of targets) {
      const node = byKey.get(target.to);
      if (node && !members.some((m) => m.key === node.key)) members.push(memberOf(node));
    }
    push({
      id: `loop:${reviewerKey}`, kind: 'loop', name: `${reviewer.name} · 返工环`, line: reviewer.line, members,
      subtitle: `退回去改，再回来看同一批字段：${members.slice(1).map((m) => m.name).join('、')}。`,
      signal: targets.map((t) => t.signal),
    });
  }

  /* ---------------------------------------------------------------- loop：运行期实际发生的咨询 */
  const byReviewer = new Map<string, Set<string>>();
  for (const pair of observed) {
    if (!byKey.has(pair.reviewer) || !byKey.has(pair.owner) || pair.reviewer === pair.owner) continue;
    const owners = byReviewer.get(pair.reviewer);
    if (owners) owners.add(pair.owner);
    else byReviewer.set(pair.reviewer, new Set([pair.owner]));
  }
  for (const [reviewerKey, owners] of byReviewer) {
    const reviewer = byKey.get(reviewerKey);
    if (!reviewer || !talks(reviewer)) continue;
    const members = [memberOf(reviewer), ...[...owners].sort().map((key) => byKey.get(key)).filter((n): n is CompiledNode => Boolean(n)).map(memberOf)];
    // 静态图里已经有一个正好装着这批人的群，就不再重复一个。
    if (rooms.some((room) => room.kind !== 'root' && members.every((m) => room.members.some((x) => x.key === m.key)))) continue;
    push({
      id: `loop:${reviewerKey}`, kind: 'loop', name: `${reviewer.name} · 复审往来`, line: reviewer.line, members, observed: true,
      subtitle: `审阅时点名的字段负责人都在这里：${members.slice(1).map((m) => m.name).join('、')}。`,
      signal: [...owners].map((key) => `consult:${reviewerKey}>${key}`),
    });
  }

  /* ---------------------------------------------------------------- bridge：跨段移交 */
  const crossings: { from: string; to: string; label: string; signal: string }[] = [
    ...factory.channels.map((c) => ({
      from: `${c.from.line}/${c.from.station}`, to: `${c.to.line}/${c.to.station}`, label: c.label, signal: c.id,
    })),
  ];
  for (const edge of factory.edges) {
    if (edge.kind !== 'flow') continue;
    const a = byKey.get(edge.from), b = byKey.get(edge.to);
    if (!a || !b || a.line === b.line) continue;
    crossings.push({ from: edge.from, to: edge.to, label: edge.label ?? '跨段', signal: edge.key });
  }
  for (const cross of crossings) {
    const left = owner(byKey, incoming, outgoing, cross.from, 'back');
    const right = owner(byKey, incoming, outgoing, cross.to, 'forward');
    if (!left || !right || left.key === right.key) continue;
    // 未接线的线（sources 这类休眠层）不产生真实往来。
    if (!wiredLine(left.line) || !wiredLine(right.line)) continue;
    const members = [memberOf(left), memberOf(right)];
    const speakers = members.filter((m) => m.talks);
    if (!speakers.length) continue;
    push({
      id: `bridge:${cross.from}>${cross.to}`, kind: 'bridge', name: cross.label, line: left.line, peerLine: right.line,
      members, solo: speakers.length === 1,
      subtitle: `${lineName(left.line)}的 ${left.name} 交给 ${lineName(right.line)}的 ${right.name}，接口要当面讲清。`,
      signal: [cross.signal],
    });
  }

  return rooms;
}

/** 一个工位属于哪些群：从画布跳到群组用这个。 */
export function roomsOf(rooms: readonly RoomSpec[], nodeKey: string): RoomSpec[] {
  return rooms.filter((room) => room.members.some((m) => m.key === nodeKey));
}

/** 房间里的"会说话的人"：头像栈和未读都只看这些。 */
export const speakersOf = (room: RoomSpec): RoomMember[] => room.members.filter((m) => m.talks);
