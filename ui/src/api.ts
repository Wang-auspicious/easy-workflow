// Talking to the factory server: boot snapshot, SSE stream, actions.
import type { Attachment, Stamped } from "../../shared/types.ts";
import type { FactoryState } from "../../shared/project.ts";
import { getState, ingest, setState, type LayoutFile } from "./store.ts";
import { toast } from "./shell/Toasts.tsx";
import { legacyReply } from "../../shared/conversation.ts";

export const api = {
  async get<T>(path: string): Promise<T> { const r = await fetch(path); if (!r.ok) throw new Error(`${path} ${r.status}`); return r.json(); },
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
  const f = await api.get<{ factory: any; layout: Partial<LayoutFile>; defaultLayout: any; settings: Record<string, number>; model: string; keyPresent: boolean }>("/api/factory");
  const fs = await api.get<FactoryState>("/api/state");
  // A window can reload while an older desktop backend is still shutting down.
  fs.activity ??= fs.chat.filter(m=>m.role==="note");
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
    layout,
    fs, version: getState().version + 1, settings: f.settings, model: f.model, keyPresent: f.keyPresent, ready: true,
  });
  connect(fs.seq);
  void api.get<import("../../shared/browser.ts").BrowserState>("/api/browser").then(browser => setState({browser})).catch(() => {});
}

export function connect(since: number) {
  es?.close();
  es = new EventSource(`/api/events?since=${since}`);
  es.onopen = () => setState({ connected: true });
  es.onerror = () => setState({ connected: false });
  es.onmessage = (m) => {
    if (getState().replay) return;
    const event = JSON.parse(m.data) as Stamped;
    ingest([event]);
    if (event.kind === "factory.loaded" || event.kind === "spec.patched") void refreshSpec();
  };
  es.addEventListener("live", (m) => {
    const e = JSON.parse((m as MessageEvent).data) as { kind: string; delta?: string; name?: string; status?: string; summary?: string; id?: string; turn?:string; message?: import("../../shared/conversation.ts").PiMessage | null; state?: import("../../shared/browser.ts").BrowserState };
    if (e.kind === "browser.state" && e.state) { setState({browser:e.state}); return; }
    const live = getState().live;
    if (e.kind === "chat.start") setState({ live: { id: e.id ?? "x", text: "", tools: [] } });
    else if (e.kind === "chat.pi") setState({ live: { ...live, id:e.turn??live.id, messageId: e.id, message: e.message } });
    else if (e.kind === "chat.delta") setState({ live: { ...live, text: live.text + (e.delta ?? "") } });
    else if (e.kind === "chat.tool") {
      const tools = e.status === "start" ? [...live.tools, { name: e.name!, status: "start" }] : live.tools.map((t, i) => (i === live.tools.map((x) => x.name).lastIndexOf(e.name!) ? { ...t, status: "end", summary: e.summary } : t));
      setState({ live: { ...live, tools } });
    } else if (e.kind === "chat.end") setState({ live: { id: null, text: "", tools: [] } });
  });
}

async function refreshSpec() {
  try {
    const f = await api.get<{ factory: any; defaultLayout: any }>("/api/factory");
    if (!getState().replay) setState((s) => ({ factory: f.factory, defaultLayout: f.defaultLayout,
      inspectors: s.inspectors.filter((i) => i.kind === "token" || f.factory.nodes.some((n: { key: string }) => n.key === i.key)),
    }));
  } catch (err) { toast(`规格刷新失败：${(err as Error).message}`); }
}

export function disconnect() { es?.close(); es = null; }

let layoutTimer = 0;
export function saveLayout(next: LayoutFile) {
  setState({ layout: next });
  clearTimeout(layoutTimer);
  layoutTimer = window.setTimeout(() => void api.post("/api/layout", next), 500);
}

export const actions = {
  chat: (text: string, attachments: Attachment[]) => api.post("/api/chat", { text, attachments }),
  abortChat: () => api.post("/api/chat/abort", {}),
  browser: async (args: Record<string,unknown>) => { const browser = await api.post<import("../../shared/browser.ts").BrowserState>("/api/browser",args); setState({browser}); return browser; },
  run: (action: "start" | "pause" | "resume" | "end", title?: string) => api.post("/api/run", { action, title }),
  pull: (count: number, category?: string) => api.post("/api/pull", { count, category }),
  feed: (urls: string[]) => api.post("/api/feed", { urls }),
  correct: (items: { token: string; node: string; evidence?: string }[], reason: string, note?: string) => api.post<{ ok: boolean; results: { ok: boolean; message: string }[] }>("/api/correct", { items, reason, note }),
  workers: (node: string, action: "fork" | "retire" | "lock" | "unlock") => api.post("/api/workers", { node, action }),
  settings: (s: Record<string, number>) => api.post("/api/settings", s),
  patch: (id: string, accept: boolean) => api.post("/api/patch", { id, accept }),
};
