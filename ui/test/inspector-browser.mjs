// 工位卡片的隔离验收：node ui/test/inspector-browser.mjs
// 只读 fixture 数据，不启动工厂、不连真实项目。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const server = await createServer({ configFile: path.resolve("ui/vite.config.ts"), logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });
await server.listen();
const address = server.httpServer.address();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const out = path.resolve("var/verification/station-card");
await fs.mkdir(out, { recursive: true });
const errors = [];
let page;
try {
  page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  const calls = [];
  const savedBindings = [];
  const detailRequests = [];
  const abortedDetails = [];
  let holdAttempt = '';
  let failAttempt = '';
  let releaseDetail;
  page.on('requestfailed', request => {
    if (request.url().endsWith('/api/tools/inspect')) abortedDetails.push(request.postDataJSON());
  });
  let configured = null;
  let rejectSave = false;
  const bindingResult = () => ({bindings: [{
    node: 'curation/review', configured,
    effective: configured?.adapter === 'pi'
      ? {adapter: 'pi', provider: configured.provider || 'fixture-provider', model: configured.model || 'fixture-model'}
      : configured ? {...configured, requestTimeoutMs: configured.requestTimeoutMs ?? 180000}
        : {adapter: 'pi', provider: 'fixture-provider', model: 'fixture-model'},
    source: configured ? 'project' : 'default',
    capabilities: {stream: !configured || configured.adapter === 'pi', cancel: true, resume: configured?.adapter !== 'launcher', usage: configured?.adapter === 'launcher' ? 'unknown' : 'reported'},
    lastModel: 'last-actual-fixture-model',
  }]});
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url.pathname);
    if (url.pathname === '/api/tools/inspect') {
      const args = route.request().postDataJSON();
      detailRequests.push(args);
      if (args.attempt === failAttempt) {
        await route.fulfill({status: 503, json: {ok: false, error: 'Fixture detail unavailable'}});
        return;
      }
      const receipt = await page.evaluate(args => {
        const raw = window.inspectorFixture.fullState;
        const result = args.attempt ? raw.attempts[args.attempt] : args.evidence ? raw.evidence[args.evidence]
          : {id: args.token, data: raw.tokens[args.token].data, attempts: raw.tokens[args.token].attempts.map(id => raw.attempts[id]), evidence: raw.tokens[args.token].evidence.map(id => raw.evidence[id])};
        return {ok: true, seq: raw.seq, result};
      }, args);
      if (args.attempt === holdAttempt) await new Promise(resolve => { releaseDetail = resolve; });
      await route.fulfill({json: receipt}).catch(() => {});
      return;
    }
    if (url.pathname === "/api/tools/read_role") {
      await route.fulfill({ json: { ok: true, result: { content: "# 截图审查员\n\n只做判定，不改内容。\n\n- 输入：候选 + 证据\n- 输出：结论\n- 异常：截图失败退回采集，最多 2 轮" } } });
      return;
    }
    if (url.pathname === '/api/tools/agent_bindings') {
      const args = route.request().postDataJSON();
      await route.fulfill({json: {ok: true, result: args.node === 'curation/review' ? bindingResult() : {bindings: []}}});
      return;
    }
    if (url.pathname === '/api/agents/binding') {
      if (rejectSave) {
        await route.fulfill({status: 422, json: {ok: false, error: 'Fixture server rejected this configuration'}});
        return;
      }
      configured = route.request().postDataJSON().binding;
      savedBindings.push(configured);
      await route.fulfill({json: {ok: true, result: bindingResult()}});
      return;
    }
    await route.fulfill({ json: { ok: true, result: {} } });
  });
  await page.goto(`http://127.0.0.1:${address.port}/test/inspector-fixture.html`);
  await page.locator(".insp-title b").waitFor();
  assert.match(await page.locator(".insp-title b").innerText(), /截图审查员/);

  // 人：含自动 fork 出来的和被撤下的，各带自己的小人。
  assert.equal(await page.locator(".crew-row").count(), 3);
  assert.equal(await page.locator(".crew-tag--fork").count(), 1);
  assert.equal(await page.locator(".crew-row.is-retired").count(), 1);
  assert.equal(await page.locator(".crew-row .gavatar").count(), 3, "每个人一只小人");
  const hues = await page.locator(".crew-row .gavatar").evaluateAll((els) => els.map((el) => el.style.getPropertyValue("--gv-hue")));
  assert.equal(new Set(hues).size, 3, "同工位的人用颜色区分开");
  assert.match(await page.locator(".crew-title").innerText(), /2 在岗 · 1 已撤/);

  // 人员变动与工位记录：fork、到岗、撤下、提示都在。
  await page.locator(".crew-log > summary").click();
  const events = await page.locator(".crew-event").allInnerTexts();
  assert.ok(events.some((e) => /自动 fork 出来/.test(e)), events.join(" | "));
  assert.ok(events.some((e) => /撤下/.test(e)), events.join(" | "));
  assert.ok(events.some((e) => /队列 12 件/.test(e)), events.join(" | "));

  // 过程：思考展开后在内部滚，工具组展开看每一步。
  await page.locator(".wt-think > button").click();
  const body = await page.locator(".wt-think-body").evaluate((el) => ({ overflow: getComputedStyle(el).overflowY, max: getComputedStyle(el).maxHeight }));
  assert.equal(body.overflow, "auto");
  assert.match(body.max, /px$/);
  await page.locator(".wt-tools-sum").click();
  assert.match(await page.locator(".wt-tools-body").innerText(), /http.*shot.*reject/s);
  assert.equal(await page.locator(".wt-tools-body .ev-thumb").count(), 4, "工具步骤带证据缩略图");
  assert.match(await page.locator(".wt-foot").innerText(), /拒收：构图与描述不符/);
  assert.equal(await page.evaluate(() => window.inspectorFixture.getState().fs.attempts.a1.steps.length), 1, 'opening complete steps must not merge them into the summary projection');
  holdAttempt = 'a2';
  const heldDetail = page.waitForRequest(request => request.url().endsWith('/api/tools/inspect') && request.postDataJSON().attempt === 'a2');
  await page.locator('.crew-row').nth(1).click();
  await page.getByText('正在读取完整步骤…', {exact: true}).waitFor();
  await heldDetail;
  const cancelledDetail = page.waitForEvent('requestfailed', request => request.url().endsWith('/api/tools/inspect') && request.postDataJSON().attempt === 'a2');
  await page.locator('.crew-row').first().click();
  await page.locator('.wt-tools-sum').waitFor();
  await cancelledDetail;
  releaseDetail?.();
  assert.ok(abortedDetails.some(args => args.attempt === 'a2'), 'switching worker aborts its full-detail request');
  holdAttempt = '';
  failAttempt = 'a2';
  await page.locator('.crew-row').nth(1).click();
  await page.getByRole('alert').filter({hasText: 'Fixture detail unavailable'}).waitFor();
  failAttempt = '';
  await page.getByRole('button', {name: '重新读取', exact: true}).click();
  await page.locator('.wt-tools-sum').waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.locator('.crew-row').first().click();
  await page.evaluate(() => window.inspectorFixture.emit({kind: 'attempt.progress', attempt: 'a1', text: '新增完整步骤已经到达', step: {tool: 'say'}}));
  await page.locator('.wt-log').getByText('新增完整步骤已经到达', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => window.inspectorFixture.getState().fs.attempts.a1.steps.length), 1);
  const beforeCursor = await page.evaluate(() => window.inspectorFixture.getState().version);
  const beforeCursorReads = detailRequests.length;
  await page.evaluate(() => window.inspectorFixture.emit({kind: 'attempt.activity', attempt: 'a1', activity: {id: 'ui-only-cursor', kind: 'tool', source: 'tool-executor', startedAt: Date.now(), status: 'running'}}));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => window.inspectorFixture.getState().fs.seq), await page.evaluate(() => window.inspectorFixture.fullState.seq));
  assert.equal(await page.evaluate(() => window.inspectorFixture.getState().version), beforeCursor, 'a cursor advances ordering without rerendering the whole dashboard');
  assert.equal(detailRequests.length, beforeCursorReads);

  // 统计与职责都还在：统计行照旧，规格页读到 ROLE.md。
  assert.match(await page.locator(".insp-stats").innerText(), /在岗\n2 \/ 3/);
  await page.getByRole("button", { name: "规格" }).click();
  await page.getByText("ROLE.md · 职责与异常处理").waitFor();
  assert.match(await page.locator(".node-role pre").innerText(), /只做判定，不改内容/);
  assert.ok(calls.includes("/api/tools/read_role"), "职责来自接口，不是写死的文案");

  const settings = page.getByRole('region', {name: '工位 Agent 配置'});
  await settings.getByLabel('执行适配器').waitFor();
  assert.equal(await settings.getByLabel('执行适配器').inputValue(), 'inherit');
  assert.match(await settings.locator('.agent-binding-effective').innerText(), /Pi · fixture-model.*应用默认/s);
  assert.match(await settings.innerText(), /最近回报模型：last-actual-fixture-model/);
  await settings.getByLabel('执行适配器').selectOption('claude-code');
  await settings.getByLabel('Agent 请求模型').fill('fixture-claude');
  await settings.getByLabel('Agent 启动命令').fill('not-json');
  await settings.getByRole('button', {name: '保存配置'}).click();
  assert.match(await settings.getByRole('alert').innerText(), /JSON 字符串数组/);
  assert.equal(savedBindings.length, 0, 'invalid JSON never sends a write');
  assert.equal(await settings.getByLabel('Agent 启动命令').inputValue(), 'not-json');
  await settings.getByLabel('Agent 启动命令').fill('["claude"]');
  rejectSave = true;
  await settings.getByRole('button', {name: '保存配置'}).click();
  await settings.getByText('Fixture server rejected this configuration').waitFor();
  assert.equal(await settings.getByLabel('Agent 请求模型').inputValue(), 'fixture-claude');
  rejectSave = false;
  await settings.getByRole('button', {name: '保存配置'}).click();
  await settings.getByRole('status').waitFor();
  await page.waitForFunction(() => window.inspectorFixture.getState().agentBindings['curation/review']?.effective?.adapter === 'claude-code');
  assert.deepEqual(configured, {adapter: 'claude-code', command: ['claude'], model: 'fixture-claude'});
  assert.match(await settings.locator('.agent-binding-effective').innerText(), /Claude Code · fixture-claude.*本项目覆盖/s);
  const statsHeight = await page.locator('.insp-stats').evaluate(element => element.getBoundingClientRect().height);
  assert.ok(statsHeight >= 40, `a long adapter form must not collapse the station statistics (${statsHeight}px)`);
  await page.locator('.spec-view').evaluate(element => { element.scrollTop = 0; });
  await page.locator('.inspector').screenshot({path: path.join(out, 'agent-binding.png')});
  await settings.getByLabel('执行适配器').selectOption('launcher');
  await settings.getByLabel('Agent 请求模型').fill('fixture-launcher');
  await settings.getByLabel('Agent 启动命令').fill('["node","fixture.mjs"]');
  await settings.getByLabel('Agent 请求超时').fill('12000');
  await settings.getByRole('button', {name: '保存配置'}).click();
  await page.waitForFunction(() => window.inspectorFixture.getState().agentBindings['curation/review']?.effective?.adapter === 'launcher');
  assert.match(await settings.locator('.agent-binding-capabilities').innerText(), /续接 不支持.*用量 未提供/);
  await settings.getByLabel('执行适配器').selectOption('pi');
  await settings.getByRole('button', {name: '保存配置'}).click();
  await page.waitForFunction(() => window.inspectorFixture.getState().agentBindings['curation/review']?.configured?.adapter === 'pi');
  assert.deepEqual(configured, {adapter: 'pi'}, 'empty Pi values inherit defaults instead of copying effective model into configured');
  assert.equal(await settings.getByLabel('Agent 请求模型').inputValue(), '');
  await settings.getByRole('button', {name: '恢复继承'}).click();
  await page.waitForFunction(() => window.inspectorFixture.getState().agentBindings['curation/review']?.configured === null);
  assert.equal(await settings.getByLabel('执行适配器').inputValue(), 'inherit');
  assert.equal(savedBindings.length, 4);
  await page.evaluate(() => window.inspectorFixture.setState({inspectors: [{key: 'curation/capture', kind: 'node', x: 40, y: 40, pinned: true}]}));
  await page.getByRole('button', {name: '规格', exact: true}).click();
  await settings.getByText('程序执行，不使用 Agent 模型。').waitFor();
  assert.equal(await settings.getByLabel('执行适配器').count(), 0, 'programs never show a fake Agent selector');

  await page.evaluate(() => window.inspectorFixture.setState({view: 'board'}));
  await page.getByRole('button', {name: '完整文字判定：查看完整证据'}).click();
  await page.locator('.evidence-document pre').filter({hasText: 'FULL-EVIDENCE-NOT-IN-SUMMARY'}).waitFor();
  assert.equal(await page.evaluate(() => window.inspectorFixture.getState().fs.evidence.evtext.meta.rawText), undefined);
  await page.screenshot({path: path.join(out, 'lazy-evidence.png')});
  await page.getByRole('button', {name: '关闭', exact: true}).click();
  const liveDetailCount = detailRequests.length;
  await page.evaluate(() => {
    const fixture = window.inspectorFixture;
    fixture.setState({fs: structuredClone(fixture.fullState), view: 'canvas', inspectors: [{key: 'curation/review', kind: 'node', x: 40, y: 40, pinned: true}],
      replay: {run: 'fixture-run', speed: 1, playing: false, at: Date.now(), start: 1, end: Date.now(), events: [], cursor: 0}});
  });
  await page.locator('.wt-tools-sum').waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(detailRequests.length, liveDetailCount, 'historical replay renders original steps without reading live details');

  await page.locator(".inspector").screenshot({ path: path.join(out, "station-card.png") });
  assert.deepEqual(errors, [], `页面不能有运行时错误：${errors.join(" | ")}`);
  console.log(`PASS: isolated station card checks, screenshot in ${path.relative(process.cwd(), out)}`);
} catch (error) {
  if (page) {
    await page.screenshot({path: path.join(out, 'failure.png')});
    await fs.writeFile(path.join(out, 'failure.txt'), await page.locator('body').innerText());
  }
  throw error;
} finally {
  await browser.close();
  await server.close();
}
