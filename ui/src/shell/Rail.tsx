import { useEffect, useRef, useState } from "react";
import { Workflow, Images, Library, History, Globe, Settings2, ListRestart, ShieldAlert, ArrowUpRight, RefreshCw } from "lucide-react";
import type { Alert } from "../../../shared/types.ts";
import { actions, api } from "../api.ts";
import { getState, setState, useStore, type View } from "../store.ts";
import { toast } from "./Toasts.tsx";
import { alertPresentation } from "./alert-presentation.ts";

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
      <div className="rail-mark" data-tip="Easy Workflow">
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

/** Red only for an identified user action; recovery diagnostics remain inspectable. */
function AlertLight() {
  useStore(s => s.version);
  const browser = useStore(s => s.browser);
  const replay = useStore(s => s.replay);
  const connected = useStore(s => s.connected);
  const fs = getState().fs;
  const alerts = Object.values(fs.alerts ?? {}).sort((a, b) => b.at - a.at).map(alert => ({ alert, view: alertPresentation(alert, fs.recoveries ?? {}, browser) }));
  const userCount = alerts.filter(a => a.view.requiresUser).length;
  const badgeCount = userCount || alerts.length;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const btn = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const base = document.title.replace(/^● /, "");
    document.title = userCount ? `● ${base}` : base;
    if (!alerts.length) setOpen(false);
  }, [alerts.length, userCount]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", down);
    return () => window.removeEventListener("pointerdown", down);
  }, [open]);
  if (!alerts.length) return null;
  const tool = async (key: string, body: Record<string, unknown>, done: string) => {
    setBusy(key);
    try { const result = await api.post<{ result?: { message?: string } }>("/api/tools/alerts", body); toast(result.result?.message || done); } catch { /* API displays the reason; keep the alert visible. */ } finally { setBusy(""); }
  };
  const go = async (a: Alert, view: ReturnType<typeof alertPresentation>) => {
    setBusy(a.id);
    try {
      if (view.tab || view.url) {
        await actions.browser(view.tab ? { action: "activate", id: view.tab } : { action: "open", url: view.url });
        setState({ view: "browser" });
      } else if (a.kind === "model" || a.kind === "preflight") setState({ view: "settings" });
      else if (a.token) setState({ view: "canvas", inspectors: [...getState().inspectors.filter((i) => i.pinned), { key: a.token, kind: "token", x: 0, y: 0, pinned: false }] });
      setOpen(false);
    } catch { /* Keep diagnostics open when the target could not be opened. */ } finally { setBusy(""); }
  };
  const r = btn.current?.getBoundingClientRect();
  return (
    <>
      <button ref={btn} className={`rail-item rail-alert ${userCount ? "" : "is-recovery"}`} onClick={() => setOpen(!open)} data-tip={userCount ? `${userCount} 件需要你操作 · ${alerts.length - userCount} 件待系统检查` : `${alerts.length} 件待系统检查`} data-tip-side="right" aria-label={userCount ? `${userCount} 件需要你操作` : `${alerts.length} 件待系统检查`} aria-expanded={open}>
        <i className="rail-alert-dot" />
        {badgeCount > 1 && <span className="rail-badge num">{badgeCount}</span>}
      </button>
      {open && (
        <div ref={pop} className="alert-pop" style={{ left: (r?.right ?? 64) + 10, bottom: Math.max(12, window.innerHeight - (r?.bottom ?? 0)) }}>
          <header><ShieldAlert size={15} /><b>恢复与访问检查</b><span className="grow" /><button className="btn btn--sm btn--ghost" disabled={Boolean(busy || replay) || !connected} onClick={() => void tool("pf", { action: "preflight" }, "环境检查结果已更新")}><RefreshCw size={12} />环境检查</button></header>
          <p className="alert-summary">{userCount ? `${userCount} 件需要你操作` : "当前没有已确认的登录操作"}{alerts.length > userCount ? ` · ${alerts.length - userCount} 件待系统检查` : ""}</p>
          {alerts.sort((a, b) => Number(b.view.requiresUser) - Number(a.view.requiresUser)).map(({ alert: a, view }) => (
            <div key={a.id} className={`alert-item ${view.requiresUser ? "" : "is-recovery"}`}>
              <div className="alert-kind"><i className="rail-alert-dot" />{view.label}{view.title && <span className="muted"> · {view.title}</span>}</div>
              <p>{view.message}</p>
              {view.nextAction && <p className="alert-next">{view.nextAction}</p>}
              {view.details !== view.message && <details className="alert-diagnostics"><summary>诊断详情</summary><pre>{view.details}</pre></details>}
              <div className="alert-actions">
                {(view.tab || view.url || a.token || a.kind === "model" || a.kind === "preflight") && <button className="btn btn--sm" disabled={Boolean(busy || replay) || !connected} onClick={() => void go(a, view)}>{view.tab || view.url ? "打开对应页面" : a.kind === "model" || a.kind === "preflight" ? "打开设置" : "查看记录"}<ArrowUpRight size={12} /></button>}
                <button className="btn btn--sm btn--ghost" disabled={Boolean(busy || replay) || !connected} onClick={() => void tool(a.id, { action: "recheck", id: a.id }, "访问检查结果已更新")}>{busy === a.id ? "正在检查…" : "重新检查"}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
