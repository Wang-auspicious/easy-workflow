import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { BrowserState } from "../shared/browser.ts";

test("a site that fails through the proxy is probed directly once to name the broken side", async () => {
  const { diagnoseReach } = await import("../server/network.ts");
  const site = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY, https_proxy: process.env.https_proxy, http_proxy: process.env.http_proxy };
  try {
    for (const key of Object.keys(saved)) delete process.env[key];
    assert.equal(await diagnoseReach(url), null, "without a proxy there is nothing to compare");
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    const reachable = await diagnoseReach(url);
    assert.equal(reachable?.directOk, true);
    assert.match(reachable!.direct, /HTTP 200/);
    const closed = await diagnoseReach("http://127.0.0.1:9/");
    assert.equal(closed?.directOk, false);
    assert.match(closed!.direct, /直连也失败/);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise((resolve) => site.close(resolve));
  }
});

test("passing a verification wall in the built-in browser continues that candidate once", async () => {
  const { Factory } = await import("../server/factory.ts");
  const retried: string[][] = [], notes: string[] = [];
  const fake = {
    state: { alerts: { "auth:uiverse.io": { id: "auth:uiverse.io", level: "red", kind: "auth", message: "HTTP 403", item: "uiverse.io", node: "curation/scout", url: "https://uiverse.io/" } } },
    walled: new Set<string>(), resuming: false, runtime: { running: true },
    ensureReady: async () => null,
    retryCandidates: (filter: { items: string[] }) => { retried.push(filter.items); return [{ id: "t", item: filter.items[0] }]; },
    journal: { append: (e: { text: string }) => notes.push(e.text) },
  };
  const resume = (tabs: BrowserState["tabs"]) => Factory.prototype.resumeVerified.call(fake as never, { tabs, active: null, bookmarks: [], history: [], retentionDays: 30, mode: "desktop" });
  const tab = (attention?: string, url = "https://uiverse.io/") => ({ id: "t1", url, title: "Uiverse", loading: false, owner: "agent" as const, attention });
  await resume([tab(undefined)]);
  assert.equal(retried.length, 0, "a clean tab that was never walled proves nothing");
  await resume([tab("页面需要完成验证")]);
  assert.equal(retried.length, 0, "still behind the wall");
  await resume([tab(undefined, "https://other.example/")]);
  assert.equal(retried.length, 0, "another site's page cannot clear this wall");
  await resume([tab(undefined)]);
  assert.deepEqual(retried, [["uiverse.io"]]);
  assert.match(notes[0], /验证已通过/);
  await resume([tab(undefined)]);
  assert.equal(retried.length, 1, "continued once, not on every browser update");
});
