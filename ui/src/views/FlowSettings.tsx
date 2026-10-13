import {useEffect, useState, type FormEvent} from 'react';
import type {BatchGoal} from '../../../shared/batch.ts';
import {setState, useStore} from '../store.ts';

type SavedAdmission = Pick<BatchGoal, 'runId' | 'maxInFlight' | 'intakeWindow' | 'admission'>;

function savedAdmission(value: unknown): SavedAdmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('入场策略保存结果未确认');
  const body = value as Record<string, unknown>;
  if (body.ok !== true) throw new Error(typeof body.error === 'string' ? body.error : '入场策略保存失败');
  if (!body.result || typeof body.result !== 'object' || Array.isArray(body.result)) throw new Error('入场策略回执无效');
  const result = body.result as Record<string, unknown>;
  const positiveInteger = (input: unknown, maximum: number): input is number =>
    typeof input === 'number' && Number.isSafeInteger(input) && input >= 1 && input <= maximum;
  if (typeof result.runId !== 'string' || !positiveInteger(result.maxInFlight, 40) || !positiveInteger(result.intakeWindow, 20)) {
    throw new Error('入场策略回执缺少有效窗口');
  }
  let admission: BatchGoal['admission'];
  if (result.admission !== undefined) {
    if (!result.admission || typeof result.admission !== 'object' || Array.isArray(result.admission)) throw new Error('入场策略回执无效');
    const policy = result.admission as Record<string, unknown>;
    if (policy.mode !== 'flow' || !positiveInteger(policy.maxInFlightLimit, 40) || !positiveInteger(policy.intakeWindowLimit, 20)) {
      throw new Error('入场策略回执缺少有效上限');
    }
    admission = {mode: 'flow', maxInFlightLimit: policy.maxInFlightLimit, intakeWindowLimit: policy.intakeWindowLimit};
  }
  return {runId: result.runId, maxInFlight: result.maxInFlight, intakeWindow: result.intakeWindow, admission};
}

export function FlowSettings() {
  const goal = useStore(state => state.fs.batch);
  const runId = useStore(state => state.fs.run.id);
  const connected = useStore(state => state.connected);
  const replay = useStore(state => Boolean(state.replay));
  const current = goal?.runId === runId ? goal : undefined;
  const [flow, setFlow] = useState(Boolean(current?.admission));
  const [maximum, setMaximum] = useState(current?.admission?.maxInFlightLimit ?? current?.maxInFlight ?? 6);
  const [intake, setIntake] = useState(current?.admission?.intakeWindowLimit ?? current?.intakeWindow ?? 2);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const revision = JSON.stringify([current?.runId, current?.admission, current?.maxInFlight, current?.intakeWindow]);
  const disabled = !current || !connected || replay || busy;
  useEffect(() => {
    if (dirty) return;
    setFlow(Boolean(current?.admission));
    setMaximum(current?.admission?.maxInFlightLimit ?? current?.maxInFlight ?? 6);
    setIntake(current?.admission?.intakeWindowLimit ?? current?.intakeWindow ?? 2);
  }, [revision, dirty]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    setBusy(true);
    setError('');
    setReceipt('');
    try {
      const response = await fetch('/api/batch/admission', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({flow, maxInFlight: maximum, intakeWindow: intake}), signal: AbortSignal.timeout(15000),
      });
      const body: unknown = await response.json();
      const saved = savedAdmission(body);
      if (!response.ok) throw new Error('入场策略保存结果未确认');
      setState(state => state.fs.batch?.runId === saved.runId
        ? {fs: {...state.fs, batch: {...state.fs.batch, maxInFlight: saved.maxInFlight, intakeWindow: saved.intakeWindow, admission: saved.admission}},
          nodeExecutions: state.nodeExecutions, nodeRecoveries: state.nodeRecoveries}
        : {});
      setDirty(false);
      setReceipt('已保存，当前运行或暂停状态保持不变。');
    } catch (reason) {
      setError(reason instanceof Error && reason.name === 'TimeoutError'
        ? '保存结果未确认，请刷新页面核对，勿重复提交。'
        : reason instanceof Error ? reason.message : '入场策略保存失败');
    } finally {
      setBusy(false);
    }
  };

  return <section className="set-sec" aria-label="流水线流动">
    <h3>流水线流动</h3>
    <p className="muted">前段处理完即可接下一件；后段按各自速度继续。模型、浏览器等实际并发仍由资源配额约束。</p>
    {!current ? <p className="muted">新建托管目标默认按节拍补料，在途最多 6 件、入口最多 2 件。设定本轮目标后可在这里调整。</p> : <form className="agent-binding agent-default" onSubmit={submit}>
      <p className="agent-binding-effective">当前窗口：在途 {current.maxInFlight} 件 · 入口 {current.intakeWindow} 件</p>
      <label>入场策略<select aria-label="入场策略" disabled={disabled} value={flow ? 'flow' : 'fixed'} onChange={event => {
        const automatic = event.target.value === 'flow';
        setFlow(automatic);
        if (automatic && !current.admission) {
          setMaximum(6);
          setIntake(2);
        }
        setDirty(true);
        setReceipt('');
      }}><option value="flow">按节拍补料</option><option value="fixed">固定窗口</option></select></label>
      <label>在途上限<input aria-label="在途上限" type="number" min={1} max={40} step={1} required disabled={disabled} value={maximum} onChange={event => {setMaximum(Number(event.target.value)); setDirty(true); setReceipt('');}} /></label>
      <label>入口上限<input aria-label="入口上限" type="number" min={1} max={20} step={1} required disabled={disabled} value={intake} onChange={event => {setIntake(Number(event.target.value)); setDirty(true); setReceipt('');}} /></label>
      <p className="muted">{flow ? '根据工位耗时和资源配额，在上限内调整窗口；慢工位的自动增员仍受工位人数和资源约束。' : '窗口保持所填数值。在途上限为 1 时，必须等一整件结束后才接下一件。'}</p>
      {error && <p className="agent-binding-error" role="alert">{error}</p>}
      {receipt && <p className="agent-binding-receipt" role="status">{receipt}</p>}
      <div className="agent-binding-actions"><button className="btn btn--sm btn--primary" disabled={disabled || !dirty}>{busy ? '正在保存…' : '保存入场策略'}</button></div>
    </form>}
  </section>;
}
