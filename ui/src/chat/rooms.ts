// 群组面板的数据层。和 transcript.ts 一样只做整理与判定，不碰 DOM，方便单测。
//
// 一个群里的"交流"= 日志里真实发生过的工位往来：
//   咨询（consult）  审阅点名要求改，负责人回话，审阅再复查
//   判定（verdict）  通过 / 退回 / 转人工，带原因
//   退回（return）   第几轮退回、退回给谁、为什么
//   交付（channel）  跨线交付一件货
//   纠错（correction）你或主调度改了一个工位的做法
//   播报（note）     工位自己发出的提示
//
// 一条消息只出现在最贴切的那个群里：同时含收发双方的群最贴切，其次
// 含其中一方的群里挑人数最少的。这样同一个群里的对话不会被复制到五个群。
import type { CompiledFactory, StationKind } from "../../../shared/types.ts";
import type { CommEntry, FactoryState } from "../../../shared/project.ts";
import type { RoomSpec } from "../../../shared/rooms.ts";
import { roomsOf } from "../../../shared/rooms.ts";
import type { AvatarState } from "./avatar-look.ts";
import type { StationLook } from "./station-look.ts";

export const DISPATCHER_KEY = "dispatcher";
export const USER_KEY = "user";

export type RoomActorKind = StationKind | "dispatcher" | "user";

export interface RoomActor {
  key: string;
  name: string;
  kind: RoomActorKind;
  shape: StationLook["shape"];
  hue: number;
  state: AvatarState;
  line?: string;
  /** 点开检查器/画布用；只有工位有。 */
  node?: string;
}

export interface RoomLine {
  id: string;
  at: number;
  actor: RoomActor;
  /** 说给谁听；null = 说给群里所有人。 */
  to: RoomActor | null;
  kind: CommEntry["kind"];
  text: string;
  tone?: "info" | "fork" | "warn";
  token: string;
  /** 相关的证据/恢复提示，界面按需展示。 */
  note?: string;
}

export interface RoomSummary {
  room: RoomSpec;
  speakers: RoomActor[];
  /** 现在有几个成员在跑。 */
  running: number;
  state: AvatarState;
  preview: string;
  previewAt: number;
  unread: number;
  count: number;
  tone?: "info" | "fork" | "warn";
}

/** 状态合并：一个群的小人脸上显示这里最"忙"的那一个。 */
const STATE_RANK: Record<AvatarState, number> = {
  fail: 7, work: 6, speaking: 5, thinking: 4, wait: 3, returned: 2, idle: 1, sleep: 0,
};

export function mergeState(states: readonly AvatarState[]): AvatarState {
  let best: AvatarState = "idle";
  for (const state of states) if (STATE_RANK[state] > STATE_RANK[best]) best = state;
  return best;
}

function stationActor(key: string, ctx: RoomContext): RoomActor | null {
  const node = ctx.factory?.nodes.find((n) => n.key === key);
  if (!node) return null;
  const look = ctx.look(key);
  if (!look) return null;
  return { key, name: node.name, kind: node.kind, line: node.line, node: key, shape: look.shape, hue: look.hue, state: look.state };
}

export interface RoomContext {
  factory: CompiledFactory | null;
  state: FactoryState;
  /** 工位外观与动作。由界面注入，与画布、转录用同一只小人。 */
  look: (key: string) => StationLook | undefined;
  now: number;
}

/** 群成员 → 演员。主调度和你没有工位状态，固定为模板头像与空闲。 */
function actorFor(key: string, ctx: RoomContext): RoomActor | null {
  if (key === DISPATCHER_KEY) return { key, name: "主调度", kind: "dispatcher", shape: "blob", hue: 256, state: "idle" };
  if (key === USER_KEY) return { key, name: "你", kind: "user", shape: "squircle", hue: 250, state: "idle" };
  return stationActor(key, ctx);
}

function memberActors(room: RoomSpec, ctx: RoomContext): RoomActor[] {
  const actors: RoomActor[] = [];
  for (const member of room.members) {
    const actor = actorFor(member.key, ctx);
    if (actor) actors.push(actor);
  }
  return actors;
}

/**
 * 一条消息落在哪个群：先看收发双方是不是都在群里，再看只有一方在的群（挑最小的）。
 * 信道事件没有收发工位，用群自己记着的 signal（信道 id / 边键）对上。
 */
export function routeComm(entry: CommEntry, rooms: readonly RoomSpec[]): RoomSpec | null {
  if (entry.from.startsWith("channel:")) {
    const id = entry.from.slice("channel:".length);
    return rooms.find((room) => room.signal.includes(id)) ?? null;
  }
  let best: RoomSpec | null = null;
  let bestScore = 0;
  for (const room of rooms) {
    if (room.kind === "root") continue;
    const hasFrom = room.members.some((m) => m.key === entry.from);
    const hasTo = entry.to !== null && entry.to !== "*" && room.members.some((m) => m.key === entry.to);
    const score = hasFrom && hasTo ? 2 : hasFrom || hasTo ? 1 : 0;
    if (!score) continue;
    if (score > bestScore || (score === bestScore && best !== null && room.members.length < best.members.length)) {
      best = room; bestScore = score;
    }
  }
  return best;
}

/** 一条消息说给谁：`*` 与 null 都是"说给群里所有人"。 */
function addressed(entry: CommEntry, ctx: RoomContext): RoomActor | null {
  if (!entry.to || entry.to === "*") return null;
  return actorFor(entry.to, ctx);
}

/** 一个群里的往来，按真实时间排出。一条消息只去它最贴切的那个群。 */
export function buildRoomLines(room: RoomSpec, rooms: readonly RoomSpec[], ctx: RoomContext): RoomLine[] {
  if (room.kind === "root") return [];
  const lines: RoomLine[] = [];
  for (const entry of ctx.state.comms ?? []) {
    const target = routeComm(entry, rooms);
    if (!target || target.id !== room.id) continue;
    // 跨线交付在日志里只有信道 id（运行时不知道两端工位的名字），
    // 两端由这个群自己的成员给出：第一个是发货方，第二个是收货方。
    const relay = entry.from.startsWith("channel:");
    const actor = actorFor(relay ? target.members[0]?.key ?? "" : entry.from, ctx);
    if (!actor) continue;
    lines.push({
      id: entry.id, at: entry.at, actor,
      to: relay ? actorFor(target.members[1]?.key ?? "", ctx) : addressed(entry, ctx),
      kind: entry.kind, text: entry.text, tone: entry.tone, token: entry.token,
    });
  }
  return lines.sort((a, b) => a.at - b.at);
}

/** 右侧栏每一行要的东西：头像栈、现在的状态、最后一句、未读。 */
export function roomSummaries(rooms: readonly RoomSpec[], ctx: RoomContext, seen: Record<string, number>): RoomSummary[] {
  return rooms.map((room) => {
    const speakers = memberActors(room, ctx).filter((actor) => actor.kind !== "user");
    const running = speakers.filter((actor) => actor.state === "work" || actor.state === "wait").length;
    // A station's own progress notes are not conversation: they neither preview nor count as unread.
    const lines = buildRoomLines(room, rooms, ctx).filter((line) => line.kind !== "note");
    const last = lines[lines.length - 1];
    const since = seen[room.id] ?? 0;
    const unread = room.kind === "root" ? 0 : lines.filter((line) => line.at > since).length;
    return {
      room, speakers, running, unread, count: lines.length,
      state: room.kind === "root" ? "idle" : mergeState(speakers.map((actor) => actor.state)),
      preview: last ? `${last.actor.name}：${last.text.replace(/^\[[^\]]{1,24}\]\s*/, "")}` : (room.kind === "root" ? "" : "还没有往来"),
      previewAt: last?.at ?? 0,
      tone: last?.tone,
    };
  });
}

/** 从画布点进来时，这个小人在哪些群里。 */
export const roomsForNode = roomsOf;

// 界面与验收用同一个入口拿群组推导结果，不另外复制一份判定。
export { deriveRooms, ROOT_ROOM, speakersOf, roomsOf } from "../../../shared/rooms.ts";
