import {useEffect, useRef, useState} from 'react';
import {Plus, Trash2, X} from 'lucide-react';
import {getState} from '../store.ts';
import {workflowCall} from './workflows.ts';
import {compileWorkflowDraft, draftOperations, emptyWorkflowDraft, newDraftNode, removeDraftNode, type DraftNode, type DraftOperation, type WorkflowDraft} from './workflow-draft.ts';

type DraftLayout = Record<string, {x: number; y: number}>;
interface SavedDraft {draft: WorkflowDraft; layout: DraftLayout}
const retainedDrafts = new Map<string, SavedDraft>();
const storageKey = (digest: string) => `easy-workflow.draft.${digest}`;

function readDraft(digest: string): SavedDraft {
  const retained = retainedDrafts.get(digest);
  if (retained) return retained;
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey(digest)) ?? 'null');
    if (saved && typeof saved === 'object' && 'draft' in saved && 'layout' in saved) {
      const {draft, layout} = saved as SavedDraft;
      if (draft && typeof draft.id === 'string' && typeof draft.name === 'string' && typeof draft.inputSchema === 'string' &&
        Array.isArray(draft.nodes) && draft.nodes.length <= 30 && Array.isArray(draft.edges) &&
        draft.nodes.every(node => node && ['id', 'name', 'inputSchema', 'outputSchema', 'mapping', 'accept'].every(key => typeof node[key as keyof DraftNode] === 'string') && draftOperations.some(operation => operation.id === node.operation)) &&
        draft.edges.every(edge => edge && typeof edge.from === 'string' && typeof edge.to === 'string') &&
        layout && typeof layout === 'object' && !Array.isArray(layout) && Object.values(layout).every(position => position && Number.isFinite(position.x) && Number.isFinite(position.y) && position.x >= 0 && position.y >= 0)) return {draft, layout};
    }
  } catch { /* A corrupt or unavailable local draft must not prevent opening the editor. */ }
  return {draft: emptyWorkflowDraft(), layout: {}};
}

export function WorkflowBuilder({blocked, digest, onBusy, onClose, onDone}: {
  blocked: boolean;
  digest: string;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [initial] = useState(() => readDraft(digest));
  const [draft, setDraft] = useState(initial.draft);
  const [layout, setLayout] = useState(initial.layout);
  const [connecting, setConnecting] = useState('');
  const [storageWarning, setStorageWarning] = useState('');
  const installed = useRef(false);
  const dragging = useRef<{id: string; pointerX: number; pointerY: number; x: number; y: number} | null>(null);
  useEffect(() => {
    if (installed.current) return;
    const saved = {draft, layout};
    retainedDrafts.set(digest, saved);
    try {sessionStorage.setItem(storageKey(digest), JSON.stringify(saved)); setStorageWarning('');}
    catch {setStorageWarning('浏览器未允许会话存储，草稿仅保留至本窗口刷新前。');}
  }, [draft, layout, digest]);
  const [selected, setSelected] = useState('');
  const [operation, setOperation] = useState<DraftOperation>('normalize-text');
  const [connectPrevious, setConnectPrevious] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [checked, setChecked] = useState('');
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const current = draft.nodes.find(node => node.id === selected);
  const change = (next: WorkflowDraft) => {setDraft(next); setChecked(''); setError('');};
  const editNode = (updates: Partial<DraftNode>) => change({...draft, nodes: draft.nodes.map(node => node.id === selected ? {...node, ...updates} : node)});
  const add = () => {
    const node = newDraftNode(operation, draft.nodes);
    const previous = draft.nodes.at(-1);
    change({...draft, nodes: [...draft.nodes, node], edges: connectPrevious && previous ? [...draft.edges, {from: previous.id, to: node.id}] : draft.edges});
    setSelected(node.id);
  };
  const remove = () => {
    change(removeDraftNode(draft, selected));
    setLayout(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== selected)));
    if (connecting === selected) setConnecting('');
    setSelected('');
    if (from === selected) setFrom('');
    if (to === selected) setTo('');
  };
  const connect = () => {
    if (!from || !to || from === to) {setError('请为连线选择两个不同的节点。'); return;}
    if (draft.edges.some(edge => edge.from === from && edge.to === to)) {setError('这两个节点已经连接。'); return;}
    change({...draft, edges: [...draft.edges, {from, to}]});
  };
  const connectPort = (target: string) => {
    if (!connecting || connecting === target) return;
    if (draft.edges.some(edge => edge.from === connecting && edge.to === target)) setError('这两个节点已经连接。');
    else change({...draft, edges: [...draft.edges, {from: connecting, to: target}]});
    setConnecting('');
  };
  const check = () => {
    try {
      compileWorkflowDraft(draft);
      setError('');
      setChecked('草稿结构检查通过。安装时还会校验完整契约与项目兼容性，当前尚未生效。');
    } catch (reason) {setChecked(''); setError(reason instanceof Error ? reason.message : '草稿检查失败。');}
  };
  const install = async (event: React.FormEvent) => {
    event.preventDefault();
    const state = getState();
    if (flight.current || blocked || !state.connected || state.replay ||
      ['running', 'paused'].includes(state.fs.run.status) || Object.values(state.fs.nodes).some(node => node.active.length)) return;
    try {
      const request = compileWorkflowDraft(draft);
      flight.current = true;
      setBusy(true);
      onBusy(true);
      setError('');
      const response = await workflowCall('workflow_install', request);
      installed.current = true;
      retainedDrafts.delete(digest);
      try {sessionStorage.removeItem(storageKey(digest));} catch { /* Installation is independent of local draft storage. */ }
      await onDone(response.summary ?? '工作流已校验并安装，可提交任务运行。');
    } catch (reason) {setError(reason instanceof Error ? reason.message : '安装失败，草稿已保留。');}
    finally {flight.current = false; setBusy(false); onBusy(false);}
  };
  const positions = new Map(draft.nodes.map((node, index) => [node.id, layout[node.id] ?? {x: 20 + index % 3 * 210, y: 25 + Math.floor(index / 3) * 112}]));
  const graphHeight = Math.max(140, ...[...positions.values()].map(position => position.y + 105));
  const graphWidth = Math.max(650, ...[...positions.values()].map(position => position.x + 210));
  return <form className="workflow-form workflow-builder" aria-label="空白工作流编辑器" onSubmit={event => void install(event)}>
    <div className="workflow-form-head"><h2>从空白开始</h2><span>草稿 · 尚未生效</span><button type="button" className="icon-btn" aria-label="关闭空白工作流编辑器" disabled={busy} onClick={onClose}><X size={15} /></button></div>
    <p>拖动节点整理草稿，点击节点右侧输出端口、再点目标左侧输入端口连接。当前支持文本处理与 JSON 文件交付，不调用模型；复杂 Agent 和外部工具可从模板或工作流包安装。</p>
    <p>{storageWarning || '草稿自动保存在本窗口的当前规格下，收起或刷新后可继续编辑；安装前不影响运行中的项目。'}</p>
    <fieldset disabled={blocked || busy} style={{display: 'contents'}}>
      <div className="source-fields">
        <label>工作流名称<input autoFocus required maxLength={120} value={draft.name} onChange={event => change({...draft, name: event.target.value})} placeholder="例如：文本统计交付" /></label>
        <label>工作流标识<input required pattern="[a-z][a-z0-9-]{0,63}" value={draft.id} onChange={event => change({...draft, id: event.target.value})} /><small>安装后作为流水线的稳定标识。</small></label>
      </div>
      {connecting && <p role="status">正在从 {draft.nodes.find(node => node.id === connecting)?.name} 连线。请选择目标节点的输入端口。<button type="button" className="btn btn--ghost btn--sm" onClick={() => setConnecting('')}>取消连线</button></p>}
      <details><summary>工作流的任务输入契约</summary><label>工作流输入契约（JSON Schema）<textarea rows={7} spellCheck={false} value={draft.inputSchema} onChange={event => change({...draft, inputSchema: event.target.value})} /></label><p>任务表单由该契约生成，节点通过 input.字段名 读取原始输入。</p></details>
      <div className="draft-add">
        <label>添加程序<select aria-label="添加程序" value={operation} onChange={event => setOperation(event.target.value as DraftOperation)}>{draftOperations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <button className="btn btn--sm" type="button" disabled={draft.nodes.length >= 30} onClick={add}><Plus size={13} />添加节点</button>
        <label className="workflow-check"><input type="checkbox" checked={connectPrevious} onChange={event => setConnectPrevious(event.target.checked)} />自动连接上一节点</label>
      </div>
      <div className="draft-graph" aria-label="草稿节点与连线">
        {!draft.nodes.length ? <p className="draft-empty">画布为空。先添加处理节点，再添加“保存 JSON 产物”作为末端。</p> : <div className="draft-stage" style={{height: graphHeight, width: graphWidth}}>
          <svg width={graphWidth} height={graphHeight} aria-hidden="true"><defs><marker id="draft-edge-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#7c8ea8" /></marker></defs>{draft.edges.map(edge => {
            const start = positions.get(edge.from), end = positions.get(edge.to);
            if (!start || !end) return null;
            const x1 = start.x + 180, y1 = start.y + 35, x2 = end.x, y2 = end.y + 35;
            return <path key={`${edge.from}:${edge.to}`} d={`M${x1},${y1} C${x1 + 30},${y1} ${x2 - 30},${y2} ${x2},${y2}`} fill="none" stroke="#7c8ea8" strokeWidth="1.5" markerEnd="url(#draft-edge-arrow)" />;
          })}</svg>
          {draft.nodes.map(node => <div key={node.id} className={`draft-node ${selected === node.id ? 'is-selected' : ''}`} style={{left: positions.get(node.id)!.x, top: positions.get(node.id)!.y}}>
            <button type="button" className="draft-node-body" aria-pressed={selected === node.id} aria-label={`编辑节点 ${node.name} ${node.id}`} onClick={() => setSelected(node.id)}
              onPointerDown={event => {
                if (event.button !== 0 || busy || blocked) return;
                const position = positions.get(node.id)!;
                dragging.current = {id: node.id, pointerX: event.clientX, pointerY: event.clientY, ...position};
                event.currentTarget.setPointerCapture(event.pointerId);
              }} onPointerMove={event => {
                const drag = dragging.current;
                if (!drag || drag.id !== node.id) return;
                setLayout(current => ({...current, [node.id]: {x: Math.max(20, Math.min(2000, drag.x + event.clientX - drag.pointerX)), y: Math.max(25, Math.min(3000, drag.y + event.clientY - drag.pointerY))}}));
              }} onPointerUp={() => {dragging.current = null;}} onPointerCancel={() => {dragging.current = null;}}>
              <strong>{node.name}</strong><small>{node.id} · 程序执行</small>
            </button>
            <button type="button" className="draft-port draft-port--input" aria-label={`连接到 ${node.name} ${node.id}`} disabled={!connecting || connecting === node.id} onClick={() => connectPort(node.id)} title="输入端口" />
            <button type="button" className={`draft-port draft-port--output ${connecting === node.id ? 'is-on' : ''}`} aria-label={`从 ${node.name} ${node.id} 连线`} onClick={() => setConnecting(connecting === node.id ? '' : node.id)} title="输出端口" />
          </div>)}
        </div>}
      </div>
      {current && <section className="draft-node-editor" aria-label="选中节点配置">
        <div className="workflow-form-head"><h2>编辑 {current.id}</h2><button type="button" className="btn btn--sm btn--danger" onClick={remove}><Trash2 size={13} />删除节点</button></div>
        <label>节点名称<input required value={current.name} onChange={event => editNode({name: event.target.value})} /></label>
        <p>执行程序：{draftOperations.find(item => item.id === current.operation)?.name} · 输出保存在 <code>{current.id}</code>。删除节点会移除连线和对该节点的有效输入引用，剩余必填输入需重新映射。</p>
        <label>输入映射（JSON）<textarea rows={4} spellCheck={false} value={current.mapping} onChange={event => editNode({mapping: event.target.value})} /><small>例如 {JSON.stringify({text: {path: 'input.text'}})}；上游字段写为 step-1.text，常量写为 {JSON.stringify({value: '固定值'})}。</small></label>
        <details><summary>输入 / 输出契约</summary><div className="source-fields"><label>节点输入契约（JSON Schema）<textarea rows={8} spellCheck={false} value={current.inputSchema} onChange={event => editNode({inputSchema: event.target.value})} /></label><label>节点输出契约（JSON Schema）<textarea rows={8} spellCheck={false} value={current.outputSchema} onChange={event => editNode({outputSchema: event.target.value})} /></label></div></details>
        <label>验收条件（每行一条）<textarea required rows={3} value={current.accept} onChange={event => editNode({accept: event.target.value})} /></label>
      </section>}
      {draft.nodes.length > 0 && <section aria-label="编辑连线">
        <div className="draft-connections"><label>连线起点<select aria-label="连线起点" value={from} onChange={event => setFrom(event.target.value)}><option value="">选择节点</option>{draft.nodes.map(node => <option key={node.id} value={node.id}>{node.name} · {node.id}</option>)}</select></label><label>连线终点<select aria-label="连线终点" value={to} onChange={event => setTo(event.target.value)}><option value="">选择节点</option>{draft.nodes.map(node => <option key={node.id} value={node.id}>{node.name} · {node.id}</option>)}</select></label><button className="btn btn--sm" type="button" onClick={connect}>添加连线</button></div>
        <ul className="draft-edge-list">{draft.edges.map(edge => <li key={`${edge.from}:${edge.to}`}><span>{draft.nodes.find(node => node.id === edge.from)?.name} → {draft.nodes.find(node => node.id === edge.to)?.name}</span><button className="btn btn--ghost btn--sm" type="button" aria-label={`删除连线 ${edge.from} 到 ${edge.to}`} onClick={() => change({...draft, edges: draft.edges.filter(value => value !== edge)})}>删除</button></li>)}</ul>
      </section>}
    </fieldset>
    {error && <p role="alert" className="workflow-error">{error}</p>}
    {checked && <p role="status" className="workflow-receipt">{checked}</p>}
    <div className="workflow-form-actions"><button type="button" className="btn btn--sm" disabled={busy} onClick={onClose}>收起，保留草稿</button><button type="button" className="btn btn--sm" disabled={busy || blocked} onClick={check}>检查草稿</button><button className="btn btn--sm btn--primary" disabled={busy || blocked}>{busy ? '正在校验安装…' : '校验并安装工作流'}</button></div>
  </form>;
}
