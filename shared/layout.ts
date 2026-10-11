// Initial auto-layout (Spec §10.7) and edge geometry, drawn as a factory floor plan.
// The graph stays a layered DAG read left to right (ranks,
// dummy waypoints, barycentre sweeps, isotonic placement). Every line is a hall; inside
// a hall the stations sit in work bays (收货 · 判定 · 采集 …), which are only tinted
// zones behind the DAG. A long hall wraps between bays, never inside one, like lines of
// text. Edges are horizontal beziers from a right port to a left port; an edge that
// continues on the next row takes a carriage-return curve along a lane of the corridor
// between rows, and edges sharing an endpoint share that lane, like lines on a metro map.
import type { CompiledEdge, CompiledNode } from "./types.ts";
import { partBounds } from "./parts.ts";

export const GEO = {
  /** Horizontal space between rank columns: room for curves, port fans and branch labels. */
  colGap: 72,
  /** Extra space where one bay ends and the next begins. */
  bayGap: 32,
  bayPadX: 16,
  /** The bay's label strip above its cards. */
  bayHead: 48,
  bayPadBottom: 12,
  /** Vertical space between stacked cards, on top of their screenshots and status lines. */
  sepY: 40,
  dummySep: 20,
  /** Corridor between the rows of a hall; carriage-return lanes run along its middle. */
  rowGap: 72,
  laneGap: 10,
  hallPadX: 36,
  /** Hall header: the line's name, its live numbers and the bay ribbon. */
  hallHead: 48,
  hallPadBottom: 20,
  hallGap: 30,
  maxCols: 99,
  capsuleW: 236,
  capsuleH: 76,
  capsuleGap: 28,
  shelfHead: 0,
  shelfPad: 12,
  thumbW: 80,
  thumbH: 50,
  stripGap: 10,
  statusGap: 5,
  statusH: 26,
  /** Source chips inside the source dock. */
  chipW: 170,
  chipH: 38,
  chipGap: 8,
  dockPad: 10,
  dockHead: 30,
  /** Distance between ports that share one side of a card. */
  portGap: 12,
};

/** Chips per row inside a source dock. */
const DOCK_COLS = 1;
/** Width of the shelf's own label, left of the capsules. */
export const SHELF_LABEL = 156;

export type NodeShape = "card" | "step" | "store" | "source";

export function shapeOf(n: Pick<CompiledNode, "kind" | "role" | "resource">): NodeShape {
  if (n.kind === "source") return "source";
  if (n.kind === "store") return "store";
  if (n.kind === "program" && n.role !== "capture" && n.role !== "process") return "step";
  if (n.kind === "gate") return "step";
  return "card";
}

export function sizeOf(n: Pick<CompiledNode, "kind" | "role" | "resource"> & { name?: string }): { w: number; h: number } {
  switch (shapeOf(n)) {
    case "source": return { w: GEO.chipW, h: GEO.chipH };
    case "store": return { w: 280, h: 228 };
    case "step": return { w: 280, h: 228 };
    default: return { w: 280, h: 228 };
  }
}

export interface PhaseHint { name: string; stations: string[] }
export interface LineHint { mode: "stack" | "layered"; wrap?: number; side?: string[]; phases?: PhaseHint[]; grid?: Record<string, [number, number]>; focus?: string[] }

export interface Pt { x: number; y: number }
export interface Placed { x: number; y: number; w: number; h: number }
export interface HallBox extends Placed { id: string; lines: string[]; layer: number }
export interface BayBox extends Placed { id: string; hall: string; line: string; name: string; index: number; row: number; stations: string[] }
export interface RowBox { hall: string; index: number; y0: number; y1: number }
export interface DockBox extends Placed { id: string; line: string; members: string[] }
export interface LayoutResult {
  /** A deliberately composed initial viewport, independent of all-factory bounds. */
  workArea?: Placed;
  pos: Record<string, Placed>;
  /** Waypoints for edges that skip columns inside a row, keyed by edge key. */
  via: Record<string, Pt[]>;
  /** Free horizontal corridors: between the rows of a hall and between halls. */
  gaps?: number[];
  /** Line extents (expanded lines) and capsule spots (collapsed lines). */
  lines: Record<string, { x: number; y: number; w: number; h: number; layer: number }>;
  capsules: Record<string, Placed>;
  layers: { layer: number; x: number; y: number; w: number; h: number }[];
  halls?: HallBox[];
  bays?: BayBox[];
  rows?: RowBox[];
  docks?: DockBox[];
  shelf?: Placed | null;
}

const hasStrip = (n: Pick<CompiledNode, "role">) => n.role === "capture" || n.role === "process";
const hasStatus = (n: Pick<CompiledNode, "kind" | "layer">) => n.layer > 1 && n.kind !== "store" && n.kind !== "source";

/** Visible areas a station draws outside its body: screenshots above, the status line below. */
export function decorationsOf(n: Pick<CompiledNode, "kind" | "layer" | "role">, p: Placed): Placed[] {
  // Evidence and progress now live inside the card; top/bottom ports remain clear.
  return [];
}

/* ------------------------------------------------------------------ one row of a hall */

interface Item { id: string; col: number; pos: number; cy: number; h: number; w: number; above: number; below: number; dummy: boolean; up: Item[]; down: Item[] }

function crossings(cols: Item[][]): number {
  let c = 0;
  for (let r = 0; r + 1 < cols.length; r++) {
    const segs: [number, number][] = [];
    for (const it of cols[r]) for (const d of it.down) segs.push([it.pos, d.pos]);
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if ((segs[i][0] - segs[j][0]) * (segs[i][1] - segs[j][1]) < 0) c++;
  }
  return c;
}

/** Weighted isotonic regression: the closest non-decreasing sequence. */
function pav(s: number[], w: number[]): number[] {
  const blocks: { v: number; wt: number; n: number }[] = [];
  for (let i = 0; i < s.length; i++) {
    blocks.push({ v: s[i], wt: w[i], n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].v > blocks[blocks.length - 1].v) {
      const b = blocks.pop()!, a = blocks[blocks.length - 1];
      a.v = (a.v * a.wt + b.v * b.wt) / (a.wt + b.wt); a.wt += b.wt; a.n += b.n;
    }
  }
  const out: number[] = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(b.v);
  return out;
}

const STATION_RANKS: Record<string, number> = {
  "sources/watch": 0, "sources/github": 0, "sources/x": 0, "sources/xhs": 0, "sources/douyin": 0, "sources/bilibili": 0,
  "candidates/tidy": 0, "candidates/extract": 1, "candidates/index": 2,
  "candidates/pool": 0, "candidates/route": 1,
  "curation/dedupe": 0, "curation/fetch": 1, "curation/classify": 2, "curation/classify-review": 3, "curation/arbiter": 3,
  "curation/plan": 0, "curation/identity": 1, "curation/breadth": 1, "curation/proof": 1, "curation/record": 1,
  "curation/process": 0, "curation/shot-review": 1, "curation/style": 2, "curation/facts": 2, "curation/copy": 3, "curation/fact-review": 3, "curation/copy-review": 4,
  "curation/gate": 0, "curation/published": 1, "curation/manual": 1,
};

/** Longest-path ranks over flow edges (acyclic once return edges are left out). */
function ranksOf(keys: string[], flow: { from: string; to: string }[]) {
  const rank = new Map<string, number>();
  for (const k of keys) {
    if (STATION_RANKS[k] !== undefined) rank.set(k, STATION_RANKS[k]);
  }
  if (rank.size === keys.length) return rank;
  const inc = new Map<string, string[]>(keys.map((k) => [k, []]));
  for (const e of flow) if (inc.has(e.to) && inc.has(e.from)) inc.get(e.to)!.push(e.from);
  const visit = (k: string, stack: Set<string>): number => {
    if (rank.has(k)) return rank.get(k)!;
    if (stack.has(k)) return 0;
    stack.add(k);
    const r = Math.max(0, ...inc.get(k)!.map((p) => visit(p, stack) + 1));
    stack.delete(k);
    rank.set(k, r);
    return r;
  };
  for (const k of keys) visit(k, new Set());
  return rank;
}

/** Barycentre ordering, isotonic vertical placement, columns left to right. */
function layoutRow(items: Item[], links: { key: string; from: string; to: string }[], bayStarts: Set<number>, justify?: number) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const ncol = Math.max(0, ...items.map((it) => it.col)) + 1;
  const cols: Item[][] = Array.from({ length: ncol }, () => []);
  for (const it of items) cols[it.col].push(it);
  const chains = new Map<string, Item[]>();
  for (const l of links) {
    const a = byId.get(l.from), b = byId.get(l.to);
    if (!a || !b || b.col <= a.col) continue;
    let prev = a;
    const chain: Item[] = [];
    for (let c = a.col + 1; c < b.col; c++) {
      const d: Item = { id: `${l.key}#${c}`, col: c, pos: 0, cy: 0, h: 8, w: 8, above: 0, below: 0, dummy: true, up: [], down: [] };
      cols[c].push(d); chain.push(d); prev.down.push(d); d.up.push(prev); prev = d;
    }
    prev.down.push(b); b.up.push(prev);
    if (chain.length) chains.set(l.key, chain);
  }
  cols.forEach((col) => col.forEach((it, i) => (it.pos = i)));
  const norm = (it: Item) => (it.pos + 0.5) / cols[it.col].length;
  const sortCol = (c: number, side: -1 | 1) => {
    const key = new Map<Item, number>();
    for (const it of cols[c]) { const ns = side < 0 ? it.up : it.down; key.set(it, ns.length ? ns.reduce((s, m) => s + norm(m), 0) / ns.length : norm(it)); }
    cols[c].sort((x, y) => key.get(x)! - key.get(y)! || x.pos - y.pos);
    cols[c].forEach((it, i) => (it.pos = i));
  };
  let best = crossings(cols), bestCols = cols.map((c) => c.slice());
  for (let iter = 0; iter < 16 && best > 0; iter++) {
    if (iter % 2 === 0) for (let c = 1; c < cols.length; c++) sortCol(c, -1);
    else for (let c = cols.length - 2; c >= 0; c--) sortCol(c, 1);
    const n = crossings(cols);
    if (n < best) { best = n; bestCols = cols.map((c) => c.slice()); }
  }
  bestCols.forEach((col, c) => { cols[c] = col; col.forEach((it, i) => (it.pos = i)); });
  // A waypoint keeps clear of a card's screenshots and status line, not just its body.
  const sep = (a: Item, b: Item) => (a.dummy && b.dummy ? GEO.dummySep : a.dummy ? GEO.dummySep + b.above : b.dummy ? a.below + GEO.dummySep : a.below + GEO.sepY + b.above);
  let tallest = 0;
  const heights = cols.map((col) => {
    let y = 0;
    col.forEach((it, k) => { if (k) y += sep(col[k - 1], it); it.cy = y + it.h / 2; y += it.h; });
    tallest = Math.max(tallest, y);
    return y;
  });
  cols.forEach((col, c) => { const off = (tallest - heights[c]) / 2; col.forEach((it) => (it.cy += off)); });
  const placeCol = (col: Item[], side: number) => {
    if (!col.length) return;
    const s: number[] = [], w: number[] = [], off: number[] = [];
    let o = 0;
    col.forEach((it, k) => {
      if (k) o += col[k - 1].h / 2 + sep(col[k - 1], it) + it.h / 2;
      off.push(o);
      const ns = side < 0 ? it.up : side > 0 ? it.down : [...it.up, ...it.down];
      s.push((ns.length ? ns.reduce((a, m) => a + m.cy, 0) / ns.length : it.cy) - o);
      w.push(ns.length ? (it.dummy ? 2 : 1) : 0.15);
    });
    const y = pav(s, w);
    col.forEach((it, k) => (it.cy = y[k] + off[k]));
  };
  for (let iter = 0; iter < 10; iter++) {
    if (iter % 2 === 0) for (let c = 1; c < cols.length; c++) placeCol(cols[c], -1);
    else for (let c = cols.length - 2; c >= 0; c--) placeCol(cols[c], 1);
  }
  for (const col of cols) placeCol(col, 0);
  // Columns are as wide as their widest card; a bay boundary adds a little air.
  const colW = cols.map((col) => Math.max(8, ...col.filter((it) => !it.dummy).map((it) => it.w)));
  const colX: number[] = [];
  colW.forEach((_, c) => colX.push(c ? colX[c - 1] + colW[c - 1] + GEO.colGap + (bayStarts.has(c) ? GEO.bayGap : 0) : 0));
  // Justified rows: a short row spreads its columns (up to a point) like justified text.
  const natural = colX[ncol - 1] + colW[ncol - 1];
  if (justify && ncol > 1 && justify > natural) {
    const per = Math.min((justify - natural) / (ncol - 1), GEO.colGap * 1.25);
    colX.forEach((_, c) => (colX[c] += Math.round(per * c)));
  }
  let top = Infinity, bottom = -Infinity;
  for (const col of cols) for (const it of col) { top = Math.min(top, it.cy - it.h / 2 - it.above); bottom = Math.max(bottom, it.cy + it.h / 2 + it.below); }
  const pos: Record<string, Placed> = {};
  for (const it of byId.values()) pos[it.id] = { x: Math.round(colX[it.col] + (colW[it.col] - it.w) / 2), y: Math.round(it.cy - it.h / 2 - top), w: it.w, h: it.h };
  const via: Record<string, Pt[]> = {};
  // A waypoint crosses its whole column level, so the bends happen in the gaps between columns.
  for (const [key, ch] of chains) via[key] = ch.flatMap((d) => [{ x: Math.round(colX[d.col]), y: Math.round(d.cy - top) }, { x: Math.round(colX[d.col] + colW[d.col]), y: Math.round(d.cy - top) }]);
  return { pos, via, colX, colW, w: colX[ncol - 1] + colW[ncol - 1], h: Math.round(bottom - top) };
}

/* ------------------------------------------------------------------ the floor plan */

interface BayDef { name: string; line: string; keys: string[] }

/** Bays of a hall: phases for every line in the production flow. */
function baysOf(group: string[], byLine: Map<string, CompiledNode[]>, hints: Record<string, LineHint>): BayDef[] {
  const bays: BayDef[] = [];
  for (const id of group) {
    const ns = byLine.get(id) ?? [];
    if (!ns.length) continue;
    const phases = hints[id]?.phases;
    if (phases?.length) {
      for (const p of phases) {
        bays.push({ name: p.name, line: id, keys: p.stations.map((s) => s.includes("/") ? s : `${id}/${s}`).filter((k) => ns.some((n) => n.key === k)) });
      }
    } else {
      const name = byLine.get(id)![0].layer === 1 ? "来源接入" : byLine.get(id)![0].layer === 2 ? "候选处理" : (byLine.get(id)![0].name || id);
      bays.push({ name, line: id, keys: ns.map((n) => n.key) });
    }
  }
  return bays.filter((b) => b.keys.length);
}

export function layoutFactory(
  nodes: CompiledNode[], edges: CompiledEdge[], order: string[], hints: Record<string, LineHint>, collapsed: string[],
): LayoutResult {
  if (Object.values(hints).some((h) => h.grid)) return gridPlan(nodes, edges, order, hints, collapsed);
  // Measure first, then lay out again with every row justified to the widest one.
  const measured = floorPlan(nodes, edges, order, hints, collapsed);
  return floorPlan(nodes, edges, order, hints, collapsed, measured.contentW);
}

/** Pack-authored coordinates express visual intent without changing execution edges.
 * Unknown/new stations and expanded secondary lines get their own free grid cells. */
function gridPlan(nodes: CompiledNode[], edges: CompiledEdge[], order: string[], hints: Record<string, LineHint>, collapsed: string[]): LayoutResult {
  const pos: Record<string, Placed> = {}, lines: LayoutResult["lines"] = {}, capsules: Record<string, Placed> = {};
  const bays: BayBox[] = [], halls: HallBox[] = [], docks: DockBox[] = [];
  const dx = 318, dy = 288;
  const ids = [...new Set(nodes.map((n) => n.line))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const extent = (ps: Placed[]): Placed => {
    if (!ps.length) return { x: 0, y: 0, w: 1, h: 1 };
    const x = Math.min(...ps.map((p) => p.x)), y = Math.min(...ps.map((p) => p.y));
    return { x, y, w: Math.max(...ps.map((p) => p.x + p.w)) - x, h: Math.max(...ps.map((p) => p.y + p.h)) - y };
  };
  let nextY = 0, workArea: Placed | undefined;
  const candidates = nodes.filter((n) => n.layer === 2);
  for (const id of ids.filter((id) => !collapsed.includes(id))) {
    const ns = nodes.filter((n) => n.line === id), hint = hints[id];
    if (ns[0].layer === 1) {
      const targetKey = edges.find((e) => ns.some((n) => n.key === e.from) && e.kind === "flow")?.to;
      const target = nodes.find((n) => n.key === targetKey);
      const cell = target ? hints[target.line]?.grid?.[target.id] : undefined;
      const h = GEO.dockHead + ns.length * (GEO.chipH + GEO.chipGap) + 2;
      const d = { id: `dock:${id}`, line: id, members: ns.map((n) => n.key), x: (cell?.[0] ?? -2) * dx - (GEO.chipW + 20) - 80, y: (cell?.[1] ?? 0) * dy + (228 - h) / 2, w: GEO.chipW + 20, h };
      docks.push(d);
      ns.forEach((n, i) => { pos[n.key] = { x: d.x + 10, y: d.y + GEO.dockHead + i * (GEO.chipH + GEO.chipGap), ...sizeOf(n) }; });
    } else if (ns[0].layer === 2) {
      ns.forEach((n) => { const cell = hint?.grid?.[n.id]; pos[n.key] = { x: (cell?.[0] ?? candidates.indexOf(n) - candidates.length) * dx, y: (cell?.[1] ?? 0) * dy, ...sizeOf(n) }; });
    } else {
      const baseY = nextY;
      const used = new Set(Object.values(hint?.grid ?? {}).map((p) => p.join(":")));
      let extra = Math.max(0, ...Object.values(hint?.grid ?? {}).map((p) => p[1])) + (hint?.grid ? 1 : 0);
      ns.forEach((n, i) => {
        const cell = hint?.grid?.[n.id];
        let col = cell?.[0], row = cell?.[1];
        if (col === undefined || row === undefined) {
          col = hint?.grid ? i % 5 : i; row = hint?.grid ? extra + Math.floor(i / 5) : 0;
          while (used.has(`${col}:${row}`)) row++;
          used.add(`${col}:${row}`);
        }
        pos[n.key] = { x: col * dx, y: baseY + row * dy, ...sizeOf(n) };
      });
      nextY = Math.max(...ns.map((n) => pos[n.key].y + pos[n.key].h)) + 140;
      if (!workArea && hint?.focus) workArea = extent(hint.focus.map((key) => pos[key.includes("/") ? key : `${id}/${key}`]).filter(Boolean));
    }
    const box = extent(ns.map((n) => pos[n.key]));
    lines[id] = { ...box, layer: ns[0].layer };
    halls.push({ ...box, id, lines: [id], layer: ns[0].layer });
    for (const phase of hint?.phases ?? [{ name: ns[0].layer === 1 ? "来源接入" : ns[0].layer === 2 ? "候选处理" : id, stations: ns.map((n) => n.id) }]) {
      const keys = phase.stations.map((key) => key.includes("/") ? key : `${id}/${key}`).filter((key) => pos[key]);
      const dock = docks.find((d) => d.line === id);
      bays.push({ ...partBounds(dock ? [dock] : keys.map((key) => pos[key])), id: `${id}:${phase.name}`, hall: id, line: id, name: phase.name, index: bays.length, row: 0, stations: keys });
    }
  }
  ids.filter((id) => collapsed.includes(id)).forEach((id, i) => {
    // All business entries branch into one vertical column. Their own nodes
    // may expand to the right; the inlet column never folds into a bottom shelf.
    const p = { x: 0, y: nextY + i * 220, w: GEO.capsuleW, h: GEO.capsuleH };
    capsules[id] = p; lines[id] = { ...p, layer: 3 };
    bays.push({ ...partBounds([p]), id: `${id}:line`, hall: id, line: id, name: id, index: bays.length, row: 0, stations: nodes.filter((n) => n.line === id).map((n) => n.key) });
  });
  return { pos, via: {}, gaps: [], lines, capsules, bays, docks, halls, rows: [], layers: [], shelf: null, workArea };
}

function floorPlan(
  nodes: CompiledNode[], edges: CompiledEdge[], order: string[], hints: Record<string, LineHint>, collapsed: string[], justify?: number,
): LayoutResult & { contentW: number } {
  const pos: Record<string, Placed> = {};
  const via: Record<string, Pt[]> = {};
  const gaps: number[] = [];
  const lines: LayoutResult["lines"] = {};
  const capsules: Record<string, Placed> = {};
  const halls: HallBox[] = [], bays: BayBox[] = [], rows: RowBox[] = [], docks: DockBox[] = [];
  const side = new Set(Object.values(hints).flatMap((h) => h.side ?? []));
  const flow = edges.filter((e) => e.kind === "flow" && !side.has(e.key));
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const byLine = new Map<string, CompiledNode[]>();
  for (const n of nodes) byLine.set(n.line, [...(byLine.get(n.line) ?? []), n]);
  const ids = [...byLine.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const intake = ids.filter((id) => byLine.get(id)![0].layer < 3);
  const activeProduction = ids.filter((id) => byLine.get(id)![0].layer === 3 && !collapsed.includes(id));
  const groups: string[][] = [[...intake, ...activeProduction]];
  const x0 = GEO.hallPadX + GEO.bayPadX;
  let y = 0, contentW = 0;
  for (const group of groups) {
    const hallId = "factory";
    const hallTop = y;
    y += GEO.hallHead;
    const defs = baysOf(group, byLine, hints);
    // Each bay ranks its own stations; a bay of many dormant sources becomes one dock.
    const bayItems = defs.map((b) => {
      const ns = b.keys.map((k) => byKey.get(k)!);
      if (ns.length >= 4 && ns.every((n) => n.kind === "source")) {
        const rowsN = Math.ceil(ns.length / DOCK_COLS);
        const id = `dock:${b.line}`;
        return { def: b, dock: id as string | null, cols: 1, items: [{ id, rank: 0, w: GEO.chipW * DOCK_COLS + GEO.chipGap * (DOCK_COLS - 1) + GEO.dockPad * 2, h: GEO.dockHead + rowsN * GEO.chipH + (rowsN - 1) * GEO.chipGap + GEO.dockPad, above: 0, below: 0 }] };
      }
      const rank = ranksOf(b.keys, flow);
      return {
        def: b, dock: null as string | null, cols: Math.max(0, ...rank.values()) + 1,
        items: ns.map((n) => {
          const s = sizeOf(n);
          return { id: n.key, rank: rank.get(n.key)!, w: s.w, h: s.h, above: hasStrip(n) && hasStatus(n) ? GEO.thumbH + GEO.stripGap : 0, below: hasStatus(n) ? GEO.statusGap + GEO.statusH : 0 };
        }),
      };
    });
    // Single row left to right across bays.
    const wrap = 999;
    const packed: (typeof bayItems)[] = [];
    for (const b of bayItems) {
      const cur = packed[packed.length - 1];
      if (cur && cur.reduce((s, x) => s + x.cols, 0) + b.cols <= wrap) cur.push(b); else packed.push([b]);
    }
    const dockOf = new Map<string, string>();
    for (const b of bayItems) if (b.dock) for (const k of b.def.keys) dockOf.set(k, b.dock);
    const vis = (k: string) => dockOf.get(k) ?? k;
    let bayIndex = 0;
    packed.forEach((row, ri) => {
      let col = 0;
      const items: Item[] = [], starts = new Set<number>(), spans: [number, number][] = [];
      for (const b of row) {
        if (col) starts.add(col);
        spans.push([col, col + b.cols - 1]);
        for (const it of b.items) items.push({ id: it.id, col: col + it.rank, pos: 0, cy: 0, w: it.w, h: it.h, above: it.above, below: it.below, dummy: false, up: [], down: [] });
        col += b.cols;
      }
      const inRow = new Set(items.map((it) => it.id));
      const links = flow.map((e) => ({ key: e.key, from: vis(e.from), to: vis(e.to) })).filter((l) => l.from !== l.to && inRow.has(l.from) && inRow.has(l.to));
      const r = layoutRow(items, links, starts, justify);
      const top = y + GEO.bayHead;
      for (const [k, p] of Object.entries(r.pos)) pos[k] = { ...p, x: p.x + x0, y: p.y + top };
      for (const [k, pts] of Object.entries(r.via)) via[k] = pts.map((p) => ({ x: p.x + x0, y: p.y + top }));
      const bottom = top + r.h + GEO.bayPadBottom;
      row.forEach((b, bi) => {
        const [c0, c1] = spans[bi];
        bays.push({
          id: `${b.def.line}:${b.def.name}`, hall: hallId, line: b.def.line, name: b.def.name, index: bayIndex++, row: ri, stations: b.def.keys,
          x: x0 + r.colX[c0] - GEO.bayPadX, y, w: (bi === row.length - 1 && justify ? Math.max(justify, r.colX[c1] + r.colW[c1]) : r.colX[c1] + r.colW[c1]) - r.colX[c0] + GEO.bayPadX * 2, h: bottom - y,
        });
      });
      rows.push({ hall: hallId, index: ri, y0: y, y1: bottom });
      contentW = Math.max(contentW, r.colX[r.colX.length - 1] + r.colW[r.colW.length - 1]);
      y = bottom;
      if (ri < packed.length - 1) { gaps.push(Math.round(y + GEO.rowGap / 2)); y += GEO.rowGap; }
    });
    // Dock chips sit in a small grid inside their dock.
    for (const b of bayItems) {
      if (!b.dock) continue;
      const d = pos[b.dock];
      delete pos[b.dock];
      docks.push({ id: b.dock, line: b.def.line, members: b.def.keys, ...d });
      b.def.keys.forEach((k, i) => {
        pos[k] = { x: d.x + GEO.dockPad + (i % DOCK_COLS) * (GEO.chipW + GEO.chipGap), y: d.y + GEO.dockHead + Math.floor(i / DOCK_COLS) * (GEO.chipH + GEO.chipGap), w: GEO.chipW, h: GEO.chipH };
      });
    }
    y += GEO.hallPadBottom;
    halls.push({ id: hallId, lines: group, layer: 3, x: 0, y: hallTop, w: 0, h: y - hallTop });
    for (const id of group) {
      const ps = byLine.get(id)!.map((n) => pos[n.key]);
      const lx = Math.min(...ps.map((p) => p.x)), ly = Math.min(...ps.map((p) => p.y));
      lines[id] = { x: lx, y: ly, w: Math.max(...ps.map((p) => p.x + p.w)) - lx, h: Math.max(...ps.map((p) => p.y + p.h)) - ly, layer: byLine.get(id)![0].layer };
    }
    gaps.push(Math.round(y + GEO.hallGap / 2));
    y += GEO.hallGap;
  }
  const closed = ids.filter((id) => collapsed.includes(id));
  const hallW = Math.max(contentW + x0 * 2, closed.length ? SHELF_LABEL + Math.min(closed.length, 6) * (GEO.capsuleW + GEO.capsuleGap) - GEO.capsuleGap + GEO.shelfPad * 2 : 0, 600);
  for (const h of halls) h.w = hallW;
  let shelf: Placed | null = null;
  if (closed.length) {
    const shelfStartX = Math.max(x0, Math.round((contentW - closed.length * (GEO.capsuleW + GEO.capsuleGap)) / 2));
    closed.forEach((id, i) => {
      const p = {
        x: shelfStartX + i * (GEO.capsuleW + GEO.capsuleGap),
        y: y + GEO.shelfPad + 12,
        w: GEO.capsuleW,
        h: GEO.capsuleH,
      };
      capsules[id] = p;
      lines[id] = { ...p, layer: byLine.get(id)![0].layer };
    });
    shelf = { x: shelfStartX - 16, y: y + 6, w: closed.length * (GEO.capsuleW + GEO.capsuleGap) + 32, h: GEO.capsuleH + GEO.shelfPad * 2 + 16 };
  }
  const layers = halls.map((h) => ({ layer: h.layer, x: h.x, y: h.y, w: h.w, h: h.h }));
  return { pos, via, gaps, lines, capsules, layers, halls, bays, rows, docks, shelf, contentW };
}

/* ------------------------------------------------------------------ edge geometry */

export type Port = Pt & { dir: "right" | "left" | "down" | "up" };

/** Face the neighbouring card: vertical stacks use top/bottom sockets, columns use side sockets. */
export function ports(a: Placed, b: Placed): [Port, Port] {
  const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  if (overlap > Math.min(a.w, b.w) * 0.55) {
    if (b.y >= a.y + a.h) return [{ x: a.x + a.w / 2, y: a.y + a.h, dir: "down" }, { x: b.x + b.w / 2, y: b.y, dir: "up" }];
    if (a.y >= b.y + b.h) return [{ x: a.x + a.w / 2, y: a.y, dir: "up" }, { x: b.x + b.w / 2, y: b.y + b.h, dir: "down" }];
  }
  const dy = b.y + b.h / 2 - a.y - a.h / 2;
  // A side branch leaves above/below the centre according to its destination.
  // Opposing branches between two columns therefore never form a false junction.
  const y = Math.round(a.y + a.h / 2 + (Math.abs(dy) > a.h / 2 ? Math.sign(dy) * a.h * 0.18 : 0));
  if (b.x + b.w <= a.x) return [{ x: a.x, y, dir: "left" }, { x: b.x + b.w, y: b.y + b.h / 2, dir: "right" }];
  return [{ x: a.x + a.w, y, dir: "right" }, { x: b.x, y: b.y + b.h / 2, dir: "left" }];
}

const f = (v: number) => Math.round(v * 10) / 10;
const sign = (d: Port["dir"]) => (d === "right" ? 1 : d === "left" ? -1 : 0);

type Seg = { c1: Pt; c2: Pt; to: Pt } | { to: Pt };

/** A path kept as segments so it can be both drawn and sampled for collisions. */
class Path {
  start: Pt;
  segs: Seg[] = [];
  constructor(start: Pt) { this.start = start; }
  get end(): Pt { return this.segs.length ? this.segs[this.segs.length - 1].to : this.start; }
  curve(c1: Pt, c2: Pt, to: Pt) { this.segs.push({ c1, c2, to }); return this; }
  line(to: Pt) { const e = this.end; if (Math.abs(e.x - to.x) > 0.01 || Math.abs(e.y - to.y) > 0.01) this.segs.push({ to }); return this; }
  /** Horizontal-tangent cubic (mid-point curve, turned sideways). */
  ease(to: Pt, outDir = 1, inDir = 1) {
    const p = this.end;
    const k = Math.max(36, Math.abs(to.x - p.x) / 2, Math.min(110, Math.abs(to.y - p.y) * 0.35));
    return this.curve({ x: p.x + outDir * k, y: p.y }, { x: to.x - inDir * k, y: to.y }, to);
  }
  d() {
    let s = `M${f(this.start.x)} ${f(this.start.y)}`;
    for (const g of this.segs) s += "c1" in g ? `C${f(g.c1.x)} ${f(g.c1.y)} ${f(g.c2.x)} ${f(g.c2.y)} ${f(g.to.x)} ${f(g.to.y)}` : `L${f(g.to.x)} ${f(g.to.y)}`;
    return s;
  }
  sample(per = 64): Pt[] {
    const out: Pt[] = [this.start];
    let p = this.start;
    for (const g of this.segs) {
      for (let i = 1; i <= per; i++) {
        const t = i / per, u = 1 - t;
        out.push("c1" in g
          ? { x: u ** 3 * p.x + 3 * u * u * t * g.c1.x + 3 * u * t * t * g.c2.x + t ** 3 * g.to.x, y: u ** 3 * p.y + 3 * u * u * t * g.c1.y + 3 * u * t * t * g.c2.y + t ** 3 * g.to.y }
          : { x: p.x + (g.to.x - p.x) * t, y: p.y + (g.to.y - p.y) * t });
      }
      p = g.to;
    }
    return out;
  }
}

export interface EdgeRoute { d: string; points: Pt[]; fromPort: Port; toPort: Port; mid: Pt; length: number }

const insideAny = (pts: Pt[], boxes: Placed[]) => pts.some((p) => boxes.some((r) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h));
const lengthOf = (pts: Pt[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);
const done = (path: Path, fromPort: Port, toPort: Port, mid?: Pt): EdgeRoute => {
  const points = path.sample();
  return { d: path.d(), points, fromPort, toPort, mid: mid ?? points[Math.floor(points.length / 2)], length: lengthOf(points) };
};

/* --------------------------- detour (only when a dragged card blocks the curve) */

const distance = (a: Pt, b: Pt) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function clearSegment(a: Pt, b: Pt, boxes: Placed[]): boolean {
  const eps = 0.01;
  if (Math.abs(a.y - b.y) < eps) return !boxes.some((r) => a.y > r.y + eps && a.y < r.y + r.h - eps && Math.max(a.x, b.x) > r.x + eps && Math.min(a.x, b.x) < r.x + r.w - eps);
  if (Math.abs(a.x - b.x) < eps) return !boxes.some((r) => a.x > r.x + eps && a.x < r.x + r.w - eps && Math.max(a.y, b.y) > r.y + eps && Math.min(a.y, b.y) < r.y + r.h - eps);
  return false;
}

function simplify(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    if (out.length && distance(out[out.length - 1], p) < 0.01) continue;
    while (out.length > 1) {
      const a = out[out.length - 2], b = out[out.length - 1];
      const straight = (Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - p.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - p.y) < 0.01);
      if (straight) out.pop(); else break;
    }
    out.push(p);
  }
  return out;
}

/** Cheapest corridor with at most two bends among the free lines between cards. */
function corridor(start: Pt, end: Pt, all: Placed[]): Pt[] | null {
  // Only cards near the two ends can shape the detour; far ones only cost time.
  const x0 = Math.min(start.x, end.x) - 360, x1 = Math.max(start.x, end.x) + 360, y0 = Math.min(start.y, end.y) - 360, y1 = Math.max(start.y, end.y) + 360;
  const boxes = all.filter((r) => r.x < x1 && r.x + r.w > x0 && r.y < y1 && r.y + r.h > y0);
  const mx = (start.x + end.x) / 2, my = (start.y + end.y) / 2;
  const near = (vs: number[], m: number) => [...new Set(vs)].sort((a, b) => Math.abs(a - m) - Math.abs(b - m)).slice(0, 18);
  // The nearest free lines, plus the outermost ones that go round everything.
  const xs = [...new Set([...near([mx, ...boxes.flatMap((r) => [r.x - 18, r.x + r.w + 18])], mx), Math.min(start.x, ...boxes.map((r) => r.x)) - 18, Math.max(end.x, ...boxes.map((r) => r.x + r.w)) + 18])];
  const ys = [...new Set([...near([my, ...boxes.flatMap((r) => [r.y - 18, r.y + r.h + 18])], my), Math.min(start.y, end.y, ...boxes.map((r) => r.y)) - 18, Math.max(start.y, end.y, ...boxes.map((r) => r.y + r.h)) + 18])];
  const options: Pt[][] = [];
  for (const x of xs) options.push([start, { x, y: start.y }, { x, y: end.y }, end]);
  for (const y of ys) options.push([start, { x: start.x, y }, { x: end.x, y }, end]);
  for (const y of ys) for (const x1 of [start.x, ...xs]) for (const x2 of [end.x, ...xs]) options.push([start, { x: x1, y: start.y }, { x: x1, y }, { x: x2, y }, { x: x2, y: end.y }, end]);
  const valid = options.map(simplify).filter((ps) => ps.slice(1).every((p, i) => clearSegment(ps[i], p, boxes)));
  const cost = (ps: Pt[]) => ps.slice(1).reduce((s, p, i) => s + distance(ps[i], p), 0) + (ps.length - 2) * 60;
  valid.sort((a, b) => cost(a) - cost(b));
  return valid[0] ?? null;
}

/** Turns a polyline into large, soft bezier turns (radius up to `max`) — never a hook. */
function softPath(points: Pt[], max = 46): Path {
  const ps = simplify(points);
  const path = new Path(ps[0]);
  for (let i = 1; i < ps.length - 1; i++) {
    const a = ps[i - 1], b = ps[i], c = ps[i + 1];
    const r = Math.min(max, distance(a, b) / 2, distance(b, c) / 2);
    const enter = { x: b.x + Math.sign(a.x - b.x) * r, y: b.y + Math.sign(a.y - b.y) * r };
    const leave = { x: b.x + Math.sign(c.x - b.x) * r, y: b.y + Math.sign(c.y - b.y) * r };
    path.line(enter).curve({ x: (enter.x + 2 * b.x) / 3, y: (enter.y + 2 * b.y) / 3 }, { x: (leave.x + 2 * b.x) / 3, y: (leave.y + 2 * b.y) / 3 }, leave);
  }
  return path.line(ps[ps.length - 1]);
}

export interface RouteOptions {
  returning?: boolean;
  decorations?: Placed[];
  via?: Pt[];
  /** Free corridors between rows and halls; an edge to a later row wraps along them. */
  gaps?: number[];
  /** Lane heights for this edge in the first and last corridor it uses (shared lanes). */
  lanes?: [number, number];
  /** The side margins a wrap that skips rows runs down. */
  margins?: [number, number];
  /** Port heights when several edges share one side of a card. */
  fromY?: number;
  toY?: number;
}

/** Corridors a wrapped edge from `a` to `b` crosses, or none when it does not wrap. */
export function wrapGaps(a: Placed, b: Placed, gaps: number[] = []): number[] {
  if (b.x >= a.x + a.w + 24) return [];
  return gaps.filter((g) => g > a.y + a.h && g < b.y).sort((x, y) => x - y);
}

/**
 * One source of truth for edges, endpoint dots, hit areas, labels and moving goods.
 * Neighbours connect directly. Offset cards use one straight middle lane with
 * rounded turns beside the ports; detours are only needed when a card blocks it.
 */
export function routeEdge(a: Placed, b: Placed, obstacles: Placed[], opts: RouteOptions = {}): EdgeRoute {
  const grow = (r: Placed, pad: number): Placed => ({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 });
  const others = obstacles.filter((r) => r !== a && r !== b && !(r.x === a.x && r.y === a.y && r.w === a.w) && !(r.x === b.x && r.y === b.y && r.w === b.w));
  const boxes = [...others.map((r) => grow(r, 6)), ...(opts.decorations ?? []).map((r) => grow(r, 2))];
  if (opts.returning) {
    const stacked = Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x);
    const sides: Port["dir"][] = stacked ? ["right", "left", "up", "down"] : ["up", "down", "right", "left"];
    const at = (r: Placed, dir: Port["dir"]): Port => ({ dir, x: dir === "left" ? r.x : dir === "right" ? r.x + r.w : Math.round(r.x + r.w / 2), y: dir === "up" ? r.y : dir === "down" ? r.y + r.h : Math.round(r.y + r.h / 2) });
    for (const dir of sides) for (const lift of [40, 76, 120, 200]) {
      const p0 = at(a, dir), p1 = at(b, dir), vertical = dir === "left" || dir === "right";
      const lane = dir === "left" ? Math.min(a.x, b.x) - lift : dir === "right" ? Math.max(a.x + a.w, b.x + b.w) + lift : dir === "up" ? Math.min(a.y, b.y) - lift : Math.max(a.y + a.h, b.y + b.h) + lift;
      const path = softPath(vertical ? [p0, { x: lane, y: p0.y }, { x: lane, y: p1.y }, p1] : [p0, { x: p0.x, y: lane }, { x: p1.x, y: lane }, p1], 14);
      if (!insideAny(path.sample(), [...boxes, a, b])) return done(path, p0, p1);
    }
    // Obstructed return routes use the same collision-aware router as normal flow.
    return routeEdge(a, b, obstacles, { ...opts, returning: false });
  }
  const [p0, p1] = ports(a, b);
  if (opts.fromY !== undefined && (p0.dir === "right" || p0.dir === "left")) p0.y = opts.fromY;
  if (opts.toY !== undefined && (p1.dir === "right" || p1.dir === "left")) p1.y = opts.toY;
  const vector = (p: Port) => ({ x: p.dir === "right" ? 1 : p.dir === "left" ? -1 : 0, y: p.dir === "down" ? 1 : p.dir === "up" ? -1 : 0 });
  const v0 = vector(p0), v1 = vector(p1);
  const out = { x: p0.x + v0.x * 12, y: p0.y + v0.y * 12 };
  const inn = { x: p1.x + v1.x * 12, y: p1.y + v1.y * 12 };
  const mx = (out.x + inn.x) / 2, my = (out.y + inn.y) / 2;
  const candidates = [
    [p0, out, { x: mx, y: out.y }, { x: mx, y: inn.y }, inn, p1],
    [p0, out, { x: out.x, y: my }, { x: inn.x, y: my }, inn, p1],
    [p0, out, { x: inn.x, y: out.y }, inn, p1],
    [p0, out, { x: out.x, y: inn.y }, inn, p1],
  ];
  // Include each endpoint card in collision checks. This rules out backwards hooks
  // through the emitting card, while still allowing paths on its boundary.
  const blocked = [...boxes, a, b];
  // Prefer one uninterrupted middle lane. A length-only comparison rewards four
  // tiny rounded bends over two clean turns and creates a pointless mid-lane jog.
  const ordered = v0.y && v1.y ? [candidates[1], candidates[0], ...candidates.slice(2)] : candidates;
  const paths = ordered.map((ps) => softPath(ps, 18)).filter((p) => !insideAny(p.sample(), blocked));
  if (paths.length) return done(paths[0], p0, p1);
  const detour = corridor(out, inn, blocked);
  if (detour) return done(softPath([p0, ...detour, p1], 16), p0, p1);
  // Overlapping user-dragged cards have no collision-free solution. Endpoints
  // remain attached and recover a clear route as soon as the cards separate.
  return done(softPath(candidates[0], 12), p0, p1);
}
