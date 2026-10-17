import {useEffect, useRef, useState} from 'react';
import {ArrowUpRight, Check, ChevronRight, ChevronLeft, Loader2, Undo2, Play, Search, Clock3, MessageSquare, Image as ImageIcon, Maximize2, X, ShieldCheck} from 'lucide-react';
import type {EvidenceRef} from '../../../shared/types.ts';
import type {TokenState} from '../../../shared/project.ts';
import {actions, api} from '../api.ts';
import {getState, setState, useStore} from '../store.ts';
import {toast} from '../shell/Toasts.tsx';
import './review.css';

const ROLE: Record<string, string> = {identity: '首屏', breadth: '目录', proof: '特写'};
const GROUPS = ['全部', '截图与页面', '事实与许可', '内容与分类', '连接与执行', '其他', '稍后处理'];
const REDO: [string, string][] = [
  ['curation/reader', '重新读站、选择页面'], ['curation/classify', '重新分类'],
  ['curation/breadth', '重拍目录'], ['curation/proof', '重拍特写'],
  ['curation/style', '重判风格'], ['curation/facts', '重查事实'], ['curation/copy', '重写简介'],
];
const isManual = (token: TokenState | undefined) => Boolean(token && (token.status === 'manual' || token.at.some(key => key.endsWith('/manual'))));
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const reason = (token: TokenState) => text(token.data.manualReason) || token.reason || '审查尚未通过，需要你决定下一步。';
function summary(token: TokenState) {
  const raw = reason(token).replace(/^\[[^\]]{1,40}\]\s*/u, '').replace(/（[^）]*token[^）]*）/gu, '')
    .replace(/^终审员发现需要站长处理的问题[：:]\s*/u, '')
    .replace(/pages[：:]\s*没有\s*pages\[\]/gu, '缺少页面来源记录')
    .replace(/pages[：:]\s*没有\s*role=(identity|breadth|proof)\s*的页面/gu, (_match, role: string) => `${ROLE[role]}截图尚未关联来源页面`);
  const first = raw.split(/\n\s*\n/u)[0];
  return first.length > 140 ? `${first.slice(0, 140)}…` : first;
}
function group(token: TokenState) {
  const raw = reason(token);
  if (/网络|超时|登录|连接|凭据|timeout|network|auth|内存|模型/i.test(raw)) return '连接与执行';
  if (/特写|目录|首屏|截图|页面|proof|breadth|identity/i.test(raw)) return '截图与页面';
  if (/事实|许可|价格|license|fact/i.test(raw)) return '事实与许可';
  if (/文案|简介|分类|风格|copy|kind|style/i.test(raw)) return '内容与分类';
  return '其他';
}
function suggested(token: TokenState) {
  const raw = reason(token);
  if (/特写|proof/i.test(raw)) return 'curation/proof';
  if (/目录|breadth/i.test(raw)) return 'curation/breadth';
  if (/风格|style/i.test(raw)) return 'curation/style';
  if (/事实|许可|价格|license|fact/i.test(raw)) return 'curation/facts';
  if (/文案|简介|copy/i.test(raw)) return 'curation/copy';
  if (/分类|kind/i.test(raw)) return 'curation/classify';
  return 'curation/reader';
}

export function Review() {
  useStore(state => state.version);
  const state = getState();
  // Journal projections mutate token maps in place; derive from every version.
  const items = Object.values(state.fs.tokens).filter(isManual).sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));
  const pick = useStore(state => state.reviewPick);
  const setPick = (reviewPick: string | null) => setState({reviewPick});
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('全部');
  const deferred = useStore(state => state.reviewDeferred);
  const setDeferred = (update: (previous: string[]) => string[]) => setState(state => ({reviewDeferred: update(state.reviewDeferred)}));
  const [processed, setProcessed] = useState(0);
  const shown = items.filter(token => `${token.title} ${token.item} ${token.url} ${reason(token)}`.toLowerCase().includes(query.toLowerCase()) &&
    (filter === '稍后处理' ? deferred.includes(token.id) : !deferred.includes(token.id) && (filter === '全部' || group(token) === filter)));
  const current = shown.find(token => token.id === pick) ?? shown[0];
  const index = current ? shown.indexOf(current) : 0;
  const next = (later: boolean) => {
    if (!current) return;
    if (later) setDeferred(previous => [...previous.filter(id => id !== current.id), current.id]);
    else setProcessed(count => count + 1);
    setPick(shown[index + 1]?.id ?? shown[index - 1]?.id ?? null);
  };
  return <div className="view review review-workbench">
    <aside className="rv-queue"><header><span className="rv-eyebrow">人工审计</span><div><h1>只看需要你决定的</h1><span className="rv-total num">{items.length}</span></div><p>{processed ? `本次已处理 ${processed} 件，按自己的节奏来。` : '一次一件。先看问题，再看证据。'}</p></header>
      <label className="rv-search"><Search size={15} /><input aria-label="搜索待审条目" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称、网址或问题" /></label>
      <div className="rv-filters" aria-label="筛选审计问题">{GROUPS.map(name => {
        const count = items.filter(token => name === '稍后处理' ? deferred.includes(token.id) : !deferred.includes(token.id) && (name === '全部' || group(token) === name)).length;
        return (count > 0 || name === '全部' || name === filter) && <button key={name} aria-pressed={filter === name} onClick={() => setFilter(name)}>{name}<span>{count}</span></button>;
      })}</div>
      <div className="rv-queue-items">{shown.map(token => <button key={token.id} className={`rv-queue-item${current?.id === token.id ? ' is-on' : ''}`} aria-current={current?.id === token.id ? 'true' : undefined} onClick={() => setPick(token.id)}>
        <small>{group(token)}</small><b>{token.title || token.item}</b><span>{summary(token)}</span><ChevronRight size={14} /></button>)}
        {!shown.length && <div className="rv-empty-state"><Check size={24} /><b>{items.length ? '这个队列已看完' : '暂时没有待审条目'}</b><p>{items.length ? '换个筛选，或查看稍后处理的条目。' : '需要你判断时，会出现在这里。'}</p>{deferred.length > 0 && <button onClick={() => setFilter('稍后处理')}>查看稍后处理</button>}</div>}
      </div>
      <footer><ShieldCheck size={13} />处理后仍经过原有审查与发布闸门</footer>
    </aside>
    {current ? <Detail key={current.id} token={current} disabled={!state.connected || Boolean(state.replay)} position={`${index + 1} / ${shown.length}`} deferred={deferred.includes(current.id)}
      restore={() => setDeferred(previous => previous.filter(id => id !== current.id))} done={() => next(false)} later={() => next(true)}
      previous={() => setPick(shown[Math.max(0, index - 1)]?.id ?? null)} hasPrevious={index > 0} />
      : <section className="rv-rest"><div><ShieldCheck size={36} /><h2>{items.length ? '留一点注意力给重要的事' : '审计队列已清空'}</h2><p>{items.length ? '选择一个队列，继续查看需要你决定的条目。' : '有新的待审条目时，你可以在这里继续。'}</p></div></section>}
  </div>;
}

function Detail({token, disabled, position, deferred, restore, done, later, previous, hasPrevious}: {
  token: TokenState; disabled: boolean; position: string; deferred: boolean; restore: () => void; done: () => void; later: () => void; previous: () => void; hasPrevious: boolean;
}) {
  const state = getState();
  const [details, setDetails] = useState<Record<string, unknown> | null>(null);
  const [loadError, setLoadError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const savedDraft = state.reviewDrafts[token.id];
  const [note, setNoteValue] = useState(savedDraft?.note ?? '');
  const flight = useRef(false);
  const fullToken = {...token, data: details ? object(details.data) : token.data};
  const recovery = Object.values(state.fs.recoveries ?? {}).find(value => value.token === token.id && value.disposition === 'manual');
  const targets = state.factory?.nodes.filter(node => node.line === token.line && !['source', 'store', 'gate', 'review'].includes(node.kind)) ?? [];
  const [target, setTargetValue] = useState(() => targets.find(node => node.key === savedDraft?.target)?.key ?? targets.find(node => node.key === suggested(token))?.key ?? targets[0]?.key ?? '');
  const setNote = (value: string) => {
    setNoteValue(value);
    setState(state => ({reviewDrafts: {...state.reviewDrafts, [token.id]: {target, note: value}}}));
  };
  const setTarget = (value: string) => {
    setTargetValue(value);
    setState(state => ({reviewDrafts: {...state.reviewDrafts, [token.id]: {target: value, note}}}));
  };
  const allEvidence = token.evidence.map(id => state.fs.evidence[id]).filter((entry): entry is EvidenceRef => Boolean(entry));
  const latest = new Map<string, EvidenceRef>();
  for (const evidence of allEvidence) if (evidence.kind === 'image' || evidence.kind === 'video') latest.set(text(evidence.meta?.role) || evidence.label, evidence);
  const shots = [...latest.entries()].sort(([a], [b]) => Object.keys(ROLE).indexOf(a) - Object.keys(ROLE).indexOf(b));
  const preferred = /特写|proof/i.test(reason(token)) ? 'proof' : /目录|breadth/i.test(reason(token)) ? 'breadth' : 'identity';
  const [shot, setShot] = useState(preferred);
  const selected = shots.find(([key]) => key === shot) ?? shots[0];
  const [zoom, setZoom] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (!expanded || details || state.replay) return;
    setLoadError('');
    void api.post<{result: Record<string, unknown>}>('/api/tools/inspect', {token: token.id}, {signal: controller.signal})
      .then(response => {if (!controller.signal.aborted) setDetails(response.result);})
      .catch(reason => {if (!controller.signal.aborted) setLoadError(reason instanceof Error ? reason.message : '详情读取失败');});
    return () => controller.abort();
  }, [expanded, token.id, details, state.replay]);
  useEffect(() => {if (zoom) dialog.current?.showModal(); else dialog.current?.close();}, [zoom]);
  const perform = async (mode: 'redo' | 'resume') => {
    const current = getState();
    if (flight.current || disabled || !current.connected || current.replay) return;
    if (!isManual(current.fs.tokens[token.id])) {setError('这件条目的状态已变化，请重新选择。'); return;}
    if (mode === 'redo' && (!note.trim() || !target)) {setError('选择一个工位，并写下或选择一条修改意见。'); return;}
    flight.current = true; setBusy(mode); setError('');
    try {
      if (mode === 'redo') {
        const response = await actions.correct([{token: token.id, node: target}], '人工审计退回', note.trim());
        if (!response.results?.[0]?.ok) throw new Error(response.results?.[0]?.message ?? '没有退回成功，意见已保留。');
        toast('已按你的意见退回，继续查看下一件。');
      } else {
        const response = await api.post<{result: {count: number}}>('/api/candidates/retry', {count: 1, tokens: [token.id], includeManual: true});
        if (!response.result.count) throw new Error('暂时不能继续，请检查流水线是否暂停。');
        toast('已从原工位继续，已有成果保留。');
      }
      setState(state => {
        const reviewDrafts = {...state.reviewDrafts};
        delete reviewDrafts[token.id];
        return {reviewDrafts, reviewDeferred: state.reviewDeferred.filter(id => id !== token.id)};
      });
      done();
    } catch (reason) {setError(reason instanceof Error ? reason.message : '处理失败，意见已保留。');}
    finally {flight.current = false; setBusy('');}
  };
  const askAgent = () => {
    setState(current => ({chatOpen: true, chatList: false, chatHistoryOpen: false, chatSessionView: null, chatRoom: 'root',
      attachments: [...current.attachments.filter(attachment => attachment.type !== 'token' || attachment.id !== token.id), {type: 'token', id: token.id, label: token.title || token.item}],
      draft: `${current.draft.trim() ? current.draft.trim() + '\n\n' : ''}请检查这个待审条目的阻塞原因，先核对现有证据和失败记录，给我简短结论与可执行的修复建议：${summary(token)}`}));
    window.dispatchEvent(new Event('easy:focus-composer'));
  };
  const openSite = async () => {
    try {await actions.browser({action: 'open', url: token.url}); setState({view: 'browser'});}
    catch (reason) {setError(reason instanceof Error ? reason.message : '页面暂时无法打开');}
  };
  const presets = target.endsWith('/reader') && /没有\s*pages\[\]|没有\s*role=/u.test(reason(token))
    ? ['补齐截图对应的来源页面记录，复用已取得的证据，再次审查。', '核对首屏、目录和特写的页面用途，修正错配的来源。']
    : target.endsWith('/proof') || target.endsWith('/breadth')
    ? ['换成可见的组件示例，避开文档文字和导航。', '重新选择与当前条目相关的页面，保留来源。', '重拍清晰完整的内容区域，检查裁切与遮挡。']
    : target.endsWith('/facts') ? ['核对原始出处，区分免费与付费内容。', '补充许可与事实来源；不确定的明确标注。']
    : ['根据审查指出的问题重新核对，并补齐证据。', '保留已核实内容，只修正有问题的部分。'];
  return <section className="rv-focus" aria-label="当前审计条目">
    <div className="rv-focus-scroll">
      <nav className="rv-focus-nav"><span>{group(token)}</span><div><button aria-label="上一件待审条目" disabled={!hasPrevious || Boolean(busy)} onClick={previous}><ChevronLeft size={15} /></button><span className="num">{position}</span><button onClick={deferred ? restore : later} disabled={Boolean(busy)}><Clock3 size={13} />{deferred ? '移回待审队列' : '稍后处理'}</button></div></nav>
      <header className="rv-focus-head"><h2>{token.title || token.item}</h2>{/^https?:\/\//i.test(token.url) && <button onClick={() => void openSite()}>{token.url.replace(/^https?:\/\//i, '').replace(/\/$/, '')}<ArrowUpRight size={12} /></button>}</header>
      <div className="rv-decision"><span className="rv-eyebrow">这次需要你判断</span><p>{summary(fullToken)}</p></div>
      <section className="rv-evidence" aria-label="相关证据"><header><b>先看证据</b><span>{shots.length ? `${shots.length} 份可视证据` : '尚未取得可视证据'}</span></header>
        {shots.length > 0 ? <><div className="rv-evidence-tabs" role="tablist" aria-label="证据类型">{shots.map(([key, evidence]) => <button role="tab" aria-selected={selected?.[0] === key} key={key} onClick={() => setShot(key)}>{ROLE[key] ?? evidence.label}{key === preferred && <i>相关</i>}</button>)}</div>
          <div className="rv-stage">{selected![1].kind === 'video' ? <video key={selected![1].id} src={selected![1].src} poster={selected![1].poster ?? selected![1].card} controls preload="metadata" />
            : <button aria-label="放大当前证据" onClick={() => setZoom(true)}><img src={selected![1].card ?? selected![1].src} alt={selected![1].label} /><span><Maximize2 size={12} />放大查看</span></button>}</div></>
          : <div className="rv-no-evidence"><ImageIcon size={26} /><p>没有截图也可以继续判断</p><span>查看完整原因，或让主调度先检查采集问题。</span></div>}
      </section>
      <details className="rv-context" onToggle={event => setExpanded(event.currentTarget.open)}><summary>完整原因与执行记录<span>按需展开</span></summary>
        <div className="rv-context-body"><h3>完整阻塞原因</h3><p>{reason(fullToken)}</p>
          {text(object(fullToken.data.copy).descriptionZh) && <><h3>当前简介</h3><p>{text(object(fullToken.data.copy).descriptionZh)}</p></>}
          {!state.replay && !details && !loadError && <p><Loader2 size={12} className="spin-i" /> 正在读取完整记录…</p>}
          {loadError && <p role="alert">{loadError}，收起后可重新展开读取。</p>}
          <h3>最近执行</h3>{token.attempts.slice(-5).map(id => state.fs.attempts[id]).filter(Boolean).map(attempt => <p className="rv-attempt" key={attempt.id}><b>{state.factory?.nodes.find(node => node.key === attempt.node)?.name ?? attempt.node}</b><span>{attempt.error || attempt.summary || '执行记录已保存'}</span></p>)}
          <small>任务 {token.id}</small>
        </div>
      </details>
    </div>
    <footer className="rv-decision-dock"><div className="rv-dock-head"><b>下一步怎么处理</b><button onClick={askAgent} disabled={Boolean(busy)}><MessageSquare size={13} />请主调度帮我看</button></div>
      {recovery && <button className="rv-resume" disabled={disabled || Boolean(busy)} onClick={() => void perform('resume')}><Play size={13} />{busy === 'resume' ? '正在恢复…' : '问题已排除，从原工位继续'}</button>}
      <div className="rv-dock-row"><label>退回给<select aria-label="退回工位" value={target} onChange={event => setTarget(event.target.value)} disabled={disabled || Boolean(busy)}>{targets.map(node => <option key={node.key} value={node.key}>{node.name} · {REDO.find(([key]) => key === node.key)?.[1] ?? '按意见重做'}</option>)}</select></label></div>
      <div className="rv-presets" aria-label="快捷修改意见">{presets.map(preset => <button key={preset} disabled={disabled || Boolean(busy)} onClick={() => {setNote(preset); setError('');}}>{preset}</button>)}</div>
      <textarea aria-label="修改意见" placeholder="写一句修改意见，或点选上面的建议后编辑…" rows={2} value={note} disabled={disabled || Boolean(busy)} onChange={event => {setNote(event.target.value); setError('');}} />
      {error && <p className="rv-inline-error" role="alert">{error}</p>}
      <div className="rv-dock-bottom"><span>{disabled ? state.replay ? '回放为只读' : '连接恢复后可处理' : '意见会交给对应工位，重做后再次审查'}</span><button className="rv-primary" disabled={disabled || Boolean(busy) || !target || !note.trim()} onClick={() => void perform('redo')}>{busy === 'redo' ? <Loader2 size={14} className="spin-i" /> : <Undo2 size={14} />}{busy === 'redo' ? '正在退回…' : '退回并看下一件'}</button></div>
    </footer>
    <dialog ref={dialog} className="rv-zoom" onCancel={() => setZoom(false)} onClick={event => {if (event.target === dialog.current) setZoom(false);}}><header><b>{selected?.[1].label}</b><button aria-label="关闭证据大图" onClick={() => setZoom(false)}><X size={18} /></button></header>{selected && <img src={selected[1].src ?? selected[1].card} alt={selected[1].label} />}</dialog>
  </section>;
}
