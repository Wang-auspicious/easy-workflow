// Small read-only views over the projection that the floor plan shows in several places.
import type { CompiledFactory } from "../../../shared/types.ts";
import { median, type FactoryState } from "../../../shared/project.ts";

/** "https://www.polished.js.org/x" → "polished.js.org". */
export const shortItem = (s: string) => s.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

/** The station that sets the line's pace: the slowest per-worker median, once measured. */
export function bottleneck(fs: FactoryState, factory: CompiledFactory, line: string): { key: string; ms: number } | null {
  let best: { key: string; ms: number } | null = null;
  for (const n of factory.nodes) {
    if (n.line !== line || n.kind === "store" || n.kind === "source") continue;
    const st = fs.nodes[n.key];
    if (!st || st.durations.length < 2) continue;
    const ms = median(st.durations) / Math.max(1, st.workers.length);
    if (!best || ms > best.ms) best = { key: n.key, ms };
  }
  return best && best.ms >= 1000 ? best : null;
}

/** Stations a token has passed through, in order (consecutive repeats folded). */
export function trailOf(fs: FactoryState, token: string): string[] {
  const t = fs.tokens[token];
  if (!t) return [];
  const out: string[] = [];
  for (const id of t.attempts) {
    const node = fs.attempts[id]?.node;
    if (node && out[out.length - 1] !== node) out.push(node);
  }
  for (const node of t.at) if (out[out.length - 1] !== node) out.push(node);
  if (t.finishedAtNode && out[out.length - 1] !== t.finishedAtNode) out.push(t.finishedAtNode);
  return out;
}
