// Talking to the factory server: boot snapshot, SSE stream, actions.
import type { Attachment } from "../../shared/types.ts";
import type { FactoryState } from "../../shared/project.ts";
import { getState, ingest, setState, type LayoutFile, type NodeAgentBinding } from "./store.ts";
import { toast } from "./shell/Toasts.tsx";
import { legacyReply } from "../../shared/conversation.ts";
import { idleDispatcher, reconcileChatLive, reduceChatLive, type ChatEvent, type DispatcherStatus } from "./chat/live.ts";
import {executionIndex} from './canvas/status.ts';
import type {UiEvent} from '../../shared/client-view.ts';

export const api = {
  async get<T>(path: string, options?: { signal?: AbortSignal }): Promise<T> { const r = await fetch(path, options); if (!r.ok) throw new Error(`${path} ${r.status}`); return r.json(); },
  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    try {
      const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? `${path} ${r.status}`);
      return data;
    } catch (err) { toast((err as Error).message); throw err; }
  },
};

let es: EventSource | null = null;

export async function boot() {
  const f = await api.get<{ factory: any; layout: Partial<LayoutFile>; defaultLayout: any; settings: Record<string, number>; model: string; keyPresent: boolean; agentBindings?: NodeAgentBinding[] }>("/api/factory");
  const fs = await api.get<FactoryState & { dispatcher?: DispatcherStatus }>("/api/state?view=ui-v1");
  // A window can reload while an older desktop backend is still shutting down.
  fs.activity ??= fs.chat.filter(m=>m.role==="note");
  fs.recoveries ??= {};
  fs.conversation ??= fs.chat.filter(m=>m.role!=="note").map(m=>({id:m.id,turn:m.id.replace(/-r$/,""),message:m.role==="user"?{role:"user" as const,content:m.text,timestamp:m.at}:legacyReply(m.text,m.at),attachments:m.attachments}));
  const layout = { pos: {}, open: {}, colors: {}, bots: {}, capsules: {}, ...f.layout };
  if (layout.designVersion !== 4) {
    // Preserve previous coordinates before adopting the requested compact layout.
    // The old file is untouched until the next explicit layout edit; after that
    // its coordinates remain available in previousLayout, not silently discarded.
    layout.previousLayout = { pos: layout.pos, capsules: layout.capsules, open: layout.open, designVersion: layout.designVersion };
    layout.pos = {}; layout.capsules = {}; layout.open = {}; layout.designVersion = 4;
  }
  setState({
    factory: f.factory, defaultLayout: f.defaultLayout,
    agentBindings: Object.fromEntries((f.agentBindings ?? []).map(binding => [binding.node, binding])),
    nodeExecutions: executionIndex(fs),
    layout,
    fs, version: getState().version + 1, settings: f.settings, model: f.model, keyPresent: f.keyPresent, ready: true,
    dispatcher: fs.dispatcher ?? idleDispatcher(),
    live: reconcileChatLive(getState().live, fs.dispatcher ?? idleDispatcher()),
  });
  connect(fs.seq);
  void api.get<import("../../shared/browser.ts").BrowserState>("/api/browser").then(browser => setState({browser})).catch(() => {});
}

export function connect(since: number) {
  es?.close();
  es = new EventSource(`/api/events?since=${since}&view=ui-v1`);
  es.onopen = () => setState({ connected: true });
  es.onerror = () => setState({ connected: false });
  es.onmessage = (m) => {
    if (getState().replay) return;
    const event = JSON.parse(m.data) as UiEvent;
    ingest([event]);
    if (event.kind === 'agent.binding') void refreshAgentBindings(event.node);
    if (event.kind === "factory.loaded" || event.kind === "spec.patched") void refreshSpec();
  };
  es.addEventListener("live", (m) => {
    const e = JSON.parse((m as MessageEvent).data) as ChatEvent & { state?: import("../../shared/browser.ts").BrowserState };
    if (e.kind === "browser.state" && e.state) { setState({browser:e.state}); return; }
    if (getState().replay) return;
    const live = getState().live;
    if (e.kind === "chat.status") {
      const dispatcher = JSON.parse((m as MessageEvent).data) as DispatcherStatus;
      setState({ dispatcher, live: reconcileChatLive(live, dispatcher) });
    } else setState({ live: reduceChatLive(live, e) });
  });
}

async function refreshSpec() {
  try {
    const f = await api.get<{ factory: any; defaultLayout: any; agentBindings?: NodeAgentBinding[] }>("/api/factory");
    if (!getState().replay) setState((s) => ({ factory: f.factory, defaultLayout: f.defaultLayout,
      agentBindings: Object.fromEntries((f.agentBindings ?? []).map(binding => [binding.node, binding])),
      inspectors: s.inspectors.filter((i) => i.kind === "token" || f.factory.nodes.some((n: { key: string }) => n.key === i.key)),
    }));
  } catch (err) { toast(`规格刷新失败：${(err as Error).message}`); }
}

const bindingReads = new Map<string, number>();
async function refreshAgentBindings(node: string) {
  const generation = (bindingReads.get(node) ?? 0) + 1;
  bindingReads.set(node, generation);
  try {
    const response = await fetch('/api/tools/agent_bindings', {
      method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({node}),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    if (!response.ok || !body.ok || !Array.isArray(body.result?.bindings)) return;
    if (getState().replay || bindingReads.get(node) !== generation) return;
    const binding = (body.result.bindings as NodeAgentBinding[]).find(binding => binding.node === node);
    setState(state => {
      const metadata = {...state.agentBindings};
      if (binding) metadata[node] = binding;
      else delete metadata[node];
      return {agentBindings: metadata};
    });
  } catch { /* Preserve recorded execution; a later read can resolve default metadata. */ }
}

export function disconnect() { es?.close(); es = null; }

let layoutTimer = 0;
export function saveLayout(next: LayoutFile) {
  setState({ layout: next });
  clearTimeout(layoutTimer);
  layoutTimer = window.setTimeout(() => void api.post("/api/layout", next), 500);
}

export const actions = {
  chat: (text: string, attachments: Attachment[], options?: { requestId: string; mode: "steer" | "followUp" }) => api.post("/api/chat", { text, attachments, ...options }),
  abortChat: () => api.post("/api/chat/abort", {}),
  continueChat: () => api.post("/api/chat/continue", {}),
  browser: async (args: Record<string,unknown>) => { const browser = await api.post<import("../../shared/browser.ts").BrowserState>("/api/browser",args); setState({browser}); return browser; },
  run: (action: "start" | "pause" | "resume" | "end", title?: string) => api.post("/api/run", { action, title }),
  pull: (count: number, category?: string) => api.post("/api/pull", { count, category }),
  feed: (urls: string[]) => api.post("/api/feed", { urls }),
  correct: (items: { token: string; node: string; evidence?: string }[], reason: string, note?: string) => api.post<{ ok: boolean; results: { ok: boolean; message: string; correction?: string }[] }>("/api/correct", { items, reason, note }),
  workers: (node: string, action: "fork" | "retire" | "lock" | "unlock") => api.post("/api/workers", { node, action }),
  settings: (s: Record<string, number>) => api.post("/api/settings", s),
  patch: (id: string, accept: boolean) => api.post("/api/patch", { id, accept }),
};
