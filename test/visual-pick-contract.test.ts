import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import type { StationContext } from '../server/runtime.ts';

test('a positive screenshot verdict with index zero is repaired rather than silently turned into rejection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-visual-contract-'));
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.FACTORY_VAR = root;
  process.env.VISLEXICON_ROOT = path.join(root, 'unconnected');
  let calls = 0;
  const model = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain request */ }
    const args = { index: ++calls === 1 ? 0 : 1, basis: 'rendered-items', reason: 'The image clearly shows multiple items.' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'pick', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant', tool_calls: [{ index: 0, id: `pick-${calls}`, type: 'function', function: { name: 'submit', arguments: JSON.stringify(args) } }] });
    send({}, 'tool_calls'); res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const port = (model.address() as { port: number }).port;
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
  fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'test-only' } }));
  fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: 'fixture', input: ['text','image'] }] } } }));
  const shot = path.join(root, 'image.png');
  execFileSync('ffmpeg', ['-loglevel','error','-f','lavfi','-i','color=c=blue:s=32x32','-frames:v','1',shot], { windowsHide: true });
  const { pickByImages } = await import('../server/agent-station.ts');
  const { closeModelTransport } = await import('../server/pi.ts');
  try {
    const ctx = { node: { key: 'curation/breadth' }, attempt: 'test-pick', worker: { id: 'test' }, signal: new AbortController().signal, progress() {} } as unknown as StationContext;
    const picked = await pickByImages(ctx, 'Pick image 1 if it shows items; index 0 means none.', [{ file: shot, label: '/gallery' }]);
    assert.equal(picked?.index, 0, 'the selected first image should remain selected (internal index zero)');
    assert.equal(picked?.basis, 'rendered-items');
    assert.equal(calls, 2, 'inconsistent output must receive feedback before rejecting the site');
  } finally { await closeModelTransport(); await new Promise<void>(resolve => model.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
});
