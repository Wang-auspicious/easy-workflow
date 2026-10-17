// Dashboard store: the compiled factory, the user's layout file, and the journal
// projection fed by SSE (or by a recorded journal in replay mode). The projection is the
// same `apply` the server uses, so what the canvas shows is exactly what the journal says.
import { useSyncExternalStore } from "react";
import { emptyBrowser, type BrowserState } from "../../shared/browser.ts";
import type { Attachment, CompiledFactory, Stamped, StationAgentBinding } from "../../shared/types.ts";
import { apply, initialState, type FactoryState } from "../../shared/project.ts";
import type { LayoutResult } from "../../shared/layout.ts";
import { emptyLive, idleDispatcher, type DispatcherStatus, type LiveChat } from "./chat/live.ts";
import {executionIndex, recordNodeExecution, runtimeRecoveryIndex, type NodeExecution} from './canvas/status.ts';
import {applyUiEvent, isUiState, type UiEvent} from '../../shared/client-view.ts';
import type {KernelSnapshot} from './kernel.ts';
export type { LiveChat } from "./chat/live.ts";

export type View = "canvas" | "board" | "review" | "candidates" | "library" | "runs" | "browser" | "settings" | "report";
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
export interface NodeAgentBinding {
  node: string;
  mode?: 'agent' | 'model-assist';
  configured: StationAgentBinding | null;
  effective: StationAgentBinding | null;
  source: 'project' | 'workflow' | 'default';
  capabilities: {stream: boolean; cancel: boolean; resume: boolean; usage: 'reported' | 'tokens-only' | 'unknown'};
  lastModel?: string;
  error?: string;
}

export interface Store {
  kernel: 'v1' | 'v2';
  kernelSnapshot: KernelSnapshot | null;
  kernelEvents: Stamped[];
  boardRevisions: Record<string, number>;
  showProgress: boolean;
  ready: boolean;
  bootError: string | null;
  connected: boolean;
  factory: CompiledFactory | null;
  defaultLayout: LayoutResult | null;
  layout: LayoutFile;
  fs: FactoryState;
  version: number;
  nodeRev: Record<string, number>;
  agentBindings: Record<string, NodeAgentBinding>;
  nodeExecutions: Record<string, NodeExecution>;
  nodeRecoveries: Record<string, string[]>;
  view: View;
  layer: Layer;
  reportRun: string | null;
  attachments: Attachment[];
  chatOpen: boolean;
  chatWidth: number;
  unread: number;
  /** 右侧栏当前展开的是哪个群（'root' = 主调度）。 */
  chatRoom: string;
  /** 群组栏是否展开；收起时只留一列头像。 */
  roomRailOpen: boolean;
  /** Grok Bot style: the conversation list replaces the open conversation. */
  chatList: boolean;
  /** 每个群看到哪一刻，用来算未读。 */
  roomSeen: Record<string, number>;
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
  replayLoading: { run: string; count: number; error?: string } | null;
  focus: { x: number; y: number; k?: number; area?: { w: number; h: number }; at: number } | null;
  draft: string;
  boardFocus: string | null;
  /** 你自己在对话里用哪张头像（ui/public/avatars 里的名字）。 */
  userAvatar: string;
  /** 发过的消息，供输入框用 ↑/↓ 回溯。 */
  history: string[];
}

const LS = (k: string, v?: unknown) => {
  try {
    if (v === undefined) return JSON.parse(localStorage.getItem(`pf.${k}`) ?? "null");
    localStorage.setItem(`pf.${k}`, JSON.stringify(v));
  } catch { /* storage may be unavailable */ }
  return null;
};

let state: Store = {
  kernel: 'v1', kernelSnapshot: null, kernelEvents: [], boardRevisions: {}, showProgress: (LS('showProgress') as boolean) ?? false,
  ready: false, bootError: null, connected: false, factory: null, defaultLayout: null, replayLoading: null,
  layout: { pos: {}, open: {}, colors: {}, bots: {}, capsules: {} },
  fs: initialState(), version: 0, nodeRev: {}, agentBindings: {}, nodeExecutions: {}, nodeRecoveries: {},
  view: (LS("view") as View) ?? "canvas", layer: "pipeline", reportRun: null,
  attachments: [], chatOpen: (LS("chatOpen") as boolean) ?? false, chatWidth: (LS("chatWidth") as number) ?? 320, unread: 0,
  chatRoom: (LS("chatRoom") as string) ?? "root", roomRailOpen: (LS("roomRailOpen") as boolean) ?? true, chatList: false, roomSeen: (LS("roomSeen") as Record<string, number>) ?? {},
  live: emptyLive(), dispatcher: idleDispatcher(),
  browser: emptyBrowser(),
  inspectors: [], selected: [], follow: false, trail: null, flashes: {}, settings: {}, model: "", keyPresent: false, replay: null, focus: null, draft: "", boardFocus: null,
  userAvatar: (LS("userAvatar") as string) ?? "ada", history: (LS("history") as string[]) ?? [],
};

const listeners = new Set<() => void>();
export const getState = () => state;
export function setState(patch: Partial<Store> | ((s: Store) => Partial<Store>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = {...state, ...p,
    ...(p.fs && p.fs !== state.fs && !('nodeExecutions' in p) ? {nodeExecutions: executionIndex(p.fs)} : {}),
    ...(p.fs && p.fs !== state.fs && !('nodeRecoveries' in p) ? {nodeRecoveries: runtimeRecoveryIndex(p.fs)} : {}),
  };
  if ("view" in p) LS("view", state.view);
  if ("chatOpen" in p) LS("chatOpen", state.chatOpen);
  if ("chatWidth" in p) LS("chatWidth", state.chatWidth);
  if ("chatRoom" in p) LS("chatRoom", state.chatRoom);
  if ("roomRailOpen" in p) LS("roomRailOpen", state.roomRailOpen);
  if ("roomSeen" in p) LS("roomSeen", state.roomSeen);
  if ("userAvatar" in p) LS("userAvatar", state.userAvatar);
  if ("history" in p) LS("history", state.history);
  if ('showProgress' in p) LS('showProgress', state.showProgress);
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

let pending: UiEvent[] = [];
let raf = 0;

function touched(e: Stamped, fs: FactoryState): string[] {
  if (e.kind === 'agent.defaults') return Object.keys(fs.nodes);
  switch (e.kind) {
    case "token.queued": return [e.node, ...(e.from ? [e.from] : [])];
    case "attempt.started": return [e.node];
    case "attempt.progress": case "attempt.finished": { const a = fs.attempts[e.attempt]; return a ? [a.node] : []; }
    case "evidence.added": return [e.evidence.station];
    case "token.finished": return [e.node, ...(fs.tokens[e.token]?.at ?? [])];
    case "token.returned": return [e.from, e.to, ...(e.reset ?? [])];
    case "worker.spawned": case "worker.forked": case "worker.retired": case "review.verdict": return [e.node];
    case "stock.set": case 'agent.binding': return [e.node];
    case "token.created": return [e.source];
    case "run.started": case "run.paused": case "run.resumed": case "resource.sample": case "run.ended": case "batch.configured": case "correction.reverted": case 'model.circuit': return Object.keys(fs.nodes);
    case 'scope.paused': return e.scope === 'station' ? [e.key] : Object.keys(fs.nodes).filter(key => key.startsWith(`${e.key}/`));
    case 'consult.opened': return [e.reviewer, e.owner];
    default: return [];
  }
}

export function ingest(events: UiEvent[]) {
  for (const event of events) pending.push(event);
  if (!raf) raf = requestAnimationFrame(flush);
}

export function clearPendingEvents() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0; pending = [];
}

function flush() {
  raf = 0;
  const batch = pending;
  pending = [];
  if (!batch.length) return;
  const fs = state.fs;
  const rev = { ...state.nodeRev };
  const flashes = { ...state.flashes };
  const nodeExecutions = {...state.nodeExecutions};
  let unread = state.unread;
  let changedProjection = false;
  let changedRecovery = false;
  const started = performance.now();
  let cursor = 0;
  for (; cursor < batch.length && cursor < 200 && performance.now() - started < 8; cursor++) {
    const e = batch[cursor];
    if (e.seq <= fs.seq) continue;
    if (e.kind === 'ui.cursor') {
      applyUiEvent(fs, e);
      continue;
    }
    changedProjection = true;
    const changed = touched(e, fs);
    if (isUiState(fs) && !state.replay) applyUiEvent(fs, e);
    else apply(fs, e);
    if (['run.started', 'run.ended', 'batch.configured', 'token.created', 'token.queued', 'token.finished', 'correction.reverted'].includes(e.kind) ||
        e.kind === 'token.data' && ['__runtimeRecovery', 'retriedBy', 'workflowPack', 'channelDelivery'].some(key => Object.hasOwn(e.patch, key))) {
      changedRecovery = true;
    }
    if (e.kind === 'attempt.finished') recordNodeExecution(nodeExecutions, fs.attempts[e.attempt]);
    for (const k of new Set([...changed, ...touched(e, fs)])) rev[k] = (rev[k] ?? 0) + 1;
    if (e.kind === "evidence.added") flashes[e.evidence.id] = e.at;
    if (e.kind === "chat.assistant" && !state.chatOpen) unread++;
    for (const t of eventTaps) t(e);
  }
  if (cursor < batch.length) pending = batch.slice(cursor).concat(pending);
  if (changedProjection) {
    setState({ version: state.version + 1, nodeRev: rev, nodeExecutions, flashes, unread,
      ...(changedRecovery ? {nodeRecoveries: runtimeRecoveryIndex(fs)} : {}),
    });
  }
  if (pending.length && !raf) raf = requestAnimationFrame(flush);
}

export function resetProjection(factory: CompiledFactory) {
  setState({ fs: initialState(factory), nodeRev: {}, nodeExecutions: {}, version: state.version + 1 });
}

/* ------------------------------------------------------------------ helpers */

export const nodeOf = (key: string) => state.factory?.nodes.find((n) => n.key === key);

export function attach(a: Attachment) {
  setState((s) => (s.attachments.some((x) => x.type === a.type && x.id === a.id) ? {} : { attachments: [...s.attachments, a] }));
}
export function detach(type: Attachment["type"], id: string) {
  setState((s) => ({ attachments: s.attachments.filter((x) => !(x.type === type && x.id === id)) }));
}
