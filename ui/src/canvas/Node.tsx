// Station identity first, execution metadata second, comparable workload metrics below.
import { memo } from "react";
import { previewSet, useHoverPreview } from "../shell/HoverPreview.tsx";
import type { CompiledNode, EvidenceRef } from "../../../shared/types.ts";
import { type NodeState } from "../../../shared/project.ts";
import { roleColors } from "../../../shared/palette.ts";
import { shapeOf, type Placed } from "../../../shared/layout.ts";
import { attach, getState, setState, useStore } from "../store.ts";
import type { BotState } from "./Bot.tsx";
import { StationIcon } from "./StationIcon.tsx";
import { openCorrection } from "../board/Correction.tsx";
import { toggleInspector } from "./Canvas.tsx";
import { useNow } from "../util/useNow.ts";
import { bottleneck, trailOf } from "./stats.ts";
import { nodeCountPresentation } from './node-counts.ts';
import { nodeExecutionPresentation, stationStatus } from './status.ts';

export const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : n.toLocaleString("en-US"));
export const secs = (ms: number) => (ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : ms >= 10000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

export function botState(n: NodeState | undefined, dormant: boolean, now: number, waiting?: string): BotState {
  if (dormant) return "sleep";
  if (!n) return "idle";
  if (n.active.length) return "work";
  if (n.queue.length && waiting) return "wait";
  if (n.lastFailAt > n.lastOkAt && now - n.lastFailAt < 60_000) return "fail";
  if (n.returned && now - n.lastAt < 20_000) return "returned";
  return "idle";
}

/** "⑥" → "06" */
const plainNum = (s: string) => {
  const c = s.codePointAt(0) ?? 0;
  return c >= 0x2460 && c <= 0x2473 ? String(c - 0x245f).padStart(2, "0") : s;
};

export const NodeCard = memo(function NodeCard({ node, place, selected, dim, onHover }: { node: CompiledNode; place: Placed; selected: boolean; dim: boolean; onHover: (k: string | null) => void }) {
  useStore((s) => s.nodeRev[node.key]);
  const agentBinding = useStore(state => state.agentBindings[node.key]);
  const actualExecution = useStore(state => state.nodeExecutions[node.key]);
  const recoveryTokens = useStore(state => state.nodeRecoveries[node.key]);
  const replay = useStore(state => Boolean(state.replay));
  const kernel = useStore(state => state.replay ? 'v1' : state.kernel);
  const kernelNumbers = useStore(state => state.replay ? undefined : state.kernelSnapshot?.stations[node.key]);
  const colorOverride = useStore((s) => s.layout.colors[node.key]);
  const open = useStore((s) => s.inspectors.some((i) => i.key === node.key));
  const trail = useStore((s) => s.trail);
  const now = useNow(5000);
  const s = getState();
  const n = s.fs.nodes[node.key];
  const lineWired = s.factory?.lines.find((l) => l.id === node.line)?.wired;
  const dormant = Boolean(node.dormant) || (!lineWired && node.kind !== "store");
  const shape = shapeOf(node);
  const displayName = node.name;
  const c = roleColors(node.role, colorOverride !== undefined ? { h: colorOverride } : undefined);
  const status = stationStatus(node, s.fs, s.replay?.at ?? now, dormant, recoveryTokens);
  const strip = dormant ? [] : (n?.strip ?? []).map((id) => s.fs.evidence[id]).filter(Boolean) as EvidenceRef[];
  const visualEvidence = strip.filter((ev) => ev.kind === "image" || ev.kind === "video");
  const workers = n?.workers.length ?? 0;
  const counts = nodeCountPresentation(node, n, s.fs);
  const slow = shape !== "store" && shape !== "source" && bottleneck(s.fs, s.factory!, node.line)?.key === node.key;
  const stop = trail ? trailOf(s.fs, trail).indexOf(node.key) : -1;
  const vars = { ["--c" as string]: c.border, ["--c-strong" as string]: c.strong, ["--fill" as string]: c.fill, ["--fill-h" as string]: c.fillHover, ["--ink-c" as string]: c.ink, ["--soft" as string]: c.soft, ["--glow" as string]: c.glow };
  const cls = `node node--uniform node--${shape} ${dormant ? "is-dormant" : ""} ${selected ? "is-selected" : ""} ${open ? "is-open" : ""} ${dim ? "is-dim" : ""} ${n?.active.length ? "is-busy" : ""} ${slow ? "is-slow" : ""} ${trail ? (stop >= 0 ? "is-trail" : "is-off-trail") : ""}`;
  const keyboardProps = {
    tabIndex: 0,
    role: 'button',
    'aria-label': `${displayName}：${status.label}，查看工位详情`,
    'aria-expanded': open,
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        const selection = getState().selected;
        setState({selected: selection.includes(node.key)
          ? selection.filter(key => key !== node.key) : [...selection, node.key]});
      } else toggleInspector(node.key);
    },
  };

  const {usesModel, label: execution} = nodeExecutionPresentation(node, actualExecution, agentBinding, replay);
  const queue = (kernel === 'v2' ? kernelNumbers?.ready : undefined) ?? n?.queue.length ?? 0;
  const active = (kernel === 'v2' ? kernelNumbers?.running : undefined) ?? n?.active.length ?? 0;
  // What a person wants to know at a glance: what is it doing now, and is anything stuck.
  const working = n?.active.length ? s.fs.tokens[s.fs.attempts[n!.active[0]]?.token ?? ""]?.item : undefined;
  const paused = status.light === 'yellow' && /暂停/.test(status.label);
  const failedLast = Boolean(n && n.lastFailAt > n.lastOkAt);
  const doing = dormant ? '休眠' : working ? `正在处理 ${working}${active > 1 ? ` 等 ${active} 件` : ''}`
    : queue ? `${paused ? '已暂停 · ' : ''}排队 ${fmt(queue)} 件` : paused ? '已暂停' : failedLast ? '上一件没有通过' : '空闲';
  const light = <i className={`light light--${status.light} ${status.pulse ? 'is-pulse' : ''}`} data-tip={`${status.label}${status.detail ? `：${status.detail}` : ''}`} />;
  const box = { left: place.x, top: place.y, width: place.w, height: place.h, ...vars, borderStyle: node.role === "channel" ? "dashed" : undefined };


  return (
    <div {...keyboardProps} className={cls} data-node={node.key} style={box}
      onPointerEnter={() => onHover(node.key)} onPointerLeave={() => onHover(null)}>
      {stop >= 0 && <span className="node-stop num">{stop + 1}</span>}
      <div className="node-header">
        <StationIcon role={node.role} size={14} />
        <div className="node-heading">
          <span className="node-name" title={node.name}>{displayName}</span>
          <span className={`node-type ${usesModel ? "node-model" : ""}`} title={execution}>{shape === "source" ? "来源接入" : shape === "store" ? "任务库存" : execution}</span>
        </div>
        {light}
      </div>
      <div className="node-footer">
        {shape === "store" ? <><span className="node-stock num">{fmt(n?.stock ?? 0)}{Boolean(n?.plus) && <span className="node-plus">本轮 +{fmt(n?.plus ?? 0)}</span>}</span>{node.id === "manual" && (n?.stock ?? 0) > 0 && <button className="node-review" onClick={event => {event.stopPropagation(); setState({view: "review"});}}>去审核</button>}</> : <>
        <span className={`node-doing ${working ? 'is-active' : failedLast && !queue ? 'is-warn' : ''}`} title={doing}>{doing}</span>
        {visualEvidence.length > 0 && <Strip items={visualEvidence.slice(-2)} />}
        </>}
      </div>
    </div>
  );
}, (previous, next) => previous.node === next.node && previous.selected === next.selected &&
  previous.dim === next.dim && previous.onHover === next.onHover &&
  previous.place.x === next.place.x && previous.place.y === next.place.y &&
  previous.place.w === next.place.w && previous.place.h === next.place.h);

function Strip({ items }: { items: EvidenceRef[] }) {
  useStore((s) => s.flashes);
  return <div className="strip">{items.map((ev, i) => <StripThumb key={`${ev.id}:${i}`} ev={ev} />)}</div>;
}

function StripThumb({ ev }: { ev: EvidenceRef }) {
  const flashes = useStore((s) => s.flashes);
  const tok = getState().fs.tokens[ev.token];
  const isNew = flashes[ev.id] && Date.now() - flashes[ev.id] < 1600;
  const open = () => toggleInspector(ev.token, "token");
  const hover = useHoverPreview(() => previewSet(ev), open);
  return (
    <div className={`thumb tone-${ev.tone ?? "none"} ${isNew ? "is-new" : ""}`} data-tip={`${tok?.item ?? ""} · ${ev.label}${ev.verdict ? `：${ev.verdict}` : ""}`}
      {...hover}
      onPointerEnter={(e) => { hover.onPointerEnter(e); setState({ trail: ev.token }); }} onPointerLeave={() => { hover.onPointerLeave(); setState({ trail: null }); }}
      onClick={(e) => { e.stopPropagation(); open(); }}>
      <img src={ev.poster ?? ev.card ?? ev.src} alt="" draggable={false} loading="lazy" />
      {ev.kind === "video" && <span className="play">▶</span>}
      <div className="thumb-actions">
        <button data-tip="加到对话附件" onClick={(e) => { e.stopPropagation(); attach({ type: "evidence", id: ev.id, label: `${tok?.item ?? ""} · ${ev.label}`, thumb: ev.poster ?? ev.card, tone: ev.tone === "bad" ? "bad" : undefined }); }}>＋</button>
        <button data-tip="不对：纠错退回" onClick={(e) => { e.stopPropagation(); openCorrection([{ token: ev.token, node: ev.station, evidence: ev.id, label: `${tok?.item} · ${ev.label}` }], e.currentTarget as HTMLElement); }}>不对</button>
      </div>
    </div>
  );
}
