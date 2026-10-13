import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { closeNetwork, configureNetwork, webGet } from '../server/network.ts';

test('HTTP admission, backoff and cache respect cancellation and request identity', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-network-'));
  const held: http.ServerResponse[] = [], seen: string[] = [];
  let limited!: () => void;
  const limitedSeen = new Promise<void>(resolve => { limited = resolve; });
  const server = http.createServer((req, res) => {
    seen.push(req.url!);
    if (req.url!.startsWith('/hold')) { held.push(res); return; }
    if (req.url === '/limited') { res.writeHead(429); res.end('slow down'); limited(); return; }
    if (req.url === '/private') res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ accept: req.headers.accept, authorization: req.headers.authorization ?? null, count: seen.length }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  configureNetwork({ cacheDir: root });
  try {
    await t.test('a cancelled queued request settles before occupied slots are released', async () => {
      const active = [webGet(`${base}/hold/1`), webGet(`${base}/hold/2`)];
      while (held.length < 2) await delay(10);
      const controller = new AbortController();
      const pending = webGet(`${base}/cancelled`, { signal: controller.signal });
      const settled = pending.then(() => 'completed', error => error.message);
      controller.abort(new Error('cancelled in HTTP queue'));
      try {
        assert.equal(await Promise.race([settled, delay(150, 'still waiting')]), 'cancelled in HTTP queue');
      } finally { for (const response of held) response.end('done'); await Promise.all(active); await settled; }
      assert.equal(seen.includes('/cancelled'), false);
    });
    await t.test('rate-limit backoff is cancelled without waiting three seconds', async () => {
      const controller = new AbortController();
      const settled = webGet(`${base}/limited`, { signal: controller.signal }).then(() => 'completed', error => error.message);
      await limitedSeen; await delay(10); controller.abort(new Error('cancelled during backoff'));
      try { assert.equal(await Promise.race([settled, delay(150, 'still waiting')]), 'cancelled during backoff'); }
      finally { await settled; }
      assert.equal(seen.filter(url => url === '/limited').length, 1);
    });
    await t.test('cache does not interchange HTML, JSON or authenticated responses', async () => {
      const html = await webGet(`${base}/content`, { accept: 'text/html' });
      const json = await webGet(`${base}/content`, { accept: 'application/json' });
      assert.equal(JSON.parse(html.body).accept, 'text/html');
      assert.equal(JSON.parse(json.body).accept, 'application/json');
      const privateResult = await webGet(`${base}/content`, { headers: { authorization: 'Bearer fixture-only' } });
      const publicResult = await webGet(`${base}/content`);
      assert.equal(JSON.parse(privateResult.body).authorization, 'Bearer fixture-only');
      assert.equal(JSON.parse(publicResult.body).authorization, null);
      assert.equal((await webGet(`${base}/content`, { accept: 'text/html' })).via, 'cache');
    });
    await t.test('no-store responses are fetched each time and an aborted cache hit rejects', async () => {
      const first = await webGet(`${base}/private`), second = await webGet(`${base}/private`);
      assert.notEqual(first.body, second.body);
      const controller = new AbortController(); controller.abort(new Error('cancelled cached request'));
      await assert.rejects(webGet(`${base}/content`, { accept: 'text/html', signal: controller.signal }), /cancelled cached request/);
    });
  } finally {
    configureNetwork({ cacheDir: null }); await closeNetwork();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), 'easy-workflow-network-')));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
