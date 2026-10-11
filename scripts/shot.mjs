// Dev helper: screenshot the dashboard at a fixed window size (headless Chrome).
// node scripts/shot.mjs <out.png> [width] [height] [zoomClicks]
import { chromium } from "playwright-core";
const [out, w = "1600", h = "1000", zoom = "0"] = process.argv.slice(2);
const b = await chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const p = await b.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
await p.goto("http://localhost:5317/");
await p.waitForSelector(".node", { timeout: 20000 });
await p.waitForTimeout(1200);
await p.evaluate(() => { if (document.querySelector(".chat:not(.is-collapsed)")) document.querySelector(".chat-head .icon-btn")?.click(); });
await p.waitForTimeout(500);
await p.keyboard.press("f");
await p.waitForTimeout(800);
for (let i = 0; i < Number(zoom); i++) { await p.keyboard.press("="); await p.waitForTimeout(80); }
await p.waitForTimeout(600);
await p.screenshot({ path: out });
console.log(await p.evaluate(() => document.querySelector(".ctl-zoom")?.textContent));
await b.close();
