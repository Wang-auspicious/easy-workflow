import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-business-integration-'));
process.env.FACTORY_VAR = dir; process.env.FACTORY_HTTP_CACHE = '0'; process.env.VISLEXICON_ROOT = path.join(dir, 'rules');
const vocabulary = path.join(process.env.VISLEXICON_ROOT, 'VisLexicon-browser-design-kit/frontend/public/spec/v1');
fs.mkdirSync(vocabulary, { recursive: true }); fs.writeFileSync(path.join(vocabulary, 'vocab.json'), JSON.stringify({ styles: [], componentTypes: ['button'] }));
const { Runtime } = await import('../server/runtime.ts');
const { Journal } = await import('../server/journal.ts');
const { Broker } = await import('../server/broker.ts');
const { EvidenceStore } = await import('../server/evidence.ts');
const { compile } = await import('../server/spec/compile.ts');
const { pack } = await import('../packs/vislexicon/pack.ts');
const { COMPONENT_TOOLS, componentAgents } = await import('../packs/vislexicon/components.ts');
const { MEDIA_TOOLS, mediaAgents } = await import('../packs/vislexicon/media-lines.ts');
const { publishBusiness } = await import('../packs/vislexicon/business-common.ts');
const { closeBrowser } = await import('../server/browser.ts');
const { closeNetwork } = await import('../server/network.ts');
import type { StationContext } from '../server/runtime.ts';
import type { Services } from '../packs/vislexicon/tools.ts';
import type { Stamped } from '../shared/types.ts';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const original = Buffer.from('\uFEFF# Fixture Skill\r\n\r\nLicense: MIT\r\nAuthor: Integration Fixture\r\nKeep these bytes unchanged.\r\n');
let base = '';
const fixture = http.createServer((request, response) => {
  if (request.url === '/SKILL.md') { response.setHeader('content-type', 'text/markdown'); response.end(original); return; }
  for (const [url, file, type] of [['/image.png', 'original.png', 'image/png'], ['/deck.pdf', 'original.pdf', 'application/pdf'], ['/deck.pptx', 'original.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']]) {
    if (request.url === url) { response.setHeader('content-type', type); response.end(fs.readFileSync(path.join(dir, file))); return; }
  }
  if (request.url === '/sitemap.xml') { response.setHeader('content-type', 'application/xml'); response.end(`<urlset><url><loc>${base}/components/button</loc></url></urlset>`); return; }
  if (request.url === '/llms.txt') { response.end(`[Button](${base}/components/button)`); return; }
  if (request.url === '/registry.json') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ items: [{ name: 'Fixture button', url: `${base}/components/button` }] })); return; }
  response.setHeader('content-type', 'text/html');
  response.end('<!doctype html><title>Fixture component</title><main><h1>Button example</h1><a href="/components/button">Button component</a><div data-component-preview class="preview" style="width:600px;height:320px;background:#d6e8ff;display:grid;place-items:center"><svg width="520" height="200"><rect x="20" y="20" width="180" height="130" fill="#397aef"/><circle cx="360" cy="90" r="70" fill="#d64245"/><text x="55" y="90" fill="white" font-size="28">Open</text></svg></div></main>');
});
before(async () => {
  const code = "from PIL import Image,ImageDraw; import fitz; from pptx import Presentation; import sys; from pathlib import Path\np=Path(sys.argv[1]); im=Image.new('RGB',(320,180),'#fff'); d=ImageDraw.Draw(im); d.rectangle((10,10,170,150),fill='#2577d0'); d.ellipse((160,20,300,160),fill='#e04d4d'); im.save(p/'original.png')\ndoc=fitz.open()\nfor i in range(2):\n page=doc.new_page(width=640,height=360); page.insert_text((40,80),'Fixture slide '+str(i+1),fontsize=32); page.draw_rect(fitz.Rect(40,120,350,250),color=(.1,.4,.8),fill=(.2,.5,.9))\ndoc.save(p/'original.pdf'); doc.close()\nr=Presentation()\nfor i in range(2):\n s=r.slides.add_slide(r.slide_layouts[1]); s.shapes.title.text='Fixture slide '+str(i+1); s.placeholders[1].text='Native presentation rendering fixture'\nr.save(p/'original.pptx')";
  execFileSync(process.env.FACTORY_PYTHON ?? 'python', ['-I', '-c', code, dir], { windowsHide: true, timeout: 30000 });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
});
after(async () => {
  await closeBrowser(); await closeNetwork(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true });
});

async function executeLine(line: string, data: Record<string, unknown>, options: { fixOnce?: boolean; fixField?: string; missingOriginalFile?: boolean; reject?: boolean } = {}) {
  const journal = new Journal(':memory:'), store = new EvidenceStore(path.join(dir, 'evidence'));
  const services: Services = { store, workDir: path.join(dir, 'work'), publishDir: path.join(dir, 'published'), inFlight: () => new Set<string>() };
  const definitions = { ...componentAgents(services), ...mediaAgents(services) }, tools = { ...COMPONENT_TOOLS, ...MEDIA_TOOLS };
  const counts: Record<string, number> = {};
  const runtime = new Runtime(compile([pack]), journal, new Broker({ cpu: 2, browser: 1, model: 3, http: 2 }, 0), pack.conditions, node => {
    if (node.tool && tools[node.tool]) return ctx => { counts[node.key] = (counts[node.key] ?? 0) + 1; return tools[node.tool!](ctx, services); };
    const definition = definitions[node.key]; if (!definition) return null;
    return async ctx => {
      counts[node.key] = (counts[node.key] ?? 0) + 1;
      if (node.kind === 'review' && counts[node.key] === 1 && options.missingOriginalFile) {
        fs.unlinkSync(services.store.resolve((ctx.token.data.mediaOriginal as { src: string }).src)!);
      }
      await definition.input(ctx);
      const problem = 'Clarify the fixture description without changing the original bytes.';
      const output = node.kind === 'review' ? { verdict: options.reject || options.fixOnce && counts[node.key] === 1 ? 'fix' : 'pass', reason: 'Fixture independent review', problems: options.reject || options.fixOnce && counts[node.key] === 1 ? line === 'components' || line === 'atlas-feed' ? [problem] : [{ field: options.fixField ?? 'intro', problem }] : [] }
        : node.key === 'components/describe' ? { items: (ctx.token.data.componentCaptures as any[]).map(item => ({ id: item.id, type: 'button', descriptionZh: '蓝色按钮与红色圆形的真实演示舞台', interaction: '可见按钮示例' })) }
          : { text: 'Fixture source and limitations are described from the preserved original artifact.', sources: [base], limitations: ['Fixture only; original bytes remain unchanged.'] };
      const issues = definition.check?.(output, ctx) ?? []; assert.deepEqual(issues, []);
      return definition.after(output, ctx, { rounds: 1, issues: [] });
    };
  });
  runtime.ensureWorkers([]); runtime.start(`business ${line}`);
  const token = runtime.create(`${line}/inbox`, { item: `${line}-${options.reject ? 'reject' : 'fixture'}`, url: `${base}/${line === 'skills' ? 'SKILL.md' : line === 'ppt' ? data.file ?? 'deck.pdf' : ''}`, source: 'fixture', data: { express: true, ...data } });
  try {
    await runtime.settle();
    const finished = [...journal.read()].filter((event): event is Extract<Stamped, { kind: 'token.finished' }> => event.kind === 'token.finished' && event.token === token.id).at(-1);
    return { token, finished, counts, services, events: [...journal.read()] };
  } finally { await runtime.close(); journal.close(); }
}

test('Skills runs through the real program and review-repair route while retaining original bytes', { timeout: 30000 }, async () => {
  const result = await executeLine('skills', {}, { fixOnce: true });
  assert.equal(result.finished?.status, 'published');
  const saved = result.services.store.resolve((result.token.data.mediaOriginal as any).src)!;
  assert.deepEqual(fs.readFileSync(saved), original); assert.equal(result.counts['skills/fetch-file'], 1);
  assert.equal(result.counts['skills/intro'], 2); assert.equal(result.counts['skills/skill-review'], 2);
});

test('Skills provenance repair returns to its owner and rebuilds its dependent introduction', { timeout: 30000 }, async () => {
  const result = await executeLine('skills', {}, { fixOnce: true, fixField: 'provenance.license' });
  assert.equal(result.finished?.status, 'published', result.finished?.reason ?? 'No final result');
  assert.equal(result.counts['skills/fetch-file'], 1);
  assert.equal(result.counts['skills/provenance'], 2); assert.equal(result.counts['skills/intro'], 2);
  const consult = result.events.find(event => event.kind === 'consult.opened');
  assert.equal(consult?.kind === 'consult.opened' && consult.owner, 'skills/provenance');
});

test('a missing original is repaired by refetching its bytes before dependent media steps are rerun', { timeout: 30000 }, async () => {
  const result = await executeLine('skills', {}, { fixOnce: true, fixField: 'original.src', missingOriginalFile: true });
  assert.equal(result.finished?.status, 'published', result.finished?.reason ?? 'No final result');
  assert.equal(result.counts['skills/fetch-file'], 2);
  assert.equal(result.counts['skills/provenance'], 2); assert.equal(result.counts['skills/intro'], 2);
  assert.equal(result.counts['skills/skill-review'], 2);
  assert.deepEqual(fs.readFileSync(result.services.store.resolve((result.token.data.mediaOriginal as { src: string }).src)!), original);
  const consult = result.events.find(event => event.kind === 'consult.opened');
  assert.equal(consult?.kind === 'consult.opened' && consult.owner, 'skills/fetch-file');
});

test('scientific figures execute Python with supplied points and preserve reproducible artifacts', { timeout: 30000 }, async () => {
  const result = await executeLine('sci-figure', { figure: { kind: 'line', series: [{ x: [1, 2, 3], y: [2, 5, 4], label: 'Provided data' }], xLabel: 'x', yLabel: 'y', seed: 7 } });
  assert.equal(result.finished?.status, 'published');
  const run = result.token.data.figureRun as any; assert.equal(run.points, 3); assert.equal(run.seed, 7);
  assert.ok(fs.existsSync(result.services.store.resolve(run.code)!)); assert.ok(fs.existsSync(result.services.store.resolve(run.pdf)!));
  assert.ok(fs.existsSync(result.services.store.resolve((result.token.data.figurePreview as any).src)!));
});

test('image processing executes a real before/after operation and keeps the input byte-for-byte', { timeout: 30000 }, async () => {
  const result = await executeLine('image-fx', { effect: { kind: 'grayscale', imageUrl: `${base}/image.png` } });
  assert.equal(result.finished?.status, 'published');
  const originalAsset = result.token.data.mediaOriginal as any, run = result.token.data.effectRun as any;
  assert.equal(sha(fs.readFileSync(result.services.store.resolve(originalAsset.src)!)), sha(fs.readFileSync(path.join(dir, 'original.png'))));
  assert.notEqual(run.before.sha256, run.after.sha256); assert.deepEqual(run.inputSize, [320, 180]);
});

test('PDF decks render every original page without replacing the source file', { timeout: 30000 }, async () => {
  const result = await executeLine('ppt', { file: 'deck.pdf' });
  assert.equal(result.finished?.status, 'published'); assert.equal((result.token.data.deckPreview as any).pageCount, 2);
  assert.equal((result.token.data.deckPreview as any).pages.length, 2);
  assert.deepEqual(fs.readFileSync(result.services.store.resolve((result.token.data.mediaOriginal as any).src)!), fs.readFileSync(path.join(dir, 'original.pdf')));
});

test('PPTX decks render all original slides through an installed native renderer', { timeout: 150000 }, async () => {
  const result = await executeLine('ppt', { file: 'deck.pptx' });
  assert.equal(result.finished?.status, 'published', result.finished?.reason ?? 'No final result');
  assert.equal((result.token.data.deckPreview as any).pageCount, 2);
  assert.deepEqual(fs.readFileSync(result.services.store.resolve((result.token.data.mediaOriginal as any).src)!), fs.readFileSync(path.join(dir, 'original.pptx')));
});

test('cancelled business work cannot leave a published artifact on disk', () => {
  const store = new EvidenceStore(path.join(dir, 'cancelled-evidence')), controller = new AbortController(); controller.abort();
  const services: Services = { store, workDir: path.join(dir, 'cancelled-work'), publishDir: path.join(dir, 'cancelled-published'), inFlight: () => new Set<string>() };
  const ctx = { token: { id: 'cancelled', item: 'cancelled', url: base }, signal: controller.signal, addEvidence: () => { controller.signal.throwIfAborted(); return {} as never; } } as unknown as StationContext;
  assert.throws(() => publishBusiness(ctx, services, 'skills', { original: 'fixture' }));
  const folder = path.join(services.publishDir, 'business', 'skills');
  assert.equal(fs.existsSync(folder) ? fs.readdirSync(folder).filter(name => name.endsWith('.json')).length : 0, 0);
});

test('components and atlas use real isolated browser evidence and persistent reviewed deltas', { timeout: 60000 }, async () => {
  const components = await executeLine('components', { canonical: base, componentUrls: [`${base}/components/button`] }, { fixOnce: true });
  assert.equal(components.finished?.status, 'published', components.finished?.reason ?? 'No final result');
  assert.equal((components.token.data.componentInstances as any[]).length, 1);
  assert.equal(components.counts['components/stage'], 1); assert.equal(components.counts['components/describe'], 2);
  const atlas = await executeLine('atlas-feed', { componentInstances: components.token.data.componentInstances });
  assert.equal(atlas.finished?.status, 'published');
  assert.equal((atlas.token.data.atlasDelta as any).added.length, 1);
  const index = JSON.parse(fs.readFileSync(path.join(atlas.services.publishDir, 'business/atlas-feed/index.json'), 'utf8'));
  assert.equal(Object.keys(index.types.button).length, 1);
  const rejected = await executeLine('atlas-feed', { componentInstances: [{ ...(components.token.data.componentInstances as any[])[0], id: 'unaccepted-new-id' }] }, { reject: true });
  assert.notEqual(rejected.finished?.status, 'published');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(atlas.services.publishDir, 'business/atlas-feed/index.json'), 'utf8')).types.button).length, 1);
});
