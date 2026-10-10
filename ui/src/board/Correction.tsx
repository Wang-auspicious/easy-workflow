// One-click correction (Spec §10.9 / F6.3): pick a reason (number keys work), optional note,
// and the item goes back to the station that produced the evidence.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { actions } from "../api.ts";
import { getState } from "../store.ts";
import { toast } from "../shell/Toasts.tsx";

export const REASONS = ["拍错页", "有弹层", "空白或没渲染", "不代表性", "分类错", "其他"];
type Item = { token: string; node: string; evidence?: string; label: string };
let open: { items: Item[]; x: number; y: number; choose: boolean } | null = null;
const ls = new Set<() => void>();

export function openCorrection(items: Item[], anchor: HTMLElement, choose = false) {
  const r = anchor.getBoundingClientRect();
  open = { items, x: Math.min(window.innerWidth - 300, r.left), y: Math.min(window.innerHeight - 330, r.bottom + 6), choose };
  for (const l of ls) l();
}
const close = () => { open = null; for (const l of ls) l(); };

export function CorrectionPopover() {
  const cur = useSyncExternalStore((l) => { ls.add(l); return () => ls.delete(l); }, () => open);
  const [reason, setReason] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [node, setNode] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { setReason(null); setNote(""); setNode(cur?.items[0]?.node ?? ""); }, [cur]);
  useEffect(() => {
    if (!cur) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "TEXTAREA") { if (e.key === "Escape") close(); return; }
      const n = Number(e.key);
      if (n >= 1 && n <= REASONS.length) { e.preventDefault(); setReason(n - 1); }
      if (e.key === "Escape") close();
      if (e.key === "Enter" && reason !== null) submit();
    };
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("pointerdown", onDown, true); };
  });
  if (!cur) return null;
  const submit = async () => {
    if (reason === null) return;
    const items = cur.items.map((i) => ({ token: i.token, node: cur.choose ? node : i.node, evidence: i.evidence }));
    const r = await actions.correct(items, REASONS[reason], note || undefined);
    const st = getState().factory?.nodes.find((n) => n.key === items[0].node)?.name;
    toast(r.ok ? `已退回 → ${st}，后台重做，新结果会原地替换` : r.results?.[0]?.message ?? "纠错失败");
    close();
  };
  const stations = getState().factory!.nodes.filter((n) => n.line === "curation" && (n.kind === "agent" || n.kind === "program" || n.kind === "review") && n.key !== "curation/dedupe");
  return (
    <div ref={ref} className="correction" style={{ left: cur.x, top: cur.y }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="corr-title">{cur.items.length > 1 ? `批量纠错 ${cur.items.length} 件` : `不对：${cur.items[0].label}`}</div>
      {cur.choose && (
        <label className="field"><span>退回到</span>
          <select value={node} onChange={(e) => setNode(e.target.value)}>{stations.map((n) => <option key={n.key} value={n.key}>{n.num} {n.name}</option>)}</select>
        </label>
      )}
      <div className="corr-reasons">
        {REASONS.map((r, i) => (
          <button key={r} className={reason === i ? "is-on" : ""} onClick={() => setReason(i)}><span className="kbd">{i + 1}</span>{r}</button>
        ))}
      </div>
      <textarea placeholder="备注（可选）：告诉重做的工人哪里不对" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
      <div className="row-end">
        <span className="muted" style={{ marginRight: "auto", fontSize: 11 }}>按数字选原因 · Enter 确认</span>
        <button className="btn btn--sm btn--ghost" onClick={close}>取消</button>
        <button className="btn btn--sm btn--primary" disabled={reason === null} onClick={submit}>退回重做</button>
      </div>
    </div>
  );
}
