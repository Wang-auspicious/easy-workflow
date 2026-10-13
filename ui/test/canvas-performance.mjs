// Spec A8 / N5: 500 real runtime tokens, 20 executing program stations, real Chrome frames.
// Isolated synthetic workload for performance only; no model or production-data claim.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { liveApp } from './live-app.mjs';

const app = await liveApp('canvas-performance');
const out = path.join(app.root, 'var/verification/canvas-performance');
await fs.mkdir(out, { recursive: true });
let page, cdp;
const errors = [], packs = [], phases = [];
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const quantile = (values, part) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * part))] ?? 0;
try {
  for (let line = 0; line < 4; line++) {
    const id = `perf-${line}`, bindings = {}, stations = [], edges = [];
    const schema = { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false };
    const files = { 'tools/step.mjs': "import { setTimeout } from 'node:timers/promises'; export async function execute(input, context) { await setTimeout(400, undefined, { signal: context.signal }); context.progress('已处理真实输入 ' + input.text); return { text: input.text }; }" };
    for (let index = 0; index < 5; index++) {
      const station = `step-${index}`, role = `roles/${station}/ROLE.md`;
      stations.push({ id: station, name: `程序 ${line + 1}.${index + 1}`, kind: 'program', role: 'process', resource: 'none', input: 'text', output: 'text', rules: [], accept: ['原样传递用户输入；取消必须终止等待'], estimateSeconds: 0.4, workers: { min: 1, max: 1, initial: 1, policy: 'fixed' } });
      files[role] = '# Performance acceptance program\n\nRead the real supplied text, wait 400ms with cancellation support, then return exactly the original text. This isolated workload measures UI event handling; it does not represent production output or model quality.';
      bindings[`${id}/${station}`] = { role, inputSchema: 'text', outputSchema: 'text', input: { text: { path: index ? `step${index - 1}.text` : 'input.text' } }, outputKey: `step${index}`, execute: { kind: 'node', module: 'tools/step.mjs' } };
      if (index) edges.push({ from: `step-${index - 1}`, to: station });
    }
    stations.push({ id: 'done', name: '验收完成', kind: 'store', role: 'store', resource: 'none', input: 'text', output: 'text', rules: [], accept: [], estimateSeconds: 0, workers: { min: 0, max: 0, initial: 0, policy: 'fixed' } });
    edges.push({ from: 'step-4', to: 'done' });
    const manifest = { format: 1, id, name: `性能验收线 ${line + 1}`, version: '1.0.0', blurb: '隔离性能工作负载', entry: `${id}/step-0`, inputSchema: 'text',
      lines: [{ id, name: `性能验收线 ${line + 1}`, layer: 3, priority: 'mid', blurb: '125 个真实令牌经过 5 个程序工位', wired: true, stations, edges }],
      channels: [], links: [], resources: { model: 0, browser: 0, cpu: 0, http: 0 }, schemas: { text: schema }, bindings, conditions: {} };
    await app.request('/api/workflows/install', { manifest, files, builtins: [] }); packs.push(manifest);
    await app.request('/api/run', { action: 'pause', line: id, reason: 'Accumulate the full 500-token acceptance workload before measuring' });
  }
  await app.request('/api/run', { action: 'start', title: 'A8 isolated 500-token / 20-station acceptance' });
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < 500) { const index = next++; await app.request('/api/workflows/feed', { packId: packs[index % 4].id, item: `performance-${index}`, input: { text: `acceptance input ${index}` } }); }
  }));
  const initial = await app.request('/api/state');
  assert.equal(initial.tokenOrder.length, 500); assert.equal(Object.keys(initial.attempts).length, 0);
  const compiled = (await app.request('/api/factory')).factory;
  assert.equal(compiled.nodes.filter(node => node.kind === 'program').length, 20);
  page = await app.browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem('pf.chatOpen', 'false'); localStorage.setItem('pf.view', JSON.stringify('canvas')); });
  await page.goto(app.url); await page.locator('.rail-conn.is-on').waitFor();
  await page.getByRole('button', { name: '全图', exact: true }).click();
  assert.equal(await page.locator('[data-node]').count(), 24);
  await pause(600);
  await page.evaluate(async () => {
    const store = await import('/src/store.ts');
    const data = window.canvasPerformance = { current: null, phases: [], latency: [], longTasks: [], getState: store.getState, live: true };
    const tick = now => {
      const phase = data.current;
      if (phase) { if (phase.last !== null) phase.frames.push(now - phase.last); phase.last = now; }
      if (data.live) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      new PerformanceObserver(entries => { for (const entry of entries.getEntries()) data.longTasks.push({ start: entry.startTime, duration: entry.duration }); }).observe({ type: 'longtask', buffered: false });
    }
    let pending = [], frame = 0;
    data.unsubscribe = store.onEvent(event => {
      if (!data.current || !['token.queued', 'attempt.started', 'attempt.finished'].includes(event.kind)) return;
      pending.push({ seq: event.seq, at: event.at, kind: event.kind });
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0; const at = Date.now(), projection = store.getState().fs;
        for (const event of pending) data.latency.push({ ...event, milliseconds: at - event.at, projected: projection.seq >= event.seq });
        pending = [];
      });
    });
  });
  cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing,toplevel,disabled-by-default-devtools.timeline.frame', transferMode: 'ReturnAsStream' });
  const before = await cdp.send('Performance.getMetrics');
  await Promise.all(packs.map(pack => app.request('/api/run', { action: 'resume', line: pack.id, reason: 'Measure sustained real execution' })));
  await pause(2200);

  const measure = async (name, interaction) => {
    await page.evaluate(name => { const data = window.canvasPerformance; data.current = { name, frames: [], last: null, start: performance.now() }; performance.mark(`A8:${name}:start`); }, name);
    await interaction();
    const phase = await page.evaluate(() => { const data = window.canvasPerformance, phase = data.current; phase.end = performance.now(); performance.mark(`A8:${phase.name}:end`); data.phases.push(phase); data.current = null; return phase; });
    const duration = phase.frames.reduce((sum, frame) => sum + frame, 0);
    phases.push({ ...phase, fps: phase.frames.length * 1000 / duration, p95FrameMs: quantile(phase.frames, 0.95), slowFrames: phase.frames.filter(frame => frame > 34).length });
    await page.screenshot({ path: path.join(out, `${name}.png`) });
  };
  await measure('live-flow', () => pause(5000));
  const box = await page.locator('.cv').boundingBox();
  await measure('pan', async () => {
    const x = box.x + box.width - 100, y = box.y + box.height - 130;
    await page.mouse.move(x, y); await page.mouse.down({ button: 'middle' });
    for (let step = 0; step < 180; step++) { await page.mouse.move(x + Math.sin(step / 18) * 140, y + Math.cos(step / 25) * 70); await pause(24); }
    await page.mouse.up({ button: 'middle' });
  });
  await page.getByRole('button', { name: '全图', exact: true }).click(); await pause(500);
  await measure('zoom', async () => {
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.55);
    for (let step = 0; step < 50; step++) { await page.mouse.wheel(0, step % 20 < 10 ? -36 : 36); await pause(80); }
  });
  await page.getByRole('button', { name: '全图', exact: true }).click(); await pause(500);
  const node = page.locator('[data-node="perf-0/step-2"]'), rect = await node.boundingBox();
  await measure('station-drag', async () => {
    const x = rect.x + rect.width / 2, y = rect.y + 15;
    await page.mouse.move(x, y); await page.mouse.down();
    for (let step = 0; step < 180; step++) { await page.mouse.move(x + Math.sin(step / 20) * 85, y + Math.cos(step / 28) * 45); await pause(24); }
    await page.mouse.up();
  });
  const after = await cdp.send('Performance.getMetrics');
  const data = await page.evaluate(() => { const data = window.canvasPerformance; data.live = false; data.unsubscribe(); return { latency: data.latency, longTasks: data.longTasks, tokens: data.getState().fs.tokenOrder.length, attempts: Object.keys(data.getState().fs.attempts).length }; });
  const tracing = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end'); const { stream } = await tracing;
  const trace = [];
  for (;;) { const chunk = await cdp.send('IO.read', { handle: stream }); trace.push(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data)); if (chunk.eof) break; }
  await cdp.send('IO.close', { handle: stream });
  await fs.writeFile(path.join(out, 'chrome-performance-trace.json'), Buffer.concat(trace));
  const measurements = { at: new Date().toISOString(), description: 'Real isolated HTTP runtime and Chrome UI; 500 synthetic input tokens, 20 program workers plus 4 stores. No production data or model workload.', viewport: { width: 1440, height: 900 },
    browser: app.browser.version(), phases, latency: { samples: data.latency.length, p95Ms: quantile(data.latency.map(event => event.milliseconds), 0.95), maxMs: Math.max(0, ...data.latency.map(event => event.milliseconds)), allProjected: data.latency.every(event => event.projected) },
    longTasks: data.longTasks, totals: { tokens: data.tokens, attempts: data.attempts }, before, after, errors };
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(measurements, null, 2));
  console.log(JSON.stringify({ phases: phases.map(({ name, fps, p95FrameMs, slowFrames }) => ({ name, fps, p95FrameMs, slowFrames })), latency: measurements.latency, longTasks: data.longTasks.length, totals: measurements.totals, errors, out }, null, 2));
  assert.equal(data.tokens, 500); assert.ok(data.attempts >= 100);
  assert.deepEqual(errors, []);
  for (const phase of phases) assert.ok(phase.fps >= 50, `${phase.name}: ${phase.fps.toFixed(1)}fps < 50fps`);
  assert.ok(measurements.latency.samples > 100 && measurements.latency.allProjected);
  assert.ok(measurements.latency.maxMs <= 300, `event-to-frame maximum ${measurements.latency.maxMs}ms > 300ms`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(out, 'failure.png') });
  await fs.writeFile(path.join(out, 'backend.log'), app.logs());
  throw error;
} finally { await app.close(); }
