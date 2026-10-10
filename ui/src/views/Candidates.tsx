import { useState } from "react";
import { RotateCw, Globe } from "lucide-react";
import { failureLabels } from "../../../shared/failures.ts";
import { api, actions } from "../api.ts";
import { getState, setState, useStore } from "../store.ts";
import "./recovery.css";

export function Candidates(){
  useStore(s=>s.version);const records=Object.values(getState().fs.recoveries);
  const [tag,setTag]=useState(""),[disposition,setDisposition]=useState("retry"),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  const rows=records.filter(c=>c.disposition===disposition&&(!tag||c.failure?.tag===tag)).sort((a,b)=>b.at-a.at);
  const tags=[...new Set(records.map(c=>c.failure?.tag).filter(Boolean))];
  const retry=async()=>{setBusy(true);setMessage("");try{const result=await api.post<{result:{count:number}}>("/api/tools/retry_candidates",{count:Math.min(200,rows.length),...(tag?{tag}:{}),...(selected.length?{items:selected}:{items:rows.slice(0,200).map(c=>c.item)})});setMessage(`已取出 ${result.result.count} 件开始重试`);setSelected([]);}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}};
  return <div className="view candidate-recovery"><div className="view-inner wide"><div className="view-head"><div><h1 className="view-title">候选恢复</h1><div className="view-sub">网络、登录和工具异常保留原条目与失败标签。修复原因后，可按标签一次性重试。</div></div><button className="btn btn--primary" disabled={busy||disposition!=="retry"||!rows.length} onClick={()=>void retry()}><RotateCw size={14}/>{busy?"正在取出…":selected.length?`重试已选 ${selected.length} 件`:`重试当前筛选 ${Math.min(200,rows.length)} 件`}</button></div>
    <div className="recovery-filters"><div className="seg">{[["retry","待重试"],["removed","已移出"],["claimed","重试中"],["resolved","已处理"]].map(([value,label])=><button key={value} className={value===disposition?"is-on":""} onClick={()=>{setDisposition(value);setSelected([]);}}>{label} {records.filter(c=>c.disposition===value).length}</button>)}</div><select aria-label="失败原因标签" value={tag} onChange={e=>{setTag(e.target.value);setSelected([]);}}><option value="">全部原因</option>{tags.map(t=><option key={t} value={t}>{failureLabels[t!]??t}</option>)}</select></div>
    {message&&<p role="status" className="recovery-message">{message}</p>}
    {disposition==="removed"&&<p className="recovery-message">已确认网址格式无效或返回 404 / 410，不再进入候选投料。这里保留处置记录。</p>}
    <div className="recovery-list">{rows.map(c=><div key={c.item} className="recovery-row"><input aria-label={`选择 ${c.title}`} type="checkbox" disabled={disposition!=="retry"} checked={selected.includes(c.item)} onChange={e=>setSelected(e.target.checked?[...selected,c.item]:selected.filter(id=>id!==c.item))}/><div><b>{c.title}</b><a href={c.url} onClick={e=>{e.preventDefault();void actions.browser({action:"open",url:c.url}).then(()=>setState({view:"browser"})).catch(()=>{});}}>{c.url}<Globe size={11}/></a><p>{c.failure?.message}</p></div><aside><span className={`failure-tag category-${c.failure?.category}`}>{c.failure?failureLabels[c.failure.tag]:"待检查"}</span><small>{new Date(c.at).toLocaleString("zh-CN")} · {c.attempts} 次记录</small></aside></div>)}{!rows.length&&<div className="empty-card">当前没有这一类候选。</div>}</div>
  </div></div>;
}
