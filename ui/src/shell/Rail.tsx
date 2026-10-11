import { useEffect, useRef, useState } from "react";
import { Workflow, Images, Library, History, Globe, Settings2, ListRestart, ShieldAlert, ArrowUpRight, RefreshCw } from "lucide-react";
import type { Alert } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { getState, setState, useStore, type View } from "../store.ts";
import { toast } from "./Toasts.tsx";

const ITEMS: { view: View; icon: typeof Workflow; label: string; key?: string }[] = [
  { view: "canvas", icon: Workflow, label: "画布 · 流水线", key: "Alt 1" },
  { view: "board", icon: Images, label: "证据板", key: "Alt 2" },
  { view:"candidates",icon:ListRestart,label:"候选恢复 · 按原因重试" },
  { view: "library", icon: Library, label: "流水线库" },
  { view: "runs", icon: History, label: "运行记录与回放" },
  { view: "browser", icon: Globe, label: "内置浏览器" },
];

export function Rail() {
  const view = useStore((s) => s.view);
  const connected = useStore((s) => s.connected);
  const replay = useStore((s) => s.replay);
  const browser = useStore((s) => s.browser);
  const evidenceCount = useStore((s) => s.fs.evidenceOrder.length);
  return (
    <nav className="rail">
      <div className="rail-mark" data-tip="Pi Factory">
        <Workflow size={24} strokeWidth={1.8} />
      </div>
      <div className="rail-items">
        {ITEMS.map(({ view: v, icon: Icon, label, key }) => (
          <button key={v} className={`rail-item ${view === v || (v === "runs" && view === "report") ? "is-on" : ""}`} onClick={() => setState({ view: v })} data-tip={key ? `${label}  ${key}` : label} data-tip-side="right">
            <Icon size={19} strokeWidth={1.7} />
            {v === "browser" && (browser.tabs.some(t => t.attention) ? <i className="rail-browser-alert" aria-label="浏览器需要检查" /> : browser.tabs.length > 0 && <span className="rail-badge num" aria-label={`${browser.tabs.length} 个网页`}>{browser.tabs.length}</span>)}
            {v === "board" && evidenceCount > 0 && <span className="rail-badge num">{evidenceCount > 999 ? "999+" : evidenceCount}</span>}
          </button>
        ))}
      </div>
      <div className="rail-foot">
        <AlertLight />
        <button className={`rail-item ${view === "settings" ? "is-on" : ""}`} onClick={() => setState({ view: "settings" })} data-tip="设置" data-tip-side="right">
          <Settings2 size={19} strokeWidth={1.7} />
        </button>
        <span className={`rail-conn ${replay ? "is-replay" : connected ? "is-on" : ""}`} data-tip={replay ? "回放中（离线）" : connected ? "已连接工厂" : "未连接"} data-tip-side="right" />
      </div>
    </nav>
  );
}

const ALERT_ZH: Record<Alert["kind"], string> = { tls: "证书", auth: "登录", model: "模型额度", preflight: "开跑体检", browser: "浏览器" };

/** Red light (Spec §30.7): certificate, login, model-quota or failed-preflight problems only the
 *  user can fix. Blinks in the rail and marks the window title until cleared. */
function AlertLight() {
  const alerts = Object.values(useStore((s) => s.fs.alerts) ?? {}).sort((a, b) => b.at - a.at);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const btn = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const base = document.title.replace(/^● /, "");
    document.title = alerts.length ? `● ${base}` : base;
    if (!alerts.length) setOpen(false);
  }, [alerts.length]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", down);
    return () => window.removeEventListener("pointerdown", down);
  }, [open]);
  if (!alerts.length) return null;
  const tool = async (key: string, body: Record<string, unknown>, done: string) => {
    setBusy(key);
    try { await api.post("/api/tools/alerts", body); toast(done); } catch (e) { toast(`没有成功：${(e as Error).message}`); } finally { setBusy(""); }
  };
  const go = (a: Alert) => {
    setOpen(false);
    if (a.tab || a.kind === "auth" || a.kind === "tls") setState({ view: "browser" });
    else if (a.token) setState({ view: "canvas", inspectors: [...getState().inspectors.filter((i) => i.pinned), { key: a.token, kind: "token", x: 0, y: 0, pinned: false }] });
  };
  const r = btn.current?.getBoundingClientRect();
  return (
    <>
      <button ref={btn} className="rail-item rail-alert" onClick={() => setOpen(!open)} data-tip={`${alerts.length} 个问题需要你处理`} data-tip-side="right" aria-label={`${alerts.length} 个红灯`}>
        <i className="rail-alert-dot" />
        {alerts.length > 1 && <span className="rail-badge num">{alerts.length}</span>}
      </button>
      {open && (
        <div ref={pop} className="alert-pop" style={{ left: (r?.right ?? 64) + 10, bottom: Math.max(12, window.innerHeight - (r?.bottom ?? 0)) }}>
          <header><ShieldAlert size={15} /><b>需要你处理</b><span className="grow" /><button className="btn btn--sm btn--ghost" disabled={busy === "pf"} onClick={() => void tool("pf", { action: "preflight" }, "已重新体检")}><RefreshCw size={12} />重新体检</button></header>
          {alerts.map((a) => (
            <div key={a.id} className="alert-item">
              <div className="alert-kind"><i className="rail-alert-dot" />{ALERT_ZH[a.kind] ?? a.kind}{a.item && <span className="muted"> · {a.item}</span>}</div>
              <p>{a.message}</p>
              {a.nextAction && <p className="alert-next">{a.nextAction}</p>}
              <div className="alert-actions">
                {(a.tab || a.token || a.kind === "auth" || a.kind === "tls") && <button className="btn btn--sm" onClick={() => go(a)}>去处理<ArrowUpRight size={12} /></button>}
                <button className="btn btn--sm btn--ghost" disabled={busy === a.id} onClick={() => void tool(a.id, { action: "clear", id: a.id, reason: "站长已处理" }, "红灯已熄灭")}>我已处理</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
