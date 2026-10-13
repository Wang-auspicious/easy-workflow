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
    if (url.pathname === "/api/chat" && failNextChat) { failNextChat = false; await route.abort("failed"); return; }
    if (url.pathname === "/api/browser") { await route.fulfill({ json: await page.evaluate(() => window.chatFixture.getState().browser) }); return; }
    await route.fulfill({ json: { ok: true, queued: true, result: { cleared: false, resumed: false, message: "检查完成，当前原因仍需处理。" } } });
  });
  await page.goto(`http://127.0.0.1:${address.port}/test/chat-fixture.html`);
  await page.getByText("正在自动恢复", { exact: true }).waitFor();
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
  assert.equal(await page.locator(".tr-row--station").count(), 2, "工位记录也要出现在对话里，带自己的小人");
  await page.getByText("候选已按来源分流，采集限额还有 6 个位置", { exact: true }).waitFor();
  // 小人：形状取自 Grok Bot 的曲线数据，动作用状态类；主调度此刻在恢复，应该是 wait。
  assert.equal(await page.locator(".tr .gavatar").count(), 6, "每条由 Agent 发出的消息一只小人");
  assert.equal(await page.locator(".tr-av-pick img").count(), 1, "你自己的消息用你选的头像图");
  assert.equal(await page.locator(".chat-head .gavatar").count(), 1, "栏头的头像与对话里的是同一套");
  assert.equal(await page.locator(".tr-row--dispatcher .gavatar--wait").count(), 4);
  assert.equal(await page.locator(".tr-row--station .gavatar--work").count(), 1, "在跑的工位小人要动起来");
  assert.equal(await page.locator(".tr-row--station .gavatar--fail").count(), 1, "刚失败的工位小人显示失败状态");
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
  const shapeLength = await page.locator(".tr-row--station .gavatar path").first().getAttribute("d");
  assert.ok((shapeLength ?? "").length > 100, "小人形状是真实的曲线数据，不是占位图");
  const avatarBox = await page.locator(".tr-row--station .gavatar").first().boundingBox();
  assert.ok(avatarBox && avatarBox.width >= 30 && avatarBox.height >= 30, "小人要真的占位，不能被压扁");
  await page.screenshot({ path: path.join(out, "transcript-1440.png") });

  const input = page.locator(".composer textarea");
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
  await page.locator('.chat-head button[data-tip^="收起到右侧"]').click();
  await page.locator('.chat.is-collapsed').waitFor();
  await page.keyboard.press("Control+k");
  await page.waitForFunction(() => !document.querySelector('.chat.is-collapsed') && document.activeElement?.tagName === "TEXTAREA", undefined, { timeout: 1500 });
  assert.equal(await input.inputValue(), "", "收起后快捷键重新展开并聚焦，不产生消息");

  await page.evaluate(() => window.fixtureEvents.onerror({}));
  await page.getByText("正在重新连接工厂", { exact: true }).waitFor();
  await input.fill("断线时保留草稿");
  assert.equal(await page.getByRole("button", { name: "安排后续跟进", exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.fixtureEvents.onopen({}); window.fixtureEvents.live({ ...window.chatFixture.getState().dispatcher, kind: "chat.status", status: "interrupted", busy: false, nextRetryAt: undefined, message: "连接已恢复，可继续检查点。" }); });
  await page.getByRole("button", { name: "继续当前任务", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".chat-recovery .btn")?.disabled);
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
  await page.locator('.chat-head button[data-tip^="收起到右侧"]').click();
  await page.locator('.chat.is-collapsed').waitFor();
  await page.keyboard.press("Control+k");
  await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
  assert.equal(await input.inputValue(), firstAttempt.body.text, "收起对话保留未确认消息及其重试身份");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".composer textarea").value && !document.querySelector(".composer-feedback"));
  assert.equal(posts.at(-1).body.requestId, firstAttempt.body.requestId);

  await page.getByRole("button", { name: "1 件需要你操作", exact: true }).click();
  assert.equal(await page.locator(".rail-alert .rail-badge").count(), 0, "system diagnostics do not inflate the human-action badge");
  const systemAlert = page.locator(".alert-item.is-recovery");
  assert.match(await systemAlert.innerText(), /连接中断/);
  assert.ok(!(await systemAlert.innerText()).includes("请登录"));
  assert.equal(await page.getByRole("button", { name: "我已处理", exact: true }).count(), 0);
  await systemAlert.getByRole("button", { name: "重新检查", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".alert-actions button")?.disabled);
  assert.deepEqual(posts.at(-1), { path: "/api/tools/alerts", body: { action: "recheck", id: "network" } });
  await page.screenshot({ path: path.join(out, "alerts-1440.png") });
  await page.locator(".alert-item:not(.is-recovery)").getByRole("button", { name: "打开对应页面" }).click();
  await page.waitForFunction(() => !document.querySelector(".alert-pop"));
  assert.deepEqual(posts.at(-1).body, { action: "activate", id: "login-tab" });

  await page.setViewportSize({ width: 1040, height: 768 });
  await page.getByRole("button", { name: "1 件需要你操作", exact: true }).click();
  await page.screenshot({ path: path.join(out, "alerts-1040.png") });
  const pop = await page.locator(".alert-pop").boundingBox();
  assert.ok(pop.x >= 0 && pop.x + pop.width <= 1040 && pop.y >= 0 && pop.y + pop.height <= 768, "alert controls remain inside the window");
  await page.evaluate(() => {
    const state = window.chatFixture.getState();
    window.fixtureEvents.onmessage({ data: JSON.stringify({ kind: "alert.cleared", id: "auth", reason: "fixture access verified", seq: state.fs.seq + 1, at: Date.now(), run: state.fs.run.id }) });
  });
  await page.getByRole("button", { name: "1 件待系统检查", exact: true }).waitFor();
  assert.equal((await page.title()).startsWith("● "), false, "a journaled resolution updates the human-action indicator immediately");
  assert.equal(await page.locator(".alert-item:not(.is-recovery)").count(), 0);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(out, "result.json"), JSON.stringify({ ok: true, checks: ["100-site goal accounting", "partial answer retention", "automatic recovery", "steer", "followUp", "SSE reconnect after missed end", "continue checkpoint", "stop answer", "idempotent resend", "network is not login", "recheck instead of blind clear", "activate exact tab", "narrow window", "journaled alert resolution"], requests: posts, errors }, null, 2));
  console.log("PASS: isolated chat recovery browser checks (14 scenarios), screenshots in var/verification/chat-recovery");
} finally {
  await browser.close();
  await server.close();
}
