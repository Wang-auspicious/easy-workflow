import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Journal } from "../server/journal.ts";
import { EvidenceStore } from "../server/evidence.ts";
import type { JournalEvent } from "../shared/types.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h2-lessons-control-"));
Object.assign(process.env, { FACTORY_VAR: dir, FACTORY_ROOT: root, FACTORY_PREFLIGHT: "0", FACTORY_HTTP_CACHE: "0", FACTORY_DISCOVERY: "0", FACTORY_START_PAUSED: "1", VISLEXICON_ROOT: path.join(dir, "unconnected") });
const { Factory } = await import("../server/factory.ts");
const { FactoryControl } = await import("../server/control.ts");
const { closeNetwork } = await import("../server/network.ts");
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const station = "curation/facts";

function failure(journal: Journal, token: string, item: string, url = `https://${item}.test/`) {
  journal.append({ kind: "token.created", token, line: "curation", item, url, source: "manual" });
  journal.append({ kind: "attempt.started", attempt: `${token}-attempt`, token, node: station, worker: "fixture", input: "fixture" });
  journal.append({ kind: "attempt.finished", attempt: `${token}-attempt`, ok: false, summary: "HTTP 503", error: "HTTP 503", ms: 1, queuedMs: 0 });
  journal.append({ kind: "token.finished", token, node: station, status: "parked", reason: "HTTP 503" });
  journal.append({ kind: "candidate.disposition", candidate: { item, token, url, source: "manual", title: item, disposition: "retry", failure: { tag: "http_server", category: "network", retryable: true, message: "HTTP 503" } } });
}

function baseline(f: InstanceType<typeof Factory>, item: string, version = "original") {
  const token = `baseline-${item}-${version}`, store = new EvidenceStore(path.join(dir, "evidence"));
  const image = store.put(Buffer.from(`immutable test image ${item}`), "webp");
  f.journal.append({ kind: "token.created", token, line: "curation", item, url: `https://${item}.test/`, source: "manual" });
  const record = { schemaVersion: 3, entryId: item, official: { checkedAt: "now" }, classification: { confirmedAt: "now" }, editorialVoice: {}, pages: ["identity", "breadth", "proof"].map((role) => ({ role, shot: { src: image.src } })), h2: { token } };
  const digest = hash(JSON.stringify({ ...record, official: { ...record.official, checkedAt: "" }, classification: { ...record.classification, confirmedAt: "" }, editorialVoice: null }));
  fs.mkdirSync(path.join(dir, "published"), { recursive: true });
  fs.writeFileSync(path.join(dir, "published", `${item}.json`), JSON.stringify({ ...record, h2: { token, digest, publishedAt: "now" } }));
  f.journal.append({ kind: "token.data", token, patch: { key: item, gate: "pass", digest } });
  f.journal.append({ kind: "evidence.added", evidence: { id: `gate-${item}`, kind: "verdict", label: "fixture gate", station: "curation/gate", token, attempt: "fixture", at: Date.now(), tone: "ok", meta: { digest } } });
  f.journal.append({ kind: "token.finished", token, node: "curation/published", status: "published", reason: "fixture" });
}

async function closeFactory(f: InstanceType<typeof Factory>) {
  await f.runtime?.close();
  f.lessons?.close();
  f.docs?.flush();
  f.journal.close();
}

const secret = "lesson-control-fixture-secret";
async function startServer(readOnly = false) {
  const child = fork(path.join(root, "server/main.ts"), [], { cwd: root, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, FACTORY_PORT: "0", FACTORY_TOKEN: secret, FACTORY_READONLY: readOnly ? "1" : "0" } });
  let output = "";
  child.stdout?.on("data", (v) => { output += v; }); child.stderr?.on("data", (v) => { output += v; });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(output || "server startup timed out")); }, 20000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${output}`)); });
    child.on("message", (message: { type?: string; url?: string }) => { if (message.type === "ready" && message.url) { clearTimeout(timer); resolve(message.url); } });
  });
  return { child, async call(route: string, args: unknown) {
    const response = await fetch(url + route, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(args), signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() as any };
  } };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill(), 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send({ type: "shutdown" }); else child.kill();
  });
}

test("lesson wiring: legacy boot, atomic Runtime scheduling, actor boundaries and HTTP user decisions", { timeout: 60000 }, async (t) => {
  const seed = new Journal(path.join(dir, "journal.db"));
  seed.append({ kind: "run.started", runId: "run-legacy", title: "legacy" }); failure(seed, "legacy-bad", "failed-site"); seed.append({ kind: "run.ended", runId: "run-legacy", manual: true });
  const originalSeq = seed.seq;
  seed.close();
  let f: InstanceType<typeof Factory> | undefined, server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await t.test("read-only legacy boot neither drafts lessons nor creates project document/evidence directories", async () => {
      process.env.FACTORY_READONLY = "1";
      f = new Factory(); await f.boot();
      assert.equal(f.journal.seq, originalSeq);
      assert.equal(f.lessons.list().length, 0);
      const control = new FactoryControl(f);
      assert.equal((await control.execute("read_lessons", {})).result.length, 0);
      await assert.rejects(() => control.execute("revise_lesson", { id: "none", digest: "none", suggestion: "禁止写入只读项目" }, "user"), /只读/);
      for (const name of ["LESSONS.md", "PROJECT.md", "context", "evidence"]) assert.equal(fs.existsSync(path.join(dir, name)), false, name);
    });
    if (f) { await closeFactory(f); f = undefined; }
    process.env.FACTORY_READONLY = "0";
    f = new Factory(); await f.boot();
    const factory = f, control = new FactoryControl(factory);
    let draft = factory.lessons.list().find((l) => l.runId === "run-legacy")!;
    await t.test("writable boot drafts completed legacy runs and keeps the same draft across another boot", () => {
      assert.ok(draft);
      assert.equal(draft.station, station);
      assert.match(fs.readFileSync(path.join(dir, "LESSONS.md"), "utf8"), new RegExp(draft.id));
      assert.match(factory.docs.renderContext(station), new RegExp(draft.id));
      assert.equal(factory.lessons.draftRun("run-legacy")[0].digest, draft.digest);
    });

    factory.journal.append({ kind: "run.started", runId: "run-baselines", title: "baselines" });
    baseline(factory, "known-a"); baseline(factory, "known-b");
    factory.journal.append({ kind: "run.ended", runId: "run-baselines", manual: true });
    await t.test("all trial tokens are bound before real Runtime attempts start, preserving catalog item IDs", async () => {
      factory.broker.memoryFloorMB = 0;
      const seen: string[] = [];
      factory.runtime.executors = () => async (ctx) => {
        const bindings = [...factory.journal.read()].filter((e) => e.kind === "lesson.validation.bound");
        assert.equal(bindings.length, 3, "worker started before complete binding");
        assert.ok(bindings.some((b) => b.kind === "lesson.validation.bound" && b.token === ctx.token.id));
        seen.push(ctx.token.item);
        return { ok: true, summary: "fixture", finish: { status: "published", reason: "fixture" } };
      };
      const receipt = await control.execute("begin_lesson_validation", { id: draft.id, digest: draft.digest, regressionItems: ["known-a", "known-b"] });
      const { tokens, trial } = receipt.result;
      assert.deepEqual(tokens.map((token: { item: string }) => token.item).sort(), ["failed-site", "known-a", "known-b"]);
      await factory.runtime.settle();
      assert.deepEqual(seen.sort(), ["failed-site", "known-a", "known-b"]);
      const events = [...factory.journal.read()], bounds = events.filter((e) => e.kind === "lesson.validation.bound" && e.trialId === trial.id);
      const first = events.find((e) => e.kind === "attempt.started" && tokens.some((token: { id: string }) => token.id === e.token));
      assert.ok(first && bounds.every((binding) => binding.seq < first.seq));
      await control.execute("run_control", { action: "end" });
    });

    await t.test("active and paused rounds block validation starts and role approvals", async () => {
      factory.runtime.start("unfinished");
      await assert.rejects(() => control.execute("begin_lesson_validation", { id: draft.id, digest: draft.digest, regressionItems: ["known-a", "known-b"] }), /先结束当前轮次/);
      factory.runtime.pause();
      await assert.rejects(() => control.execute("begin_lesson_validation", { id: draft.id, digest: draft.digest, regressionItems: ["known-a", "known-b"] }), /先结束当前轮次/);
      await assert.rejects(() => control.execute("decide_lesson", { id: draft.id, digest: draft.digest, decision: "approve", validationDigest: "missing" }, "user"), /先结束当前轮次/);
      await control.execute("run_control", { action: "end" });
    });

    factory.runtime.start("refresh fixture baselines");
    baseline(factory, "known-a", "current"); baseline(factory, "known-b", "current");
    await control.execute("run_control", { action: "end" });
    await t.test("unexpected binding failure stops queued work and persists the ended run before returning an error", async () => {
      const original = factory.lessons.bindValidation;
      const before = factory.journal.seq;
      let executions = 0;
      factory.runtime.executors = () => async () => { executions++; return { ok: true, summary: "must not execute" }; };
      factory.lessons.bindValidation = () => { throw new Error("fixture binding failure"); };
      try {
        await assert.rejects(() => control.execute("begin_lesson_validation", { id: draft.id, digest: draft.digest, regressionItems: ["known-a", "known-b"] }), /fixture binding failure/);
      } finally { factory.lessons.bindValidation = original; }
      assert.equal(executions, 0);
      assert.equal(factory.runtime.running, false);
      assert.equal(factory.state.run.status, "ended");
      const events = [...factory.journal.read(before)];
      assert.ok(events.some((e) => e.kind === "run.ended"));
      assert.ok(events.some((e) => e.kind === "report.ready"));
      assert.equal(events.filter((e) => e.kind === "attempt.started").length, 0);
    });

    await t.test("invalid historical sample URLs fail before any trial run or worker is created", async () => {
      factory.runtime.start("legacy invalid URL");
      const runId = factory.state.run.id;
      failure(factory.journal, "invalid-url", "invalid-site", "not a URL");
      await control.execute("run_control", { action: "end" });
      const invalid = factory.lessons.list().find((l) => l.runId === runId && l.station === station)!;
      const before = factory.journal.seq;
      await assert.rejects(() => control.execute("begin_lesson_validation", { id: invalid.id, digest: invalid.digest, regressionItems: ["known-a", "known-b"] }), /完整的 HTTP/);
      assert.equal(factory.journal.seq, before);
      assert.equal(factory.runtime.running, false);
      assert.equal(factory.state.run.id, runId);
    });

    await t.test("report.ready creates lessons without delivering journal sequence numbers out of order", async () => {
      const delivered: number[] = [], off = factory.journal.subscribe((event) => delivered.push(event.seq));
      try {
        factory.runtime.start("review another failure");
        const runId = factory.state.run.id;
        failure(factory.journal, "live-bad", "live-failed");
        await control.execute("run_control", { action: "end" });
        assert.ok(factory.lessons.list().some((l) => l.runId === runId));
        assert.deepEqual(delivered, [...delivered].sort((a, b) => a - b), "SSE subscribers must observe journal order");
      } finally { off(); }
    });

    await t.test("control actor reaches revisions and only the owner can reject or approve", async () => {
      const revised = await control.execute("revise_lesson", { id: draft.id, digest: draft.digest, suggestion: "网络入口恢复后再核对直接事实来源。" }, "dispatcher");
      draft = revised.result;
      const change = [...factory.journal.read()].findLast((event) => event.kind === "lesson.revised");
      assert.equal(change?.kind === "lesson.revised" && change.by, "dispatcher");
      await assert.rejects(() => control.execute("decide_lesson", { id: draft.id, digest: draft.digest, decision: "reject", reason: "must remain a draft" }, "agent"), /只有站长/);
      await assert.rejects(() => control.execute("decide_lesson", { id: draft.id, digest: draft.digest, decision: "approve", validationDigest: "missing" }, "agent"), /只有站长/);
      // The dispatcher holds the user's decision gate. The digest check still
      // rejects a stale approval instead of writing into the role handbook.
      await assert.rejects(() => control.execute("decide_lesson", { id: draft.id, digest: draft.digest, decision: "approve", validationDigest: "missing" }, "dispatcher"), /缺少当前草案/);
      await assert.rejects(() => control.execute("decide_lesson", { id: draft.id, digest: draft.digest, decision: "approve", validationDigest: "missing" }, "user"), /缺少当前草案/);
    });

    await closeFactory(factory); f = undefined;
    server = await startServer();
    await t.test("HTTP agent tools cannot spoof the actor and keep the same digest gate", async () => {
      const args = { id: draft.id, digest: draft.digest, decision: "reject", reason: "fixture owner rejected" };
      assert.equal((await server!.call("/api/tools/decide_lesson", { ...args, actor: "user" })).status, 400, "the request body cannot spoof the actor");
      assert.equal((await server!.call("/api/tools/decide_lesson", { ...args, digest: "stale" })).status, 409, "the dispatcher route uses the same digest gate");
      assert.equal((await server!.call("/api/lessons/decision", { ...args, decision: "approve", validationDigest: "not-validated" })).status, 409);
      const response = await server!.call("/api/lessons/decision", args);
      assert.equal(response.status, 200);
      assert.equal(response.body.result.status, "rejected");
    });
    await stop(server.child); server = await startServer(true);
    await t.test("HTTP read-only mode serves lessons and rejects both decision routes", async () => {
      const list = await server!.call("/api/tools/read_lessons", {});
      assert.equal(list.status, 200);
      const args = { id: draft.id, digest: draft.digest, decision: "reject", reason: "read only" };
      assert.equal((await server!.call("/api/tools/decide_lesson", args)).status, 403);
      assert.equal((await server!.call("/api/lessons/decision", args)).status, 403);
    });
    await stop(server.child); server = undefined;
    const broken = "# 旧项目经验\n\n站长手写内容\n<!-- H2:LESSONS:START -->\n缺失结束标记\n";
    fs.writeFileSync(path.join(dir, "LESSONS.md"), broken);
    server = await startServer();
    await t.test("damaged old LESSONS metadata preserves the source and reports an issue without blocking boot", async () => {
      assert.equal(fs.readFileSync(path.join(dir, "LESSONS.md"), "utf8"), broken);
      const context = await server!.call("/api/tools/read_context", { station: "dispatcher" });
      assert.equal(context.status, 200);
      assert.match(context.body.result.markdown, /复盘文档需要修复/);
    });
  } finally {
    if (server) await stop(server.child);
    if (f) await closeFactory(f);
    await closeNetwork();
    assert.ok(path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()), "h2-lessons-control-")));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
