import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { fork } from "node:child_process";

test("browser process loss invalidates an attempt and resumes its checkpoint without a site failure", { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-browser-recovery-"));
  process.env.FACTORY_VAR = root;
  const { openPage, closeBrowser } = await import("../server/browser.ts");
  const { Runtime } = await import("../server/runtime.ts");
  const { Journal } = await import("../server/journal.ts");
  const { Broker } = await import("../server/broker.ts");
  const { compile } = await import("../server/spec/compile.ts");
  const { pack } = await import("../packs/vislexicon/pack.ts");
  const { initialState, apply } = await import("../shared/project.ts");
  const fixture = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>Recovery fixture</title><main>Rendered checkpoint</main>"); });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const compiled = compile([pack]);
  try {
    for (const mode of ["renderer", "browser"] as const) await t.test(`real ${mode} crash is requeued once, including a swallowed tool exception`, async () => {
      const journal = new Journal(":memory:"), broker = new Broker({ browser: 3, cpu: 4, model: 6, http: 4 }, 0), state = initialState(compiled);
      journal.subscribe(event => apply(state, event));
      let calls = 0, candidateFailures = 0;
      const runtime = new Runtime(compiled, journal, broker, pack.conditions, node => async ctx => {
        assert.equal(node.key, "curation/identity");
        calls++;
        assert.equal(ctx.token.data.keptCheckpoint, "unchanged");
        const lease = await openPage(undefined, undefined, ctx.signal);
        try {
          await lease.page.goto(url);
          if (calls === 1) {
            const session = mode === "browser" ? await lease.context.browser()!.newBrowserCDPSession() : await lease.context.newCDPSession(lease.page);
            const lost = mode === "browser" ? lease.context.waitForEvent("close") : lease.page.waitForEvent("crash");
            void session.send(mode === "browser" ? "Browser.crash" : "Page.crash").catch(() => {});
            await lost;
            if (mode === "renderer") {
              // Real capture/scout code can catch a page error and return a result. The
              // runtime must still discard that invalid attempt, including this patch.
              try { await lease.page.title(); } catch { /* Simulated fallback inside a station. */ }
              return { ok: true, summary: "incorrect fallback", data: { poisonedResult: true }, finish: { status: "published" as const, reason: "must not publish" } };
            }
            await lease.page.title();
          }
          return { ok: true, summary: "checkpoint recovered", data: { recovered: true }, finish: { status: "published" as const, reason: "one successful publication" } };
        } finally { await lease.close(); }
      });
      runtime.onRecovery = () => { candidateFailures++; };
      runtime.ensureWorkers([]); runtime.start(`real ${mode} recovery`);
      const token = runtime.create("curation/identity", { item: mode, url, source: "manual", data: { canonical: url, keptCheckpoint: "unchanged" } });
      try {
        for (let i = 0; i < 1500 && !token.finished; i++) await delay(10);
        assert.ok(token.finished, "the bounded recovery must settle");
        assert.equal(calls, 2, "the damaged attempt is retried from this station");
        assert.equal(token.data.poisonedResult, undefined, "an invalid attempt cannot commit fallback output");
        assert.equal(token.data.recovered, true);
        assert.equal(candidateFailures, 0);
        assert.equal(state.nodes["curation/identity"].failed, 0);
        const finishes = [...journal.read()].filter(event => event.kind === "attempt.finished");
        assert.equal(finishes.length, 2); assert.equal(finishes[0].cancelled, true);
        assert.equal([...journal.read()].filter(event => event.kind === "token.finished" && event.status === "published").length, 1);
        assert.equal(broker.used.browser, 0);
      } finally { await runtime.close(); journal.close(); await closeBrowser(); }
    });
    await t.test("one crashed process recovers concurrent leases without double publication or leaked quota", async () => {
      const journal = new Journal(":memory:"), broker = new Broker({ browser: 3 }, 0), state = initialState(compiled);
      journal.subscribe(event => apply(state, event));
      const calls = new Map<string, number>(); let arrived = 0;
      let ready!: () => void; const bothReady = new Promise<void>(resolve => { ready = resolve; });
      const runtime = new Runtime(compiled, journal, broker, pack.conditions, () => async ctx => {
        const count = (calls.get(ctx.token.item) ?? 0) + 1; calls.set(ctx.token.item, count);
        const lease = await openPage(undefined, undefined, ctx.signal);
        try {
          await lease.page.goto(url);
          if (count === 1) {
            const lost = lease.context.waitForEvent("close");
            if (++arrived === 2) ready(); await bothReady;
            if (ctx.token.item === "first") { const session = await lease.context.browser()!.newBrowserCDPSession(); void session.send("Browser.crash").catch(() => {}); }
            await lost;
            return { ok: false, summary: "broken process" };
          }
          return { ok: true, summary: "recovered", finish: { status: "published" as const, reason: "one valid output" } };
        } finally { await lease.close(); }
      });
      runtime.ensureWorkers([]); runtime.start("shared process recovery");
      const tokens = ["first", "second"].map(item => runtime.create("curation/identity", { item, url, source: "manual", data: { canonical: url } }));
      try {
        await runtime.settle();
        assert.ok(tokens.every(token => state.tokens[token.id].status === "published"));
        assert.ok([...calls.values()].every(count => count >= 2 && count <= 3));
        assert.equal([...journal.read()].filter(event => event.kind === "token.finished" && event.status === "published").length, 2);
        assert.equal(state.nodes["curation/identity"].failed, 0);
        assert.equal(broker.used.browser, 0);
      } finally { await runtime.close(); journal.close(); await closeBrowser(); }
    });
    await t.test("repeated renderer crashes stop after two recoveries and preserve the failed checkpoint", async () => {
      const journal = new Journal(":memory:"), broker = new Broker({ browser: 3 }, 0), state = initialState(compiled);
      journal.subscribe(event => apply(state, event));
      let calls = 0; const failures: any[] = [];
      const runtime = new Runtime(compiled, journal, broker, pack.conditions, () => async ctx => {
        calls++;
        const lease = await openPage(undefined, undefined, ctx.signal);
        try {
          await lease.page.goto(url);
          const session = await lease.context.newCDPSession(lease.page), crashed = lease.page.waitForEvent("crash");
          void session.send("Page.crash").catch(() => {}); await crashed;
          return { ok: true, summary: "invalid fallback", data: { poisonedResult: true } };
        } finally { await lease.close(); }
      });
      runtime.onRecovery = (_token, failure) => { failures.push(failure); };
      runtime.ensureWorkers([]); runtime.start("bounded crash recovery");
      const token = runtime.create("curation/identity", { item: "bounded", url, source: "candidates/pool", data: { canonical: url, keptCheckpoint: "kept" } });
      token.done.add("curation/scout");
      try {
        for (let i = 0; i < 1500 && !token.finished; i++) await delay(10);
        assert.equal(calls, 3, "initial call plus two automatic recoveries");
        assert.equal(state.tokens[token.id].status, "parked");
        assert.equal(state.tokens[token.id].finishedAtNode, "curation/identity");
        assert.equal(state.nodes["curation/identity"].failed, 0);
        assert.equal(token.data.poisonedResult, undefined);
        assert.deepEqual(token.data.checkpointDone, ["curation/scout"]);
        assert.equal(failures.length, 1); assert.equal(failures[0].owner, "system");
        assert.equal(failures[0].code, "BROWSER_POOL_RECOVERY_EXHAUSTED");
        assert.equal(broker.used.browser, 0);
      } finally { await runtime.close(); journal.close(); await closeBrowser(); }
    });
    await t.test("ending the run during a real crash cancels without requeueing or publishing", async () => {
      const journal = new Journal(":memory:"), broker = new Broker({ browser: 3 }, 0), state = initialState(compiled);
      journal.subscribe(event => apply(state, event));
      let calls = 0;
      const runtime = new Runtime(compiled, journal, broker, pack.conditions, () => async ctx => {
        calls++;
        const lease = await openPage(undefined, undefined, ctx.signal);
        try {
          await lease.page.goto(url);
          const session = await lease.context.newCDPSession(lease.page), crashed = lease.page.waitForEvent("crash");
          lease.page.once("crash", () => runtime.end());
          void session.send("Page.crash").catch(() => {}); await crashed;
          return { ok: true, summary: "late output", finish: { status: "published" as const, reason: "must remain cancelled" } };
        } finally { await lease.close(); }
      });
      runtime.ensureWorkers([]); runtime.start("cancel a crashed attempt");
      const token = runtime.create("curation/identity", { item: "cancelled", url, source: "manual", data: { keptCheckpoint: true } });
      try {
        for (let i = 0; i < 1000 && runtime.running; i++) await delay(10);
        await runtime.settle();
        assert.equal(calls, 1); assert.equal(state.tokens[token.id].status, "parked");
        assert.equal([...journal.read()].filter(event => event.kind === "token.queued").length, 1);
        assert.equal([...journal.read()].filter(event => event.kind === "token.finished" && event.status === "published").length, 0);
        assert.equal(state.nodes["curation/identity"].failed, 0);
      } finally { await runtime.close(); journal.close(); await closeBrowser(); }
    });
    await t.test("desktop leases discard crashed agent pages while preserving user and access-check tabs", async () => {
      const { BrowserManager } = createRequire(import.meta.url)("../app/browser-manager.cjs");
      const manager = Object.create(BrowserManager.prototype);
      let closes = 0, frameReleases = 0;
      const page = { id: "agent", owner: "agent", ready: Promise.resolve(), readyError: "fixture renderer unavailable", crashed: true, captureDepth: 1, attention: "crashed", view: { webContents: { isDestroyed: () => false, close: () => { closes++; }, endFrameSubscription: () => { frameReleases++; } } } };
      manager.tabs = new Map([[page.id, page]]); manager.create = () => page; manager.snapshot = () => ({}); manager.publish = () => {}; manager.check = async () => {};
      await assert.rejects(manager.command({ action: "lease" }), /BROWSER_LEASE_FAILED/);
      assert.equal(closes, 1); assert.equal(frameReleases, 1);
      page.crashed = false; page.readyError = ""; page.attention = "access denied";
      await manager.command({ action: "release", id: page.id }); assert.equal(closes, 1, "healthy access-check tabs stay visible");
      await manager.command({ action: "release", id: page.id, discard: true }); assert.equal(closes, 2);
      page.owner = "user";
      await manager.command({ action: "release", id: page.id, discard: true }); assert.equal(closes, 2, "recovery never discards user tabs");
    });
    await t.test("real desktop renderer loss rebuilds only the agent view", { skip: process.platform !== "win32" && "native Windows desktop regression" }, async () => {
      const { _electron } = await import("playwright-core");
      const executable = createRequire(import.meta.url)("electron") as string;
      const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
      // Electron rejects URL-bearing Windows command lines with trailing arguments.
      env.EASY_WORKFLOW_RECOVERY_URL = url;
      env.EASY_WORKFLOW_RECOVERY_PROFILE = path.join(root, "desktop-profile");
      let app;
      try {
        app = await _electron.launch({ executablePath: executable, args: [path.resolve("test/fixtures/desktop-pool-crash.cjs")], env, timeout: 20000 });
        const result = await app.evaluate(async ({ app }) => { await app.whenReady(); return (globalThis as any).runBrowserRecovery(); });
        assert.equal(result.oldAgentRemoved, true); assert.equal(result.replacementWorks, true); assert.equal(result.userTabPreserved, true);
      } catch (error) { throw new Error(String(error).replace(/(?:https?|wss?):\/\/[^\s]+/g, "<local-browser-endpoint>")); }
      finally { await app?.close(); }
    });
    await t.test("a lost desktop IPC bridge reports its boundary and exhausts only two recoveries", async () => {
      const child = fork(path.resolve("test/fixtures/browser-bridge-loss.mjs"), [], { env: { ...process.env, FACTORY_VAR: path.join(root, "bridge"), FACTORY_BROWSER_BRIDGE: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let stdout = "", stderr = "";
      child.stdout!.on("data", chunk => { stdout += chunk; }); child.stderr!.on("data", chunk => { stderr += chunk; });
      child.on("message", (message: any) => { if (message.type === "browser:request" && message.args.action === "lease") child.disconnect(); });
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
      assert.equal(code, 0, stderr);
      const result = JSON.parse(stdout.trim());
      assert.equal(result.calls, 3); assert.equal(result.status, "parked"); assert.equal(result.failed, 0);
      assert.equal(result.failure.code, "BROWSER_POOL_RECOVERY_EXHAUSTED");
      assert.ok(result.failure.tried.includes("BROWSER_BRIDGE_UNAVAILABLE"));
      assert.match(result.failure.nextAction, /桌面应用/);
    });
  } finally {
    await closeBrowser(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), "easy-workflow-browser-recovery-"))); fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
