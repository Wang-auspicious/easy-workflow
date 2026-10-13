// Current preset lines and design references. Drafting a request does not install
// a new executable line; execution availability comes from the compiled spec.
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
            <div className="view-sub">查看预设流程与执行状态，或参考下方模板和主调度讨论新流程。当前可执行候选处理与策展；其他业务线为规格预览。</div>
          </div>
          <div className="row-gap">
            <button className="btn" onClick={() => ask("请和我讨论一条新流程的目标、输入输出与审查要求：")}><Sparkles size={14} />讨论新流程</button>
            <button className="btn btn--primary" onClick={() => ask("请起草一份流程设计供我评估，说明需要实现的工位与工具。我的任务是：")}><Plus size={14} />起草流程需求</button>
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
                      <button className="btn btn--sm btn--ghost" onClick={() => ask(`请参考「${l.name}」起草流程设计，并说明需要实现的部分。我的新任务是：`)}><CopyPlus size={13} />参考此流程</button>
                      <button className="btn btn--sm" onClick={() => { if (!open) openLine(l.id, true); setState({ view: "canvas" }); }}>在画布上看</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
        <section className="lib-pack">
          <div className="lib-pack-head"><b>流程设计参考</b><span className="muted">选择一个流程，将需求草稿带入对话。新建可执行流水线与模板安装仍待接入；现有工位与连线可通过规格补丁调整。</span></div>
          <div className="lib-grid">
            {TEMPLATES.map((t) => (
              <div key={t.id} className="lib-line">
                <div className="lib-line-head"><LayoutTemplate size={14} /><b>{t.name}</b></div>
                <div className="lib-line-blurb">{t.blurb}</div>
                <div className="lib-chain">{t.chain.map((r, i) => <i key={i} style={{ background: roleColors(r).fill, borderColor: roleColors(r).border }} />)}</div>
                <div className="lib-line-foot"><span className="grow" /><button className="btn btn--sm" onClick={() => ask(`请参考「${t.name}」讨论流程设计，任务是：`)}>讨论此流程</button></div>
              </div>
            ))}
          </div>
        </section>
        <div className="muted lib-note">结构修改（加减工位、改连线、改人数上下限）都会生成规格补丁，先给你看差异再生效；默认版本始终保留，可一键回到默认。当前规格摘要 <code className="mono">{getState().factory?.digest}</code></div>
      </div>
    </div>
  );
}
