// One-click correction (Spec §10.9 / F6.3): pick a reason (number keys work), optional note,
// and the item goes back to the station that produced the evidence.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { actions } from "../api.ts";
import { getState, useStore } from "../store.ts";
import { CorrectionUndo } from './CorrectionUndo.tsx';
import './correction.css';

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
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [results, setResults] = useState<Array<{ ok: boolean; message: string; correction?: string }> | null>(null);
  const disabled = useStore(s => !s.connected || Boolean(s.replay));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { setReason(null); setNote(""); setNode(cur?.items[0]?.node ?? ""); setResults(null); setError(''); }, [cur]);
  useEffect(() => {
    if (!cur) return;
    const onKey = (e: KeyboardEvent) => {
      if (busy) return;
      if ((e.target as HTMLElement).tagName === "TEXTAREA") { if (e.key === "Escape") close(); return; }
      const n = Number(e.key);
      if (n >= 1 && n <= REASONS.length) { e.preventDefault(); setReason(n - 1); }
      if (e.key === "Escape") close();
      if (e.key === "Enter" && reason !== null && !results) { e.preventDefault(); void submit(); }
    };
    const onDown = (e: PointerEvent) => { if (!busy && !ref.current?.contains(e.target as Node)) close(); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("pointerdown", onDown, true); };
  });
  if (!cur) return null;
  const submit = async () => {
    if (reason === null || busy || disabled || results) return;
    const items = cur.items.map((i) => ({ token: i.token, node: cur.choose ? node : i.node, evidence: i.evidence }));
    setBusy(true); setError('');
    try { const r = await actions.correct(items, REASONS[reason], note || undefined); setResults(r.results); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };
  const state = getState();
  const stations = state.factory!.nodes.filter(n => !['store', 'source'].includes(n.kind) && cur.items.every(item => item.node === n.key || state.fs.tokens[item.token]?.attempts.some(id => state.fs.attempts[id]?.node === n.key)));
  return (
    <div ref={ref} className="correction" role="dialog" aria-label="纠错与撤销" style={{ left: Math.max(8, cur.x), top: Math.max(8, cur.y) }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="corr-title">{cur.items.length > 1 ? `批量纠错 ${cur.items.length} 件` : `不对：${cur.items[0].label}`}</div>
      {results ? <><div className="correction-receipts">{results.map((result, index) => <div key={result.correction ?? index}><b>{cur.items[index]?.label}</b><p className={result.ok ? '' : 'correction-error'}>{result.message}</p>{result.correction && <CorrectionUndo id={result.correction} />}</div>)}</div><div className="row-end"><button className="btn btn--sm" onClick={close}>完成</button></div></> : <>
      {cur.choose && (
        <label className="field"><span>退回到</span>
          <select disabled={busy} value={node} onChange={(e) => setNode(e.target.value)}>{stations.map((n) => <option key={n.key} value={n.key}>{n.num} {n.name}</option>)}</select>
        </label>
      )}
      <div className="corr-reasons">
        {REASONS.map((r, i) => (
          <button disabled={busy} key={r} className={reason === i ? "is-on" : ""} onClick={() => setReason(i)}><span className="kbd">{i + 1}</span>{r}</button>
        ))}
      </div>
      <textarea disabled={busy} placeholder="备注（可选）：告诉重做的工人哪里不对" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
      {error && <p className="correction-error" role="alert">{error}</p>}
      <div className="row-end">
        <span className="muted" style={{ marginRight: "auto", fontSize: 11 }}>按数字选原因 · Enter 确认</span>
        <button className="btn btn--sm btn--ghost" disabled={busy} onClick={close}>取消</button>
        <button className="btn btn--sm btn--primary" disabled={reason === null || busy || disabled || !node} onClick={() => void submit()}>{busy ? '正在退回…' : '退回重做'}</button>
      </div>
      </>}
    </div>
  );
}
