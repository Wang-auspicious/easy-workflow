// Run: node ui/test/chat-browser.mjs. All API requests and SSE events are isolated.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const server = await createServer({ configFile: path.resolve("ui/vite.config.ts"), logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });
await server.listen();
const address = server.httpServer.address();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const out = path.resolve("var/verification/chat-recovery");
await fs.mkdir(out, { recursive: true });
const posts = [], errors = [];
let failNextChat = false;
let failNextQuota = false;
let failNextCatalog = false;
let failNextCorrection = true;
let failNextSession = false;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    class FixtureEventSource {
      constructor() { window.fixtureEvents = this; this.handlers = new Map(); queueMicrotask(() => this.onopen?.({})); }
      addEventListener(name, fn) { this.handlers.set(name, fn); }
      close() {}
      live(data) { this.handlers.get("live")?.({ data: JSON.stringify(data) }); }
    }
    window.EventSource = FixtureEventSource;
  });
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON();
    posts.push({ path: url.pathname, body });
    if (url.pathname === '/api/correct' && process.argv.includes('--review')) {
      if (failNextCorrection) {failNextCorrection = false; await route.fulfill({json: {ok: false, results: [{ok: false, message: '这次退回未执行，意见已保留'}]}}); return;}
      await page.evaluate(id => {
        const state = window.chatFixture.getState();
        state.fs.tokens[id].status = 'active'; state.fs.tokens[id].at = ['curation/proof'];
        window.chatFixture.setState({version: state.version + 1});
      }, body.items[0].token);
      await route.fulfill({json: {ok: true, results: [{ok: true}]}}); return;
    }
    if (url.pathname === '/api/tools/inspect' && process.argv.includes('--review')) {
      const token = await page.evaluate(id => window.chatFixture.getState().fs.tokens[id], body.token);
      await route.fulfill({json: {ok: true, result: token}}); return;
    }
    if (url.pathname === '/api/chat/session') {
      if (failNextSession) {failNextSession = false; await route.abort('failed'); return;}
      const session = await page.evaluate(id => ({id, after: window.chatFixture.getState().fs.conversation.at(-1)?.id ?? null, at: Date.now()}), body.requestId);
      await route.fulfill({json: {ok: true, session, status: {turn: '', status: 'idle', busy: false, attempt: 0, maxAttempts: 3, recoverable: false, message: '新对话已就绪', updatedAt: Date.now()}}});
      return;
    }
    if (url.pathname === '/api/settings') {
      if (failNextQuota) {failNextQuota = false; await route.fulfill({status: 400, json: {error: '配额未保存，fixture 拒绝'}}); return;}
      const settings = await page.evaluate(values => ({...window.chatFixture.getState().settings, ...values}), body);
      await route.fulfill({json: {ok: true, settings}});
      return;
    }
    if (url.pathname === '/api/tools/workflow_templates') {
      if (failNextCatalog) {failNextCatalog = false; await route.fulfill({status: 503, json: {error: '模板暂不可用'}}); return;}
      await route.fulfill({json: {ok: true, result: {templates: [], installed: []}}});
      return;
    }
    if (url.pathname === '/api/tools/source_list') {
      await route.fulfill({json: {ok: true, result: {sources: [], targets: []}}});
      return;
    }
    if (url.pathname === '/api/tools/choose_preview_page') {
      await route.fulfill({json: {ok: false, summary: '当前条目无法从所选工位恢复'}});
      return;
    }
    if (url.pathname === "/api/chat" && failNextChat) { failNextChat = false; await route.abort("failed"); return; }
    if (url.pathname === "/api/browser") { await route.fulfill({ json: await page.evaluate(() => window.chatFixture.getState().browser) }); return; }
    await route.fulfill({ json: { ok: true, queued: true, result: { cleared: false, resumed: false, message: "检查完成，当前原因仍需处理。" } } });
  });
  await page.goto(`http://127.0.0.1:${address.port}/test/chat-fixture.html`);
  await page.locator('.talk-row').filter({has: page.getByText('主调度', {exact: true})}).click();
  await page.locator('.chat-status').filter({hasText: '正在自动恢复'}).waitFor();
  // 顶部那块（批次卡片 / 注意力提示 / 运行记录）已经去掉：批次控制在工作区工具条上，
  // 工位提示作为对话行出现，不再重复一份。
  assert.equal(await page.locator(".batch-outcome").count(), 0);
  assert.equal(await page.locator(".chat-activity").count(), 0);
  await page.getByText("已核对这批网站的状态。现有图片和已经完成的工具结果已保留，接下来从失败工位继续。", { exact: true }).waitFor();
  assert.equal(await page.getByText("已停止回答", { exact: true }).count(), 0);
  assert.equal(await page.locator(".pi-conversation .pi-turn-notice").count(), 1);

  // 右侧栏现在按 Grok Bot 的转录样式渲染：每行一只小人 + 说的人 + 时间 + 状态。
  // 思考折叠 + 工具卡片：调用与结果配对显示，中文标签来自同一份工具名表。
  assert.equal(await page.locator(".tr-think").count(), 1);
  assert.equal(await page.locator(".tr-tool").count(), 2);
  assert.match(await page.locator(".tr-tool--done summary").innerText(), /查看运行状态/);
  await page.locator(".tr-tool--done summary").click();
  assert.match(await page.locator(".tr-tool--done .tr-tool-body").innerText(), /调用参数.*返回结果.*blocked/s);
  assert.equal(await page.locator(".tr-row--user").count(), 1);
  assert.equal(await page.locator(".tr-row--dispatcher").count(), 4);
  assert.equal(await page.locator('.tr-row--station').count(), 0, 'station broadcasts belong in their own rooms, not the dispatcher conversation');
  // 小人：形状取自 Grok Bot 的曲线数据，动作用状态类；主调度此刻在恢复，应该是 wait。
  assert.equal(await page.locator(".tr .gavatar").count(), 4, "每条由 Agent 发出的消息一只小人");
  assert.equal(await page.locator(".tr-av-pick img").count(), 1, "你自己的消息用你选的头像图");
  assert.equal(await page.locator(".chat-head .gavatar").count(), 1, "栏头的头像与对话里的是同一套");
  assert.equal(await page.locator(".tr-row--dispatcher .gavatar--wait").count(), 4);
  // 思考只占一小块，自己在里面滚；报错的工具卡片不自动展开。
  const think = await page.locator(".tr-think-body").first().evaluate((el) => ({ overflow: getComputedStyle(el).overflowY, max: getComputedStyle(el).maxHeight }));
  assert.equal(think.overflow, "auto");
  assert.match(think.max, /px$/);
  assert.equal(await page.locator(".tr-tool--error").count(), 1, "被中止的调用要有一条");
  assert.equal(await page.locator(".tr-tool--error[open]").count(), 0, "报错不自动展开，避免刷屏");
  assert.match(await page.locator(".tr-tool-reason").innerText(), /没有返回结果/);
  // 一次收起/展开所有工具卡片。
  const toolTotal = await page.locator(".tr-tool").count();
  await page.getByRole("button", { name: "全部收起" }).click();
  assert.equal(await page.locator(".tr-tool[open]").count(), 0);
  await page.getByRole("button", { name: "全部展开" }).click();
  assert.equal(await page.locator(".tr-tool[open]").count(), toolTotal);
  await page.getByRole("button", { name: "全部收起" }).click();
  // 头像自选：点开菜单换一张。
  await page.locator(".tr-av-pick > button").click();
  await page.locator(".tr-av-menu button", { hasText: "Dijkstra" }).click();
  assert.match(await page.locator(".tr-av-pick img").getAttribute("src"), /dijkstra\.svg$/);
  assert.equal(await page.locator(".tr-av-menu").count(), 0);
  const shapeLength = await page.locator(".tr-row--dispatcher .gavatar path").first().getAttribute("d");
  assert.ok((shapeLength ?? "").length > 100, "小人形状是真实的曲线数据，不是占位图");
  const avatarBox = await page.locator(".tr-row--dispatcher .gavatar").first().boundingBox();
  assert.ok(avatarBox && avatarBox.width >= 30 && avatarBox.height >= 30, "小人要真的占位，不能被压扁");
  await page.screenshot({ path: path.join(out, "transcript-1440.png") });

  const input = page.locator(".composer textarea");
  if (process.argv.includes('--review')) {
    await page.evaluate(() => {
      const state = window.chatFixture.getState();
      state.factory.nodes.push({...state.factory.nodes[0], key: 'curation/proof', name: '特写摄影'}, {...state.factory.nodes[0], key: 'curation/facts', name: '事实核验'});
      state.fs.tokens = {};
      const reasons = ['特写中主体被导航遮挡，需要换一张组件预览。', '许可条款没有可核对的出处，需要补充事实来源。', '公开页面连接超时，已有证据保留。'];
      for (let i = 0; i < 9; i++) {
        state.fs.tokens[`review-${i}`] = {id: `review-${i}`, line: 'curation', item: `review-${i}`, title: ['Forma 组件与设计系统', 'Editorial 素材库', 'Canvas 工具集'][i % 3] + (i > 2 ? ` ${i}` : ''), url: `https://review-${i}.example.test`, status: 'manual', at: ['curation/manual'], attempts: [], evidence: [], rounds: {}, corrections: 0, source: 'fixture', createdAt: i, reason: reasons[i % 3], data: {manualReason: reasons[i % 3] + '\n\n' + '完整审查记录：保留每一项判断与原始依据。'.repeat(80) + '记录末尾仍然可读'}};
      }
      window.chatFixture.setState({view: 'review', version: state.version + 1});
    });
    await page.getByRole('heading', {name: '暂时没有需要你决定的事'}).waitFor();
    assert.equal(await page.locator('.rv-queue-item').count(), 0, 'technical repairs do not occupy the owner decision queue');
    await page.getByRole('button', {name: /Agent 待修复\s*9/}).click();
    await page.locator('.rv-queue-item').first().waitFor();
    assert.equal(await page.locator('.rv-queue-item').count(), 9);
    assert.equal(await page.locator('.rv-context[open]').count(), 0);
    assert.ok((await page.locator('.rv-decision p').innerText()).length < 150);
    await page.getByRole('button', {name: /截图与页面\s*3/}).click();
    assert.equal(await page.locator('.rv-queue-item').count(), 3);
    await page.getByLabel('修改意见', {exact: true}).fill('待核对：先保留这条人工意见');
    await page.getByRole('button', {name: '稍后处理', exact: true}).click();
    assert.equal(await page.locator('.rv-queue-item').count(), 2);
    await page.getByRole('button', {name: /稍后处理\s*1/}).click();
    assert.equal(await page.locator('.rv-queue-item').count(), 1);
    assert.equal(await page.getByLabel('修改意见', {exact: true}).inputValue(), '待核对：先保留这条人工意见', 'deferring and returning keeps the human draft');
    await page.getByRole('button', {name: '移回待审队列', exact: true}).click();
    await page.getByRole('button', {name: /全部\s*9/}).click();
    await page.getByLabel('搜索待审条目').fill('Forma');
    assert.equal(await page.locator('.rv-queue-item').count(), 3);
    await page.getByLabel('搜索待审条目').fill('');
    await page.locator('.rv-queue-item').first().click();
    await page.locator('.rv-context summary').click();
    await page.getByText(/记录末尾仍然可读/).waitFor();
    await page.locator('.rv-context summary').click();
    await page.getByRole('button', {name: '请主调度帮我看', exact: true}).click();
    assert.match(await input.inputValue(), /请实际修复待审任务 review-0/);
    assert.equal(await page.evaluate(() => window.chatFixture.getState().attachments[0].id), 'review-0');
    await page.getByLabel('退回工位').selectOption('curation/proof');
    await page.getByRole('button', {name: '换成可见的组件示例，避开文档文字和导航。', exact: true}).click();
    await page.getByRole('button', {name: '退回并看下一件', exact: true}).click();
    await page.getByRole('alert').filter({hasText: '这次退回未执行'}).waitFor();
    assert.match(await page.getByLabel('修改意见', {exact: true}).inputValue(), /可见的组件示例/);
    assert.equal(await page.locator('.rv-queue-item').count(), 9);
    await page.getByRole('button', {name: '退回并看下一件', exact: true}).click();
    await page.waitForFunction(() => document.querySelectorAll('.rv-queue-item').length === 8);
    assert.equal(posts.filter(post => post.path === '/api/correct').length, 2);
    assert.equal(posts.find(post => post.path === '/api/correct').body.items[0].node, 'curation/proof');
    await page.screenshot({path: path.join(out, 'review-redesigned.png')});
    await page.setViewportSize({width: 1050, height: 800});
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const reviewBounds = await page.evaluate(() => {
      const queue = document.querySelector('.rv-queue').getBoundingClientRect();
      const focus = document.querySelector('.rv-focus').getBoundingClientRect();
      const workspace = document.querySelector('.workspace').getBoundingClientRect();
      return {stacked: queue.bottom <= focus.top + 1, inside: focus.right <= workspace.right + 1};
    });
    assert.ok(reviewBounds.stacked && reviewBounds.inside, JSON.stringify(reviewBounds));
    await page.screenshot({path: path.join(out, 'review-1050.png')});
    assert.deepEqual(errors, []);
    console.log('PASS: focused review, filters, full evidence, deferred queue, failure retention and successful advance');
  } else if (process.argv.includes('--clear-regression')) {
    await input.fill('/clear');
    await input.press('Enter');
    await page.waitForTimeout(100);
    assert.ok(posts.some(post => post.path === '/api/chat/session'), '/clear must start a real fresh conversation, not merely erase the input');
    await page.getByText('新对话已开启。旧记录在「历史对话」，流水线任务继续保留。', {exact: true}).waitFor();
    assert.equal(await page.locator('.tr-row--user').count(), 0);
    await page.getByRole('button', {name: '历史对话', exact: true}).click();
    await page.locator('.chat-session').filter({hasText: '把 100 个网站持续处理完'}).click();
    assert.equal(await page.locator('.tr-row--user').count(), 1, 'archived messages remain readable');
    await page.getByRole('button', {name: '回到当前对话', exact: true}).click();
    await input.fill('/clear');
    await page.getByRole('button', {name: '发送消息', exact: true}).click();
    await page.getByText('新对话已开启。旧记录在「历史对话」，流水线任务继续保留。', {exact: true}).waitFor();
    assert.equal(posts.filter(post => post.path === '/api/chat/session').length, 2, 'send button and Enter run the same command');
    failNextSession = true;
    await input.fill('/new');
    await input.press('Enter');
    await page.locator('.composer-feedback').waitFor();
    const lostSessionId = posts.at(-1).body.requestId;
    assert.equal(await input.inputValue(), '/new');
    await page.getByRole('button', {name: '收起对话', exact: true}).click();
    await page.keyboard.press('Control+k');
    await input.press('Enter');
    await page.getByText('新对话已开启。旧记录在「历史对话」，流水线任务继续保留。', {exact: true}).waitFor();
    assert.equal(posts.at(-1).body.requestId, lostSessionId, 'lost session receipt reuses the same id after sidebar reopen');
    await input.fill('/does-not-exist');
    await input.press('Enter');
    await page.getByText(/没有 \/does-not-exist 这个命令/).waitFor();
    assert.equal(posts.filter(post => post.path === '/api/chat').length, 0, 'unknown commands never leak into the model prompt');
    await input.fill('/hist');
    await input.press('Tab');
    assert.equal(await input.inputValue(), '/history');
    await input.press('Escape');
    await input.fill('/help');
    await input.press('Enter');
    await page.locator('.cmd-palette').waitFor();
    await page.screenshot({path: path.join(out, 'commands-redesigned.png')});
    console.log('clear command regression passed');
    process.exitCode = 0;
  } else {
  await input.fill("先检查连接问题");
  await page.getByRole("button", { name: "发送补充要求", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".composer .send[aria-label='发送补充要求']"));
  assert.equal(posts.at(-1).body.mode, "steer");
  assert.match(posts.at(-1).body.requestId, /^[a-f\d-]{36}$/);
  await page.getByRole("combobox", { name: "消息送达方式" }).selectOption("followUp");
  await input.fill("完成后汇总恢复次数");
  await page.getByRole("button", { name: "安排后续跟进", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".composer .send[aria-label='安排后续跟进']"));
  assert.equal(posts.at(-1).body.mode, "followUp");

  // 命令与快捷方式：输入 / 出面板，选中即执行；↑ 回溯发过的内容；Ctrl+K 直接跳进输入框。
  await input.fill("");
  await input.type("/");
  await page.locator(".cmd-palette").waitFor();
  assert.ok(await page.locator(".cmd-palette button").count() >= 8, "命令面板要列出可用命令");
  await input.fill("/sta");
  assert.equal(await page.locator(".cmd-palette button").count(), 1);
  assert.match(await page.locator(".cmd-palette button").innerText(), /问主调度现在怎么样/);
  await input.press("Escape");
  assert.equal(await page.locator(".cmd-palette").count(), 0);
  await input.fill("");
  await input.press("ArrowUp");
  assert.equal(await input.inputValue(), "完成后汇总恢复次数", "↑ 回溯上一次发送的内容");
  await input.fill("");
  await input.press("ArrowUp");
  await page.locator(".cmd-palette").count();
  await input.fill("/stop");
  await page.locator(".cmd-palette button").first().click();
  await page.waitForFunction(() => !document.querySelector(".composer .send[aria-label='停止当前回答']")?.disabled);
  assert.equal(posts.at(-1).path, "/api/chat/abort");
  await page.keyboard.press("Control+k");
  await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA", "Ctrl+K 要把光标送进输入框");
  await page.getByRole('button', {name: '收起对话', exact: true}).click();
  await page.locator('.chat.is-collapsed').waitFor();
  await page.keyboard.press("Control+k");
  await page.waitForFunction(() => !document.querySelector('.chat.is-collapsed') && document.activeElement?.tagName === "TEXTAREA", undefined, { timeout: 1500 });
  assert.equal(await input.inputValue(), "", "收起后快捷键重新展开并聚焦，不产生消息");

  await page.evaluate(() => window.fixtureEvents.onerror({}));
  await page.getByText('正在重新连接，已有回答都在', {exact: true}).waitFor();
  await input.fill("断线时保留草稿");
  assert.equal(await page.getByRole("button", { name: "安排后续跟进", exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.fixtureEvents.onopen({}); window.fixtureEvents.live({ ...window.chatFixture.getState().dispatcher, kind: "chat.status", status: "interrupted", busy: false, nextRetryAt: undefined, message: "连接已恢复，可继续检查点。" }); });
  await page.locator('.chat-status').getByRole('button', {name: '继续', exact: true}).click();
  await page.waitForFunction(() => !document.querySelector('.chat-status-act')?.disabled);
  assert.equal(posts.at(-1).path, "/api/chat/continue");
  assert.equal(await input.inputValue(), "断线时保留草稿");

  await page.evaluate(() => window.fixtureEvents.live({ ...window.chatFixture.getState().dispatcher, kind: "chat.status", status: "running", busy: true }));
  // 正在往外吐字时：主调度小人进入说话状态，正文末尾出现光标。
  await page.evaluate(() => window.fixtureEvents.live({ kind: "chat.pi", turn: window.chatFixture.getState().live.id ?? "fixture-turn", id: "live-reply", message: { role: "assistant", content: [{ type: "text", text: "正在读取工位状态" }], timestamp: Date.now(), api: "openai-completions", provider: "fixture", model: "fixture-model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
  await page.locator(".tr-row--dispatcher .gavatar--speaking").first().waitFor();
  assert.equal(await page.locator(".tr-text.is-streaming").count(), 1, "流式回答末尾要有光标");
  await page.getByRole("button", { name: "停止当前回答", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("button[aria-label='停止当前回答']")?.disabled);
  assert.equal(posts.at(-1).path, "/api/chat/abort");
  await page.evaluate(() => window.fixtureEvents.live({ ...window.chatFixture.getState().dispatcher, kind: "chat.status", status: "aborted", busy: false }));

  failNextChat = true;
  await input.fill("提交后回执丢失仍然只执行一次");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.getByText(/消息未确认送达/).waitFor();
  const firstAttempt = posts.at(-1);
  assert.equal(await input.inputValue(), firstAttempt.body.text);
  await page.getByRole('button', {name: '收起对话', exact: true}).click();
  await page.locator('.chat.is-collapsed').waitFor();
  await page.keyboard.press("Control+k");
  await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
  assert.equal(await input.inputValue(), firstAttempt.body.text, "收起对话保留未确认消息及其重试身份");
  await page.getByRole('button', {name: '所有对话', exact: true}).click();
  await page.keyboard.press('Control+k');
  assert.equal(await input.inputValue(), firstAttempt.body.text, 'switching conversations preserves the pending message');
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".composer textarea").value && !document.querySelector(".composer-feedback"));
  assert.equal(posts.at(-1).body.requestId, firstAttempt.body.requestId);

  await page.getByRole('button', {name: '需要你处理的事', exact: true}).click();
  assert.equal(await page.locator('.rail-alert .rail-badge').innerText(), '1', 'only the login task counts as a human action');
  const systemAlert = page.locator('.alert-group');
  await systemAlert.locator('summary').click();
  assert.match(await systemAlert.innerText(), /连接中断/);
  assert.ok(!(await systemAlert.innerText()).includes("请登录"));
  assert.equal(await page.getByRole("button", { name: "我已处理", exact: true }).count(), 0);
  await systemAlert.getByRole("button", { name: "重新检查", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.alert-group .alert-link')?.disabled);
  assert.deepEqual(posts.at(-1), { path: "/api/tools/alerts", body: { action: "recheck", id: "network" } });
  await page.screenshot({ path: path.join(out, "alerts-1440.png") });
  await page.locator('.alert-row').getByRole('button', {name: '打开页面'}).click();
  await page.waitForFunction(() => !document.querySelector(".alert-pop"));
  assert.deepEqual(posts.at(-1).body, { action: "activate", id: "login-tab" });

  await page.setViewportSize({ width: 1040, height: 768 });
  await page.getByRole('button', {name: '需要你处理的事', exact: true}).click();
  await page.screenshot({ path: path.join(out, "alerts-1040.png") });
  const pop = await page.locator(".alert-pop").boundingBox();
  assert.ok(pop.x >= 0 && pop.x + pop.width <= 1040 && pop.y >= 0 && pop.y + pop.height <= 768, "alert controls remain inside the window");
  await page.evaluate(() => {
    const state = window.chatFixture.getState();
    window.fixtureEvents.onmessage({ data: JSON.stringify({ kind: "alert.cleared", id: "auth", reason: "fixture access verified", seq: state.fs.seq + 1, at: Date.now(), run: state.fs.run.id }) });
  });
  await page.locator('.rail-alert.is-recovery').waitFor();
  assert.equal((await page.title()).startsWith("● "), false, "a journaled resolution updates the human-action indicator immediately");
  assert.equal(await page.locator('.alert-row').count(), 0);

  // Composer stays compact at every supported sidebar width. Test actual boxes,
  // not CSS text, while retaining the real send/recovery actions above.
  await page.waitForFunction(() => document.querySelectorAll('.toast').length === 0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    const { getState, setState } = window.chatFixture;
    setState({ draft: '', attachments: [], live: { id: null, text: '', tools: [] }, dispatcher: { ...getState().dispatcher, status: 'idle', busy: false, recoverable: false } });
  });
  for (const width of [320, 420, 720]) {
    await page.evaluate(width => {
      window.chatFixture.setState({ chatWidth: width });
      document.querySelector('.app').style.setProperty('--chat-w', `${width}px`);
    }, width);
    const box = await page.locator('.composer').evaluate(element => {
      const card = element.querySelector('.composer-box').getBoundingClientRect();
      const textarea = element.querySelector('textarea');
      return {
        width: element.getBoundingClientRect().width,
        fontSize: parseFloat(getComputedStyle(textarea).fontSize),
        cardHeight: card.height,
        fits: element.scrollWidth <= element.clientWidth,
        controls: [...element.querySelectorAll('.composer-foot button')].map(button => {
          const rect = button.getBoundingClientRect();
          return { label: button.getAttribute('aria-label'), width: rect.width, height: rect.height, inside: rect.x >= card.x && rect.right <= card.right, whiteSpace: getComputedStyle(button).whiteSpace };
        }),
      };
    });
    assert.ok(box.fits && box.fontSize <= 13 && box.cardHeight <= 105, `compact composer at ${width}px: ${JSON.stringify(box)}`);
    assert.ok(box.controls.every(button => button.inside && button.width >= 27 && button.height <= 32), `controls fit at ${width}px`);
    assert.equal(box.controls.find(button => button.label === '命令').whiteSpace, 'nowrap');
    await page.locator('.composer').screenshot({ path: path.join(out, `composer-empty-${width}.png`) });
  }

  await input.fill('这是一条还没发送的草稿');
  await page.getByRole('button', { name: '命令', exact: true }).click();
  await page.locator('.cmd-palette').waitFor();
  assert.equal(await input.inputValue(), '这是一条还没发送的草稿', 'opening commands never overwrites the draft');
  await input.press('Escape');
  await input.press('ArrowUp');
  assert.equal(await input.inputValue(), '这是一条还没发送的草稿', 'history navigation never replaces a nonempty draft');
  await input.press('Escape');
  assert.equal(await input.inputValue(), '这是一条还没发送的草稿', 'Escape preserves the draft');
  const beforeComposition = posts.length;
  await input.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  assert.equal(posts.length, beforeComposition, 'IME confirmation does not send a message');

  await page.evaluate(() => {
    const { getState, setState } = window.chatFixture;
    setState({ chatWidth: 320, live: { id: 'composer-busy', text: '', tools: [] }, dispatcher: { ...getState().dispatcher, status: 'running', busy: true }, attachments: [{ type: 'node', id: 'curation/facts', label: '事实核验 · 引用与许可范围' }] });
    document.querySelector('.app').style.setProperty('--chat-w', '320px');
  });
  await page.getByRole('combobox', { name: '消息送达方式' }).selectOption('followUp');
  await page.locator('.composer').screenshot({ path: path.join(out, 'composer-busy-320.png') });
  const busyControls = await page.locator('.composer').evaluate(element => {
    const card = element.querySelector('.composer-box').getBoundingClientRect();
    return [...element.querySelectorAll('.composer-foot button, .composer-foot select')].map(button => { const rect = button.getBoundingClientRect(); return rect.x >= card.x && rect.right <= card.right && rect.width >= 27; });
  });
  assert.ok(busyControls.every(Boolean), 'busy controls and delivery mode remain usable at 320px');
  await page.getByRole('button', { name: '移除附件：事实核验 · 引用与许可范围', exact: true }).click();
  assert.equal(await page.locator('.composer .att').count(), 0);
  await page.getByRole('button', { name: '选择证据附件', exact: true }).click();
  assert.equal(await page.evaluate(() => window.chatFixture.getState().view), 'board');
  await page.getByRole('button', { name: '命令', exact: true }).click();
  await page.locator('.cmd-palette').screenshot({ path: path.join(out, 'composer-commands-320.png') });
  await page.getByRole('option').filter({ hasText: '/status' }).click();
  await page.waitForFunction(() => !document.querySelector('.composer-feedback'));
  assert.equal(await input.inputValue(), '这是一条还没发送的草稿', 'a command can run without consuming the draft or its attachments');
  await page.evaluate(() => {
    const {getState, setState} = window.chatFixture;
    const current = getState();
    setState({fs: {...current.fs, conversation: [...current.fs.conversation, {
      id: 'native-final', turn: 'native-turn', message: {
        role: 'assistant', api: 'native-client', provider: 'unreported', model: 'fixture-native-model',
        content: [{type: 'text', text: '原生主调度已保留实际工具回执。'}], timestamp: Date.now(), stopReason: 'stop',
        native: {adapter: 'codex', usageReported: false, costReported: false},
      },
    }]}, version: current.version + 1});
  });
  await page.getByText('原生主调度已保留实际工具回执。', {exact: true}).waitFor();
  // Approval controls must never change a live factory from historical replay.
  await page.evaluate(() => {
    const {getState, setState} = window.chatFixture;
    setState({fs: {...getState().fs, patches: [{id: 'fixture-patch', summary: '新增工位', status: 'proposed', at: Date.now()}]}});
  });
  const patch = page.locator('.patch-card');
  assert.equal(await patch.getByRole('button', {name: '接受', exact: true}).isDisabled(), true, 'running workflows cannot install a patch');
  assert.equal(await patch.getByRole('button', {name: '拒绝', exact: true}).isEnabled(), true);
  await page.evaluate(() => window.chatFixture.setState({replay: {run: 'history', at: 1}}));
  assert.equal(await patch.getByRole('button', {name: '拒绝', exact: true}).isDisabled(), true, 'replay cannot reject a live patch');
  await page.evaluate(() => {
    const {getState, setState} = window.chatFixture;
    setState({replay: null, fs: {...getState().fs, run: {...getState().fs.run, status: 'ended'}, nodes: {}}});
  });
  await patch.getByRole('button', {name: '接受', exact: true}).click();
  assert.deepEqual(posts.at(-1), {path: '/api/patch', body: {id: 'fixture-patch', accept: true}});

  // Quotas retain edits after errors and only write the fields the user changed.
  await page.evaluate(() => window.chatFixture.setState({view: 'settings', settings: {
    browser: 2, model: 1, modelWorkers: 3, cpu: 2, http: 2, memoryFloorMB: 1024, socialPerMinute: 2, socialPerDay: 60,
  }}));
  const quotas = page.locator('.set-sec').filter({has: page.getByRole('heading', {name: '资源配额'})});
  await quotas.getByLabel('CPU 重活').focus();
  await quotas.getByLabel('CPU 重活').press('ArrowRight');
  await page.evaluate(() => window.chatFixture.setState({settings: {...window.chatFixture.getState().settings, model: 4}}));
  await page.waitForFunction(() => document.querySelector('input[aria-label="模型调用并发"]')?.value === '4');
  assert.equal(await quotas.getByLabel('CPU 重活').inputValue(), '3');
  failNextQuota = true;
  await quotas.getByRole('button', {name: '保存', exact: true}).click();
  await quotas.getByRole('alert').waitFor();
  assert.equal(await quotas.getByLabel('CPU 重活').inputValue(), '3', 'failed writes preserve quota edits');
  const savesBefore = posts.filter(post => post.path === '/api/settings').length;
  await quotas.getByRole('button', {name: '保存', exact: true}).evaluate(button => {
    button.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    button.dispatchEvent(new MouseEvent('click', {bubbles: true}));
  });
  await page.waitForFunction(() => window.chatFixture.getState().settings.cpu === 3);
  assert.equal(posts.filter(post => post.path === '/api/settings').length, savesBefore + 1, 'same-frame repeat clicks write once');
  assert.deepEqual(posts.filter(post => post.path === '/api/settings').at(-1).body, {cpu: 3}, 'saving one slider cannot overwrite another client settings');
  await page.evaluate(() => window.chatFixture.setState({connected: false}));
  assert.equal(await quotas.getByLabel('CPU 重活').isDisabled(), true);
  await page.evaluate(() => window.chatFixture.setState({connected: true, replay: {run: 'history', at: 1}}));
  assert.equal(await quotas.getByLabel('CPU 重活').isDisabled(), true);

  await page.evaluate(() => window.chatFixture.setState({view: 'browser'}));
  assert.equal(await page.getByRole('button', {name: '新建标签页', exact: true}).isDisabled(), true);
  await page.evaluate(() => window.chatFixture.setState({replay: null}));
  assert.equal(await page.getByRole('button', {name: '新建标签页', exact: true}).isEnabled(), true);
  await page.evaluate(() => window.chatFixture.setState({view: 'candidates', draft: '不应被失败回执替换'}));
  await page.getByText('指定目录或示例页后继续').click();
  await page.getByLabel('采集页面网址').fill('https://fixture.test/catalog');
  await page.getByRole('button', {name: '按这页继续'}).click();
  await page.getByRole('alert').filter({hasText: '当前条目无法从所选工位恢复'}).waitFor();
  assert.equal(await page.evaluate(() => window.chatFixture.getState().draft), '不应被失败回执替换', 'ok:false never emits a success message');

  failNextCatalog = true;
  await page.evaluate(() => window.chatFixture.setState({view: 'library'}));
  await page.getByRole('button', {name: '重新读取模板'}).click();
  await page.getByText('当前没有可用模板，可以安装自己的工作流包。').waitFor();
  const inputValidation = await page.evaluate(async () => {
    const {workflowInput} = await import('/src/views/workflows.ts');
    const schema = {properties: {count: {type: 'integer', minimum: 1, maximum: 4}, optional: {type: 'boolean'}, enabled: {type: 'boolean'}}, required: ['count', 'enabled']};
    const failures = ['1.5', '0', '5', ' '].map(count => {try {workflowInput(schema, {count}); return false;} catch {return true;}});
    return {failures, omitted: workflowInput(schema, {count: '2'}), explicit: workflowInput(schema, {count: '2', optional: 'false'})};
  });
  assert.deepEqual(inputValidation.failures, [true, true, true, true]);
  assert.deepEqual(inputValidation.omitted, {count: 2, enabled: false});
  assert.deepEqual(inputValidation.explicit, {count: 2, optional: false, enabled: false});
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(out, "result.json"), JSON.stringify({ ok: true, checks: ["100-site goal accounting", "partial answer retention", "automatic recovery", "steer", "followUp", "SSE reconnect after missed end", "continue checkpoint", "stop answer", "idempotent resend", "network is not login", "recheck instead of blind clear", "activate exact tab", "narrow window", "journaled alert resolution"], requests: posts, errors }, null, 2));
  console.log("PASS: isolated chat recovery and responsive composer checks, screenshots in var/verification/chat-recovery");
  }
} finally {
  await browser.close();
  await server.close();
}
