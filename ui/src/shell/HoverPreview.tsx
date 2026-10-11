// Hover preview for evidence images (same gesture as VisLexicon cards): rest the pointer on
// an image for one second and a large preview opens over it. A set of three role images
// (首屏 / 目录 / 特写) splits the preview into thirds — the pointer's horizontal position
// picks the image; two images split in halves; one image fills it. No close button:
// leaving the preview closes it. Used on canvas strips, the inspector and the evidence board.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { EvidenceRef } from "../../../shared/types.ts";
import { getState } from "../store.ts";

export interface PreviewItem { src: string; video?: string; label: string; where?: string }
interface Open { items: PreviewItem[]; index: number; rect: DOMRect; x: number; y: number; onActivate?: () => void }

let current: Open | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const set = (next: Open | null) => { current = next; emit(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

const ROLE_ORDER = ["identity", "breadth", "proof"];
const ROLE_ZH: Record<string, string> = { identity: "首屏", breadth: "目录", proof: "特写" };
const isVisual = (e: EvidenceRef) => e.kind === "image" || e.kind === "video";
const toItem = (e: EvidenceRef): PreviewItem => ({
  src: e.kind === "video" ? (e.poster ?? e.card ?? e.src ?? "") : (e.src ?? e.card ?? ""),
  video: e.kind === "video" ? e.src : undefined,
  label: ROLE_ZH[String(e.meta?.role)] ?? (e.kind === "video" ? "录屏" : e.label),
  where: e.meta?.href ? String(e.meta.href).replace(/^https?:\/\//, "") : undefined,
});

/** The set an image belongs to: the latest image per role of the same item, in role order. */
export function previewSet(ev: EvidenceRef): { items: PreviewItem[]; index: number } {
  if (!isVisual(ev)) return { items: [], index: 0 };
  const fs = getState().fs;
  const role = String(ev.meta?.role ?? "");
  if (ev.kind === "video" || !ROLE_ORDER.includes(role)) return { items: [toItem(ev)], index: 0 };
  const latest = new Map<string, EvidenceRef>();
  for (const id of fs.tokens[ev.token]?.evidence ?? []) {
    const e = fs.evidence[id];
    if (e && e.kind === "image" && ROLE_ORDER.includes(String(e.meta?.role))) latest.set(String(e.meta?.role), e);
  }
  latest.set(role, ev);
  const set = ROLE_ORDER.map((r) => latest.get(r)).filter(Boolean) as EvidenceRef[];
  return { items: set.map(toItem), index: Math.max(0, set.findIndex((e) => e.id === ev.id)) };
}

/** Pointer handlers for a thumbnail. `group` is read when the preview opens. */
export function useHoverPreview(group: () => { items: PreviewItem[]; index: number }, onActivate?: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef({ x: 0, y: 0 });
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => clear, []);
  const arm = (el: HTMLElement) => {
    clear();
    timer.current = setTimeout(() => {
      const g = group();
      if (!g.items.length || !el.isConnected) return;
      set({ ...g, rect: el.getBoundingClientRect(), x: last.current.x, y: last.current.y, onActivate });
    }, 1000);
  };
  return {
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => { last.current = { x: e.clientX, y: e.clientY }; if (e.pointerType === "mouse") arm(e.currentTarget); },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType !== "mouse" || current) return;
      // Only a still pointer opens the preview: any real movement restarts the one-second wait.
      if (Math.hypot(e.clientX - last.current.x, e.clientY - last.current.y) > 3) { last.current = { x: e.clientX, y: e.clientY }; arm(e.currentTarget); }
    },
    onPointerLeave: () => clear(),
    onPointerDown: () => clear(),
  };
}

const W = 720, H = 450, HEAD = 34;

/** Mounted once at the app root. */
export function HoverPreviewHost() {
  const open = useSyncExternalStore(subscribe, () => current);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") set(null); };
    const scroll = () => set(null);
    window.addEventListener("keydown", key);
    window.addEventListener("wheel", scroll, { passive: true });
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("wheel", scroll); };
  }, [open]);
  if (!open) return null;
  const n = open.items.length;
  // Place the preview over the thumbnail so the pointer starts inside it, in the segment of
  // the image it rested on; clamp to the window.
  const w = Math.min(W, window.innerWidth - 32), h = Math.round(w * (H / W)) + HEAD;
  const left = Math.max(16, Math.min(window.innerWidth - w - 16, open.x - ((open.index + 0.5) / n) * w));
  const top = Math.max(16, Math.min(window.innerHeight - h - 16, open.y - h / 2));
  const pick = (clientX: number) => Math.max(0, Math.min(n - 1, Math.floor(((clientX - left) / w) * n)));
  const idx = open.index;
  const item = open.items[idx];
  return createPortal(
    <div className={`hp ${n > 1 ? `hp--${n}` : ""}`} style={{ left, top, width: w, height: h }}
      onPointerMove={(e) => { const i = pick(e.clientX); if (i !== open.index) set({ ...open, index: i }); }}
      onPointerLeave={() => set(null)}
      onClick={() => { const act = open.onActivate; set(null); act?.(); }}>
      <div className="hp-stage">
        {item.video ? <video key={item.video} src={item.video} poster={item.src} autoPlay muted loop playsInline /> : <img key={item.src} src={item.src} alt={item.label} draggable={false} />}
      </div>
      <div className="hp-head">
        {n > 1 && <span className="hp-ticks">{open.items.map((it, i) => <i key={i} className={i === idx ? "is-on" : ""} data-label={it.label} />)}</span>}
        <b>{item.label}</b>
        {item.where && <span className="hp-where">{item.where}</span>}
      </div>
    </div>,
    document.body,
  );
}
