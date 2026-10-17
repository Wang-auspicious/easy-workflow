// 工位卡片的隔离验收：node ui/test/inspector-browser.mjs
// 只读 fixture 数据，不启动工厂、不连真实项目。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const server = await createServer({ configFile: path.resolve("ui/vite.config.ts"), logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
await server.listen();
const address = server.httpServer.address();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const out = path.resolve("var/verification/station-card");
await fs.mkdir(out, { recursive: true });
const errors = [];
let page;
try {
  page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.addInitScript(() => {
    // The fixture supplies journal events directly; snapshot refreshes must not
    // open an actual backend stream or turn a synthetic connection into an error.
    window.EventSource = class extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      close() {}
    };
  });
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
  let projectDefaults = {
    station: {adapter: 'pi', provider: 'fixture-provider', model: 'fixture-model'},
    dispatcher: {adapter: 'pi', provider: 'dispatcher-provider', model: 'dispatcher-model'},
  };
  const defaultWrites = [];
  const admissionWrites = [];
  const candidateRetries = [];
  const workerWrites = [];
  const pullWrites = [];
  let releasePull;
  const scopeWrites = [];
  let holdWorkers = false;
  let rejectWorkers = false;
  let releaseWorkers;
  let rejectCandidateRetry = false;
  let holdCandidateRetry = false;
  let releaseCandidateRetry;
  let rejectDefaultSave = false;
  let exposeModelAssist = false;
  const bindingResult = () => ({bindings: [{
    node: 'curation/review', configured,
    effective: configured?.adapter === 'pi'
      ? {adapter: 'pi', provider: configured.provider || projectDefaults.station.provider, model: configured.model || projectDefaults.station.model}
      : configured ? {...configured, requestTimeoutMs: configured.requestTimeoutMs ?? 180000}
        : projectDefaults.station,
    source: configured ? 'project' : 'default',
    capabilities: {stream: !configured || configured.adapter === 'pi', cancel: true, resume: configured?.adapter !== 'launcher', usage: configured?.adapter === 'launcher' ? 'unknown' : configured?.adapter === 'codex' ? 'tokens-only' : 'reported'},
    lastModel: 'last-actual-fixture-model',
  }], piModels: [{provider: 'fixture-provider', model: 'fixture-model', name: 'Fixture default'},
    {provider: 'node-provider', model: 'independent-model', name: 'Independent node model'},
    {provider: 'opencode-go', model: 'muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor'}]});
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url.pathname);
    if (url.pathname === '/api/board') {
      await route.fulfill({json: {posts: [], rooms: []}});
      return;
    }
    if (url.pathname === '/api/pull') {
      pullWrites.push(route.request().postDataJSON());
      await new Promise(resolve => { releasePull = resolve; });
      await route.fulfill({json: {ok: true, pulled: 0}});
      return;
    }
    if (url.pathname === '/api/workers') {
      workerWrites.push(route.request().postDataJSON());
      if (holdWorkers) await new Promise(resolve => { releaseWorkers = resolve; });
      await route.fulfill({json: {ok: !rejectWorkers}});
      return;
    }
    if (url.pathname === '/api/run') {
      const request = route.request().postDataJSON();
      scopeWrites.push(request);
      await page.evaluate(request => window.inspectorFixture.emit({kind: 'scope.paused',
        scope: request.line ? 'line' : 'station', key: request.line || request.station,
        paused: request.action === 'pause', reason: request.reason}), request);
      await route.fulfill({json: {ok: true, result: {}}});
      return;
    }
    if (url.pathname === '/api/state') {
      await route.fulfill({json: await page.evaluate(() => window.inspectorFixture.getState().fs)});
      return;
    }
    if (url.pathname === '/api/candidates/retry') {
      const request = route.request().postDataJSON();
      candidateRetries.push(request);
      if (holdCandidateRetry) await new Promise(resolve => { releaseCandidateRetry = resolve; });
      await route.fulfill(rejectCandidateRetry
        ? {status: 409, json: {ok: false, error: 'Fixture checkpoint is temporarily unavailable'}}
        : {json: {ok: true, result: {count: request.tokens.length}}});
      return;
    }
    if (url.pathname === '/api/batch/admission') {
      const update = route.request().postDataJSON();
      admissionWrites.push(update);
      const goal = await page.evaluate(() => window.inspectorFixture.getState().fs.batch);
      await route.fulfill({json: {ok: true, result: {...goal, maxInFlight: 3, intakeWindow: 1,
        admission: update.flow ? {mode: 'flow', maxInFlightLimit: update.maxInFlight, intakeWindowLimit: update.intakeWindow} : undefined}}});
      return;
    }
    if (url.pathname === '/api/tools/agent_defaults') {
      await route.fulfill({json: {ok: true, result: projectDefaults}});
      return;
    }
    if (url.pathname === '/api/agents/defaults') {
      if (rejectDefaultSave) {
        await route.fulfill({status: 422, json: {ok: false, error: 'Fixture rejected project defaults'}});
        return;
      }
      const update = route.request().postDataJSON();
      defaultWrites.push(update);
      projectDefaults = {...projectDefaults, ...update};
      await route.fulfill({json: {ok: true, result: projectDefaults}});
      return;
    }
    if (url.pathname === '/api/factory') {
      const snapshot = await page.evaluate(() => {
        const state = window.inspectorFixture.getState();
        return {factory: state.factory, defaultLayout: state.defaultLayout, layout: state.layout, settings: state.settings};
      });
      await route.fulfill({json: {...snapshot, agentBindings: bindingResult().bindings,
        agentDefaults: projectDefaults, model: projectDefaults.dispatcher.model, keyPresent: true}});
      return;
    }
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
      if (args.node === 'curation/capture' && exposeModelAssist) {
        const result = bindingResult();
        await route.fulfill({json: {ok: true, result: {...result, bindings: [{...result.bindings[0],
          node: args.node, mode: 'model-assist', capabilities: {...result.bindings[0].capabilities, resume: false}}]}}});
        return;
      }
      await route.fulfill({json: {ok: true, result: !args.node || args.node === 'curation/review' ? bindingResult() : {bindings: []}}});
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

  if (process.argv.includes('--message-open')) {
    for (const kernel of ['v1', 'v2']) {
      await page.goto(`http://127.0.0.1:${address.port}/test/inspector-fixture.html`);
      await page.evaluate(kernel => {
        const fixture = window.inspectorFixture;
        fixture.setState({kernel});
        for (const token of ['t1', 't2']) fixture.emit({kind: 'token.data', token,
          patch: {title: {value: 'Structured task title'}, kind: 'component-source',
            facts: {pricing: {value: 'free', sources: []}, license: {value: 'MIT', sources: []}},
            style: {applicable: true, styles: [{id: 'minimal'}]},
            copy: {takeawayZh: {value: 'A traceable result'}, descriptionZh: 'Original evidence retained'}}});
      }, kernel);
      for (let index = 0; index < 2; index++) {
        await page.locator('.feed-msg').nth(index).click();
        await page.locator('.inspector--token .chain-facts').waitFor();
        assert.match(await page.locator('.inspector--token .chain-facts').innerText(), /free.*MIT/);
        assert.match(await page.locator('.inspector--token .insp-title').innerText(), /Structured task title/);
        assert.equal(await page.locator('.inspector--node .feed-msg').count(), 2, 'the station stays mounted after clicking its conversation');
        assert.equal(await page.locator('.inspector-error').count(), 0);
        await page.locator('.inspector--token').getByRole('button', {name: '关闭详情', exact: true}).click();
      }
      await page.evaluate(() => {
        const fixture = window.inspectorFixture;
        for (const token of ['t1', 't2']) fixture.emit({kind: 'token.data', token,
          patch: {facts: {price: 'paid', license: 'Apache-2.0'}, style: {applicable: true, styles: {unexpected: true}}, copy: null}});
      });
      await page.locator('.feed-msg').first().click();
      await page.locator('.inspector--token .chain-facts').waitFor();
      assert.match(await page.locator('.inspector--token .chain-facts').innerText(), /paid.*Apache-2.0/);
      await page.screenshot({path: path.join(out, `message-open-${kernel}.png`)});
      assert.deepEqual(errors, [], 'structured facts and legacy values must never blank the workspace');
      // The local boundary also contains a future malformed record outside token.data.
      await page.evaluate(() => {
        const fixture = window.inspectorFixture, state = fixture.getState();
        const open = state.inspectors.find(item => item.kind === 'token');
        state.fs.tokens[open.key].url = {broken: true};
        fixture.setState({version: state.version + 1});
      });
      await page.locator('.inspector-error').waitFor();
      assert.equal(await page.locator('.inspector--node .feed-msg').count(), 2);
      await page.locator('.inspector-error').getByRole('button', {name: '关闭详情', exact: true}).click();
      assert.equal(await page.locator('.inspector-error').count(), 0);
      assert.equal(await page.locator('.inspector--node').count(), 1);
    }
    console.log('PASS: all station messages open structured/legacy task details on v1/v2; local errors remain closable');
  } else {
  // Inspectors must remain read-only during replay/disconnection, including staff controls.
  const addWorker = page.getByRole('button', {name: '加一个人', exact: true});
  const lockWorkers = page.getByRole('button', {name: '锁定人数', exact: true});
  await page.evaluate(() => window.inspectorFixture.setState({connected: false}));
  assert.equal(await addWorker.isDisabled(), true);
  assert.equal(await lockWorkers.isDisabled(), true);
  await page.evaluate(() => window.inspectorFixture.setState({connected: true,
    replay: {run: 'fixture-run', speed: 1, playing: false, at: Date.now(), start: 1, end: Date.now(), events: [], cursor: 0}}));
  assert.equal(await addWorker.isDisabled(), true);
  assert.equal(await lockWorkers.isDisabled(), true);
  assert.equal(workerWrites.length, 0);
  await page.evaluate(() => window.inspectorFixture.setState({replay: null}));
  holdWorkers = true;
  rejectWorkers = true;
  const workerRequest = page.waitForRequest(request => request.url().endsWith('/api/workers'));
  await addWorker.dblclick();
  await workerRequest;
  assert.equal(workerWrites.length, 1, 'double click sends one staff mutation');
  assert.equal(await lockWorkers.isDisabled(), true);
  holdWorkers = false;
  releaseWorkers();
  await page.getByRole('alert').filter({hasText: '没有增加工人'}).waitFor();
  rejectWorkers = false;
  await lockWorkers.click();
  assert.equal(await page.getByRole('alert').count(), 0, 'a new successful mutation clears the old failure');
  await page.evaluate(() => {
    const fixture = window.inspectorFixture;
    fixture.emit({kind: 'scope.paused', scope: 'line', key: 'curation', paused: true, reason: 'fixture'});
    fixture.emit({kind: 'scope.paused', scope: 'station', key: 'curation/review', paused: true, reason: 'fixture'});
  });
  await page.getByRole('button', {name: '恢复所属流水线', exact: true}).click();
  await page.waitForFunction(() => !window.inspectorFixture.getState().fs.pausedScopes.lines.includes('curation'));
  assert.equal(await page.evaluate(() => window.inspectorFixture.getState().fs.pausedScopes.stations.includes('curation/review')), true,
    'line resume cannot clear an independent station pause');
  await page.getByRole('button', {name: '恢复此工位', exact: true}).click();
  await page.waitForFunction(() => !window.inspectorFixture.getState().fs.pausedScopes.stations.includes('curation/review'));
  assert.deepEqual(scopeWrites.map(request => [request.action, request.line || request.station]),
    [['resume', 'curation'], ['resume', 'curation/review']]);

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
  assert.match(await page.getByRole('region', {name: '自动恢复策略'}).innerText(), /未单独声明.*默认恢复/s);

  const settings = page.getByRole('region', {name: '工位 Agent 配置'});
  await settings.getByLabel('执行适配器').waitFor();
  assert.equal(await settings.getByLabel('执行适配器').inputValue(), 'inherit');
  assert.match(await settings.locator('.agent-binding-effective').innerText(), /Pi · fixture-model.*本项目默认/s);
  assert.match(await settings.innerText(), /最近回报模型：last-actual-fixture-model/);
  assert.match(await settings.innerText(), /运行中也能修改.*下一次模型请求/s);
  await settings.getByLabel('本节点已接入模型').selectOption('1');
  assert.equal(await settings.getByLabel('执行适配器').inputValue(), 'pi');
  assert.equal(await settings.getByLabel('Agent provider').inputValue(), 'node-provider');
  assert.equal(await settings.getByLabel('Agent 请求模型').inputValue(), 'independent-model');
  assert.equal(savedBindings.length, 0, 'choosing a connected model stays a draft until save');
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
  assert.match(await settings.locator('.agent-binding-effective').innerText(), /Claude Code · fixture-claude.*本节点覆盖/s);
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
  for (const adapter of ['opencode', 'codex', 'claude-code']) {
    await settings.getByLabel('执行适配器').selectOption(adapter);
    assert.equal(await settings.getByLabel('Agent 请求模型').inputValue(), '');
    assert.equal(await settings.getByLabel('Agent 启动命令').inputValue(), '');
    await settings.getByRole('button', {name: '保存配置'}).click();
    await settings.getByRole('status').waitFor();
    assert.deepEqual(savedBindings.at(-1), {adapter}, 'an empty native selection keeps its own client defaults');
    assert.match(await settings.locator('.agent-binding-effective').innerText(), /客户端默认模型/);
    if (adapter === 'codex') assert.match(await settings.locator('.agent-binding-capabilities').innerText(), /仅 Token 回报，费用未知/);
  }
  await settings.getByRole('button', {name: '恢复继承'}).click();
  await page.waitForFunction(() => window.inspectorFixture.getState().agentBindings['curation/review']?.configured === null);
  await page.evaluate(() => window.inspectorFixture.setState({view: 'settings'}));
  const stationDefaults = page.getByRole('form', {name: '工位默认配置'});
  const dispatcherDefaults = page.getByRole('form', {name: '主调度配置'});
  await stationDefaults.getByLabel('工位默认已接入模型').waitFor({timeout: 5000});
  await stationDefaults.getByLabel('工位默认已接入模型').selectOption({label: 'opencode-go / Muse Spark 1.3 Contributor'});
  assert.equal(await stationDefaults.getByLabel('Agent provider').inputValue(), 'opencode-go');
  assert.equal(await stationDefaults.getByLabel('Agent 请求模型').inputValue(), 'muse-spark-1.3-contributor');
  await stationDefaults.getByRole('button', {name: '保存工位默认'}).click();
  await stationDefaults.getByRole('status').waitFor();
  assert.deepEqual(defaultWrites, [{station: {adapter: 'pi', provider: 'opencode-go', model: 'muse-spark-1.3-contributor'}}]);
  assert.equal(await dispatcherDefaults.getByLabel('Agent 请求模型').inputValue(), 'dispatcher-model');
  await dispatcherDefaults.getByLabel('主调度已接入模型').selectOption({label: 'node-provider / Independent node model'});
  assert.equal(await dispatcherDefaults.getByLabel('Agent provider').inputValue(), 'node-provider');
  assert.equal(await dispatcherDefaults.getByLabel('Agent 请求模型').inputValue(), 'independent-model');
  await dispatcherDefaults.getByLabel('Agent 请求模型').fill('next-dispatcher-model');
  await dispatcherDefaults.getByRole('button', {name: '保存主调度'}).click();
  await dispatcherDefaults.getByRole('status').waitFor();
  await page.waitForFunction(() => window.inspectorFixture.getState().model === 'next-dispatcher-model');
  assert.equal(projectDefaults.station.model, 'muse-spark-1.3-contributor');
  assert.deepEqual(Object.keys(defaultWrites[1]), ['dispatcher'], 'saving the dispatcher cannot overwrite station defaults');
  rejectDefaultSave = true;
  await stationDefaults.getByLabel('Agent 请求模型').fill('rejected-default');
  await stationDefaults.getByRole('button', {name: '保存工位默认'}).click();
  await stationDefaults.getByRole('alert').filter({hasText: 'Fixture rejected project defaults'}).waitFor();
  assert.equal(projectDefaults.station.model, 'muse-spark-1.3-contributor');
  rejectDefaultSave = false;
  await stationDefaults.getByRole('button', {name: '重新读取', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="工位默认配置"] [aria-label="Agent 请求模型"]').value === 'muse-spark-1.3-contributor');
  for (const adapter of ['opencode', 'claude-code', 'codex', 'launcher']) {
    await dispatcherDefaults.getByLabel('执行适配器').selectOption(adapter);
    if (adapter === 'launcher') {
      await dispatcherDefaults.getByLabel('Agent 启动命令').fill('["fixture-must-not-launch"]');
      await dispatcherDefaults.getByLabel('Agent 请求模型').fill('fixture-native');
    }
    await dispatcherDefaults.getByRole('button', {name: '保存主调度'}).click();
    await dispatcherDefaults.getByRole('status').waitFor();
    assert.equal(projectDefaults.dispatcher.adapter, adapter);
    assert.equal(projectDefaults.station.model, 'muse-spark-1.3-contributor', 'the dispatcher harness is independent');
    assert.match(await page.locator('.set-sec').first().innerText(), /由所选客户端管理，实际调用时验证/);
    assert.match(await dispatcherDefaults.getByRole('status').innerText(), /新对话.*当前对话及检查点保留原选择/);
  }
  await dispatcherDefaults.getByLabel('执行适配器').selectOption('pi');
  await dispatcherDefaults.getByLabel('主调度已接入模型').selectOption({label: 'opencode-go / Muse Spark 1.3 Contributor'});
  await dispatcherDefaults.getByRole('button', {name: '保存主调度'}).click();
  await dispatcherDefaults.getByRole('status').waitFor();
  await page.locator('.set-sec').first().screenshot({path: path.join(out, 'project-model-defaults.png')});
  await page.evaluate(() => {
    const fixture = window.inspectorFixture;
    const current = fixture.getState().fs;
    fixture.setState({fs: {...current, run: {...current.run, status: 'paused'},
      batch: {runId: current.run.id, target: 100, maxInFlight: 1, intakeWindow: 1, maxRecoveries: 2, mode: 'paused', startedAt: current.run.startedAt}}});
  });
  const flowSettings = page.getByRole('region', {name: '流水线流动'});
  assert.equal(await flowSettings.getByLabel('入场策略').inputValue(), 'fixed');
  await flowSettings.getByLabel('入场策略').selectOption('flow');
  assert.equal(await flowSettings.getByLabel('在途上限').inputValue(), '6');
  await flowSettings.getByRole('button', {name: '保存入场策略'}).click();
  await flowSettings.getByRole('status').waitFor();
  assert.deepEqual(admissionWrites, [{flow: true, maxInFlight: 6, intakeWindow: 2}]);
  assert.equal(await page.evaluate(() => window.inspectorFixture.getState().fs.run.status), 'paused');
  assert.equal(await page.evaluate(() => window.inspectorFixture.getState().fs.batch.mode), 'paused');
  assert.match(await flowSettings.locator('.agent-binding-effective').innerText(), /在途 3 件 · 入口 1 件/);
  await flowSettings.screenshot({path: path.join(out, 'pipeline-flow-settings.png')});
  await page.evaluate(() => {
    const fixture = window.inspectorFixture;
    const current = fixture.getState().fs;
    fixture.setState({fs: {...current, run: {...current.run, status: 'running'}, batch: undefined}});
  });
  await page.evaluate(() => window.inspectorFixture.setState({view: 'canvas'}));
  await page.evaluate(() => window.inspectorFixture.setState({inspectors: [{key: 'curation/capture', kind: 'node', x: 40, y: 40, pinned: true}]}));
  await page.getByRole('button', {name: '规格', exact: true}).click();
  await settings.getByText('程序执行，不使用 Agent 模型。').waitFor();
  assert.equal(await settings.getByLabel('执行适配器').count(), 0, 'programs never show a fake Agent selector');
  exposeModelAssist = true;
  await settings.getByRole('button', {name: '重新读取配置'}).click();
  await settings.getByText('程序的模型辅助', {exact: true}).waitFor();
  assert.match(await settings.innerText(), /程序完成采集.*模型辅助/);
  assert.equal(await settings.getByLabel('执行适配器').count(), 1, 'program helpers expose their own model executor');
  assert.match(await settings.locator('.agent-binding-capabilities').innerText(), /续接 不支持/);
  const policyDetails = page.getByRole('region', {name: '自动恢复策略'});
  assert.match(await policyDetails.innerText(), /网络超时.*最多 5 次.*首次 2 秒.*×2.*最长 30 秒.*±20%.*60 秒.*暂停.*转人工复核/s);
  assert.equal(await policyDetails.locator('input, select, button').count(), 0, 'policy details are read-only');
  await policyDetails.screenshot({path: path.join(out, 'recovery-policy.png')});

  await page.evaluate(() => window.inspectorFixture.setState({view: 'board'}));
  await page.getByRole('button', {name: '完整文字判定：查看完整证据'}).click();
  await page.locator('.evidence-document pre').filter({hasText: 'FULL-EVIDENCE-NOT-IN-SUMMARY'}).waitFor();
  assert.equal(await page.evaluate(() => window.inspectorFixture.getState().fs.evidence.evtext.meta.rawText), undefined);
  await page.screenshot({path: path.join(out, 'lazy-evidence.png')});
  await page.getByRole('button', {name: '关闭', exact: true}).click();
  const recoveryPlan = {version: 1, runId: 'fixture-run', kind: 'network', state: 'waiting', station: 'curation/capture',
    nextAt: Date.now() + 60000, networkAttempts: 0, modelFailures: 0, failureAttempt: 'fixture-timeout', reason: '原网页连接超时'};
  await page.evaluate(plan => {
    const fixture = window.inspectorFixture;
    fixture.emit({kind: 'token.created', token: 'recovering', item: '恢复状态验收', line: 'curation', source: 'fixture', url: ''});
    fixture.emit({kind: 'token.finished', token: 'recovering', node: plan.station, status: 'parked', reason: '原网页连接超时'});
    fixture.emit({kind: 'token.data', token: 'recovering', patch: {__runtimeRecovery: plan}});
    fixture.setState({view: 'canvas', inspectors: [{key: plan.station, kind: 'node', x: 40, y: 40, pinned: true}]});
  }, recoveryPlan);
  await page.locator('[data-station-status="等待自动恢复"]').waitFor();
  assert.match(await page.locator('[data-station-status]').innerText(), /0 次.*未记录上限.*当前排队 0/);
  await page.evaluate(() => window.inspectorFixture.emit({kind: 'run.paused', runId: 'fixture-run'}));
  await page.locator('[data-station-status="已暂停"]').waitFor();
  assert.doesNotMatch(await page.locator('[data-station-status]').innerText(), /秒后/);
  await page.evaluate(plan => {
    const fixture = window.inspectorFixture;
    fixture.emit({kind: 'run.resumed', runId: 'fixture-run'});
    fixture.emit({kind: 'token.data', token: 'recovering', patch: {__runtimeRecovery: {...plan, state: 'exhausted', nextAt: 0, networkAttempts: 2, reason: '两次恢复后原网页仍超时'}}});
  }, recoveryPlan);
  await page.locator('[data-station-status="自动恢复次数耗尽"]').waitFor();
  assert.match(await page.locator('[data-station-status]').innerText(), /两次恢复后原网页仍超时/);
  await page.evaluate(() => window.inspectorFixture.setState({inspectors: [{key: 'recovering', kind: 'token', x: 40, y: 40, pinned: true}]}));
  await page.locator('[data-token-status="自动恢复次数耗尽"]').waitFor();
  await page.screenshot({path: path.join(out, 'recovery-state.png')});
  await page.evaluate(() => window.inspectorFixture.emit({kind: 'token.finished', token: 'recovering', node: 'curation/published', status: 'published', reason: '已核验的发布结果'}));
  await page.locator('[data-token-status="已发布"]').waitFor();
  await page.evaluate(() => {
    const fixture = window.inspectorFixture;
    const policy = fixture.getState().factory.nodes.find(node => node.key === 'curation/capture').recovery;
    fixture.emit({kind: 'token.created', token: 'policy-recovery', item: 'policy-recovery', line: 'curation', source: 'fixture', url: ''});
    fixture.emit({kind: 'token.finished', token: 'policy-recovery', node: 'curation/capture', status: 'parked', reason: '等待恢复策略'});
    fixture.emit({kind: 'token.data', token: 'policy-recovery', patch: {__runtimeRecovery: {
      version: 1, runId: 'fixture-run', kind: 'network', state: 'waiting', station: 'curation/capture',
      nextAt: Date.now() + 20000, networkAttempts: 1, modelFailures: 0, failureAttempt: 'custom-timeout',
      startedAt: Date.now(), deadlineAt: Date.now() + 60000, attempts: 3, policy,
    }}});
    fixture.setState({inspectors: [{key: 'policy-recovery', kind: 'token', x: 40, y: 40, pinned: true}]});
  });
  await page.locator('[data-token-status="等待自动恢复"]').waitFor();
  assert.match(await page.locator('[data-token-status]').innerText(), /3\/5 次.*截止.*墙钟.*暂停/);
  await page.evaluate(() => {
    const fixture = window.inspectorFixture;
    fixture.emit({kind: 'run.paused', runId: 'fixture-run'});
    const plan = fixture.fullState.tokens['policy-recovery'].data.__runtimeRecovery;
    fixture.emit({kind: 'token.data', token: 'policy-recovery', patch: {__runtimeRecovery: {...plan, deadlineAt: Date.now() - 1}}});
  });
  await page.locator('[data-token-status="恢复已暂停"]').filter({hasText: '恢复期限已到'}).waitFor();
  assert.match(await page.locator('[data-token-status]').innerText(), /恢复期限已到/);
  await page.evaluate(() => window.inspectorFixture.emit({kind: 'run.resumed', runId: 'fixture-run'}));
  await page.locator('[data-token-status="恢复期限已到"]').waitFor();
  assert.equal(await page.evaluate(() => window.inspectorFixture.getState().fs.tokens['policy-recovery'].status), 'parked');

  await page.evaluate(() => {
    const fixture = window.inspectorFixture;
    for (const [item, title, disposition] of [['manual-one', '需核查一', 'manual'], ['manual-two', '需核查二', 'manual'], ['retry-one', '网络待重试', 'retry']]) {
      fixture.emit({kind: 'token.created', token: item, item, title, line: 'curation', source: 'fixture', url: `https://fixture.test/${item}`});
      fixture.emit({kind: 'token.finished', token: item, node: disposition === 'manual' ? 'curation/manual' : 'curation/capture',
        status: disposition === 'manual' ? 'manual' : 'parked', reason: '保留原有证据'});
      fixture.emit({kind: 'candidate.disposition', candidate: {item, token: item, title, source: 'fixture',
        url: `https://fixture.test/${item}`, disposition, recoveryStation: 'curation/capture',
        failure: {tag: disposition === 'manual' ? 'tool_error' : 'network_timeout', category: 'system',
          owner: 'system', retryable: true, message: '保留原有证据，核查故障后从原工位继续'}}});
    }
    fixture.emit({kind: 'token.created', token: 'quality-manual', item: 'quality-manual', title: '质量审查待人工', line: 'curation', source: 'fixture', url: ''});
    fixture.emit({kind: 'token.finished', token: 'quality-manual', node: 'curation/manual', status: 'manual', reason: '需要用户质量判断'});
    fixture.setState({view: 'candidates'});
  });
  await page.getByRole('button', {name: '恢复待人工 2', exact: true}).click();
  assert.equal(candidateRetries.length, 0, 'opening the manual group must not execute anything');
  assert.equal(await page.getByRole('button', {name: '选择人工项后继续', exact: true}).isDisabled(), true);
  assert.match(await page.locator('.candidate-recovery').innerText(), /不含任务与证据板中的质量审查待人工项/);
  assert.equal(await page.getByLabel('选择 质量审查待人工', {exact: true}).count(), 0);
  assert.match(await page.locator('.recovery-row').first().innerText(), /恢复工位：截图程序 · curation\/capture/);
  await page.getByLabel('选择 需核查一', {exact: true}).check();
  rejectCandidateRetry = true;
  holdCandidateRetry = true;
  const manualRequest = page.waitForRequest(request => request.url().endsWith('/api/candidates/retry'));
  await page.getByRole('button', {name: '继续已选 1 件原工位', exact: true}).dblclick();
  await manualRequest;
  assert.equal(candidateRetries.length, 1, 'a double click cannot submit the manual continuation twice');
  assert.equal(await page.getByRole('button', {name: '正在取出…', exact: true}).isDisabled(), true);
  assert.equal(await page.getByLabel('选择 需核查一', {exact: true}).isChecked(), true);
  holdCandidateRetry = false;
  releaseCandidateRetry();
  await page.getByRole('alert').filter({hasText: 'Fixture checkpoint is temporarily unavailable'}).waitFor();
  assert.equal(await page.getByLabel('选择 需核查一', {exact: true}).isChecked(), true, 'a rejected request preserves the explicit choice');
  assert.deepEqual(candidateRetries[0], {count: 1, tokens: ['manual-one'], includeManual: true});
  rejectCandidateRetry = false;
  await page.getByRole('button', {name: '继续已选 1 件原工位', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已从原工位继续 1 件'}).waitFor();
  assert.deepEqual(candidateRetries[1], candidateRetries[0], 'manual continuation never expands to unselected items');
  await page.getByLabel('选择 需核查二', {exact: true}).check();
  await page.evaluate(() => window.inspectorFixture.setState({connected: false}));
  assert.equal(await page.getByRole('button', {name: '继续已选 1 件原工位', exact: true}).isDisabled(), true);
  assert.equal(await page.getByLabel('选择 需核查二', {exact: true}).isDisabled(), true);
  await page.evaluate(() => window.inspectorFixture.setState({connected: true,
    replay: {run: 'fixture-run', speed: 1, playing: false, at: Date.now(), start: 1, end: Date.now(), events: [], cursor: 0}}));
  assert.equal(await page.getByRole('button', {name: '继续已选 1 件原工位', exact: true}).isDisabled(), true);
  assert.match(await page.locator('.candidate-recovery').innerText(), /回放为只读/);
  assert.equal(candidateRetries.length, 2);
  await page.evaluate(() => window.inspectorFixture.setState({replay: null}));
  await page.getByLabel('失败原因标签').selectOption('network_timeout');
  assert.equal(await page.getByRole('button', {name: '选择人工项后继续', exact: true}).isDisabled(), true);
  await page.getByRole('button', {name: '待重试 1', exact: true}).click();
  await page.getByRole('button', {name: '重试当前筛选 1 件', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已从原工位继续 1 件'}).waitFor();
  assert.deepEqual(candidateRetries[2], {count: 1, tokens: ['retry-one'], tag: 'network_timeout'});
  assert.equal(calls.includes('/api/tools/retry_candidates'), false, 'both paths use the authorized user route');
  await page.getByLabel('失败原因标签').selectOption('');
  await page.getByRole('button', {name: '恢复待人工 2', exact: true}).click();
  await page.screenshot({path: path.join(out, 'manual-recovery.png')});
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

  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.goto(`http://127.0.0.1:${address.port}/test/inspector-fixture.html?canvas=1`);
  const canvas = page.getByRole('region', {name: '工作流画布'});
  await canvas.waitFor();
  await page.evaluate(() => window.inspectorFixture.setState({connected: false}));
  assert.equal(await page.getByRole('button', {name: '投料', exact: true}).isDisabled(), true);
  assert.equal(await page.getByRole('button', {name: '暂停', exact: true}).isDisabled(), true);
  assert.equal(await page.getByRole('button', {name: '结束本轮', exact: true}).isDisabled(), true);
  await page.evaluate(() => {
    const fixture = window.inspectorFixture;
    const fs = fixture.getState().fs;
    fixture.setState({connected: true, fs: {...fs, nodes: {...fs.nodes,
      'candidates/pool': {...fs.nodes['curation/capture'], key: 'candidates/pool', stock: 5}}}});
  });
  await page.getByRole('button', {name: '投料', exact: true}).click();
  const pullRequest = page.waitForRequest(request => request.url().endsWith('/api/pull'));
  await page.getByRole('button', {name: '取货并开始', exact: true}).dblclick();
  await pullRequest;
  assert.equal(pullWrites.length, 1, 'double-clicking intake cannot submit the same batch twice');
  assert.equal(await page.getByRole('button', {name: '正在取货…', exact: true}).isDisabled(), true);
  releasePull();
  await page.getByRole('alert').filter({hasText: '当前分类没有可取出的候选'}).waitFor();
  assert.equal(await page.locator('.pull-card').count(), 1, 'empty intake does not pretend work has started or discard the form');
  await page.getByRole('button', {name: '取消', exact: true}).click();
  const node = page.locator('[data-node="curation/review"]');
  await node.focus();
  await node.press('Enter');
  await page.locator('[data-inspector="curation/review"]').waitFor();
  await node.press('Shift+Space');
  assert.deepEqual(await page.evaluate(() => window.inspectorFixture.getState().selected), ['curation/review']);
  const transform = () => page.locator('.cv-world').evaluate(element => element.style.transform);
  const originalTransform = await transform();
  await canvas.evaluate(element => {
    for (const key of ['f', 'w', '0', '+', '-']) {
      element.dispatchEvent(new KeyboardEvent('keydown', {key, ctrlKey: true, bubbles: true}));
      element.dispatchEvent(new KeyboardEvent('keydown', {key, metaKey: true, bubbles: true}));
    }
    for (const tag of ['select', 'div']) {
      const input = document.createElement(tag);
      if (tag === 'div') input.contentEditable = 'true';
      element.append(input);
      input.dispatchEvent(new KeyboardEvent('keydown', {key: '0', bubbles: true}));
      input.remove();
    }
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    element.append(dialog);
    dialog.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    dialog.remove();
  });
  assert.equal(await transform(), originalTransform, 'editing and host shortcuts cannot move the canvas');
  assert.equal(await page.locator('[data-inspector="curation/review"]').count(), 1,
    'Escape owned by another dialog must not close the station inspector');
  await canvas.focus();
  await canvas.press('Escape');
  assert.equal(await page.locator('.inspector').count(), 0);
  await page.evaluate(() => window.inspectorFixture.setState({follow: true}));
  await page.getByRole('button', {name: '放大画布', exact: true}).click();
  assert.equal(await page.evaluate(() => window.inspectorFixture.getState().follow), false);
  await canvas.focus();
  await canvas.press('0');
  assert.equal(await page.locator('.ctl-zoom').innerText(), '100%');
  const blank = await canvas.evaluate(element => {
    const box = element.getBoundingClientRect();
    for (let y = box.top + 180; y < box.bottom - 100; y += 45) {
      for (let x = box.left + 16; x < box.right - 16; x += 45) {
        const target = document.elementFromPoint(x, y);
        if (element.contains(target) && !target.closest('[data-node], [data-capsule], .inspector, .hud, .controls, .minimap, .replay-bar, button')) return {x, y};
      }
    }
    throw new Error('Fixture has no blank canvas location');
  });
  await page.mouse.move(blank.x, blank.y);
  await page.mouse.down({button: 'middle'});
  await page.mouse.move(blank.x + 20, blank.y + 20);
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel')));
  const cancelledPan = await transform();
  await page.mouse.move(blank.x + 70, blank.y + 70);
  assert.equal(await transform(), cancelledPan, 'cancelled pointer gestures cannot keep panning');
  await page.mouse.up({button: 'middle'});
  await page.mouse.move(blank.x, blank.y);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(blank.x + 15, blank.y + 15);
  assert.equal(await page.locator('.marquee').count(), 1);
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel')));
  assert.equal(await page.locator('.marquee').count(), 0, 'pointer cancellation clears the selection rectangle');
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.evaluate(() => {
    const fixture = window.inspectorFixture;
    const at = fixture.getState().fs.attempts.a2.startedAt + 5000;
    fixture.setState({inspectors: [{key: 'curation/review', kind: 'node', x: 20, y: 20, pinned: false}],
      replay: {run: 'fixture-run', speed: 1, playing: false, at, start: 1, end: Date.now(), events: [], cursor: 0}});
  });
  await page.locator('.crew-row').nth(1).click();
  assert.equal(await page.locator('.wt-input .num').innerText(), '5.0s', 'history uses the replay position for ongoing attempt duration');
  await page.evaluate(() => window.inspectorFixture.setState({replay: null}));
  await page.evaluate(() => {
    const fixture = window.inspectorFixture;
    fixture.emit({kind: 'attempt.finished', attempt: 'a2', ok: true, summary: '原生用量回执', ms: 1000,
      metrics: {usageReported: true, tokenUsage: {input: 84, output: 16}, costReported: false}});
    fixture.setState({inspectors: [{key: 'curation/review', kind: 'node', x: 20, y: 20, pinned: false}]});
  });
  await page.locator('.crew-row').nth(1).click();
  assert.match(await page.locator('.wt-foot').innerText(), /100 tok/);
  await page.getByRole('button', {name: '统计', exact: true}).click();
  assert.match(await page.locator('.node-metrics-row').last().innerText(), /1,284 tok.*316 tok/s,
    'token-only model receipts are included in station input/output totals');
  await page.evaluate(() => {
    const fixture = window.inspectorFixture;
    fixture.setState({factory: {...fixture.getState().factory, nodes: []}});
  });
  assert.equal(await page.locator('.inspector').count(), 0, 'a removed station cannot crash its stale inspector');
  assert.deepEqual(errors, [], `页面不能有运行时错误：${errors.join(" | ")}`);
  console.log(`PASS: isolated station card checks, screenshot in ${path.relative(process.cwd(), out)}`);
  }
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
