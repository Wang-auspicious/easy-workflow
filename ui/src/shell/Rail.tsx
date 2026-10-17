import { useEffect, useRef, useState } from "react";
import { Workflow, Images, Library, History, Globe, Settings2, ListRestart, ArrowUpRight, RefreshCw, ClipboardCheck } from "lucide-react";
import type { Alert } from "../../../shared/types.ts";
import { actions, api } from "../api.ts";
import { getState, setState, useStore, type View } from "../store.ts";
import { toast } from "./Toasts.tsx";
import { alertPresentation } from "./alert-presentation.ts";
import {manualOwner, manualQueue} from '../../../shared/project.ts';

const ITEMS: { view: View; icon: typeof Workflow; label: string; key?: string }[] = [
  { view: "canvas", icon: Workflow, label: "画布 · 流水线", key: "Alt 1" },
  { view: "board", icon: Images, label: "证据板", key: "Alt 2" },
  { view: "review", icon: ClipboardCheck, label: "待人工 · 逐件审核" },
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
  const manualCount = useStore(s => manualQueue(s.fs).filter(token => manualOwner(token) === 'human').length);
  return (
    <nav className="rail" aria-label="工作台导航">
      <div className="rail-mark" data-tip="Easy Workflow">
        <Workflow size={24} strokeWidth={1.8} />
      </div>
      <div className="rail-items">
        {ITEMS.map(({ view: v, icon: Icon, label, key }) => (
          <button key={v} aria-label={label} aria-current={view === v || (v === 'runs' && view === 'report') ? 'page' : undefined} className={`rail-item ${view === v || (v === "runs" && view === "report") ? "is-on" : ""}`} onClick={() => setState({ view: v })} data-tip={key ? `${label}  ${key}` : label} data-tip-side="right">
            <Icon size={19} strokeWidth={1.7} />
            {v === "review" && manualCount > 0 && <span className="rail-badge num">{manualCount > 99 ? "99+" : manualCount}</span>}
            {v === "browser" && (browser.tabs.some(t => t.attention) ? <i className="rail-browser-alert" aria-label="浏览器需要检查" /> : browser.tabs.length > 0 && <span className="rail-badge num" aria-label={`${browser.tabs.length} 个网页`}>{browser.tabs.length}</span>)}
          </button>
        ))}
      </div>
      <div className="rail-foot">
        <AlertLight />
        <button aria-label="设置" aria-current={view === 'settings' ? 'page' : undefined} className={`rail-item ${view === "settings" ? "is-on" : ""}`} onClick={() => setState({ view: "settings" })} data-tip="设置" data-tip-side="right">
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
  const mine = alerts.filter(a => a.view.requiresUser);
  // Problems the system retries on its own are grouped by cause; each group is one line.
  const groups = new Map<string, typeof alerts>();
  for (const a of alerts.filter(a => !a.view.requiresUser)) groups.set(a.view.label, [...(groups.get(a.view.label) ?? []), a]);
  const disabled = Boolean(busy || replay) || !connected;
  return (
    <>
      <button ref={btn} className={`rail-item rail-alert ${userCount ? "" : "is-recovery"}`} onClick={() => setOpen(!open)}
        data-tip={userCount ? `${userCount} 件需要你处理` : `${alerts.length} 件在自动恢复，不需要你操作`} data-tip-side="right" aria-label="需要你处理的事">
        <i className="rail-alert-dot" />
        {userCount > 0 && <span className="rail-badge num">{userCount}</span>}
      </button>
      {open && (
        <div ref={pop} className="alert-pop alert-pop--plain" style={{ left: (r?.right ?? 64) + 10, bottom: Math.max(12, window.innerHeight - (r?.bottom ?? 0)) }}>
          <header><b>{mine.length ? "需要你处理" : "不需要你处理"}</b><span className="grow" />
            <button className="alert-link" disabled={disabled} onClick={() => void tool("pf", { action: "preflight" }, "环境检查结果已更新")}><RefreshCw size={11} />重新检查环境</button></header>
          {mine.map(({ alert: a, view }) => (
            <div key={a.id} className="alert-row">
              <p><b>{view.title || view.label}</b>{view.nextAction || view.message}</p>
              {(view.tab || view.url || a.token || a.kind === "model" || a.kind === "preflight") &&
                <button className="alert-go" disabled={disabled} onClick={() => void go(a, view)}>{view.tab || view.url ? "打开页面" : "去处理"}<ArrowUpRight size={11} /></button>}
            </div>
          ))}
          {!mine.length && <p className="alert-calm">现在没有要你登录或决定的事。下面这些系统会自己重试。</p>}
          {[...groups.entries()].map(([label, list]) => (
            <details key={label} className="alert-group">
              <summary><span>{label}</span><em className="num">{list.length} 件</em></summary>
              <p className="alert-why">{list[0].view.nextAction || list[0].view.message}</p>
              <ul>{list.map(({ alert: a, view }) => <li key={a.id}><span>{view.title || a.token || a.id}</span>
                <button className="alert-link" disabled={disabled} onClick={() => void tool(a.id, { action: "recheck", id: a.id }, "已重新检查")}>{busy === a.id ? "检查中…" : "重新检查"}</button></li>)}</ul>
            </details>
          ))}
        </div>
      )}
    </>
  );
}
