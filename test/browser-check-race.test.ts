import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { BrowserManager, noteBrowserResponse } = createRequire(import.meta.url)('../app/browser-manager.cjs');

test('lease release rechecks navigation that made an in-flight attention probe stale', async () => {
  let url = 'https://fixture.test/public', probes = 0, closes = 0;
  let resolveProbe!: (value: unknown) => void;
  const firstProbe = new Promise(resolve => { resolveProbe = resolve; });
  const tab = { id: 'agent', owner: 'agent', leased: true, url, view: { webContents: {
    isDestroyed: () => false, getURL: () => url, isLoading: () => false, close: () => { closes++; },
    executeJavaScript: async () => ++probes === 1 ? firstProbe : { url, issue: '登录状态需要检查', kind: 'auth' },
  } } };
  const manager = Object.create(BrowserManager.prototype);
  manager.tabs = new Map([[tab.id, tab]]); manager.publish = () => {}; manager.snapshot = () => ({});
  const original = manager.check(tab);
  await Promise.resolve();
  const oldUrl = url; url = tab.url = 'https://fixture.test/login';
  noteBrowserResponse(tab, { url, status: 200, mainFrame: true, resourceType: 'mainFrame' });
  const release = manager.command({ action: 'release', id: tab.id });
  resolveProbe({ url: oldUrl, issue: '' });
  await Promise.all([original, release]);
  assert.equal(closes, 0, 'the stale public-page probe cannot discard the new login scene');
  assert.equal(probes, 2);
  assert.equal((tab as { attentionKind?: string }).attentionKind, 'auth');
});
