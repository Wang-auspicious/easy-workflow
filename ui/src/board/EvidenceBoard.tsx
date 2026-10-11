// Evidence board (Spec §10.9): replaces the canvas in the workspace. Dense rows (one item
// per row, its preview images in order) or image-only tiles; filter, single / Ctrl / Shift /
// box select — the selection *is* the chat's attachment strip — and one-click correction.
import { useEffect, useMemo, useRef, useState } from "react";
import { Rows3, LayoutGrid, Search, AlertTriangle, X, Undo2, ArrowRight, FileText, ClipboardCheck } from "lucide-react";
import type { Attachment, EvidenceRef } from "../../../shared/types.ts";
import type { TokenState } from "../../../shared/project.ts";
import { getState, setState, useStore } from "../store.ts";
import { openCorrection, REASONS } from "./Correction.tsx";
import { toggleInspector } from "../canvas/Canvas.tsx";

type Mode = "rows" | "tiles";
const KIND_ZH: Record<string, string> = { gallery: "灵感合集", "component-source": "组件源", "design-system": "设计规范", assets: "素材与模板", tool: "工具与库", knowledge: "知识", work: "作品" };
const ROLE_ZH: Record<string, string> = { identity: "首屏", breadth: "目录", proof: "特写" };
const STATUS_ZH: Record<string, string> = { active: "在线上", published: "已发布", merged: "已合并", rejected: "已排除", manual: "待人工", failed: "失败", parked: "待重试" };

interface Row { t: TokenState; images: EvidenceRef[]; suspicious: string[] }

const evAttachment = (ev: EvidenceRef, t?: TokenState): Attachment => ({ type: "evidence", id: ev.id, label: `${t?.item ?? ""} · ${ev.label}`, thumb: ev.poster ?? ev.card ?? ev.src });

export function EvidenceBoard() {
  useStore((s) => s.version);
  const atts = useStore((s) => s.attachments);
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem("pf.boardMode") as Mode) ?? "rows");
  const [q, setQ] = useState("");
  const [f, setF] = useState({ run: "current", kind: "", status: "", station: "", review: "", corrected: false, suspicious: false, source: "" });
  const [cursor, setCursor] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const [light, setLight] = useState<EvidenceRef | null>(null);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const anchor = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { try { localStorage.setItem("pf.boardMode", mode); } catch { /* ignore */ } }, [mode]);
  const s = getState();
  const selected = new Set(atts.filter((a) => a.type === "evidence").map((a) => a.id));

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const runStart = s.fs.run.startedAt;
    for (const id of [...s.fs.tokenOrder].reverse()) {
      const t = s.fs.tokens[id];
      if (!t) continue;
      if (f.run === "current" && t.createdAt < runStart) continue;
      if(f.run==="current"&&typeof t.data.retriedBy==="string"&&s.fs.tokens[t.data.retriedBy])continue;
      const all = t.evidence.map((e) => s.fs.evidence[e]).filter((e): e is EvidenceRef => Boolean(e));
      // Latest image per role (a reshoot replaces the earlier one in the row).
      const byRole = new Map<string, EvidenceRef>();
      for (const e of all) byRole.set(e.kind==="image"||e.kind==="video"?String(e.meta?.role??e.kind):e.id, e);
      const order = ["identity", "breadth", "proof", "video"];
      const images = [...byRole.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([, e]) => e);
      if (!images.length && !f.status) continue;
      const d = t.data as Record<string, any>;
      const suspicious: string[] = [];
      if (d.kindAgreed === false) suspicious.push("分类有分歧");
      if (d.style?.applicable && d.style.subjectVisible === false) suspicious.push("风格员看不到组件");
      if (Object.keys(t.rounds).length) suspicious.push("被退回过");
      for (const e of images) if (typeof e.meta?.content === "number" && (e.meta.content as number) < 0.06) suspicious.push(`${ROLE_ZH[String(e.meta?.role)] ?? ""}内容占比低`);
      if (t.status === "manual") suspicious.push("待人工");
      const text = `${t.item} ${t.title ?? ""} ${d.title ?? ""} ${t.url}`.toLowerCase();
      if (q && !text.includes(q.toLowerCase())) continue;
      if (f.kind && d.kind !== f.kind) continue;
      if (f.status && t.status !== f.status) continue;
      if (f.station && !images.some((e) => e.station === f.station)) continue;
      if (f.review === "returned" && !Object.keys(t.rounds).length) continue;
      if (f.review === "passed" && d.shotReview !== "pass") continue;
      if (f.review === "pending" && d.shotReview) continue;
      if (f.corrected && !t.corrections) continue;
      if (f.source === "pool" && t.source !== "candidates/pool") continue;
      if (f.source === "manual" && t.source !== "manual") continue;
      if (f.suspicious && !suspicious.length) continue;
      out.push({ t, images, suspicious });
    }
    if (f.suspicious) out.sort((a, b) => b.suspicious.length - a.suspicious.length);
    return out;
  }, [s.version, q, f]);

  const flat = useMemo(() => rows.flatMap((r) => r.images.map((e) => ({ e, t: r.t }))), [rows]);

  const select = (ids: string[], how: "set" | "toggle" | "add") => {
    const s2 = getState();
    const keep = s2.attachments.filter((a) => a.type !== "evidence");
    const cur = s2.attachments.filter((a) => a.type === "evidence");
    let next: Attachment[];
    const mk = (id: string) => { const e = s2.fs.evidence[id]; return evAttachment(e, s2.fs.tokens[e.token]); };
    if (how === "set") next = ids.map(mk);
    else if (how === "add") next = [...cur, ...ids.filter((id) => !cur.some((a) => a.id === id)).map(mk)];
    else next = ids.every((id) => cur.some((a) => a.id === id)) ? cur.filter((a) => !ids.includes(a.id)) : [...cur, ...ids.filter((id) => !cur.some((a) => a.id === id)).map(mk)];
    setState({ attachments: [...keep, ...next] });
  };

  const click = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (e.shiftKey && anchor.current) {
      const ids = flat.map((x) => x.e.id);
      const a = ids.indexOf(anchor.current), b = ids.indexOf(id);
      select(ids.slice(Math.min(a, b), Math.max(a, b) + 1), "add");
    } else if (e.ctrlKey || e.metaKey) { select([id], "toggle"); anchor.current = id; }
    else { select(selected.has(id) && selected.size === 1 ? [] : [id], "set"); anchor.current = id; }
  };

  // Keyboard scanning: J/K rows, H/L within a row, space zoom, Enter to canvas, X select.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select") || light && e.key !== "Escape" && e.key !== " ") return;
      const k = e.key.toLowerCase();
      if (k === "escape") { if (light) setLight(null); else select([], "set"); return; }
      if (!rows.length) return;
      const r = Math.min(cursor.r, rows.length - 1);
      const row = rows[r];
      if (k === "j" || k === "arrowdown") { e.preventDefault(); setCursor({ r: Math.min(rows.length - 1, r + 1), c: 0 }); }
      else if (k === "k" || k === "arrowup") { e.preventDefault(); setCursor({ r: Math.max(0, r - 1), c: 0 }); }
      else if (k === "l" || k === "arrowright") setCursor({ r, c: Math.min(row.images.length - 1, cursor.c + 1) });
      else if (k === "h" || k === "arrowleft") setCursor({ r, c: Math.max(0, cursor.c - 1) });
      else if (k === " ") { e.preventDefault(); setLight(light ? null : row.images[cursor.c] ?? null); }
      else if (k === "x") { const ev = row.images[cursor.c]; if (ev) select([ev.id], "toggle"); }
      else if (k === "enter") goCanvas(row.t);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    const el = scroller.current?.querySelector(`[data-row="${cursor.r}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor.r]);

  // Box select (drag on empty space).
  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".ev, button, input, select, .bd-row-main")) return;
    const sc = scroller.current!;
    const rect = sc.getBoundingClientRect();
    const x0 = e.clientX - rect.left + sc.scrollLeft, y0 = e.clientY - rect.top + sc.scrollTop;
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    const move = (ev: PointerEvent) => setBox({ x0, y0, x1: ev.clientX - rect.left + sc.scrollLeft, y1: ev.clientY - rect.top + sc.scrollTop });
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      const x1 = ev.clientX - rect.left + sc.scrollLeft, y1 = ev.clientY - rect.top + sc.scrollTop;
      setBox(null);
      if (Math.abs(x1 - x0) < 6 && Math.abs(y1 - y0) < 6) { if (!additive) select([], "set"); return; }
      const lx = Math.min(x0, x1), hx = Math.max(x0, x1), ly = Math.min(y0, y1), hy = Math.max(y0, y1);
      const hit: string[] = [];
      sc.querySelectorAll<HTMLElement>("[data-ev]").forEach((el) => {
        const r = el.getBoundingClientRect();
        const ex = r.left - rect.left + sc.scrollLeft, ey = r.top - rect.top + sc.scrollTop;
        if (ex < hx && ex + r.width > lx && ey < hy && ey + r.height > ly) hit.push(el.dataset.ev!);
      });
      select(hit, additive ? "add" : "set");
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  const kinds = [...new Set(Object.values(s.fs.tokens).map((t) => String((t.data as any).kind ?? "")).filter(Boolean))];
  const stations = [...new Set(Object.values(s.fs.evidence).map((e) => e.station))];
  const nodeName = (k: string) => s.factory?.nodes.find((n) => n.key === k)?.name ?? k;
  const corrSel = () => [...selected].map((id) => s.fs.evidence[id]).filter(Boolean).map((e) => ({ token: e.token, node: e.station, evidence: e.id, label: `${s.fs.tokens[e.token]?.item} · ${e.label}` }));

  return (
    <div className="view board" onPointerDown={onDown}>
      <div className="bd-bar">
        <div className="bd-search"><Search size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜域名、标题" /></div>
        <Seg value={f.run} onChange={(v) => setF({ ...f, run: v })} options={[["current", "本轮"], ["all", "全部"]]} />
        <Sel value={f.kind} onChange={(v) => setF({ ...f, kind: v })} label="分类" options={kinds.map((k) => [k, KIND_ZH[k] ?? k])} />
        <Sel value={f.station} onChange={(v) => setF({ ...f, station: v })} label="工位" options={stations.map((k) => [k, nodeName(k)])} />
        <Sel value={f.status} onChange={(v) => setF({ ...f, status: v })} label="状态" options={Object.entries(STATUS_ZH)} />
        <Sel value={f.review} onChange={(v) => setF({ ...f, review: v })} label="审查" options={[["passed", "截图审查通过"], ["returned", "被退回过"], ["pending", "未审查"]]} />
        <Sel value={f.source} onChange={(v) => setF({ ...f, source: v })} label="来源" options={[["pool", "候选层库存"], ["manual", "手贴"]]} />
        <button className={`bd-toggle ${f.corrected ? "is-on" : ""}`} onClick={() => setF({ ...f, corrected: !f.corrected })}><Undo2 size={13} />纠错过</button>
        <button className={`bd-toggle ${f.suspicious ? "is-on" : ""}`} onClick={() => setF({ ...f, suspicious: !f.suspicious })}><AlertTriangle size={13} />只看可疑</button>
        <span className="grow" />
        <span className="muted num">{rows.length} 件 · {flat.length} 条证据（{flat.filter(x=>x.e.kind==="image"||x.e.kind==="video").length} 张图像 / 视频）</span>
        <Seg value={mode} onChange={(v) => setMode(v as Mode)} options={[["rows", <Rows3 key="r" size={14} />], ["tiles", <LayoutGrid key="t" size={14} />]]} />
      </div>
      {selected.size > 0 && (
        <div className="bd-selbar">
          <span><b className="num">{selected.size}</b> 张已选 · 已放进右侧对话的附件条</span>
          <button className="btn btn--sm" onClick={(e) => openCorrection(corrSel(), e.currentTarget)}>批量纠错…</button>
          <button className="btn btn--sm btn--ghost" onClick={() => select([], "set")}><X size={13} />清空</button>
          <span className="grow" />
          <span className="muted"><span className="kbd">J</span><span className="kbd">K</span> 行 · <span className="kbd">H</span><span className="kbd">L</span> 张 · <span className="kbd">␣</span> 放大 · <span className="kbd">X</span> 选 · <span className="kbd">↵</span> 去画布</span>
        </div>
      )}
      <div className={`bd-scroll ${mode}`} ref={scroller}>
        {!rows.length && <div className="bd-empty"><b>{s.fs.evidenceOrder.length?"当前筛选下没有证据":"还没有证据"}</b><span>{s.fs.evidenceOrder.length?"可切换“全部”或清除筛选条件查看已有证据。":"文字、判定、图片和视频都会随处理过程出现在这里。"}</span></div>}
        {mode === "rows" ? rows.map((row, ri) => (
          <div key={row.t.id} data-row={ri} className={`bd-row ${cursor.r === ri ? "is-cursor" : ""}`}>
            <div className="bd-imgs">
              {row.images.map((e, ci) => <Ev key={e.id} e={e} t={row.t} sel={selected.has(e.id)} cur={cursor.r === ri && cursor.c === ci} onClick={(ev) => { setCursor({ r: ri, c: ci }); click(ev, e.id); }} onZoom={() => setLight(e)} />)}
              {Array.from({ length: Math.max(0, 3 - row.images.length) }).map((_, i) => <div key={i} className="ev ev--empty" />)}
            </div>
            <div className="bd-row-main" onClick={(e) => { setCursor({ r: ri, c: 0 }); if (e.ctrlKey || e.metaKey) select(row.images.map((x) => x.id), "toggle"); else select(row.images.map((x) => x.id), "set"); }}>
              <div className="bd-name"><b>{(row.t.data as any).title || row.t.title || row.t.item}</b><span className="muted">{row.t.url.replace(/^https?:\/\//, "")}</span></div>
              <div className="bd-tags">
                {(row.t.data as any).kind && <span className="chip">{KIND_ZH[(row.t.data as any).kind]}</span>}
                {((row.t.data as any).style?.styles ?? []).map((x: any) => <span key={x.id} className="chip">{x.id}</span>)}
                {row.suspicious.map((x) => <span key={x} className="chip warn-chip">{x}</span>)}
              </div>
              <div className="bd-meta">
                <Reviews t={row.t} />
                <span className={`chip st-${row.t.status}`}>{STATUS_ZH[row.t.status]}</span>
                {row.t.corrections > 0 && <span className="chip warn-chip">纠错 {row.t.corrections}</span>}
                <button className="bd-go" onClick={(e) => { e.stopPropagation(); goCanvas(row.t); }} data-tip="在画布上看这件货的证据链  Enter"><ArrowRight size={14} /></button>
              </div>
            </div>
          </div>
        )) : (
          <div className="bd-tiles">
            {flat.map(({ e, t }) => <Ev key={e.id} e={e} t={t} sel={selected.has(e.id)} cur={false} tile onClick={(ev) => click(ev, e.id)} onZoom={() => setLight(e)} />)}
          </div>
        )}
        {box && <div className="bd-box" style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />}
      </div>
      {light && <Lightbox e={light} onClose={() => setLight(null)} />}
    </div>
  );
}

function goCanvas(t: TokenState) {
  const s = getState();
  setState({ view: "canvas", inspectors: [...s.inspectors.filter((i) => i.pinned), { key: t.id, kind: "token", x: 0, y: 0, pinned: false }] });
}

function Ev({ e, t, sel, cur, tile, onClick, onZoom }: { e: EvidenceRef; t: TokenState; sel: boolean; cur: boolean; tile?: boolean; onClick: (ev: React.MouseEvent) => void; onZoom: () => void }) {
  const corrected = t.corrections > 0 && Object.keys(t.rounds).includes(e.station);
  const returning = t.status === "active" && t.at.includes(e.station);
  return (
    <div className={`ev ${sel ? "is-sel" : ""} ${cur ? "is-cur" : ""} ${tile ? "is-tile" : ""}`} data-ev={e.id} onClick={onClick} onDoubleClick={onZoom}>
      {e.kind==="image"||e.kind==="video"?<img src={e.poster ?? e.card ?? e.src} alt="" draggable={false} loading="lazy" />:<div className={`ev-document tone-${e.tone??"none"}`}><header>{e.kind==="verdict"?<ClipboardCheck size={17}/>:<FileText size={17}/>}<b>{e.label}</b></header><span>{e.verdict||"查看文字证据"}</span></div>}
      {(e.kind==="image"||e.kind==="video")&&<span className="ev-role">{ROLE_ZH[String(e.meta?.role)] ?? (e.kind === "video" ? "录屏" : e.label)}</span>}
      {e.kind === "video" && <span className="play">▶</span>}
      {returning && <span className="ev-state">已退回 → 重做中</span>}
      {!returning && corrected && <span className="ev-state is-done">已纠错</span>}
      {tile && <span className="ev-host">{t.item}</span>}
      <button className="ev-wrong" onClick={(ev) => { ev.stopPropagation(); openCorrection([{ token: e.token, node: e.station, evidence: e.id, label: `${t.item} · ${e.label}` }], ev.currentTarget); }}>不对</button>
    </div>
  );
}

function Reviews({ t }: { t: TokenState }) {
  const d = t.data as any;
  const items: [string, string | undefined][] = [["分类复核", d.kindAgreed === undefined ? undefined : d.kindAgreed ? "pass" : "warn"], ["截图审查", d.shotReview], ["事实审查", d.factReview], ["文案审查", d.copyReview]];
  return <span className="reviews">{items.map(([k, v]) => <i key={k} className={`light ${v === "pass" ? "light--green" : v === "return" || v === "warn" ? "light--yellow" : v === "escalate" ? "light--red" : "light--idle"}`} data-tip={`${k}：${v === "pass" ? "通过" : v === "return" ? "退回" : v === "warn" ? "有分歧" : v ?? "未到"}`} />)}</span>;
}

function Lightbox({ e, onClose }: { e: EvidenceRef; onClose: () => void }) {
  const t = getState().fs.tokens[e.token];
  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lb-inner" onClick={(ev) => ev.stopPropagation()}>
        {e.kind === "video" ? <video src={e.src} poster={e.poster} autoPlay loop muted controls /> : e.kind==="image"?<img src={e.src?.replace(/\.webp$/, ".webp") ?? e.card} alt="" />:<article className="evidence-document"><h2>{e.label}</h2><p>{e.verdict}</p><pre>{JSON.stringify(e.meta??{},null,2)}</pre></article>}
        <div className="lb-meta">
          <b>{t?.item}</b><span className="muted">{e.label}{e.meta?.href ? ` · ${String(e.meta.href).replace(/^https?:\/\//, "")}` : ""}{e.meta?.framing ? ` · ${e.meta.framing}` : ""}</span>
          <span className="grow" />
          {REASONS.slice(0, 4).map((r, i) => <span key={r} className="kbd" data-tip={r}>{i + 1}</span>)}
          <button className="btn btn--sm" onClick={(ev) => openCorrection([{ token: e.token, node: e.station, evidence: e.id, label: `${t?.item} · ${e.label}` }], ev.currentTarget)}>不对…</button>
          <button className="btn btn--sm btn--ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

function Seg({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, React.ReactNode][] }) {
  return <div className="seg">{options.map(([v, l]) => <button key={v} className={value === v ? "is-on" : ""} onClick={() => onChange(v)}>{l}</button>)}</div>;
}

function Sel({ value, onChange, label, options }: { value: string; onChange: (v: string) => void; label: string; options: [string, string][] }) {
  return (
    <label className={`bd-sel ${value ? "is-on" : ""}`}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{label}</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
