import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "../server/spec/compile.ts";
import { pack } from "../packs/vislexicon/pack.ts";
import { decorationsOf, layoutFactory, ports, routeEdge, type LayoutResult, type Placed, type Pt } from "../shared/layout.ts";
import type { CompiledEdge, CompiledFactory, CompiledNode } from "../shared/types.ts";
import { geometry } from "../ui/src/canvas/geometry.ts";

const emptyLayout = () => ({ pos: {}, open: {}, colors: {}, bots: {}, capsules: {} });
const node = (key: string, line = "line"): CompiledNode => ({
  key, id: key, line, layer: 3, name: key, role: "process", kind: "agent", input: "*", output: "*",
  rules: [], accept: [], resource: "none", estimateSeconds: 0,
  workers: { min: 0, max: 1, initial: 0, policy: "fixed" },
  bot: { shape: "circle", hue: 0, eyes: "dot", seed: 0 },
});
function fixture(ns: CompiledNode[], edges: CompiledEdge[], pos: Record<string, Placed>) {
  const lines = [...new Set(ns.map((n) => n.line))].map((id) => ({ id, name: id, layer: 3 as const, priority: "mid" as const, blurb: "", stations: ns.filter((n) => n.line === id), edges: [], wired: true }));
  const f: CompiledFactory = { nodes: ns, edges, lines, packs: [], channels: [], resources: { browser: 0, model: 0, cpu: 0, http: 0 }, issues: [], digest: "fixture", specVersion: "fixture", ui: { order: lines.map((l) => l.id), hints: {}, collapsed: [] } };
  const def: LayoutResult = { pos, via: {}, lines: {}, capsules: {}, layers: [] };
  return { f, def };
}
const edge = (from: string, to: string, kind: CompiledEdge["kind"] = "flow"): CompiledEdge => ({ key: `${from}->${to}:${kind}`, from, to, kind });

/** Sample the SVG actually supplied to the renderer, rather than a parallel route model. */
function sample(d: string): Pt[] {
  const tokens = d.match(/[MLCQ]|-?\d+(?:\.\d+)?/g) ?? [];
  const out: Pt[] = [];
  let i = 0, p = { x: 0, y: 0 };
  const point = () => ({ x: Number(tokens[i++]), y: Number(tokens[i++]) });
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === "M") { p = point(); out.push(p); continue; }
    const a = p, b = point();
    const c = command === "L" ? b : point();
    const end = command === "C" ? point() : c;
    for (let k = 1; k <= 80; k++) {
      const t = k / 80, u = 1 - t;
      out.push(command === "C"
        ? { x: u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * end.x, y: u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * end.y }
        : command === "Q"
          ? { x: u * u * a.x + 2 * u * t * b.x + t * t * end.x, y: u * u * a.y + 2 * u * t * b.y + t * t * end.y }
          : { x: a.x * u + end.x * t, y: a.y * u + end.y * t });
    }
    p = end;
  }
  return out;
}
const inside = (p: Pt, r: Placed) => p.x > r.x + 1 && p.x < r.x + r.w - 1 && p.y > r.y + 1 && p.y < r.y + r.h - 1;

test("dragging a station past another switches to facing ports, without a backwards loop", () => {
  const [from, to] = ports({ x: 500, y: 0, w: 200, h: 80 }, { x: 0, y: 0, w: 200, h: 80 });
  assert.equal(from.dir, "left");
  assert.equal(to.dir, "right");
});

test("live geometry reroutes an edge around a station dragged into its path", () => {
  const { f, def } = fixture([node("a"), node("b"), node("obstacle")], [edge("a", "b")], {
    a: { x: 0, y: 100, w: 200, h: 80 }, b: { x: 700, y: 100, w: 200, h: 80 },
    obstacle: { x: 340, y: 350, w: 200, h: 80 },
  });
  const clear = geometry(f, def, emptyLayout());
  const moved = geometry(f, def, { ...emptyLayout(), pos: { obstacle: { x: 340, y: 100 } } });
  assert.notEqual(moved.edges[0].d, clear.edges[0].d, "unrelated edge must react when its corridor becomes occupied");
  assert.ok(sample(moved.edges[0].d).every((p) => !inside(p, moved.place.obstacle)), "the visible edge must not pass through the dragged card");
});

test("moving an endpoint discards obsolete rank waypoints instead of stretching them", () => {
  const { f, def } = fixture([node("a"), node("b")], [edge("a", "b")], {
    a: { x: 0, y: 0, w: 200, h: 80 }, b: { x: 800, y: 0, w: 200, h: 80 },
  });
  def.via[f.edges[0].key] = [{ x: 400, y: 300 }];
  const g = geometry(f, def, { ...emptyLayout(), pos: { a: { x: 540, y: 0 } } });
  assert.ok(sample(g.edges[0].d).every((p) => p.y >= -20 && p.y <= 100), "short unobstructed edge must stay near its current endpoints");
});

test("return path starts at the rejecting station and ends at the repair station", () => {
  const { f, def } = fixture([node("review"), node("repair")], [edge("review", "repair", "return")], {
    review: { x: 600, y: 0, w: 200, h: 80 }, repair: { x: 0, y: 0, w: 200, h: 80 },
  });
  const g = geometry(f, def, emptyLayout()), points = sample(g.returns[0].d);
  assert.ok(points[0].x >= 600 && points[0].x <= 800, "return origin is the review station");
  assert.ok(points.at(-1)!.x >= 0 && points.at(-1)!.x <= 200, "return destination is the repair station");
});

test("the factory composes a dense working area with a short vertical review branch", () => {
  const f = compile([pack]);
  const def = layoutFactory(f.nodes, f.edges, f.ui.order, f.ui.hints, f.ui.collapsed);
  const g = geometry(f, def, emptyLayout());
  // The work camera now opens at reading scale; fitting the entire factory is
  // explicitly a navigation view. Verify readable card geometry rather than
  // shrinking every station to satisfy a fixed full-factory width.
  assert.ok(Object.values(g.bounds).every(Number.isFinite));
  for (const { node, place } of g.nodes) if (node.kind !== "source") {
    assert.ok(place.w >= 240 && place.h >= 170, `${node.key} must fit its title, metrics and status`);
  }
  const review = g.place["curation/classify-review"], arbiter = g.place["curation/arbiter"];
  assert.equal(review.x, arbiter.x);
  const branch = g.edges.find((e) => e.edge.from === "curation/classify-review" && e.edge.to === "curation/arbiter")!;
  assert.equal(branch.fromPort.dir, "down");
  assert.equal(branch.toPort.dir, "up");
  assert.ok(branch.length <= arbiter.y - review.y - review.h + 1, "vertical neighbours must not detour sideways");
  const area = def.workArea!;
  assert.ok(g.nodes.filter(({ place: p }) => p.x >= area.x && p.x + p.w <= area.x + area.w && p.y >= area.y && p.y + p.h <= area.y + area.h).length >= 9, "working area contains a complete acquisition part and its upstream decision");
  for (const e of g.edges) {
    assert.ok(g.place[e.from], `visible source ${e.from}`);
    assert.ok(g.place[e.to], `visible target ${e.to}`);
  }
});

test("adjacent-column branches keep one straight stem instead of jogging midway", () => {
  for (const [a, b] of [
    [{ x: 0, y: 288, w: 280, h: 228 }, { x: 318, y: 0, w: 280, h: 228 }],
    [{ x: 318, y: 288, w: 280, h: 228 }, { x: 0, y: 864, w: 280, h: 228 }],
  ]) {
    const route = routeEdge(a, b, [a, b]);
    assert.equal((route.d.match(/C/g) ?? []).length, 2, "only the two turns beside the ports should be rounded");
    const points = sample(route.d);
    const stem = points.filter((p) => p.y > Math.min(route.fromPort.y, route.toPort.y) + 20 && p.y < Math.max(route.fromPort.y, route.toPort.y) - 20);
    assert.ok(stem.length > 0);
    assert.ok(stem.every((p) => Math.abs(p.x - stem[0].x) < 0.1), "the middle of the connector is a single vertical line");
  }
});

test("every real flow, channel and return keeps visible endpoints and avoids unrelated cards", () => {
  const f = compile([pack]), def = layoutFactory(f.nodes, f.edges, f.ui.order, f.ui.hints, f.ui.collapsed);
  const freeX = Math.max(...Object.values(def.pos).map((p) => p.x + p.w)) + 180;
  // Keep the moved capsule outside the candidate column; overlapping an endpoint
  // with another card has no collision-free route and is tested as attachment only.
  const freeLeft = Math.min(...Object.values(def.pos).map((p) => p.x)) - def.capsules.components.w - 80;
  for (const overrides of [emptyLayout(), { ...emptyLayout(), pos: { "curation/identity": { x: freeX, y: 400 } } }, { ...emptyLayout(), capsules: { components: { x: freeLeft, y: 400 } } }]) {
    const g = geometry(f, def, overrides);
    const evidenceOf = g.nodes.map(({ node, place: p }) => ({ key: node.key, boxes: decorationsOf(node, p) }));
    for (const route of [...g.edges, ...g.returns]) {
      const points = sample(route.d);
      assert.deepEqual(points[0], { x: route.fromPort.x, y: route.fromPort.y });
      assert.deepEqual(points.at(-1), { x: route.toPort.x, y: route.toPort.y });
      for (const [key, p] of Object.entries(g.place)) {
        if (key === route.from || key === route.to) continue;
        assert.ok(points.every((point) => !inside(point, p)), `${route.edge.key} crosses visible ${key}`);
      }
      for (const ev of evidenceOf) if (ev.key !== route.from && ev.key !== route.to) for (const p of ev.boxes) assert.ok(points.every((point) => !inside(point, p)), `${route.edge.key} crosses screenshot/status space of ${ev.key}`);
    }
    const represented = [...g.edges, ...g.returns].flatMap((route) => route.members.map((e) => e.key));
    const visibleKey = (key: string) => g.capsuleOf[key] ? `capsule:${g.capsuleOf[key]}` : key;
    const expected = f.edges.filter((e) => visibleKey(e.from) !== visibleKey(e.to)).map((e) => e.key);
    assert.deepEqual(represented.sort(), expected.sort(), "folding may aggregate routes but cannot discard original relationships");
  }
});

test("default screenshot strips, station bodies and status lines have separate physical space", () => {
  const f = compile([pack]), def = layoutFactory(f.nodes, f.edges, f.ui.order, f.ui.hints, f.ui.collapsed);
  const g = geometry(f, def, emptyLayout());
  const areas = g.nodes.flatMap(({ node, place: p }) => {
    const body = [{ id: `${node.key}:body`, ...p }];
    return [...body, ...decorationsOf(node, p).map((r, i) => ({ id: `${node.key}:${i ? "status" : "decor"}`, ...r }))];
  });
  for (let i = 0; i < areas.length; i++) for (let j = i + 1; j < areas.length; j++) {
    const a = areas[i], b = areas[j];
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} overlaps ${b.id}`);
  }
});

test("opening several capsules allocates separate line areas and preserves every station", () => {
  const f = compile([pack]), def = layoutFactory(f.nodes, f.edges, f.ui.order, f.ui.hints, f.ui.collapsed);
  const g = geometry(f, def, { ...emptyLayout(), open: { components: true, "atlas-feed": true } });
  const rectangles = g.nodes.map((n) => n.place);
  for (let i = 0; i < rectangles.length; i++) for (let j = i + 1; j < rectangles.length; j++) {
    const a = rectangles[i], b = rectangles[j];
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `stations ${g.nodes[i].node.key} and ${g.nodes[j].node.key} overlap after expansion`);
  }
  assert.equal(g.nodes.length, 29 + 9 + 5);
  assert.equal(g.capsules.length, 4);
});

test("an empty compiled graph has finite canvas bounds", () => {
  const { f, def } = fixture([], [], {});
  const g = geometry(f, def, emptyLayout());
  assert.ok(Object.values(g.bounds).every(Number.isFinite));
});

test("logical phase bounds still contain their stations in the compact layout", () => {
  const f = compile([pack]), def = layoutFactory(f.nodes, f.edges, f.ui.order, f.ui.hints, f.ui.collapsed);
  const bays = def.bays!;
  assert.deepEqual(bays.slice(0, 6).map((b) => b.name), ["来源接入", "候选与分流", "分类校验", "资源采集", "内容生成", "发布管理"]);
  for (const b of bays) for (const k of b.stations) {
    const p = def.pos[k] ?? def.capsules[b.line];
    assert.ok(p.x >= b.x && p.x + p.w <= b.x + b.w && p.y >= b.y && p.y + p.h <= b.y + b.h, `${k} sits inside bay ${b.name}`);
  }
  // Single left-to-right flow: all bays sit in row 0.
  assert.ok(bays.every((b) => b.row === 0));
});

test("return paths remain outside both endpoint cards, including vertically stacked pairs", () => {
  const f = compile([pack]), def = layoutFactory(f.nodes, f.edges, f.ui.order, f.ui.hints, f.ui.collapsed);
  const g = geometry(f, def, emptyLayout());
  assert.ok(g.returns.length >= 3, "return loops exist for reject edges");
  for (const ret of g.returns) {
    for (const key of [ret.from, ret.to]) assert.ok(sample(ret.d).every((p) => !inside(p, g.place[key])), `return must not disappear behind ${key}`);
  }
  const a = { x: 0, y: 288, w: 280, h: 228 }, b = { x: 0, y: 0, w: 280, h: 228 };
  const path = routeEdge(a, b, [a, b], { returning: true });
  assert.ok(sample(path.d).every((p) => !inside(p, a) && !inside(p, b)));
});

test("intake is compact and all business branches enter one aligned column", () => {
  const f = compile([pack]), def = layoutFactory(f.nodes, f.edges, f.ui.order, f.ui.hints, f.ui.collapsed);
  const g = geometry(f, def, emptyLayout());
  const dock = g.docks[0].place, prep = g.place["candidates/tidy"];
  assert.ok(prep.x - dock.x - dock.w <= 90, "source and preparation are actual neighbours");
  assert.deepEqual(f.nodes.filter((n) => n.line === "candidates").map((n) => n.id), ["tidy", "pool", "route"]);
  const branches = g.edges.filter((e) => e.from === "candidates/route");
  assert.ok(branches.length >= 4);
  assert.equal(new Set(branches.map((e) => g.place[e.to].x)).size, 1);
  assert.ok(branches.every((e) => !e.quiet), "branch destinations must not be hidden as channels");
  for (let i = 0; i < g.bays.length; i++) for (let j = i + 1; j < g.bays.length; j++) {
    const a = g.bays[i], b = g.bays[j];
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `parts ${a.name} and ${b.name} overlap`);
  }
});

test("dormant sources sit in one dock whose single edge still carries every source relation", () => {
  const f = compile([pack]), def = layoutFactory(f.nodes, f.edges, f.ui.order, f.ui.hints, f.ui.collapsed);
  const g = geometry(f, def, emptyLayout());
  const dock = g.docks.find((d) => d.line === "sources")!;
  for (const k of dock.members) { const p = g.place[k]; assert.ok(p.x >= dock.place.x && p.x + p.w <= dock.place.x + dock.place.w && p.y >= dock.place.y && p.y + p.h <= dock.place.y + dock.place.h, `${k} inside the dock`); }
  const out = g.edges.filter((e) => e.from === dock.id);
  assert.equal(out.length, 1);
  assert.equal(out[0].members.length, 6);
  // Dragging one chip out gives it back its own edge.
  const moved = geometry(f, def, { ...emptyLayout(), pos: { "sources/x": { x: -400, y: 40 } } });
  assert.ok(moved.edges.some((e) => e.from === "sources/x"));
  assert.equal(moved.edges.find((e) => e.from === dock.id)!.members.length, 5);
});
