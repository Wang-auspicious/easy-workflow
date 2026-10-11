// Station avatars as animated GIFs rendered from the bloub engine
// (github.com/jeremy-prt/bloub, MIT) by scripts/bots/make-gifs.mjs. The body shape is
// fixed per station, the colour is the role's, and the state picks bloub's expression.
import { memo, useSyncExternalStore } from "react";
import type { BotLook, Role } from "../../../shared/types.ts";
import manifest from "../../public/bots/manifest.json";
import { Bot, type BotState } from "./Bot.tsx";

const SHAPES = manifest.shapes as Record<string, string>;
const COMBOS = manifest.combos as Record<string, string[]>;
const BASE = import.meta.env.BASE_URL;
const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
const subscribeMotion = (notify: () => void) => { motion.addEventListener("change", notify); return () => motion.removeEventListener("change", notify); };

export function botGifSrc(look: Pick<BotLook, "shape">, role: Role | "dispatcher", state: BotState) {
  const key = `${SHAPES[look.shape] ?? "cercle"}-${role}`;
  const states = COMBOS[key] ?? COMBOS[`cercle-${role}`] ?? ["idle"];
  const s = states.includes(state) ? state : state === "sleep" ? "idle" : "idle";
  const combo = COMBOS[key] ? key : `cercle-${role}`;
  return `${BASE}bots/${combo}-${s}.gif`;
}

export const BotGif = memo(function BotGif({ look, role, state, size, className = "" }: { look: Pick<BotLook, "shape"> & Partial<BotLook>; role: Role | "dispatcher"; state: BotState; size: number; className?: string }) {
  const reduced = useSyncExternalStore(subscribeMotion, () => motion.matches);
  // CSS cannot stop animation inside an image. Use the existing procedural avatar
  // under reduced motion; its CSS animations already respect the same preference.
  if (reduced) return <span className={className} style={{ display: "inline-flex", width: size, height: size }}><Bot look={{ hue: 210, seed: 0, eyes: "dot", ...look }} state={state} size={size} /></span>;
  return <img className={`bot-gif bot-gif--${state} ${className}`} src={botGifSrc(look, role, state)} width={size} height={size} alt="" draggable={false} />;
});
