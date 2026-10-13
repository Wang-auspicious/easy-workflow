// Real UI -> user HTTP routes -> installed pack -> runtime -> persisted artifact.
// Run: node ui/test/workflows-browser.mjs (needs the exclusive acceptance browser slot).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { liveApp } from './live-app.mjs';

const app = await liveApp('workflows');
const sourceFeed = http.createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify([{url: 'https://resource.fixture.test/ui-source', title: 'Real source fixture', excerpt: 'Source text enters normalization and the full analysis workflow.'}]));
});
await new Promise(resolve => sourceFeed.listen(0, '127.0.0.1', resolve));
const out = path.join(app.root, 'var/verification/workflows-ui');
await fs.mkdir(out, { recursive: true });
const errors = [], checks = [];
const sourcesOnly = process.env.WORKFLOW_SOURCES_ONLY === '1';
let measuredProof;
let page;
try {
  page = await app.browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem('pf.view', JSON.stringify('library')); localStorage.setItem('pf.chatOpen', 'false'); });
  await page.goto(app.url);
  await page.locator('.rail-conn.is-on').waitFor();
  if (!sourcesOnly) {
    const original = (await app.request('/api/tools/agent_bindings', {})).result.bindings;
    await page.locator('[data-tip^="画布 · 流水线"]').click();
    await page.evaluate(async () => {
      const store = await import('/src/store.ts');
      store.setState(state => ({layout: {...state.layout, open: {...state.layout.open, curation: true}}}));
      (await import('/src/canvas/Canvas.tsx')).toggleInspector('curation/reader', 'node');
    });
    const inspector = page.locator('[data-inspector="curation/reader"]');
    await inspector.getByRole('button', {name: '规格', exact: true}).click();
    const settings = inspector.getByRole('region', {name: '工位 Agent 配置'});
    await settings.getByLabel('执行适配器').waitFor();
    assert.equal(await settings.getByLabel('执行适配器').inputValue(), 'inherit');
    await settings.getByLabel('执行适配器').selectOption('launcher');
    await settings.getByLabel('Agent 请求模型').fill('isolated-requested-model');
    const oversizedCommand = JSON.stringify(Array(33).fill('argument'));
    await settings.getByLabel('Agent 启动命令').fill(oversizedCommand);
    await settings.getByRole('button', {name: '保存配置'}).click();
    await settings.getByRole('alert').waitFor();
    assert.equal(await settings.getByLabel('Agent 启动命令').inputValue(), oversizedCommand, 'server rejection preserves the actual edited command');
    assert.equal((await app.request('/api/state')).agentBindings['curation/reader'], undefined);
    await settings.getByLabel('Agent 启动命令').fill('["node","fixture-launcher.mjs"]');
    const saved = page.waitForResponse(response => response.url().endsWith('/api/agents/binding') && response.request().method() === 'POST');
    await settings.getByRole('button', {name: '保存配置'}).click();
    const receipt = await (await saved).json();
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    const expected = {adapter: 'launcher', command: ['node', 'fixture-launcher.mjs'], model: 'isolated-requested-model'};
    assert.deepEqual((await app.request('/api/state')).agentBindings['curation/reader'], expected);
    await page.locator('[data-node="curation/reader"] .node-type').filter({hasText: 'launcher · isolated-requested-model（配置）'}).waitFor();
    await inspector.locator('.spec-view').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({path: path.join(out, 'agent-binding-live.png')});
    await page.reload();
    await page.locator('.rail-conn.is-on').waitFor();
    await page.locator('[data-tip^="画布 · 流水线"]').click();
    await page.evaluate(async () => (await import('/src/canvas/Canvas.tsx')).toggleInspector('curation/reader', 'node'));
    await inspector.getByRole('button', {name: '规格', exact: true}).click();
    await settings.getByLabel('Agent 请求模型').waitFor();
    assert.equal(await settings.getByLabel('执行适配器').inputValue(), 'launcher');
    assert.equal(await settings.getByLabel('Agent 请求模型').inputValue(), expected.model);
    assert.equal(await settings.getByLabel('Agent 请求超时').inputValue(), '', 'effective timeout defaults do not overwrite the configured form');
    await settings.getByRole('button', {name: '恢复继承'}).click();
    await page.waitForFunction(async () => !(await (await fetch('/api/state')).json()).agentBindings['curation/reader']);
    await page.waitForFunction(async () => (await import('/src/store.ts')).getState().agentBindings['curation/reader']?.configured === null);
    assert.equal(await settings.getByLabel('执行适配器').inputValue(), 'inherit');
    assert.deepEqual((await app.request('/api/tools/agent_bindings', {})).result.bindings, original, 'the entire Agent binding view returns to the original values');
    assert.equal(Object.keys((await app.request('/api/state')).attempts).length, 0, 'editing a binding never starts a model call');
    await page.evaluate(async () => (await import('/src/store.ts')).setState({inspectors: []}));
    await page.locator('[data-tip="流水线库"]').click();
    checks.push('real node binding form preserves rejected drafts, persists launcher settings across reload, updates canvas labels immediately and restores inheritance without changing other stations');
  }
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

  if (!sourcesOnly) {
  await page.locator('[data-tip^="画布 · 流水线"]').click();
  await page.evaluate(async node => (await import('/src/canvas/Canvas.tsx')).toggleInspector(node, 'node'), pack.entry);
  const programInspector = page.locator(`[data-inspector="${pack.entry}"]`);
  await programInspector.getByRole('button', {name: '规格', exact: true}).click();
  await programInspector.getByText('程序执行，不使用 Agent 模型。').waitFor();
  assert.equal(await programInspector.getByLabel('执行适配器').count(), 0);
  await page.evaluate(async () => (await import('/src/store.ts')).setState({inspectors: []}));
  await page.locator('[data-tip="流水线库"]').click();
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
  measuredProof = {sampleItems: measured.sampleItems, artifact: {sha256: artifact.sha256, bytes: artifact.bytes}};
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
  const correctionHit = await page.getByRole('dialog', {name: '纠错与撤销'}).evaluate(dialog => {
    const target = dialog.querySelector('.corr-reasons button:last-child');
    if (!target) return false;
    const bounds = target.getBoundingClientRect();
    return dialog.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  });
  assert.equal(correctionHit, true, 'the correction dialog receives pointer hits above canvas inspectors');
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
  }

  await page.locator('[data-tip="流水线库"]').click();
  const sources = page.getByRole('region', {name: '持续来源'});
  await sources.getByRole('button', {name: '添加来源'}).click();
  await page.getByLabel('来源名称', {exact: true}).fill('浏览器验收来源');
  await page.getByLabel('采集格式', {exact: true}).selectOption('json');
  await page.getByLabel('来源地址', {exact: true}).fill(`http://127.0.0.1:${sourceFeed.address().port}/items`);
  await page.getByLabel('候选入口', {exact: true}).selectOption(pack.entry);
  await page.getByText('输入映射与常量（需要时填写）', {exact: true}).click();
  await page.getByLabel('来源输入映射（JSON）', {exact: true}).fill('{bad-json');
  await page.getByRole('button', {name: '保存来源配置', exact: true}).click();
  await sources.getByRole('alert').waitFor();
  assert.equal(await page.getByLabel('来源输入映射（JSON）', {exact: true}).inputValue(), '{bad-json');
  await page.getByLabel('来源输入映射（JSON）', {exact: true}).fill('{"text":"excerpt"}');
  const sourceSaved = page.waitForResponse(response => response.url().endsWith('/api/sources/configure') && response.request().method() === 'POST');
  await page.getByRole('button', {name: '保存来源配置', exact: true}).click();
  const configured = await (await sourceSaved).json();
  assert.equal(configured.ok, true, JSON.stringify(configured));
  assert.equal(configured.result.enabled, false);
  const sourceRow = page.locator(`[data-source-id="${configured.result.id}"]`);
  await sourceRow.getByText('已停用', {exact: true}).waitFor();
  const beforeSourceTokens = Object.keys((await app.request('/api/state')).tokens).length;
  const sourcePolled = page.waitForResponse(response => response.url().endsWith('/api/sources/poll') && response.request().method() === 'POST');
  await sourceRow.getByRole('button', {name: '采集一次', exact: true}).click();
  const collected = await (await sourcePolled).json();
  assert.equal(collected.result.count, 1);
  await sourceRow.getByText(/候选 1 · 待投 1/).waitFor();
  assert.equal(Object.keys((await app.request('/api/state')).tokens).length, beforeSourceTokens);
  await sourceRow.getByRole('button', {name: '启用来源', exact: true}).click();
  await sourceRow.getByRole('button', {name: '停用来源', exact: true}).waitFor();
  const sourceLine = page.locator(`[data-workflow-line="${pack.lines[0].id}"]`);
  const resumeSourceLine = sourceLine.getByRole('button', {name: '恢复此线', exact: true});
  if (await resumeSourceLine.count()) await resumeSourceLine.click();
  const beforeRun = await app.request('/api/state');
  await app.request('/api/run', {action: beforeRun.run.status === 'paused' ? 'resume' : 'start', title: 'Configured source fixture'});
  await page.waitForFunction(async id => {
    const response = await fetch('/api/tools/source_list', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});
    const state = await response.json();
    return state.result.sources.find(source => source.id === id)?.candidates[0]?.status === 'acknowledged';
  }, configured.result.id);
  const deliveredSource = (await app.request('/api/tools/source_list', {})).result.sources.find(source => source.id === configured.result.id);
  const sourceToken = (await app.request('/api/state')).tokens[deliveredSource.candidates[0].targetToken];
  assert.equal(sourceToken.status, 'published');
  assert.equal(sourceToken.data.normalized.text, 'Source text enters normalization and the full analysis workflow.');
  assert.equal(sourceToken.attempts.length, pack.lines[0].stations.length - 1, 'every executable station and the publication gate run');
  await sourceRow.getByRole('button', {name: '停用来源', exact: true}).click();
  await sourceRow.getByText('已停用', {exact: true}).waitFor();
  await sourceRow.getByText(/已确认 1/).waitFor();
  await sourceRow.getByText(/上次新增 1/).waitFor();
  await sources.scrollIntoViewIfNeeded();
  await page.screenshot({path: path.join(out, 'sources.png')});
  checks.push('source form preserves invalid drafts; explicit configure/poll/enable sends one durable candidate through every workflow station, then disables without losing provenance');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({checks, errors, sourcesOnly, ...measuredProof}, null, 2));
  console.log(JSON.stringify({ checks, errors, out }, null, 2));
} catch (error) {
  await fs.writeFile(path.join(out, 'backend.log'), app.logs());
  if (page) {
    await page.screenshot({ path: path.join(out, 'failure.png') });
    await fs.writeFile(path.join(out, 'failure.txt'), JSON.stringify({ errors, text: await page.locator('body').innerText() }, null, 2));
  }
  throw error;
} finally {
  await app.close();
  sourceFeed.closeAllConnections();
  await new Promise(resolve => sourceFeed.close(resolve));
}
