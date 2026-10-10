// Offline replay (Spec §10.11): a recorded journal is fed through the same projection at
// 0.5×–8×; canvas, bots, lights and evidence strips re-enact the run without network.
import { useEffect } from "react";
import { Pause, Play, X } from "lucide-react";
import type { Stamped } from "../../../shared/types.ts";
import { initialState } from "../../../shared/project.ts";
import { getState, ingest, setState, useStore } from "../store.ts";
import { boot, connect, disconnect } from "../api.ts";
import { clock } from "./Hud.tsx";

let timer = 0;

export async function startReplay(run: string, events?: Stamped[]) {
  const evs = events ?? (await (await fetch(`/api/journal?run=${encodeURIComponent(run)}`)).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Stamped);
  if (!evs.length) return;
  disconnect();
  const f = getState().factory!;
  const fs = initialState(f);
  // Stock values before the run so counters start where they were.
  setState({ fs, nodeRev: {}, view: "canvas", inspectors: [], replay: { run, speed: 2, playing: true, at: evs[0].at, start: evs[0].at, end: evs[evs.length - 1].at, events: evs, cursor: 0 } });
}

export function stopReplay() {
  clearInterval(timer);
  setState({ replay: null });
  boot().catch(() => connect(0));
}

export function ReplayBar() {
  const r = useStore((s) => s.replay);
  useEffect(() => {
    clearInterval(timer);
    if (!r?.playing) return;
    let last = performance.now();
    timer = window.setInterval(() => {
      const st = getState().replay;
      if (!st || !st.playing) return;
      const now = performance.now();
      // Long idle gaps are compressed so the replay never stalls on a quiet minute.
      let at = st.at + (now - last) * st.speed;
      last = now;
      const next = st.events[st.cursor];
      if (next && next.at - st.at > 4000) at = next.at;
      const batch: Stamped[] = [];
      let i = st.cursor;
      while (i < st.events.length && st.events[i].at <= at) batch.push(st.events[i++]);
      if (batch.length) ingest(batch);
      const done = i >= st.events.length;
      setState({ replay: { ...st, at: done ? st.end : at, cursor: i, playing: !done } });
    }, 50);
    return () => clearInterval(timer);
  }, [r?.playing, r?.speed, r?.run]);
  if (!r) return null;
  const pct = ((r.at - r.start) / Math.max(1, r.end - r.start)) * 100;
  return (
    <div className="replay-bar" onPointerDown={(e) => e.stopPropagation()}>
      <span className="replay-tag">回放</span>
      <button className="icon-btn" onClick={() => setState({ replay: { ...r, playing: !r.playing } })}>{r.playing ? <Pause size={15} /> : <Play size={15} />}</button>
      <span className="num muted">{clock(r.at - r.start)}</span>
      <div className="replay-track"><i style={{ width: `${pct}%` }} /></div>
      <span className="num muted">{clock(r.end - r.start)}</span>
      <div className="replay-speeds">
        {[0.5, 1, 2, 4, 8].map((x) => <button key={x} className={r.speed === x ? "is-on" : ""} onClick={() => setState({ replay: { ...r, speed: x } })}>{x}×</button>)}
      </div>
      <button className="icon-btn" onClick={stopReplay} data-tip="退出回放，回到实时"><X size={15} /></button>
    </div>
  );
}
