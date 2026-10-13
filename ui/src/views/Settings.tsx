// Settings: model and key status, global resource quotas (Spec §6.3), social rate limits,
// and layout resets. Quotas apply to every line at once.
import { useState } from "react";
import { getState, setState, useStore } from "../store.ts";
import { actions, saveLayout } from "../api.ts";
import { toast } from "../shell/Toasts.tsx";

const FIELDS: { k: string; label: string; hint: string; min: number; max: number; step?: number }[] = [
  { k: "browser", label: "采集并发", hint: "最多同时采集 3 页；手动页和等待登录的页面会单独保留。", min: 1, max: 3 },
  { k: "model", label: "模型并发", hint: "按服务商限额调；最后一个位置留给审查员。", min: 1, max: 32 },
  { k: "cpu", label: "CPU 重活", hint: "转码 / 图像哈希。本机 16 线程 → 4。", min: 1, max: 8 },
  { k: "http", label: "HTTP 并发", hint: "只发请求不开浏览器的工位。", min: 1, max: 16 },
  { k: "memoryFloorMB", label: "内存守护 (MB)", hint: "空闲内存低于它时，不再发新的浏览器页面。", min: 256, max: 4096, step: 128 },
  { k: "socialPerMinute", label: "社媒每分钟访问", hint: "每个平台单独限速，带随机间隔。", min: 1, max: 30 },
  { k: "socialPerDay", label: "社媒每天访问", hint: "超额排到下一时段，不为提速放宽。", min: 10, max: 2000, step: 10 },
];

export function Settings() {
  const settings = useStore((s) => s.settings);
  const model = useStore((s) => s.model);
  const key = useStore((s) => s.keyPresent);
  const [draft, setDraft] = useState<Record<string, number>>(settings);
  const dirty = FIELDS.some((f) => draft[f.k] !== settings[f.k]);
  return (
    <div className="view">
      <div className="view-inner narrow">
        <div className="view-head"><div><h1 className="view-title">设置</h1><div className="view-sub">配额对所有流水线一起生效：线再多，浏览器页面总数也不会超过这里的上限。</div></div></div>
        <section className="set-sec">
          <h3>Pi 默认与主调度</h3>
          <div className="set-row"><span>底座</span><b>pi agent（@earendil-works/pi-agent-core 1.1.0）</b></div>
          <div className="set-row"><span>默认模型</span><b className="mono">{model || '未配置'}</b></div>
          <div className="set-row"><span>Pi 凭据</span><b className={key ? "ok-c" : "bad-c"}>{key ? "已找到本机凭据，不写入日志" : "未找到，请检查 Pi 默认 provider 的本机凭据"}</b></div>
          <p className="muted">Agent 工位可在节点的“规格”中单独选择 Pi、Claude Code 或 launcher。各工位按所选适配器检查就绪状态；此处仅显示 Pi 默认信息。</p>
        </section>
        <section className="set-sec">
          <h3>资源配额</h3>
          {FIELDS.map((f) => (
            <div key={f.k} className="set-field">
              <div><b>{f.label}</b><span className="muted">{f.hint}</span></div>
              <input type="range" min={f.min} max={f.max} step={f.step ?? 1} value={draft[f.k] ?? 0} onChange={(e) => setDraft({ ...draft, [f.k]: Number(e.target.value) })} />
              <b className="num set-val">{draft[f.k]}</b>
            </div>
          ))}
          <div className="row-end">
            <button className="btn btn--ghost btn--sm" disabled={!dirty} onClick={() => setDraft(settings)}>还原</button>
            <button className="btn btn--primary btn--sm" disabled={!dirty} onClick={async () => { const r: any = await actions.settings(draft); setState({ settings: r.settings }); toast("配额已更新，立即生效"); }}>保存</button>
          </div>
        </section>
        <section className="set-sec">
          <h3>画布</h3>
          <div className="set-row"><span>布局</span><button className="btn btn--sm" onClick={() => { const L = getState().layout; saveLayout({ ...L, pos: {}, capsules: {}, open: {} }); toast("已重置为默认布局"); }}>重置为默认布局</button></div>
          <div className="set-row"><span>节点颜色与 bot</span><button className="btn btn--sm" onClick={() => { const L = getState().layout; saveLayout({ ...L, colors: {}, bots: {} }); toast("节点颜色与 bot 形象已恢复默认"); }}>一并恢复默认</button></div>
          <div className="set-row muted">拖动只写布局文件 <code className="mono">layout/factory.layout.json</code>，不改规格、不影响运行。</div>
        </section>
      </div>
    </div>
  );
}
