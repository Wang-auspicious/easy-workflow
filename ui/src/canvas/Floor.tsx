// The floor plan under the DAG: stage columns from left to right (来源接入 · 候选处理 · 预处理 ·
// 分类校验 · 资源采集 · 内容生成 · 发布管理), the source dock, and the bottom shelf of other lines.
import type { CompiledFactory } from "../../../shared/types.ts";
import type { FactoryState } from "../../../shared/project.ts";
import { roleColors } from "../../../shared/palette.ts";
import type { BayBox } from "../../../shared/layout.ts";
import { getState, useStore } from "../store.ts";
import type { Geometry } from "./geometry.ts";
import { inspectPart, partTone } from "../../../shared/parts.ts";
import { toggleInspector } from "./Canvas.tsx";

const STAGE_TONES: Record<string, string> = {
  "来源接入": "#2563eb",
  "候选处理": "#4f46e5",
  "预处理": "#0d9488",
  "分类校验": "#16a34a",
  "资源采集": "#ca8a04",
  "内容生成": "#7c3aed",
  "发布管理": "#dc2626",
};

export function Floor({ geo, hover, onHover }: { geo: Geometry; hover: string | null; onHover: (k: string | null) => void }) {
  useStore((s) => s.version);
  const s = getState();
  const factory = s.factory!;
  return (
    <>
      {geo.bays.map((b, idx) => (
        <StageColumn key={b.id} bay={b} isLast={idx === geo.bays.length - 1} factory={factory} fs={s.fs} />
      ))}
      {geo.docks.map((d) => {
        const members = d.members.filter((k) => geo.dockOf[k] === d.id);
        const awake = members.filter((k) => !factory.nodes.find((n) => n.key === k)?.dormant).length;
        return (
          <div
            key={d.id}
            className={`dock ${hover === d.id ? "is-hover" : ""}`}
            data-node={d.id}
            style={{ left: d.place.x, top: d.place.y, width: d.place.w, height: d.place.h }}
            onPointerEnter={() => onHover(d.id)}
            onPointerLeave={() => onHover(null)}
          >
            <div className="dock-head">
              <b>来源接入</b>
              <span>{awake ? `${awake} 激活` : `休眠 ${members.length}`}</span>
            </div>
          </div>
        );
      })}
      {geo.shelf && (
        <div className="shelf" style={{ left: geo.shelf.x, top: geo.shelf.y, width: geo.shelf.w, height: geo.shelf.h }}>
          <div className="shelf-label">
            <b>其他流水线（{geo.capsules.length} 个，待接入）</b>
          </div>
        </div>
      )}
    </>
  );
}

function StageColumn({ bay, isLast, factory, fs }: { bay: BayBox; isLast: boolean; factory: CompiledFactory; fs: FactoryState }) {
  const ns = bay.stations.map((k) => factory.nodes.find((n) => n.key === k)!).filter(Boolean);
  const busy = ns.reduce((s, n) => s + (fs.nodes[n.key]?.active.length ?? 0), 0);
  const queued = ns.reduce((s, n) => s + (fs.nodes[n.key]?.queue.length ?? 0), 0);
  const c = roleColors(ns.find((n) => n.kind !== "store")?.role ?? ns[0]?.role ?? "process");
  const tone = partTone(bay.name);
  const summary = inspectPart(factory, fs, bay);
  const name = bay.name === bay.line ? factory.lines.find((l) => l.id === bay.line)?.name ?? bay.name : bay.name;

  return (
    <div
      className={`bay ${busy ? "is-busy" : ""} ${isLast ? "is-last" : ""}`}
      data-part={bay.id}
      style={{
        left: bay.x,
        top: bay.y,
        width: bay.w,
        height: bay.h,
        ["--c" as string]: tone,
        ["--soft" as string]: c.soft,
      }}
    >
      <button className="bay-label" aria-label={`查看${name}详情`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); toggleInspector(bay.id, "part"); }}>
        <b>{name}</b><em className="num">{summary.totals.stations} 工位{busy ? ` · ${busy} 运行` : queued ? ` · ${queued} 排队` : ""}</em><span className="part-open">查看详情 ↗</span>
      </button>
    </div>
  );
}
