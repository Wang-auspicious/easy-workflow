import {useEffect, useState} from 'react';
import {api, refreshKernel} from './api.ts';
import {getState, setState, useStore} from './store.ts';
import {toggleInspector} from './canvas/Canvas.tsx';
import {waitingNames, type KernelAttention, type KernelStationNumbers} from './kernel.ts';
import type {BoardPost, Room} from '../../shared/board.ts';
import type {SharedLesson} from '../../shared/lessons.ts';
import './styles/kernel.css';

export function ProgressToggle() {
  const show = useStore(state => state.showProgress);
  return <label className="kernel-progress-toggle"><input type="checkbox" checked={show}
    onChange={event => setState({showProgress: event.target.checked})} />显示进展</label>;
}

export function KernelSummary() {
  const kernel = useStore(state => state.kernel);
  const snapshot = useStore(state => state.kernelSnapshot);
  const connected = useStore(state => state.connected);
  const replay = useStore(state => Boolean(state.replay));
  const [busy, setBusy] = useState('');
  useEffect(() => {
    if (kernel !== 'v2') return;
    const timer = setInterval(() => {void refreshKernel();}, 3000);
    return () => clearInterval(timer);
  }, [kernel]);
  if (kernel !== 'v2' || replay) return null;
  const summary = snapshot?.summary;
  const handle = async (entry: KernelAttention) => {
    if (entry.action === 'continue_budget' && entry.item && entry.node) {
      setBusy(entry.id);
      try {await api.post('/api/kernel/continue', {item: entry.item, node: entry.node}); await refreshKernel();}
      finally {setBusy('');}
    } else if (entry.action === 'approval') {
      setState({chatRoom: 'root', draft: `请说明待批准补丁 ${entry.patchId ?? ''} 的内容与影响。`});
    } else if (entry.item || entry.node) {
      setState({view: 'canvas'});
      toggleInspector(entry.item ?? entry.node!, entry.item ? 'token' : 'node');
    } else setState({view: 'browser'});
  };
  return <section className="kernel-overview" aria-label="运行总结与注意事项">
    <div className="kernel-summary" aria-live="polite">{summary
      ? `在跑 ${summary.running} · 等资源 ${summary.waitingResource} · 等模型 ${summary.waitingModel} · 已发布 ${summary.published} · 需要你 ${summary.needsUser}`
      : '正在读取运行统计…'}</div>
    {!connected && <span className="muted kernel-offline">连接已断开，显示上次确认的统计</span>}
    {(snapshot?.attention ?? []).slice(0, 5).map(entry => <div className="kernel-attention" key={entry.id} data-attention={entry.code}>
      <span title={`${entry.title}：${entry.reason}`}><b>{entry.title}</b> · {entry.reason}</span>
      <button className="btn btn--sm" disabled={!connected || Boolean(busy)} onClick={() => void handle(entry).catch(() => {})}>
        {busy === entry.id ? '处理中…' : entry.action === 'view' ? '查看' : '处理'}
      </button>
    </div>)}
  </section>;
}

export function KernelCounts({numbers, compact = false}: {numbers: KernelStationNumbers; compact?: boolean}) {
  return <div className={`kernel-counts${compact ? ' is-compact' : ''}`} aria-label="工位状态计数">
    <div className="kernel-count-row"><span>就绪 <b>{numbers.ready}</b></span><span>运行 <b>{numbers.running}</b></span>
      <span title="本轮完成">{compact ? '完成' : '本轮完成'} <b>{numbers.done}</b></span><span>停放 <b>{numbers.parked}</b></span></div>
    <div className="kernel-waits">{Object.entries(waitingNames).map(([key, label]) => {
      const count = numbers.waiting[key as keyof typeof waitingNames] ?? 0;
      return count > 0 ? <span key={key} className={`kernel-wait kernel-wait--${key}`} data-waiting={key}>等{label} {count}</span> : null;
    })}{Object.values(numbers.waiting).every(count => !count) && <span className="muted">无等待</span>}</div>
  </div>;
}

export function SharedLessons({node}: {node: string}) {
  const [lessons, setLessons] = useState<SharedLesson[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const connected = useStore(state => state.connected);
  const replay = useStore(state => Boolean(state.replay));
  const load = async () => {
    try {const result = await api.get<{lessons: SharedLesson[]}>(`/api/lessons/shared?node=${encodeURIComponent(node)}`); setLessons(result.lessons); setError('');}
    catch (reason) {setError(reason instanceof Error ? reason.message : '经验读取失败');}
  };
  useEffect(() => {void load();}, [node]);
  const remove = async (id: string) => {
    setBusy(id);
    try {await api.post('/api/lessons/shared/delete', {id}); await load();}
    catch (reason) {setError(reason instanceof Error ? reason.message : '经验删除失败，请重试');}
    finally {setBusy('');}
  };
  return <section className="kernel-lessons"><div className="sec-title">跨货经验</div>
    {error && <p role="alert">{error} <button onClick={() => void load()}>重新读取</button></p>}
    {!error && !lessons.filter(lesson => lesson.status !== 'deleted').length && <p className="muted">暂无生效经验。</p>}
    {lessons.filter(lesson => lesson.status !== 'deleted').map(lesson => <div key={lesson.id} className="kernel-lesson">
      <p>{lesson.text}</p><div><span className="muted">{lesson.status === 'active' ? '生效' : '试用'} · {new Date(lesson.at).toLocaleDateString()}</span>
        <button className="btn btn--sm" disabled={!connected || replay || Boolean(busy)} onClick={() => void remove(lesson.id).catch(() => {})}>{busy === lesson.id ? '删除中…' : '删除'}</button></div>
    </div>)}
  </section>;
}

export function BoardChain({item}: {item: string}) {
  const [posts, setPosts] = useState<BoardPost[]>([]);
  const [error, setError] = useState('');
  const revision = useStore(state => state.boardRevisions[item]);
  useEffect(() => {
    const controller = new AbortController();
    void api.get<{posts: BoardPost[]; rooms: Room[]}>(`/api/board?item=${encodeURIComponent(item)}`, {signal: controller.signal})
      .then(result => {setPosts(result.posts); setError('');}).catch(reason => {if (!controller.signal.aborted) setError(String(reason));});
    return () => controller.abort();
  }, [item, revision]);
  const names: Record<string, string> = {claim: '结论', challenge: '质疑', answer: '答复', question: '提问', evidence: '证据', resolve: '解决', note: '备注'};
  const status: Record<string, string> = {open: '当前', resolved: '已解决', rejected: '已拒绝', superseded: '已替代'};
  return <section className="kernel-board-chain"><div className="sec-title">黑板证据链 · 最近 40 条</div>
    {error && <p role="alert">{error}</p>}
    {!error && !posts.length && <p className="muted">这件货还没有黑板记录。</p>}
    {posts.map(post => <article key={post.id} className={`kernel-board-post is-${post.status}`} data-board-type={post.type}>
      <header><b>{names[post.type]} · {post.field}</b><span>{status[post.status]}</span></header>
      <small>{getState().factory?.nodes.find(node => node.key === post.author.replace(/^program:/, ''))?.name ?? post.author} · {new Date(post.at).toLocaleTimeString()}</small>
      <p>{post.body}</p>{post.evidence.length > 0 && <div className="kernel-post-evidence">{post.evidence.map(id => {
        const evidence = getState().fs.evidence[id];
        return evidence?.src ? <a key={id} href={evidence.src} target="_blank" rel="noreferrer">{evidence.label || id}</a> : <span key={id}>{evidence?.label ?? id}</span>;
      })}</div>}
    </article>)}
  </section>;
}
