// 右侧栏现在分成"群组栏 + 当前群组"：左边一列是流程上真实需要对话的地方，
// 点谁就展开谁的往来。群组不是写死的：deriveRooms 把编译好的图走一遍，
// 找返工环、判断会合点、同一段工序和跨段移交（shared/rooms.ts）。
import { useMemo, useState } from "react";
import { useStore, setState } from "../store.ts";
import { ChevronsLeft, ChevronsRight, Radio } from "lucide-react";
import { ROOT_ROOM, deriveRooms, type RoomSpec } from "../../../shared/rooms.ts";
import { roomSummaries, type RoomActor, type RoomContext, type RoomSummary } from "./rooms.ts";
import { stationLook } from "./station-look.ts";
import { GroupAvatar, type StackMember } from "./GroupAvatar.tsx";
import { Avatar, type AvatarState } from "./Avatar.tsx";
import { DISPATCHER_HUE, dispatcherState } from "./transcript.ts";
import { useNow } from "../util/useNow.ts";
import "./rooms.css";

/** 群组集合只由工厂图和观测到的咨询决定，跟界面状态无关。 */
export function useRooms(): RoomSpec[] {
  const factory = useStore((s) => s.factory);
  const consults = useStore((s) => s.fs.consults);
  return useMemo(() => {
    const observed = Object.values(consults ?? {}).map((c) => ({ reviewer: c.reviewer, owner: c.owner }));
    return deriveRooms(factory, observed);
  }, [factory, consults]);
}

const KIND_LABEL: Record<RoomSpec["kind"], string> = { root: "总台", part: "工序", loop: "返工", bridge: "跨段" };

/** 每个群在栏里显示什么名字：跨段要带上对面那条线才看得懂。 */
function roomTitle(room: RoomSpec, lineName: (id: string | null) => string): string {
  if (room.kind === "root") return "主调度";
  if (room.kind === "bridge") return `${room.name} · ${lineName(room.peerLine)}`;
  return room.name;
}

const stackOf = (actor: RoomActor): StackMember =>
  ({ key: actor.key, shape: actor.shape, hue: actor.hue, state: actor.state, title: `${actor.name} · ${actor.state}` });

/** 主调度的小人：和对话行里同一套状态判定，收起时也看得出它在干什么。 */
function useDispatcherActor(): RoomActor {
  const live = useStore((s) => s.live);
  const dispatcher = useStore((s) => s.dispatcher);
  const entries = useStore((s) => s.fs.conversation);
  const last = [...entries].reverse().find((e) => e.message.role === "assistant")?.message ?? null;
  const state: AvatarState = dispatcherState(live, dispatcher, last);
  return { key: "dispatcher", name: "主调度", kind: "dispatcher", shape: "blob", hue: DISPATCHER_HUE, state };
}

export function RoomRail() {
  const rooms = useRooms();
  const open = useStore((s) => s.roomRailOpen);
  const selected = useStore((s) => s.chatRoom);
  const seen = useStore((s) => s.roomSeen);
  const factory = useStore((s) => s.factory);
  const fs = useStore((s) => s.fs);
  const bots = useStore((s) => s.layout.bots);
  const now = useNow(2000);
  const dispatcher = useDispatcherActor();
  const ctx: RoomContext = useMemo(() => ({ factory, state: fs, look: stationLook(factory, fs, bots, now), now }), [factory, fs, bots, now]);
  const summaries = useMemo(() => roomSummaries(rooms, ctx, seen), [rooms, ctx, seen]);
  const lineName = (id: string | null) => factory?.lines.find((l) => l.id === id)?.name ?? id ?? "";

  // 按线分组，顺序沿用画布的线序；总台永远在最上面。
  const groups = useMemo(() => {
    const order = factory?.ui.order ?? [];
    const buckets = new Map<string, RoomSummary[]>();
    for (const summary of summaries) {
      if (summary.room.kind === "root") continue;
      const key = summary.room.line ?? "";
      const list = buckets.get(key);
      if (list) list.push(summary);
      else buckets.set(key, [summary]);
    }
    return [...buckets.entries()].sort((a, b) => {
      const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  }, [summaries, factory]);

  const total = summaries.reduce((n, s) => n + s.unread, 0);
  const rootUnread = useStore((s) => s.unread);
  const pick = (id: string) => setState((s) => ({ chatRoom: id, roomSeen: { ...s.roomSeen, [id]: Date.now() }, ...(id === ROOT_ROOM ? { unread: 0 } : {}) }));

  return (
    <nav className={`room-rail${open ? "" : " is-narrow"}`} aria-label="群组">
      <div className="room-rail-head">
        {open && <span className="room-rail-title">群组<em>{rooms.length}</em></span>}
        <span className="grow" />
        <button className="icon-btn" onClick={() => setState({ roomRailOpen: !open })}
          aria-expanded={open} aria-label={open ? "收起群组栏" : "展开群组栏"} data-tip={open ? "收起群组栏" : "展开群组栏"} data-tip-side="right">
          {open ? <ChevronsLeft size={14} /> : <ChevronsRight size={14} />}
        </button>
      </div>
      <div className="room-rail-list">
        <button className={`room-item room-item--root${selected === ROOT_ROOM ? " is-on" : ""}`}
          onClick={() => pick(ROOT_ROOM)} aria-current={selected === ROOT_ROOM ? "true" : undefined}
          data-tip={open ? undefined : "主调度 · 总台"}>
          <span className="room-item-stack"><Avatar shape={dispatcher.shape} hue={dispatcher.hue} state={dispatcher.state} size={open ? 26 : 24} title="主调度" /></span>
          {open && <span className="room-item-text">
            <span className="room-item-name">主调度<em className="room-kind room-kind--root">总台</em></span>
            <span className="room-item-sub">你 + 主调度，所有工位从这里编排</span>
          </span>}
          {open && rootUnread > 0 && <i className="room-item-unread" aria-label={`${rootUnread} 条新回复`}>{rootUnread}</i>}
        </button>

        {groups.map(([line, list]) => (
          <div className="room-group" key={line || "none"}>
            {open && <div className="room-group-label">{lineName(line)}</div>}
            {list.map((summary) => {
              const { room } = summary;
              const stack = summary.speakers.length
                ? summary.speakers.map(stackOf)
                : room.members.slice(0, 4).map((m) => ({ key: m.key, hue: 250, state: "sleep" as AvatarState }));
              return (
                <button key={room.id} className={`room-item${selected === room.id ? " is-on" : ""}${summary.running ? " is-busy" : ""}`}
                  onClick={() => pick(room.id)} aria-current={selected === room.id ? "true" : undefined}
                  data-tip={open ? undefined : `${roomTitle(room, lineName)} — ${room.subtitle}`}>
                  <span className="room-item-stack">
                    <GroupAvatar size={open ? 26 : 24} members={stack} />
                    {summary.running > 0 && <i className="room-item-pulse" aria-hidden />}
                  </span>
                  {open && <span className="room-item-text">
                    <span className="room-item-name">
                      {roomTitle(room, lineName)}
                      <em className={`room-kind room-kind--${room.kind}`}>{room.observed ? "实际" : KIND_LABEL[room.kind]}</em>
                    </span>
                    <span className={`room-item-sub${summary.tone === "warn" ? " is-warn" : ""}`}>{summary.preview}</span>
                  </span>}
                  {open && summary.unread > 0 && <i className="room-item-unread" aria-label={`${summary.unread} 条新往来`}>{summary.unread}</i>}
                </button>
              );
            })}
          </div>
        ))}
        {open && !groups.length && <p className="room-rail-empty">这套流程还没有需要彼此说话的工序。</p>}
      </div>
      {open && total > 0 && <div className="room-rail-foot"><Radio size={11} />{total} 条新往来</div>}
    </nav>
  );
}

const clock = (t: number, now: number) => {
  if (!t) return "";
  const d = new Date(t), today = new Date(now);
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : `${d.getMonth() + 1}/${d.getDate()}`;
};

/**
 * Grok Bot 式的对话列表：一行一个对象，头像、名字、时间、最后一句。主调度永远在最上面，
 * 其余按最近一次往来排序；还没说过话的群收进末尾，一行带过。
 */
export function RoomList() {
  const rooms = useRooms();
  const seen = useStore((s) => s.roomSeen);
  const factory = useStore((s) => s.factory);
  const fs = useStore((s) => s.fs);
  const bots = useStore((s) => s.layout.bots);
  const rootUnread = useStore((s) => s.unread);
  const now = useNow(5000);
  const dispatcher = useDispatcherActor();
  const [showQuiet, setShowQuiet] = useState(false);
  const ctx: RoomContext = useMemo(() => ({ factory, state: fs, look: stationLook(factory, fs, bots, now), now }), [factory, fs, bots, now]);
  const summaries = useMemo(() => roomSummaries(rooms, ctx, seen).filter((s) => s.room.kind !== "root"), [rooms, ctx, seen]);
  const talking = summaries.filter((s) => s.count > 0).sort((a, b) => b.previewAt - a.previewAt);
  const quiet = summaries.filter((s) => s.count === 0);
  const lastRoot = [...fs.conversation].reverse().find((e) => e.message.role === "assistant" || e.message.role === "user");
  const rootPreview = lastRoot ? textOf(lastRoot.message) : "布置任务、问进度、让它调度所有工位";
  const lineName = (id: string | null) => factory?.lines.find((l) => l.id === id)?.name ?? id ?? "";
  const open = (id: string) => setState((s) => ({
    chatRoom: id, chatList: false, roomSeen: { ...s.roomSeen, [id]: Date.now() }, ...(id === ROOT_ROOM ? { unread: 0 } : {}),
  }));
  const row = (summary: RoomSummary) => {
    const { room } = summary;
    const stack = summary.speakers.length ? summary.speakers.map(stackOf)
      : room.members.slice(0, 4).map((m) => ({ key: m.key, hue: 250, state: "sleep" as AvatarState }));
    const last = summary.preview.replace(/^[^：]{1,12}：/, "");
    return (
      <button key={room.id} className="talk-row" onClick={() => open(room.id)}>
        <span className="talk-av"><GroupAvatar size={40} members={stack} />{summary.running > 0 && <i className="talk-live" aria-label="有工位在跑" />}</span>
        <span className="talk-main">
          <span className="talk-top"><b>{roomTitle(room, lineName)}</b><time className="num">{clock(summary.previewAt, now)}</time></span>
          <span className="talk-sub">
            <span className={summary.tone === "warn" ? "is-warn" : ""}>{summary.count ? last : room.subtitle}</span>
            {summary.unread > 0 && <i className="talk-unread num">{summary.unread > 99 ? "99+" : summary.unread}</i>}
          </span>
        </span>
      </button>
    );
  };
  return (
    <div className="talk-list" role="list">
      <button className="talk-row" onClick={() => open(ROOT_ROOM)}>
        <span className="talk-av"><Avatar shape={dispatcher.shape} hue={dispatcher.hue} state={dispatcher.state} size={40} title="主调度" /></span>
        <span className="talk-main">
          <span className="talk-top"><b>主调度</b><time className="num">{lastRoot ? clock(lastRoot.message.timestamp ?? 0, now) : ""}</time></span>
          <span className="talk-sub"><span>{rootPreview}</span>{rootUnread > 0 && <i className="talk-unread num">{rootUnread}</i>}</span>
        </span>
      </button>
      {talking.map(row)}
      {quiet.length > 0 && <>
        <button className="talk-more" onClick={() => setShowQuiet(!showQuiet)}>{showQuiet ? "收起" : `还有 ${quiet.length} 个群暂时没有往来`}</button>
        {showQuiet && quiet.map(row)}
      </>}
    </div>
  );
}

function textOf(message: { content?: unknown }): string {
  const c = message.content;
  if (typeof c === "string") return c.replace(/\s+/g, " ").slice(0, 80);
  if (Array.isArray(c)) {
    const t = c.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join(" ");
    return t.replace(/\s+/g, " ").slice(0, 80);
  }
  return "";
}
