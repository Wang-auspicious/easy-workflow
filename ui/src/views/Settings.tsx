// Settings: model and key status, global resource quotas (Spec §6.3), social rate limits,
// and layout resets. Quotas apply to every line at once.
import {useEffect, useState, type FormEvent} from 'react';
import type {ProjectAgentDefaults} from '../../../shared/types.ts';
import { getState, setState, useStore } from "../store.ts";
import {actions, refreshSpec, saveLayout} from '../api.ts';
import { toast } from "../shell/Toasts.tsx";
import {AgentBindingFields, adapterLabel, agentBindingDraft, parseBindingDraft, selectBindingAdapter, type AgentBindingDraft} from '../canvas/AgentBindingFields.tsx';

const FIELDS: { k: string; label: string; hint: string; min: number; max: number; step?: number }[] = [
  { k: "browser", label: "采集并发", hint: "采集页的总上限；可用名额会随内存余量收缩。", min: 1, max: 16 },
  { k: "model", label: "模型并发", hint: "模型工位同时执行的总上限。", min: 1, max: 64 },
  { k: "cpu", label: "CPU 重活", hint: "转码、图像处理等计算任务的总并发。", min: 1, max: 32 },
  { k: "http", label: "HTTP 并发", hint: "只发请求不开浏览器的工位。", min: 1, max: 64 },
  { k: "memoryFloorMB", label: "内存守护 (MB)", hint: "空闲内存低于它时，不再发新的浏览器页面。", min: 0, max: 4096, step: 128 },
  { k: "socialPerMinute", label: "社媒每分钟访问", hint: "每个平台单独限速，带随机间隔。", min: 1, max: 6 },
  { k: "socialPerDay", label: "社媒每天访问", hint: "超额排到下一时段，不为提速放宽。", min: 1, max: 300 },
];

export function Settings() {
  const settings = useStore((s) => s.settings);
  const key = useStore((s) => s.keyPresent);
  const [draft, setDraft] = useState<Record<string, number>>(settings);
  const dirty = FIELDS.some((f) => draft[f.k] !== settings[f.k]);
  return (
    <div className="view">
      <div className="view-inner narrow">
        <div className="view-head"><div><h1 className="view-title">设置</h1><div className="view-sub">配额对所有流水线一起生效：线再多，浏览器页面总数也不会超过这里的上限。</div></div></div>
        <section className="set-sec">
          <h3>本项目的 Agent 与模型</h3>
          <p className="muted">首次使用时导入 Pi 的选择，之后独立保存。其他 Pi 窗口切换模型不会改动这里。单个节点可在“规格”中覆盖项目默认。</p>
          <AgentDefaultEditor scope="station" />
          <AgentDefaultEditor scope="dispatcher" />
          <div className="set-row"><span>主调度凭据</span><b className={key ? 'ok-c' : 'bad-c'}>{key ? '已找到对应 Provider 的本机凭据' : '未就绪，请检查所选 Provider 的模型与本机凭据'}</b></div>
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

function AgentDefaultEditor({scope}: {scope: keyof ProjectAgentDefaults}) {
  const configured = useStore(state => state.fs.agentDefaults?.[scope]);
  const connected = useStore(state => state.connected);
  const replay = useStore(state => Boolean(state.replay));
  const revision = JSON.stringify(configured);
  const [draft, setDraft] = useState(() => agentBindingDraft(configured ?? {adapter: 'pi'}));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const title = scope === 'station' ? '工位默认' : '主调度';
  const disabled = !configured || !connected || replay || busy;

  useEffect(() => {
    if (!dirty) setDraft(agentBindingDraft(configured ?? {adapter: 'pi'}));
  }, [revision, dirty]);

  const reflect = (defaults: ProjectAgentDefaults) => {
    setState(state => ({fs: {...state.fs, agentDefaults: defaults},
      nodeExecutions: state.nodeExecutions, nodeRecoveries: state.nodeRecoveries}));
    setDraft(agentBindingDraft(defaults[scope]));
    setDirty(false);
  };
  const read = async () => {
    setBusy(true);
    setError('');
    setReceipt('');
    try {
      const response = await fetch('/api/tools/agent_defaults', {
        method: 'POST', headers: {'content-type': 'application/json'}, body: '{}', signal: AbortSignal.timeout(15000),
      });
      const body = await response.json();
      if (!response.ok || !body.ok || !body.result?.station || !body.result?.dispatcher) throw new Error(body.error ?? '项目配置读取失败');
      reflect(body.result);
      await refreshSpec();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '项目配置读取失败');
    } finally {
      setBusy(false);
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    setError('');
    setReceipt('');
    try {
      const binding = parseBindingDraft(draft, true);
      if (!binding) throw new Error('请选择明确的项目默认配置。');
      setBusy(true);
      const response = await fetch('/api/agents/defaults', {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({[scope]: binding}),
        signal: AbortSignal.timeout(20000),
      });
      const body = await response.json();
      if (!response.ok || !body.ok || !body.result?.station || !body.result?.dispatcher) throw new Error(body.error ?? '配置保存结果未确认，请重新读取核对');
      reflect(body.result);
      setReceipt(scope === 'station' ? '已保存，继承此默认的工位从下次尝试生效。' : '已保存，从主调度的下次对话生效。');
      await refreshSpec();
    } catch (reason) {
      setError(reason instanceof Error && reason.name === 'TimeoutError'
        ? '保存结果尚未确认，请重新读取核对，勿重复提交。'
        : reason instanceof Error ? reason.message : '配置保存失败');
    } finally {
      setBusy(false);
    }
  };
  const change = (field: keyof AgentBindingDraft, value: string) => {
    setDraft(current => ({...current, [field]: value}));
    setDirty(true);
    setReceipt('');
  };
  return <form className="agent-binding agent-default" aria-label={`${title}配置`} onSubmit={save}>
    <div className="agent-binding-heading"><b>{title}</b><span className="muted">{scope === 'dispatcher' ? '独立 Pi 会话' : '各工位独立执行'}</span></div>
    <p className="agent-binding-effective">{configured ? `${adapterLabel(configured.adapter)} · ${configured.model || '客户端默认模型'}` : '项目配置尚未加载'}</p>
    <AgentBindingFields draft={draft} disabled={disabled} scope={scope} change={change} selectAdapter={adapter => {
      setDraft(selectBindingAdapter(adapter, configured ?? null));
      setDirty(true);
      setReceipt('');
    }} />
    <p className="muted">{scope === 'dispatcher' ? '主调度目前使用 Pi，可与工位选择不同的 Provider 和模型。' : '节点中的独立配置优先。此处保存只影响继承默认的工位。'}正在执行的任务保留已选模型。</p>
    {error && <p className="agent-binding-error" role="alert">{error}</p>}
    {receipt && <p className="agent-binding-receipt" role="status">{receipt}</p>}
    <div className="agent-binding-actions">
      <button className="btn btn--sm btn--ghost" type="button" disabled={!connected || replay || busy} onClick={() => void read()}>重新读取</button>
      <button className="btn btn--sm btn--primary" disabled={disabled || !dirty}>{busy ? '正在保存…' : `保存${title}`}</button>
    </div>
  </form>;
}
