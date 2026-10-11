import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserState } from '../shared/browser.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-verified-access-'));
process.env.FACTORY_VAR = dir;
process.env.FACTORY_PREFLIGHT = '0';
process.env.FACTORY_HTTP_CACHE = '0';
process.env.FACTORY_BROWSER_BRIDGE = '1';
process.env.VISLEXICON_ROOT = path.join(dir, 'not-connected');

// Exercise the production browser RPC contract without creating a real browser,
// opening a URL, or accessing a user's profile.
const healthyBrowser = (): BrowserState => ({
  tabs: [{ id: 'retained', title: 'Account library', url: 'https://account.example.test/library', loading: false, owner: 'agent' }],
  active: 'retained', bookmarks: [], history: [], retentionDays: 30, mode: 'desktop',
});
let observed = healthyBrowser();
Object.defineProperty(process, 'connected', { value: true, writable: true, configurable: true });
process.send = ((request: { id: string; args: { action: string } }, callback?: (error: Error | null) => void) => {
  assert.ok(['state', 'attention.check'].includes(request.args.action), `unexpected browser action ${request.args.action}`);
  queueMicrotask(() => process.emit('message', { type: 'browser:reply', id: request.id, result: structuredClone(observed) }));
  callback?.(null);
  return true;
}) as typeof process.send;

const { Factory } = await import('../server/factory.ts');
const { batchSummary } = await import('../shared/batch.ts');

async function withWalledBatch(run: (factory: InstanceType<typeof Factory>) => Promise<void>) {
  observed = healthyBrowser();
  const factory = new Factory();
  try {
    await factory.boot();
    factory.catalog = [{ id: 'account', name: 'Account library', canonicalUrl: 'https://account.example.test/library' }];
    factory.runtime.executors = () => async ctx => ctx.token.data.retryOf
      ? { ok: true, summary: 'fixture complete', finish: { status: 'published', reason: 'fixture' } }
      : { ok: false, summary: 'loginWall', failure: { tag: 'auth_required', category: 'auth', retryable: true, owner: 'user', message: 'loginWall', url: 'https://account.example.test/library' } };
    factory.batch.configure({ target: 1 });
    await factory.runtime.settle();
    assert.equal(batchSummary(factory.state)?.blocked, 1);
    assert.ok(factory.state.alerts['auth:account']);
    await run(factory);
  } finally {
    await factory.runtime.close(); factory.docs.flush(); factory.lessons.close(); factory.journal.close();
    const target = path.resolve(dir), parent = path.resolve(os.tmpdir());
    assert.ok(target.startsWith(`${parent}${path.sep}`) && path.basename(target).startsWith('easy-workflow-verified-access-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
}

test('verification while paused waits for resume, then retries the verified checkpoint', async () => {
  await withWalledBatch(async factory => {
    factory.batch.setMode('paused');
    const count = factory.runtime.tokens.size;
    const checked = await factory.recheckAlert('auth:account');
    assert.equal(checked.cleared, true);
    assert.equal(checked.resumed, false);
    assert.equal(factory.runtime.tokens.size, count, 'verification must not bypass pause');
    factory.batch.setMode('running');
    factory.batch.pump(Date.now() + 120000);
    await factory.runtime.settle();
    assert.equal(batchSummary(factory.state)?.completed, 1, 'clearing the login alert must retain a durable recovery to consume after resume');
    assert.equal(batchSummary(factory.state)?.admitted, 1);
  });
});

test('stopped batch does not automatically retry on a healthy browser notification', async () => {
  await withWalledBatch(async factory => {
    factory.batch.setMode('stopped');
    const count = factory.runtime.tokens.size;
    await factory.resumeVerified({ ...observed, tabs: observed.tabs.map(tab => ({ ...tab, attention: 'loginWall', attentionKind: 'auth' })) });
    await factory.resumeVerified(observed);
    await factory.runtime.settle();
    assert.equal(factory.state.batch?.mode, 'stopped');
    assert.equal(factory.runtime.tokens.size, count, 'automatic access recovery must obey stopped admission/retry supervision');
    assert.equal(batchSummary(factory.state)?.completed, 0);
  });
});

test('retained tab identity does not certify access after navigating to an unrelated site', async () => {
  await withWalledBatch(async factory => {
    const alert = factory.state.alerts['auth:account'];
    factory.raiseAlert({ ...alert, tab: 'retained' });
    observed.tabs[0].url = 'https://unrelated.example.test/';
    const checked = await factory.recheckAlert('auth:account');
    assert.equal(checked.cleared, false, 'a different website is not evidence that the original access wall has been resolved');
    assert.equal(checked.resumed, false);
    assert.ok(factory.state.alerts['auth:account']);
    assert.equal(factory.runtime.tokens.size, 1);
  });
});

test('verified recoveries still respect the configured in-flight limit on resume', async () => {
  await withWalledBatch(async factory => {
    factory.catalog = Array.from({ length: 4 }, (_, i) => ({ id: i ? `account-${i}` : 'account', name: `Library ${i}`, canonicalUrl: `https://account.example.test/library-${i}` }));
    factory.batch.configure({ target: 4, maxInFlight: 2, intakeWindow: 2 });
    await factory.runtime.settle();
    assert.equal(batchSummary(factory.state)?.admitted, 4);
    factory.batch.setMode('paused');
    for (const alert of Object.values(factory.state.alerts)) await factory.recheckAlert(alert.id);
    factory.batch.setMode('running');
    await Promise.resolve();
    assert.ok(batchSummary(factory.state)!.active <= 2, 'resuming verified login failures must share the bounded admission budget');
    await factory.runtime.settle();
    assert.equal(batchSummary(factory.state)?.completed, 4, 'later verified items resume when earlier work frees an in-flight slot');
  });
});
