import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { StationContext } from "../server/runtime.ts";

test("proof checks only the selected component stage's iframe content", { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-stage-iframe-"));
  process.env.FACTORY_VAR = root;
  const { findStage, iframeEmpty } = await import("../packs/vislexicon/capture.ts");
  const { TOOLS } = await import("../packs/vislexicon/tools.ts");
  const { EvidenceStore } = await import("../server/evidence.ts");
  const { openPage, closeBrowser } = await import("../server/browser.ts");
  const component = '<div class="bd-example" style="width:500px;height:300px;background:#eef2f5"><svg width="480" height="280"><rect x="20" y="20" width="140" height="90" rx="12" fill="#2563eb"/><circle cx="340" cy="80" r="55" fill="#dc2626"/><rect x="60" y="155" width="360" height="80" rx="12" fill="#16a34a"/><text x="140" y="204" font-size="28" fill="white">Live component</text></svg></div>';
  const fixture = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/empty") { res.end("<!doctype html><body></body>"); return; }
    if (req.url === "/delayed") { res.end('<!doctype html><body><script>setTimeout(()=>{document.body.innerHTML="<main><h1>Delayed component</h1><p>One real item</p><p>Another real item</p><button>Action</button></main>"},350)</script></body>'); return; }
    if (req.url === "/rendered") { res.end(`<!doctype html><main>${component}</main>`); return; }
    res.end(`<!doctype html><title>Stage fixture</title><main>${component}</main><iframe title="Unrelated analytics" src="/empty" style="display:none"></iframe>`);
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  try {
    await t.test("a real SVG stage is not rejected by an unrelated empty frame", async () => {
      const messages: string[] = [];
      const ctx = {
        token: { id: "svg-with-analytics", url: base, data: { canonical: base, host: "127.0.0.1", kind: "component-source", previewChoices: { proof: `${base}/component` } } },
        signal: new AbortController().signal, attempt: "a-stage-iframe",
        progress: (message: string) => messages.push(message), addEvidence: (e: unknown) => e,
      } as unknown as StationContext;
      const result = await TOOLS["curation.proof"](ctx, { store: new EvidenceStore(path.join(root, "evidence")), workDir: path.join(root, "work"), publishDir: path.join(root, "publish"), inFlight: () => new Set<string>() });
      assert.equal(result.ok, true, messages.join("\n"));
      assert.ok(!messages.some(message => message.includes("iframe 是空的")));
      assert.ok(fs.existsSync((result.data?.shots as { proof: { file: string } }).proof.file));
    });
    await t.test("a genuinely empty selected iframe is still rejected even beside a rendered unrelated frame", async () => {
      const { page, close } = await openPage();
      try {
        await page.goto(base);
        await page.setContent(`<iframe data-preview src="${base}/empty" style="width:500px;height:300px"></iframe><aside><iframe src="${base}/rendered" style="width:300px;height:200px"></iframe></aside>`);
        const stage = await findStage(page); assert.ok(stage);
        assert.equal(await iframeEmpty(page, stage), true);
      } finally { await close(); }
    });
    await t.test("stage descendants are checked, hidden analytics and other matching stages are excluded", async () => {
      const { page, close } = await openPage();
      try {
        await page.goto(base);
        await page.setContent(`<div class="bd-example" style="width:500px;height:300px"><iframe src="${base}/empty" style="width:480px;height:280px"></iframe></div>`);
        let stage = await findStage(page); assert.equal(stage?.sel, ".bd-example");
        assert.equal(await iframeEmpty(page, stage!), true, "a container's real empty preview frame remains a veto");
        await page.setContent(`${component.replace("</div>", `<iframe src="${base}/empty" style="display:none"></iframe></div>`)}<div class="bd-example" style="width:100px;height:60px"><iframe src="${base}/empty" width="90" height="50"></iframe></div>`);
        stage = await findStage(page); assert.equal(stage?.w, 500);
        assert.equal(await iframeEmpty(page, stage!), false, "the matching smaller example is not the selected stage");
        await page.setContent(`<demo-host></demo-host><aside><iframe src="${base}/rendered"></iframe></aside>`);
        await page.evaluate(url => { document.querySelector("demo-host")!.attachShadow({ mode: "open" }).innerHTML = `<div class="bd-example" style="width:500px;height:300px"><iframe src="${url}/empty" style="width:480px;height:280px"></iframe></div>`; }, base);
        stage = await findStage(page); assert.equal(stage?.sel, ".bd-example");
        assert.equal(await iframeEmpty(page, stage!), true, "shadow-root stages keep their exact iframe association");
      } finally { await close(); }
    });
    await t.test("a selected iframe may navigate and render after load while unrelated content cannot make it ready", async () => {
      const { page, close } = await openPage();
      try {
        await page.goto(base);
        await page.setContent(`<iframe data-preview id="demo" src="${base}/empty" style="width:500px;height:300px"></iframe><aside><iframe src="${base}/rendered" style="width:300px;height:200px"></iframe></aside>`);
        const stage = await findStage(page); assert.ok(stage);
        await page.evaluate(url => { setTimeout(() => { (document.querySelector("#demo") as HTMLIFrameElement).src = `${url}/delayed`; }, 150); }, base);
        const started = Date.now();
        assert.equal(await iframeEmpty(page, stage, { timeoutMs: 2000, signal: new AbortController().signal }), false);
        assert.ok(Date.now() - started >= 300, "an unrelated already-rendered frame cannot satisfy readiness");
        const demo = page.frames().find(frame => frame.url().endsWith("/delayed"));
        assert.match(await demo!.locator("body").innerText(), /Delayed component/);
      } finally { await close(); }
    });
    await t.test("permanent emptiness expires and cancelling the DOM wait does not wait for the deadline", async () => {
      const { page, close } = await openPage();
      try {
        await page.goto(base);
        await page.setContent(`<iframe data-preview src="${base}/empty" style="width:500px;height:300px"></iframe>`);
        const stage = await findStage(page); assert.ok(stage);
        const start = Date.now();
        assert.equal(await iframeEmpty(page, stage, { timeoutMs: 100 }), true);
        assert.ok(Date.now() - start >= 75, "empty frames exhaust the bounded wait rather than fail instantly");
        const ctrl = new AbortController(), cancelStarted = Date.now();
        const waiting = iframeEmpty(page, stage, { timeoutMs: 10000, signal: ctrl.signal });
        setTimeout(() => ctrl.abort(new Error("cancel iframe readiness")), 30);
        await assert.rejects(waiting, /cancel iframe readiness|abort/i);
        assert.ok(Date.now() - cancelStarted < 500, "cancellation releases the caller immediately");
      } finally { await close(); }
    });
  } finally {
    await closeBrowser(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), "easy-workflow-stage-iframe-")));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
