// 一个群展开之后看到的东西：这个群里真实发生过的往来，加上这个群由哪些人组成。
//
// 和 transcript 一样渲染在 shadow root 里，复用同一套行结构、小人样式和 Markdown，
// 只是数据换成 rooms.ts 按群过滤出来的真实事件（咨询 / 判定 / 退回 / 交付 / 纠错 / 播报）。
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Wrench, Info, Send } from "lucide-react";
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
  const lines = useMemo(() => {
    const ctx: RoomContext = { factory, state: fs, look: stationLook(factory, fs, bots, now), now };
    return buildRoomLines(room, rooms, ctx);
  }, [room, rooms, factory, fs, bots, now]);
  const lineName = (id: string | null) => factory?.lines.find((l) => l.id === id)?.name ?? id ?? "";

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
      <div className="room-head">
        <div className="room-head-top">
          <b>{room.name}</b>
          <em className={`room-kind room-kind--${room.kind}`}>{room.observed ? "实际往来" : room.kind === "part" ? "工序" : room.kind === "loop" ? "返工环" : "跨段移交"}</em>
          {room.peerLine && <span className="room-head-peer"><ArrowRight size={11} />{lineName(room.peerLine)}</span>}
        </div>
        <p className="room-head-sub">{room.subtitle}</p>
        <div className="room-head-members">
          <span className="room-mine" title="你永远在这个群里">你</span>
          {room.members.map((member) => (
            <span key={member.key} className={`room-chip room-chip--${member.kind}`}
              title={`${member.name} · ${member.kind}${member.talks ? "（会说话）" : "（程序工位，不说话）"}`}>
              {member.name}
            </span>
          ))}
        </div>
      </div>
      <div className="room-scroll" ref={scroll} onScroll={onScroll}>
        <div className="pi-conversation" ref={host} aria-label={`${room.name} 的工位往来`} />
        {container ? createPortal(
          <div className="tr">
            {lines.length === 0
              ? <div className="rlog-empty">
                <Info size={13} />
                <div>
                  <b>这个群还没有往来</b>
                  <p>等这些工位开始互相提意见、退回去改、或者把活交给下一条线，这里会出现真实的对话记录。</p>
                </div>
              </div>
              : lines.map((line) => <RoomRow key={line.id} line={line} />)}
          </div>, container) : null}
      </div>
      <div className="room-foot">
        <span><Wrench size={11} />群里的往来只读，来自运行日志</span>
        <span className="grow" />
        <button className="btn btn--sm" onClick={ask}><Send size={11} />让主调度处理这里的问题</button>
      </div>
    </>
  );
}

function RoomRow({ line }: { line: RoomLine }) {
  const fs = useStore((s) => s.fs);
  const item = line.token ? fs.tokens[line.token]?.item ?? line.token : "";
  const open = () => { const key = line.actor.node; if (!key) return; setState({ view: "canvas" }); toggleInspector(key); };
  return (
    <article className={`tr-row rlog-row rlog-row--${line.kind}${line.tone ? ` tr-row--${line.tone}` : ""}`}
      style={{ ["--hue" as string]: line.actor.hue }}>
      <div className="tr-av">
        <Avatar shape={line.actor.shape} hue={line.actor.hue} state={line.actor.state} size={34}
          title={`${line.actor.name} · ${STATE_TEXT[line.actor.state]}`} />
      </div>
      <div className="tr-main">
        <header className="tr-head">
          {line.actor.node
            ? <button className="tr-who tr-who--link" onClick={open} data-tip="在画布上打开这个工位">{line.actor.name}</button>
            : <b className="tr-who">{line.actor.name}</b>}
          <span className={`rlog-verb rlog-verb--${line.kind}`}>{VERB[line.kind]}</span>
          {line.to && <span className="rlog-to">→ {line.to.name}</span>}
          <time className="tr-time num">{time(line.at)}</time>
        </header>
        <p className="rlog-text">{line.text}</p>
        {item && <span className="rlog-token" title="这件货">{item}</span>}
      </div>
    </article>
  );
}

export type { RoomActor };
