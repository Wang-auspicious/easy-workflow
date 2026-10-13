import type { Stamped } from '../../../shared/types.ts';

interface JournalPage { events: Stamped[]; nextSeq: number; through: number; done: boolean }

/** Bound JSON parsing per page and freeze the upper sequence while live work continues. */
export async function loadReplayEvents(run: string, signal: AbortSignal, progress: (count: number) => void, request: typeof fetch = fetch) {
  const events: Stamped[] = [];
  let since = 0, through: number | undefined;
  for (;;) {
    signal.throwIfAborted();
    const query = new URLSearchParams({ run, since: String(since), limit: '200' });
    if (through !== undefined) query.set('through', String(through));
    const response = await request(`/api/journal?${query}`, { signal });
    if (!response.ok) throw new Error(`读取回放失败（HTTP ${response.status}）。`);
    const page: JournalPage = await response.json();
    signal.throwIfAborted();
    if (!Array.isArray(page.events) || page.events.length > 200 || !Number.isSafeInteger(page.nextSeq) || !Number.isSafeInteger(page.through) || typeof page.done !== 'boolean') throw new Error('回放分页格式无效，请更新服务后重试。');
    if (through !== undefined && through !== page.through) throw new Error('回放快照发生变化，请重新加载。');
    through = page.through;
    let sequence = since;
    for (const event of page.events) {
      if (!Number.isSafeInteger(event.seq) || event.seq <= sequence || event.seq > through || !Number.isFinite(event.at)) throw new Error('回放事件顺序无效，已停止加载。');
      sequence = event.seq; events.push(event);
    }
    if (page.nextSeq < sequence || page.nextSeq > through || (!page.done && page.nextSeq <= since)) throw new Error('回放分页没有前进，已停止加载。');
    since = page.nextSeq; progress(events.length);
    if (page.done) return events;
  }
}
