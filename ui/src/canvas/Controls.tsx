// Bottom-left round buttons (Spec §10.2): zoom, fit all, follow, layers, reset layout.
import { useEffect, useId, useRef, useState } from 'react';
import { Minus, Plus, Maximize, Crosshair, Layers, RotateCcw } from "lucide-react";
import { setState, useStore, type Layer } from "../store.ts";
import type { Camera } from "./Canvas.tsx";

const LAYERS: { id: Layer; label: string; hint: string }[] = [
  { id: "pipeline", label: "流水线", hint: "谁在干什么、货流到哪" },
  { id: "spec", label: "Spec", hint: "每个节点挂上规则与验收条件" },
  { id: "channels", label: "信道", hint: "线与线之间的事件流" },
];

export function Controls({ cam, zoomBy, fitAll, focusWork, resetLayout }: { cam: Camera; zoomBy: (f: number) => void; fitAll: () => void; focusWork: () => void; resetLayout: () => void }) {
  const follow = useStore((s) => s.follow);
  const layer = useStore((s) => s.layer);
  const [menu, setMenu] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!menu) return;
    root.current?.querySelector<HTMLButtonElement>('[role=menuitemradio][aria-checked=true]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setMenu(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setMenu(false);
        trigger.current?.focus();
      }
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [menu]);
  return (
    <div ref={root} className="controls" onPointerDown={(e) => e.stopPropagation()}
      onBlur={event => {if (!event.currentTarget.contains(event.relatedTarget)) setMenu(false);}}>
      <div className="ctl-group">
        <button className="icon-btn" onClick={() => zoomBy(1 / 1.25)} aria-label="缩小画布" data-tip="缩小  −" data-tip-side="top"><Minus size={14} /></button>
        <button className="ctl-zoom num" onClick={fitAll} data-tip="适配全部  F / 双击空白" data-tip-side="top">{Math.round(cam.k * 100)}%</button>
        <button className="icon-btn" onClick={() => zoomBy(1.25)} aria-label="放大画布" data-tip="放大  +" data-tip-side="top"><Plus size={14} /></button>
      </div>
      <div className="ctl-group">
        <button className="ctl-btn" onClick={focusWork} data-tip="回到可读的工作视图  W" data-tip-side="top">工作视图</button>
        <button className="ctl-btn" onClick={fitAll} data-tip="查看全图  F" data-tip-side="top"><Maximize size={13} />全图</button>
        <button className={`ctl-btn ${follow ? "is-on" : ""}`} onClick={() => setState({ follow: !follow })} aria-label={follow ? '停止跟随' : '跟随活跃工位'} aria-pressed={follow} data-tip={follow ? "停止跟随" : "跟随活跃工位"} data-tip-side="top"><Crosshair size={13} /></button>
        <button ref={trigger} className={`ctl-btn ${layer !== "pipeline" ? "is-on" : ""}`} onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-haspopup="menu" aria-controls={menu ? menuId : undefined} data-tip="切换图层" data-tip-side="top"><Layers size={13} /> 图层</button>
        <button className="ctl-btn" onClick={resetLayout} data-tip="一键重新排列回默认布局" data-tip-side="top"><RotateCcw size={13} /> 重排</button>
      </div>
      {menu && (
        <div id={menuId} className="layer-menu" role="menu" aria-label="画布图层" onKeyDown={event => {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]')];
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }}>
          {LAYERS.map((l) => (
            <button key={l.id} role="menuitemradio" aria-checked={layer === l.id} className={layer === l.id ? "is-on" : ""} onClick={() => { setState({ layer: l.id }); setMenu(false); trigger.current?.focus(); }}>
              <b>{l.label}</b><span>{l.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
