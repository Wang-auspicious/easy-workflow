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
  assert.equal(await page.getByText("目标 100 个网站 · 已完成 1", { exact: true }).count(), 1);
  assert.match(await page.locator(".batch-outcome").innerText(), /已领取 20.*尚未领取 80/);
  await page.getByText("已核对这批网站的状态。现有图片和已经完成的工具结果已保留，接下来从失败工位继续。", { exact: true }).waitFor();
  assert.equal(await page.getByText("已停止回答", { exact: true }).count(), 0);
  assert.equal(await page.locator(".pi-conversation .pi-turn-notice").count(), 1);

  // 右侧栏现在按 Grok Bot 的转录样式渲染：每行一只小人 + 说的人 + 时间 + 状态。
  // 思考折叠 + 工具卡片：调用与结果配对显示，中文标签来自同一份工具名表。
  assert.equal(await page.locator(".tr-think").count(), 1);
  assert.equal(await page.locator(".tr-tool").count(), 1);
  assert.match(await page.locator(".tr-tool summary").innerText(), /查看运行状态/);
  await page.locator(".tr-tool summary").click();
  assert.match(await page.locator(".tr-tool-body").innerText(), /调用参数.*返回结果.*blocked/s);
  assert.equal(await page.locator(".tr-row--user").count(), 1);
  assert.equal(await page.locator(".tr-row--dispatcher").count(), 3);
  assert.equal(await page.locator(".tr-row--station").count(), 2, "工位记录也要出现在对话里，带自己的小人");
  await page.getByText("候选已按来源分流，采集限额还有 6 个位置", { exact: true }).waitFor();
  // 小人：形状取自 Grok Bot 的曲线数据，动作用状态类；主调度此刻在恢复，应该是 wait。
  assert.equal(await page.locator(".tr .gavatar").count(), 5, "每条由 Agent 发出的消息一只小人");
  assert.equal(await page.locator(".tr-av-user").count(), 1, "你自己的消息用人物头像");
  assert.equal(await page.locator(".chat-head .gavatar").count(), 1, "栏头的头像与对话里的是同一套");
  assert.equal(await page.locator(".tr-row--dispatcher .gavatar--wait").count(), 3);
  assert.equal(await page.locator(".tr-row--station .gavatar--work").count(), 1, "在跑的工位小人要动起来");
  assert.equal(await page.locator(".tr-row--station .gavatar--fail").count(), 1, "刚失败的工位小人显示失败状态");
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
