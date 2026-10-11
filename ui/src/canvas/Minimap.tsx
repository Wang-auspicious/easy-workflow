// Minimap (bottom-right, hideable): every node as a tinted dot-rect, the viewport as a frame; drag to pan.
import { useState, type RefObject } from "react";
import { EyeOff, Map as MapIcon } from "lucide-react";
import { roleColors } from "../../../shared/palette.ts";
import { getState, useStore } from "../store.ts";
import type { Geometry } from "./geometry.ts";
import type { Camera } from "./Canvas.tsx";

const W = 180, H = 112;

export function Minimap({ geo, cam, box, setCam }: { geo: Geometry; cam: Camera; box: RefObject<HTMLDivElement | null>; setCam: (c: Camera) => void }) {
  useStore((s) => s.version);
  const [hidden, setHidden] = useState(true);
  const b = geo.bounds;
  const s = Math.min(W / (b.w + 200), H / (b.h + 200));
  const ox = (W - b.w * s) / 2 - b.x * s, oy = (H - b.h * s) / 2 - b.y * s;
  const r = box.current?.getBoundingClientRect();
  const vw = r ? r.width / cam.k : 0, vh = r ? r.height / cam.k : 0;
  const vx = -cam.x / cam.k, vy = -cam.y / cam.k;
  if (hidden) return <button className="minimap-show icon-btn" onPointerDown={(e) => e.stopPropagation()} onClick={() => setHidden(false)} data-tip="显示小地图" data-tip-side="top"><MapIcon size={15} /></button>;
  const panTo = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const wx = (e.clientX - rect.left - ox) / s, wy = (e.clientY - rect.top - oy) / s;
    if (r) setCam({ ...cam, x: r.width / 2 - wx * cam.k, y: r.height / 2 - wy * cam.k });
  };
  const fs = getState().fs;
  return (
    <div className="minimap" onPointerDown={(e) => e.stopPropagation()}>
      <svg width={W} height={H} onPointerDown={(e) => { (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId); panTo(e); }} onPointerMove={(e) => { if (e.buttons) panTo(e); }}>
        {geo.halls.map((h) => <rect key={h.id} x={ox + h.x * s} y={oy + h.y * s} width={h.w * s} height={h.h * s} rx={4} fill="#fff" stroke="#e2e1da" strokeWidth={0.6} />)}
        {geo.capsules.map(({ line, place: p }) => <rect key={line} x={ox + p.x * s} y={oy + p.y * s} width={p.w * s} height={p.h * s} rx={3} fill="#e9e8e2" />)}
        {geo.nodes.map(({ node, place: p }) => {
          const c = roleColors(node.role);
          const busy = fs.nodes[node.key]?.active.length;
          return <rect key={node.key} x={ox + p.x * s} y={oy + p.y * s} width={Math.max(2, p.w * s)} height={Math.max(2, p.h * s)} rx={1.5} fill={busy ? c.border : c.fillHover} stroke={c.border} strokeWidth={0.5} opacity={node.dormant ? 0.4 : 1} />;
        })}
        <rect x={ox + vx * s} y={oy + vy * s} width={vw * s} height={vh * s} className="minimap-view" />
      </svg>
      <button className="minimap-hide" onClick={() => setHidden(true)} data-tip="隐藏小地图" data-tip-side="top"><EyeOff size={12} /></button>
    </div>
  );
}
