// Role hues (Spec §10.3): border = main colour, fill = the same hue at ~10% strength,
// ink = the same hue, dark. All in OKLCH so lightness stays even across hues and the
// dark ink keeps ≥ 4.5:1 contrast on every tinted fill.
import type { BotLook, BotShape, Role } from "./types.ts";

export interface Hue { h: number; c: number; zh: string; en: string }

export const ROLE_HUES: Record<Role, Hue> = {
  source: { h: 245, c: 0.13, zh: "来源", en: "Source" },
  social: { h: 212, c: 0.11, zh: "社媒来源", en: "Social" },
  candidate: { h: 268, c: 0.12, zh: "候选层", en: "Candidates" },
  sort: { h: 186, c: 0.1, zh: "分拣 / 抓取", en: "Sort & fetch" },
  judge: { h: 152, c: 0.12, zh: "判定", en: "Judge" },
  capture: { h: 122, c: 0.11, zh: "采集", en: "Capture" },
  process: { h: 232, c: 0.045, zh: "加工", en: "Process" },
  write: { h: 285, c: 0.12, zh: "撰写", en: "Write" },
  verify: { h: 308, c: 0.1, zh: "核验", en: "Verify" },
  review: { h: 78, c: 0.13, zh: "审查", en: "Review" },
  arbiter: { h: 52, c: 0.14, zh: "仲裁 / 待人工", en: "Arbiter" },
  publish: { h: 24, c: 0.15, zh: "发布 / 闸门", en: "Publish" },
  channel: { h: 330, c: 0.13, zh: "信道", en: "Channel" },
  store: { h: 250, c: 0.0, zh: "存储", en: "Store" },
};

export function roleColors(role: Role, override?: { h: number; c?: number }) {
  const { h, c } = override ? { h: override.h, c: override.c ?? ROLE_HUES[role].c } : ROLE_HUES[role];
  return {
    border: `oklch(0.67 ${c} ${h})`,
    strong: `oklch(0.58 ${Math.min(0.2, c * 1.15)} ${h})`,
    fill: `oklch(0.975 ${(c * 0.22).toFixed(3)} ${h})`,
    fillHover: `oklch(0.955 ${(c * 0.35).toFixed(3)} ${h})`,
    ink: `oklch(0.36 ${(c * 0.75).toFixed(3)} ${h})`,
    soft: `oklch(0.67 ${c} ${h} / 0.18)`,
    glow: `oklch(0.72 ${c} ${h} / 0.45)`,
    h, c,
  };
}

/* ------------------------------------------------------------------ bots */

export function hash(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return x >>> 0;
}

export function rng(seed: number) {
  let a = seed || 1;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const SHAPES: BotShape[] = ["circle", "squircle", "drop", "capsule", "star", "hex", "bean"];
const EYES: BotLook["eyes"][] = ["dot", "round", "wide", "sleepy"];

/** Default bots are fixed per station id; new nodes get a random seed stored in the layout file. */
export function botFor(id: string, role: Role, given?: Partial<BotLook>): BotLook {
  const seed = given?.seed ?? hash(id);
  const r = rng(seed);
  const base = ROLE_HUES[role].h;
  return {
    shape: given?.shape ?? SHAPES[Math.floor(r() * SHAPES.length)],
    hue: given?.hue ?? (base + Math.round((r() - 0.5) * 24) + 360) % 360,
    eyes: given?.eyes ?? EYES[Math.floor(r() * 3)],
    seed,
  };
}
