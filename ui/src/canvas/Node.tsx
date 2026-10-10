// Station identity first, execution metadata second, comparable workload metrics below.
import { memo } from "react";
import type { CompiledNode, EvidenceRef } from "../../../shared/types.ts";
import { nodeLight, type NodeState } from "../../../shared/project.ts";
import { roleColors } from "../../../shared/palette.ts";
import { shapeOf, type Placed } from "../../../shared/layout.ts";
import { attach, getState, setState, useStore } from "../store.ts";
import type { BotState } from "./Bot.tsx";
import { StationIcon } from "./StationIcon.tsx";
import { openCorrection } from "../board/Correction.tsx";
import { toggleInspector } from "./Canvas.tsx";
import { useNow } from "../util/useNow.ts";
import { bottleneck, trailOf } from "./stats.ts";

export const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : n.toLocaleString("en-US"));
export const secs = (ms: number) => (ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : ms >= 10000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

export function botState(n: NodeState | undefined, dormant: boolean, now: number, waiting?: string): BotState {
  if (dormant) return "sleep";
  if (!n) return "idle";
  if (n.lastFailAt > n.lastOkAt && now - n.lastFailAt < 60_000) return "fail";
  if (n.active.length) return "work";
  if (n.queue.length && waiting) return "wait";
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
  const colorOverride = useStore((s) => s.layout.colors[node.key]);
  const open = useStore((s) => s.inspectors.some((i) => i.key === node.key));
  const trail = useStore((s) => s.trail);
  const now = useNow(5000);
  const s = getState();
  const n = s.fs.nodes[node.key];
  const waiting = s.fs.resources.waiting?.[node.key];
  const lineWired = s.factory?.lines.find((l) => l.id === node.line)?.wired;
  const dormant = Boolean(node.dormant) || (!lineWired && node.kind !== "store");
  const shape = shapeOf(node);
  const displayName = node.name;
  const c = roleColors(node.role, colorOverride !== undefined ? { h: colorOverride } : undefined);
  const light = nodeLight(n, dormant, now);
  const strip = dormant ? [] : (n?.strip ?? []).map((id) => s.fs.evidence[id]).filter(Boolean) as EvidenceRef[];
  const visualEvidence = strip.filter((ev) => ev.kind === "image" || ev.kind === "video");
  const workers = n?.workers.length ?? 0;
  const slow = shape !== "store" && shape !== "source" && bottleneck(s.fs, s.factory!, node.line)?.key === node.key;
  const stop = trail ? trailOf(s.fs, trail).indexOf(node.key) : -1;
  const vars = { ["--c" as string]: c.border, ["--c-strong" as string]: c.strong, ["--fill" as string]: c.fill, ["--fill-h" as string]: c.fillHover, ["--ink-c" as string]: c.ink, ["--soft" as string]: c.soft, ["--glow" as string]: c.glow };
  const cls = `node node--${shape} ${dormant ? "is-dormant" : ""} ${selected ? "is-selected" : ""} ${open ? "is-open" : ""} ${dim ? "is-dim" : ""} ${n?.active.length ? "is-busy" : ""} ${slow ? "is-slow" : ""} ${trail ? (stop >= 0 ? "is-trail" : "is-off-trail") : ""}`;

  if (shape === "source") {
    return (
      <div className={cls} data-node={node.key} style={{ left: place.x, top: place.y, width: place.w, height: place.h, ...vars }}
        data-tip={`${node.name}：${node.blurb ?? ""}${dormant ? "（休眠）" : ""}`} onPointerEnter={() => onHover(node.key)} onPointerLeave={() => onHover(null)}>
        <StationIcon role={node.role} size={15} />
        <span className="node-name">{displayName}</span>
        <span className="node-src-sub">{dormant ? "休眠" : "待命"} {n?.stock ?? 0}</span>
      </div>
    );
  }

  const numPrefix = node.num ? plainNum(node.num) : "";
  const usesModel = node.kind === "agent" || node.kind === "review";
  const execution = usesModel ? `pi · ${s.model}` : ({ program: "程序执行", gate: "规则门禁", store: "资源库", source: "来源", agent: "pi Agent", review: "pi Agent" })[node.kind];

  return (
    <div className={cls} data-node={node.key} style={{ left: place.x, top: place.y, width: place.w, height: place.h, ...vars, borderStyle: node.role === "channel" ? "dashed" : undefined }}
      onPointerEnter={() => onHover(node.key)} onPointerLeave={() => onHover(null)}>
      {stop >= 0 && <span className="node-stop num">{stop + 1}</span>}
      <div className="node-header">
        <StationIcon role={node.role} size={19} />
        <div className="node-heading">
          <span className="node-name" title={node.name}>{displayName}</span>
          <span className={`node-type ${usesModel ? "node-model" : ""}`} title={execution}>{execution}</span>
        </div>
        {numPrefix && <span className="node-idx num">{numPrefix}</span>}
      </div>
      {visualEvidence.length ? <Strip items={visualEvidence} /> : <div className="node-metrics num">
        <div className="node-metric"><span>{shape === "store" ? "库存" : "待处理"}</span><b>{fmt(shape === "store" ? n?.stock ?? 0 : n?.queue.length ?? 0)}<small> 件</small></b></div>
        <div className="node-metric"><span>{shape === "store" ? "本轮新增" : "进行中"}</span><b>{fmt(shape === "store" ? n?.plus ?? 0 : n?.active.length ?? 0)}<small> 件</small></b></div>
      </div>}
      <div className="node-footer">
        <span className="node-status" data-tip={n?.summary || waiting || lightTip(light, waiting)}><i className={`light light--${light} ${n?.active.length ? "is-pulse" : ""}`} />{dormant ? "待接入" : n?.active.length ? "处理中" : n?.queue.length ? "排队中" : light === "red" ? "需要检查" : n?.processed ? "已完成" : "待命"}</span>
        <span className="node-staff num" data-tip={`${workers} 位工人`}>本轮 {fmt(n?.processed ?? 0)}</span>
      </div>
    </div>
  );
});

function lightTip(l: string, waiting?: string) {
  return l === "green" ? "正常运行" : l === "yellow" ? (waiting ? `等待：${waiting}` : "积压 / 有退回") : l === "red" ? "最近失败" : l === "gray" ? "休眠：不占资源" : "空闲";
}


function Strip({ items }: { items: EvidenceRef[] }) {
  const flashes = useStore((s) => s.flashes);
  const now = Date.now();
  return (
    <div className="strip">
      {items.map((ev, i) => {
        const tok = getState().fs.tokens[ev.token];
        const isNew = flashes[ev.id] && now - flashes[ev.id] < 1600;
        return (
          <div key={`${ev.id}:${i}`} className={`thumb tone-${ev.tone ?? "none"} ${isNew ? "is-new" : ""}`} data-tip={`${tok?.item ?? ""} · ${ev.label}${ev.verdict ? `：${ev.verdict}` : ""}`}
            onPointerEnter={() => setState({ trail: ev.token })} onPointerLeave={() => setState({ trail: null })}
            onClick={(e) => { e.stopPropagation(); toggleInspector(ev.token, "token"); }}>
            <img src={ev.poster ?? ev.card ?? ev.src} alt="" draggable={false} loading="lazy" />
            {ev.kind === "video" && <span className="play">▶</span>}
            <div className="thumb-actions">
              <button data-tip="加到对话附件" onClick={(e) => { e.stopPropagation(); attach({ type: "evidence", id: ev.id, label: `${tok?.item ?? ""} · ${ev.label}`, thumb: ev.poster ?? ev.card, tone: ev.tone === "bad" ? "bad" : undefined }); }}>＋</button>
              <button data-tip="不对：纠错退回" onClick={(e) => { e.stopPropagation(); openCorrection([{ token: ev.token, node: ev.station, evidence: ev.id, label: `${tok?.item} · ${ev.label}` }], e.currentTarget as HTMLElement); }}>不对</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
