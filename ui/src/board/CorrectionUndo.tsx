import { useState } from 'react';
import { boot } from '../api.ts';
import { useStore } from '../store.ts';
import { workflowCall } from '../views/workflows.ts';

/** Availability comes from replayable correction events; the server verifies again on click. */
export function CorrectionUndo({ id }: { id: string }) {
  const record = useStore(s => s.fs.corrections?.[id]);
  const status = useStore(s => s.fs.corrections?.[id]?.status);
  const inFlight = useStore(s => {
    const token = s.fs.corrections?.[id]?.token;
    return token ? s.fs.tokens[token]?.attempts.some(attempt => !s.fs.attempts[attempt]?.endedAt) ?? false : false;
  });
  const disabled = useStore(s => !s.connected || Boolean(s.replay));
  const [busy, setBusy] = useState(false), [done, setDone] = useState(false), [error, setError] = useState('');
  if (!record) return null;
  if (status === 'reverted' || done) return <span className="correction-undo-note" role="status">已撤销本次纠错</span>;
  if (status === 'executed') return <span className="correction-undo-note">纠错已开始执行，不能撤销</span>;
  const undo = async () => {
    if (busy || disabled || inFlight) return;
    setBusy(true); setError('');
    try {
      await workflowCall('undo_correction', { correction: id }); setDone(true);
      await boot();
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="correction-undo"><button type="button" disabled={busy || disabled || inFlight} onClick={() => void undo()}>{busy ? '正在撤销…' : inFlight ? '等待在途工位回收' : '撤销本次纠错'}</button>{error && <p role="alert">{error}</p>}</div>;
}
