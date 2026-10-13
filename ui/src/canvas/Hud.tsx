// Metrics HUD (Spec §10.2): time, tokens, cost, one light per item in this run, done/total.
// It floats on the canvas, top-left; clicking it opens the per-station breakdown.
import { useState } from "react";
import { Play, Pause, Square, PackagePlus, ChevronDown } from "lucide-react";
import { elapsed, median } from "../../../shared/project.ts";
import { getState, setState, useStore } from "../store.ts";
import { actions } from "../api.ts";
import { useNow } from "../util/useNow.ts";
import { fmt, secs } from "./Node.tsx";
import { toggleInspector } from "./Canvas.tsx";
import { toast } from "../shell/Toasts.tsx";
import { AllocationShortcut } from '../views/AllocationProposal.tsx';
import { recordedUsage, runStatus } from './status.ts';

const CATEGORIES = ["UI 组件与设计系统", "灵感与案例", "视觉素材与字体", "设计创作与原型", "前端开发与动效", "AI 设计工具", "UX 研究与学习", "协作与效率", "品牌与营销"];

export function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export function Hud() {
  useStore((s) => s.version);
  const replay = useStore((s) => s.replay);
  const selected = useStore((s) => s.selected);
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const [pull, setPull] = useState(false);
  const [ending,setEnding]=useState(false),[endConfirm,setEndConfirm]=useState(false),[endError,setEndError]=useState("");
  const finishRun=async()=>{if(ending)return;setEnding(true);setEndError("");try{const result=await actions.run("end") as {runId?:string;run?:{id:string};result?:{id:string}};const runId=result.runId??result.run?.id??result.result?.id;if(!runId)throw new Error("结束请求未返回运行编号");setEndConfirm(false);setState({reportRun:runId,view:"report"});}catch(error){setEndError((error as Error).message);}finally{setEnding(false);}};
  const s = getState();
  const run = s.fs.run;
  const t = replay ? replay.at : now;
  const progress = runStatus(s.fs, t);
  const { counts } = progress;
  const usage = recordedUsage(Object.values(s.fs.attempts).filter(attempt => attempt.startedAt >= run.startedAt));
  const status = run.status;
  const isIdle = status === "idle";
  const displayTok = usage.total === null ? '—' : fmt(usage.total);
  const displayTime = clock(elapsed(run, t));

  return (
    <>
      <div className="hud-wrap">
        <div className="hud">
          <div className="canvas-title"><span>工作区</span><i>/</i><b>{isIdle ? "网站入库" : run.title || "网站入库"}</b><span className="hud-badge" data-tip={progress.detail}>{progress.label}</span></div>
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
          <button className="run-metrics num" onClick={() => setOpen((o) => !o)} data-tip={progress.detail}>
            <span className={`light light--${progress.light}`} />
            <span className="hud-done">已发布 <b>{counts.published}/{counts.total}</b></span>{counts.active>0&&<span>在途 {counts.active}</span>}{counts.parked>0&&<span className="has-failures">待重试 {counts.parked}</span>}{counts.manual>0&&<span className="has-failures">待人工 {counts.manual}</span>}{counts.failed>0&&<span className="has-failures">失败 {counts.failed}</span>}<span className="metric-dot">·</span><span className="hud-clock">{displayTime}</span><span className="metric-dot">·</span><span data-tip={`模型用量 ${usage.reported}/${usage.samples} 次有报告，未报告的用量不视为零。`}>{usage.partial ? '已报 ' : ''}{displayTok} tok</span><ChevronDown size={12} />
          </button>
          {selected.length > 0 && <button className="inspect-selection" onClick={() => toggleInspector(selected[0])}>查看所选</button>}
          <AllocationShortcut />
        </div>
      </div>
      {pull && <PullCard onClose={() => setPull(false)} />}
      {endConfirm && <div className="end-run-card" role="dialog" aria-label="结束本轮确认"><b>结束本轮并生成报告</b><p>未完成的任务会退回候选库，保留原因与已有证据。</p>{endError&&<p role="alert" className="end-error">{endError}</p>}<div><button className="btn btn--sm" disabled={ending} onClick={()=>setEndConfirm(false)}>取消</button><button className="btn btn--sm btn--primary" disabled={ending} onClick={()=>void finishRun()}>{ending?"正在回收任务并生成报告…":"结束并生成报告"}</button></div></div>}
      {open && <HudCard onClose={() => setOpen(false)} />}
    </>
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
  const attempts = Object.values(s.fs.attempts).filter(attempt => attempt.startedAt >= s.fs.run.startedAt);
  const rows = s.factory!.nodes.map((n) => {
    const st = s.fs.nodes[n.key];
    const work = attempts.filter(attempt => attempt.node === n.key), usage = recordedUsage(work);
    return { n, st, work, med: median(st?.durations ?? []), tok: usage.total };
  }).filter(row => row.st && (row.work.length || row.st.queue.length || row.st.active.length));
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
        <thead><tr><th>工位</th><th>尝试次数</th><th>成功中位</th><th /><th>已报 token</th><th>人</th></tr></thead>
        <tbody>
          {rows.map(({ n, st, work, med, tok }) => (
            <tr key={n.key} onClick={() => setState({ inspectors: [...getState().inspectors.filter((i) => i.pinned), { key: n.key, kind: "node", x: 0, y: 0, pinned: false }] })}>
              <td>{n.num} {n.name}</td><td title={`成功返回 ${st.processed} 次 · 执行异常 ${st.failed} 次 · 取消 ${work.filter(attempt => attempt.cancelled).length} 次`}>{work.length}</td><td>{st.durations.length ? secs(med) : "—"}</td>
              <td className="bar-cell"><i style={{ width: `${(med / maxMed) * 100}%` }} /></td>
              <td>{tok === null ? '—' : fmt(tok)}</td><td>{st.workers.length}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={6} className="muted">还没有工位处理过货</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
