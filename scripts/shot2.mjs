// Dev helper: screenshot the dashboard (headless Chrome), chat open or collapsed.
// node scripts/shot2.mjs <out.png> [width] [height] [zoomClicks] [chat=open|closed] [hover selector]
import { chromium } from "playwright-core";
const [out, w = "1440", h = "900", zoom = "0", chat = "open", hover = ""] = process.argv.slice(2);
const b = await chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const p = await b.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
p.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
await p.goto("http://localhost:5317/");
await p.waitForSelector(".node", { timeout: 20000 });
await p.waitForTimeout(1000);
const isOpen = await p.evaluate(() => Boolean(document.querySelector(".chat:not(.is-collapsed)")));
if ((chat === "closed") === isOpen) await p.evaluate(() => document.querySelector(".chat-head .icon-btn, .chat-avatar, .chat button")?.click());
await p.waitForTimeout(500);
await p.keyboard.press("f");
await p.waitForTimeout(700);
for (let i = 0; i < Number(zoom); i++) { await p.keyboard.press("="); await p.waitForTimeout(60); }
if (hover) { const el = await p.$(hover); if (el) { const r = await el.boundingBox(); await p.mouse.move(r.x + r.width / 2, r.y + r.height / 2); } }
await p.waitForTimeout(700);
await p.screenshot({ path: out });
const m = await p.evaluate(() => {
  const k = new DOMMatrix(getComputedStyle(document.querySelector(".cv-world")).transform).a;
  const px = (sel) => Math.min(...[...document.querySelectorAll(sel)].map((e) => parseFloat(getComputedStyle(e).fontSize) * k));
  return { zoom: k.toFixed(3), title: px(".node:not(.node--source) .node-name").toFixed(1), row: px(".node-row").toFixed(1) };
});
console.log(JSON.stringify(m), errors.slice(0, 5).join(" | "));
await b.close();
