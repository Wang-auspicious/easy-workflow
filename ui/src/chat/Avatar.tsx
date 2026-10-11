// 对话里的小人。形状数据取自 Grok Bot 的程序化小人（见 grokbot-shapes.ts），
// 动作全部由状态驱动，不用图片：
//
//   idle      呼吸 + 定时眨眼
//   thinking  慢慢上浮、眼珠往上看，头顶三点闪动        —— 收到消息、还没开始说
//   speaking  说话节奏的上下点动 + 眨眼加快 + 声波环     —— 正在往外吐字
//   work      前倾、点动加快，带工具角标                —— 正在跑工具
//   wait      左右张望                                 —— 被限流 / 在恢复 / 排队等资源
//   returned  完成时弹两下 + 一颗星                     —— 刚交回结果
//   fail      X 眼 + 抖两下                            —— 失败或中止
//   sleep     闭眼 + z                                 —— 休眠工位
//
// 什么时候动、什么时候说，由 transcript.ts 依真实状态判定，不在这里猜。
import { memo } from "react";
import type { BotShape } from "../../../shared/types.ts";
import { GROK_SHAPES, type GrokShapeName } from "./grokbot-shapes.ts";
import { grokShape, type AvatarState } from "./avatar-look.ts";

export { grokShape, STATE_TEXT } from "./avatar-look.ts";
export type { AvatarState } from "./avatar-look.ts";

export const Avatar = memo(function Avatar({ shape, hue, state, size = 34, title }: {
  shape: BotShape | GrokShapeName | undefined; hue: number; state: AvatarState; size?: number; title?: string;
}) {
  const s = GROK_SHAPES[grokShape(shape)];
  const fill = `oklch(0.78 0.105 ${hue})`;
  const stroke = `oklch(0.55 0.12 ${hue})`;
  const ink = "#1d1d1a";
  const closed = state === "sleep";
  const broken = state === "fail";
  return (
    <svg className={`gavatar gavatar--${state}`} width={size} height={size} viewBox="-15 -15 259 259"
      role="img" aria-label={title ?? undefined} style={{ ["--gv-hue" as string]: hue }}>
      {state === "thinking" && <g className="gavatar-think" aria-hidden>
        {[0, 1, 2].map((i) => <circle key={i} className="gavatar-dot" cx={92 + i * 22} cy={-4} r="7" style={{ animationDelay: `${i * 0.18}s` }} />)}
      </g>}
      {state === "speaking" && <circle className="gavatar-ring" cx="114.3" cy="114.3" r="120" fill="none" stroke={stroke} strokeWidth="4" aria-hidden />}
      <g className="gavatar-body">
        <ellipse className="gavatar-shadow" cx="114.3" cy="238" rx="58" ry="9" fill="rgba(30,28,20,.10)" aria-hidden />
        <path d={s.body} fill={fill} stroke={stroke} strokeWidth="3" strokeLinejoin="round" />
        {state === "returned" && <path className="gavatar-spark" d="M206 52q9 15 0 21q-9-6 0-21Z" fill={`oklch(0.76 0.1 ${(hue + 190) % 360})`} aria-hidden />}
        {closed ? (
          <g className="gavatar-eyes-closed" stroke={ink} strokeWidth="4.2" strokeLinecap="round" fill="none" aria-hidden>
            {s.eyes.map((e) => <path key={e.cx} d={`M${e.cx - 13} ${e.cy}q13 10 26 0`} />)}
          </g>
        ) : broken ? (
          <g className="gavatar-eyes-broken" stroke={ink} strokeWidth="4.6" strokeLinecap="round" aria-hidden>
            {s.eyes.flatMap((e) => [
              <path key={`a${e.cx}`} d={`M${e.cx - 11} ${e.cy - 11}l22 22`} />,
              <path key={`b${e.cx}`} d={`M${e.cx + 11} ${e.cy - 11}l-22 22`} />,
            ])}
          </g>
        ) : (
          <g className="gavatar-eyes">
            {s.eyes.map((e, i) => (
              <g key={e.cx} className="gavatar-eye" style={{ transformOrigin: `${e.cx}px ${e.cy}px`, animationDelay: `${i * 0.06}s` }}>
                <path d={e.d} fill={ink} />
                <circle cx={e.cx + 5} cy={e.cy - 6} r="2.6" fill="#fff" opacity=".85" />
              </g>
            ))}
          </g>
        )}
      </g>
      {closed && <text className="gavatar-z" x="196" y="46" fontSize="34" fontWeight="700" fill={stroke} aria-hidden>z</text>}
    </svg>
  );
});

