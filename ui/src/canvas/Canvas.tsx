// The infinite dotted canvas (Spec §10.1, §10.7): free pan & zoom, no levels; nodes drag
// freely and only the layout file changes; one click resets to the default layout.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getState, setState, useStore } from "../store.ts";
import { saveLayout } from "../api.ts";
import { geometry } from "./geometry.ts";
import { NodeCard } from "./Node.tsx";
import { Capsule } from "./Capsule.tsx";
import { Edges, ConnectionPorts } from "./Edges.tsx";
import { Particles } from "./Particles.tsx";
import { Hud } from "./Hud.tsx";
import { Controls } from "./Controls.tsx";
import { Minimap } from "./Minimap.tsx";
import { Inspectors } from "./Inspector.tsx";
import { ReplayBar } from "./ReplayBar.tsx";
import { Floor } from "./Floor.tsx";
import { toast } from "../shell/Toasts.tsx";

export interface Camera { x: number; y: number; k: number }
const MIN_K = 0.12, MAX_K = 2.4;

export function Canvas({ active }: { active: boolean }) {
  const factory = useStore((s) => s.factory)!;
  const def = useStore((s) => s.defaultLayout)!;
  const layout = useStore((s) => s.layout);
  const selected = useStore((s) => s.selected);
  const follow = useStore((s) => s.follow);
  const focus = useStore((s) => s.focus);
  const [live, setLive] = useState<Record<string, { x: number; y: number }> | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [cam, setCamState] = useState<Camera>({ x: 80, y: 120, k: 0.5 });
  const camRef = useRef(cam);
  const boxRef = useRef<HTMLDivElement>(null);
  const anim = useRef(0);
  const fitMode = useRef(true);
  const workMode = useRef(true);
  const gestureCleanup = useRef<(() => void) | null>(null);
  const dragFrame = useRef(0);

  const effective = useMemo(() => {
    if (!live) return layout;
    const pos = { ...layout.pos }, capsules = { ...layout.capsules };
    for (const [key, p] of Object.entries(live)) {
      if (key.startsWith("capsule:")) capsules[key.slice(8)] = p;
      else pos[key] = p;
    }
    return { ...layout, pos, capsules };
  }, [layout, live]);
  const geo = useMemo(() => geometry(factory, def, effective), [factory, def, effective]);
  const geoRef = useRef(geo);
  geoRef.current = geo;

  const setCam = useCallback((c: Camera) => { camRef.current = c; setCamState(c); }, []);

  const animateTo = useCallback((target: Camera, ms = 420) => {
    cancelAnimationFrame(anim.current);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setCam(target); return; }
    const from = { ...camRef.current };
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      setCam({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e });
      if (p < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  }, [setCam]);

  const fitAll = useCallback((animate = true) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const b = geoRef.current.bounds;
    fitMode.current = true;
    workMode.current = false;
    const padX = 20, padTop = 62, padBottom = 58;
    const k = Math.max(MIN_K, Math.min(1.1, (box.width - padX * 2) / b.w, (box.height - padTop - padBottom) / b.h));
    const target = { k, x: (box.width - b.w * k) / 2 - b.x * k, y: padTop + (box.height - padTop - padBottom - b.h * k) / 2 - b.y * k };
    if (animate) animateTo(target); else setCam(target);
  }, [animateTo, setCam]);

  // Open at a useful reading scale. "Fit all" is a separate navigation action:
  // large factories should never make the default working text microscopic.
  const focusWork = useCallback((animate = true) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const g = geoRef.current, s = getState();
    const area = s.defaultLayout?.workArea;
    if (area && !Object.keys(s.layout.pos).length && !s.selected.length) {
      fitMode.current = false;
      workMode.current = true;
      // The whole working line fits the screen; the HUD keeps 96px above, controls 56px below.
      const k = Math.max(0.5, Math.min(1.1, (box.width - 40) / area.w, (box.height - 152) / area.h));
      const target = { k, x: (box.width - area.w * k) / 2 - area.x * k, y: 96 + (box.height - 152 - area.h * k) / 2 - area.y * k };
      if (animate) animateTo(target, 320); else setCam(target);
      return;
    }
    const key = s.selected.find((k) => g.place[k])
      ?? g.nodes.find(({ node }) => s.fs.nodes[node.key]?.active.length)?.node.key
      ?? (g.place["curation/classify"] ? "curation/classify" : g.nodes.find(({ node }) => node.kind !== "source")?.node.key);
    const p = key ? g.place[key] : undefined;
    if (!p) { fitAll(animate); return; }
    fitMode.current = false;
    workMode.current = false;
    const k = box.width < 800 ? 0.95 : 1;
    const target = { k, x: box.width / 2 - (p.x + p.w / 2) * k, y: box.height * 0.44 - (p.y + p.h / 2) * k };
    if (animate) animateTo(target, 320); else setCam(target);
  }, [animateTo, fitAll, setCam]);

  // First fit once the workspace has a size.
  const fitted = useRef(false);
  useLayoutEffect(() => {
    if (fitted.current || !boxRef.current) return;
    const r = boxRef.current.getBoundingClientRect();
    if (r.width > 100) { fitted.current = true; focusWork(false); }
  });
  useEffect(() => {
    let frame = 0;
    let previous = boxRef.current?.getBoundingClientRect();
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = boxRef.current?.getBoundingClientRect();
        if (!next || next.width < 100 || next.height < 100) return;
        if (fitMode.current) fitAll(false);
        else if (workMode.current) focusWork(false);
        else if (previous) {
          const c = camRef.current;
          setCam({ ...c, x: c.x + (next.width - previous.width) / 2, y: c.y + (next.height - previous.height) / 2 });
        }
        previous = next;
      });
    });
    if (boxRef.current) ro.observe(boxRef.current);
    return () => { ro.disconnect(); cancelAnimationFrame(frame); };
  }, [fitAll, focusWork, setCam]);
  const lastOpen = useRef(layout.open);
  useEffect(() => {
    if (lastOpen.current !== layout.open) { lastOpen.current = layout.open; if (fitMode.current) fitAll(); }
  }, [layout.open, fitAll]);
  useEffect(() => () => { cancelAnimationFrame(anim.current); cancelAnimationFrame(dragFrame.current); gestureCleanup.current?.(); }, []);

  // External focus requests (evidence board "Enter", report links, notes).
  useEffect(() => {
    if (!focus || !boxRef.current) return;
    fitMode.current = false;
    workMode.current = false;
    const box = boxRef.current.getBoundingClientRect();
    const k = focus.area ? Math.min(1, (box.width - 72) / focus.area.w, (box.height - 180) / focus.area.h) : focus.k ?? Math.max(camRef.current.k, 0.85);
    animateTo({ k, x: box.width / 2 - focus.x * k, y: box.height / 2 - focus.y * k });
  }, [focus, animateTo]);

  // Follow mode: glide to the busiest station every couple of seconds (omnigraph idea).
  useEffect(() => {
    if (!follow || !active) return;
    const tick = () => {
      const s = getState();
      let best: string | null = null, bestAt = 0;
      for (const [k, n] of Object.entries(s.fs.nodes)) if (n.active.length && n.lastAt > bestAt && geoRef.current.place[k]) { best = k; bestAt = n.lastAt; }
      const p = best && geoRef.current.place[best];
      if (!p || !boxRef.current) return;
      fitMode.current = false;
      workMode.current = false;
      const box = boxRef.current.getBoundingClientRect();
      const k = Math.max(camRef.current.k, 0.75);
      animateTo({ k, x: box.width / 2 - (p.x + p.w / 2) * k, y: box.height / 2 - (p.y + p.h / 2) * k }, 900);
    };
    tick();
    const t = setInterval(tick, 2600);
    return () => clearInterval(t);
  }, [follow, active, animateTo]);

  /* ------------------------------------------------------------ input */

  const toWorld = (cx: number, cy: number) => {
    const r = boxRef.current!.getBoundingClientRect();
    const c = camRef.current;
    return { x: (cx - r.left - c.x) / c.k, y: (cy - r.top - c.y) / c.k };
  };

  const zoomAt = (cx: number, cy: number, factor: number) => {
    if (getState().follow) setState({follow: false});
    fitMode.current = false;
    workMode.current = false;
    cancelAnimationFrame(anim.current);
    const r = boxRef.current!.getBoundingClientRect();
    const c = camRef.current;
    const k = Math.max(MIN_K, Math.min(MAX_K, c.k * factor));
    const px = cx - r.left, py = cy - r.top;
    setCam({ k, x: px - ((px - c.x) / c.k) * k, y: py - ((py - c.y) / c.k) * k });
  };

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".inspector, .hud-card, .no-canvas-wheel")) return;
      e.preventDefault();
      cancelAnimationFrame(anim.current);
      if (getState().follow) setState({ follow: false });
      const mouseWheel = e.deltaMode === 1 || (Math.abs(e.deltaY) >= 100 && Math.abs(e.deltaX) < 1 && Number.isInteger(e.deltaY));
      if (e.ctrlKey || e.metaKey || mouseWheel) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0016)));
      else {
        fitMode.current = false;
        workMode.current = false;
        setCam({ ...camRef.current, x: camRef.current.x - e.deltaX, y: camRef.current.y - e.deltaY });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    const target = e.target as HTMLElement;
    if (target.closest(".inspector, .hud, .controls, .minimap, .replay-bar, .hud-card, .thumb, button, a, input")) return;
    boxRef.current?.focus({preventScroll: true});
    const nodeEl = target.closest("[data-node]") as HTMLElement | null;
    const capsuleEl = target.closest("[data-capsule]") as HTMLElement | null;
    cancelAnimationFrame(anim.current);
    gestureCleanup.current?.();
    if (getState().follow) setState({ follow: false });
    const start = { x: e.clientX, y: e.clientY };
    const startK = camRef.current.k;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (e.button === 0 && (nodeEl || capsuleEl)) {
      const key = nodeEl ? nodeEl.dataset.node! : `capsule:${capsuleEl!.dataset.capsule}`;
      const group = nodeEl && getState().selected.includes(key) ? getState().selected : [key];
      const origin: Record<string, { x: number; y: number }> = {};
      for (const k of group) { const p = geoRef.current.place[k]; if (p) origin[k] = { x: p.x, y: p.y }; }
      let moved = false;
      let pendingPosition: Record<string, { x: number; y: number }> = {};
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - start.x) / startK, dy = (ev.clientY - start.y) / startK;
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
        moved = true;
        fitMode.current = false;
        workMode.current = false;
        const next: Record<string, { x: number; y: number }> = {};
        for (const [k, o] of Object.entries(origin)) next[k] = { x: Math.round(o.x + dx), y: Math.round(o.y + dy) };
        pendingPosition = next;
        if (!dragFrame.current) dragFrame.current = requestAnimationFrame(() => { dragFrame.current = 0; setLive(pendingPosition); });
      };
      const up = (ev: PointerEvent) => {
        cleanup();
        if (moved) {
          const dx = (ev.clientX - start.x) / startK, dy = (ev.clientY - start.y) / startK;
          const L = getState().layout;
          const pos = { ...L.pos }, capsules = { ...L.capsules };
          for (const [k, o] of Object.entries(origin)) {
            const v = { x: Math.round(o.x + dx), y: Math.round(o.y + dy) };
            if (k.startsWith("capsule:")) capsules[k.slice(8)] = v; else pos[k] = v;
          }
          saveLayout({ ...L, pos, capsules });
          setLive(null);
        } else if (capsuleEl) {
          openLine(capsuleEl.dataset.capsule!, true);
        } else if (nodeEl && !key.startsWith("dock:")) {
          if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
            const sel = getState().selected;
            setState({ selected: sel.includes(key) ? sel.filter((x) => x !== key) : [...sel, key] });
          } else toggleInspector(key);
        }
      };
      const cancel = () => { cleanup(); setLive(null); };
      const cleanup = () => {
        cancelAnimationFrame(dragFrame.current); dragFrame.current = 0;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        gestureCleanup.current = null;
      };
      gestureCleanup.current = cleanup;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      return;
    }
    if (e.shiftKey) {
      const w0 = toWorld(e.clientX, e.clientY);
      setMarquee({ x0: w0.x, y0: w0.y, x1: w0.x, y1: w0.y });
      const move = (ev: PointerEvent) => { const w = toWorld(ev.clientX, ev.clientY); setMarquee({ x0: w0.x, y0: w0.y, x1: w.x, y1: w.y }); };
      const up = (ev: PointerEvent) => {
        cleanup();
        const w = toWorld(ev.clientX, ev.clientY);
        const x0 = Math.min(w0.x, w.x), x1 = Math.max(w0.x, w.x), y0 = Math.min(w0.y, w.y), y1 = Math.max(w0.y, w.y);
        const hit = geoRef.current.nodes.filter(({ place: p }) => p.x < x1 && p.x + p.w > x0 && p.y < y1 && p.y + p.h > y0).map(({ node }) => node.key);
        setState({ selected: [...new Set([...getState().selected, ...hit])] });
        setMarquee(null);
      };
      const cancel = () => { cleanup(); setMarquee(null); };
      const cleanup = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        gestureCleanup.current = null;
      };
      gestureCleanup.current = cancel;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener('pointercancel', cancel);
      return;
    }
    // Pan.
    const c0 = { ...camRef.current };
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 3) { moved = true; if (getState().follow) setState({ follow: false }); }
      if (moved) { fitMode.current = false; workMode.current = false; }
      setCam({ ...c0, x: c0.x + ev.clientX - start.x, y: c0.y + ev.clientY - start.y });
    };
    const up = () => {
      cleanup();
      if (!moved && getState().selected.length) setState({ selected: [] });
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cleanup);
      gestureCleanup.current = null;
    };
    gestureCleanup.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener('pointercancel', cleanup);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-node], [data-capsule], .inspector, .hud, .controls, .minimap, .hud-card")) return;
    if (getState().follow) setState({follow: false});
    fitAll();
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target;
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey ||
          !(target instanceof Element) ||
          target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [aria-modal="true"]') ||
          (target !== document.body && !boxRef.current?.contains(target))) return;
      if (!['f', 'F', 'w', 'W', '0', 'Escape', '=', '+', '-'].includes(e.key)) return;
      // A focused button keeps its own shortcuts. Escape may still dismiss its card.
      if (e.key !== 'Escape' && target.closest('button, a, .inspector')) return;
      e.preventDefault();
      if (getState().follow) setState({follow: false});
      if (e.key === "f" || e.key === "F") fitAll();
      if (e.key === "w" || e.key === "W") focusWork();
      if (e.key === "0" && !e.altKey) { const box = boxRef.current!.getBoundingClientRect(); zoomAt(box.left + box.width / 2, box.top + box.height / 2, 1 / camRef.current.k); }
      if (e.key === "Escape") setState({ selected: [], inspectors: getState().inspectors.filter((i) => i.pinned) });
      if ((e.key === "=" || e.key === "+") && !e.ctrlKey) { const b = boxRef.current!.getBoundingClientRect(); zoomAt(b.left + b.width / 2, b.top + b.height / 2, 1.2); }
      if (e.key === "-" && !e.ctrlKey) { const b = boxRef.current!.getBoundingClientRect(); zoomAt(b.left + b.width / 2, b.top + b.height / 2, 1 / 1.2); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const resetLayout = () => {
    const prev = getState().layout;
    saveLayout({ ...prev, pos: {}, capsules: {}, open: {} });
    setTimeout(() => focusWork(), 30);
    toast("已重置节点布局", { label: "撤销", run: () => { saveLayout(prev); setTimeout(() => focusWork(), 30); } }, 6500);
  };

  const k = cam.k;
  // Grid spacing snaps to powers of two in world units so the dots on screen always sit 20–40px apart.
  let step = 24;
  while (step * k < 20) step *= 2;
  while (step * k > 40) step /= 2;
  const dot = step * k;
  const dotAlpha = 1;
  return (
    <div
      ref={boxRef}
      tabIndex={0}
      role="region"
      aria-label="工作流画布"
      className={`cv ${cam.k < 0.5 ? "is-overview" : ""} ${live ? "is-dragging" : ""} ${follow ? "is-follow" : ""}`}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      style={{
        backgroundSize: `${dot}px ${dot}px`, backgroundPosition: `${cam.x}px ${cam.y}px`,
        ["--dot-alpha" as string]: dotAlpha, ["--k" as string]: k, ["--ik" as string]: 1 / k,
      }}
    >
      <div className="cv-world" style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${k})` }}>
        <Floor geo={geo} hover={hover} onHover={setHover} />
        <Edges geo={geo} hover={hover} selected={selected} />
        <Particles geo={geo} />
        {geo.capsules.map(({ line, place }) => <Capsule key={line} line={line} place={place} />)}
        {geo.nodes.map(({ node, place }) => (
          <NodeCard key={node.key} node={node} place={place} selected={selected.includes(node.key)} dim={hover !== null && hover !== node.key && !geo.edges.some((e) => (e.from === hover && e.to === node.key) || (e.to === hover && e.from === node.key))} onHover={setHover} />
        ))}
        <ConnectionPorts geo={geo} hover={hover} selected={selected} />
        {marquee && <div className="marquee" style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />}
      </div>
      <Hud />
      <Controls cam={cam} zoomBy={(f) => { const b = boxRef.current!.getBoundingClientRect(); zoomAt(b.left + b.width / 2, b.top + b.height / 2, f); }} fitAll={() => { setState({follow: false}); fitAll(); }} focusWork={() => { setState({follow: false}); focusWork(); }} resetLayout={resetLayout} />
      <Minimap geo={geo} cam={cam} box={boxRef} setCam={(c) => { fitMode.current = false; workMode.current = false; cancelAnimationFrame(anim.current); if (getState().follow) setState({follow: false}); setCam(c); }} />
      <Inspectors geo={geo} cam={cam} />
      <ReplayBar />
    </div>
  );
}

export function openLine(line: string, open: boolean) {
  const L = getState().layout;
  saveLayout({ ...L, open: { ...L.open, [line]: open } });
}

export function toggleInspector(key: string, kind: "node" | "token" | "part" = "node") {
  const list = getState().inspectors;
  if (list.some((i) => i.key === key)) setState({ inspectors: list.filter((i) => i.key !== key) });
  else setState({ inspectors: [...list.filter((i) => i.pinned).slice(-1), { key, kind, x: 0, y: 0, pinned: false }] });
}
