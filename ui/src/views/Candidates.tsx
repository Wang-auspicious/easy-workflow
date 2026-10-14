import {useRef, useState} from 'react';
import {RotateCw, Globe} from 'lucide-react';
import {failureLabels, recoveryAdvice, type CandidateRecovery} from '../../../shared/failures.ts';
import {api, actions} from '../api.ts';
import {getState, setState, useStore} from '../store.ts';
import './recovery.css';
import {PreviewChoice} from './PreviewChoice.tsx';

const groups: readonly [CandidateRecovery['disposition'], string][] = [
  ['retry', '待重试'],
  ['manual', '恢复待人工'],
  ['removed', '已移出'],
  ['claimed', '重试中'],
  ['resolved', '已处理'],
];

export function Candidates() {
  useStore(state => state.version);
  const connected = useStore(state => state.connected);
  const replay = useStore(state => Boolean(state.replay));
  const records = Object.values(getState().fs.recoveries);
  const [tag, setTag] = useState('');
  const [disposition, setDisposition] = useState<CandidateRecovery['disposition']>('retry');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const rows = records.filter(candidate => candidate.disposition === disposition &&
    (!tag || candidate.failure?.tag === tag)).sort((a, b) => b.at - a.at);
  const tags = [...new Set(records.flatMap(candidate => candidate.failure ? [candidate.failure.tag] : []))];
  const selectedTokens = rows.filter(candidate => selected.includes(candidate.token)).map(candidate => candidate.token);
  const manual = disposition === 'manual';
  const canRetry = disposition === 'retry' || manual;
  const readOnly = !connected || replay;
  const count = Math.min(200, manual || selected.length ? selectedTokens.length : rows.length);
  const retryLabel = manual
    ? count ? `继续已选 ${count} 件原工位` : '选择人工项后继续'
    : selected.length ? `重试已选 ${count} 件` : `重试当前筛选 ${count} 件`;

  const reportError = (error: unknown) => {
    setFailed(true);
    setMessage(error instanceof Error ? error.message : '操作失败，请检查当前状态后重试。');
  };

  const retry = async () => {
    const state = getState();
    if (inFlight.current || !state.connected || state.replay || !canRetry) return;
    const current = Object.values(state.fs.recoveries).filter(candidate => candidate.disposition === disposition &&
      (!tag || candidate.failure?.tag === tag));
    const chosen = current.filter(candidate => selected.includes(candidate.token));
    if (manual && !chosen.length) return;
    const tokens = (manual || selected.length ? chosen : current).slice(0, 200).map(candidate => candidate.token);
    if (!tokens.length) return;

    inFlight.current = true;
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      const response = await api.post<{result: {count: number}}>('/api/candidates/retry', {
        count: tokens.length,
        tokens,
        ...(tag ? {tag} : {}),
        ...(manual ? {includeManual: true} : {}),
      });
      const resumed = response.result.count;
      setMessage(resumed
        ? `已从原工位继续 ${resumed} 件，已有成果与证据保留。`
        : '本次没有可继续的条目，请检查暂停状态与恢复条件。');
      if (resumed) setSelected([]);
    } catch (error) {
      reportError(error);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const openBrowser = async (url: string) => {
    if (!getState().connected || getState().replay) return;
    try {
      await actions.browser({action: 'open', url});
      setState({view: 'browser'});
    } catch (error) {
      reportError(error);
    }
  };

  return <div className="view candidate-recovery">
    <div className="view-inner wide">
      <div className="view-head">
        <div>
          <h1 className="view-title">候选恢复</h1>
          <div className="view-sub">失败原因、检查点和已有证据保留。修复原因后继续原工位；人工项需先明确选择。</div>
        </div>
        <button className="btn btn--primary" disabled={busy || readOnly || !canRetry || !count} onClick={() => void retry()}>
          <RotateCw size={14} />{busy ? '正在取出…' : retryLabel}
        </button>
      </div>
      <div className="recovery-filters">
        <div className="seg">
          {groups.map(([value, label]) => <button key={value} className={value === disposition ? 'is-on' : ''}
            disabled={busy} onClick={() => {
              setDisposition(value);
              setSelected([]);
              setMessage('');
              setFailed(false);
            }}>
            {label} {records.filter(candidate => candidate.disposition === value).length}
          </button>)}
        </div>
        <select aria-label="失败原因标签" value={tag} disabled={busy} onChange={event => {
          setTag(event.target.value);
          setSelected([]);
        }}>
          <option value="">全部原因</option>
          {tags.map(value => <option key={value} value={value}>{failureLabels[value]}</option>)}
        </select>
      </div>
      {readOnly && <p className="recovery-message">{replay
        ? '回放为只读，不能继续任务或操作浏览器。' : '连接恢复后可选择并继续任务。'}</p>}
      {message && <p role={failed ? 'alert' : 'status'} className="recovery-message">{message}</p>}
      {manual && <p className="recovery-message">这里仅列按恢复策略转人工的技术故障，不含任务与证据板中的质量审查待人工项。它们不会自动领取；核查后勾选条目继续原工位，每次最多 200 件。</p>}
      {disposition === 'removed' && <p className="recovery-message">已确认网址格式无效或返回 404 / 410，不再进入候选投料。这里保留处置记录。</p>}
      <div className="recovery-list">
        {rows.map(candidate => {
          const checked = selectedTokens.includes(candidate.token);
          const station = candidate.recoveryStation ?? (manual ? undefined : getState().fs.tokens[candidate.token]?.finishedAtNode);
          return <div key={candidate.key ?? candidate.token} className="recovery-row">
            <input aria-label={`选择 ${candidate.title}`} type="checkbox" checked={checked}
              disabled={readOnly || busy || !canRetry || !checked && selectedTokens.length >= 200}
              onChange={event => setSelected(event.target.checked
                ? [...selectedTokens, candidate.token] : selectedTokens.filter(item => item !== candidate.token))} />
            <div>
              <b>{candidate.title}</b>
              {candidate.line && <p>工作流：{candidate.workflowPack ? `${candidate.workflowPack} / ` : ''}{candidate.line}</p>}
              <a href={candidate.url} aria-disabled={readOnly} onClick={event => {
                event.preventDefault();
                void openBrowser(candidate.url);
              }}>{candidate.url}<Globe size={11} /></a>
              <p>{candidate.failure?.message.split('\n')[0]}</p>
              {station && <p>恢复工位：{getState().factory?.nodes.find(node => node.key === station)?.name ?? station} · {station}</p>}
              <p className="recovery-next">下一步：{recoveryAdvice(candidate.failure)}</p>
              {disposition === 'retry' && ['needs_selection', 'page_unavailable', 'quality_rejected'].includes(candidate.failure?.tag ?? '') &&
                <fieldset disabled={readOnly || busy} style={{border: 0, padding: 0, margin: 0, minWidth: 0}}>
                  <PreviewChoice item={candidate.item} station={station} onMessage={text => {
                    setFailed(false);
                    setMessage(text);
                  }} />
                </fieldset>}
              {candidate.failure?.message.includes('\n') && <details>
                <summary>错误详情</summary><pre>{candidate.failure.message}</pre>
              </details>}
            </div>
            <aside>
              <span className={`failure-tag category-${candidate.failure?.category}`}>
                {candidate.failure ? failureLabels[candidate.failure.tag] : '待检查'}
              </span>
              <small>{new Date(candidate.at).toLocaleString('zh-CN')} · {candidate.attempts} 次记录</small>
            </aside>
          </div>;
        })}
        {!rows.length && <div className="empty-card">当前没有这一类候选。</div>}
      </div>
    </div>
  </div>;
}
