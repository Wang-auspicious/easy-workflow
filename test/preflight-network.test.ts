import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkExternalAccess } from '../server/preflight.ts';
import { closeNetwork } from '../server/network.ts';

test('external preflight distinguishes one failed probe from a total outage', async () => {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url!);
    if (req.url === '/hang') return;
    res.writeHead(req.url === '/ok' ? 200 : 503, { 'content-type': 'text/plain' });
    res.end(req.url === '/ok' ? 'reachable' : 'temporarily unavailable');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const reachable = await checkExternalAccess([origin + '/down', origin + '/ok'], 2000);
    assert.equal(reachable.ok, true); assert.match(reachable.detail, /503.*200/);
    assert.deepEqual(seen, ['/down', '/ok']);
    assert.equal((await checkExternalAccess([origin + '/down', origin + '/down-again'], 2000)).ok, false);
    const stalled = await checkExternalAccess([origin + '/hang', origin + '/ok'], 500);
    assert.equal(stalled.ok, true, stalled.detail);
    assert.ok(seen.includes('/hang')); assert.equal(seen.at(-1), '/ok');
  } finally {
    await closeNetwork(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
