// Talking to the factory server: boot snapshot, SSE stream, actions.
import type { Attachment, CompiledFactory, ProjectAgentDefaults } from "../../shared/types.ts";
import type {LayoutResult} from '../../shared/layout.ts';
import type { FactoryState } from "../../shared/project.ts";
import { clearPendingEvents, getState, ingest, setState, type LayoutFile, type NodeAgentBinding } from "./store.ts";
import { toast } from "./shell/Toasts.tsx";
import { legacyReply } from "../../shared/conversation.ts";
import { idleDispatcher, reconcileChatLive, reduceChatLive, type ChatEvent, type DispatcherStatus } from "./chat/live.ts";
import {executionIndex} from './canvas/status.ts';
import type {UiEvent} from '../../shared/client-view.ts';
import {mergeKernelEvents, type KernelSnapshot} from './kernel.ts';
import type {Stamped} from '../../shared/types.ts';

export const api = {
  async get<T>(path: string, options?: { signal?: AbortSignal }): Promise<T> {
    return readResponse<T>(await fetch(path, options));
  },
  async post<T = unknown>(path: string, body: unknown, options?: {signal?: AbortSignal}): Promise<T> {
    try {
      const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: options?.signal });
      return await readResponse<T>(r);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) toast(err instanceof Error ? err.message : '请求失败，请重试。');
      throw err;
    }
  },
};

async function readResponse<T>(response: Response): Promise<T> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(response.ok ? '服务返回了无法读取的数据，请重试。' : `服务请求失败（HTTP ${response.status}），请检查连接后重试。`);
  }
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : `服务请求失败（HTTP ${response.status}）`;
    throw new Error(`${message}（HTTP ${response.status}）`);
  }
  return data as T;
}

let es: EventSource | null = null;
let bootGeneration = 0;
let bootController: AbortController | null = null;
let specGeneration = 0;

interface FactorySnapshot {
  kernel?: 'v1' | 'v2';
  factory: CompiledFactory;
  layout: Partial<LayoutFile>;
  defaultLayout: LayoutResult;
  settings: Record<string, number>;
  model: string;
  keyPresent: boolean;
  agentBindings?: NodeAgentBinding[];
}

export async function boot() {
  if (getState().replay) return;
  const generation = ++bootGeneration;
  specGeneration++;
  bootController?.abort();
  const controller = new AbortController();
  bootController = controller;
  setState({bootError: null});
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
  const initialLayoutRevision = layoutRevision;
  try {
    let f: FactorySnapshot | null = null;
    let fs: (FactoryState & {dispatcher?: DispatcherStatus}) | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const readingSpec = specGeneration;
      const factory = await api.get<FactorySnapshot>('/api/factory', {signal});
      const state = await api.get<FactoryState & {dispatcher?: DispatcherStatus}>('/api/state?view=ui-v1', {signal});
      if (generation !== bootGeneration || getState().replay) return;
      if (readingSpec === specGeneration && state.digest === factory.factory.digest) {
        f = factory;
        fs = state;
        break;
      }
    }
    if (!f || !fs) throw new Error('工作流规格正在更新，请重新连接以读取一致的状态。');
    clearPendingEvents();
    // A window can reload while an older desktop backend is still shutting down.
    fs.activity ??= fs.chat.filter(m=>m.role==="note");
    fs.recoveries ??= {};
    fs.conversation ??= fs.chat.filter(m=>m.role!=="note").map(m=>({id:m.id,turn:m.id.replace(/-r$/,""),message:m.role==="user"?{role:"user" as const,content:m.text,timestamp:m.at}:legacyReply(m.text,m.at),attachments:m.attachments}));
    const layout = { pos: {}, open: {}, colors: {}, bots: {}, capsules: {}, ...f.layout };
    if (layout.designVersion !== 6) {
      // Preserve previous coordinates before adopting the requested compact layout.
      // The old file is untouched until the next explicit layout edit; after that
      // its coordinates remain available in previousLayout, not silently discarded.
      layout.previousLayout = { pos: layout.pos, capsules: layout.capsules, open: layout.open, designVersion: layout.designVersion };
      layout.pos = {}; layout.capsules = {}; layout.open = {}; layout.designVersion = 6;
    }
    setState({
      kernel: f.kernel ?? 'v1', kernelSnapshot: null, kernelEvents: [], boardRevisions: {},
      factory: f.factory, defaultLayout: f.defaultLayout,
      agentBindings: Object.fromEntries((f.agentBindings ?? []).map(binding => [binding.node, binding])),
      nodeExecutions: executionIndex(fs),
      layout: layoutDirty || layoutRevision !== initialLayoutRevision ? getState().layout : layout,
      fs, version: getState().version + 1, settings: f.settings, model: f.model, keyPresent: f.keyPresent, ready: true,
      dispatcher: fs.dispatcher ?? idleDispatcher(),
      live: reconcileChatLive(getState().live, fs.dispatcher ?? idleDispatcher()),
    });
    connect(fs.seq);
    if (f.kernel === 'v2') void refreshKernel(true);
    void persistLayout();
    void api.get<import("../../shared/browser.ts").BrowserState>("/api/browser", {signal}).then(browser => {
      if (generation === bootGeneration && !getState().replay) setState({browser});
    }).catch(() => {});
  } catch (error) {
    if (generation !== bootGeneration || controller.signal.aborted) return;
    const message = signal.aborted ? '连接超时，请检查本地服务后重试。' : error instanceof Error ? error.message : '无法读取工作台，请重试。';
    setState({bootError: message, connected: false});
    throw new Error(message);
  }
}

export function connect(since: number) {
  es?.close();
  const stream = new EventSource(`/api/events?since=${since}&view=ui-v1`);
  es = stream;
  stream.onopen = () => { if (es === stream) setState({ connected: true }); };
  stream.onerror = () => { if (es === stream) setState({ connected: false }); };
  stream.onmessage = (m) => {
    if (es !== stream || getState().replay) return;
    const event = JSON.parse(m.data) as UiEvent;
    ingest([event]);
    if (getState().kernel === 'v2') {
      setState(state => ({kernelEvents: mergeKernelEvents(state.kernelEvents, [event as Stamped])}));
      if (event.kind === 'board.posted') setState(state => ({boardRevisions: {...state.boardRevisions, [event.post.item]: event.seq}}));
      scheduleKernelRefresh();
    }
    if (event.kind === 'agent.binding') void refreshAgentBindings(event.node);
    if (event.kind === 'agent.defaults') void refreshSpec();
    if (event.kind === "factory.loaded" || event.kind === "spec.patched") void refreshSpec();
  };
  stream.addEventListener("live", (m) => {
    if (es !== stream || getState().replay) return;
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

export async function refreshSpec() {
  const generation = ++specGeneration;
  try {
    const f = await api.get<{ factory: CompiledFactory; defaultLayout: LayoutResult; agentBindings?: NodeAgentBinding[]; agentDefaults?: ProjectAgentDefaults; model?: string; keyPresent?: boolean }>("/api/factory", {signal: AbortSignal.timeout(20000)});
    if (generation === specGeneration && !getState().replay) setState((s) => ({ factory: f.factory, defaultLayout: f.defaultLayout,
      agentBindings: Object.fromEntries((f.agentBindings ?? []).map(binding => [binding.node, binding])),
      ...(f.model !== undefined ? {model: f.model} : {}),
      ...(f.keyPresent !== undefined ? {keyPresent: f.keyPresent} : {}),
      inspectors: s.inspectors.filter((i) => i.kind === "token" || f.factory.nodes.some((n: { key: string }) => n.key === i.key)),
    }));
  } catch (err) { if (generation === specGeneration && !getState().replay) toast(`规格刷新失败：${(err as Error).message}`); }
}

const bindingReads = new Map<string, number>();
async function refreshAgentBindings(node: string) {
  const snapshotGeneration = bootGeneration;
  const generation = (bindingReads.get(node) ?? 0) + 1;
  bindingReads.set(node, generation);
  try {
    const response = await fetch('/api/tools/agent_bindings', {
      method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({node}),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    if (!response.ok || !body.ok || !Array.isArray(body.result?.bindings)) return;
    if (getState().replay || bindingReads.get(node) !== generation || snapshotGeneration !== bootGeneration) return;
    const binding = (body.result.bindings as NodeAgentBinding[]).find(binding => binding.node === node);
    setState(state => {
      const metadata = {...state.agentBindings};
      if (binding) metadata[node] = binding;
      else delete metadata[node];
      return {agentBindings: metadata};
    });
  } catch { /* Preserve recorded execution; a later read can resolve default metadata. */ }
}

export function disconnect() {
  bootGeneration++;
  specGeneration++;
  bootController?.abort();
  es?.close();
  es = null;
  clearTimeout(kernelRefreshTimer);
  setState({connected: false});
}

let kernelRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let kernelRead = 0;
export async function refreshKernel(history = false): Promise<void> {
  if (getState().kernel !== 'v2' || getState().replay) return;
  const generation = ++kernelRead;
  const projectGeneration = bootGeneration;
  try {
    const snapshot = await api.get<KernelSnapshot>('/api/kernel/streams');
    if (projectGeneration !== bootGeneration || getState().kernel !== 'v2' || getState().replay) return;
    if (generation === kernelRead) setState({kernelSnapshot: snapshot});
    if (history) {
      let since = 0;
      for (let page = 0; page < 4; page++) {
        const response = await api.get<{events: Stamped[]; seq: number; hasMore?: boolean}>(`/api/kernel/conversation?since=${since}&includeProgress=1`);
        if (projectGeneration !== bootGeneration || getState().replay) return;
        setState(state => ({kernelEvents: mergeKernelEvents(state.kernelEvents, response.events)}));
        if (!response.hasMore || response.seq <= since) break;
        since = response.seq;
      }
    }
  } catch { /* The last confirmed counts remain visible until the connection recovers. */ }
}

function scheduleKernelRefresh() {
  if (kernelRefreshTimer) return;
  kernelRefreshTimer = setTimeout(() => {kernelRefreshTimer = undefined; void refreshKernel();}, 350);
}

let layoutTimer = 0;
let pendingLayout: LayoutFile | null = null;
let layoutWriting = false;
let layoutDirty = false;
let layoutRevision = 0;

async function persistLayout() {
  if (layoutWriting || !pendingLayout || getState().replay) return;
  layoutWriting = true;
  try {
    while (pendingLayout && !getState().replay) {
      const next = pendingLayout;
      pendingLayout = null;
      try {
        await api.post('/api/layout', next);
        if (!pendingLayout && getState().layout === next) layoutDirty = false;
      } catch {
        toast('布局尚未保存，当前画面已保留。', {
          label: '重试保存',
          run: () => saveLayout(getState().layout),
        }, 10000);
      }
    }
  } finally {
    layoutWriting = false;
  }
}

export function saveLayout(next: LayoutFile) {
  if (getState().replay) {
    toast('回放期间布局只读，请退出回放后调整。');
    return;
  }
  setState({ layout: next });
  layoutRevision++;
  layoutDirty = true;
  pendingLayout = next;
  clearTimeout(layoutTimer);
  layoutTimer = window.setTimeout(() => void persistLayout(), 500);
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
