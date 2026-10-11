// Dashboard store: the compiled factory, the user's layout file, and the journal
// projection fed by SSE (or by a recorded journal in replay mode). The projection is the
// same `apply` the server uses, so what the canvas shows is exactly what the journal says.
import { useSyncExternalStore } from "react";
import { emptyBrowser, type BrowserState } from "../../shared/browser.ts";
import type { Attachment, CompiledFactory, Stamped } from "../../shared/types.ts";
import { apply, initialState, type FactoryState } from "../../shared/project.ts";
import type { LayoutResult } from "../../shared/layout.ts";
import { emptyLive, idleDispatcher, type DispatcherStatus, type LiveChat } from "./chat/live.ts";
export type { LiveChat } from "./chat/live.ts";

export type View = "canvas" | "board" | "candidates" | "library" | "runs" | "browser" | "settings" | "report";
export type Layer = "pipeline" | "gantt" | "spec" | "channels";

export interface LayoutFile {
  designVersion?: number;
  previousLayout?: { pos: Record<string, { x: number; y: number }>; capsules: Record<string, { x: number; y: number }>; open: Record<string, boolean>; designVersion?: number };
  pos: Record<string, { x: number; y: number }>;
  /** Lines the user expanded from / collapsed to a capsule (overrides the pack default). */
  open: Record<string, boolean>;
  colors: Record<string, number>;
  bots: Record<string, number>;
  capsules: Record<string, { x: number; y: number }>;
}

export interface Inspector { key: string; kind: "node" | "token" | "part"; x: number; y: number; pinned: boolean; pinScale?: number; worker?: string }

export interface Store {
  ready: boolean;
  connected: boolean;
  factory: CompiledFactory | null;
  defaultLayout: LayoutResult | null;
  layout: LayoutFile;
  fs: FactoryState;
  version: number;
  nodeRev: Record<string, number>;
  view: View;
  layer: Layer;
  reportRun: string | null;
  attachments: Attachment[];
  chatOpen: boolean;
  chatWidth: number;
  unread: number;
  live: LiveChat;
  dispatcher: DispatcherStatus;
  browser: BrowserState;
  inspectors: Inspector[];
  selected: string[];
  follow: boolean;
  /** A token whose journey is highlighted across the floor (hovering its cargo tag). */
  trail: string | null;
  flashes: Record<string, number>;
  settings: Record<string, number>;
  model: string;
  keyPresent: boolean;
  replay: { run: string; speed: number; playing: boolean; at: number; start: number; end: number; events: Stamped[]; cursor: number } | null;
  focus: { x: number; y: number; k?: number; area?: { w: number; h: number }; at: number } | null;
  draft: string;
  boardFocus: string | null;
}

const LS = (k: string, v?: unknown) => {
  try {
    if (v === undefined) return JSON.parse(localStorage.getItem(`pf.${k}`) ?? "null");
    localStorage.setItem(`pf.${k}`, JSON.stringify(v));
  } catch { /* storage may be unavailable */ }
  return null;
};

let state: Store = {
  ready: false, connected: false, factory: null, defaultLayout: null,
  layout: { pos: {}, open: {}, colors: {}, bots: {}, capsules: {} },
  fs: initialState(), version: 0, nodeRev: {},
  view: (LS("view") as View) ?? "canvas", layer: "pipeline", reportRun: null,
  attachments: [], chatOpen: (LS("chatOpen") as boolean) ?? false, chatWidth: (LS("chatWidth") as number) ?? 320, unread: 0,
  live: emptyLive(), dispatcher: idleDispatcher(),
  browser: emptyBrowser(),
  inspectors: [], selected: [], follow: false, trail: null, flashes: {}, settings: {}, model: "", keyPresent: false, replay: null, focus: null, draft: "", boardFocus: null,
};

const listeners = new Set<() => void>();
export const getState = () => state;
export function setState(patch: Partial<Store> | ((s: Store) => Partial<Store>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  if ("view" in p) LS("view", state.view);
  if ("chatOpen" in p) LS("chatOpen", state.chatOpen);
  if ("chatWidth" in p) LS("chatWidth", state.chatWidth);
  for (const l of listeners) l();
}
export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function useStore<T>(sel: (s: Store) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

/* ------------------------------------------------------------------ events → projection */

/** Transient listeners (particles, flashes) see every event as it is applied. */
const eventTaps = new Set<(e: Stamped) => void>();
export const onEvent = (f: (e: Stamped) => void) => { eventTaps.add(f); return () => { eventTaps.delete(f); }; };

let pending: Stamped[] = [];
let raf = 0;

function touched(e: Stamped, fs: FactoryState): string[] {
  switch (e.kind) {
    case "token.queued": return [e.node, ...(e.from ? [e.from] : [])];
    case "attempt.started": return [e.node];
    case "attempt.progress": case "attempt.finished": { const a = fs.attempts[e.attempt]; return a ? [a.node] : []; }
    case "evidence.added": return [e.evidence.station];
    case "token.finished": return [e.node];
    case "token.returned": return [e.from, e.to, ...(e.reset ?? [])];
    case "worker.spawned": case "worker.forked": case "worker.retired": case "review.verdict": return [e.node];
    case "stock.set": return [e.node];
    case "token.created": return [e.source];
    case "run.started": case "resource.sample": case "run.ended": return Object.keys(fs.nodes);
    default: return [];
  }
}

export function ingest(events: Stamped[]) {
  pending.push(...events);
  if (!raf) raf = requestAnimationFrame(flush);
}

function flush() {
  raf = 0;
  const batch = pending;
  pending = [];
  if (!batch.length) return;
  const fs = state.fs;
  const rev = { ...state.nodeRev };
  const flashes = { ...state.flashes };
  let unread = state.unread;
  for (const e of batch) {
    if (e.seq <= fs.seq) continue;
    apply(fs, e);
    for (const k of touched(e, fs)) rev[k] = (rev[k] ?? 0) + 1;
    if (e.kind === "evidence.added") flashes[e.evidence.id] = e.at;
    if (e.kind === "chat.assistant" && !state.chatOpen) unread++;
    for (const t of eventTaps) t(e);
  }
  setState({ version: state.version + 1, nodeRev: rev, flashes, unread });
}

export function resetProjection(factory: CompiledFactory) {
  setState({ fs: initialState(factory), nodeRev: {}, version: state.version + 1 });
}

/* ------------------------------------------------------------------ helpers */

export const nodeOf = (key: string) => state.factory?.nodes.find((n) => n.key === key);

export function attach(a: Attachment) {
  setState((s) => (s.attachments.some((x) => x.type === a.type && x.id === a.id) ? {} : { attachments: [...s.attachments, a] }));
}
export function detach(type: Attachment["type"], id: string) {
  setState((s) => ({ attachments: s.attachments.filter((x) => !(x.type === type && x.id === id)) }));
}
