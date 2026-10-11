// Exercise the real dashboard with isolated layout writes: no jobs, model calls or journal changes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { layoutFactory } from '../shared/layout.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const base = process.argv.find(a => a.startsWith('--url='))?.slice(6) ?? process.env.CANVAS_URL ?? 'http://127.0.0.1:5317';
const out = path.resolve('var/verification');
await fs.mkdir(out, { recursive: true });
const snapshot = await fetch(`${base}/api/factory`).then(r => r.json());
snapshot.defaultLayout = layoutFactory(snapshot.factory.nodes, snapshot.factory.edges, snapshot.factory.ui.order, snapshot.factory.ui.hints, snapshot.factory.ui.collapsed);
snapshot.layout = { pos: {}, open: {}, capsules: {}, colors: {}, bots: {} };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const results = [];
async function endpointErrors(page) {
  return page.evaluate(() => {
    const result = [];
    const locate = (key) => [...document.querySelectorAll('[data-node], [data-capsule]')].find(e => e.dataset.node === key || `capsule:${e.dataset.capsule}` === key);
    for (const edge of document.querySelectorAll('[data-edge]')) {
      const path = edge.querySelector('.edge-line');
      for (const [key, length] of [[edge.dataset.from, 0], [edge.dataset.to, path.getTotalLength()]]) {
        const node = locate(key);
        if (!node) { result.push(`missing visible endpoint ${key}`); continue; }
        const p = path.getPointAtLength(length), screen = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()), r = node.getBoundingClientRect();
        const near = screen.x >= r.left - 1.6 && screen.x <= r.right + 1.6 && screen.y >= r.top - 1.6 && screen.y <= r.bottom + 1.6;
        const border = Math.min(Math.abs(screen.x - r.left), Math.abs(screen.x - r.right), Math.abs(screen.y - r.top), Math.abs(screen.y - r.bottom)) <= 1.6;
        if (!near || !border) result.push(`detached ${edge.dataset.edge}: ${key}`);
      }
    }
    return [...new Set(result)];
  });
}
try {
  for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.route('**/api/factory', route => route.fulfill({ json: snapshot }));
    await page.route('**/api/layout', route => route.fulfill({ json: { ok: true } }));
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.waitForSelector('[data-node]');
    await page.waitForTimeout(700);
    const metrics = await page.evaluate(() => {
      const matrix = new DOMMatrix(getComputedStyle(document.querySelector('.cv-world')).transform);
      const canvas = document.querySelector('.cv').getBoundingClientRect();
      const nodes = [...document.querySelectorAll('[data-node], [data-capsule]')];
      return {
        canvasHeight: canvas.height, viewportHeight: innerHeight,
        zoom: matrix.a,
        titlePx: Math.min(...[...document.querySelectorAll('.node-name')].map(e => parseFloat(getComputedStyle(e).fontSize) * matrix.a)),
        bodyPx: Math.min(...[...document.querySelectorAll('.node-row')].map(e => parseFloat(getComputedStyle(e).fontSize) * matrix.a)),
        clipped: nodes.filter(e => { const r = e.getBoundingClientRect(); return r.left < canvas.left - 1 || r.right > canvas.right + 1 || r.top < canvas.top - 1 || r.bottom > canvas.bottom + 1; }).map(e => e.dataset.node ?? e.dataset.capsule),
      };
    });
    await page.screenshot({ path: path.join(out, `canvas-${width}.png`) });
    const failures = [];
    if (metrics.canvasHeight > height + 1) failures.push(`canvas extends below window: ${metrics.canvasHeight} > ${height}`);
    if (metrics.titlePx < 13.5) failures.push(`titles only ${metrics.titlePx.toFixed(2)}px (need ≥13.5)`);
    if (metrics.bodyPx < 11.5) failures.push(`counters only ${metrics.bodyPx.toFixed(2)}px (need ≥11.5)`);
    if (metrics.clipped.length) failures.push(`clipped: ${metrics.clipped.join(', ')}`);
    if (errors.length) failures.push(...errors);
    failures.push(...await endpointErrors(page));
    // A collapsed line must visibly move during pointermove, not jump only on pointerup.
    const capsule = page.locator('[data-capsule]').first();
    const before = await capsule.boundingBox();
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 - 52, before.y + before.height / 2 - 36, { steps: 8 });
    const during = await capsule.boundingBox();
    if (Math.abs((during.x - before.x) + 52) > 2 || Math.abs((during.y - before.y) + 36) > 2) failures.push(`capsule does not follow drag: dx=${(during.x - before.x).toFixed(1)}, dy=${(during.y - before.y).toFixed(1)}`);
    await page.mouse.up();
    failures.push(...await endpointErrors(page));
    const station = page.locator('[data-node="curation/identity"]');
    const stationBefore = await station.boundingBox();
    await page.mouse.move(stationBefore.x + 20, stationBefore.y + 15);
    await page.mouse.down();
    await page.mouse.move(stationBefore.x + 48, stationBefore.y + 45, { steps: 8 });
    const stationDuring = await station.boundingBox();
    if (Math.abs(stationDuring.x - stationBefore.x - 28) > 2 || Math.abs(stationDuring.y - stationBefore.y - 30) > 2) failures.push('station does not follow live dragging');
    failures.push(...await endpointErrors(page));
    await page.mouse.up();
    const stationAfter = await station.boundingBox();
    if (Math.abs(stationAfter.x - stationDuring.x) > 2 || Math.abs(stationAfter.y - stationDuring.y) > 2) failures.push('station jumps on release');
    // Cancelled pointer input returns to the saved position and removes drag listeners.
    await page.mouse.move(stationAfter.x + 20, stationAfter.y + 15);
    await page.mouse.down();
    await page.mouse.move(stationAfter.x + 38, stationAfter.y + 32, { steps: 4 });
    await page.locator('.cv').dispatchEvent('pointercancel', { bubbles: true, pointerId: 1 });
    await page.mouse.up();
    const cancelled = await station.boundingBox();
    if (Math.abs(cancelled.x - stationAfter.x) > 2 || Math.abs(cancelled.y - stationAfter.y) > 2) failures.push('cancelled drag was committed');
    await page.mouse.move(10, 10);
    await page.keyboard.press('f');
    await page.waitForTimeout(500);
    failures.push(...await endpointErrors(page));
    results.push({ viewport: [width, height], ...metrics, failures });
    await page.close();
  }
  await fs.writeFile(path.join(out, 'canvas-check.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  assert.equal(results.flatMap(r => r.failures).length, 0, 'Canvas must be readable and follow dragging at normal window sizes');
} finally {
  await browser.close();
}
