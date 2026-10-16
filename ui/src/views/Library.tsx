// Runnable project workflows: every create, install and feed action has a server receipt.
import {useEffect, useRef, useState} from 'react';
import { Plus, Upload, LayoutTemplate, Play, Pause, X, ArrowUpRight, Loader2 } from 'lucide-react';
import { roleColors } from '../../../shared/palette.ts';
import type {SourceCandidate, SourceSpec} from '../../../shared/types.ts';
import {getState, setState, useStore} from '../store.ts';
import {api, boot} from '../api.ts';
import { openLine } from '../canvas/Canvas.tsx';
import { isOpen } from '../canvas/geometry.ts';
import { AllocationProposal } from './AllocationProposal.tsx';
import { BusinessForm, businessLines, type BusinessLine } from './BusinessForm.tsx';
import {WorkflowBuilder} from './WorkflowBuilder.tsx';
import { workflowCall, workflowEntries, workflowInput, parseObject, inputLabel, type InstalledWorkflow, type WorkflowCatalog, type WorkflowTemplate } from './workflows.ts';
import './workflows.css';

type Panel = { kind: 'template'; template: WorkflowTemplate; id: string } | { kind: 'install' } | { kind: 'line'; pack: InstalledWorkflow } | { kind: 'feed'; pack: InstalledWorkflow; line: string } | { kind: 'business'; line: BusinessLine; title: string };

export function Library() {
  useStore(s => s.version); // Journal projections mutate run and scope objects in place.
  const factory = useStore(s => s.factory)!;
  const layout = useStore(s => s.layout);
  const run = useStore(s => s.fs.run);
  const scopes = useStore(s => s.fs.pausedScopes);
  const connected = useStore(s => s.connected);
  const replay = useStore(s => s.replay);
  const inFlight = useStore(s => Object.values(s.fs.nodes).some(node => node.active.length > 0));
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const lineFlight = useRef(false);
  const [formBusy, setFormBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const readOnly = !connected || Boolean(replay);
  const structureBlocked = readOnly || ['running', 'paused'].includes(run.status) || inFlight;
  const structureReason = replay ? '回放期间不能修改流程。' : !connected ? '连接恢复后可修改流程。' : '结束当前轮次并等待在途工位回收后，即可创建、安装或添加流程。';
  const load = async () => {
    const response = await workflowCall<WorkflowCatalog>('workflow_templates', {}, {signal: AbortSignal.timeout(20000)});
    setCatalog(response.result); return response.result;
  };
  useEffect(() => {
    if (!connected || replay) return;
    const controller = new AbortController();
    setCatalogError('');
    void workflowCall<WorkflowCatalog>('workflow_templates', {}, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    }).then(response => {
      if (!controller.signal.aborted) setCatalog(response.result);
    }).catch(reason => {
      if (!controller.signal.aborted) setCatalogError(reason instanceof Error && reason.name === 'TimeoutError'
        ? '模板读取超时，请重新读取。' : reason instanceof Error ? reason.message : '模板读取失败。');
    });
    return () => controller.abort();
  }, [factory.digest, catalogRevision, connected, replay]);
  const toggleLine = async (line: string, paused: boolean) => {
    if (lineFlight.current || !getState().connected || getState().replay) return;
    lineFlight.current = true;
    setBusy(line); setError('');
    try { const result = await workflowCall('run_control', { action: paused ? 'resume' : 'pause', line, reason: '用户在流水线库调整此线' }); setReceipt(result.summary ?? '局部运行状态已更新。'); await boot(); }
    catch (reason) { setError((reason as Error).message); } finally { lineFlight.current = false; setBusy(''); }
  };
  const done = async (message: string) => {
    setReceipt(message); setPanel(null); setBuilderOpen(false);
    try { await boot(); await load(); }
    catch (reason) { setError(`操作已完成，但页面刷新失败：${(reason as Error).message}。刷新页面可重新读取状态。`); }
  };
  const show = (next: Panel) => { if (formBusy) return; setError(''); setBuilderOpen(false); setPanel(next); };

  return <div className="view"><div className="view-inner workflows">
    <div className="view-head"><div><h1 className="view-title">流水线库</h1><div className="view-sub">从完整模板创建流程，安装自己的工作流包，再把真实任务交给它。</div></div>
      <div className="workflow-form-actions"><button className="btn" disabled={structureBlocked || Boolean(busy) || formBusy} onClick={() => {setPanel(null); setBuilderOpen(true);}}><Plus size={14} />从空白开始</button><button className="btn" disabled={structureBlocked || Boolean(busy) || formBusy} onClick={() => show({ kind: 'install' })}><Upload size={14} />安装工作流包</button></div>
    </div>
    {structureBlocked && <p className="workflow-notice" role="status">{structureReason}</p>}
    {error && <p className="workflow-error" role="alert">{error}</p>}
    {receipt && <p className="workflow-receipt" role="status">{receipt}</p>}
    <AllocationProposal />
    <Sources disabled={readOnly} digest={factory.digest} />
    {builderOpen && <WorkflowBuilder digest={factory.digest} blocked={structureBlocked} onBusy={setFormBusy} onClose={() => setBuilderOpen(false)} onDone={done} />}
    {panel && (panel.kind === 'business' ? <BusinessForm key={panel.line} line={panel.line} title={panel.title} disabled={readOnly || run.status === 'paused'} onBusy={setFormBusy} onClose={() => setPanel(null)} onDone={done} /> : <WorkflowForm key={panel.kind === 'template' ? panel.id : panel.kind === 'install' ? 'install' : `${panel.kind}:${panel.pack.id}:${panel.kind === 'feed' ? panel.line : ''}`} panel={panel} structureBlocked={structureBlocked} feedBlocked={readOnly || run.status === 'paused'} onBusy={setFormBusy} onClose={() => setPanel(null)} onDone={done} />)}
    <section className="lib-pack"><div className="lib-pack-head"><b>项目中的流程</b><span className="muted">{factory.packs.map(pack => `${pack.name} v${pack.version}`).join(' · ')}</span></div>
      <div className="lib-grid">{factory.lines.map(line => {
        const nodes = factory.nodes.filter(node => node.line === line.id);
        const owner = catalog?.installed.find(pack => pack.lines.some(entry => entry.id === line.id));
        const paused = scopes?.lines.includes(line.id) ?? false;
        return <article className="lib-line" key={line.id} data-workflow-line={line.id}>
          <div className="lib-line-head"><b>{line.name}</b><span className={`chip ${line.wired ? 'ok-chip' : ''}`}>{line.wired ? paused ? '此线已暂停' : '可运行' : '尚未接入'}</span></div>
          <p className="lib-line-blurb">{line.blurb}</p>
          <div className="lib-chain" aria-label={`${nodes.length} 个节点`}>{nodes.map(node => <i key={node.key} style={{ background: roleColors(node.role).fill, borderColor: roleColors(node.role).border }} data-tip={node.name} />)}</div>
          <div className="workflow-line-meta">{nodes.length} 个节点 · {line.priority === 'high' ? '高' : line.priority === 'mid' ? '中' : '低'}优先</div>
          <div className="lib-line-foot">
            {line.wired && <button className="btn btn--sm btn--ghost" disabled={readOnly || Boolean(busy) || formBusy} onClick={() => void toggleLine(line.id, paused)}>{busy === line.id ? <Loader2 size={12} className="spin-i" /> : paused ? <Play size={12} /> : <Pause size={12} />}{paused ? '恢复此线' : '暂停此线'}</button>}
            {owner && workflowEntries(owner).some(entry => entry.line === line.id) && <button className="btn btn--sm btn--primary" disabled={readOnly || run.status === 'paused' || formBusy} onClick={() => show({ kind: 'feed', pack: owner, line: line.id })}>提交任务</button>}
            {line.wired && businessLines.includes(line.id as BusinessLine) && <button className="btn btn--sm btn--primary" disabled={readOnly || run.status === 'paused' || formBusy} onClick={() => show({ kind: 'business', line: line.id as BusinessLine, title: line.name })}>提交任务</button>}
            <button className="btn btn--sm" onClick={() => { if (!isOpen(factory, layout, line.id)) openLine(line.id, true); setState({ view: 'canvas' }); }}>查看画布<ArrowUpRight size={12} /></button>
          </div>
        </article>;
      })}</div>
    </section>
    {Boolean(catalog?.installed.length) && <section className="lib-pack"><div className="lib-pack-head"><b>已安装工作流包</b></div><div className="workflow-installed">{catalog!.installed.map(pack => <div key={pack.id}><div><b>{pack.name}</b><small>v{pack.version} · {pack.lines.length} 条线</small></div><button className="btn btn--sm" disabled={structureBlocked || formBusy} onClick={() => show({ kind: 'line', pack })}><Plus size={13} />添加流水线</button></div>)}</div></section>}
    <section className="lib-pack"><div className="lib-pack-head"><b>可运行模板</b><span className="muted">包含岗位、输入输出契约和执行器；创建后可直接提交任务。</span></div>
      {catalogError && <p className="workflow-error" role="alert">{catalogError} <button className="btn btn--sm" disabled={readOnly} onClick={() => setCatalogRevision(value => value + 1)}>重新读取模板</button></p>}
      {!catalog ? !catalogError && <p className="muted">{replay ? '退出回放后可读取可用模板。' : !connected ? '连接恢复后可读取可用模板。' : '正在读取服务端模板…'}</p> : !catalog.templates.length ? <p className="muted">当前没有可用模板，可以安装自己的工作流包。</p> : <div className="lib-grid">{catalog.templates.map(template => <article className="lib-line" key={template.id} data-workflow-template={template.id}>
        <div className="lib-line-head"><LayoutTemplate size={15} /><b>{template.name}</b></div><p className="lib-line-blurb">{template.description}</p>
        <div className="workflow-line-meta">输入：{Object.keys(template.inputSchema.properties ?? {}).map(inputLabel).join('、') || '按入口契约填写'}</div>
        <div className="lib-line-foot"><button className="btn btn--sm btn--primary" disabled={structureBlocked || formBusy} onClick={() => show({ kind: 'template', template, id: `flow-${crypto.randomUUID().slice(0, 8)}` })}><Plus size={13} />创建工作流</button></div>
      </article>)}</div>}
    </section>
    <p className="muted lib-note">安装与结构修改由你操作后生效，运行及暂停期间保持当前结构。当前规格 <code className="mono">{factory.digest.slice(0, 12)}</code></p>
  </div></div>;
}

interface SourceStatus extends SourceSpec {
  nextAt: number;
  nextAllowedAt: number;
  count: number;
  duplicates: number;
  invalid?: number;
  running: boolean;
  attention?: string;
  failure?: {message: string; tag: string};
  deferred?: {reason: string; nextAt: number};
  deliveryHold?: string;
  counts: Record<SourceCandidate['status'], number> & {total: number};
  candidates: SourceCandidate[];
}
interface SourceCatalog {
  sources: SourceStatus[];
  targets: {key: string; name: string; line: string}[];
}

function Sources({disabled, digest}: {disabled: boolean; digest: string}) {
  const [catalog, setCatalog] = useState<SourceCatalog | null>(null);
  const [revision, setRevision] = useState(0);
  const [form, setForm] = useState(false);
  const [draft, setDraft] = useState({id: `source-${crypto.randomUUID().slice(0, 8)}`, name: '', url: '', format: 'rss', target: '', minutes: '360', enabled: false, input: '', constants: ''});
  const [busy, setBusy] = useState('');
  const flight = useRef(false);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  useEffect(() => {
    if (disabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch('/api/tools/source_list', {
          method: 'POST', headers: {'content-type': 'application/json'}, body: '{}',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error ?? '持续来源状态读取失败');
        if (active) {
          setCatalog(result.result as SourceCatalog);
          setLoadError('');
        }
      } catch (reason) {
        if (active) setLoadError(reason instanceof Error && reason.name === 'TimeoutError'
          ? '来源状态读取超时，请重新读取。' : reason instanceof Error ? reason.message : '持续来源状态读取失败');
      } finally {
        if (active) timer = setTimeout(refresh, 15000);
      }
    };
    void refresh();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [disabled, digest, revision]);
  const mutate = async (action: 'configure' | 'enable' | 'poll', body: Record<string, unknown>, id: string) => {
    if (disabled || flight.current || !getState().connected || getState().replay) return;
    flight.current = true;
    setBusy(id);
    setError('');
    setReceipt('');
    try {
      const response = await api.post<{ok: boolean; summary: string; result: {ok?: boolean; cancelled?: boolean; attention?: string; failure?: {message: string}; count?: number; duplicates?: number; invalid?: number; deferred?: boolean; reason?: string; nextAt?: number}}>(`/api/sources/${action}`, body);
      if (!response.ok) throw new Error(response.summary);
      const result = response.result;
      if (action === 'poll' && result.ok === false) {
        throw new Error(result.attention || result.failure?.message ||
          (result.cancelled ? '本次采集已取消，候选和出处已保留。' : '本次采集失败，请查看来源状态。'));
      }
      setReceipt(action !== 'poll' ? response.summary : result.deferred
        ? `${result.reason}；下次可采集 ${new Date(result.nextAt!).toLocaleString()}`
        : `本次采集新增 ${result.count}，重复 ${result.duplicates}，跳过坏条目 ${result.invalid ?? 0}。`);
      if (action === 'configure') {
        setForm(false);
        setDraft({...draft, id: `source-${crypto.randomUUID().slice(0, 8)}`, name: '', url: '', enabled: false});
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '来源操作失败，请核对状态后再试');
    } finally {
      flight.current = false;
      setBusy('');
      setRevision(value => value + 1);
    }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const input = draft.input.trim() ? parseObject(draft.input, '来源输入映射') : undefined;
      if (input && Object.values(input).some(value => typeof value !== 'string')) throw new Error('来源输入映射的值必须是字段路径字符串。');
      const constants = draft.constants.trim() ? parseObject(draft.constants, '来源常量') : undefined;
      void mutate('configure', {
        id: draft.id, name: draft.name.trim(), url: draft.url.trim(), format: draft.format,
        target: draft.target || catalog?.targets[0]?.key, intervalMs: Number(draft.minutes) * 60000,
        enabled: draft.enabled, ...(input ? {input} : {}), ...(constants ? {constants} : {}),
      }, 'configure');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '来源输入无效');
    }
  };
  const update = (field: keyof typeof draft, value: string | boolean) => setDraft(current => ({...current, [field]: value}));
  return <section className="lib-pack source-section" aria-label="持续来源">
    <div className="lib-pack-head"><b>持续来源</b><span className="muted">只采集你配置的地址；新候选照常通过完整流水线。</span><button className="btn btn--sm" disabled={disabled || Boolean(busy)} onClick={() => setForm(value => !value)}><Plus size={13} />添加来源</button></div>
    {error && <p className="workflow-error" role="alert">{error}</p>}
    {loadError && <p className="workflow-error" role="alert">{loadError} <button className="btn btn--sm" disabled={disabled} onClick={() => setRevision(value => value + 1)}>重新读取来源</button></p>}
    {receipt && <p className="workflow-receipt" role="status">{receipt}</p>}
    {form && <form className="workflow-form source-form" aria-label="配置持续来源" onSubmit={submit}>
      <fieldset disabled={disabled || Boolean(busy)} style={{display: 'contents'}}>
      <div className="source-fields">
        <label>来源名称<input required value={draft.name} onChange={event => update('name', event.target.value)} /></label>
        <label>采集格式<select aria-label="采集格式" value={draft.format} onChange={event => update('format', event.target.value)}><option value="rss">RSS / Atom / Sitemap</option><option value="json">JSON 列表</option><option value="browser">共享浏览器页面</option></select></label>
      </div>
      <label>来源地址<input required type="url" value={draft.url} onChange={event => update('url', event.target.value)} placeholder="https://example.com/feed.xml" /></label>
      <div className="source-fields">
        <label>候选入口<select aria-label="候选入口" required value={draft.target || catalog?.targets[0]?.key || ''} onChange={event => update('target', event.target.value)}>{catalog?.targets.map(target => <option key={target.key} value={target.key}>{target.name} · {target.line}</option>)}</select></label>
        <label>采集间隔（分钟）<input required type="number" min="1" max="43200" step="1" value={draft.minutes} onChange={event => update('minutes', event.target.value)} /></label>
      </div>
      <details><summary>输入映射与常量（需要时填写）</summary><p>可用来源字段：url、title、text、excerpt、author。映射值为字段路径，例如 {JSON.stringify({text: 'excerpt'})}。</p><label>来源输入映射（JSON）<textarea aria-label="来源输入映射（JSON）" rows={3} value={draft.input} onChange={event => update('input', event.target.value)} placeholder='{"text":"excerpt"}' /></label><label>来源常量（JSON）<textarea aria-label="来源常量（JSON）" rows={3} value={draft.constants} onChange={event => update('constants', event.target.value)} placeholder="{}" /></label></details>
      <label className="workflow-check"><input type="checkbox" checked={draft.enabled} onChange={event => update('enabled', event.target.checked)} />保存后启用定期采集</label>
      <p>默认停用。停用时“采集一次”只保存候选；启用后，在运行中的轮次按空位投料，默认一次仅 1 件。社交页面需你先在共享浏览器登录。</p>
      <div className="workflow-form-actions"><button type="button" className="btn btn--sm" disabled={Boolean(busy)} onClick={() => setForm(false)}>取消添加来源</button><button className="btn btn--sm btn--primary" disabled={disabled || Boolean(busy) || !catalog?.targets.length}>{busy === 'configure' ? '正在保存…' : '保存来源配置'}</button></div>
      </fieldset>
    </form>}
    {!catalog ? <p className="muted">{disabled ? '连接服务并退出回放后可查看来源。' : loadError ? '来源状态暂不可用。' : '正在读取持续来源…'}</p> : !catalog.sources.length ? <p className="muted">尚未配置来源，不会自动发起采集。</p> : <div className="source-list">{catalog.sources.map(source => <article className="source-row" key={source.id} data-source-id={source.id}>
      <div className="source-row-head"><b>{source.name}</b><span className="chip">{source.running ? '正在采集' : source.attention ? '需处理' : source.failure ? '上次采集失败' : source.enabled ? '已启用' : '已停用'}</span><span className="mono muted">{source.target}</span></div>
      <p className="source-address">{source.url}</p>
      <p className="muted">候选 {source.counts.total} · 待投 {source.counts.pending + source.counts.blocked} · 已投未完成 {source.counts.delivered + source.counts.failed} · 已确认 {source.counts.acknowledged} · 已排除 {source.counts.rejected} · {source.nextAt ? `上次新增 ${source.count} / 重复 ${source.duplicates} / 坏条目 ${source.invalid ?? 0}` : '尚未采集'}</p>
      {(source.attention || source.failure || source.deferred || source.deliveryHold) && <p className={source.attention || source.failure ? 'source-attention' : 'muted'}>{source.attention || source.failure?.message || source.deferred?.reason || source.deliveryHold}</p>}
      <div className="source-row-foot"><span className="muted">{source.enabled && !source.attention ? source.nextAt ? `下次计划 ${new Date(Math.max(source.nextAt, source.nextAllowedAt, source.deferred?.nextAt ?? 0)).toLocaleString()}` : '等待首次计划采集' : '候选和出处已保留'}</span><button className="btn btn--sm" disabled={disabled || Boolean(busy) || source.running} onClick={() => void mutate('poll', {id: source.id}, source.id)}>采集一次</button><button className="btn btn--sm" disabled={disabled || Boolean(busy)} onClick={() => void mutate('enable', {id: source.id, enabled: !source.enabled}, source.id)}>{source.enabled ? '停用来源' : '启用来源'}</button></div>
    </article>)}</div>}
  </section>;
}

function WorkflowForm({ panel, structureBlocked, feedBlocked, onBusy, onClose, onDone }: { panel: Exclude<Panel, {kind: 'business'}>; structureBlocked: boolean; feedBlocked: boolean; onBusy: (busy: boolean) => void; onClose: () => void; onDone: (message: string) => Promise<void> }) {
  const [name, setName] = useState(panel.kind === 'template' ? panel.template.name : '');
  const [directory, setDirectory] = useState('');
  const [json, setJson] = useState('');
  const [installMode, setInstallMode] = useState<'directory' | 'json'>('directory');
  const [replace, setReplace] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [feedLine, setFeedLine] = useState(panel.kind === 'feed' ? panel.line : '');
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const [error, setError] = useState('');
  const blocked = panel.kind === 'feed' ? feedBlocked : structureBlocked;
  const entries = panel.kind === 'feed' ? workflowEntries(panel.pack) : [];
  const schema = entries.find(entry => entry.line === feedLine)?.schema;
  const fields = Object.entries(schema?.properties ?? {});
  const heading = panel.kind === 'template' ? `创建 · ${panel.template.name}` : panel.kind === 'install' ? '安装工作流包' : panel.kind === 'line' ? `为 ${panel.pack.name} 添加流水线` : `提交任务 · ${panel.pack.name}`;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (flight.current || blocked || !getState().connected || getState().replay) return;
    flight.current = true;
    setBusy(true); onBusy(true); setError('');
    try {
      if ((panel.kind === 'template' || panel.kind === 'feed') && !name.trim()) throw new Error('请填写名称，不能仅包含空格。');
      let response;
      if (panel.kind === 'template') response = await workflowCall('workflow_template', { templateId: panel.template.id, id: panel.id, name: name.trim(), includeBuiltins: true });
      else if (panel.kind === 'install') response = await workflowCall('workflow_install', installMode === 'directory' ? { directory: directory.trim(), replace } : { ...parseObject(json, '工作流包'), replace });
      else if (panel.kind === 'line') response = await workflowCall('workflow_line', { ...parseObject(json, '流水线定义'), packId: panel.pack.id });
      else response = await workflowCall('workflow_feed', { packId: panel.pack.id, ...(panel.pack.entry.startsWith(`${feedLine}/`) ? {} : { line: feedLine }), item: name.trim(), input: fields.length ? workflowInput(schema!, values) : parseObject(json, '任务输入') });
      await onDone(response.summary ?? '操作已完成，状态已刷新。');
    } catch (reason) { setError((reason as Error).message); } finally { flight.current = false; setBusy(false); onBusy(false); }
  };
  return <form className="workflow-form" onSubmit={event => void submit(event)} aria-label={heading}>
    <div className="workflow-form-head"><h2>{heading}</h2><button type="button" className="icon-btn" disabled={busy} aria-label="关闭工作流表单" onClick={onClose}><X size={15} /></button></div>
    <fieldset disabled={busy || blocked} style={{display: 'contents'}}>
    {panel.kind === 'template' && <><p>{panel.template.description}</p><label>工作流名称<input autoFocus required value={name} maxLength={120} onChange={event => setName(event.target.value)} /></label><small>创建后保留当前项目中的预设流程。新任务会按模板的入口契约执行。</small></>}
    {panel.kind === 'install' && <>
      <div className="workflow-mode"><button type="button" className={installMode === 'directory' ? 'is-on' : ''} onClick={() => setInstallMode('directory')}>从本地目录安装</button><button type="button" className={installMode === 'json' ? 'is-on' : ''} onClick={() => setInstallMode('json')}>粘贴包内容</button></div>
      {installMode === 'directory' ? <label>工作流目录<input autoFocus required value={directory} onChange={event => setDirectory(event.target.value)} placeholder="包含 pack.json 与角色文件的目录" /></label> : <label>包内容（JSON）<textarea required rows={8} value={json} onChange={event => setJson(event.target.value)} placeholder={'{ "manifest": { ... }, "files": { "roles/step/ROLE.md": "..." } }'} spellCheck={false} /></label>}
      <label className="workflow-check"><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)} />更新同标识的已安装包</label>
    </>}
    {panel.kind === 'line' && <><p>提交该线的工位、连线、契约和角色文件。服务端校验通过后才会加入项目。</p><label>流水线定义（JSON）<textarea autoFocus required rows={9} value={json} onChange={event => setJson(event.target.value)} placeholder={'{ "line": { ... }, "bindings": { ... }, "schemas": { ... }, "files": { ... } }'} spellCheck={false} /></label></>}
    {panel.kind === 'feed' && <>{entries.length > 1 && <label>投料流水线<select value={feedLine} onChange={event => { setFeedLine(event.target.value); setValues({}); setJson(''); }}>{entries.map(entry => <option key={entry.line} value={entry.line}>{entry.name}</option>)}</select></label>}<label>任务名称<input autoFocus required value={name} maxLength={160} onChange={event => setName(event.target.value)} placeholder="为这次任务取一个便于追踪的名称" /></label>{fields.length ? fields.map(([field, rule]) => <label key={field}>{rule.title || inputLabel(field)}{schema?.required?.includes(field) ? ' *' : ''}{rule.enum ? <select required={schema?.required?.includes(field)} value={values[field] ?? ''} onChange={event => setValues({ ...values, [field]: event.target.value })}><option value="">请选择</option>{rule.enum.map(value => <option key={JSON.stringify(value)} value={JSON.stringify(value)}>{String(value)}</option>)}</select> : rule.type === 'boolean' ? <select required={schema?.required?.includes(field)} value={values[field] ?? (schema?.required?.includes(field) ? 'false' : '')} onChange={event => setValues({ ...values, [field]: event.target.value })}>{!schema?.required?.includes(field) && <option value="">不指定</option>}<option value="false">否</option><option value="true">是</option></select> : <textarea required={schema?.required?.includes(field)} minLength={rule.minLength} rows={field === 'url' ? 2 : 4} value={values[field] ?? ''} onChange={event => setValues({ ...values, [field]: event.target.value })} placeholder={rule.type === 'array' ? '每行一项' : rule.description ?? ''} />}{rule.description && <small>{rule.description}</small>}</label>) : <label>任务输入（JSON）<textarea required rows={7} value={json} onChange={event => setJson(event.target.value)} placeholder="{}" /></label>}</>}
    </fieldset>
    {error && <p className="workflow-error" role="alert">{error}</p>}
    <div className="workflow-form-actions"><button type="button" className="btn btn--sm" disabled={busy} onClick={onClose}>取消</button><button className="btn btn--sm btn--primary" disabled={busy || blocked}>{busy ? <Loader2 size={13} className="spin-i" /> : panel.kind === 'feed' ? <Play size={13} /> : <Plus size={13} />}{busy ? '正在处理…' : panel.kind === 'feed' ? '验证输入并投料' : panel.kind === 'template' ? '创建可运行工作流' : panel.kind === 'line' ? '添加到项目' : '校验并安装'}</button></div>
  </form>;
}
