import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowUpRight, Download, PlayCircle, X } from "lucide-react";
import type { RunReport } from "../../../server/report.ts";
import type { AttemptMetrics } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { getState, setState, useStore } from "../store.ts";
import { fmt, secs } from "../canvas/Node.tsx";
import { clock } from "../canvas/Hud.tsx";
import { startReplay } from "../canvas/ReplayBar.tsx";
import "./dashboard.css";

type Attempt = RunReport["attempts"][number];
const palette = ["#5798d4","#58b5a7","#aa8bd2","#d6ac63","#d77c81","#8593b1","#7fae6b","#b98a62"];
type TokenKey = keyof NonNullable<AttemptMetrics["tokens"]>;
const TOKEN_PARTS: [TokenKey, string][] = [["system","角色与规则"],["context","上下文"],["caseFile","案卷"],["input","任务输入"],["images","图片"],["toolDefs","工具定义"],["toolResults","工具结果"],["output","输出"]];
// Per-attempt breakdowns (Spec §37) come with the report when the server includes them, else from live state.
const metricsOf = (a: Attempt): AttemptMetrics | undefined => (a as Attempt & { metrics?: AttemptMetrics }).metrics ?? getState().fs.attempts[a.id]?.metrics;
const stamp = (at:number) => new Date(at).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",second:"2-digit"});

export function Report({ runId, embedded = false }: {runId?:string;embedded?:boolean}) {
  const selected = useStore(s=>s.reportRun);
  const current = useStore(s=>s.fs.run);
  useStore(s=>s.fs.run.status);
  const id = runId ?? selected;
  const [report,setReport] = useState<RunReport | null>(null), [error,setError] = useState("");
  useEffect(()=>{
    if(!id) return;
    let alive=true; setReport(null); setError("");
    const read=()=>api.get<RunReport>(`/api/report/${encodeURIComponent(id)}`).then(r=>{if(alive)setReport(r);}).catch(e=>{if(alive)setError(e.message);});
    void read(); const timer=id===current.id && current.status!=="ended" ? setInterval(read,5000):null;
    return()=>{alive=false;if(timer)clearInterval(timer);};
  },[id,current.id,current.status]);
  if(!report) return <div className="dashboard-empty">{error || "读取运行数据…"}</div>;
  return <div className={embedded?"dashboard-host":"view dashboard-host"}><Dashboard key={report.runId} report={report} embedded={embedded}/></div>;
}

function Dashboard({report:r,embedded}:{report:RunReport;embedded:boolean}) {
  const [line,setLine]=useState("all"),[metric,setMetric]=useState<"work"|"tokens">("work"),[bucket,setBucket]=useState<number|null>(null),[node,setNode]=useState<string|null>(null),[outcome,setOutcome]=useState("all"),[detail,setDetail]=useState<string|null>(null);
  const factory=useStore(s=>s.factory);
  const allNodes=r.layers.flatMap(l=>l.nodes);
  const nodes=allNodes.filter(n=>line==="all" || n.line===line);
  const keys=new Set(nodes.map(n=>n.key));
  const attempts=r.attempts.filter(a=>keys.has(a.node));
  const nBuckets=24, span=Math.max(1,r.endedAt-r.startedAt);
  const bin=(a:Attempt)=>Math.min(nBuckets-1,Math.max(0,Math.floor(((a.endedAt??r.endedAt)-r.startedAt)/span*nBuckets)));
  const series=useMemo(()=>{
    const values=Array.from({length:nBuckets},()=>({ok:0,failed:0,input:0,output:0}));
    for(const a of attempts){const b=values[bin(a)];if(a.ok===true)b.ok++;if(a.ok===false&&!a.cancelled)b.failed++;b.input+=a.input;b.output+=a.output;}
    return values;
  },[r,line]);
  const filtered=attempts.filter(a=>(!node||a.node===node)&&(bucket===null||bin(a)===bucket)&&(outcome==="all" || (outcome==="cancelled" ? a.cancelled : outcome==="failed" ? a.ok===false&&!a.cancelled : a.ok===true)));
  const totalTokens=attempts.reduce((n,a)=>n+a.input+a.output,0), totalWork=attempts.reduce((n,a)=>n+a.ms,0), totalWait=attempts.reduce((n,a)=>n+a.queuedMs,0);
  const ranks=[...nodes].filter(n=>n.tokens||n.processed||n.failed).sort((a,b)=>metric==="tokens"?b.tokens-a.tokens:b.medianMs-a.medianMs).slice(0,7);
  const maxBar=Math.max(1,...series.map(b=>metric==="work"?b.ok+b.failed:b.input+b.output));
  const totalInput=attempts.reduce((n,a)=>n+a.input,0);
  const activeNode=nodes.find(n=>n.key===node), selectedAttempt=r.attempts.find(a=>a.id===detail);
  const lines=[...new Set(allNodes.map(n=>n.line))];
  return <div className="run-dashboard">
    {!embedded&&<button className="dash-back" onClick={()=>setState({view:"runs"})}><ArrowLeft size={13}/>运行记录</button>}
    <div className="dash-head"><div><span className="dash-eyebrow">运行分析 <i className={`run-state ${r.status}`}/>{({running:"进行中",paused:"已暂停",idle:"尚未运行",ended:"已结束"})[r.status]}</span><h1>{r.title || "本轮工作"}</h1><p>{new Date(r.startedAt).toLocaleString("zh-CN")} · {r.runId}</p></div><div className="dash-actions"><button className="btn btn--sm" onClick={()=>void startReplay(r.runId)}><PlayCircle size={13}/>过程回放</button><a className="btn btn--sm" href={`/api/report/${encodeURIComponent(r.runId)}`} download={`${r.runId}.json`}><Download size={13}/>导出</a></div></div>
    <div className="dash-kpis">
      <Kpi label="本轮投料" value={fmt(r.totals.created)} sub={`发布 ${r.totals.published} · 合并 ${r.totals.merged}`}/>
      <Kpi label="净运行时长" value={clock(r.netMs)} sub="已扣除暂停时间"/>
      <Kpi label="模型用量" value={fmt(r.totals.usage.input+r.totals.usage.output)} sub={`Token · $${r.totals.usage.cost.toFixed(4)}`}/>
      <Kpi label="需要处理" value={fmt(r.totals.manual+r.totals.failed+(r.totals.parked??0))} sub={`待重试 ${r.totals.parked??0} · 待人工 ${r.totals.manual} · 失败步骤 ${r.totals.failedAttempts??0}`} warn={r.totals.manual+r.totals.failed+(r.totals.parked??0)>0}/>
    </div>
    {(r.totals.parked??0)>0&&<button className="dash-jump" onClick={()=>setState({view:"candidates"})}>查看退回候选库的任务与原因 <ArrowUpRight size={12}/></button>}
    <div className="dash-filters"><div className="dash-seg"><button className={metric==="work"?"is-on":""} onClick={()=>setMetric("work")}>处理与耗时</button><button className={metric==="tokens"?"is-on":""} onClick={()=>setMetric("tokens")}>Token 用量</button></div><select aria-label="筛选流水线" value={line} onChange={e=>{setLine(e.target.value);setNode(null);setBucket(null);}}><option value="all">全部流水线</option>{lines.map(l=><option key={l} value={l}>{factory?.lines.find(x=>x.id===l)?.name??l}</option>)}</select><span className="grow"/>{(node||bucket!==null)&&<button className="dash-clear" onClick={()=>{setNode(null);setBucket(null);setOutcome("all");}}>清除选择 <X size={11}/></button>}</div>
    <div className="dash-grid">
      <section className="dash-panel dash-trend"><div className="dash-panel-head"><h2>{metric==="work"?"处理进度":"模型用量趋势"}</h2><span>点击时段查看记录</span></div><div className="chart-legend"><i style={{background:palette[0]}}/>{metric==="work"?"成功步骤":"输入"}<i style={{background:metric==="work"?palette[4]:palette[1]}}/>{metric==="work"?"失败步骤":"输出"}<span className="grow"/><b>{metric==="work"?`${attempts.filter(a=>a.endedAt).length} 步`: `${fmt(totalTokens)} tok`}</b></div><div className="dash-bars">{series.map((b,i)=>{const a=metric==="work"?b.ok:b.input,c=metric==="work"?b.failed:b.output;return <button key={i} aria-label={`时段 ${i+1}`} className={bucket===i?"is-selected":""} title={`${stamp(r.startedAt+i*span/nBuckets)} · ${a+c}${metric==="work"?" 步":" tok"}`} onClick={()=>setBucket(bucket===i?null:i)}><span style={{height:`${(a+c)/maxBar*100}%`}}><i style={{flex:c,background:metric==="work"?palette[4]:palette[1]}}/><i style={{flex:a,background:palette[0]}}/></span></button>;})}</div><div className="dash-axis"><span>{stamp(r.startedAt)}</span><span>{stamp(r.startedAt+span/2)}</span><span>{stamp(r.endedAt)}</span></div>{!attempts.length&&<p className="dash-no-data">尚无处理记录，投料后这里会显示真实进度。</p>}</section>
      <section className="dash-panel"><div className="dash-panel-head"><h2>{metric==="work"?"执行与排队":"输入与输出"}</h2></div><Donut values={metric==="work"?[totalWork,totalWait]:[totalInput,totalTokens-totalInput]} labels={metric==="work"?["执行","排队"]:["输入","输出"]} center={metric==="work"?secs(totalWork+totalWait):fmt(totalTokens)} suffix={metric==="work"?"累计步骤时间":"Token"} format={metric==="work"?secs:fmt}/><p className="dash-footnote">{metric==="work"?"并行步骤的累计时间，与净运行时长分别统计。":"按模型返回的用量统计，不估算未知的上下文细项。"}</p></section>
      <section className="dash-panel"><div className="dash-panel-head"><h2>{metric==="work"?"工位耗时":"工位用量"}</h2><span>点击下钻</span></div><div className="dash-ranks">{ranks.map((n,i)=>{const value=metric==="work"?n.medianMs:n.tokens,max=Math.max(1,...ranks.map(x=>metric==="work"?x.medianMs:x.tokens));return <button key={n.key} className={node===n.key?"is-selected":""} onClick={()=>setNode(node===n.key?null:n.key)}><span>{n.name}</span><b>{metric==="work"?secs(value):fmt(value)}</b><i style={{width:`${value/max*100}%`,background:palette[i%palette.length]}}/></button>;})}{!ranks.length&&<p className="dash-no-data">运行后显示各工位的实测数据</p>}</div></section>
      <section className="dash-panel dash-stations"><div className="dash-panel-head"><h2>工位表现</h2><span>{nodes.length} 个参与工位</span></div><div className="dash-table-scroll"><table><thead><tr><th>工位</th><th>完成</th><th>中位</th><th>P90</th><th>排队占比</th><th>Token</th></tr></thead><tbody>{nodes.map(n=><tr key={n.key} className={node===n.key?"is-selected":""}><td><button onClick={()=>setNode(node===n.key?null:n.key)}>{n.name}<ArrowUpRight size={11}/></button></td><td>{n.processed}</td><td>{n.medianMs?secs(n.medianMs):"—"}</td><td>{n.p90Ms?secs(n.p90Ms):"—"}</td><td><span className="mini-meter"><i style={{width:`${n.waitShare*100}%`}}/></span>{Math.round(n.waitShare*100)}%</td><td>{fmt(n.tokens)}</td></tr>)}</tbody></table></div></section>
    </div>
    <Breakdown attempts={attempts.filter(a=>!node||a.node===node)} scope={activeNode?.name ?? (line==="all"?"全部工位":factory?.lines.find(x=>x.id===line)?.name ?? line)}/>
    <section className="dash-panel dash-process"><div className="dash-panel-head"><h2>{activeNode?`${activeNode.name} · 处理过程`:"处理过程"}</h2><span>{bucket!==null?`${stamp(r.startedAt+bucket*span/nBuckets)} – ${stamp(r.startedAt+(bucket+1)*span/nBuckets)}`:`${filtered.length} 条记录`}</span><select aria-label="筛选处理结果" value={outcome} onChange={e=>setOutcome(e.target.value)}><option value="all">全部结果</option><option value="ok">成功</option><option value="failed">失败</option><option value="cancelled">已取消</option></select></div>
      {activeNode&&<div className="node-summary"><span>完成 <b>{activeNode.processed}</b></span><span>退回 <b>{activeNode.returned}</b></span><span>失败 <b>{activeNode.failed}</b></span><span>模型费用 <b>${activeNode.cost.toFixed(4)}</b></span></div>}
      <div className="dash-attempts">{[...filtered].sort((a,b)=>b.startedAt-a.startedAt).slice(0,30).map(a=><button key={a.id} onClick={()=>setDetail(detail===a.id?null:a.id)} className={detail===a.id?"is-selected":""}><i className={a.cancelled?"cancelled":a.ok===false?"bad":a.ok===true?"ok":"working"}/><time>{stamp(a.startedAt)}</time><b>{a.item}</b><span>{allNodes.find(n=>n.key===a.node)?.name??a.node}</span><small>{secs(a.ms)}</small></button>)}{!filtered.length&&<p className="dash-no-data">这个范围内没有处理记录。</p>}</div>
      {selectedAttempt&&<div className="attempt-detail"><div><b>{selectedAttempt.item}</b><button aria-label="关闭处理详情" onClick={()=>setDetail(null)}><X size={13}/></button></div><p>{selectedAttempt.summary}</p>{selectedAttempt.steps.map((step,i)=><div className="attempt-step" key={i}><time>{stamp(step.at)}</time><span>{step.text}</span></div>)}<button className="dash-jump" onClick={()=>{setState({view:"canvas",inspectors:[...getState().inspectors.filter(i=>i.pinned),{key:selectedAttempt.token,kind:"token",pinned:false,x:0,y:0}]});}}>查看任务与证据 <ArrowUpRight size={12}/></button></div>}
      {filtered.length>30&&<p className="dash-footnote">当前展示最近 30 条，可选择工位或时段缩小范围。</p>}
    </section>
  </div>;
}
/** Token composition and time composition of the attempts in scope (the clicked station, or all). */
function Breakdown({attempts,scope}:{attempts:Attempt[];scope:string}) {
  const withM=attempts.map(a=>({a,m:metricsOf(a)}));
  const sum=(f:(x:typeof withM[number])=>number)=>withM.reduce((n,x)=>n+f(x),0);
  const tok=TOKEN_PARTS.map(([k,label])=>[label,sum(x=>x.m?.tokens?.[k]??0)] as [string,number]).filter(([,v])=>v>0);
  const actualIn=sum(x=>x.m?.tokens?.actualInput??0), cacheRead=sum(x=>x.m?.tokens?.cacheRead??0), actualOut=sum(x=>x.m?.tokens?.actualOutput??x.a.output);
  const t=(k:"firstTokenMs"|"outputMs"|"toolMs"|"programMs")=>sum(x=>x.m?.time?.[k]??0);
  const known=t("firstTokenMs")+t("outputMs")+t("toolMs")+t("programMs");
  const time=([["首字等待",t("firstTokenMs")],["生成输出",t("outputMs")],["工具",t("toolMs")],["程序",t("programMs")],["其他",Math.max(0,sum(x=>x.a.ms)-known)],["排队",sum(x=>x.a.queuedMs)]] as [string,number][]).filter(([,v])=>v>=500);
  const covered=withM.filter(x=>x.m?.tokens||x.m?.time).length, outMs=t("outputMs"), calls=sum(x=>x.m?.time?.modelCalls??0);
  const tokTotal=tok.reduce((n,[,v])=>n+v,0), timeTotal=time.reduce((n,[,v])=>n+v,0);
  return <div className="dash-grid dash-breakdown">
    <section className="dash-panel"><div className="dash-panel-head"><h2>Token 构成</h2><span>{scope}</span></div>
      <Donut values={tok.map(x=>x[1])} labels={tok.map(x=>x[0])} center={fmt(tokTotal)} suffix="Token" format={fmt}/>
      <p className="dash-footnote">{covered?`${covered}/${attempts.length} 步有分项，分项按字符估算。`:"运行后显示每一步的 Token 分项。"}{actualIn>0&&` 缓存命中 ${Math.round(cacheRead/actualIn*100)}%。`}</p></section>
    <section className="dash-panel"><div className="dash-panel-head"><h2>耗时构成</h2><span>{scope}</span></div>
      <Donut values={time.map(x=>x[1])} labels={time.map(x=>x[0])} center={secs(timeTotal)} suffix="累计步骤时间" format={secs}/>
      <p className="dash-footnote">{outMs>0?`输出速度 ${(actualOut/(outMs/1000)).toFixed(1)} tok/s。`:""}{calls>0&&`模型调用 ${calls} 次，工具调用 ${sum(x=>x.m?.time?.toolCalls??0)} 次。`}并行步骤按累计时间计。</p></section>
  </div>;
}

function Kpi({label,value,sub,warn=false}:{label:string;value:string;sub:string;warn?:boolean}) { return <div className={`dash-kpi ${warn?"is-warn":""}`}><span>{label}</span><b>{value}</b><small>{sub}</small></div>; }
function Donut({values,labels,center,suffix,format}:{values:number[];labels:string[];center:string;suffix:string;format:(n:number)=>string}) {
  const total=values.reduce((s,n)=>s+n,0);
  let at=0; const stops=values.map((v,i)=>{const a=at; at+=total?v/total*100:0; return `${palette[i%palette.length]} ${a}% ${at}%`;});
  return <div className="dash-donut"><div className="donut-ring" style={{background:total?`conic-gradient(${stops.join(",")})`:"#edf0f4"}}><div><b>{total?center:"—"}</b><span>{suffix}</span></div></div><div className="donut-key">{values.map((v,i)=><div key={i}><span><i style={{background:palette[i%palette.length]}}/>{labels[i]}</span><b>{format(v)}</b><small>{total?Math.round(v/total*100):0}%</small></div>)}</div></div>;
}
