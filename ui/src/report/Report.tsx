import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Download, PlayCircle, X } from "lucide-react";
import type { RunReport } from "../../../server/report.ts";
import type { AttemptMetrics } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { getState, setState, useStore } from "../store.ts";
import { fmt, secs } from "../canvas/Node.tsx";
import { clock } from "../canvas/Hud.tsx";
import { cancelReplayLoad, startReplay } from "../canvas/ReplayBar.tsx";
import { buildTimeView, hasReportedUsage, usageSummary, type DisplayInterval, type TimeStrip } from "./activity.ts";
import { timelineDisplay } from './timeline-display.ts';
import "./dashboard.css";

type Attempt = RunReport["attempts"][number];
const palette = ["#5798d4","#58b5a7","#aa8bd2","#d6ac63","#d77c81","#8593b1","#7fae6b","#b98a62"];
type TokenKey = keyof NonNullable<AttemptMetrics["tokens"]>;
const TOKEN_PARTS: [TokenKey, string][] = [["system","角色与规则"],["context","上下文"],["caseFile","案卷"],["input","任务输入"],["images","图片"],["toolDefs","工具定义"],["toolResults","工具结果"],["output","输出"]];
// Historical reports must never borrow measurements from the current projection.
const metricsOf = (a: Attempt): AttemptMetrics | undefined => a.metrics;
const stamp = (at:number) => new Date(at).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",second:"2-digit"});

export function Report({ runId, embedded = false }: {runId?:string;embedded?:boolean}) {
  const selected = useStore(s=>s.reportRun);
  const current = useStore(s=>s.fs.run);
  useStore(s=>s.fs.run.status);
  const id = runId ?? selected;
  const [report,setReport] = useState<RunReport | null>(null), [error,setError] = useState(''), [retry,setRetry] = useState(0), [loading,setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(()=>{
    if(!id) return;
    let alive=true, timer: ReturnType<typeof setTimeout> | undefined;
    setReport(null); setError('');
    const read = async () => {
      const controller = new AbortController(); request.current = controller; setLoading(true);
      const timeout = setTimeout(() => controller.abort(new Error('读取运行数据超时；可重试或切换页面。')), 20000);
      try {
        const value = await api.get<RunReport>(`/api/report/${encodeURIComponent(id)}`, { signal: controller.signal });
        if (!alive || controller.signal.aborted) return;
        if (!value || typeof value.runId !== 'string' || !Array.isArray(value.attempts) || !Array.isArray(value.layers) || !value.totals) throw new Error('运行报告格式无效，请重试或更新服务。');
        setReport(value); setError('');
        // A new refresh begins after this one finishes. Slow reports cannot stack requests.
        if (id === current.id && current.status !== 'ended') timer = setTimeout(() => void read(), 15000);
      } catch (reason) { if (alive) setError(controller.signal.aborted ? String(controller.signal.reason?.message ?? '已取消加载。') : (reason as Error).message); }
      finally { clearTimeout(timeout); if (alive) setLoading(false); }
    };
    void read();
    return()=>{alive=false;clearTimeout(timer);request.current?.abort();};
  },[id,current.id,current.status,retry]);
  const loadingState = <div className="dashboard-empty" role={error ? 'alert' : 'status'}><span>{error || '读取运行数据…'}</span> {loading ? <button className="btn btn--sm" onClick={() => request.current?.abort(new Error('已取消加载。'))}>取消加载</button> : <button className="btn btn--sm" onClick={() => setRetry(value => value + 1)}>重新读取</button>}</div>;
  if(!report) return loadingState;
  return <div className={embedded?"dashboard-host":"view dashboard-host"}>{error && loadingState}<Dashboard key={report.runId} report={report} embedded={embedded}/></div>;
}

function Dashboard({report:r,embedded}:{report:RunReport;embedded:boolean}) {
  const [line,setLine]=useState("all"),[metric,setMetric]=useState<"work"|"tokens">("work"),[bucket,setBucket]=useState<number|null>(null),[node,setNode]=useState<string|null>(null),[outcome,setOutcome]=useState("all"),[detail,setDetail]=useState<string|null>(null);
  const factory=useStore(s=>s.factory);
  const replayLoading = useStore(s => s.replayLoading?.run === r.runId ? s.replayLoading : null);
  useEffect(() => () => cancelReplayLoad(r.runId), [r.runId]);
  const live=useStore(s=>s.fs.run.id===r.runId && ["running","paused"].includes(s.fs.run.status));
  const observedUntil=r.endedAt;
  const allNodes=r.layers.flatMap(l=>l.nodes);
  const nodes=allNodes.filter(n=>line==="all" || n.line===line);
  const keys=new Set(nodes.map(n=>n.key));
  const attempts=r.attempts.filter(a=>keys.has(a.node));
  const nBuckets=24, span=Math.max(1,r.endedAt-r.startedAt);
  const bin=(a:Attempt)=>Math.min(nBuckets-1,Math.max(0,Math.floor(((a.endedAt??a.startedAt)-r.startedAt)/span*nBuckets)));
  const series=useMemo(()=>{
    const values=Array.from({length:nBuckets},()=>({ok:0,failed:0,input:0,output:0,reported:0}));
    for(const a of attempts){const b=values[bin(a)];if(a.ok===true)b.ok++;if(a.ok===false&&!a.cancelled)b.failed++;if(hasReportedUsage(a)){b.input+=a.input;b.output+=a.output;b.reported++;}}
    return values;
  },[r,line]);
  const filtered=attempts.filter(a=>(!node||a.node===node)&&(bucket===null||bin(a)===bucket)&&(outcome==="all" || (outcome==="cancelled" ? a.cancelled : outcome==="failed" ? a.ok===false&&!a.cancelled : a.ok===true)));
  const breakdownAttempts = useMemo(() => attempts.filter(attempt => !node || attempt.node === node), [r, line, node]);
  const programNodes = useMemo(() => new Set(factory?.nodes.filter(node => node.kind === 'program').map(node => node.key)), [factory]);
  const usage=usageSummary(attempts), overallUsage=usageSummary(r.attempts);
  const nodeUsage=new Map(nodes.map(n=>[n.key,usageSummary(attempts.filter(a=>a.node===n.key))]));
  const totalTokens=usage.total, totalWork=attempts.reduce((n,a)=>n+(a.endedAt!==undefined?a.ms:live?Math.max(0,observedUntil-a.startedAt):0),0), totalWait=attempts.reduce((n,a)=>n+a.queuedMs,0);
  const ranks=[...nodes].filter(n=>n.tokens||n.processed||n.failed).sort((a,b)=>metric==="tokens"?b.tokens-a.tokens:b.medianMs-a.medianMs).slice(0,7);
  const maxBar=Math.max(1,...series.map(b=>metric==="work"?b.ok+b.failed:b.input+b.output));
  const totalInput=usage.input;
  const activeNode=nodes.find(n=>n.key===node), selectedAttempt=r.attempts.find(a=>a.id===detail);
  const lines=[...new Set(allNodes.map(n=>n.line))];
  return <div className="run-dashboard">
    {!embedded&&<button className="dash-back" onClick={()=>setState({view:"runs"})}><ArrowLeft size={13}/>运行记录</button>}
    <div className="dash-head"><div><span className="dash-eyebrow">运行分析 <i className={`run-state ${r.status}`}/>{({running:"进行中",paused:"已暂停",idle:"尚未运行",ended:"已结束"})[r.status]}</span><h1>{r.title || "本轮工作"}</h1><p>{new Date(r.startedAt).toLocaleString("zh-CN")} · {r.runId}</p></div><div className="dash-actions"><button className="btn btn--sm" disabled={Boolean(replayLoading && !replayLoading.error)} onClick={()=>void startReplay(r.runId)}><PlayCircle size={13}/>{replayLoading && !replayLoading.error ? `已读取 ${replayLoading.count} 个事件…` : replayLoading?.error ? '重试回放' : '过程回放'}</button>{replayLoading && !replayLoading.error && <button className="btn btn--sm" onClick={()=>cancelReplayLoad(r.runId)}>取消加载回放</button>}<a className="btn btn--sm" href={`/api/report/${encodeURIComponent(r.runId)}`} download={`${r.runId}.json`}><Download size={13}/>导出</a></div></div>
    {replayLoading?.error && <p className="dash-footnote" role="alert">{replayLoading.error}</p>}<div className="dash-kpis">
      <Kpi label="本轮投料" value={fmt(r.totals.created)} sub={`发布 ${r.totals.published} · 合并 ${r.totals.merged}`}/>
      <Kpi label="净运行时长" value={clock(r.netMs)} sub="已扣除暂停时间"/>
      <Kpi label="模型用量" value={overallUsage.total===null?"—":fmt(overallUsage.total)} sub={overallUsage.total===null?"尚未报告模型用量":`Token 已报小计 · ${overallUsage.reported}/${overallUsage.attempts} 步 · $${overallUsage.cost!.toFixed(4)}`}/>
      <Kpi label="需要处理" value={fmt(r.totals.manual+r.totals.failed+(r.totals.parked??0))} sub={`待重试 ${r.totals.parked??0} · 待人工 ${r.totals.manual} · 失败步骤 ${r.totals.failedAttempts??0}`} warn={r.totals.manual+r.totals.failed+(r.totals.parked??0)>0}/>
    </div>
    {(r.totals.parked??0)>0&&<button className="dash-jump" onClick={()=>setState({view:"candidates"})}>查看退回候选库的任务与原因 <ArrowUpRight size={12}/></button>}
    <div className="dash-filters"><div className="dash-seg"><button className={metric==="work"?"is-on":""} onClick={()=>setMetric("work")}>处理与耗时</button><button className={metric==="tokens"?"is-on":""} onClick={()=>setMetric("tokens")}>Token 用量</button></div><select aria-label="筛选流水线" value={line} onChange={e=>{setLine(e.target.value);setNode(null);setBucket(null);}}><option value="all">全部流水线</option>{lines.map(l=><option key={l} value={l}>{factory?.lines.find(x=>x.id===l)?.name??l}</option>)}</select><span className="grow"/>{(node||bucket!==null)&&<button className="dash-clear" onClick={()=>{setNode(null);setBucket(null);setOutcome("all");}}>清除选择 <X size={11}/></button>}</div>
    <div className="dash-grid">
      <section className="dash-panel dash-trend"><div className="dash-panel-head"><h2>{metric==="work"?"处理进度":"模型用量趋势"}</h2><span>点击时段查看记录</span></div><div className="chart-legend"><i style={{background:palette[0]}}/>{metric==="work"?"成功步骤":"输入"}<i style={{background:metric==="work"?palette[4]:palette[1]}}/>{metric==="work"?"失败步骤":"输出"}<span className="grow"/><b>{metric==="work"?`${attempts.filter(a=>a.endedAt).length} 步`: `${totalTokens===null?"—":fmt(totalTokens)} tok · 已报小计`}</b></div><div className="dash-bars">{series.map((b,i)=>{const a=metric==="work"?b.ok:b.input,c=metric==="work"?b.failed:b.output;return <button key={i} aria-label={`时段 ${i+1}`} className={bucket===i?"is-selected":""} title={`${stamp(r.startedAt+i*span/nBuckets)} · ${metric==="tokens"&&!b.reported?"未报告用量":`${a+c}${metric==="work"?" 步":" tok"}`}`} onClick={()=>setBucket(bucket===i?null:i)}><span style={{height:`${(a+c)/maxBar*100}%`}}><i style={{flex:c,background:metric==="work"?palette[4]:palette[1]}}/><i style={{flex:a,background:palette[0]}}/></span></button>;})}</div><div className="dash-axis"><span>{stamp(r.startedAt)}</span><span>{stamp(r.startedAt+span/2)}</span><span>{stamp(r.endedAt)}</span></div>{!attempts.length&&<p className="dash-no-data">尚无处理记录，投料后这里会显示真实进度。</p>}</section>
      <section className="dash-panel"><div className="dash-panel-head"><h2>{metric==="work"?"执行与排队":"输入与输出"}</h2></div><Donut values={metric==="work"?[attempts.some(a=>a.endedAt!==undefined||live)?totalWork:null,attempts.some(a=>a.endedAt!==undefined)?totalWait:null]:[totalInput,usage.output]} labels={metric==="work"?["执行","排队"]:["输入","输出"]} center={metric==="work"?secs(totalWork+totalWait):totalTokens===null?"—":fmt(totalTokens)} suffix={metric==="work"?"累计步骤时间":"Token"} format={metric==="work"?secs:fmt}/><p className="dash-footnote">{metric==="work"?"并行步骤的累计时间，与净运行时长分别统计。":`实际用量 ${usage.reported}/${attempts.length} 步已报；未报告部分保持未知，0 只用于接口实际返回的零值。`}</p></section>
      <section className="dash-panel"><div className="dash-panel-head"><h2>{metric==="work"?"工位耗时":"工位用量"}</h2><span>点击下钻</span></div><div className="dash-ranks">{ranks.map((n,i)=>{const value=metric==="work"?n.medianMs:n.tokens,max=Math.max(1,...ranks.map(x=>metric==="work"?x.medianMs:x.tokens));return <button key={n.key} className={node===n.key?"is-selected":""} onClick={()=>setNode(node===n.key?null:n.key)}><span>{n.name}</span><b>{metric==="work"?secs(value):nodeUsage.get(n.key)?.total==null?"—":fmt(value)}</b><i style={{width:`${value/max*100}%`,background:palette[i%palette.length]}}/></button>;})}{!ranks.length&&<p className="dash-no-data">运行后显示各工位的实测数据</p>}</div></section>
      <section className="dash-panel dash-stations"><div className="dash-panel-head"><h2>工位表现</h2><span>{nodes.length} 个参与工位</span></div><div className="dash-table-scroll"><table><thead><tr><th>工位</th><th>完成</th><th>中位</th><th>P90</th><th>排队占比</th><th>Token</th></tr></thead><tbody>{nodes.map(n=><tr key={n.key} className={node===n.key?"is-selected":""}><td><button onClick={()=>setNode(node===n.key?null:n.key)}>{n.name}<ArrowUpRight size={11}/></button></td><td>{n.processed}</td><td>{n.medianMs?secs(n.medianMs):"—"}</td><td>{n.p90Ms?secs(n.p90Ms):"—"}</td><td><span className="mini-meter"><i style={{width:`${n.waitShare*100}%`}}/></span>{Math.round(n.waitShare*100)}%</td><td>{nodeUsage.get(n.key)?.total==null?"—":fmt(n.tokens)}</td></tr>)}</tbody></table></div></section>
    </div>
    <Breakdown attempts={breakdownAttempts} live={live} observedUntil={observedUntil} programNodes={programNodes} scope={activeNode?.name ?? (line==="all"?"全部工位":factory?.lines.find(x=>x.id===line)?.name ?? line)}/>
    <section className="dash-panel dash-process"><div className="dash-panel-head"><h2>{activeNode?`${activeNode.name} · 处理过程`:"处理过程"}</h2><span>{bucket!==null?`${stamp(r.startedAt+bucket*span/nBuckets)} – ${stamp(r.startedAt+(bucket+1)*span/nBuckets)}`:`${filtered.length} 条记录`}</span><select aria-label="筛选处理结果" value={outcome} onChange={e=>setOutcome(e.target.value)}><option value="all">全部结果</option><option value="ok">成功</option><option value="failed">失败</option><option value="cancelled">已取消</option></select></div>
      {activeNode&&<div className="node-summary"><span>完成 <b>{activeNode.processed}</b></span><span>退回 <b>{activeNode.returned}</b></span><span>失败 <b>{activeNode.failed}</b></span><span>模型费用 <b>{nodeUsage.get(activeNode.key)?.cost==null?"—":`${nodeUsage.get(activeNode.key)!.cost!.toFixed(4)}`}</b></span></div>}
      <div className="dash-attempts">{[...filtered].sort((a,b)=>b.startedAt-a.startedAt).slice(0,30).map(a=><button key={a.id} onClick={()=>setDetail(detail===a.id?null:a.id)} className={detail===a.id?"is-selected":""}><i className={a.cancelled?"cancelled":a.ok===false?"bad":a.ok===true?"ok":"working"}/><time>{stamp(a.startedAt)}</time><b>{a.item}</b><span>{allNodes.find(n=>n.key===a.node)?.name??a.node}</span><small>{a.endedAt!==undefined?secs(a.ms):live?"进行中":"结束未知"}</small></button>)}{!filtered.length&&<p className="dash-no-data">这个范围内没有处理记录。</p>}</div>
      {selectedAttempt&&<div className="attempt-detail"><div><b>{selectedAttempt.item}</b><button aria-label="关闭处理详情" onClick={()=>setDetail(null)}><X size={13}/></button></div><p>{selectedAttempt.summary}</p>{selectedAttempt.steps.map((step,i)=><div className="attempt-step" key={i}><time>{stamp(step.at)}</time><span>{step.text}</span></div>)}<button className="dash-jump" onClick={()=>{setState({view:"canvas",inspectors:[...getState().inspectors.filter(i=>i.pinned),{key:selectedAttempt.token,kind:"token",pinned:false,x:0,y:0}]});}}>查看任务与证据 <ArrowUpRight size={12}/></button></div>}
      {filtered.length>30&&<p className="dash-footnote">当前展示最近 30 条，可选择工位或时段缩小范围。</p>}
    </section>
  </div>;
}
/** Token composition and time composition of the attempts in scope (the clicked station, or all):
 *  a ring, a legend with share · amount · count, and an activity strip along the run's timeline. */
interface Cat { key: string; label: string; color: string; value: number; sub: string }
interface Span { from: number; to: number; w: Record<string, number> }
const TIME_COLORS: Record<string, string> = { first: "#f2a33a", output: "#9b6cf0", tool: "#1fb5a3", program: "#5798d4", other: "#98a2b3", queue: "#e4798a", unknown: "#c7cdd5" };
const TIME_LABELS: Record<string, string> = { first: "首字等待", output: "生成输出", tool: "工具执行", program: "程序工位", other: "其他开销", queue: "排队", unknown: "未记录活动" };
const TOKEN_COLORS = ["#5798d4","#1fb5a3","#9b6cf0","#f2a33a","#e4798a","#98a2b3","#7fae6b","#b98a62"];
const dur = (ms: number) => { const s = Math.round(ms / 1000); if (s < 60) return ms < 1000 ? `${Math.round(ms)}ms` : `${s}s`; const m = Math.floor(s / 60); return m < 60 ? `${m}m${s % 60}s` : `${Math.floor(m / 60)}h${m % 60}m`; };
const pct = (v: number, total: number) => { const x = total ? v / total * 100 : 0; return x > 0 && x < 0.1 ? "<0.1%" : `${x.toFixed(1)}%`; };

function Breakdown({attempts,scope,live,observedUntil,programNodes}:{attempts:Attempt[];scope:string;live:boolean;observedUntil:number;programNodes:Set<string>}) {
  const withM=attempts.map(a=>({a,m:metricsOf(a)}));
  const sum=(f:(x:typeof withM[number])=>number)=>withM.reduce((n,x)=>n+f(x),0);
  const count=(f:(x:typeof withM[number])=>boolean)=>withM.filter(f).length;
  const timeView=useMemo(()=>buildTimeView(attempts,{live,observedUntil,programNodes}),[attempts,live,observedUntil,programNodes]), usage=usageSummary(attempts);
  const time:Cat[]=Object.entries(timeView.totals).map(([key,value])=>({key,value,label:`${TIME_LABELS[key]}${timeView.estimated.has(key as keyof typeof timeView.totals)?" ≈":""}`,color:TIME_COLORS[key],sub:dur(value)})).filter(c=>c.value>0);
  const tokenValue=(x:typeof withM[number],k:TokenKey)=>k==="output"?(hasReportedUsage(x.a)?x.a.output:0):x.m?.tokens?.[k]??0;
  const tok:Cat[]=TOKEN_PARTS.map(([k,label],i)=>{const v=sum(x=>tokenValue(x,k));return {key:k,label:`${label}${k==="output"?"（实报）":" ≈"}`,color:TOKEN_COLORS[i],value:v,sub:`${fmt(v)} · ${count(x=>tokenValue(x,k)>0)} 步`};}).filter(c=>c.value>0);
  const tokSpans:Span[]=withM.flatMap(x=>{const end=x.a.endedAt??(live?observedUntil:undefined);return x.m?.tokens&&end!==undefined?[{from:x.a.startedAt,to:end,w:Object.fromEntries(TOKEN_PARTS.map(([k])=>[k,tokenValue(x,k)]))}]:[];});
  const covered=count(x=>Boolean(x.m?.tokens)), c=timeView.coverage;
  return <div className="dash-grid dash-breakdown">
    <Composition title="耗时构成" scope={scope} cats={time} center={dur(time.reduce((n,c)=>n+c.value,0))} suffix="累计步骤时间" spans={[]} timeline={timeView.strip}
      note={`${c.observed}/${c.attempts} 步有真实区间。${c.estimated?`${c.estimated} 步旧记录为比例估算。`:""}${c.running?`${c.running} 步进行中，仅显示截至本次快照。`:""}${c.unknownEnd?`${c.unknownEnd} 步结束未知，不补历史终点。`:""}未记录的模型阶段保持未知；并行工具取并集，不重复计时；重叠工位用多色显示，悬停查看起止。${usage.outputPerSecond===null?"输出速度未知。":`完整用量样本输出速度 ${usage.outputPerSecond.toFixed(1)} tok/s。`}`}/>
    <Composition title="Token 构成" scope={scope} cats={tok} center={fmt(tok.reduce((n,c)=>n+c.value,0))} suffix="Token" spans={tokSpans} keyOf={(k)=>tok.find(c=>c.key===k)?.color}
      note={`${covered}/${attempts.length} 步有分项；≈ 按字符估算，输出取已报小计。Token 色带始终为比例估算，不代表实际生成时刻。${usage.reported}/${attempts.length} 步报告实际用量，${usage.complete} 步完整。${usage.cacheHitRate===null?"缓存命中率未知。":`已报完整样本缓存命中 ${(usage.cacheHitRate*100).toFixed(1)}%（缓存读 / 输入与缓存读写总量）。`}`}/>
  </div>;
}

function Composition({title,scope,cats,center,suffix,spans,note,keyOf,timeline}:{title:string;scope:string;cats:Cat[];center:string;suffix:string;spans:Span[];note:string;keyOf?:(k:string)=>string|undefined;timeline?:TimeStrip|null}) {
  const total=cats.reduce((n,c)=>n+c.value,0);
  let at=0; const stops=cats.map(c=>{const a=at; at+=total?c.value/total*100:0; return `${c.color} ${a}% ${at}%`;});
  const strip=timeline===undefined?activityStrip(spans):null;
  const displayed = useMemo(() => timeline ? timelineDisplay(timeline) : [], [timeline]);
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }), []);
  const color=(k:string)=>keyOf?.(k)??cats.find(c=>c.key===k)?.color??TIME_COLORS[k]??"#ccc";
  const label=(k:string)=>cats.find(c=>c.key===k)?.label??TIME_LABELS[k]??k;
  const timestamp=(at:number)=>dateFormatter.format(at);
  const intervalTitle=(s:DisplayInterval)=>`${s.attempt} · ${TIME_LABELS[s.key]}${s.label?` · ${s.label}`:""} · ${timestamp(s.from)} → ${s.to!==undefined?timestamp(s.to):s.state==="running"?`进行中（显示截至 ${timestamp(s.through!)}）`:"结束未知"}${s.quality==="estimated"?" · 比例估算，阶段位置未知":s.quality==="unknown"?" · 活动类型未知":s.state==="ended"?" · 实测起止":" · 已记录开始"}`;
  const overlapColor=(keys:string[])=>keys.length<2?(keys[0]?color(keys[0]):"transparent"):`linear-gradient(to bottom,${keys.map((k,i)=>`${color(k)} ${i/keys.length*100}% ${(i+1)/keys.length*100}%`).join(",")})`;
  return <section className="dash-panel"><div className="dash-panel-head"><h2>{title}</h2><span>{scope}</span></div>
    <div className="bk-top">
      <div className="donut-ring" style={{background:total?`conic-gradient(${stops.join(",")})`:"#edf0f4"}}><div><b>{total?center:"—"}</b><span>{suffix}</span></div></div>
      <div className="bk-key">{cats.map(c=><div key={c.key}><i style={{background:c.color}}/><b>{c.label}</b><em>{pct(c.value,total)}</em><small>{c.sub}</small></div>)}{!cats.length&&<p className="dash-no-data">没有已记录的分项数据</p>}</div>
    </div>
    {timeline&&<div className="bk-strip-wrap"><div className="bk-strip">{displayed.map((g,i)=><i key={i} style={{left:`${(g.from-timeline.start)/Math.max(1,timeline.end-timeline.start)*100}%`,width:`${(g.to-g.from)/Math.max(1,timeline.end-timeline.start)*100}%`,background:overlapColor(g.keys)}} onPointerEnter={event => { event.currentTarget.title = `${g.aggregated ? `显示范围 ${timestamp(g.from)} – ${timestamp(g.to)} · ${g.intervalCount} 个活动区间（按像素合并；总量仍精确）\n` : ''}${g.intervals.slice(0,6).map(intervalTitle).join('\n') || '没有工位活动记录'}${g.intervalCount > 6 ? '\n更多区间请按工位缩小范围。' : ''}`; }}/>) }{timeline.markers.slice(0,480).map(g=><i key={g.id} style={{left:`min(calc(100% - 2px), ${(g.from-timeline.start)/Math.max(1,timeline.end-timeline.start)*100}%)`,width:2,background:color(g.key)}} onPointerEnter={event => { event.currentTarget.title = intervalTitle(g); }}/>)}</div><div className="bk-axis">{[0,0.25,0.5,0.75,1].map(f=><span key={f}>{f?dur(f*(timeline.end-timeline.start)):"0"}</span>)}</div>{displayed.some(segment => segment.aggregated) && <small className="dash-footnote">时间带按显示像素合并区间；精确起止保留在任务记录中。</small>}{timeline.markers.length > 480 && <small className="dash-footnote">未闭合活动标记较多，显示前 480 个；选择工位可缩小范围。</small>}</div>}
    {strip&&<div className="bk-strip-wrap"><div className="bk-strip">{strip.segs.map((g,i)=><i key={i} style={{left:`${g.from/strip.n*100}%`,width:`${(g.to-g.from)/strip.n*100}%`,background:g.k?color(g.k):"transparent"}} title={`比例估算 · ${dur(g.from*strip.dt)} – ${dur(g.to*strip.dt)}${g.k?` · ${label(g.k)}`:" · 没有分项记录"}`}/>)}</div>
      <div className="bk-axis">{[0,0.25,0.5,0.75,1].map(f=><span key={f}>{f?dur(f*strip.span):"0"}</span>)}</div></div>}
    <p className="dash-footnote">{note}</p>
  </section>;
}

/** Lay every span's mix over its real start–end, slice the run into equal cells and colour each
 *  cell by the activity with the most time (or tokens) in it; neighbouring equal cells merge. */
function activityStrip(spans:Span[], n=200) {
  const live=spans.filter(s=>s.to>s.from);
  if(!live.length) return null;
  const t0=Math.min(...live.map(s=>s.from)), t1=Math.max(...live.map(s=>s.to)), dt=(t1-t0)/n;
  const cells=Array.from({length:n},()=>({} as Record<string,number>));
  for(const s of live){
    const tot=Object.values(s.w).reduce((x,y)=>x+y,0); if(!tot) continue;
    const len=s.to-s.from;
    for(let i=Math.max(0,Math.floor((s.from-t0)/dt));i<=Math.min(n-1,Math.floor((s.to-t0)/dt));i++){
      const ov=Math.min(s.to,t0+(i+1)*dt)-Math.max(s.from,t0+i*dt); if(ov<=0) continue;
      for(const [k,v] of Object.entries(s.w)) if(v>0) cells[i][k]=(cells[i][k]??0)+v/tot*ov/len*tot;
    }
  }
  const segs:{k:string;from:number;to:number}[]=[];
  cells.forEach((c,i)=>{const k=Object.entries(c).sort((a,b)=>b[1]-a[1])[0]?.[0]??"";const last=segs[segs.length-1];if(last&&last.k===k)last.to=i+1;else segs.push({k,from:i,to:i+1});});
  return {segs,n,dt,span:t1-t0};
}

function Kpi({label,value,sub,warn=false}:{label:string;value:string;sub:string;warn?:boolean}) { return <div className={`dash-kpi ${warn?"is-warn":""}`}><span>{label}</span><b>{value}</b><small>{sub}</small></div>; }
function Donut({values,labels,center,suffix,format}:{values:(number|null)[];labels:string[];center:string;suffix:string;format:(n:number)=>string}) {
  const total=values.reduce<number>((s,n)=>s+(n??0),0), known=values.some(value=>value!==null);
  let at=0; const stops=values.map((v,i)=>{const a=at; at+=total?(v??0)/total*100:0; return `${palette[i%palette.length]} ${a}% ${at}%`;});
  return <div className="dash-donut"><div className="donut-ring" style={{background:total?`conic-gradient(${stops.join(",")})`:"#edf0f4"}}><div><b>{known?center:"—"}</b><span>{suffix}</span></div></div><div className="donut-key">{values.map((v,i)=><div key={i}><span><i style={{background:palette[i%palette.length]}}/>{labels[i]}</span><b>{v===null?"—":format(v)}</b><small>{v===null?"未知":total?`${Math.round(v/total*100)}%`:"—"}</small></div>)}</div></div>;
}
