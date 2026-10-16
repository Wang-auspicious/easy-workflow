import {useRef, useState} from 'react';
import { SlidersHorizontal, Loader2 } from 'lucide-react';
import { boot } from '../api.ts';
import { getState, setState, useStore } from '../store.ts';
import { workflowCall } from './workflows.ts';
import './workflows.css';

export function AllocationShortcut() {
  const kernel = useStore(state => state.kernel);
  const pending = useStore(s => s.fs.measurement?.status === 'proposed' && s.fs.measurement.runId === s.fs.run.id);
  const count = useStore(s => s.fs.measurement?.sampleItems ?? 0);
  if (kernel === 'v2' || !pending) return null;
  return <button className="allocation-shortcut" onClick={() => setState({ view: 'library' })}><SlidersHorizontal size={13} />{count} 件实测 · 配员待确认</button>;
}

export function AllocationProposal() {
  const kernel = useStore(state => state.kernel);
  useStore(s => s.version);
  const proposal = useStore(s => s.fs.measurement);
  const currentRun = useStore(s => s.fs.run.id);
  const disabled = useStore(s => !s.connected || Boolean(s.replay));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const flight = useRef(false);
  if (kernel === 'v2' || !proposal || proposal.runId !== currentRun || proposal.status !== 'proposed') return null;
  const decide = async (action: 'accept' | 'reject') => {
    if (flight.current || !getState().connected || getState().replay) return;
    flight.current = true;
    setBusy(true); setError('');
    try { await workflowCall('allocation_plan', { action, id: proposal.id }); await boot(); }
    catch (reason) { setError((reason as Error).message); } finally { flight.current = false; setBusy(false); }
  };
  const state = getState();
  return <section className="allocation-proposal" aria-label="实测配员建议">
    <div className="workflow-form-head"><h2><SlidersHorizontal size={15} />前 {proposal.sampleItems} 件的配员建议</h2><span>待你确认</span></div>
    <p>按本轮耗时和资源余量调整。已锁定的人数与规格上限仍然有效。</p>
    <details><summary>查看各工位的建议人数</summary><div className="allocation-table"><table><thead><tr><th>工位</th><th>在岗 → 建议</th><th>耗时</th><th>依据</th></tr></thead><tbody>{proposal.stations.slice().sort((a, b) => Number(b.measured) - Number(a.measured)).map(row => <tr key={row.node}><td>{state.factory?.nodes.find(node => node.key === row.node)?.name ?? row.node}</td><td>{state.fs.nodes[row.node]?.workers.length ?? 0} → {row.allocated}</td><td>{row.serviceSeconds.toFixed(1)}s</td><td>{row.measured ? `实测 ${row.samples} 次` : `规格估计 · ${row.samples} 次样本`}</td></tr>)}</tbody></table></div></details>
    {error && <p className="workflow-error" role="alert">{error}</p>}
    <div className="workflow-form-actions"><button className="btn btn--sm" disabled={busy || disabled} onClick={() => void decide('reject')}>保留现有人数</button><button className="btn btn--sm btn--primary" disabled={busy || disabled} onClick={() => void decide('accept')}>{busy && <Loader2 size={12} className="spin-i" />}应用这份建议</button></div>
  </section>;
}
