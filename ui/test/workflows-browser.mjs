// Real UI -> user HTTP routes -> installed pack -> runtime -> persisted artifact.
// Run: node ui/test/workflows-browser.mjs (needs the exclusive acceptance browser slot).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { liveApp } from './live-app.mjs';

const app = await liveApp('workflows');
const out = path.join(app.root, 'var/verification/workflows-ui');
await fs.mkdir(out, { recursive: true });
const errors = [], checks = [];
let page;
try {
  page = await app.browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem('pf.view', JSON.stringify('library')); localStorage.setItem('pf.chatOpen', 'false'); });
  await page.goto(app.url);
  await page.locator('.rail-conn.is-on').waitFor();
  await page.locator('[data-workflow-template="fanout"]').getByRole('button', { name: '创建工作流' }).click();
  await page.getByLabel('工作流名称').fill('浏览器验收文本分析');
  const created = page.waitForResponse(response => response.url().endsWith('/api/workflows/template') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '创建可运行工作流' }).click();
  const creation = await (await created).json();
  assert.equal(creation.ok, true, JSON.stringify(creation));
  const pack = creation.result.manifest;
  assert.ok(pack.entry.endsWith('/prepare'));
  await page.locator(`[data-workflow-line="${pack.lines[0].id}"]`).waitFor();
  assert.equal((await app.request('/api/factory')).factory.lines.filter(line => line.id === pack.lines[0].id).length, 1);
  checks.push('user template creation installs a real compiled pack without duplicating line cards');

  const line = page.locator(`[data-workflow-line="${pack.lines[0].id}"]`);
  await line.getByRole('button', { name: '暂停此线' }).click();
  await line.getByRole('button', { name: '恢复此线' }).waitFor();
  assert.ok((await app.request('/api/state')).pausedScopes.lines.includes(pack.lines[0].id));
  const input = 'Alpha beta alpha\n\nGamma';
  const submit = async index => {
    await line.getByRole('button', { name: '提交任务' }).click();
    await page.getByLabel('任务名称').fill(`ui-task-${index}`);
    await page.getByLabel('原始文本').fill(input);
    const completed = page.waitForResponse(response => response.url().endsWith('/api/workflows/feed') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '验证输入并投料' }).click();
    const receipt = await (await completed).json();
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    await page.locator('.workflow-form').waitFor({ state: 'hidden' });
    return receipt.result.token;
  };
  const first = await submit(0);
  let state = await app.request('/api/state');
  assert.equal(state.tokens[first].status, 'active');
  assert.equal(state.tokens[first].attempts.length, 0, 'paused line must hold actual work');
  await line.getByRole('button', { name: '恢复此线' }).click();
  await page.waitForFunction(async id => (await (await fetch('/api/state')).json()).tokens[id]?.status === 'published', first);
  state = await app.request('/api/state');
  assert.deepEqual(state.tokens[first].data.statistics, { characters: 23, words: 4, paragraphs: 2 });
  const artifact = Object.values(state.tokens[first].data).find(value => value && typeof value === 'object' && 'sha256' in value);
  assert.ok(artifact);
  const body = await fs.readFile(path.join(app.directory, artifact.path));
  assert.equal(body.length, artifact.bytes);
  assert.equal(createHash('sha256').update(body).digest('hex'), artifact.sha256);
  checks.push('local pause holds submitted work; resume produces verifiable artifact bytes and hash');

  for (let index = 1; index < 10; index++) await submit(index);
  await page.getByRole('region', { name: '实测配员建议' }).waitFor();
  await page.getByText('查看各工位的建议人数', { exact: true }).click();
  const measured = (await app.request('/api/state')).measurement;
  assert.equal(measured.status, 'proposed'); assert.ok(measured.sampleItems >= 10);
  await page.screenshot({ path: path.join(out, 'allocation-proposal.png'), fullPage: false });
  await page.getByRole('button', { name: '应用这份建议' }).click();
  await page.getByRole('region', { name: '实测配员建议' }).waitFor({ state: 'hidden' });
  assert.equal((await app.request('/api/state')).measurement.status, 'accepted');
  checks.push('ten real program tasks generate measured allocation and the user applies it');

  // All built-in entry forms are reachable; malformed user data stays in the form.
  for (const id of ['components', 'skills', 'sci-figure', 'ppt', 'image-fx']) {
    await page.locator(`[data-workflow-line="${id}"]`).getByRole('button', { name: '提交任务' }).click();
    await page.getByLabel('任务名称').fill(`input-check-${id}`);
    if (id === 'sci-figure') {
      await page.getByLabel('数据来源地址').fill('https://data.example.test/experiment');
      await page.getByLabel('科研图数据（JSON）').fill('{bad-json');
      await page.getByRole('button', { name: '验证输入并投料' }).click();
      await page.locator('.workflow-form [role="alert"]').waitFor();
      assert.equal(await page.getByLabel('科研图数据（JSON）').inputValue(), '{bad-json');
    }
    if (id === 'image-fx') {
      await page.getByLabel('图像变换').selectOption('resize');
      await page.getByLabel('输出宽度（像素）').fill('1280');
      await page.screenshot({ path: path.join(out, 'business-input.png') });
    }
    await page.getByRole('button', { name: '关闭业务任务表单' }).click();
  }
  checks.push('five real business-line forms expose inputs; invalid scientific JSON retains the draft');

  await page.locator('[data-tip^="画布 · 流水线"]').click();
  await page.getByRole('button', { name: '结束本轮', exact: true }).click();
  await page.getByRole('button', { name: '结束并生成报告', exact: true }).click();
  await page.locator('.dashboard-host .dash-head h1').waitFor();
  assert.equal(await page.locator('.dashboard-host .dash-head h1').innerText(), '浏览器验收文本分析');
  assert.equal((await app.request('/api/state')).run.status, 'ended');
  checks.push('end-run receipt opens the actual report');

  await page.locator('[data-tip="流水线库"]').click();
  await page.getByRole('button', { name: '安装工作流包', exact: true }).click();
  const index = JSON.parse(await fs.readFile(path.join(app.directory, 'packs/installed.json'), 'utf8'));
  const revision = index.packages.find(entry => entry.id === pack.id).revision;
  await page.getByLabel('工作流目录').fill(path.join(app.directory, 'packs', pack.id, 'versions', revision));
  await page.getByRole('button', { name: '校验并安装' }).click();
  await page.locator('.workflow-form [role="alert"]').waitFor();
  assert.ok((await page.getByLabel('工作流目录').inputValue()).endsWith(revision));
  await page.getByLabel('更新同标识的已安装包').check();
  await page.getByRole('button', { name: '校验并安装' }).click();
  await page.locator('.workflow-form').waitFor({ state: 'hidden' });
  checks.push('local directory install reports duplicate and retains form; explicit replacement succeeds');

  const extra = { line: { id: 'extra-ui', name: '追加文本线', layer: 3, priority: 'low', blurb: '浏览器集成验收的真实程序线', wired: true,
      stations: [{ ...pack.lines[0].stations[0], id: 'prepare', name: '追加文本标准化' }, pack.lines[0].stations.at(-1)], edges: [{ from: 'prepare', to: 'published' }] },
    schemas: {}, bindings: { 'extra-ui/prepare': { role: 'roles/extra-ui/prepare/ROLE.md', inputSchema: 'text', outputSchema: 'text', input: { text: { path: 'input.text' } }, outputKey: 'extraNormalized', execute: { kind: 'builtin', name: 'normalize-text' } } },
    files: { 'roles/extra-ui/prepare/ROLE.md': '# Normalize supplied text\n\nNormalize only the supplied input text and preserve its meaning. Reject missing inputs and never invent a successful transformation.' } };
  await page.getByRole('button', { name: '添加流水线', exact: true }).click();
  await page.getByLabel('流水线定义（JSON）').fill(JSON.stringify(extra, null, 2));
  await page.getByRole('button', { name: '添加到项目' }).click();
  await page.locator('[data-workflow-line="extra-ui"]').waitFor();
  assert.ok((await app.request('/api/factory')).factory.nodes.some(node => node.key === 'extra-ui/prepare'));
  checks.push('adding a line validates and compiles the actual executor and role contract');

  // A published item can be corrected and undone while its line is held, including after reload.
  await page.locator(`[data-workflow-line="${pack.lines[0].id}"]`).getByRole('button', { name: '暂停此线' }).click();
  await page.locator(`[data-workflow-line="${pack.lines[0].id}"]`).getByRole('button', { name: '恢复此线' }).waitFor();
  await page.locator('[data-tip^="画布 · 流水线"]').click();
  await page.evaluate(async token => (await import('/src/canvas/Canvas.tsx')).toggleInspector(token, 'token'), first);
  await page.getByRole('button', { name: '纠错退回…' }).click();
  await page.locator('.correction select').selectOption(pack.entry);
  await page.locator('.corr-reasons button').last().click();
  const corrected = page.waitForResponse(response => response.url().endsWith('/api/correct') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '退回重做', exact: true }).click();
  const correction = (await (await corrected).json()).results[0];
  assert.equal(correction.ok, true);
  await page.locator('.correction').getByRole('button', { name: '撤销本次纠错' }).waitFor();
  await page.reload();
  await page.locator('.rail-conn.is-on').waitFor();
  await page.locator('[data-tip^="画布 · 流水线"]').click();
  await page.evaluate(async token => (await import('/src/canvas/Canvas.tsx')).toggleInspector(token, 'token'), first);
  await page.locator('.token-corrections').getByRole('button', { name: '撤销本次纠错' }).click();
  await page.locator('.token-corrections').getByText('已撤销本次纠错', { exact: true }).waitFor();
  assert.equal((await app.request('/api/state')).corrections[correction.correction].status, 'reverted');
  assert.equal((await app.request('/api/state')).tokens[first].status, 'published');
  checks.push('correction receipt offers undo only while pending, survives reload and restores published state');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ checks, errors, sampleItems: measured.sampleItems, artifact: { sha256: artifact.sha256, bytes: artifact.bytes } }, null, 2));
  console.log(JSON.stringify({ checks, errors, out }, null, 2));
} catch (error) {
  await fs.writeFile(path.join(out, 'backend.log'), app.logs());
  if (page) {
    await page.screenshot({ path: path.join(out, 'failure.png') });
    await fs.writeFile(path.join(out, 'failure.txt'), JSON.stringify({ errors, text: await page.locator('body').innerText() }, null, 2));
  }
  throw error;
} finally { await app.close(); }
