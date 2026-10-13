// Spec DSL (Spec §9.2): lines and stations are plain data built with two helpers,
// so a pack reads like the Spec tables and the compiler can check every field.
import type { EdgeSpec, LineSpec, PackSpec, StationSpec } from "../../shared/types.ts";
import type { LineHint } from "../../shared/layout.ts";

type StationInput = Omit<StationSpec, "rules" | "accept" | "resource" | "workers" | "estimateSeconds" | "input" | "output"> &
  Partial<Pick<StationSpec, "rules" | "accept" | "resource" | "workers" | "estimateSeconds" | "input" | "output">>;

export function station(s: StationInput): StationSpec {
  const isStock = s.kind === "source" || s.kind === "store";
  return {
    rules: [], accept: [], resource: isStock ? "none" : "model", estimateSeconds: isStock ? 0 : 6,
    workers: isStock ? { min: 0, max: 0, initial: 0, policy: "fixed" } : { min: 1, max: 3, initial: 1, policy: "auto" },
    input: "*", output: "*",
    ...s,
  };
}

export function line(l: Omit<LineSpec, "edges"> & { edges: (EdgeSpec | [string, string] | [string, string, string])[] }): LineSpec {
  return {
    ...l,
    edges: l.edges.map((e) => (Array.isArray(e) ? { from: e[0], to: e[1], when: e[2], kind: "flow" as const } : { kind: "flow" as const, ...e })),
  };
}

/** Straight chain helper: ["a","b","c"] → a→b, b→c. */
export function chain(...ids: string[]): [string, string][] {
  return ids.slice(1).map((id, i) => [ids[i], id]);
}

export type Pack = PackSpec & {
  /** Installed packs declare executable contracts; legacy bundled packs may
   * supply their bindings through the host adapter instead. */
  contracts?: Record<string, { role: string; inputSchema: string; outputSchema: string; executor: string; revision: string; outputKey?: string }>;
  /** Edges between lines (qualified `line/station` keys). */
  links: EdgeSpec[];
  /** Named predicates used by `when` on edges. */
  conditions: Record<string, (data: Record<string, unknown>) => boolean>;
  /** Line order on the canvas, top to bottom inside each layer. */
  order: string[];
  /** Lines collapsed into capsules in the default layout. */
  collapsed: string[];
  /** Default-layout hints (visual only; never part of the compiled digest). */
  hints: Record<string, LineHint>;
};
