// Where everything is on the canvas right now: the pack's default layout, overridden by
// the user's layout file (drags, opened capsules). Layout never touches the spec.
import type { CompiledEdge, CompiledFactory, CompiledNode } from "../../../shared/types.ts";
import {
  GEO, alignBands, decorationsOf, layoutFactory, ports, routeEdge, sizeOf, wrapGaps,
  type BayBox, type DockBox, type EdgeRoute, type HallBox, type LayoutResult, type Placed,
} from "../../../shared/layout.ts";
import type { LayoutFile } from "../store.ts";
import { partBounds } from "../../../shared/parts.ts";

type Routed = EdgeRoute & { edge: CompiledEdge; members: CompiledEdge[]; from: string; to: string };

export interface Geometry {
  nodes: { node: CompiledNode; place: Placed }[];
  place: Record<string, Placed>;
  capsules: { line: string; place: Placed }[];
  capsuleOf: Record<string, string>;
  /** Source docks: dormant source chips grouped into one card; their edges leave the dock. */
  docks: (DockBox & { place: Placed })[];
  dockOf: Record<string, string>;
  edges: (Routed & { quiet: boolean; wrap: boolean })[];
  returns: Routed[];
  bounds: { x: number; y: number; w: number; h: number };
  halls: HallBox[];
  bays: BayBox[];
  shelf: Placed | null;
}

export function isOpen(f: CompiledFactory, layout: LayoutFile, line: string) {
  return layout.open[line] ?? !f.ui.collapsed.includes(line);
}

const CONDITION_ZH: Record<string, string> = {
  agree: "一致", disagree: "不一致", decided: "裁定", undecided: "交人", shots: "截图", video: "录屏", needsProof: "", noProof: "",
  complete: "齐全", incomplete: "缺件", website: "网站", skill: "Skill", figure: "绘图", deck: "PPT", fx: "图像",
};
export const conditionLabel = (e: CompiledEdge) => e.label ?? (e.when ? CONDITION_ZH[e.when] ?? e.when : "");

export function geometry(f: CompiledFactory, def: LayoutResult, layout: LayoutFile): Geometry {
  const closed = f.lines.filter((l) => !isOpen(f, layout, l.id)).map((l) => l.id);
  if (closed.some((id) => !f.ui.collapsed.includes(id)) || f.ui.collapsed.some((id) => !closed.includes(id))) {
    // Opening two capsules must allocate two real line areas, not expose overlapping
    // hidden coordinates from the original collapsed layout. User drags remain overrides.
    def = layoutFactory(f.nodes, f.edges, f.ui.order, f.ui.hints, closed);
  }
  const place: Record<string, Placed> = {};
  const nodes: Geometry["nodes"] = [];
  const capsules: Geometry["capsules"] = [];
  const capsuleOf: Record<string, string> = {};
  for (const l of f.lines) {
    if (isOpen(f, layout, l.id)) continue;
    const c = layout.capsules[l.id] ?? def.capsules[l.id] ?? { x: def.lines[l.id]?.x ?? 0, y: def.lines[l.id]?.y ?? 0 };
    const p = { x: c.x, y: c.y, w: GEO.capsuleW, h: GEO.capsuleH };
    capsules.push({ line: l.id, place: p });
    for (const n of f.nodes) if (n.line === l.id) capsuleOf[n.key] = l.id;
    place[`capsule:${l.id}`] = p;
  }
  // A dock moves as one; a chip dragged out of it leaves the dock and keeps its own edges.
  const docks: Geometry["docks"] = [];
  const dockOf: Record<string, string> = {};
  const dockShift: Record<string, { x: number; y: number }> = {};
  for (const d of def.docks ?? []) {
    if (d.members.some((k) => capsuleOf[k])) continue;
    const o = layout.pos[d.id];
    const p = { x: o?.x ?? d.x, y: o?.y ?? d.y, w: d.w, h: d.h };
    dockShift[d.id] = { x: p.x - d.x, y: p.y - d.y };
    docks.push({ ...d, place: p });
    place[d.id] = p;
    for (const k of d.members) if (!layout.pos[k]) dockOf[k] = d.id;
  }
  for (const n of f.nodes) {
    if (capsuleOf[n.key]) continue;
    const d = def.pos[n.key] ?? { x: 0, y: 0, ...sizeOf(n) };
    const o = layout.pos[n.key];
    const shift = dockOf[n.key] ? dockShift[dockOf[n.key]] : { x: 0, y: 0 };
    const p = { x: o?.x ?? d.x + shift.x, y: o?.y ?? d.y + shift.y, w: d.w, h: d.h };
    place[n.key] = p;
    nodes.push({ node: n, place: p });
  }
  const visible = (key: string) => (capsuleOf[key] ? `capsule:${capsuleOf[key]}` : dockOf[key] ?? key);
  const at = (key: string) => place[visible(key)];
  // Obstacles: every card, but chips inside a dock are covered by the dock itself.
  const obstacles = Object.entries(place).filter(([k]) => !dockOf[k]).map(([, p]) => p);
  // These areas are visible parts of a station, although the HTML draws them outside
  // its body. Reserving them before evidence arrives prevents the graph jumping while
  // a run is active and prevents routes cutting through screenshots or status text.
  const decorated = nodes.flatMap(({ node, place: p }) => decorationsOf(node, p).map((box) => ({ box, owner: node.key })));
  const decorations: Placed[] = decorated.map((d) => d.box);
  const moved = (k: string) => Boolean(layout.pos[k]);
  const gaps = def.gaps ?? [];

  // 1. Visible relations: one per original edge, aggregated where an end is folded.
  type Draft = { edge: CompiledEdge; members: CompiledEdge[]; from: string; to: string; a: Placed; b: Placed; crossed: number[]; out: "right" | "left"; inn: "right" | "left" };
  const drafts: Draft[] = [];
  const grouped = new Map<string, Draft>();
  for (const e of f.edges) {
    const fromKey = visible(e.from), toKey = visible(e.to);
    const a = place[fromKey], b = place[toKey];
    if (!a || !b || fromKey === toKey) continue;
    const groupKey = `${fromKey}->${toKey}:${e.kind}:${conditionLabel(e)}`;
    if (fromKey !== e.from || toKey !== e.to) {
      const g = grouped.get(groupKey);
      if (g) { g.members.push(e); continue; }
    }
    const crossed = e.kind === "return" ? [] : wrapGaps(a, b, gaps);
    const [p0, p1] = crossed.length ? [{ dir: "right" as const }, { dir: "left" as const }] : ports(a, b);
    const d: Draft = { edge: e, members: [e], from: fromKey, to: toKey, a, b, crossed, out: p0.dir as "right" | "left", inn: p1.dir as "right" | "left" };
    drafts.push(d); grouped.set(groupKey, d);
  }

  // 2. Shared lanes: in each corridor, wraps that share a source (descending into it) or
  //    a target (leaving it) run on one lane; separate groups get parallel lanes.
  const flows = drafts.filter((d) => d.edge.kind !== "return");
  // Give unrelated branches distinct sockets, ordered by their opposite endpoint.
  // Their stems then converge in order instead of lying on top of one another.
  const socketY = new Map<Draft, { fromY?: number; toY?: number }>();
  for (const end of ["from", "to"] as const) {
    const groups = new Map<string, Draft[]>();
    for (const d of flows) {
      const ps = ports(d.a, d.b), p = ps[end === "from" ? 0 : 1];
      if (p.dir !== "left" && p.dir !== "right") continue;
      const k = `${d[end]}:${p.dir}`;
      groups.set(k, [...(groups.get(k) ?? []), d]);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => end === "from" ? a.b.y - b.b.y : a.a.y - b.a.y);
      group.forEach((d, i) => {
        const box = end === "from" ? d.a : d.b;
        // Compact cards: sockets spread up to 14px apart and stay on whole pixels.
        const gap = Math.max(0, Math.min(14, (box.h - 16) / Math.max(1, group.length - 1)));
        socketY.set(d, { ...socketY.get(d), [end === "from" ? "fromY" : "toY"]: Math.round(box.y + box.h / 2 + (i - (group.length - 1) / 2) * gap) });
      });
    }
  }
  const laneOf = new Map<Draft, [number, number]>();
  for (const g of gaps) {
    const users = flows.filter((d) => d.crossed[0] === g || d.crossed[d.crossed.length - 1] === g);
    if (!users.length) continue;
    const parent = users.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    users.forEach((u, i) => users.forEach((v, j) => {
      if (j <= i) return;
      const shareFrom = u.crossed[0] === g && v.crossed[0] === g && u.from === v.from;
      const shareTo = u.crossed[u.crossed.length - 1] === g && v.crossed[v.crossed.length - 1] === g && u.to === v.to;
      if (shareFrom || shareTo) parent[find(j)] = find(i);
    }));
    const groups = new Map<number, Draft[]>();
    users.forEach((u, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), u]));
    const order = [...groups.values()].sort((m, n) => score(m) - score(n));
    order.forEach((grp, i) => {
      const y = g + (i - (order.length - 1) / 2) * GEO.laneGap;
      for (const d of grp) {
        const cur = laneOf.get(d) ?? [d.crossed[0], d.crossed[d.crossed.length - 1]];
        if (d.crossed[0] === g) cur[0] = y;
        if (d.crossed[d.crossed.length - 1] === g) cur[1] = y;
        laneOf.set(d, cur);
      }
    });
  }
  function score(grp: Draft[]) { return grp.reduce((s, d) => s + d.a.x + d.a.w + d.b.x + (d.crossed.length > 1 ? 4000 : 0), 0) / grp.length; }

  // 4. Route.
  const halls = def.halls ?? [];
  const margins: [number, number] | undefined = halls.length ? [Math.min(...halls.map((h) => h.x)) + 18, Math.max(...halls.map((h) => h.x + h.w)) - 18] : undefined;
  const edges: Geometry["edges"] = [];
  const returns: Geometry["returns"] = [];
  for (const d of drafts) {
    const e = d.edge;
    // Default waypoints only while both ends sit where the layout put them.
    const via = !moved(e.from) && !moved(e.to) && d.from === e.from && d.to === e.to ? def.via[e.key] : undefined;
    // A station's own screenshots and status line never block its own edges.
    const foreign = decorated.filter((x) => x.owner !== e.from && x.owner !== e.to).map((x) => x.box);
    const route = routeEdge(d.a, d.b, obstacles, {
      returning: e.kind === "return", decorations: foreign, via, gaps, lanes: laneOf.get(d), margins, ...socketY.get(d),
    });
    const item = { edge: e, members: d.members, from: d.from, to: d.to, ...route };
    if (e.kind === "return") { returns.push(item); continue; }
    // Quiet changes visual emphasis only: cross-line edges still have visible endpoints.
    // Hand-offs to folded lines show on hover only, so they never cross the working line.
    const quiet = (d.from.startsWith("capsule:") || d.to.startsWith("capsule:") || Boolean(f.ui.hints[f.nodes.find((n) => n.key === e.from)?.line ?? ""]?.side?.includes(e.key)));
    edges.push({ ...item, quiet, wrap: d.crossed.length > 0 });
  }

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (r: Placed) => { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); };
  for (const p of Object.values(place)) grow(p);
  for (const r of decorations) grow(r);
  for (const h of halls) grow(h);
  if (def.shelf && capsules.length) grow(def.shelf);
  // Return arcs and quiet edges only appear on demand, so they never widen the overview.
  for (const route of edges.filter((e) => !e.quiet)) for (const p of route.points) grow({ x: p.x - 4, y: p.y - 4, w: 8, h: 8 });
  if (!Number.isFinite(x0)) { x0 = 0; y0 = 0; x1 = 1; y1 = 1; }
  return {
    nodes, place, capsules, capsuleOf, docks, dockOf, edges, returns,
    bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    halls, bays: alignedBays((def.bays ?? []).map((b) => ({ ...b, ...partBounds(b.stations.map((k) => place[visible(k)]).filter(Boolean)) })), capsuleOf), shelf: capsules.length ? def.shelf ?? null : null,
  };
}

/** Frames of the open lines keep one table grid after drags; folded-line frames stay as they are. */
function alignedBays(bays: BayBox[], capsuleOf: Record<string, string>): BayBox[] {
  const open = bays.filter((b) => !b.stations.some((k) => capsuleOf[k]));
  alignBands(open);
  return bays;
}
