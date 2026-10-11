// Verify the shipped Electron renderer against existing evidence, with an isolated layout.
import { _electron } from 'playwright-core';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-canvas-'));
const output = path.join(root, 'artifacts', 'desktop');
await fs.mkdir(output, { recursive: true });
const journal = path.join(root, 'var', 'journal.db');
const digest = async () => crypto.createHash('sha256').update(await fs.readFile(journal)).digest('hex');
const beforeJournal = await digest();
const env = { ...process.env, FACTORY_PROFILE: profile, FACTORY_VIEW_VAR: path.join(root, 'var'), FACTORY_DESKTOP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: path.join(root, 'release', 'EasyWorkflow-win32-x64', 'EasyWorkflow.exe'), args: [], env, timeout: 45000 });
const checks = [];
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.locator('[data-node]').first().waitFor();
  for (const [width, height] of [[1440, 900], [1366, 768]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await page.waitForTimeout(800);
    const metrics = await page.evaluate(() => {
      const cv = document.querySelector('.cv').getBoundingClientRect();
      const k = new DOMMatrix(getComputedStyle(document.querySelector('.cv-world')).transform).a;
      const nodes = [...document.querySelectorAll('[data-node], [data-capsule]')];
      return {
        width: innerWidth, height: innerHeight, canvasHeight: cv.height, zoom: k,
        title: Math.min(...[...document.querySelectorAll('.node-name')].map(e => parseFloat(getComputedStyle(e).fontSize) * k)),
        counter: Math.min(...[...document.querySelectorAll('.node-row')].map(e => parseFloat(getComputedStyle(e).fontSize) * k)),
        clipped: nodes.filter(e => { const r = e.getBoundingClientRect(); return r.left < cv.left || r.right > cv.right || r.top < 0 || r.bottom > innerHeight; }).map(e => e.dataset.node || e.dataset.capsule),
      };
    });
    console.log(JSON.stringify({ requested: [width, height], metrics }));
    assert.ok(metrics.title >= 13.5 && metrics.counter >= 11.5, 'readable text in the shipped app');
    // Windows display scaling may round a requested DIP size by one CSS pixel.
    assert.ok(Math.abs(metrics.height - height) <= 2 && Math.abs(metrics.width - width) <= 2);
    assert.ok(metrics.canvasHeight <= metrics.height);
    assert.deepEqual(metrics.clipped, []);
    await page.screenshot({ path: path.join(output, `final-evidence-${width}x${height}.png`) });
    checks.push(metrics);
  }
  const key = 'curation/classify';
  const node = page.locator(`[data-node="${key}"]`);
  const start = await node.boundingBox();
  await page.mouse.move(start.x + 20, start.y + 15);
  await page.mouse.down();
  await page.mouse.move(start.x + 52, start.y + 47, { steps: 12 });
  const moved = await node.boundingBox();
  assert.ok(Math.abs(moved.x - start.x - 32) < 2 && Math.abs(moved.y - start.y - 32) < 2);
  await page.mouse.up();
  const savedPosition = await node.evaluate(e => ({ x: e.style.left, y: e.style.top }));
  await page.waitForTimeout(700);
  await page.reload();
  await node.waitFor();
  assert.deepEqual(await node.evaluate(e => ({ x: e.style.left, y: e.style.top })), savedPosition, 'drag position survives renderer reload');
  checks.push('live station drag and persisted position verified');
  await page.locator('[data-capsule="components"]').click();
  await page.locator('[data-node="components/inbox"]').waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('[data-capsule="components"]').count(), 0);
  await page.locator('.line-cap').filter({ hasText: '组件入库线' }).locator('button').click();
  await page.locator('[data-capsule="components"]').waitFor();
  assert.equal(await page.locator('[data-node="components/inbox"]').count(), 0);
  checks.push('line expansion and collapse verified in Electron');
  assert.deepEqual(errors, []);
  checks.push('no renderer errors');
} finally {
  await app.close();
}
assert.equal(await digest(), beforeJournal, 'existing journal remains unchanged');
checks.push('existing journal SHA-256 unchanged');
await fs.writeFile(path.join(output, 'canvas-final.json'), JSON.stringify({ ok: true, checks }, null, 2));
console.log(JSON.stringify({ ok: true, checks }, null, 2));
