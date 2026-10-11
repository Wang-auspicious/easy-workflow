import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { Report } from "../report/Report.tsx";

interface RunRow { run:string;first:number;last:number;events:number;report:boolean }
export function Runs() {
  const current=useStore(s=>s.fs.run.id), status=useStore(s=>s.fs.run.status);
  const [rows,setRows]=useState<RunRow[]|null>(null),[selected,setSelected]=useState("");
  useEffect(()=>{let alive=true;api.get<RunRow[]>("/api/runs").then(r=>{if(alive){setRows(r);setSelected(old=>r.some(x=>x.run===old)?old:r.find(x=>x.run===current)?.run??r[0]?.run??"");}}).catch(()=>{if(alive)setRows([]);});return()=>{alive=false;};},[current,status]);
  return <div className="view runs-dashboard">
    {!rows ? <div className="dashboard-empty">读取运行记录…</div> : !rows.length ? <div className="dashboard-empty">还没有运行记录。投料后即可查看处理进度、Token 用量和工位详情。</div> : <>
      <div className="run-picker"><span>运行记录</span><select aria-label="选择运行轮次" value={selected} onChange={e=>setSelected(e.target.value)}>{rows.map(r=><option key={r.run} value={r.run}>{new Date(r.first).toLocaleString("zh-CN")} · {r.run===current&&status!=="ended"?"当前轮":"历史轮"} · {r.events} 个事件</option>)}</select><span>{rows.length} 轮</span></div>
      {selected&&<Report runId={selected} embedded/>}
    </>}
  </div>;
}
