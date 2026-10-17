// 待人工审核：一件一件看、一键处理。左边是排队的条目（为什么停下），右边是这件货的
// 三张证据图和关键结论，底下只有你能做的几个动作——退回某个工位按你的意见重做，
// 或者（技术故障转人工的）从原工位继续。没有"强制发布"：闸门规则不允许跳过审查。
import { useMemo, useState } from "react";
import { ArrowUpRight, Check, ChevronRight, Loader2, Undo2, Play } from "lucide-react";
import type { EvidenceRef } from "../../../shared/types.ts";
import type { TokenState } from "../../../shared/project.ts";
import { actions, api } from "../api.ts";
import { getState, setState, useStore } from "../store.ts";
import { toast } from "../shell/Toasts.tsx";

const KIND_ZH: Record<string, string> = { gallery: "灵感合集", "component-source": "组件源", "design-system": "设计规范", assets: "素材与模板", tool: "工具与库", knowledge: "知识", work: "作品" };
const ROLE_ZH: Record<string, string> = { identity: "首屏", breadth: "目录", proof: "特写" };
/** Stations a person can send an entry back to, in the order the line runs. */
const REDO: [string, string][] = [
  ["curation/reader", "阅读员 · 重新读站、重选页面"],
  ["curation/classify", "分类员 · 重新分类"],
  ["curation/breadth", "目录摄影 · 重拍目录"],
  ["curation/proof", "特写摄影 · 重拍特写"],
  ["curation/style", "风格判定员 · 重判风格"],
  ["curation/facts", "事实核验员 · 重查事实"],
  ["curation/copy", "编辑 · 重写简介"],
];

const isManual = (t: TokenState) => t.status === "manual" || t.at.some((key) => key.endsWith("/manual"));

/** Turn station reasons into a sentence a person can act on. */
function why(t: TokenState): string {
  const d = t.data as Record<string, unknown>;
  const raw = String(d.manualReason ?? t.reason ?? "审查没有通过，需要你决定");
  return raw.replace(/^\[[^\]]{1,24}\]\s*/, "")
    .replace(/^退回\s*(\S+?)\s*已满\s*(\d+)\s*轮[：:]\s*(identity|breadth|proof)?\s*/, "$1重做了 $2 次仍不合格。")
    .replace(/（[^）]*token[^）]*）/g, "").slice(0, 220);
}

/** Send it back to the station the reason talks about. */
function suggested(t: TokenState): string {
  const text = String((t.data as Record<string, unknown>).manualReason ?? t.reason ?? "");
  if (/特写|proof/.test(text)) return "curation/proof";
  if (/目录|breadth/.test(text)) return "curation/breadth";
  if (/风格|style/.test(text)) return "curation/style";
  if (/事实|许可|license|fact/i.test(text)) return "curation/facts";
  if (/文案|简介|copy/.test(text)) return "curation/copy";
  if (/分类|kind/.test(text)) return "curation/classify";
  return "curation/reader";
}

export function Review() {
  useStore((s) => s.version);
  const fs = getState().fs;
  const connected = useStore((s) => s.connected);
  const replay = useStore((s) => Boolean(s.replay));
  const items = useMemo(() => Object.values(fs.tokens).filter(isManual)
    .sort((a, b) => (b.finishedAt ?? b.touchedAt ?? 0) - (a.finishedAt ?? a.touchedAt ?? 0)), [fs.tokens]);
  const [pick, setPick] = useState<string | null>(null);
  const current = items.find((t) => t.id === pick) ?? items[0];
  return (
    <div className="view review">
      <aside className="rv-list">
        <header><b>待人工</b><em className="num">{items.length}</em></header>
        {!items.length && <p className="rv-empty">没有等你决定的条目。</p>}
        {items.map((t) => (
          <button key={t.id} className={`rv-item ${current?.id === t.id ? "is-on" : ""}`} onClick={() => setPick(t.id)}>
            <b>{t.title || t.item}</b>
            <span>{why(t)}</span>
          </button>
        ))}
      </aside>
      {current ? <Detail key={current.id} t={current} disabled={!connected || replay} next={() => {
        const i = items.findIndex((t) => t.id === current.id);
        setPick(items[i + 1]?.id ?? items[i - 1]?.id ?? null);
      }} /> : <div className="rv-detail rv-blank">都处理完了。</div>}
    </div>
  );
}

function Detail({ t, disabled, next }: { t: TokenState; disabled: boolean; next: () => void }) {
  const fs = getState().fs;
  const d = t.data as Record<string, any>;
  const recovery = Object.values(fs.recoveries ?? {}).find((r) => r.token === t.id && r.disposition === "manual");
  const shots = useMemo(() => {
    const latest: Record<string, EvidenceRef> = {};
    for (const id of t.evidence) {
      const ev = fs.evidence[id];
      if (!ev || (ev.kind !== "image" && ev.kind !== "video")) continue;
      latest[String(ev.meta?.role ?? ev.label)] = ev;
    }
    return ["identity", "breadth", "proof"].map((role) => ({ role, ev: latest[role] }));
  }, [t.evidence, fs.evidence]);
  const [target, setTarget] = useState(() => suggested(t));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const send = async () => {
    if (!note.trim()) { toast("写一句你希望怎么改，工位会按这句话重做"); return; }
    setBusy("redo");
    try {
      const r = await actions.correct([{ token: t.id, node: target }], "站长审核退回", note.trim());
      const ok = r.results?.[0]?.ok;
      toast(ok ? `已退回给${REDO.find(([k]) => k === target)?.[1].split(" · ")[0]}，会按你的意见重做` : r.results?.[0]?.message ?? "没有退回成功");
      if (ok) { setNote(""); next(); }
    } catch { /* the API layer shows the reason */ } finally { setBusy(""); }
  };
  const resume = async () => {
    setBusy("resume");
    try {
      const r = await api.post<{ result: { count: number } }>("/api/candidates/retry", { count: 1, tokens: [t.id], includeManual: true });
      toast(r.result.count ? "已从原工位继续，之前的成果都保留" : "这件现在不能继续，请检查是否暂停");
      if (r.result.count) next();
    } catch { /* shown by the API layer */ } finally { setBusy(""); }
  };
  const openSite = () => { void actions.browser({ action: "open", url: t.url }); setState({ view: "browser" }); };
  return (
    <section className="rv-detail">
      <header className="rv-head">
        <div>
          <h2>{t.title || t.item}</h2>
          <button className="rv-url" onClick={openSite}>{t.url.replace(/^https?:\/\//, "")}<ArrowUpRight size={12} /></button>
        </div>
        <div className="rv-tags">
          {d.kind && <span>{KIND_ZH[d.kind] ?? d.kind}</span>}
          {(d.style?.styles ?? []).slice(0, 3).map((s: { id: string }) => <span key={s.id}>{s.id}</span>)}
        </div>
      </header>
      <p className="rv-why"><b>为什么停下</b>{why(t)}</p>
      <div className="rv-shots">
        {shots.map(({ role, ev }) => (
          <figure key={role} className={ev ? "" : "is-missing"}>
            {ev ? <img src={ev.card ?? ev.src} alt={`${ROLE_ZH[role]}截图`} loading="lazy" /> : <span>没有{ROLE_ZH[role]}</span>}
            <figcaption>{ROLE_ZH[role]}</figcaption>
          </figure>
        ))}
      </div>
      {(d.copy?.descriptionZh || d.descriptionZh) && <p className="rv-copy">{d.copy?.descriptionZh ?? d.descriptionZh}</p>}
      <div className="rv-actions">
        <div className="rv-redo">
          <label>退回给
            <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={disabled}>
              {REDO.filter(([key]) => getState().factory?.nodes.some((n) => n.key === key)).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} disabled={disabled} rows={2}
            placeholder="你希望怎么改？例如：特写换成 /components/button 的预览区，不要文档文字" />
          <button className="rv-primary" disabled={disabled || busy !== ""} onClick={() => void send()}>
            {busy === "redo" ? <Loader2 size={13} className="spin-i" /> : <Undo2 size={13} />}按我的意见重做</button>
        </div>
        <div className="rv-side">
          {recovery && <button className="rv-secondary" disabled={disabled || busy !== ""} onClick={() => void resume()}>
            {busy === "resume" ? <Loader2 size={13} className="spin-i" /> : <Play size={13} />}问题已排除，从原工位继续</button>}
          <button className="rv-ghost" onClick={next}><Check size={13} />先跳过<ChevronRight size={13} /></button>
        </div>
      </div>
    </section>
  );
}
