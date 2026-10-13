import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { Report } from "../report/Report.tsx";

interface RunRow { run:string;first:number;last:number;events:number;report:boolean }
export function Runs() {
  const current=useStore(s=>s.fs.run.id), status=useStore(s=>s.fs.run.status);
  const [rows,setRows]=useState<RunRow[]|null>(null),[selected,setSelected]=useState(''),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{let alive=true;const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);setError('');api.get<RunRow[]>('/api/runs',{signal:controller.signal}).then(r=>{if(alive){setRows(r);setSelected(old=>r.some(x=>x.run===old)?old:r.find(x=>x.run===current)?.run??r[0]?.run??'');}}).catch(reason=>{if(alive)setError(controller.signal.aborted?'读取运行记录超时，请重试。':reason.message);}).finally(()=>clearTimeout(timeout));return()=>{alive=false;controller.abort();clearTimeout(timeout);};},[current,status,retry]);
  return <div className="view runs-dashboard">
    {error && <div className="dashboard-empty" role="alert">{error} <button className="btn btn--sm" onClick={()=>setRetry(value=>value+1)}>重试</button></div>}
    {!rows ? !error&&<div className="dashboard-empty">读取运行记录…</div> : !rows.length ? <div className="dashboard-empty">还没有运行记录。投料后即可查看处理进度、Token 用量和工位详情。</div> : <>
      <div className="run-picker"><span>运行记录</span><select aria-label="选择运行轮次" value={selected} onChange={e=>setSelected(e.target.value)}>{rows.map(r=><option key={r.run} value={r.run}>{new Date(r.first).toLocaleString("zh-CN")} · {r.run===current&&status!=="ended"?"当前轮":"历史轮"} · {r.events} 个事件</option>)}</select><span>{rows.length} 轮</span></div>
      {selected&&<Report runId={selected} embedded/>}
    </>}
  </div>;
}
