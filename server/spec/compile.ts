// Spec compiler (Spec §9.3): packs + accepted patches → one runtime graph, the canvas
// graph and a validation report. The DAG never exists without the Spec: every node and
// edge the canvas draws comes from here, and layout never feeds back into it.
import crypto from "node:crypto";
import type { CompiledEdge, CompiledFactory, CompiledNode, EdgeSpec, LineSpec, StationSpec } from "../../shared/types.ts";
import { botFor } from "../../shared/palette.ts";
import type { Pack } from "./dsl.ts";

export const SPEC_VERSION = "2026-10-09.1";

/** A patch is a small, ordered, reversible edit of the default spec (Spec §9.4). */
export type PatchOp =
  | { op: "set"; station: string; field: "workers.min" | "workers.max" | "workers.initial" | "workers.policy" | "estimateSeconds" | "dormant" | "name" | "blurb"; value: unknown }
  | { op: "add-station"; line: string; station: Partial<StationSpec> & { id: string; name: string }; after: string; before?: string }
  | { op: "remove-station"; station: string }
  | { op: "add-edge"; from: string; to: string; when?: string }
  | { op: "remove-edge"; from: string; to: string };

export interface Patch { id: string; summary: string; ops: PatchOp[]; author: "user" | "dispatcher"; at: string; status: "proposed" | "accepted" | "rejected" }

const clone = <T>(v: T): T => structuredClone(v);

function applyPatch(lines: LineSpec[], links: EdgeSpec[], patch: Patch, issues: CompiledFactory["issues"]) {
  const find = (key: string) => {
    const [l, s] = key.split("/");
    const ln = lines.find((x) => x.id === l);
    return { ln, st: ln?.stations.find((x) => x.id === s), sid: s };
  };
  for (const op of patch.ops) {
    if (op.op === "set") {
      const { st } = find(op.station);
      if (!st) { issues.push({ at: patch.id, message: `set: unknown station ${op.station}` }); continue; }
      const numeric = ["workers.min", "workers.max", "workers.initial", "estimateSeconds"].includes(op.field);
      const valid = numeric ? typeof op.value === "number" && Number.isFinite(op.value) && op.value >= 0 && (op.field === "estimateSeconds" || Number.isInteger(op.value))
        : op.field === "workers.policy" ? op.value === "auto" || op.value === "fixed"
        : op.field === "dormant" ? typeof op.value === "boolean"
        : ["name", "blurb"].includes(op.field) && typeof op.value === "string";
      if (!valid) { issues.push({ at: patch.id, message: `invalid value for ${op.field}` }); continue; }
      if (op.field.startsWith("workers.")) (st.workers as unknown as Record<string, unknown>)[op.field.slice(8)] = op.value;
      else (st as unknown as Record<string, unknown>)[op.field] = op.value;
    } else if (op.op === "add-station") {
      const ln = lines.find((x) => x.id === op.line);
      if (!ln) { issues.push({ at: patch.id, message: `add-station: unknown line ${op.line}` }); continue; }
      ln.stations.push({
        rules: [], accept: ["added by patch: review its output"], resource: "model", estimateSeconds: 6, input: "*", output: "*",
        workers: { min: 1, max: 2, initial: 1, policy: "auto" }, role: "review", kind: "review", ...op.station,
      } as StationSpec);
      const before = op.before ?? ln.edges.find((e) => e.from === op.after && e.kind !== "return")?.to;
      if (before) {
        ln.edges = ln.edges.filter((e) => !(e.from === op.after && e.to === before));
        ln.edges.push({ from: op.after, to: op.station.id, kind: "flow" }, { from: op.station.id, to: before, kind: "flow" });
      } else ln.edges.push({ from: op.after, to: op.station.id, kind: "flow" });
    } else if (op.op === "remove-station") {
      const { ln, sid } = find(op.station);
      if (!ln) { issues.push({ at: patch.id, message: `remove-station: unknown ${op.station}` }); continue; }
      const ins = ln.edges.filter((e) => e.to === sid && e.kind !== "return"), outs = ln.edges.filter((e) => e.from === sid && e.kind !== "return");
      ln.edges = ln.edges.filter((e) => e.to !== sid && e.from !== sid);
      for (const a of ins) for (const b of outs) if (!ln.edges.some((e) => e.from === a.from && e.to === b.to)) ln.edges.push({ from: a.from, to: b.to, when: a.when ?? b.when, kind: "flow" });
      ln.stations = ln.stations.filter((s) => s.id !== sid);
      for (const s of ln.stations) if (s.returnTo) s.returnTo = s.returnTo.filter((r) => r.station !== sid);
    } else if (op.op === "add-edge" || op.op === "remove-edge") {
      const [la] = op.from.split("/"), [lb] = op.to.split("/");
      const fa = op.from.split("/")[1], tb = op.to.split("/")[1];
      if (la === lb) {
        const ln = lines.find((x) => x.id === la);
        if (!ln) { issues.push({ at: patch.id, message: `unknown line ${la}` }); continue; }
        if (op.op === "add-edge") ln.edges.push({ from: fa, to: tb, when: op.when, kind: "flow" });
        else ln.edges = ln.edges.filter((e) => !(e.from === fa && e.to === tb));
      } else if (op.op === "add-edge") links.push({ from: op.from, to: op.to, when: op.when, kind: "flow" });
      else { const i = links.findIndex((e) => e.from === op.from && e.to === op.to); if (i >= 0) links.splice(i, 1); }
    }
  }
}

export function compile(packs: Pack[], patches: Patch[] = []): CompiledFactory {
  const issues: CompiledFactory["issues"] = [];
  const lines: LineSpec[] = clone(packs.flatMap((p) => p.lines));
  const links: EdgeSpec[] = clone(packs.flatMap((p) => p.links));
  const conditions = Object.assign({}, ...packs.map((p) => p.conditions)) as Pack["conditions"];
  for (const patch of patches.filter((p) => p.status === "accepted")) applyPatch(lines, links, patch, issues);

  const nodes: CompiledNode[] = [];
  const byKey = new Map<string, CompiledNode>();
  for (const ln of lines) for (const st of ln.stations) {
    const key = `${ln.id}/${st.id}`;
    if (byKey.has(key)) { issues.push({ at: key, message: "duplicate station id" }); continue; }
    const n: CompiledNode = { ...st, key, line: ln.id, layer: ln.layer, bot: botFor(key, st.role, st.bot) };
    nodes.push(n); byKey.set(key, n);
  }
  const edges: CompiledEdge[] = [];
  const pushEdge = (e: EdgeSpec, from: string, to: string) => {
    const kind = e.kind ?? "flow";
    const key = `${from}->${to}${kind === "flow" ? "" : `:${kind}`}`;
    if (!byKey.has(from) || !byKey.has(to)) { issues.push({ at: key, message: `edge end not found` }); return; }
    if (e.when && !conditions[e.when]) issues.push({ at: key, message: `unknown condition "${e.when}"` });
    edges.push({ key, from, to, kind, when: e.when, label: e.label });
  };
  for (const ln of lines) for (const e of ln.edges) pushEdge(e, `${ln.id}/${e.from}`, `${ln.id}/${e.to}`);
  for (const e of links) pushEdge(e, e.from, e.to);
  for (const n of nodes) for (const r of n.returnTo ?? []) {
    const to = `${n.line}/${r.station}`;
    if (!byKey.has(to)) { issues.push({ at: n.key, message: `return target ${to} not found` }); continue; }
    if (!(r.maxRounds > 0)) issues.push({ at: n.key, message: "return edge needs maxRounds > 0" });
    edges.push({ key: `${n.key}->${to}:return`, from: n.key, to, kind: "return", maxRounds: r.maxRounds, label: `退回 ≤${r.maxRounds} 轮` });
  }
  const channels = packs.flatMap((p) => p.channels);
  for (const c of channels) {
    const from = `${c.from.line}/${c.from.station}`, to = `${c.to.line}/${c.to.station}`;
    if (!byKey.has(from) || !byKey.has(to)) { issues.push({ at: c.id, message: "channel end not found" }); continue; }
    edges.push({ key: `${from}->${to}:channel`, from, to, kind: "channel", label: c.label });
  }

  // Checks (Spec F1.4): acyclic flow, compatible I/O, acceptance on every runnable station.
  const flow = edges.filter((e) => e.kind === "flow");
  const state = new Map<string, 0 | 1 | 2>();
  const out = new Map<string, string[]>();
  for (const e of flow) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const dfs = (k: string): boolean => {
    if (state.get(k) === 1) return true;
    if (state.get(k) === 2) return false;
    state.set(k, 1);
    for (const t of out.get(k) ?? []) if (dfs(t)) { issues.push({ at: `${k}->${t}`, message: "cycle in flow edges (only return edges may loop)" }); return false; }
    state.set(k, 2);
    return false;
  };
  for (const n of nodes) dfs(n.key);
  for (const e of flow) {
    const a = byKey.get(e.from)!, b = byKey.get(e.to)!;
    const accepts = b.input.split("|");
    if (b.input !== "*" && a.output !== "*" && !accepts.includes(a.output)) issues.push({ at: e.key, message: `I/O mismatch: ${a.output} → ${b.input}` });
  }
  for (const n of nodes) {
    const runnable = n.kind !== "source" && n.kind !== "store";
    if (runnable && !n.accept.length && lines.find((l) => l.id === n.line)?.wired) issues.push({ at: n.key, message: "runnable station without acceptance conditions" });
    if (runnable && n.workers.min > n.workers.max) issues.push({ at: n.key, message: "workers.min > workers.max" });
    if (!["none", "browser", "model", "cpu", "http"].includes(n.resource)) issues.push({ at: n.key, message: "invalid resource class" });
    if (![n.workers.min, n.workers.max, n.workers.initial].every((v) => Number.isInteger(v) && v >= 0)) issues.push({ at: n.key, message: "worker counts must be non-negative integers" });
    if (n.workers.initial < n.workers.min || n.workers.initial > n.workers.max) issues.push({ at: n.key, message: "workers.initial must be within min/max" });
    if (runnable && !n.dormant && lines.find((l) => l.id === n.line)?.wired && n.workers.max < 1) issues.push({ at: n.key, message: "runnable station needs at least one worker" });
  }

  const runtimeGraph = {
    nodes: nodes.map(({ bot, ...rest }) => ({ ...rest, bot: { shape: bot.shape, hue: bot.hue, eyes: bot.eyes } })),
    edges, channels,
  };
  const digest = crypto.createHash("sha256").update(JSON.stringify(runtimeGraph)).digest("hex").slice(0, 16);
  const resources = Object.assign({}, ...packs.map((p) => p.resources));
  return {
    specVersion: SPEC_VERSION,
    packs: packs.map((p) => ({ id: p.id, name: p.name, version: p.version, blurb: p.blurb })),
    lines, nodes, edges, channels, resources, issues, digest,
    ui: {
      order: packs.flatMap((p) => p.order),
      collapsed: packs.flatMap((p) => p.collapsed),
      hints: Object.assign({}, ...packs.map((p) => p.hints)),
    },
  };
}
