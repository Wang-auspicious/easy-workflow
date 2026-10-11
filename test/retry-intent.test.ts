import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-retry-intent-'));
process.env.FACTORY_VAR = dir;
process.env.FACTORY_PREFLIGHT = '0';
process.env.FACTORY_HTTP_CACHE = '0';
process.env.VISLEXICON_ROOT = path.join(dir, 'unconnected');
const { Factory } = await import('../server/factory.ts');
const { endRun } = await import('../server/report.ts');

test('retry after intake failure preserves explicit published-site rerun intent', async () => {
  const factory = new Factory();
  try {
    await factory.boot();
    factory.runtime.executors = () => async () => ({ ok: false, summary: 'connection reset', failure: { tag: 'network_connection', category: 'network', message: 'ECONNRESET', retryable: true } });
    const [first] = factory.feed(['https://published.example/'], { rerunPublished: true });
    await factory.runtime.settle();
    assert.equal(factory.state.tokens[first.id].status, 'parked');
    factory.runtime.executors = () => async context => ({ ok: true, summary: 'dedupe decision', finish: { status: context.token.data.rerunPublished ? 'published' : 'merged', reason: 'fixture' } });
    const [retry] = factory.retryCandidates({ items: [first.item], count: 1 });
    await factory.runtime.settle();
    assert.equal(factory.state.tokens[retry.id].status, 'published');
    assert.equal(retry.data.rerunPublished, true);
    assert.equal(retry.data.retryOf, first.id);
    await endRun(factory);
  } finally { await factory.runtime.close(); factory.lessons.close(); factory.journal.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
