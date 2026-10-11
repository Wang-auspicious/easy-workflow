import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { StationContext } from '../server/runtime.ts';

test('unreachable sites stay with system recovery and network diagnosis never exports proxy credentials', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-network-ownership-'));
  const saved = { FACTORY_VAR: process.env.FACTORY_VAR, HTTPS_PROXY: process.env.HTTPS_PROXY };
  process.env.FACTORY_VAR = root;
  process.env.HTTPS_PROXY = 'http://probe-user:probe-secret@127.0.0.1:9';
  const { scout } = await import('../packs/vislexicon/scout.ts');
  const { closeNetwork, diagnoseReach } = await import('../server/network.ts');
  const fixture = http.createServer((req, res) => {
    if (req.url === '/ready') { res.end('public content'); return; }
    req.socket.destroy();
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  try {
    const probe = await diagnoseReach(`${base}/ready`);
    assert.equal(probe?.directOk, true);
    assert.doesNotMatch(JSON.stringify(probe), /probe-user|probe-secret/);
    const messages: string[] = [];
    const ctx = { token: { url: base, data: {} }, signal: new AbortController().signal, progress: (message: string) => messages.push(message) } as unknown as StationContext;
    const result = await scout(ctx, {});
    assert.equal(result.ok, false);
    assert.equal(result.failure?.tag, 'network_connection');
    assert.equal(result.failure?.owner, 'system');
    assert.doesNotMatch(JSON.stringify({ result, messages }), /probe-user|probe-secret|多半是当前代理/);
    assert.match(result.failure!.nextAction!, /系统|稍后/);
    assert.ok(result.failure!.tried!.length >= 2);
  } finally {
    await closeNetwork(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), 'easy-workflow-network-ownership-')));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
