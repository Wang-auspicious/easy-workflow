import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import type { StationContext } from '../server/runtime.ts';
import { classifyFailure } from '../shared/failures.ts';

test('empty capture candidates keep the automatic page-selection recovery classification', () => {
  for (const role of ['目录', '特写']) {
    const failure = classifyFailure(`需要重新选页：交阅读员重新查找公开${role}页面`);
    assert.equal(failure.tag, 'needs_selection'); assert.equal(failure.owner, 'agent');
  }
});

test('proof follows quoted location text and keeps the intended viewport during reframe', { timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-proof-location-'));
  const previous = process.env.FACTORY_VAR; process.env.FACTORY_VAR = root;
  const heading = 'logo designs created with Example Logo Maker.';
  const locate = `页面中部：L2 标题「${heading}」下的成品 Logo 图墙，紧接文字「Join over 250,000 creators…」与「Make Your Logo with AI」按钮；需从首屏下滚。`;
  const fixture = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    const stage = req.url === '/stages';
    res.end(`<!doctype html><style>body{margin:0;font:22px sans-serif;background:white}h1,h2{margin:0 0 24px}#hero{height:1600px;padding:30px;box-sizing:border-box}#results{min-height:750px;padding:24px;box-sizing:border-box;position:relative}#results h2{max-width:800px}.tile{display:inline-block;width:220px;height:150px;margin:12px;background:#fff;border-radius:20px;border:6px solid #14213d}.mark{width:80px;height:80px;margin:20px;background:#fca311;border-radius:50%}#marker{position:absolute;right:0;top:0;width:120px;height:750px;background:rgb(23,131,79)}</style><main><section id="hero"><h1>Logo Maker</h1><p>Enter a business name.</p><div ${stage ? 'class="bd-example"' : ''} style="width:400px;height:220px;border:6px solid #14213d"><button>Generate</button><div style="display:flex;gap:20px"><div class="mark"></div><div class="mark" style="background:#e63946"></div></div></div></section><section id="results"><div id="marker"></div><h2><span>logo designs created</span><br><span>with Example Logo Maker.</span></h2><div ${stage ? 'class="bd-example"' : ''} style="width:1000px;height:500px">${'<div class="tile"><div class="mark"></div></div>'.repeat(6)}</div><p>Join over 250,000 creators.</p></section><section style="height:1000px">Tips</section></main>`);
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const { TOOLS } = await import('../packs/vislexicon/tools.ts');
  const { EvidenceStore } = await import('../server/evidence.ts');
  const { closeBrowser } = await import('../server/browser.ts');
  const svc = { store: new EvidenceStore(path.join(root, 'evidence')), workDir: path.join(root, 'work'), publishDir: path.join(root, 'published'), inFlight: () => new Set<string>() };
  const run = async (name: string, target: string | undefined, repair?: string, route = '/page') => {
    const messages: string[] = [];
    const url = base + route;
    const ctx = { token: { id: name, url: base, data: { kind: 'tool', host: '127.0.0.1', canonical: base, title: 'Logo fixture', readerPlan: target ? { proof: { url, locate: target } } : undefined, shotRepairs: repair ? { proof: { action: 'reframe', url, reason: repair } } : undefined } }, signal: new AbortController().signal, attempt: `a-${name}`, progress: (message: string) => messages.push(message), addEvidence: (e: unknown) => e } as unknown as StationContext;
    return { result: await TOOLS['curation.proof'](ctx, svc), messages };
  };
  try {
    await t.test('Chinese prose locates an English heading split across DOM nodes instead of silently photographing the hero', async () => {
      const { result, messages } = await run('reader', locate);
      assert.equal(result.ok, true, messages.join('\n'));
      const shot = (result.data!.shots as any).proof;
      const pixel = [...execFileSync('ffmpeg', ['-loglevel', 'error', '-i', shot.file, '-vf', 'crop=1:1:1200:180', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])];
      assert.deepEqual(pixel, [23, 131, 79], 'the screenshot must contain the specified results section, not the first screen');
      assert.match(messages.join('\n'), /定位/);
    });
    await t.test('a reviewer reframe instruction works without an old reader location', async () => {
      const { result, messages } = await run('reviewer', undefined, `请滚到 L2 标题「${heading}」处，把成品图墙收进画面。`);
      assert.equal(result.ok, true, messages.join('\n'));
      const shot = (result.data!.shots as any).proof;
      const pixel = [...execFileSync('ffmpeg', ['-loglevel', 'error', '-i', shot.file, '-vf', 'crop=1:1:1200:180', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])];
      assert.deepEqual(pixel, [23, 131, 79]);
    });
    await t.test('an explicit reviewer correction takes priority over an old but still matching reader target', async () => {
      const { result, messages } = await run('changed-target', '页面顶部 H1 标题「Logo Maker」下。', `改为「${heading}」下的成品图墙，旧首屏不要再拍。`);
      assert.equal(result.ok, true, messages.join('\n'));
      const shot = (result.data!.shots as any).proof;
      assert.equal(shot.location?.matched, heading);
      const pixel = [...execFileSync('ffmpeg', ['-loglevel', 'error', '-i', shot.file, '-vf', 'crop=1:1:1200:180', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])];
      assert.deepEqual(pixel, [23, 131, 79]);
    });
    await t.test('stage selection does not undo a successful location by returning to the hero', async () => {
      const { result } = await run('stage', locate, undefined, '/stages');
      assert.equal(result.ok, true);
      assert.match((result.data!.shots as any).proof.framing, /1000×500/);
    });
    await t.test('a missing quoted target is returned for page selection instead of accepting another hero', async () => {
      const { result } = await run('missing', '滚到标题「This heading does not exist」下的成品。');
      assert.equal(result.ok, false);
      assert.equal(result.failure?.tag, 'needs_selection');
      assert.equal(result.failure?.owner, 'agent');
    });
  } finally {
    await closeBrowser(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
    if (previous === undefined) delete process.env.FACTORY_VAR; else process.env.FACTORY_VAR = previous;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('easy-workflow-proof-location-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
