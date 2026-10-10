// Line library (Spec §9.5): packs, their lines and templates. The app orchestrates any
// line-shaped work; VisLexicon's lines are a preset pack, not built-in features.
import { Plus, Sparkles, CopyPlus, LayoutTemplate } from "lucide-react";
import { roleColors } from "../../../shared/palette.ts";
import { getState, setState, useStore } from "../store.ts";
import { openLine } from "../canvas/Canvas.tsx";
import { isOpen } from "../canvas/geometry.ts";

const TEMPLATES = [
  { id: "review-loop", name: "生产 + 审查回路", blurb: "一个生产工位、一个独立审查员，不过就带理由退回，最多 2 轮。", chain: ["process", "review", "publish"] as const },
  { id: "fanout", name: "扇出 · 汇总", blurb: "一件货拆成几份并行处理，再在汇总工位合并。", chain: ["sort", "judge", "judge", "process"] as const },
  { id: "collect", name: "采集 · 加工 · 审查 · 发布", blurb: "浏览器采集、程序加工、模型审查、闸门发布：策展线的骨架。", chain: ["capture", "process", "review", "publish"] as const },
  { id: "triage", name: "分流 · 多线投递", blurb: "按规则把货分到不同的线；判不了的交给 agent，再判不了交人。", chain: ["sort", "judge", "arbiter"] as const },
];

export function Library() {
  const f = useStore((s) => s.factory)!;
  const layout = useStore((s) => s.layout);
  const ask = (text: string) => setState({ draft: text, chatOpen: true });
  return (
    <div className="view">
      <div className="view-inner">
        <div className="view-head">
          <div>
            <h1 className="view-title">流水线库</h1>
            <div className="view-sub">应用本身不绑定任何领域：线、工位、工具、规则都来自“流水线包”。下面是随应用自带的 VisLexicon 预设包，以及几种通用模板。</div>
          </div>
          <div className="row-gap">
            <button className="btn" onClick={() => ask("我要新建一条流水线：")}><Sparkles size={14} />让主调度起草</button>
            <button className="btn btn--primary" onClick={() => ask("从空白开始新建一条流水线，先给我一个只有收件箱和发布的骨架：")}><Plus size={14} />新建流水线</button>
          </div>
        </div>
        {f.packs.map((p) => (
          <section key={p.id} className="lib-pack">
            <div className="lib-pack-head"><b>{p.name}</b><span className="chip">v{p.version}</span><span className="chip">预设包</span><span className="muted">{p.blurb}</span></div>
            <div className="lib-grid">
              {f.lines.map((l) => {
                const nodes = f.nodes.filter((n) => n.line === l.id);
                const open = isOpen(f, layout, l.id);
                return (
                  <div key={l.id} className="lib-line">
                    <div className="lib-line-head">
                      <b>{l.name}</b>
                      <span className="chip">第 {l.layer} 层</span>
                      <span className={`chip ${l.wired ? "ok-chip" : ""}`}>{l.wired ? "已接工具" : "工具待接"}</span>
                    </div>
                    <div className="lib-line-blurb">{l.blurb}</div>
                    <div className="lib-chain">{nodes.map((n) => <i key={n.key} style={{ background: roleColors(n.role).fill, borderColor: roleColors(n.role).border }} data-tip={n.name} />)}</div>
                    <div className="lib-line-foot">
                      <span className="muted num">{nodes.length} 个节点 · {l.priority === "high" ? "高" : l.priority === "mid" ? "中" : "低"}优先</span>
                      <span className="grow" />
                      <button className="btn btn--sm btn--ghost" onClick={() => ask(`复制「${l.name}」做一条新线，改成：`)}><CopyPlus size={13} />复制</button>
                      <button className="btn btn--sm" onClick={() => { if (!open) openLine(l.id, true); setState({ view: "canvas" }); }}>在画布上看</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
        <section className="lib-pack">
          <div className="lib-pack-head"><b>通用模板</b><span className="muted">从模板起一条线：主调度按你的任务填上工位、I/O 与审查点，以虚线预览，确认后生效；首次运行进入测量模式（每站 1 人跑 10 件，再按实测耗时给配比建议）。</span></div>
          <div className="lib-grid">
            {TEMPLATES.map((t) => (
              <div key={t.id} className="lib-line">
                <div className="lib-line-head"><LayoutTemplate size={14} /><b>{t.name}</b></div>
                <div className="lib-line-blurb">{t.blurb}</div>
                <div className="lib-chain">{t.chain.map((r, i) => <i key={i} style={{ background: roleColors(r).fill, borderColor: roleColors(r).border }} />)}</div>
                <div className="lib-line-foot"><span className="grow" /><button className="btn btn--sm" onClick={() => ask(`用「${t.name}」模板新建一条流水线，任务是：`)}>用这个模板</button></div>
              </div>
            ))}
          </div>
        </section>
        <div className="muted lib-note">结构修改（加减工位、改连线、改人数上下限）都会生成规格补丁，先给你看差异再生效；默认版本始终保留，可一键回到默认。当前规格摘要 <code className="mono">{getState().factory?.digest}</code></div>
      </div>
    </div>
  );
}
