// Runnable project workflows: every create, install and feed action has a server receipt.
import { useEffect, useState } from 'react';
import { Plus, Upload, LayoutTemplate, Play, Pause, X, ArrowUpRight, Loader2 } from 'lucide-react';
import { roleColors } from '../../../shared/palette.ts';
import { setState, useStore } from '../store.ts';
import { boot } from '../api.ts';
import { openLine } from '../canvas/Canvas.tsx';
import { isOpen } from '../canvas/geometry.ts';
import { AllocationProposal } from './AllocationProposal.tsx';
import { BusinessForm, businessLines, type BusinessLine } from './BusinessForm.tsx';
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
  const [panel, setPanel] = useState<Panel | null>(null);
  const [busy, setBusy] = useState('');
  const [formBusy, setFormBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const readOnly = !connected || Boolean(replay);
  const structureBlocked = readOnly || ['running', 'paused'].includes(run.status) || inFlight;
  const structureReason = replay ? '回放期间不能修改流程。' : !connected ? '连接恢复后可修改流程。' : '结束当前轮次并等待在途工位回收后，即可创建、安装或添加流程。';
  const load = async () => {
    const response = await workflowCall<WorkflowCatalog>('workflow_templates', {});
    setCatalog(response.result); return response.result;
  };
  useEffect(() => { let current = true; void workflowCall<WorkflowCatalog>('workflow_templates', {}).then(response => { if (current) setCatalog(response.result); }).catch(reason => { if (current) setError(reason.message); }); return () => { current = false; }; }, [factory.digest]);
  const toggleLine = async (line: string, paused: boolean) => {
    setBusy(line); setError('');
    try { const result = await workflowCall('run_control', { action: paused ? 'resume' : 'pause', line, reason: '用户在流水线库调整此线' }); setReceipt(result.summary ?? '局部运行状态已更新。'); await boot(); }
    catch (reason) { setError((reason as Error).message); } finally { setBusy(''); }
  };
  const done = async (message: string) => {
    setReceipt(message); setPanel(null);
    try { await boot(); await load(); }
    catch (reason) { setError(`操作已完成，但页面刷新失败：${(reason as Error).message}。刷新页面可重新读取状态。`); }
  };
  const show = (next: Panel) => { if (formBusy) return; setError(''); setPanel(next); };

  return <div className="view"><div className="view-inner workflows">
    <div className="view-head"><div><h1 className="view-title">流水线库</h1><div className="view-sub">从完整模板创建流程，安装自己的工作流包，再把真实任务交给它。</div></div>
      <button className="btn" disabled={structureBlocked || Boolean(busy) || formBusy} onClick={() => show({ kind: 'install' })}><Upload size={14} />安装工作流包</button>
    </div>
    {structureBlocked && <p className="workflow-notice" role="status">{structureReason}</p>}
    {error && <p className="workflow-error" role="alert">{error}</p>}
    {receipt && <p className="workflow-receipt" role="status">{receipt}</p>}
    <AllocationProposal />
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
      {!catalog ? <p className="muted">正在读取服务端模板…</p> : <div className="lib-grid">{catalog.templates.map(template => <article className="lib-line" key={template.id} data-workflow-template={template.id}>
        <div className="lib-line-head"><LayoutTemplate size={15} /><b>{template.name}</b></div><p className="lib-line-blurb">{template.description}</p>
        <div className="workflow-line-meta">输入：{Object.keys(template.inputSchema.properties ?? {}).map(inputLabel).join('、') || '按入口契约填写'}</div>
        <div className="lib-line-foot"><button className="btn btn--sm btn--primary" disabled={structureBlocked || formBusy} onClick={() => show({ kind: 'template', template, id: `flow-${crypto.randomUUID().slice(0, 8)}` })}><Plus size={13} />创建工作流</button></div>
      </article>)}</div>}
    </section>
    <p className="muted lib-note">安装与结构修改由你操作后生效，运行及暂停期间保持当前结构。当前规格 <code className="mono">{factory.digest.slice(0, 12)}</code></p>
  </div></div>;
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
  const [error, setError] = useState('');
  const blocked = panel.kind === 'feed' ? feedBlocked : structureBlocked;
  const entries = panel.kind === 'feed' ? workflowEntries(panel.pack) : [];
  const schema = entries.find(entry => entry.line === feedLine)?.schema;
  const fields = Object.entries(schema?.properties ?? {});
  const heading = panel.kind === 'template' ? `创建 · ${panel.template.name}` : panel.kind === 'install' ? '安装工作流包' : panel.kind === 'line' ? `为 ${panel.pack.name} 添加流水线` : `提交任务 · ${panel.pack.name}`;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || blocked) return; setBusy(true); onBusy(true); setError('');
    try {
      let response;
      if (panel.kind === 'template') response = await workflowCall('workflow_template', { templateId: panel.template.id, id: panel.id, name: name.trim(), includeBuiltins: true });
      else if (panel.kind === 'install') response = await workflowCall('workflow_install', installMode === 'directory' ? { directory: directory.trim(), replace } : { ...parseObject(json, '工作流包'), replace });
      else if (panel.kind === 'line') response = await workflowCall('workflow_line', { ...parseObject(json, '流水线定义'), packId: panel.pack.id });
      else response = await workflowCall('workflow_feed', { packId: panel.pack.id, ...(panel.pack.entry.startsWith(`${feedLine}/`) ? {} : { line: feedLine }), item: name.trim(), input: fields.length ? workflowInput(schema!, values) : parseObject(json, '任务输入') });
      await onDone(response.summary ?? '操作已完成，状态已刷新。');
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); onBusy(false); }
  };
  return <form className="workflow-form" onSubmit={event => void submit(event)} aria-label={heading}>
    <div className="workflow-form-head"><h2>{heading}</h2><button type="button" className="icon-btn" disabled={busy} aria-label="关闭工作流表单" onClick={onClose}><X size={15} /></button></div>
    {panel.kind === 'template' && <><p>{panel.template.description}</p><label>工作流名称<input autoFocus required value={name} maxLength={120} onChange={event => setName(event.target.value)} /></label><small>创建后保留当前项目中的预设流程。新任务会按模板的入口契约执行。</small></>}
    {panel.kind === 'install' && <>
      <div className="workflow-mode"><button type="button" className={installMode === 'directory' ? 'is-on' : ''} onClick={() => setInstallMode('directory')}>从本地目录安装</button><button type="button" className={installMode === 'json' ? 'is-on' : ''} onClick={() => setInstallMode('json')}>粘贴包内容</button></div>
      {installMode === 'directory' ? <label>工作流目录<input autoFocus required value={directory} onChange={event => setDirectory(event.target.value)} placeholder="包含 pack.json 与角色文件的目录" /></label> : <label>包内容（JSON）<textarea required rows={8} value={json} onChange={event => setJson(event.target.value)} placeholder={'{ "manifest": { ... }, "files": { "roles/step/ROLE.md": "..." } }'} spellCheck={false} /></label>}
      <label className="workflow-check"><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)} />更新同标识的已安装包</label>
    </>}
    {panel.kind === 'line' && <><p>提交该线的工位、连线、契约和角色文件。服务端校验通过后才会加入项目。</p><label>流水线定义（JSON）<textarea autoFocus required rows={9} value={json} onChange={event => setJson(event.target.value)} placeholder={'{ "line": { ... }, "bindings": { ... }, "schemas": { ... }, "files": { ... } }'} spellCheck={false} /></label></>}
    {panel.kind === 'feed' && <>{entries.length > 1 && <label>投料流水线<select value={feedLine} onChange={event => { setFeedLine(event.target.value); setValues({}); setJson(''); }}>{entries.map(entry => <option key={entry.line} value={entry.line}>{entry.name}</option>)}</select></label>}<label>任务名称<input autoFocus required value={name} maxLength={160} onChange={event => setName(event.target.value)} placeholder="为这次任务取一个便于追踪的名称" /></label>{fields.length ? fields.map(([field, rule]) => <label key={field}>{rule.title || inputLabel(field)}{schema?.required?.includes(field) ? ' *' : ''}{rule.enum ? <select required={schema?.required?.includes(field)} value={values[field] ?? ''} onChange={event => setValues({ ...values, [field]: event.target.value })}><option value="">请选择</option>{rule.enum.map(value => <option key={JSON.stringify(value)} value={JSON.stringify(value)}>{String(value)}</option>)}</select> : rule.type === 'boolean' ? <select value={values[field] ?? 'false'} onChange={event => setValues({ ...values, [field]: event.target.value })}><option value="false">否</option><option value="true">是</option></select> : <textarea required={schema?.required?.includes(field)} minLength={rule.minLength} rows={field === 'url' ? 2 : 4} value={values[field] ?? ''} onChange={event => setValues({ ...values, [field]: event.target.value })} placeholder={rule.type === 'array' ? '每行一项' : rule.description ?? ''} />}{rule.description && <small>{rule.description}</small>}</label>) : <label>任务输入（JSON）<textarea required rows={7} value={json} onChange={event => setJson(event.target.value)} placeholder="{}" /></label>}</>}
    {error && <p className="workflow-error" role="alert">{error}</p>}
    <div className="workflow-form-actions"><button type="button" className="btn btn--sm" disabled={busy} onClick={onClose}>取消</button><button className="btn btn--sm btn--primary" disabled={busy || blocked}>{busy ? <Loader2 size={13} className="spin-i" /> : panel.kind === 'feed' ? <Play size={13} /> : <Plus size={13} />}{busy ? '正在处理…' : panel.kind === 'feed' ? '验证输入并投料' : panel.kind === 'template' ? '创建可运行工作流' : panel.kind === 'line' ? '添加到项目' : '校验并安装'}</button></div>
  </form>;
}
