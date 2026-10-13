import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

test('browser metadata preserves all thirty allowed user tabs', () => {
  const { BrowserData } = createRequire(import.meta.url)('../app/browser-data.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-browser-metadata-'));
  try {
    const file = path.join(root, 'browser.json');
    fs.writeFileSync(file, JSON.stringify({ tabs: Array.from({ length: 30 }, (_, i) => ({ url: `https://fixture.test/${i}` })) }));
    assert.equal(new BrowserData(file).tabs.length, 30);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), 'easy-workflow-browser-metadata-')));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('standalone browser restores user tabs, tracks their popups and detects idle login changes', { timeout: 35000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-browser-standalone-'));
  const saved = process.env.FACTORY_VAR; process.env.FACTORY_VAR = root;
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<title>Fixture ${req.url}</title><main>Public content ${req.url}</main>`); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { openPage, browserCommand, closeBrowser } = await import('../server/browser.ts');
  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    await browserCommand({ action: 'open', url: `${base}/one` });
    await browserCommand({ action: 'open', url: `${base}/two` });
    let state = await browserCommand({ action: 'state' });
    const first = state.tabs.find((tab: any) => tab.url === `${base}/one`), second = state.tabs.find((tab: any) => tab.url === `${base}/two`);
    await browserCommand({ action: 'tab.move', id: second.id, before: first.id });
    await browserCommand({ action: 'tab.move', id: second.id, before: second.id });
    const task = await openPage();
    assert.equal((await browserCommand({ action: 'state' })).active, second.id, 'a background task must not select its tab over the user tab');
    await task.page.goto(`${base}/task`); await task.close();
    const persisted = JSON.parse(fs.readFileSync(path.join(root, 'browser', 'browser.json'), 'utf8'));
    assert.deepEqual(persisted.tabs.map((tab: any) => tab.url), [`${base}/two`, `${base}/one`]);
    await closeBrowser();
    state = await browserCommand({ action: 'state' });
    assert.deepEqual(state.tabs.map((tab: any) => tab.url), [`${base}/two`, `${base}/one`]);
    for (const tab of state.tabs) assert.match((await browserCommand({ action: 'read', id: tab.id })).text, /Public content/);
    const inspection = await openPage();
    const one = inspection.context.pages().find(page => page.url() === `${base}/one`)!;
    const two = inspection.context.pages().find(page => page.url() === `${base}/two`)!;
    await two.evaluate(() => { window.open('/popup'); });
    for (let i = 0; i < 100 && !(await browserCommand({ action: 'state' })).tabs.some((tab: any) => tab.url === `${base}/popup`); i++) await delay(10);
    const popup = (await browserCommand({ action: 'state' })).tabs.find((tab: any) => tab.url === `${base}/popup`);
    assert.equal(popup?.owner, 'user');
    await browserCommand({ action: 'close', id: popup.id });
    await one.evaluate(() => { document.title = 'Log in'; document.body.innerHTML = '<main>Sign in to continue<input type=password></main>'; });
    await inspection.close();
    t.mock.timers.tick(30000);
    for (let i = 0; i < 100 && !(await browserCommand({ action: 'state' })).tabs.find((tab: any) => tab.url === `${base}/one`)?.attention; i++) await delay(10);
    state = await browserCommand({ action: 'state' });
    const blocked = state.tabs.find((tab: any) => tab.url === `${base}/one`);
    assert.equal(blocked.attentionKind, 'auth', 'idle DOM changes must be checked without a manual attention.check');
    await browserCommand({ action: 'close', id: blocked.id });
    await closeBrowser();
    assert.deepEqual((await browserCommand({ action: 'state' })).tabs.map((tab: any) => tab.url), [`${base}/two`]);
  } finally {
    await closeBrowser(); t.mock.timers.reset();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (saved === undefined) delete process.env.FACTORY_VAR; else process.env.FACTORY_VAR = saved;
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), 'easy-workflow-browser-standalone-')));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
