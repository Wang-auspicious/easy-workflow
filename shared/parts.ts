import type { CompiledFactory } from "./types.ts";
import type { FactoryState } from "./project.ts";
import type { BayBox, Placed } from "./layout.ts";

const tones: Record<string, string> = { 来源接入: "#638ebd", 候选与分流: "#7e88b5", 分类校验: "#6288c4", 资源采集: "#429d92", 内容生成: "#9476ba", 发布管理: "#b58a48", components: "#6386b1", "atlas-feed": "#76a078", skills: "#9176b1", "sci-figure": "#5997aa", ppt: "#b39467", "image-fx": "#ad788d" };
export const partTone = (name: string) => tones[name] ?? "#7e8cae";
export function partBounds(places: Placed[]): Placed {
  if (!places.length) return { x: 0, y: 0, w: 1, h: 1 };
  const x = Math.min(...places.map((p) => p.x)) - 22, y = Math.min(...places.map((p) => p.y)) - 42;
  return { x, y, w: Math.max(...places.map((p) => p.x + p.w)) - x + 22, h: Math.max(...places.map((p) => p.y + p.h)) - y + 22 };
}

/** The UI and headless API share the same aggregation, without double-counting in-flight tokens. */
export function inspectPart(factory: CompiledFactory, state: FactoryState, part: Pick<BayBox, "id" | "name" | "line" | "stations">) {
  const keys = new Set(part.stations);
  const stations = factory.nodes.filter((n) => keys.has(n.key)).map((n) => {
    const s = state.nodes[n.key];
    return { key: n.key, name: n.name, kind: n.kind, queued: s?.queue.length ?? 0, active: s?.active.length ?? 0, workers: s?.workers.length ?? 0, processed: s?.processed ?? 0, failed: s?.failed ?? 0, stock: s?.stock ?? 0, summary: s?.summary ?? "" };
  });
  const queued = new Set(part.stations.flatMap((k) => state.nodes[k]?.queue ?? []));
  const active = new Set(part.stations.flatMap((k) => state.nodes[k]?.active ?? []).map((id) => state.attempts[id]?.token).filter((id): id is string => Boolean(id)));
  const attempts = Object.values(state.attempts).filter((a) => keys.has(a.node) && (!state.run.startedAt || a.startedAt >= state.run.startedAt)).sort((a, b) => b.startedAt - a.startedAt);
  return {
    id: part.id, name: part.name, line: part.line, wired: Boolean(factory.lines.find((l) => l.id === part.line)?.wired),
    totals: { stations: stations.length, queued: queued.size, active: active.size, inFlight: new Set([...queued, ...active]).size,
      workers: stations.reduce((n, s) => n + s.workers, 0), processedSteps: stations.reduce((n, s) => n + s.processed, 0), failedSteps: stations.reduce((n, s) => n + s.failed, 0),
      tokens: part.stations.reduce((n, k) => n + (state.nodes[k]?.usage.input ?? 0) + (state.nodes[k]?.usage.output ?? 0), 0) },
    stations, recent: attempts.slice(0, 30).map((a) => ({ ...a, item: state.tokens[a.token]?.item ?? a.token })),
  };
}
