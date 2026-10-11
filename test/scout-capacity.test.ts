import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { StationContext } from "../server/runtime.ts";

test("scout waits for the shared browser only when HTTP cannot supply the dossier", { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-scout-capacity-"));
  process.env.FACTORY_VAR = root;
  const { scout } = await import("../packs/vislexicon/scout.ts");
  const { Broker } = await import("../server/broker.ts");
  const { closeBrowser } = await import("../server/browser.ts");
  const { closeNetwork, configureNetwork } = await import("../server/network.ts");
  configureNetwork({ cacheDir: null });
  let resets = 0, browserVisits = 0;
  const fixture = http.createServer((req, res) => {
    const rendered = req.headers["sec-fetch-dest"] === "document";
    if (req.url?.startsWith("/fallback") && !rendered) { resets++; req.socket.destroy(); return; }
    if (rendered) browserVisits++;
    if (!rendered && req.url !== "/available") { res.writeHead(404); res.end(); return; }
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>Capacity fixture</title><main><h1>Rendered dossier</h1><p>Usable source content, retained while browser pages are shared between active stations.</p></main>");
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const context = (url: string, signal: AbortSignal, messages: string[]) => ({
    token: { url, data: {} }, signal, attempt: "capacity-fixture",
    progress: (message: string) => messages.push(message), addEvidence: (e: unknown) => e,
  }) as unknown as StationContext;
  try {
    await t.test("real HTTP resets queue behind both occupied leases and resume after release", async () => {
      const broker = new Broker({ browser: 2 }, 0), held = [broker.tryAcquire("browser")!, broker.tryAcquire("browser")!];
      const messages: string[] = []; let releaseLater: ReturnType<typeof setTimeout> | undefined, waits = 0;
      try {
        const result = await scout(context(`${base}/fallback`, new AbortController().signal, messages), {
          tryBrowser: () => broker.tryAcquire("browser"),
          acquireBrowser: (signal, timeoutMs) => {
            waits++;
            releaseLater = setTimeout(() => held[0].release(), 100);
            return broker.acquire("browser", { signal, timeoutMs });
          },
        });
        assert.equal(result.ok, true, "temporary browser saturation must not become the HTTP site failure");
        assert.ok(resets >= 2, "both real HTTP attempts failed before browser fallback");
        assert.equal(waits, 1, "the scout queues for capacity instead of discarding the candidate");
        assert.ok((result.data?.dossier as { via: string[] }).via.includes("browser"));
        assert.ok(browserVisits > 0);
        assert.match(messages.join("\n"), /等待.*浏览器|浏览器.*等待/);
        assert.equal(broker.used.browser, 1, "the scout releases its lease while the other reader keeps its own");
      } finally { clearTimeout(releaseLater); held.forEach(lease => lease.release()); }
      assert.equal(broker.used.browser, 0);
    });
    await t.test("cancelling the queued fallback rejects promptly without acquiring a later lease", async () => {
      const broker = new Broker({ browser: 1 }, 0), held = broker.tryAcquire("browser")!, ctrl = new AbortController();
      const messages: string[] = []; let abortLater: ReturnType<typeof setTimeout> | undefined, waits = 0;
      try {
        await assert.rejects(scout(context(`${base}/fallback-cancel`, ctrl.signal, messages), {
          tryBrowser: () => broker.tryAcquire("browser"),
          acquireBrowser: (signal, timeoutMs) => {
            waits++;
            abortLater = setTimeout(() => ctrl.abort(new Error("fixture cancellation")), 20);
            return broker.acquire("browser", { signal, timeoutMs });
          },
        }), /fixture cancellation|abort/i);
        held.release(); await delay(40);
        assert.equal(waits, 1); assert.equal(broker.used.browser, 0);
      } finally { clearTimeout(abortLater); held.release(); }
    });
    await t.test("successful HTTP content proceeds while all browser leases remain occupied", async () => {
      const broker = new Broker({ browser: 1 }, 0), held = broker.tryAcquire("browser")!;
      let claims = 0; const visits = browserVisits;
      try {
        const result = await scout(context(`${base}/available`, new AbortController().signal, []), {
          tryBrowser: () => { claims++; return broker.tryAcquire("browser"); },
          acquireBrowser: async () => { assert.fail("sufficient HTTP content must not wait for a browser"); },
        });
        assert.equal(result.ok, true); assert.equal(claims, 1);
        assert.equal(browserVisits, visits); assert.equal(broker.used.browser, 1);
        assert.match((result.data?.dossier as { text: string }).text, /Usable source content/);
      } finally { held.release(); }
    });
    await t.test("capacity wait expiry is a system disposition, distinct from the prior HTTP error", async () => {
      const broker = new Broker({ browser: 1 }, 0), held = broker.tryAcquire("browser")!;
      try {
        const result = await scout(context(`${base}/fallback-timeout`, new AbortController().signal, []), {
          tryBrowser: () => broker.tryAcquire("browser"),
          acquireBrowser: (signal, timeoutMs) => { assert.equal(timeoutMs, 60000); return broker.acquire("browser", { signal, timeoutMs: 30 }); },
        });
        assert.equal(result.ok, false); assert.equal(result.failure?.code, "BROWSER_CAPACITY_TIMEOUT");
        assert.equal(result.failure?.category, "system"); assert.equal(result.failure?.owner, "system");
        assert.equal(result.failure?.retryable, true); assert.equal(result.failure?.tried?.length, 2);
        held.release(); await delay(40); assert.equal(broker.used.browser, 0, "an expired wait cannot claim a future slot");
      } finally { held.release(); }
    });
    await t.test("both browser tools release a granted slot when cancellation prevents page creation", async () => {
      const { Toolbox } = await import("../server/toolbox.ts");
      for (const name of ["page_text", "page_find"] as const) {
        const broker = new Broker({ browser: 1 }, 0), ctrl = new AbortController();
        const acquire = broker.acquire.bind(broker);
        broker.acquire = async (cls, opts) => {
          const lease = await acquire(cls, opts);
          ctrl.abort(new Error("fixture cancellation after grant")); return lease;
        };
        const toolbox = new Toolbox({ broker, journal: {} as never, docs: () => { throw new Error("unused fixture docs"); } });
        await assert.rejects(toolbox.call([name], name, name === "page_text" ? { url: base } : { url: base, query: "source" }, { node: "curation/facts", signal: ctrl.signal }), /fixture cancellation after grant/);
        assert.equal(broker.used.browser, 0, `${name} must return the slot even though openPage rejected`);
      }
    });
  } finally {
    await closeBrowser(); await closeNetwork();
    fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), "easy-workflow-scout-capacity-")));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
