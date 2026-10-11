import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";

const pixel = (png: Buffer, x: number, y: number) => [...execFileSync("ffmpeg", ["-loglevel", "error", "-f", "image2pipe", "-i", "pipe:0", "-vf", `crop=1:1:${x}:${y}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { input: png })];

test("screenshots remove late cookie overlays without hiding content or bypassing access checks", { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-capture-overlay-"));
  process.env.FACTORY_VAR = root;
  const { shoot, visit } = await import("../packs/vislexicon/capture.ts");
  const { openPage, closeBrowser } = await import("../server/browser.ts");
  const fixture = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><style>body{margin:0;min-height:1100px}nav{position:sticky;top:0;width:600px;height:60px;background:rgb(20,160,40)}#demo{position:absolute;left:40px;top:100px;width:480px;height:900px;background:rgb(20,100,200)}</style><nav>Normal navigation</nav><main id="demo"><button>Real component action</button></main>');
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  try {
    const { page, close } = await openPage({ width: 600, height: 400 });
    try {
      await visit(page, url, "127.0.0.1");
      await page.evaluate(() => {
        (window as any).consentAccepted = false;
        setTimeout(() => {
          const banner = document.createElement("div"); banner.id = "late-cookie";
          banner.style.cssText = "position:fixed;bottom:0;left:0;width:100%;height:160px;background:rgb(255,0,0);z-index:9999";
          banner.innerHTML = '<p>Cookie preferences and privacy notice</p><button id="accept-consent">Accept all</button>';
          document.body.append(banner);
          document.querySelector("#accept-consent")!.addEventListener("click", () => { (window as any).consentAccepted = true; });
          window.addEventListener("scroll", () => banner.style.removeProperty("visibility"));
        }, 40);
      });
      await page.locator("#late-cookie").waitFor({ state: "visible" });
      await t.test("a cookie banner appearing after the visit cannot cover the viewport shot", async () => {
        assert.deepEqual(pixel(await page.screenshot(), 100, 300), [255, 0, 0], "the late banner really covers component pixels before capture");
        const png = await shoot(page);
        assert.deepEqual(pixel(png, 100, 300), [20, 100, 200]);
        assert.deepEqual(pixel(png, 100, 30), [20, 160, 40], "normal navigation remains visible");
        assert.equal(await page.evaluate(() => (window as any).consentAccepted), false);
        assert.equal(await page.locator("#demo").evaluate(el => getComputedStyle(el).visibility), "visible");
      });
      await t.test("every stitched tile rechecks a banner that returns after scrolling", async () => {
        const png = await shoot(page, { x: 40, y: 100, width: 480, height: 900 });
        for (const y of [150, 450, 750]) assert.deepEqual(pixel(png, 100, y), [20, 100, 200], `component pixel at stitched y=${y}`);
        assert.equal(await page.evaluate(() => (window as any).consentAccepted), false);
      });
      await t.test("a newly appearing verification wall is rejected and stays visible", async () => {
        await page.evaluate(() => { document.querySelector("#late-cookie")?.remove(); const wall = document.createElement("div"); wall.id = "verification-wall"; wall.style.cssText = "position:fixed;bottom:0;left:0;width:100%;height:150px;background:red"; wall.textContent = "Verify you are human before continuing"; document.body.append(wall); });
        await assert.rejects(shoot(page), /登录|验证|auth_required/);
        assert.equal(await page.locator("#verification-wall").evaluate(el => getComputedStyle(el).visibility), "visible");
      });
    } finally { await close(); }
    await t.test("cancelled leases still reject instead of taking a late screenshot", async () => {
      const ctrl = new AbortController(), lease = await openPage({ width: 600, height: 400 }, undefined, ctrl.signal);
      try { await lease.page.goto(url); ctrl.abort(); await assert.rejects(shoot(lease.page)); }
      finally { await lease.close(); }
    });
  } finally {
    await closeBrowser(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), "easy-workflow-capture-overlay-")));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
