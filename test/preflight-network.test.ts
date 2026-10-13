import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkExternalAccess, checkMemoryCapacity, checkDnsProxy, checkBrowserCapture, preflight } from '../server/preflight.ts';
import {Broker}from'../server/broker.ts';
import { closeNetwork, networkRoute } from '../server/network.ts';

test('a local program-only workflow checks storage without contacting network, model or browser', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-cpu-preflight-'));
  const lookup = t.mock.method(dns, 'lookup', async () => { throw new Error('program-only preflight must not resolve external hosts'); });
  const broker = new Broker({ browser: 0, cpu: 1 }, 1_000_000); broker.freeMem = () => 420;
  try {
    const result = await preflight(root, broker, { network: false, model: false, browser: false });
    assert.equal(result.ok, true); assert.deepEqual(result.checks.map(check => check.id), ['disk', 'memory']);
    assert.equal(lookup.mock.callCount(), 0); assert.equal(broker.used.browser, 0);
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'ENV.md'), 'utf8'), /✓.*模型凭据|✓.*后台页/);
    const explicit = await preflight(root, broker, {network: false, browser: false, model: true, agents: []});
    assert.equal(explicit.ok, true);
    assert.deepEqual(explicit.checks.map(check => check.id), ['disk', 'memory'], 'an explicit empty agent set does not probe default Pi');
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'ENV.md'), 'utf8'), /✓.*模型凭据/);
  } finally {
    lookup.mock.restore();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DNS preflight follows the proxy hop, bypass rules and credential redaction', async t => {
  const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const resolved: string[] = [];
  const lookup = t.mock.method(dns, 'lookup', async (host: string) => {
    resolved.push(host);
    if (host === 'unresolvable-public.test') throw Object.assign(new Error('local DNS unavailable'), { code: 'ENOTFOUND' });
    return { address: '127.0.0.1', family: 4 };
  });
  try {
    for (const key of keys) delete process.env[key];
    process.env.HTTPS_PROXY = 'http://fixture-user:fixture-password@proxy.internal.test:8080/private-path?token=fixture-query';
    const proxy = await checkDnsProxy('https://unresolvable-public.test/');
    assert.equal(proxy.ok, true); assert.deepEqual(resolved, ['proxy.internal.test']);
    assert.doesNotMatch(proxy.detail, /fixture-user|fixture-password|private-path|fixture-query/);
    assert.equal(networkRoute('http://localhost/').proxy, false);
    assert.equal(networkRoute('https://[::1]/').proxy, false);
    process.env.NO_PROXY = '.direct.test,*.subdomain.test,[::1]:443';
    assert.equal(networkRoute('https://direct.test/').proxy, false);
    assert.equal(networkRoute('https://a.direct.test/').proxy, false);
    assert.equal(networkRoute('https://subdomain.test/').proxy, true);
    assert.equal(networkRoute('https://a.subdomain.test/').proxy, false);
    process.env.NO_PROXY = '*';
    await assert.rejects(checkDnsProxy('https://unresolvable-public.test/'), /local DNS unavailable/);
    assert.equal(resolved.at(-1), 'unresolvable-public.test');
  } finally {
    lookup.mock.restore();
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

test('insufficient memory cannot produce a green preflight while the browser pool is blocked',()=>{
  const broker=new Broker({browser:3},1024);broker.freeMem=()=>420;
  assert.equal(broker.tryAcquire('browser'),null);assert.equal(checkMemoryCapacity(broker).ok,false);
  assert.match(checkMemoryCapacity(broker).detail,/420MB/);
  broker.freeMem=()=>2048;assert.equal(checkMemoryCapacity(broker).ok,true);
});

test('a late browser preflight page is cancelled and reclaimed after the deadline', async () => {
  const broker = new Broker({ browser: 1 }, 0);
  let resolvePage!: (value: any) => void, closed = 0, navigated = 0, signal: AbortSignal | undefined;
  const pending = checkBrowserCapture(broker, { timeoutMs: 20, open: async (_viewport, _locale, requestSignal) => {
    signal = requestSignal;
    return new Promise(resolve => { resolvePage = resolve; });
  } });
  await assert.rejects(pending, /后台截图检查超过/);
  assert.equal(signal?.aborted, true);
  assert.equal(broker.used.browser, 1, 'late native allocation still counts until cleanup settles');
  resolvePage({ page: { goto: async () => { navigated++; } }, close: async () => { closed++; } });
  await delay(0);
  assert.equal(closed, 1); assert.equal(navigated, 0); assert.equal(broker.used.browser, 0);
});

test('external preflight distinguishes one failed probe from a total outage', async () => {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url!);
    if (req.url === '/hang') return;
    res.writeHead(req.url === '/ok' ? 200 : req.url === '/proxy-auth' ? 407 : 503, { 'content-type': 'text/plain' });
    res.end(req.url === '/ok' ? 'reachable' : 'temporarily unavailable');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const reachable = await checkExternalAccess([origin + '/down', origin + '/ok'], 2000);
    assert.equal(reachable.ok, true); assert.match(reachable.detail, /503.*200/);
    assert.deepEqual(seen, ['/down', '/ok']);
    assert.equal((await checkExternalAccess([origin + '/down', origin + '/down-again'], 2000)).ok, false);
    assert.equal((await checkExternalAccess([origin + '/proxy-auth'], 2000)).ok, false, 'an authenticating proxy does not prove external access');
    const stalled = await checkExternalAccess([origin + '/hang', origin + '/ok'], 500);
    assert.equal(stalled.ok, true, stalled.detail);
    assert.ok(seen.includes('/hang')); assert.equal(seen.at(-1), '/ok');
  } finally {
    await closeNetwork(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
