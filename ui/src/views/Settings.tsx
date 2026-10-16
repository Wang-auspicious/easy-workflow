// Settings: model and key status, global resource quotas (Spec §6.3), social rate limits,
// and layout resets. Quotas apply to every line at once.
import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import type {ProjectAgentDefaults} from '../../../shared/types.ts';
import { getState, setState, useStore } from "../store.ts";
import {actions, refreshSpec, saveLayout} from '../api.ts';
import { toast } from "../shell/Toasts.tsx";
import {AgentBindingFields, adapterLabel, agentBindingDraft, parseBindingDraft, selectBindingAdapter, type AgentBindingDraft, type PiModelChoice} from '../canvas/AgentBindingFields.tsx';
import {FlowSettings} from './FlowSettings.tsx';

const FIELDS: { k: string; label: string; hint: string; min: number; max: number; step?: number }[] = [
  { k: "browser", label: "采集并发", hint: "采集页的总上限；可用名额会随内存余量收缩。", min: 1, max: 16 },
  { k: 'model', label: '模型调用并发', hint: 'Pi 请求、程序中的模型请求和原生客户端调用共享名额。', min: 1, max: 64 },
  { k: 'modelWorkers', label: '模型工位并发', hint: '工位等待工具时可让其他工位前进；实际模型调用仍受上一项限制。多于 1 个名额时保留 1 个给审查。', min: 1, max: 64 },
  { k: "cpu", label: "CPU 重活", hint: "转码、图像处理等计算任务的总并发。", min: 1, max: 32 },
  { k: "http", label: "HTTP 并发", hint: "只发请求不开浏览器的工位。", min: 1, max: 64 },
  { k: "memoryFloorMB", label: "内存守护 (MB)", hint: "空闲内存低于它时，不再发新的浏览器页面。", min: 0, max: 4096, step: 128 },
  { k: "socialPerMinute", label: "社媒每分钟访问", hint: "每个平台单独限速，带随机间隔。", min: 1, max: 6 },
  { k: "socialPerDay", label: "社媒每天访问", hint: "超额排到下一时段，不为提速放宽。", min: 1, max: 300 },
];

export function Settings() {
  const settings = useStore((s) => s.settings);
  const key = useStore((s) => s.keyPresent);
  const dispatcherAdapter = useStore(state => state.fs.agentDefaults?.dispatcher.adapter);
  const connected = useStore(state => state.connected);
  const replay = useStore(state => Boolean(state.replay));
  const [models, setModels] = useState<PiModelChoice[]>([]);
  const [modelError, setModelError] = useState('');
  const [draft, setDraft] = useState<Record<string, number>>(settings);
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [quotaBusy, setQuotaBusy] = useState(false);
  const [quotaError, setQuotaError] = useState('');
  const quotaFlight = useRef(false);
  const dirty = FIELDS.some(field => edited.has(field.k) && draft[field.k] !== settings[field.k]);
  const readOnly = !connected || replay;
  useEffect(() => {
    setDraft(current => Object.fromEntries(Object.entries(settings).map(([key, value]) =>
      [key, edited.has(key) ? current[key] : value])));
  }, [settings, edited]);
  const saveQuotas = async () => {
    if (quotaFlight.current || !getState().connected || getState().replay || !dirty) return;
    quotaFlight.current = true;
    setQuotaBusy(true);
    setQuotaError('');
    try {
      const changes = Object.fromEntries([...edited].map(key => [key, draft[key]]));
      const response = await actions.settings(changes) as {settings?: unknown};
      const saved = response.settings;
      if (!saved || typeof saved !== 'object' || Array.isArray(saved) ||
        Object.values(saved).some(value => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error('配额保存回执无效，请重新读取设置核对。');
      }
      setState({settings: saved as Record<string, number>});
      setEdited(new Set());
      toast('配额已更新，立即生效');
    } catch (reason) {
      setQuotaError(reason instanceof Error ? reason.message : '配额保存失败，修改内容已保留。');
    } finally {
      quotaFlight.current = false;
      setQuotaBusy(false);
    }
  };
  const readModels = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/tools/agent_bindings', {
        method: 'POST', headers: {'content-type': 'application/json'}, body: '{}',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      });
      const body: {ok?: boolean; error?: string; result?: {piModels?: unknown}} = await response.json();
      const choices = body.result?.piModels;
      if (!response.ok || !body.ok || !Array.isArray(choices)) throw new Error(body.error ?? '已接入模型列表读取失败');
      const valid = choices.filter((choice: unknown): choice is PiModelChoice =>
        typeof choice === 'object' && choice !== null &&
        'provider' in choice && typeof choice.provider === 'string' &&
        'model' in choice && typeof choice.model === 'string' &&
        'name' in choice && typeof choice.name === 'string');
      if (!signal?.aborted) {
        setModels(valid);
        setModelError('');
      }
    } catch (reason) {
      if (!signal?.aborted) setModelError(reason instanceof Error ? reason.message : '已接入模型列表读取失败');
    }
  }, []);
  useEffect(() => {
    if (!connected || replay) return;
    const controller = new AbortController();
    void readModels(controller.signal);
    return () => controller.abort();
  }, [connected, replay, readModels]);
  return (
    <div className="view">
      <div className="view-inner narrow">
        <div className="view-head"><div><h1 className="view-title">设置</h1><div className="view-sub">配额对所有流水线一起生效：线再多，浏览器页面总数也不会超过这里的上限。</div></div></div>
        <section className="set-sec">
          <h3>本项目的 Agent 与模型</h3>
          <p className="muted">首次使用时导入 Pi 的选择，之后独立保存。其他 Pi 窗口切换模型不会改动这里。单个节点可在“规格”中覆盖项目默认。</p>
          {modelError && <p className="agent-binding-error" role="alert">{modelError} <button className="btn btn--sm" disabled={!connected || replay} onClick={() => void readModels()}>重新读取模型列表</button></p>}
          <AgentDefaultEditor scope="station" models={models} readModels={readModels} />
          <AgentDefaultEditor scope="dispatcher" models={models} readModels={readModels} />
          <div className="set-row"><span>主调度凭据</span><b className={dispatcherAdapter !== 'pi' ? 'muted' : key ? 'ok-c' : 'bad-c'}>{dispatcherAdapter !== 'pi' ? '由所选客户端管理，实际调用时验证' : key ? '已找到对应 Provider 的本机凭据' : '未就绪，请检查所选 Provider 的模型与本机凭据'}</b></div>
        </section>
        <FlowSettings />
        <section className="set-sec">
          <h3>资源配额</h3>
          {readOnly && <p className="muted" role="status">{replay ? '回放为只读，退出回放后可修改配额。' : '连接恢复后可修改配额。'}</p>}
          {FIELDS.map((f) => (
            <div key={f.k} className="set-field">
              <div><b>{f.label}</b><span className="muted">{f.hint}</span></div>
              <input aria-label={f.label} disabled={readOnly || quotaBusy} type="range" min={f.min} max={f.max} step={f.step ?? 1} value={draft[f.k] ?? 0} onChange={event => {
                setDraft(current => ({...current, [f.k]: Number(event.target.value)}));
                setEdited(current => new Set([...current, f.k]));
                setQuotaError('');
              }} />
              <b className="num set-val">{draft[f.k]}</b>
            </div>
          ))}
          {quotaError && <p className="agent-binding-error" role="alert">{quotaError}</p>}
          <div className="row-end">
            <button className="btn btn--ghost btn--sm" disabled={!dirty || quotaBusy} onClick={() => {setDraft(settings); setEdited(new Set()); setQuotaError('');}}>还原</button>
            <button className="btn btn--primary btn--sm" disabled={!dirty || readOnly || quotaBusy} onClick={() => void saveQuotas()}>{quotaBusy ? '正在保存…' : '保存'}</button>
          </div>
        </section>
        <section className="set-sec">
          <h3>画布</h3>
          <div className="set-row"><span>布局</span><button className="btn btn--sm" disabled={readOnly} onClick={() => { const L = getState().layout; saveLayout({ ...L, pos: {}, capsules: {}, open: {} }); toast("画布已重置，正在保存布局…"); }}>重置为默认布局</button></div>
          <div className="set-row"><span>节点颜色与 bot</span><button className="btn btn--sm" disabled={readOnly} onClick={() => { const L = getState().layout; saveLayout({ ...L, colors: {}, bots: {} }); toast("节点外观已恢复默认，正在保存…"); }}>一并恢复默认</button></div>
          <div className="set-row muted">拖动只写布局文件 <code className="mono">layout/factory.layout.json</code>，不改规格、不影响运行。</div>
        </section>
      </div>
    </div>
  );
}

function AgentDefaultEditor({scope, models, readModels}: {
  scope: keyof ProjectAgentDefaults;
  models: readonly PiModelChoice[];
  readModels: () => Promise<void>;
}) {
  const configured = useStore(state => state.fs.agentDefaults?.[scope]);
  const connected = useStore(state => state.connected);
  const replay = useStore(state => Boolean(state.replay));
  const revision = JSON.stringify(configured);
  const [draft, setDraft] = useState(() => agentBindingDraft(configured ?? {adapter: 'pi'}));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
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
    if (flight.current || !getState().connected || getState().replay) return;
    flight.current = true;
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
      await Promise.all([refreshSpec(), readModels()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '项目配置读取失败');
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || flight.current || !getState().connected || getState().replay) return;
    setError('');
    setReceipt('');
    try {
      const binding = parseBindingDraft(draft, true);
      if (!binding) throw new Error('请选择明确的项目默认配置。');
      flight.current = true;
      setBusy(true);
      const response = await fetch('/api/agents/defaults', {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({[scope]: binding}),
        signal: AbortSignal.timeout(20000),
      });
      const body = await response.json();
      if (!response.ok || !body.ok || !body.result?.station || !body.result?.dispatcher) throw new Error(body.error ?? '配置保存结果未确认，请重新读取核对');
      reflect(body.result);
      setReceipt(scope === 'station'
        ? '已保存。继承此默认的 Pi 工位从下一次模型请求生效；更换运行底座从下次尝试生效。'
        : binding.adapter === 'pi' ? '已保存。Pi 会话内切换模型从下一次请求生效；更换底座从新对话生效。'
          : '已保存，主调度的新对话使用此底座与模型；当前对话及检查点保留原选择。');
      await refreshSpec();
    } catch (reason) {
      setError(reason instanceof Error && reason.name === 'TimeoutError'
        ? '保存结果尚未确认，请重新读取核对，勿重复提交。'
        : reason instanceof Error ? reason.message : '配置保存失败');
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  const change = (field: keyof AgentBindingDraft, value: string) => {
    setDraft(current => ({...current, [field]: value}));
    setDirty(true);
    setReceipt('');
  };
  return <form className="agent-binding agent-default" aria-label={`${title}配置`} onSubmit={save}>
    <div className="agent-binding-heading"><b>{title}</b><span className="muted">{scope === 'dispatcher' ? '独立会话与底座' : '各工位独立执行'}</span></div>
    <p className="agent-binding-effective">{configured ? `${adapterLabel(configured.adapter)} · ${configured.model || '客户端默认模型'}` : '项目配置尚未加载'}</p>
    <AgentBindingFields draft={draft} disabled={disabled} scope={scope} change={change} selectAdapter={adapter => {
      setDraft(selectBindingAdapter(adapter, configured ?? null));
      setDirty(true);
      setReceipt('');
    }} models={models} selectModel={model => {
      setDraft(agentBindingDraft({adapter: 'pi', provider: model.provider, model: model.model}));
      setDirty(true);
      setReceipt('');
    }} />
    <p className="muted">{scope === 'dispatcher'
      ? '主调度独立选择底座和模型。Pi 会话内换模型从下一次请求生效；更换底座或原生模型从新对话生效，恢复沿用原底座。'
      : '节点的独立配置优先，此处只影响继承默认的工位。运行中也能修改 Pi 模型，下一次模型请求生效；已经发出的请求完成后再切换。'}</p>
    {error && <p className="agent-binding-error" role="alert">{error}</p>}
    {receipt && <p className="agent-binding-receipt" role="status">{receipt}</p>}
    <div className="agent-binding-actions">
      <button className="btn btn--sm btn--ghost" type="button" disabled={!connected || replay || busy} onClick={() => void read()}>重新读取</button>
      <button className="btn btn--sm btn--primary" disabled={disabled || !dirty}>{busy ? '正在保存…' : `保存${title}`}</button>
    </div>
  </form>;
}
