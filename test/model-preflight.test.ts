import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { checkModelEndpoint } from '../server/preflight.ts';
import { closeModelTransport } from '../server/pi.ts';
import { closeNetwork } from '../server/network.ts';

test('model preflight tests authenticated inference, not a healthy public base URL', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-model-check-'));
  const keys = ['PI_CODING_AGENT_DIR', 'FACTORY_PROVIDER', 'FACTORY_MODEL'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let mode = 'unauthorized', getCalls = 0, inferenceCalls = 0, activeKey = 'preflight-fixture-only';
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') { getCalls++; res.writeHead(200); res.end('Healthy gateway'); return; }
    inferenceCalls++;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    assert.equal(req.headers.authorization, `Bearer ${activeKey}`);
    if (mode === 'unauthorized') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `Invalid API key: ${activeKey}`, type: 'authentication_error' } })); return; }
    if (mode === 'hang') return;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const delta of [{ choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }]) res.write(`data: ${JSON.stringify({ id: 'probe', model: 'fixture', ...delta })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  process.env.PI_CODING_AGENT_DIR = dir; process.env.FACTORY_PROVIDER = 'fixture'; process.env.FACTORY_MODEL = 'fixture';
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'preflight-fixture-only' } }));
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: 'fixture', input: ['text'] }] } } }));
  try {
    await t.test('rejects unusable credentials and does not expose the provider-echoed key', async () => {
      const result = await checkModelEndpoint(5000);
      assert.equal(result.ok, false);
      assert.ok(!JSON.stringify(result).includes('preflight-fixture-only'));
      assert.equal(inferenceCalls, 1); assert.equal(getCalls, 0);
    });
    await t.test('accepts an actual inference with a small bounded output budget', async () => {
      mode = 'success';
      const result = await checkModelEndpoint(5000);
      assert.equal(result.ok, true, result.detail);
      const outputLimit = requests.at(-1).max_tokens ?? requests.at(-1).max_completion_tokens;
      assert.ok(outputLimit > 0 && outputLimit <= 128);
      assert.equal(inferenceCalls, 2); assert.equal(getCalls, 0);
    });
    await t.test('a stalled model is aborted within the check deadline', async () => {
      mode = 'hang'; const start = Date.now();
      const result = await checkModelEndpoint(500);
      assert.equal(result.ok, false);
      assert.ok(Date.now() - start < 4000);
      assert.equal(inferenceCalls, 3);
    });
    await t.test('provider errors cannot leak a credential through JSON escaping', async () => {
      mode = 'unauthorized'; activeKey = 'fixture"escaped\\key';
      fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: activeKey } }));
      const result = await checkModelEndpoint(5000);
      assert.equal(result.ok, false);
      assert.ok(!result.detail.includes(activeKey));
      assert.ok(!result.detail.includes(JSON.stringify(activeKey).slice(1, -1)));
      assert.match(result.detail, /\[redacted\]/);
    });
  } finally {
    await closeModelTransport(); await closeNetwork();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
