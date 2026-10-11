// Goods flowing along the edges: every transfer in the journal becomes a cargo tag — a
// coloured dot with the item's domain — riding its bezier (CSS offset-path). Long carriage
// returns take a little longer than short hops; returns ride amber and backwards (§10.5).
import { useEffect, useRef, useState } from "react";
import { roleColors } from "../../../shared/palette.ts";
import { getState, onEvent, setState } from "../store.ts";
import type { Geometry } from "./geometry.ts";
import { shortItem } from "./stats.ts";

interface P { id: number; edge: string; token: string; label: string; color: string; ret: boolean; delay: number }
let seq = 0;

export function Particles({ geo }: { geo: Geometry }) {
  const [ps, setPs] = useState<P[]>([]);
  const geoRef = useRef(geo);
  geoRef.current = geo;
  const lastPerEdge = useRef(new Map<string, number>());

  useEffect(() => onEvent((e) => {
    if (e.kind !== "token.queued" || !e.from) return;
    const g = geoRef.current;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || document.hidden) return;
    let edge: string | undefined, color = "", ret = false;
    if (e.returned) {
      const r = g.returns.flatMap((x) => x.members).find((x) => x.to === e.node && (x.from === e.from || e.from === "human"));
      edge = r?.key; color = "oklch(0.72 0.15 70)"; ret = true;
    } else {
      const f = g.edges.flatMap((x) => x.members).find((x) => x.from === e.from && x.to === e.node);
      edge = f?.key;
      const role = getState().factory!.nodes.find((n) => n.key === e.from)?.role ?? "process";
      color = roleColors(role).strong;
    }
    if (!edge) return;
    // Several goods on one edge at once travel as a short convoy.
    const key = `${e.from}->${e.node}`;
    const now = performance.now();
    const prev = lastPerEdge.current.get(key) ?? 0;
    const delay = Math.max(0, prev + 220 - now);
    lastPerEdge.current.set(key, now + delay);
    const item = getState().fs.tokens[e.token]?.item ?? "";
    setPs((list) => [...list.slice(-60), { id: ++seq, edge, token: e.token, label: shortItem(item), color, ret, delay }]);
  }), []);

  return (
    <div className="particles">
      {ps.map((p) => {
        // Dragging and folding affect in-flight goods as well as static edge strokes.
        const route = (p.ret ? geo.returns : geo.edges).find((e) => e.members.some((member) => member.key === p.edge));
        if (!route) return null;
        const ms = Math.round(Math.min(2400, Math.max(760, route.length * 1.1)));
        return (
          <span key={p.id} className={`cargo ${p.ret ? "is-return" : ""}`}
            style={{ offsetPath: `path('${route.d}')`, animationDelay: `${p.delay}ms`, animationDuration: `${ms}ms`, ["--pc" as string]: p.color }}
            onPointerEnter={() => setState({ trail: p.token })} onPointerLeave={() => setState({ trail: null })}
            onAnimationEnd={() => setPs((list) => list.filter((x) => x.id !== p.id))}>
            <i />{p.label && <b>{p.label}</b>}
          </span>
        );
      })}
    </div>
  );
}
