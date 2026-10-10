// Station bots (Spec §10.4): small geometric bodies with two eyes, procedurally drawn.
// Default stations always get the same bot; states are CSS animations (idle blink,
// working bob with eyes looking downstream, waiting, returned, failed, asleep).
import { memo, useId } from "react";
import type { BotLook } from "../../../shared/types.ts";
import { rng } from "../../../shared/palette.ts";

export type BotState = "idle" | "work" | "wait" | "returned" | "fail" | "sleep";

const BODY: Record<BotLook["shape"], string> = {
  circle: "M20 8.5a13 13 0 1 1 0 26a13 13 0 1 1 0-26Z",
  squircle: "M11 10.5h18q6 0 6 6v11q0 6-6 6H11q-6 0-6-6v-11q0-6 6-6Z",
  drop: "M20 6.5C25 12 33 17.5 33 24.5a13 10.5 0 0 1-26 0C7 17.5 15 12 20 6.5Z",
  capsule: "M20 7.5a10.5 10.5 0 0 1 10.5 10.5v6a10.5 10.5 0 0 1-21 0v-6A10.5 10.5 0 0 1 20 7.5Z",
  star: "M20 7c3 0 4 3.6 6.7 4.7 2.8 1.1 6.3-.4 7.6 2.3 1.3 2.6-1.6 5.2-1.6 8.3s3 5.6 1.4 8.1c-1.6 2.4-5.2 1-8 2.2C23.4 33.7 22.6 37 20 37s-3.4-3.3-6.1-4.4c-2.8-1.2-6.4.2-8-2.2-1.6-2.5 1.4-5 1.4-8.1s-2.9-5.7-1.6-8.3c1.3-2.7 4.8-1.2 7.6-2.3C16 10.6 17 7 20 7Z",
  hex: "M16.5 8.2q3.5-2 7 0l7.6 4.4q3.5 2 3.5 6v8.4q0 4-3.5 6l-7.6 4.4q-3.5 2-7 0l-7.6-4.4q-3.5-2-3.5-6v-8.4q0-4 3.5-6Z",
  bean: "M13 9.5c5-2.5 8 .5 12 0s9 1.5 9.5 8.5-2.5 15-13 15.5S5.5 29 6 21.5 8 12 13 9.5Z",
};

export const Bot = memo(function Bot({ look, state, size = 30, title }: { look: BotLook; state: BotState; size?: number; title?: string }) {
  const id = useId().replace(/:/g, "");
  const r = rng(look.seed);
  const antenna = r() > 0.55;
  const cheeks = r() > 0.5;
  const delay = (r() * 4).toFixed(2);
  const h = look.hue;
  const top = `oklch(0.9 0.07 ${h})`, bottom = `oklch(0.76 0.12 ${h})`, stroke = `oklch(0.52 0.12 ${h})`;
  const eyeY = look.shape === "drop" ? 24 : 21.5;
  return (
    <svg className={`bot bot--${state}`} width={size} height={size} viewBox="0 0 40 40" style={{ ["--blink-delay" as string]: `${delay}s` }} aria-label={title}>
      <defs>
        <linearGradient id={`g${id}`} x1="0.2" y1="0" x2="0.7" y2="1">
          <stop offset="0" stopColor={top} />
          <stop offset="1" stopColor={bottom} />
        </linearGradient>
      </defs>
      <g className="bot-body">
        <ellipse cx="20" cy="37.2" rx="9" ry="1.6" fill="rgba(30,28,20,.10)" className="bot-shadow" />
        {antenna && (
          <g className="bot-antenna">
            <path d="M20 8V3.8" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
            <circle cx="20" cy="3.3" r="1.8" fill={bottom} stroke={stroke} strokeWidth="1" />
          </g>
        )}
        <path d={BODY[look.shape]} fill={`url(#g${id})`} stroke={stroke} strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M13 13.5q3-2.5 7-2.6" stroke="#fff" strokeOpacity=".7" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        {cheeks && state !== "fail" && <g fill={`oklch(0.72 0.14 ${(h + 330) % 360})`} opacity=".35"><circle cx="12.4" cy={eyeY + 4.2} r="1.9" /><circle cx="27.6" cy={eyeY + 4.2} r="1.9" /></g>}
        <Eyes kind={look.eyes} state={state} y={eyeY} />
        {state === "returned" && <g stroke="#1d1d1a" strokeWidth="1.3" strokeLinecap="round"><path d={`M13.6 ${eyeY - 5.2}l3.6 1.3`} /><path d={`M26.4 ${eyeY - 5.2}l-3.6 1.3`} /></g>}
        {state === "returned" && <path d="M31.5 12.5q1.4 2.3 0 3.2q-1.4-.9 0-3.2Z" fill="oklch(0.75 0.1 230)" />}
      </g>
      {state === "sleep" && <text className="bot-z" x="29" y="11" fontSize="7" fontWeight="700" fill={stroke}>z</text>}
    </svg>
  );
});

function Eyes({ kind, state, y }: { kind: BotLook["eyes"]; state: BotState; y: number }) {
  const L = 15.4, R = 24.6;
  if (state === "sleep") return <g stroke="#1d1d1a" strokeWidth="1.4" strokeLinecap="round" fill="none"><path d={`M${L - 2.2} ${y}q2.2 1.8 4.4 0`} /><path d={`M${R - 2.2} ${y}q2.2 1.8 4.4 0`} /></g>;
  if (state === "fail") return <g stroke="#1d1d1a" strokeWidth="1.5" strokeLinecap="round"><path d={`M${L - 1.8} ${y - 1.8}l3.6 3.6M${L + 1.8} ${y - 1.8}l-3.6 3.6`} /><path d={`M${R - 1.8} ${y - 1.8}l3.6 3.6M${R + 1.8} ${y - 1.8}l-3.6 3.6`} /></g>;
  const pupil = kind === "round";
  return (
    <g className="bot-eyes">
      {[L, R].map((x) => (
        <g key={x} className="bot-eye" style={{ transformOrigin: `${x}px ${y}px` }}>
          {pupil && <circle cx={x} cy={y} r="3.6" fill="#fff" stroke="#1d1d1a" strokeOpacity=".18" />}
          {kind === "wide"
            ? <ellipse className="bot-pupil" cx={x} cy={y} rx="1.9" ry="2.9" fill="#1d1d1a" />
            : <circle className="bot-pupil" cx={x} cy={y} r={pupil ? 1.8 : kind === "sleepy" ? 1.9 : 2.3} fill="#1d1d1a" />}
          {kind === "sleepy" && <path d={`M${x - 2.6} ${y - 1.4}h5.2`} stroke="oklch(0.55 0.05 60)" strokeWidth="1.2" strokeLinecap="round" />}
          <circle cx={x + 0.8} cy={y - 0.9} r=".7" fill="#fff" />
        </g>
      ))}
    </g>
  );
}
