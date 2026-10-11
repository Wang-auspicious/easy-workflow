// Dev helper: replay the recorded run in headless Chrome and capture frames while goods move.
// node scripts/shot-replay.mjs <outPrefix> [width] [height] [frames] [zoomClicks]
import { chromium } from "playwright-core";
const [prefix, w = "1440", h = "900", frames = "6", zoom = "0"] = process.argv.slice(2);
const b = await chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const p = await b.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto("http://localhost:5317/");
await p.waitForSelector(".node", { timeout: 20000 });
await p.evaluate(() => { if (document.querySelector(".chat:not(.is-collapsed)")) document.querySelector(".chat-head .icon-btn")?.click(); });
// The live run has no replay button, so start the replay through the module itself.
await p.evaluate(async () => {
  const run = (await (await fetch("/api/runs")).json())[0].run;
  const m = await import("/src/canvas/ReplayBar.tsx");
  await m.startReplay(run);
  const st = await import("/src/store.ts");
  st.setState({ replay: { ...st.getState().replay, speed: 8 } });
});
await p.waitForTimeout(400);
await p.keyboard.press("f");
for (let i = 0; i < Number(zoom); i++) { await p.keyboard.press("="); await p.waitForTimeout(60); }
let shot = 0;
for (let t = 0; t < 120 && shot < Number(frames); t++) {
  await p.waitForTimeout(250);
  const n = await p.evaluate(() => document.querySelectorAll(".cargo, .node.is-busy").length);
  if (n >= 2) {
    // Every other frame hovers the first cargo chip to show that item's journey.
    if (shot % 2 === 1) { const chip = await p.$(".cargo-chip"); if (chip) { const r = await chip.boundingBox(); if (r) await p.mouse.move(r.x + r.width / 2, r.y + r.height / 2); await p.waitForTimeout(300); } }
    await p.screenshot({ path: `${prefix}-${shot++}.png` });
    await p.mouse.move(5, 300);
    await p.waitForTimeout(1400);
  }
}
console.log("frames", shot, errors.slice(0, 3).join(" | "));
await b.close();
