// Metrics HUD (Spec §10.2): time, tokens, cost, one light per item in this run, done/total.
// It floats on the canvas, top-left; clicking it opens the per-station breakdown.
import { useState } from "react";
import { Play, Pause, Square, PackagePlus, ChevronDown } from "lucide-react";
import { elapsed, median, latestRunTokens, type TokenState } from "../../../shared/project.ts";
import { getState, setState, useStore } from "../store.ts";
import { actions } from "../api.ts";
import { useNow } from "../util/useNow.ts";
import { fmt, secs } from "./Node.tsx";
import { toggleInspector } from "./Canvas.tsx";
import { toast } from "../shell/Toasts.tsx";

const CATEGORIES = ["UI 组件与设计系统", "灵感与案例", "视觉素材与字体", "设计创作与原型", "前端开发与动效", "AI 设计工具", "UX 研究与学习", "协作与效率", "品牌与营销"];

export function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

const lightOf = (t: TokenState) => (t.status === "published" ? "done" : t.status === "active" ? (t.corrections || Object.keys(t.rounds).length ? "warn" : "run") : t.status === "manual" ? "warn" : t.status === "failed" ? "bad" : "out");

export function Hud() {
  useStore((s) => s.version);
  const replay = useStore((s) => s.replay);
  const selected = useStore((s) => s.selected);
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const [pull, setPull] = useState(false);
  const [ending,setEnding]=useState(false),[endConfirm,setEndConfirm]=useState(false),[endError,setEndError]=useState("");
  const finishRun=async()=>{if(ending)return;setEnding(true);setEndError("");try{const result=await actions.run("end") as {runId:string};if(!result.runId)throw new Error("结束请求未返回运行编号");setEndConfirm(false);setState({reportRun:result.runId,view:"report"});}catch(error){setEndError((error as Error).message);}finally{setEnding(false);}};
  const s = getState();
  const run = s.fs.run;
  const t = replay ? replay.at : now;
  const tokens = latestRunTokens(s.fs);
  const done = tokens.filter((x) => x.status !== "active").length;
  const deferred = tokens.filter(x => x.status === "parked").length;
  const invalid = tokens.filter(x => x.status === "rejected" && x.data.failure).length;
  const u = s.fs.totals.usage;
  const status = run.status;
  const isIdle = status === "idle";
  const displayTok = fmt(u.input + u.output);
  const displayTime = clock(elapsed(run, t));
  const displayDone = done;
  const displayTotal = tokens.length;

  return (
    <>
      <div className="hud-wrap">
        <div className="hud">
          <div className="canvas-title"><span>工作区</span><i>/</i><b>{isIdle ? "网站入库" : run.title || "网站入库"}</b><span className="hud-badge">{status === "running" && !displayTotal ? "等待投料" : status==="running"&&displayDone===displayTotal?(deferred?"有待处理项":"本批已完成"):({ idle: "尚未运行", running: "运行中", paused: "已暂停", ended: "已结束" })[status]}</span></div>
          {!replay && (
            <div className="hud-actions">
              <button className="btn" onClick={() => setPull((p) => !p)}><PackagePlus size={15} />投料</button>
              <button className="btn btn--primary" onClick={() => void actions.run(status === "running" ? "pause" : status === "paused" ? "resume" : "start").catch(() => {})}>
                {status === "running" ? <Pause size={14} /> : <Play size={14} />}{status === "running" ? "暂停" : status === "paused" ? "继续" : "运行"}
              </button>
              {(status === "running" || status === "paused") && <button className="icon-btn hud-end" aria-label="结束本轮" data-tip="结束本轮并生成报告" onClick={() => {setEndError("");setEndConfirm(true);}}><Square size={12} /></button>}
            </div>
          )}
        </div>
        <div className="hud-sub">
          <select className="section-picker" aria-label="定位工段" defaultValue="" onChange={(e) => {
            const bay = s.defaultLayout?.bays?.find((b) => b.id === e.target.value);
            if (!bay) return;
            setState({ focus: { x: bay.x + bay.w / 2, y: bay.y + bay.h / 2, area: { w: bay.w, h: bay.h }, at: Date.now() } });
          }}>
            <option value="" disabled>定位工段</option>
            {s.defaultLayout?.bays?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button className="run-metrics num" onClick={() => setOpen((o) => !o)} data-tip="查看完整运行统计">
            <span className={`light light--${status === "running" ? "green" : status === "paused" ? "yellow" : "idle"}`} />
            <span className="hud-done">处理结束 <b>{displayDone}/{displayTotal}</b></span>{deferred>0&&<span className="has-failures">待重试 {deferred}</span>}{invalid>0&&<span className="has-failures">无效 {invalid}</span>}<span className="metric-dot">·</span><span className="hud-clock">{displayTime}</span><span className="metric-dot">·</span><span>{displayTok} tok</span><ChevronDown size={12} />
          </button>
          {selected.length > 0 && <button className="inspect-selection" onClick={() => toggleInspector(selected[0])}>查看所选</button>}
        </div>
      </div>
      {pull && <PullCard onClose={() => setPull(false)} />}
      {endConfirm && <div className="end-run-card" role="dialog" aria-label="结束本轮确认"><b>结束本轮并生成报告</b><p>未完成的任务会退回候选库，保留原因与已有证据。</p>{endError&&<p role="alert" className="end-error">{endError}</p>}<div><button className="btn btn--sm" disabled={ending} onClick={()=>setEndConfirm(false)}>取消</button><button className="btn btn--sm btn--primary" disabled={ending} onClick={()=>void finishRun()}>{ending?"正在回收任务并生成报告…":"结束并生成报告"}</button></div></div>}
      {open && <HudCard onClose={() => setOpen(false)} />}
    </>
  );
}

function Lights({ tokens }: { tokens: TokenState[] }) {
  if (tokens.length <= 40) {
    return <span className="hud-lights">{tokens.map((x) => <i key={x.id} className={`hl hl--${lightOf(x)}`} />)}</span>;
  }
  const c = { done: 0, run: 0, warn: 0, bad: 0, out: 0 };
  for (const x of tokens) c[lightOf(x) as keyof typeof c]++;
  return (
    <span className="hud-bar">
      {(Object.keys(c) as (keyof typeof c)[]).map((k) => c[k] ? <i key={k} className={`hb hl--${k}`} style={{ flex: c[k] }} /> : null)}
    </span>
  );
}

function PullCard({ onClose }: { onClose: () => void }) {
  const [count, setCount] = useState(10);
  const [cat, setCat] = useState(CATEGORIES[0]);
  const stock = useStore((s) => s.fs.nodes["candidates/pool"]?.stock ?? 0);
  return (
    <div className="hud-card pull-card">
      <div className="hud-card-title">从候选库取货 <span className="muted num">库存 {fmt(stock)}</span></div>
      <label className="field"><span>分类</span>
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">全部</option>
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select>
      </label>
      <label className="field"><span>件数</span>
        <input type="range" min={1} max={60} value={count} onChange={(e) => setCount(Number(e.target.value))} />
        <b className="num">{count}</b>
      </label>
      <div className="row-end">
        <button className="btn btn--ghost btn--sm" onClick={onClose}>取消</button>
        <button className="btn btn--primary btn--sm" onClick={async () => { const r: any = await actions.pull(count, cat || undefined); toast(`取了 ${r.pulled} 件，开始流动`); onClose(); }}>取货并开始</button>
      </div>
    </div>
  );
}

function HudCard({ onClose }: { onClose: () => void }) {
  useStore((s) => s.version);
  const s = getState();
  const rows = s.factory!.nodes.filter((n) => s.fs.nodes[n.key]?.processed || s.fs.nodes[n.key]?.active.length).map((n) => {
    const st = s.fs.nodes[n.key];
    return { n, st, med: median(st.durations), tok: st.usage.input + st.usage.output };
  });
  const maxMed = Math.max(1, ...rows.map((r) => r.med));
  const r = s.fs.resources;
  return (
    <div className="hud-card hud-detail no-canvas-wheel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="hud-card-title">本轮分工位 <button className="icon-btn" onClick={onClose}>×</button></div>
      <div className="res-row num">
        {Object.entries(r.limits).map(([k, lim]) => <span key={k} className="chip">{({ browser: "浏览器", model: "模型", cpu: "CPU", http: "HTTP" } as Record<string, string>)[k] ?? k} {r.used[k] ?? 0}/{lim}</span>)}
        {r.freeMemMB > 0 && <span className="chip">空闲内存 {(r.freeMemMB / 1024).toFixed(1)}GB</span>}
      </div>
      <table className="mini-table num">
        <thead><tr><th>工位</th><th>完成</th><th>中位耗时</th><th /><th>token</th><th>人</th></tr></thead>
        <tbody>
          {rows.map(({ n, st, med, tok }) => (
            <tr key={n.key} onClick={() => setState({ inspectors: [...getState().inspectors.filter((i) => i.pinned), { key: n.key, kind: "node", x: 0, y: 0, pinned: false }] })}>
              <td>{n.num} {n.name}</td><td>{st.processed}</td><td>{med ? secs(med) : "—"}</td>
              <td className="bar-cell"><i style={{ width: `${(med / maxMed) * 100}%` }} /></td>
              <td>{tok ? fmt(tok) : "—"}</td><td>{st.workers.length}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={6} className="muted">还没有工位处理过货</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
