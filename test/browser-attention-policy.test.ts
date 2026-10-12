import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { classifyFailure, candidateFailure } from '../shared/failures.ts';

test('access-denied status and validation errors do not invent a request for user login', () => {
  const forbidden = classifyFailure('HTTP 403', { status: 403 });
  assert.equal(forbidden.tag, 'http_forbidden');
  assert.equal(forbidden.owner, 'system');
  assert.doesNotMatch(forbidden.nextAction!, /等站长.*登录/);
  assert.equal(classifyFailure('事实验证失败：the quote is not verbatim in the dossier').tag, 'tool_error');
  assert.equal(classifyFailure('证书验证失败：CERT_HAS_EXPIRED').tag, 'network_tls');
  assert.equal(classifyFailure('登录页面导航失败 net::ERR_CONNECTION_CLOSED').tag, 'network_connection');
  assert.equal(classifyFailure('页面需要登录或验证，已保留在内置浏览器').tag, 'auth_required');
  assert.equal(classifyFailure('HTTP 401', { status: 401 }).tag, 'auth_required');
});

test('an optional capture page redirects to login without turning a public homepage into a user task', () => {
  const auth = classifyFailure('页面需要登录或验证', { url: 'https://cloud.example.test/login' });
  const optional = candidateFailure({ ...auth, requestedUrl: 'https://example.test/gallery/private-demo' }, 'https://example.test/');
  assert.equal(optional.tag, 'needs_selection'); assert.equal(optional.owner, 'agent');
  assert.match(optional.nextAction!, /公开|备选/);
  assert.equal(candidateFailure({ ...auth, requestedUrl: 'https://example.test/' }, 'https://example.test/').tag, 'auth_required', 'a homepage redirect can be a real access wall');
  assert.equal(candidateFailure({ ...auth, requestedUrl: 'https://www.example.test/?utm_source=gallery' }, 'http://example.test/').tag, 'auth_required', 'normal homepage canonicalization does not make the entry optional');
  assert.equal(candidateFailure(auth, 'https://example.test/').tag, 'auth_required', 'missing navigation context cannot prove an optional page');
});

test('shared browser holds actual access walls and releases recoverable system failures', { timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-attention-'));
  const old = process.env.FACTORY_VAR; process.env.FACTORY_VAR = root;
  const fixture = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/optional-session') { res.statusCode = 401; res.end('not signed in'); return; }
    if (req.url === '/forbidden') { res.statusCode = 403; res.end('<title>Forbidden</title><main>Access denied by server policy.</main>'); return; }
    if (req.url === '/unavailable') { res.statusCode = 503; res.end('<title>Temporarily unavailable</title>Try again later.'); return; }
    if (req.url === '/login') { res.end('<title>Log in | Product Cloud</title><main><h1>Log in to continue</h1><form><input type=email><input type=password><button>Log in</button></form></main>'); return; }
    if (req.url === '/challenge') { res.end('<title>Just a moment...</title><main>Verify you are human</main>'); return; }
    if (req.url === '/password-demo') { res.end('<title>Password field - Components</title><nav>Sign in</nav><main><h1>Password input</h1><p>Use this input in your forms. This is a live component preview.</p><section><label>Example password<input type=password></label></section><h2>Examples</h2><p>The examples show visible and hidden password fields.</p></main>'); return; }
    res.end('<title>ProtoPie-style public homepage</title><nav><a href="/login">Sign in</a></nav><main><h1>Build interactive prototypes</h1><p>Explore the public gallery and documentation.</p></main><script>fetch("/optional-session").then(() => window.sessionChecked = true)</script>');
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const { openPage, browserCommand, closeBrowser, inspectBrowserAttention } = await import('../server/browser.ts');
  const { pageVerdict, visit } = await import('../packs/vislexicon/capture.ts');
  const { BrowserManager, noteBrowserResponse } = createRequire(import.meta.url)('../app/browser-manager.cjs');
  try {
    await t.test('background popups do not leave untracked pages behind', async () => {
      const lease = await openPage(); await lease.page.goto(base);
      assert.equal(await lease.page.evaluate(() => window.open('/login') === null), true);
      assert.equal(lease.context.pages().length, 1);
      await lease.close();
      assert.equal(lease.context.pages().length, 0);
      assert.equal((await browserCommand({action:'state'})).tabs.length, 0);
    });
    await t.test('optional anonymous session checks cannot hold a public site hostage', async () => {
      const lease = await openPage(); await lease.page.goto(base);
      await lease.page.waitForFunction(() => (window as any).sessionChecked);
      const id = (await browserCommand({ action: 'state' })).tabs[0].id;
      await browserCommand({ action: 'attention.check', id });
      assert.equal((await browserCommand({ action: 'state' })).tabs[0].attention, undefined);
      await lease.close();
      assert.equal((await browserCommand({ action: 'state' })).tabs.length, 0);
    });
    await t.test('a password component example is not a login wall', async () => {
      const lease = await openPage();
      try {
        await lease.page.goto(`${base}/password-demo`);
        const probe = await inspectBrowserAttention(lease.page);
        assert.equal(probe.issue, '');
        assert.deepEqual(await pageVerdict(lease.page, '127.0.0.1'), []);
      } finally { await lease.close(); }
    });
    await t.test('agent failures release pages while real login and captcha pages remain inspectable', async () => {
      for (const route of ['forbidden', 'unavailable', 'login', 'challenge']) {
        const lease = await openPage(); await lease.page.goto(`${base}/${route}`);
        const id = (await browserCommand({ action: 'state' })).tabs.find((tab: { url: string }) => tab.url === `${base}/${route}`).id;
        await lease.close();
        const held = (await browserCommand({ action: 'state' })).tabs.some((tab: { id: string }) => tab.id === id);
        assert.equal(held, ['login', 'challenge'].includes(route), route);
        if (held) await browserCommand({ action: 'close', id });
      }
    });
    await t.test('desktop release protects user tabs and recycles system-failed agent views', async () => {
      for (const owner of ['agent', 'user']) {
        let closes = 0;
        const tab = { id: owner, owner, url: `${base}/unavailable`, attention: undefined, view: { webContents: { close: () => { closes++; }, isDestroyed: () => false } } };
        noteBrowserResponse(tab, { url: tab.url, status: 503, mainFrame: true, resourceType: 'mainFrame' });
        const manager = Object.create(BrowserManager.prototype);
        manager.tabs = new Map([[tab.id, tab]]); manager.check = async () => {}; manager.snapshot = () => ({}); manager.publish = () => {};
        await manager.command({ action: 'release', id: tab.id });
        assert.equal(closes, owner === 'agent' ? 1 : 0, owner);
      }
    });
    await t.test('capture reports an unexplained 403 as system-owned and still blocks real login', async () => {
      const lease = await openPage();
      try {
        await assert.rejects(visit(lease.page, `${base}/forbidden`, '127.0.0.1'), (error: any) => error.failure?.tag === 'http_forbidden' && error.failure?.owner === 'system');
        await assert.rejects(visit(lease.page, `${base}/login`, '127.0.0.1'), /登录/);
      } finally { await lease.close(); }
    });
    await t.test('repeated attempts preserve one login scene instead of exhausting the page limit', async () => {
      for (let i = 0; i < 3; i++) {
        const lease = await openPage(); await lease.page.goto(`${base}/login`); await lease.close();
      }
      const held = (await browserCommand({ action: 'state' })).tabs.filter((tab: { url: string }) => tab.url === `${base}/login`);
      assert.equal(held.length, 1);
    });
  } finally {
    await closeBrowser(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
    if (old === undefined) delete process.env.FACTORY_VAR; else process.env.FACTORY_VAR = old;
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), 'easy-workflow-attention-')));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
