// Quiet, rounded connectors with explicit card sockets (Spec §22). Conditions become
// visible on interaction; transfers highlight their route and return arcs appear on demand.
import { memo, useId } from "react";
import { roleColors } from "../../../shared/palette.ts";
import { getState, useStore } from "../store.ts";
import { conditionLabel, type Geometry } from "./geometry.ts";
import { trailOf } from "./stats.ts";
import { useNow } from "../util/useNow.ts";
import { partTone } from "../../../shared/parts.ts";

const ACTIVE_MS = 3600, RETURN_MS = 30_000;

export const Edges = memo(function Edges({ geo, hover, selected }: { geo: Geometry; hover: string | null; selected: string[] }) {
  useStore((s) => s.version);
  const trail = useStore((s) => s.trail);
  const layer = useStore((s) => s.layer);
  const clock = useNow(1000);
  const now = useStore(state => state.replay?.at) ?? clock;
  const s = getState();
  const arrowId = `flow-arrow-${useId().replaceAll(":", "")}`;
  const last = new Map<string, number>();
  const lastReturn = new Map<string, number>();
  for (const t of s.fs.transfers) {
    if (t.returned) lastReturn.set(`${t.from}->${t.to}`, t.at);
    else last.set(`${t.from}->${t.to}`, t.at);
  }
  const focus = new Set([...(hover ? [hover] : []), ...selected]);
  const touches = (a: string, b: string) => focus.size === 0 || focus.has(a) || focus.has(b);
  const nodeRole = (k: string) => s.factory!.nodes.find((n) => n.key === k)?.role ?? "process";
  // Consecutive stops of the highlighted item; an edge is on the trail when it joins two.
  const stops = trail ? trailOf(s.fs, trail) : [];
  const hops = new Set(stops.slice(1).map((k, i) => `${stops[i]}->${k}`));
  const onTrail = (members: { from: string; to: string }[]) => members.some((m) => hops.has(`${m.from}->${m.to}`));
  // Two branches with the same condition from one station (e.g. 截图 → 目录 / 图像) show it once.
  const labelled = new Set<string>();
  const firstLabel = (from: string, label: string) => { const k = `${from}:${label}`; if (labelled.has(k)) return false; labelled.add(k); return true; };
  return (
    <svg className={`edges ${trail ? "has-trail" : ""}`} width="1" height="1">
      <defs>
        <marker id={arrowId} viewBox="0 -5 10 10" refX="16" refY="0" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M0 -4.2L9 0L0 4.2Z" fill="context-stroke" />
        </marker>
      </defs>
      {geo.edges.map(({ edge, members, d, from, to, fromPort, toPort, mid, quiet }) => {
        const at = Math.max(0, ...members.map((member) => last.get(`${member.from}->${member.to}`) ?? 0));
        const active = now - at < ACTIVE_MS;
        const dim = !touches(from, to);
        const hovered = hover !== null && (hover === from || hover === to);
        const isCapsuleEdge = from.startsWith("capsule:") || to.startsWith("capsule:");
        const channel = edge.kind === "channel" || isCapsuleEdge;
        const part = geo.bays.find((b) => b.stations.includes(edge.from));
        const color = channel ? "#9a80b8" : partTone(part?.name ?? "");
        const label = conditionLabel(edge);
        const lit = trail !== null && onTrail(members);
        // Side edges stay subtle, capsule edges are shown as dashed purple channels.
        if (quiet && layer !== "channels" && !active && !hovered && !lit && !selected.includes(from) && !selected.includes(to)) return null;
        const w = label.length * 17 + 18;
        return (
          <g key={edge.key} data-edge={edge.key} data-from={from} data-to={to} className={`edge ${active ? "is-active" : ""} ${dim ? "is-dim" : ""} ${channel ? "is-channel" : ""} ${edge.when ? "is-branch" : ""} ${lit ? "is-lit" : ""} ${hovered ? "is-hover" : ""}`} style={{ ["--ec" as string]: color }}>
            <path d={d} className="edge-hit" />
            <path d={d} className="edge-line" vectorEffect="non-scaling-stroke" markerEnd={`url(#${arrowId})`} />
            {active && <path key={at} d={d} className="edge-flash" vectorEffect="non-scaling-stroke" />}
            {(active || lit) && <path d={d} className="edge-flow" vectorEffect="non-scaling-stroke" />}
            {label && (active || hovered || selected.includes(from) || selected.includes(to)) && !dim && firstLabel(from, label) && (
              <g transform={`translate(${mid.x} ${mid.y})`} className="edge-label">
                <rect x={-w / 2} y={-14} width={w} height={28} rx={14} />
                <text textAnchor="middle" dominantBaseline="central" y={0.5}>{label}</text>
              </g>
            )}
          </g>
        );
      })}
      {geo.returns.map(({ edge, members, d, from, to, mid }) => {
        const at = Math.max(0, ...members.flatMap((member) => [lastReturn.get(`${member.from}->${member.to}`) ?? 0, lastReturn.get(`human->${member.to}`) ?? 0]));
        const fresh = now - at < RETURN_MS;
        const isProofReturn = from === "curation/shot-review" && to === "curation/proof";
        const shown = fresh || hover === from || hover === to || selected.includes(from) || selected.includes(to);
        const returnLabel = isProofReturn ? "重拍 · 最多2轮" : from === "curation/fact-review" ? "退修改" : "";
        const w = returnLabel.length * 15 + 16;
        return (
          <g key={edge.key} data-return={edge.key} className={`edge-return ${shown ? "is-shown" : ""} ${fresh ? "is-fresh" : ""}`}>
            <path d={d} vectorEffect="non-scaling-stroke" markerEnd={`url(#${arrowId})`} />
            {shown && returnLabel && (
              <g transform={`translate(${mid.x} ${mid.y - 12})`} className="edge-return-label">
                <rect x={-w / 2} y={-11} width={w} height={22} rx={11} />
                <text textAnchor="middle" dominantBaseline="central">{returnLabel}</text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
});

/** Draw each physical socket once, above cards, so neither half is clipped by a card. */
export const ConnectionPorts = memo(function ConnectionPorts({ geo, hover, selected }: { geo: Geometry; hover: string | null; selected: string[] }) {
  useStore((s) => s.version);
  const layer = useStore((s) => s.layer);
  const clock = useNow(1000);
  const now = useStore(state => state.replay?.at) ?? clock;
  const active = new Set(getState().fs.transfers.filter((t) => now - t.at < ACTIVE_MS).map((t) => `${t.from}->${t.to}`));
  const sockets = new Map<string, { owner: string; x: number; y: number; dir: string }>();
  for (const e of geo.edges) {
    if (e.quiet && layer !== "channels" && hover !== e.from && hover !== e.to && !selected.includes(e.from) && !selected.includes(e.to) && !e.members.some((m) => active.has(`${m.from}->${m.to}`))) continue;
    for (const [owner, p] of [[e.from, e.fromPort], [e.to, e.toPort]] as const) sockets.set(`${owner}:${p.x}:${p.y}`, { owner, ...p });
  }
  for (const e of geo.returns) {
    const shown = hover === e.from || hover === e.to || selected.includes(e.from) || selected.includes(e.to) || getState().fs.transfers.some((t) => t.returned && now - t.at < RETURN_MS && e.members.some((m) => m.from === t.from && m.to === t.to));
    if (shown) for (const [owner, p] of [[e.from, e.fromPort], [e.to, e.toPort]] as const) sockets.set(`${owner}:${p.x}:${p.y}`, { owner, ...p });
  }
  return <svg className="connection-ports" width="1" height="1" aria-hidden="true">
    {[...sockets].map(([key, p]) => <circle key={key} data-node-port={`${p.owner}:${p.dir}`} cx={p.x} cy={p.y} r="7" className={hover === p.owner || selected.includes(p.owner) ? "is-highlighted" : ""} vectorEffect="non-scaling-stroke" />)}
  </svg>;
});
