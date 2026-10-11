import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";

test("an over-height Storybook render root yields a complete bounded component group", { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-storybook-groups-"));
  process.env.FACTORY_VAR = root;
  const { findStage, shoot } = await import("../packs/vislexicon/capture.ts");
  const { openPage, closeBrowser } = await import("../server/browser.ts");
  const groups = Array.from({ length: 4 }, (_, i) => `<section class="sample-group"><div class="group-heading">Complete group ${i + 1}</div><ul>${Array.from({ length: 8 }, (_, j) => `<li>Item ${j + 1}</li>`).join("")}</ul><div class="group-end">End of this group</div></section>`).join("");
  const style = '<style>*{box-sizing:border-box}body{margin:42px}.story-shell{display:flex;flex-direction:column;gap:16px;width:1196px}.sample-group{height:425px;width:1196px;flex-shrink:0;background:white}.group-heading{height:48px;background:rgb(29,78,216);color:white}ul{margin:0;padding:0;list-style:none}li{height:44px;border-bottom:1px solid #ddd}.group-end{height:25px;background:rgb(24,132,72);color:white}</style>';
  const fixture = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const body = req.url === "/legacy" ? `<div id="root"><div class="sb-story"><div class="story-shell">${groups}</div></div></div>` : `<div id="storybook-root"><div><div class="story-shell">${groups}</div></div></div>`;
    res.end(`<!doctype html><title>Story fixture</title>${style}${body}`);
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  try {
    const { page, close } = await openPage();
    try {
      for (const url of [base, `${base}/legacy`]) await t.test(`selects one whole group from ${url.endsWith("legacy") ? ".sb-story" : "#storybook-root"}`, async () => {
        await page.goto(url);
        const rootBox = await page.locator(url.endsWith("legacy") ? ".sb-story" : "#storybook-root").boundingBox();
        assert.equal(rootBox?.height, 1748);
        const stage = await findStage(page);
        assert.ok(stage, "rendered component groups inside a real story root must be discoverable");
        assert.equal(stage.w, 1196); assert.equal(stage.h, 425); assert.equal(stage.y, 42);
        assert.equal(stage.sel, "storybook-component-group");
        const png = await shoot(page, { x: stage.x, y: stage.y, width: stage.w, height: stage.h });
        assert.equal(png.readUInt32BE(16), 1196); assert.equal(png.readUInt32BE(20), 425);
        const pixel = (y: number) => [...execFileSync("ffmpeg", ["-loglevel", "error", "-f", "image2pipe", "-i", "pipe:0", "-vf", `crop=1:1:1000:${y}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { input: png })];
        assert.deepEqual(pixel(20), [29, 78, 216], "the group header is included");
        assert.deepEqual(pixel(410), [24, 132, 72], "the complete group footer is included, not a row fragment");
      });
      await t.test("ordinary tall docs and story prose/code do not gain new stage eligibility", async () => {
        const prose = Array.from({ length: 4 }, () => '<article style="height:425px"><h2>Documentation</h2><p>Explanation of how this API works.</p><pre>example source code</pre></article>').join("");
        for (const tag of ['<main class="preview-document">', '<div id="storybook-root">']) {
          await page.setContent(`${style}${tag}${prose}${tag.startsWith("<main") ? "</main>" : "</div>"}`);
          assert.equal(await findStage(page), null);
        }
      });
      await t.test("an oversized single list is not fragmented into rows", async () => {
        await page.setContent(`${style}<div id="storybook-root"><ul>${Array.from({ length: 40 }, (_, i) => `<li><span>Row ${i}</span><button>Action</button></li>`).join("")}</ul></div>`);
        assert.equal(await findStage(page), null);
      });
    } finally { await close(); }
  } finally {
    await closeBrowser(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), "easy-workflow-storybook-groups-")));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
