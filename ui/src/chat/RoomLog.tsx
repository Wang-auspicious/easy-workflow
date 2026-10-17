// 一个群展开之后看到的东西：这个群里真实发生过的往来，加上这个群由哪些人组成。
//
// 和 transcript 一样渲染在 shadow root 里，复用同一套行结构、小人样式和 Markdown，
// 只是数据换成 rooms.ts 按群过滤出来的真实事件（咨询 / 判定 / 退回 / 交付 / 纠错 / 播报）。
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info, Send } from "lucide-react";
import { setState, useStore } from "../store.ts";
import { Avatar, STATE_TEXT } from "./Avatar.tsx";
import { toggleInspector } from "../canvas/Canvas.tsx";
import { buildRoomLines, type RoomActor, type RoomContext, type RoomLine } from "./rooms.ts";
import { stationLook } from "./station-look.ts";
import { ROOT_ROOM, type RoomSpec } from "../../../shared/rooms.ts";
import { useNow } from "../util/useNow.ts";
import "./PiBlocks.ts";
import base from "./pi-conversation.css?inline";
import styles from "./transcript.css?inline";
import avatar from "./avatar.css?inline";
import roomStyles from "./rooms.css?inline";

const VERB: Record<RoomLine["kind"], string> = {
  consult: "提出修改", verdict: "判定", return: "退回", channel: "交付", correction: "纠错", note: "播报",
};

const time = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

export function RoomLog({ room, rooms }: { room: RoomSpec; rooms: readonly RoomSpec[] }) {
  const host = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const fs = useStore((s) => s.fs);
  const factory = useStore((s) => s.factory);
  const bots = useStore((s) => s.layout.bots);
  const now = useNow(2000);
  const [showNotes, setShowNotes] = useState(false);
  const all = useMemo(() => {
    const ctx: RoomContext = { factory, state: fs, look: stationLook(factory, fs, bots, now), now };
    return buildRoomLines(room, rooms, ctx);
  }, [room, rooms, factory, fs, bots, now]);
  // A station announcing its own progress is not a conversation; it stays one tap away.
  const notes = all.filter((line) => line.kind === "note").length;
  const lines = showNotes ? all : all.filter((line) => line.kind !== "note");

  useLayoutEffect(() => {
    const el = host.current!;
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    const sheet = document.createElement("style");
    sheet.textContent = `${base}\n${styles}\n${avatar}\n${roomStyles}`;
    const slot = document.createElement("div");
    slot.className = "tr-root";
    shadow.replaceChildren(sheet, slot);
    setContainer(slot);
    return () => { shadow.replaceChildren(); };
  }, []);

  // 往来是往下长的：跟着底部走，除非你自己往回翻了。
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, room.id]);
  const onScroll = () => {
    const el = scroll.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const ask = () => {
    setState({
      chatRoom: ROOT_ROOM,
      draft: `请处理「${room.name}」里的问题：`,
      unread: 0,
    });
  };

  return (
    <>
      <div className="room-scroll" ref={scroll} onScroll={onScroll}>
        <p className="room-intro">{room.subtitle}<br /><span>{room.members.map((m) => m.name).join(" · ")}</span></p>
        {notes > 0 && <button className="room-notes" onClick={() => setShowNotes(!showNotes)}>{showNotes ? "隐藏工位播报" : `${notes} 条工位播报已折叠`}</button>}
        <div className="pi-conversation" ref={host} aria-label={`${room.name} 的工位往来`} />
        {container ? createPortal(
          <div className="tr talk">
            {lines.length === 0
              ? <div className="rlog-empty">
                <Info size={13} />
                <div>
                  <b>还没有往来</b>
                  <p>工位之间互相提意见、退回去改、或把活交给下一条线时，会出现在这里。</p>
                </div>
              </div>
              : lines.map((line, i) => <RoomRow key={line.id} line={line} first={i === 0 || lines[i - 1].actor.key !== line.actor.key || line.at - lines[i - 1].at > 300_000} />)}
          </div>, container) : null}
      </div>
      <div className="room-foot">
        <button className="room-ask" onClick={ask}><Send size={12} />让主调度处理这里的问题</button>
      </div>
    </>
  );
}

function RoomRow({ line, first }: { line: RoomLine; first: boolean }) {
  const fs = useStore((s) => s.fs);
  const item = line.token ? fs.tokens[line.token]?.item ?? line.token : "";
  const open = () => { const key = line.actor.node; if (!key) return; setState({ view: "canvas" }); toggleInspector(key); };
  return (
    <article className={`bub-row${first ? " is-first" : ""}`} style={{ ["--hue" as string]: line.actor.hue }}>
      <div className="bub-av">{first && <Avatar shape={line.actor.shape} hue={line.actor.hue} state={line.actor.state} size={30}
        title={`${line.actor.name} · ${STATE_TEXT[line.actor.state]}`} />}</div>
      <div className="bub-main">
        {first && <header className="bub-head">
          {line.actor.node ? <button className="bub-who" onClick={open}>{line.actor.name}</button> : <b className="bub-who">{line.actor.name}</b>}
          {line.to && <span className="bub-to">对 {line.to.name}</span>}
          <time className="num">{time(line.at)}</time>
        </header>}
        <div className={`bub bub--${line.kind}${line.tone === "warn" ? " is-warn" : ""}`}>
          {line.kind !== "note" && <span className="bub-verb">{VERB[line.kind]}</span>}
          {line.text.replace(/^\[[^\]]{1,24}\]\s*/, "")}
          {item && <span className="bub-item">{item}</span>}
        </div>
      </div>
    </article>
  );
}

export type { RoomActor };
