// Inspector cards (Spec §10.6, §10.10). A station card opens next to its node and shows the
// workers and, for the chosen worker, its work as a narrated trace — like a Claude Code
// sub-agent view: input, thoughts, folded tool steps with their evidence, current activity.
// A token card shows that item's evidence chain from URL to publication.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { previewSet, useHoverPreview } from "../shell/HoverPreview.tsx";
import { Pin, PinOff, X, GitFork, UserMinus, Lock, Unlock, MessageSquarePlus, ChevronRight, CircleMinus, Check, AlertTriangle, Loader2, ExternalLink, Play, Pause } from "lucide-react";
import type { CompiledNode, EvidenceRef } from "../../../shared/types.ts";
import { median, quantile, type AttemptState, type TokenState } from "../../../shared/project.ts";
import { roleColors } from "../../../shared/palette.ts";
import { attach, getState, setState, useStore, type Inspector } from "../store.ts";
import { actions, api, boot } from "../api.ts";
import { workflowCall } from '../views/workflows.ts';
import '../views/workflows.css';
import { StationIcon } from "./StationIcon.tsx";
import { fmt, secs } from "./Node.tsx";
import { openCorrection } from "../board/Correction.tsx";
import { CorrectionUndo } from '../board/CorrectionUndo.tsx';
import type { Geometry } from "./geometry.ts";
import type { Camera } from "./Canvas.tsx";
import { toggleInspector } from "./Canvas.tsx";
import { useNow } from "../util/useNow.ts";
import { toast } from "../shell/Toasts.tsx";
import { inspectPart, partTone } from "../../../shared/parts.ts";
import { CrewStrip, CrewTimeline, WorkerTrace } from "./CrewTrace.tsx";

export function Inspectors({ geo, cam }: { geo: Geometry; cam: Camera }) {
  const list = useStore((s) => s.inspectors);
  return <>{list.map((i, idx) => <Card key={i.key} insp={i} idx={idx} geo={geo} cam={cam} />)}</>;
}

function Card({ insp, idx, geo, cam }: { insp: Inspector; idx: number; geo: Geometry; cam: Camera }) {
  const ref = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0, cardHeight: 0 });
  useLayoutEffect(() => {
    const element = ref.current, parent = element?.parentElement;
    if (!element || !parent) return;
    const measure = () => {
      const next = { width: parent.clientWidth, height: parent.clientHeight, cardHeight: element.offsetHeight };
      setBounds((old) => old.width === next.width && old.height === next.height && old.cardHeight === next.cardHeight ? old : next);
    };
    const observer = new ResizeObserver(measure); observer.observe(parent); observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  const anchorKey = insp.kind === "node" ? insp.key : (getState().fs.tokens[insp.key]?.at[0] ?? getState().fs.tokens[insp.key]?.finishedAtNode ?? "");
  const p = insp.kind === "part" ? geo.bays.find((b) => b.id === insp.key) : geo.place[anchorKey];
  let left = cam.x + insp.x * cam.k, top = cam.y + insp.y * cam.k;
  if (!insp.pinned) {
    if (p) { left = cam.x + (p.x + p.w) * cam.k + 16; top = cam.y + p.y * cam.k - 24; }
    else { left = 120 + idx * 30; top = 90 + idx * 30; }
    const parent = bounds.width ? bounds : undefined;
    const w = insp.kind === "node" ? 440 : 520;
    if (parent) {
      if (left + w > parent.width - 12 && p) left = Math.max(12, cam.x + p.x * cam.k - w - 16);
      left = Math.max(12, Math.min(parent.width - w - 12, left));
      top = Math.max(104, Math.min(parent.height - bounds.cardHeight - 16, top));
    }
  }
  const update = (patch: Partial<Inspector>) => setState({ inspectors: getState().inspectors.map((x) => (x.key === insp.key ? { ...x, ...patch } : x)) });
  const close = () => setState({ inspectors: getState().inspectors.filter((x) => x.key !== insp.key) });
  const startDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.stopPropagation();
    const r = ref.current!.getBoundingClientRect(), pr = ref.current!.parentElement!.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    const move = (ev: PointerEvent) => update({ pinned: true, pinScale: insp.pinned ? insp.pinScale : cam.k, x: (ev.clientX - pr.left - ox - cam.x) / cam.k, y: (ev.clientY - pr.top - oy - cam.y) / cam.k });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const pin = () => update({ pinned: !insp.pinned, pinScale: cam.k, x: (left - cam.x) / cam.k, y: (top - cam.y) / cam.k });
  return (
    <div ref={ref} data-inspector={insp.key} className={`inspector inspector--${insp.kind} ${insp.pinned ? "is-pinned" : ""}`} style={{ left, top, transform: insp.pinned ? `scale(${cam.k / (insp.pinScale ?? 1)})` : undefined, transformOrigin: "0 0" }} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {insp.kind === "node"
        ? <NodeInspector insp={insp} onDrag={startDrag} onClose={close} onPin={pin} onWorker={(w) => update({ worker: w })} />
        : insp.kind === "part" ? <PartInspector insp={insp} geo={geo} onDrag={startDrag} onClose={close} onPin={pin} />
        : <TokenInspector insp={insp} onDrag={startDrag} onClose={close} onPin={pin} />}
    </div>
  );
}

function Head({ onDrag, onClose, onPin, pinned, children }: { onDrag: (e: React.PointerEvent) => void; onClose: () => void; onPin: () => void; pinned: boolean; children: React.ReactNode }) {
  return (
    <div className="insp-head" onPointerDown={onDrag}>
      {children}
      <span className="grow" />
      <button className="icon-btn" onClick={onPin} aria-label={pinned ? "取消钉住" : "钉在画布上"} data-tip={pinned ? "取消钉住（回到节点旁）" : "钉在画布上，随缩放和平移移动"}>{pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>
      <button className="icon-btn" onClick={onClose} data-tip="关闭  Esc"><X size={15} /></button>
    </div>
  );
}

/* ------------------------------------------------------------------ station */

function NodeInspector({ insp, onDrag, onClose, onPin, onWorker }: { insp: Inspector; onDrag: (e: React.PointerEvent) => void; onClose: () => void; onPin: () => void; onWorker: (w: string) => void }) {
  useStore((s) => s.nodeRev[insp.key]);
  const now = useNow(1000);
  const [tab, setTab] = useState<"work" | "metrics" | "spec">("work");
  const [attemptSel, setAttemptSel] = useState<string | null>(null);
  const [scopeBusy, setScopeBusy] = useState(false);
  const stationPaused = useStore(s => s.fs.pausedScopes?.stations.includes(insp.key) ?? false);
  const s = getState();
  const node = s.factory!.nodes.find((n) => n.key === insp.key) as CompiledNode;
  const n = s.fs.nodes[insp.key];
  const c = roleColors(node.role);
  // 含已撤下的人：撤下的人不在 n.workers 里了，但卡片要能看到"减员"这件事。
  const workers = Object.values(s.fs.workers).filter((w) => w.node === insp.key).sort((a, b) => a.spawnedAt - b.spawnedAt);
  const onDuty = n?.workers?.length ?? 0;
  const attempts = Object.values(s.fs.attempts).filter((a) => a.node === insp.key);
  const recent = attempts.slice(-10).reverse();
  const worker = workers.find((w) => w.id === insp.worker) ?? workers.find((w) => w.busy) ?? workers[0];
  const current = attemptSel ? s.fs.attempts[attemptSel] : worker ? (worker.busy ? s.fs.attempts[worker.busy] : [...attempts].reverse().find((a) => a.worker === worker.id)) : recent[0];
  const durations = n?.durations ?? [];
  const locked = useStore((s) => s.fs.lockedStations.includes(insp.key));
  const lineWired = s.factory!.lines.find((l) => l.id === node.line)?.wired;
  const linePaused = s.fs.pausedScopes?.lines.includes(node.line) ?? false;
  const togglePause = async () => {
    setScopeBusy(true);
    try { await workflowCall('run_control', { action: stationPaused ? 'resume' : 'pause', station: node.key, reason: '用户在工位详情调整领取状态' }); await boot(); }
    catch { /* The API reports the failure without changing the displayed scope. */ } finally { setScopeBusy(false); }
  };
  return (
    <>
      <Head onDrag={onDrag} onClose={onClose} onPin={onPin} pinned={insp.pinned}>
        <StationIcon role={node.role} size={21} />
        <div className="insp-title">
          <b>{node.num} {node.name}</b>
          <span className="muted">{({ agent: "agent 工位", program: "程序工位", review: "审查员", gate: "闸门", source: "来源", store: "库" } as Record<string, string>)[node.kind]} · {node.resource === "none" ? "无资源" : node.resource}</span>
        </div>
      </Head>
      <div className="insp-stats num">
        <Stat k="在岗" v={`${onDuty}${workers.length > onDuty ? ` / ${workers.length}` : ""}`} />
        <Stat k="队列" v={`${n?.queue.length ?? 0}`} />
        <Stat k="中位" v={durations.length ? secs(median(durations)) : "—"} />
        <Stat k="P90" v={durations.length ? secs(quantile(durations, 0.9)) : "—"} />
        <Stat k="节拍" v={durations.length ? secs(median(durations) / Math.max(1, workers.length)) : "—"} />
        <Stat k="token" v={fmt((n?.usage.input ?? 0) + (n?.usage.output ?? 0))} />
      </div>
      {s.fs.resources.waiting?.[node.key] && <div className="insp-wait"><Loader2 size={12} className="spin-i" /> 等待：{s.fs.resources.waiting[node.key]}</div>}
      {(stationPaused || linePaused) && <div className="scope-notice">{stationPaused ? '此工位已暂停领取新任务。' : '所属流水线已暂停领取新任务。'}已开始的处理继续，其他工位保持原状态。</div>}
      <div className="insp-actions">
        {node.kind !== "store" && node.kind !== "source" && <>
          <button className="btn btn--sm" disabled={scopeBusy || Boolean(s.replay) || !s.connected || !lineWired} onClick={() => void togglePause()}>{scopeBusy ? <Loader2 size={12} className="spin-i" /> : stationPaused ? <Play size={12} /> : <Pause size={12} />}{stationPaused ? '恢复此工位' : '暂停此工位'}</button>
          <button className="btn btn--sm" onClick={() => actions.workers(node.key, "fork").then((r: any) => !r.ok && toast("没有 fork：已到人数上限"))} data-tip={`上限 ${node.workers.max}`}><GitFork size={13} />加一个人</button>
          <button className="btn btn--sm" onClick={() => actions.workers(node.key, "retire").then((r: any) => !r.ok && toast("没有撤：已到下限或都在忙"))}><UserMinus size={13} />撤一个</button>
          <button className="btn btn--sm btn--ghost" onClick={() => void actions.workers(node.key, locked ? "unlock" : "lock").then(() => toast(locked ? "已解锁人数：恢复自动伸缩" : "已锁定人数：不再自动伸缩")).catch(() => {})}>{locked ? <Unlock size={13} /> : <Lock size={13} />}{locked ? "解锁人数" : "锁定人数"}</button>
        </>}
        <span className="grow" />
        <button className="btn btn--sm btn--ghost" onClick={() => attach({ type: "node", id: node.key, label: node.name })} data-tip="把这个工位加到对话附件"><MessageSquarePlus size={13} />问主调度</button>
      </div>
      <div className="insp-tabs">
        <button className={tab === "work" ? "is-on" : ""} onClick={() => setTab("work")}>工作过程</button>
        <button className={tab === "metrics" ? "is-on" : ""} onClick={() => setTab("metrics")}>统计</button>
        <button className={tab === "spec" ? "is-on" : ""} onClick={() => setTab("spec")}>规格</button>
      </div>
      {tab === "spec" ? <SpecView node={node} /> : tab === "metrics" ? <NodeMetrics attempts={attempts.filter(a=>a.startedAt>=s.fs.run.startedAt)} onSelect={id=>{setAttemptSel(id);setTab("work");}}/> : (
        <div className="insp-body">
          {workers.length > 0 && (
            <CrewStrip node={node} workers={workers} attempts={attempts} current={worker?.id}
              onPick={(id) => { setAttemptSel(null); onWorker(id); }} />
          )}
          {current ? <WorkerTrace a={current} node={node} now={now} /> : (
            node.kind === "store" ? <div className="insp-empty">库存 {fmt(n?.stock ?? 0)}。这是一个存储库，不运行执行器。</div> :
            node.dormant ? <div className="insp-empty">休眠：不占任何资源，不发任何请求。需要时让主调度激活。</div> : (
              <div className="insp-empty">{lineWired ? "尚无处理记录。任务经过这个工位后，会在这里显示真实步骤与证据。" : "这条线尚未接入执行器，暂时不会处理任务。"}</div>
            )
          )}
          <CrewTimeline notes={s.fs.activity.filter((m) => m.node === insp.key)} workers={workers} now={now} />
          {recent.length > 0 && (
            <div className="recent">
              <div className="sec-title">最近处理</div>
              {recent.map((a) => (
                <button key={a.id} className={`recent-row ${current?.id === a.id ? "is-on" : ""}`} onClick={() => setAttemptSel(a.id)}>
                  {a.endedAt === undefined ? <Loader2 size={12} className="spin-i" /> : a.cancelled ? <CircleMinus size={12} className="muted" /> : a.ok ? <Check size={12} className="ok-c" /> : <AlertTriangle size={12} className="bad-c" />}
                  <span className="r-item">{s.fs.tokens[a.token]?.item}</span>
                  <span className="r-sum muted">{a.summary ?? a.input}</span>
                  <span className="num muted">{a.ms !== undefined ? secs(a.ms) : secs(now - a.startedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

const Stat = ({ k, v }: { k: string; v: string }) => <div className="stat"><span>{k}</span><b>{v}</b></div>;

function NodeMetrics({attempts,onSelect}:{attempts:AttemptState[];onSelect:(id:string)=>void}) {
  const done=attempts.filter(a=>a.endedAt),work=done.reduce((n,a)=>n+(a.ms??0),0),wait=done.reduce((n,a)=>n+(a.queuedMs??0),0),input=done.reduce((n,a)=>n+a.usage.input,0),output=done.reduce((n,a)=>n+a.usage.output,0),recent=done.slice(-20),max=Math.max(1,...recent.map(a=>a.ms??0));
  return <div className="insp-body node-metrics"><div className="node-metrics-row"><span>执行 <b>{secs(work)}</b></span><span>排队 <b>{secs(wait)}</b></span><span>失败 <b>{done.filter(a=>!a.ok&&!a.cancelled).length}</b></span></div><div className="node-time-share"><i style={{width:`${work/Math.max(1,work+wait)*100}%`}}/></div><div className="node-metrics-row"><span>输入 <b>{fmt(input)} tok</b></span><span>输出 <b>{fmt(output)} tok</b></span></div><div className="node-duration-chart">{recent.map(a=><button key={a.id} title={`${a.summary || a.input} · ${secs(a.ms??0)}`} onClick={()=>onSelect(a.id)}><i className={a.ok?"":"is-failed"} style={{height:`${(a.ms??0)/max*100}%`}}/></button>)}</div><div className="node-metrics-caption">{done.length?"最近 20 次处理耗时 · 点击查看对应过程":"本轮尚无处理记录"}</div></div>;
}

function PartInspector({ insp, geo, onDrag, onClose, onPin }: { insp: Inspector; geo: Geometry; onDrag: (e: React.PointerEvent) => void; onClose: () => void; onPin: () => void }) {
  useStore((s) => s.version);
  const [tab, setTab] = useState<"stations" | "process">("stations");
  const [attempt, setAttempt] = useState<string | null>(null);
  const now = useNow(1000), s = getState();
  const part = geo.bays.find((b) => b.id === insp.key);
  if (!part) return null;
  const result = inspectPart(s.factory!, s.fs, part), total = result.totals;
  const name = part.name === part.line ? s.factory!.lines.find((l) => l.id === part.line)?.name ?? part.name : part.name;
  const current = result.recent.find((a) => a.id === attempt);
  const node = current && s.factory!.nodes.find((n) => n.key === current.node);
  return <>
    <Head onDrag={onDrag} onClose={onClose} onPin={onPin} pinned={insp.pinned}><StationIcon role="sort" /><div className="insp-title"><b>{name}</b><span className="muted">{total.stations} 个工位 · {result.wired ? "已接入" : "待接入"}</span></div></Head>
    <div className="insp-stats num"><Stat k="在途任务" v={fmt(total.inFlight)} /><Stat k="队列" v={fmt(total.queued)} /><Stat k="工人" v={fmt(total.workers)} /><Stat k="处理步骤" v={fmt(total.processedSteps)} /><Stat k="失败步骤" v={fmt(total.failedSteps)} /><Stat k="token" v={fmt(total.tokens)} /></div>
    <div className="insp-actions"><button className="btn btn--sm" onClick={() => setState({ focus: { x: part.x + part.w / 2, y: part.y + part.h / 2, area: { w: part.w, h: part.h }, at: Date.now() } })}>聚焦这部分</button></div>
    <div className="insp-tabs"><button className={tab === "stations" ? "is-on" : ""} onClick={() => setTab("stations")}>工位概览</button><button className={tab === "process" ? "is-on" : ""} onClick={() => setTab("process")}>处理过程</button></div>
    <div className="insp-body">
      {tab === "stations" ? result.stations.map((n) => <button key={n.key} className="part-station" onClick={() => toggleInspector(n.key)}><b>{n.name}</b><span>{n.active ? `${n.active} 进行中` : n.queued ? `${n.queued} 待处理` : "空闲"}</span><small>{n.processed} 步</small><ChevronRight size={13} /></button>) : <>
        {current && node && <Trace a={current} node={node} c={partTone(part.name)} now={now} />}
        {!result.recent.length && <div className="insp-empty">{result.wired ? "本轮暂无处理记录。任务经过后，这里汇总这部分的步骤、结果和证据。" : "这部分尚未接入执行器。"}</div>}
        {result.recent.map((a) => <button className="recent-row" key={a.id} onClick={() => setAttempt(a.id)}><span>{result.stations.find((n) => n.key === a.node)?.name}</span><span className="r-item">{a.item}</span><span className="r-sum muted">{a.summary ?? "进行中"}</span></button>)}
      </>}
    </div>
  </>;
}

function SpecView({ node }: { node: CompiledNode }) {
  const [role,setRole]=useState("");
  useEffect(()=>{let alive=true;setRole("");void api.post<{result:{content:string}}>("/api/tools/read_role",{station:node.key}).then(r=>{if(alive)setRole(r.result.content);}).catch(e=>{if(alive)setRole(e.message);});return()=>{alive=false;};},[node.key]);
  return (
    <div className="insp-body spec-view">
      <details className="node-role" open><summary>ROLE.md · 职责与异常处理</summary><pre>{role||"正在读取职责…"}</pre></details>
      <div className="spec-row"><span>I/O</span><code>{node.input} → {node.output}</code></div>
      <div className="spec-row"><span>工人</span><code>min {node.workers.min} · max {node.workers.max} · 初始 {node.workers.initial} · {node.workers.policy === "auto" ? "自动伸缩" : "固定"}</code></div>
      <div className="spec-row"><span>预计耗时</span><code>{node.estimateSeconds}s</code></div>
      {node.rules.length > 0 && <div className="spec-row"><span>规则</span><div className="chips">{node.rules.map((r) => <span key={r} className="chip mono">{r.replace("vislexicon:", "")}</span>)}</div></div>}
      {node.accept.length > 0 && <div className="spec-row"><span>验收</span><ul>{node.accept.map((a) => <li key={a}>{a}</li>)}</ul></div>}
      {node.returnTo?.length ? <div className="spec-row"><span>退回</span><code>{node.returnTo.map((r) => `→ ${r.station} ≤${r.maxRounds} 轮`).join("   ")}</code></div> : null}
      {node.pseudo && <div className="spec-row col"><span>伪代码（I/O 边界与副作用）</span><pre className="pseudo">{node.pseudo}</pre></div>}
      <div className="spec-note muted">在画布上拖动不会改这里；改结构请对主调度说，它会起草补丁让你确认。</div>
    </div>
  );
}

/** The sub-agent view: input, narrated progress, folded tool steps with evidence, current state. */
function Trace({ a, node, c, now }: { a: AttemptState; node: CompiledNode; c: string; now: number }) {
  const s = getState();
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [inputOpen, setInputOpen] = useState(false);
  const token = s.fs.tokens[a.token];
  const groups = useMemo(() => {
    const out: { kind: "say" | "tools" | "think"; items: AttemptState["steps"] }[] = [];
    for (const st of a.steps) {
      const tool = st.step?.tool ?? "say";
      const isTool = ["browser", "shot", "reject", "http", "record", "webp"].includes(tool);
      const kind = isTool ? "tools" : tool === "think" ? "think" : "say";
      const last = out[out.length - 1];
      // Streamed reasoning arrives in fragments; one train of thought is one block.
      if ((kind === "tools" || kind === "think") && last?.kind === kind) last.items.push(st);
      else out.push({ kind, items: [st] });
    }
    return out;
  }, [a.steps.length, a.id]);
  const running = a.endedAt === undefined;
  return (
    <div className="trace" style={{ ["--tc" as string]: c }}>
      <button className="trace-input" onClick={() => setInputOpen((o) => !o)}>
        <ChevronRight size={13} className={inputOpen ? "rot" : ""} />
        <span className="muted">输入</span>
        <span className="t-item">{token?.item}</span>
        {token?.url && <a href={token.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="muted"><ExternalLink size={11} /></a>}
      </button>
      {inputOpen && <div className="trace-input-body sel">{a.input}{token?.url ? `\n${token.url}` : ""}</div>}
      <div className="trace-steps">
        {groups.map((g, gi) => g.kind === "say" ? g.items.map((st, i) => <SayRow key={`${gi}-${i}`} st={st} />) : g.kind === "think" ? <ThinkRow key={gi} items={g.items} /> : (
          <div key={gi} className="tool-group">
            <button className="tool-sum" onClick={() => setOpen((o) => ({ ...o, [gi]: !o[gi] }))}>
              <ChevronRight size={13} className={open[gi] ? "rot" : ""} />
              <span>{summarize(g.items)}</span>
              <span className="tool-thumbs">{g.items.flatMap((st) => st.step?.evidence ?? []).slice(0, 3).map((id) => <EvThumb key={id} id={id} small />)}</span>
            </button>
            {open[gi] && (
              <div className="tool-detail">
                {g.items.map((st, i) => (
                  <div key={i} className={`tool-line ${st.step?.ok === false ? "is-bad" : st.step?.ok ? "is-ok" : ""}`}>
                    <span className="tl-tool mono">{st.step?.tool}</span>
                    <span className="sel">{st.text}</span>
                    {(st.step?.evidence ?? []).map((id) => <EvThumb key={id} id={id} />)}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className={`trace-foot ${running ? "is-running" : a.cancelled ? "is-cancelled" : a.ok ? "is-ok" : "is-bad"}`}>
        {running ? <><Loader2 size={13} className="spin-i" /><span>{a.steps[a.steps.length - 1]?.text ?? "开始处理…"}</span><span className="num muted">{secs(now - a.startedAt)}</span></>
          : <>{a.cancelled ? <CircleMinus size={13} /> : a.ok ? <Check size={13} /> : <AlertTriangle size={13} />}<span>{a.ok ? a.summary : `${a.summary}${a.error && a.error !== a.summary ? `：${a.error}` : ""}`}</span>
            <span className="num muted">{secs(a.ms ?? 0)}{a.usage.input ? ` · ${fmt(a.usage.input + a.usage.output)} tok` : ""}{a.queuedMs ? ` · 排队 ${secs(a.queuedMs)}` : ""}</span></>}
      </div>
    </div>
  );
}

function SayRow({ st }: { st: AttemptState["steps"][number] }) {
  const tool = st.step?.tool;
  const cls = st.step?.ok===false?"say--bad":st.step?.ok===true?"say--ok":tool === "think" ? "say--think" : tool === "submit" ? "say--submit" : tool === "model" ? "say--model" : "";
  return (
    <div className={`say ${cls}`}>
      <span className="say-dot" />
      <span className="sel">{st.text}</span>
      {(st.step?.evidence ?? []).map((id) => <EvThumb key={id} id={id} />)}
    </div>
  );
}

/** Filler that carries no content once fragments are joined ("Hmm, but", "Actually", "H."). */
const FILLER = /^(hmm+|actually|wait|ok(ay)?|so|but|well|right|good|fine|let me( think| see| check)?|hmm, but|[a-z]\.?|[a-z]\. ?\w{0,6})[\s,.:;!?…—-]*$/i;

function thought(items: AttemptState["steps"]) {
  return items.map((st) => st.text.trim()).filter((t) => t.length > 3 && !FILLER.test(t)).join(" ").replace(/\s+/g, " ").trim();
}

function ThinkRow({ items }: { items: AttemptState["steps"] }) {
  const [open, setOpen] = useState(false);
  const text = thought(items);
  if (!text) return null;
  const first = (text.match(/^.{12,}?[。.!?！？](\s|$)/)?.[0] ?? text).slice(0, 110);
  return (
    <button className={`think ${open ? "is-open" : ""}`} onClick={() => setOpen((o) => !o)}>
      <ChevronRight size={13} className={open ? "rot" : ""} />
      <span className="think-label">思考</span>
      <span className="think-text sel">{open ? text : `${first}${first.length < text.length ? "…" : ""}`}</span>
    </button>
  );
}

function summarize(items: AttemptState["steps"]) {
  const count = (t: string) => items.filter((x) => x.step?.tool === t).length;
  const opened = items.filter((x) => x.text.startsWith("打开") || x.step?.tool === "http").length;
  const parts = [opened && `打开 ${opened} 页`, count("shot") && `截图 ${count("shot")} 张`, count("reject") && `拒收 ${count("reject")} 张`, count("record") && `录屏 ${count("record")} 步`, count("webp") && "转 WebP"].filter(Boolean);
  return parts.join("、") || `${items.length} 步`;
}

function EvThumb({ id, small }: { id: string; small?: boolean }) {
  const ev = getState().fs.evidence[id];
  if (!ev) return null;
  const tok = getState().fs.tokens[ev.token];
  return <EvThumbBody ev={ev} tok={tok} small={small} />;
}

function EvThumbBody({ ev, tok, small }: { ev: EvidenceRef; tok?: TokenState; small?: boolean }) {
  const hover = useHoverPreview(() => previewSet(ev));
  return (
    <span className={`ev-thumb ${small ? "is-small" : ""}`} {...(ev.kind === "image" || ev.kind === "video" ? hover : {})}>
      {ev.kind === "image" || ev.kind === "video" ? <img src={ev.poster ?? ev.card ?? ev.src} alt="" draggable={false} /> : <b>{ev.verdict}</b>}
      {!small && <button className="ev-wrong" onClick={(e) => { e.stopPropagation(); openCorrection([{ token: ev.token, node: ev.station, evidence: ev.id, label: `${tok?.item} · ${ev.label}` }], e.currentTarget); }}>不对</button>}
    </span>
  );
}

/* ------------------------------------------------------------------ token: evidence chain */

const STATUS_ZH: Record<string, string> = { active: "在线上", published: "已发布", merged: "已合并", rejected: "拒收出线", manual: "待人工", failed: "失败", parked: "停放" };

function TokenInspector({ insp, onDrag, onClose, onPin }: { insp: Inspector; onDrag: (e: React.PointerEvent) => void; onClose: () => void; onPin: () => void }) {
  useStore((s) => s.version);
  const s = getState();
  const t = s.fs.tokens[insp.key];
  if (!t) return null;
  const d = t.data as Record<string, any>;
  const steps: { node: string; a: AttemptState; ev: EvidenceRef[] }[] = [];
  for (const id of t.attempts) {
    const a = s.fs.attempts[id];
    if (!a) continue;
    const ev = t.evidence.map((e) => s.fs.evidence[e]).filter((e) => e && e.attempt === id) as EvidenceRef[];
    steps.push({ node: a.node, a, ev });
  }
  const name = (k: string) => s.factory!.nodes.find((n) => n.key === k);
  return (
    <>
      <Head onDrag={onDrag} onClose={onClose} onPin={onPin} pinned={insp.pinned}>
        <div className="insp-title">
          <b>{d.title || t.title || t.item}</b>
          <span className="muted">{t.url.replace(/^https?:\/\//, "")}</span>
        </div>
        <span className={`chip st-${t.status}`}>{STATUS_ZH[t.status]}</span>
      </Head>
      <div className="chain-facts">
        {d.kind && <span className="chip">分类 {d.kind}{d.kindAgreed ? " ✓" : d.kindAgreed === false ? " · 仲裁" : ""}</span>}
        {d.mode && <span className="chip">{d.mode === "video" ? "录屏路线" : "三张图"}</span>}
        {d.style?.applicable && <span className="chip">风格 {(d.style.styles ?? []).map((x: any) => x.id).join(" · ") || "无合适的词"}</span>}
        {d.facts && <span className="chip">{d.facts.price} · {d.facts.license}</span>}
        {Object.entries(t.rounds).map(([k, r]) => <span key={k} className="chip warn-chip">退回 {name(k)?.name} ×{r}</span>)}
      </div>
      {d.copy?.takeawayZh && <div className="chain-copy sel">「{d.copy.takeawayZh}」<span className="muted">{d.copy.descriptionZh}</span></div>}
      {t.reason && t.status !== "active" && <div className="chain-reason">{t.reason}</div>}
      <div className="chain">
        {steps.map(({ node, a, ev }, i) => {
          const n = name(node);
          if (!n) return null;
          return (
            <div key={a.id} className={`chain-step ${a.endedAt === undefined ? "is-running" : a.cancelled ? "" : a.ok ? "" : "is-bad"}`} style={{ ["--c" as string]: roleColors(n.role).border, ["--fill" as string]: roleColors(n.role).fill }}>
              <div className="cs-head"><i>{i + 1}</i>{n.num} {n.name}</div>
              <div className="cs-sum">{a.summary ?? "…"}</div>
              {ev.length > 0 && <div className="cs-ev">{ev.map((e) => <EvThumb key={e.id} id={e.id} />)}</div>}
            </div>
          );
        })}
      </div>
      <div className="insp-actions">
        <button className="btn btn--sm" onClick={() => attach({ type: "token", id: t.id, label: t.item, tone: t.status === "manual" ? "warn" : undefined })}><MessageSquarePlus size={13} />加到对话</button>
        <button className="btn btn--sm" disabled={!steps.length} onClick={(e) => openCorrection([{ token: t.id, node: steps.filter((x) => x.a.ok).slice(-1)[0]?.node ?? steps[0]?.node, label: t.item }], e.currentTarget, true)}>纠错退回…</button>
      </div>
      {Object.values(s.fs.corrections ?? {}).some(correction => correction.token === t.id) && <div className="token-corrections">{Object.values(s.fs.corrections ?? {}).filter(correction => correction.token === t.id).slice(-5).reverse().map(correction => <CorrectionUndo key={correction.id} id={correction.id} />)}</div>}
    </>
  );
}
