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
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  const calls = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url.pathname);
    if (url.pathname === "/api/tools/read_role") {
      await route.fulfill({ json: { ok: true, result: { content: "# 截图审查员\n\n只做判定，不改内容。\n\n- 输入：候选 + 证据\n- 输出：结论\n- 异常：截图失败退回采集，最多 2 轮" } } });
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

  // 统计与职责都还在：统计行照旧，规格页读到 ROLE.md。
  assert.match(await page.locator(".insp-stats").innerText(), /在岗\n2 \/ 3/);
  await page.getByRole("button", { name: "规格" }).click();
  await page.getByText("ROLE.md · 职责与异常处理").waitFor();
  assert.match(await page.locator(".node-role pre").innerText(), /只做判定，不改内容/);
  assert.ok(calls.includes("/api/tools/read_role"), "职责来自接口，不是写死的文案");

  await page.locator(".inspector").screenshot({ path: path.join(out, "station-card.png") });
  assert.deepEqual(errors, [], `页面不能有运行时错误：${errors.join(" | ")}`);
  console.log(`PASS: isolated station card checks, screenshot in ${path.relative(process.cwd(), out)}`);
} finally {
  await browser.close();
  await server.close();
}
