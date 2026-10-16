import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import type {Page} from 'playwright-core';
import type { StationContext } from '../server/runtime.ts';
import { classifyFailure } from '../shared/failures.ts';

test('empty capture candidates keep the automatic page-selection recovery classification', () => {
  for (const role of ['目录', '特写']) {
    const failure = classifyFailure(`需要重新选页：交阅读员重新查找公开${role}页面`);
    assert.equal(failure.tag, 'needs_selection'); assert.equal(failure.owner, 'agent');
  }
});

function readinessPage(mode: 'delayed' | 'translucent' | 'infinite' | 'hidden') {
  const started = Date.now();
  class Element {
    tagName = 'DIV'; id = ''; parentElement: Element | null = null;
    offsetLeft = 0; offsetTop = 100; offsetWidth = 900; offsetHeight = 500;
    isConnected = true;
    getBoundingClientRect() {return {x: mode === 'infinite' ? Math.sin(Date.now()) * 10 : 0,
      y: 100, left: 0, right: 900, top: 100, bottom: 600, width: 900, height: 500};}
    closest(selector: string) {return selector.includes('section') ? root : null;}
    querySelectorAll() {return [video];}
    getAnimations() {
      if (this !== root || mode === 'hidden' || mode === 'translucent') return [];
      const infinite = mode === 'infinite';
      return [{playState: infinite || Date.now() - started < 350 ? 'running' : 'finished', pending: false,
        currentTime: Date.now() - started, effect: {
          getComputedTiming: () => ({endTime: infinite ? Infinity : 350, iterations: infinite ? Infinity : 1}),
          getKeyframes: () => [{opacity: 0, transform: 'translateY(10px)'}, {opacity: 1, transform: 'none'}],
        }}];
    }
  }
  class Video extends Element {
    override tagName = 'VIDEO'; videoWidth = 320; videoHeight = 180; currentSrc = 'https://fixture.test/original.mp4';
    get readyState() {return mode === 'delayed' && Date.now() - started < 500 ? 1 : 2;}
    getVideoPlaybackQuality() {return {totalVideoFrames: this.readyState >= 2 ? 1 : 0};}
    getAttribute() {return null;}
  }
  const root = new Element(); root.id = 'original-section';
  const target = new Element(); target.id = 'proof-heading'; target.parentElement = root;
  const video = new Video(); video.id = 'original-video'; video.parentElement = root;
  const context = {document: {querySelectorAll: () => [target]}, innerWidth: 1280, innerHeight: 800,
    scrollX: 0, scrollY: 500, Date, CSS: {escape: (text: string) => text},
    HTMLImageElement: class {}, HTMLVideoElement: Video,
    getComputedStyle: (element: Element) => ({display: 'block', visibility: 'visible',
      opacity: element !== root ? '1' : mode === 'hidden' ? '0' : mode === 'translucent' ? '0.35' :
        mode === 'infinite' ? String(0.4 + (Date.now() % 100) / 200) : Date.now() - started < 350 ? '0.2' : '1'})};
  const page = {evaluate: async (fn: Function, argument: unknown) =>
    vm.runInNewContext(`(${fn.toString()})(argument)`, {...context, argument})} as unknown as Page;
  return page;
}

test('native proof readiness observes original ancestors/media, stays bounded and aborts without a browser', async t => {
  const {waitProofCaptureReady} = await import('../packs/vislexicon/capture.ts');
  const location = {matched: 'Original proof', anchors: ['Original proof'], selector: '#proof-heading'};
  await t.test('a child with opacity1 waits for its finite parent fade and delayed original video data', async () => {
    const result = await waitProofCaptureReady(readinessPage('delayed'), location, {timeoutMs: 2000});
    assert.equal(result.status, 'ready');
    assert.ok(result.elapsedMs >= 800 && result.elapsedMs < 2000);
    assert.ok(result.samples.some(sample => sample.finitePending > 0));
    assert.ok(result.samples.some(sample => sample.media.some(media => !media.ready)));
    assert.equal(result.samples.at(-1)!.finitePending, 0);
    assert.equal(result.samples.at(-1)!.media[0].ready, true);
  });
  for (const mode of ['translucent', 'infinite'] as const) await t.test(`${mode} original content does not require forced opacity or frozen pixels`, async () => {
    const result = await waitProofCaptureReady(readinessPage(mode), location, {timeoutMs: 1500});
    assert.equal(result.status, 'ready');
    assert.ok(result.elapsedMs < 1000);
  });
  await t.test('an invisible target times out normally with raw observations and no success', async () => {
    const result = await waitProofCaptureReady(readinessPage('hidden'), location, {timeoutMs: 35});
    assert.equal(result.status, 'timeout'); assert.equal(result.code, 'CAPTURE_NOT_READY');
    assert.ok(result.samples.length > 0); assert.equal(result.samples[0].visible, false);
  });
  await t.test('a stalled DOM read is cancelled promptly', async () => {
    const started = Date.now();
    const controller = new AbortController();
    const page = {evaluate: () => new Promise(() => {})} as unknown as Page;
    const timer = setTimeout(() => controller.abort(new DOMException('Stop capture', 'AbortError')), 20);
    try {
      await assert.rejects(waitProofCaptureReady(page, location, {signal: controller.signal}), /Stop capture/);
      assert.ok(Date.now() - started < 500, 'abort must not wait for the DOM read or20s budget');
    } finally {clearTimeout(timer);}
  });
  await t.test('a longer caller budget cannot extend the single20s bound', async subtest => {
    subtest.mock.timers.enable({apis: ['Date'], now: Date.now()});
    const observed = readinessPage('hidden');
    const evaluate = observed.evaluate.bind(observed);
    observed.evaluate = (async (...args: Parameters<Page['evaluate']>) => {
      const value = await evaluate(...args); subtest.mock.timers.tick(20001); return value;
    }) as Page['evaluate'];
    const result = await waitProofCaptureReady(observed, location, {timeoutMs: 60000});
    assert.equal(result.budgetMs, 20000); assert.equal(result.status, 'timeout');
  });
});

test('proof follows quoted location text and keeps the intended viewport during reframe', { timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-proof-location-'));
  const previous = process.env.FACTORY_VAR; process.env.FACTORY_VAR = root;
  const heading = 'logo designs created with Example Logo Maker.';
  const locate = `页面中部：L2 标题「${heading}」下的成品 Logo 图墙，紧接文字「Join over 250,000 creators…」与「Make Your Logo with AI」按钮；需从首屏下滚。`;
  const fixture = http.createServer((req, res) => {
    if (req.url === '/original-media.svg') {
      res.setHeader('content-type', 'image/svg+xml');
      setTimeout(() => res.end('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#214978"/></svg>'), 1700);
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/delayed') {
      res.end(`<!doctype html><style>body{margin:0;font:22px sans-serif;background:white}#hero{height:1600px}
        #results{height:800px;padding:24px;box-sizing:border-box;position:relative;opacity:0;transition:opacity .2s ease 1.2s}
        #results.revealed{opacity:1}#marker{position:absolute;right:0;top:0;width:120px;height:800px;background:rgb(23,131,79)}
        .tile{display:inline-block;width:220px;height:130px;margin:12px;border:6px solid #14213d;background:#fca311}
        h2{max-width:800px;margin:0 0 24px}</style><section id="hero"><h1>Original hero</h1></section>
        <section id="results"><div id="marker"></div><h2>${heading}</h2><img id="original-media" width="200" height="120" alt="Original fixture image">
        <div>${'<div class="tile"></div>'.repeat(6)}</div></section>
        <script>const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){
          document.querySelector('#results').classList.add('revealed');document.querySelector('#original-media').src='/original-media.svg';observer.disconnect();}});
          observer.observe(document.querySelector('#results'));</script>`);
      return;
    }
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
    await t.test('the original finite parent fade and lazy image finish before a located viewport is photographed', async () => {
      const {result} = await run('delayed-original', locate, undefined, '/delayed');
      assert.equal(result.ok, true);
      const shot = (result.data!.shots as any).proof;
      const pixel = [...execFileSync('ffmpeg', ['-loglevel', 'error', '-i', shot.file, '-vf', 'crop=1:1:1200:180',
        '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])];
      assert.deepEqual(pixel, [23, 131, 79], 'the retained original viewport must contain the opaque original result, not the earlier white frame');
      const observed = JSON.parse(fs.readFileSync(svc.store.resolve(shot.readiness.src)!, 'utf8'));
      assert.equal(observed.status, 'ready');
      assert.ok(observed.samples.some((sample: {finitePending: number}) => sample.finitePending > 0));
      assert.ok(observed.samples.some((sample: {media: {ready: boolean}[]}) => sample.media.some(media => !media.ready)));
      assert.equal(observed.samples.at(-1).media[0].ready, true);
      assert.equal(shot.captureState.viewport.width, 1280);
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
