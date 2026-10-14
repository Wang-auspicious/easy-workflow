import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { apply, initialState } from "../shared/project.ts";
import { compile } from "../server/spec/compile.ts";
import { pack } from "../packs/vislexicon/pack.ts";
import { Journal } from "../server/journal.ts";
import { Docs, CASE_HEADER } from "../server/docs.ts";
import { Runtime } from "../server/runtime.ts";
import { Broker } from "../server/broker.ts";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-cases-"));
  const compiled = compile([pack]);
  const journal = new Journal(path.join(dir, "journal.db")), state = initialState(compiled);
  journal.subscribe((e) => apply(state, e));
  const host = { compiled, journal, state }, docs = new Docs(host, dir, "case fixture");
  return { dir, host, journal, state, docs, close() { docs.flush(); journal.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const create = (journal: Journal, id: string, item = "site") => journal.append({ kind: "token.created", token: id, item, line: "curation", source: "manual", url: "https://example.test/" });

test('station context distinguishes configured closed agents, actual model receipts and program nodes', () => {
  const f = fixture();
  const previous = { command: process.env.FACTORY_STATION_COMMAND, model: process.env.FACTORY_STATION_MODEL };
  process.env.FACTORY_STATION_COMMAND = '["fixture-unused-launcher"]';
  process.env.FACTORY_STATION_MODEL = 'requested-fixture-model';
  try {
    const configured = f.docs.renderContext('curation/facts');
    assert.match(configured, /执行：closed-command · requested-fixture-model.*请求配置/);
    assert.doesNotMatch(configured, /最近执行回执/);
    create(f.journal, 'execution-model');
    f.journal.append({ kind: 'attempt.started', attempt: 'execution-attempt', token: 'execution-model', node: 'curation/facts', worker: 'fixture', input: 'facts' });
    f.journal.append({ kind: 'attempt.finished', attempt: 'execution-attempt', ok: true, summary: 'fixture result', ms: 20, queuedMs: 0, metrics: { execution: { adapter: 'closed-command', model: 'actual-fixture-model' } } });
    const completed = f.docs.renderContext('curation/facts');
    assert.match(completed, /执行：closed-command · requested-fixture-model.*请求配置/);
    assert.match(completed, /最近执行回执：closed-command · actual-fixture-model/);
    assert.match(f.docs.renderContext('curation/scout'), /执行：程序执行/);
    assert.match(f.docs.renderContext('dispatcher'), /执行：pi · .*当前配置/);
    f.journal.append({kind: 'agent.defaults', defaults: {
      station: {adapter: 'pi', provider: 'project-provider', model: 'project-model'},
      dispatcher: {adapter: 'pi', provider: 'dispatcher-provider', model: 'dispatcher-model'},
    }});
    f.journal.append({kind: 'agent.binding', node: 'curation/facts',
      binding: {adapter: 'pi', provider: 'node-provider', model: 'node-model'}});
    assert.match(f.docs.renderContext('curation/facts'), /执行：pi · node-provider\/node-model.*本节点请求配置/);
    assert.match(f.docs.renderContext('curation/reader'), /执行：pi · project-provider\/project-model/);
    assert.match(f.docs.renderContext('dispatcher'), /执行：pi · dispatcher-provider\/dispatcher-model/);
  } finally {
    if (previous.command === undefined) delete process.env.FACTORY_STATION_COMMAND; else process.env.FACTORY_STATION_COMMAND = previous.command;
    if (previous.model === undefined) delete process.env.FACTORY_STATION_MODEL; else process.env.FACTORY_STATION_MODEL = previous.model;
    f.close();
  }
});

test("a real multi-station run persists actions, facts, review repairs and immutable earlier run snapshots; restart rebuilds both files", async () => {
  const f = fixture();
  const names = ["scout", "reader", "facts", "fact-review", "copy", "copy-review", "published"];
  const compiled = { ...f.host.compiled, nodes: f.host.compiled.nodes.filter((n) => names.includes(n.id) && n.line === "curation"), edges: names.slice(0, -1).map((from, i) => ({ key: `${from}-${names[i + 1]}`, from: `curation/${from}`, to: `curation/${names[i + 1]}`, kind: "flow" as const })), channels: [] };
  let factCalls = 0;
  const runtime = new Runtime(compiled, f.journal, new Broker({ cpu: 4, model: 4, browser: 4, http: 4 }, 0), {}, (node) => async (ctx) => {
    if (node.id === "scout") {
      const ev = ctx.addEvidence({ id: `source-${ctx.token.id}`, kind: "text", label: "原页引用", meta: { sourceUrl: "https://example.test/license", quote: "MIT License" } });
      for (let i = 0; i < 95; i++) ctx.progress(`观察 ${i}`, { tool: "page_text", text: `段落 ${i}`, evidence: [ev.id] });
      return { ok: true, summary: "已读取首页与许可页", data: { dossier: { title: "Example", framework: ["Storybook"] } }, caseNotes: [{ section: "侦察卷宗", text: "许可页来自网站页脚。" }] };
    }
    if (node.id === "reader") return { ok: true, summary: "先拍组件目录", data: { understanding: "复制组件源码", readerPlan: { breadth: "https://example.test/components" }, readerBlockers: ["价格范围待核实"] }, caseNotes: [{ section: "拍摄单", text: "选择有实际预览的目录。" }] };
    if (node.id === "facts") {
      factCalls++;
      const repaired = factCalls > 1;
      ctx.progress(repaired ? "读取指定 LICENSE" : "只读了首页", { tool: "fetch_text", text: "资料核验", ok: true });
      return { ok: true, summary: repaired ? "源码许可已核实" : "许可待核实", data: { facts: { license: { value: repaired ? "MIT" : "unknown", sourceUrl: repaired ? "https://example.test/license" : "", quote: repaired ? "MIT License" : "", evidence: repaired ? "LICENSE 原文" : "首页未找到" }, pricing: { value: "unknown", sourceUrl: "", quote: "", evidence: "未取得价格页" } }, reply: repaired ? "已补许可原文，不替未知价格下结论。" : "" } };
    }
    if (node.id === "fact-review" && factCalls === 1) return { ok: true, summary: "许可需要补证据", verdict: { verdict: "fix", reason: "需读取许可原文", fixes: [{ station: "curation/facts", fields: ["facts.license"], problem: "未引用 LICENSE 原文" }] } };
    if (node.kind === "review") return { ok: true, summary: "已复查", verdict: { verdict: "pass", reason: "引用支持当前声明；未知价格仍未知" } };
    return { ok: true, summary: "写下核实过的内容", data: { copy: { noteZh: "组件源码可以复制；价格尚未核实。" } } };
  });
  try {
    runtime.ensureWorkers([]);
    const firstRun = runtime.start("first run");
    const token = runtime.create("curation/scout", { item: "site", url: "https://example.test/", source: "manual" });
    for (let i = 0; i < 200 && f.state.tokens[token.id]?.status === "active"; i++) await delay(10);
    assert.equal(f.state.tokens[token.id].status, "published");
    runtime.end(); await runtime.settle();
    f.docs.write("case", "site");
    const first = f.docs.caseData("site"), firstSnapshot = structuredClone(first.runs[0]);
    assert.deepEqual(first.runs[0].stationOrder.map((x) => x.station), ["curation/scout", "curation/reader", "curation/facts", "curation/fact-review", "curation/facts", "curation/fact-review", "curation/copy", "curation/copy-review"]);
    assert.equal(first.runs[0].attempts[0].actions.filter((a) => a.tool === "page_text").length, 95, "case keeps the full journal rather than the UI's 80-step ring");
    assert.equal(first.runs[0].evidence[0].id, `source-${token.id}`);
    assert.equal(first.runs[0].tokens[0].dataChanges.filter(change =>
      ['dossier', 'understanding', 'facts', 'copy'].some(key => Object.hasOwn(change.patch, key))).length,
    5, 'all five business outputs remain recorded separately from scheduler and recovery policy checkpoints');
    assert.ok(first.runs[0].tokens[0].dataChanges.some(change => 'runtimeCheckpoint' in change.patch), 'scheduler checkpoints remain part of the full case audit trail');
    assert.equal(first.runs[0].consultations.filter((e) => e.kind === "consult.closed" && e.outcome === "resolved").length, 1);
    assert.ok(first.runs[0].unresolved.some((i) => i.field === "facts.pricing" && i.status === "unknown"));
    assert.match(fs.readFileSync(f.docs.caseFile("site"), "utf8"), /已补许可原文/);
    assert.ok(fs.readFileSync(f.docs.caseFile("site"), "utf8").includes(CASE_HEADER));

    const secondRun = runtime.start("retry later");
    runtime.pause();
    const retry = runtime.create("curation/facts", { item: "site", url: "https://example.test/", source: "manual" });
    f.journal.append({ kind: "token.data", token: retry.id, patch: { facts: { pricing: { value: "paid", sourceUrl: "", quote: "", evidence: "" } } } });
    f.journal.append({ kind: "case.noted", caseId: "site", token: retry.id, note: { station: "curation/facts", section: "未确认", text: "新的价格声明没有来源。", by: "fixture" } });
    f.docs.schedule("case", "site"); f.docs.flush();
    const next = JSON.parse(fs.readFileSync(f.docs.caseJsonFile("site"), "utf8"));
    assert.equal(next.currentRunId, secondRun);
    assert.equal(next.runs[0].id, firstRun); assert.equal(next.runs[0].current, false);
    assert.deepEqual(next.runs[0], { ...firstSnapshot, current: false });
    assert.equal(next.runs[1].tokens[0].id, retry.id);
    assert.ok(next.runs[1].unresolved.some((i: { reason: string }) => i.reason.includes("缺少出处")));
    assert.match(f.docs.renderCase("site"), /历史轮次/); assert.match(f.docs.renderCase("site"), /当前轮次/);
    assert.ok(f.docs.caseBrief("site", 1600).length <= 1600);
    assert.match(f.docs.caseBrief("site", 1600), /已裁剪/);
    assert.match(f.docs.caseBrief("site", 1600), /新的价格声明没有来源/);

    runtime.end(); await runtime.close();
    f.docs.write("case", "site");
    const before = { json: fs.readFileSync(f.docs.caseJsonFile("site"), "utf8"), md: fs.readFileSync(f.docs.caseFile("site"), "utf8") };
    f.journal.close();
    fs.writeFileSync(f.docs.caseJsonFile("site"), "partial json"); fs.writeFileSync(f.docs.caseFile("site"), "stale markdown");
    const replay = new Journal(path.join(f.dir, "journal.db")), state = initialState(compiled);
    for (const e of replay.read()) apply(state, e);
    const restored = new Docs({ compiled, state, journal: replay }, f.dir, "case fixture");
    try {
      restored.writeAllCases();
      assert.equal(fs.readFileSync(restored.caseJsonFile("site"), "utf8"), before.json);
      assert.equal(fs.readFileSync(restored.caseFile("site"), "utf8"), before.md);
      assert.equal(restored.caseData("site").runs.length, 2);
    } finally { replay.close(); }
  } finally { await runtime.close(); try { f.close(); } catch { fs.rmSync(f.dir, { recursive: true, force: true }); } }
});

test("cross-run correction of the same token preserves the old outcome and logs the new return, repair and evidence", () => {
  const f = fixture();
  try {
    f.journal.append({ kind: "run.started", runId: "old", title: "old" }); create(f.journal, "same-token");
    f.journal.append({ kind: "token.data", token: "same-token", patch: { facts: { author: { value: "unknown" } } } });
    f.journal.append({ kind: "token.finished", token: "same-token", node: "curation/manual", status: "manual", reason: "作者未知" });
    f.journal.append({ kind: "run.ended", runId: "old", manual: true });
    const oldSnapshot = f.docs.caseData("site").runs[0];
    f.journal.append({ kind: "run.started", runId: "current", title: "correction" });
    f.journal.append({ kind: "correction.created", correction: "fix", token: "same-token", node: "curation/facts", reason: "新出处", evidence: "source-link" });
    f.journal.append({ kind: "token.returned", token: "same-token", from: "curation/manual", to: "curation/facts", round: 1, byHuman: true, reason: "核实作者" });
    f.journal.append({ kind: "token.queued", token: "same-token", from: "curation/manual", node: "curation/facts", returned: true });
    f.journal.append({ kind: "token.data", token: "same-token", patch: { facts: { author: { value: "Named author", sourceUrl: "https://example.test/about", evidence: "作者署名" } } } });
    f.docs.write("case", "site");
    const doc = f.docs.caseData("site");
    assert.equal(doc.runs[0].tokens[0].status, "manual");
    assert.deepEqual(doc.runs[0].tokens[0].at, [], "later requeue cannot alter a previous run's location array");
    assert.deepEqual(doc.runs[0], { ...oldSnapshot, current: false }, "all earlier snapshot fields stay isolated from replay mutations");
    assert.equal((doc.runs[0].tokens[0].data.facts as any).author.value, "unknown");
    assert.equal(doc.runs[1].tokens[0].status, "active");
    assert.deepEqual(doc.runs[1].tokens[0].at, ["curation/facts"]);
    assert.equal(doc.runs[1].tokens[0].createdInRun, "old");
    assert.equal(doc.runs[1].returns[0].byHuman, true);
    assert.equal(doc.runs[1].corrections[0].evidence, "source-link");
    f.journal.append({ kind: "run.started", runId: "unrelated", title: "another item" });
    const md = f.docs.renderCase("site");
    assert.match(md, /本件尚未参与项目当前轮次/);
    assert.ok(f.docs.caseData("site").runs.every((r) => !r.current));
  } finally { f.close(); }
});

test("case documents redact credentials in payloads, notes, URLs and evidence while retaining provenance and unknowns", () => {
  const f = fixture(), before = process.env.FACTORY_TOKEN;
  process.env.FACTORY_TOKEN = "fixture-control-credential";
  try {
    create(f.journal, "safe-task");
    f.journal.append({ kind: "token.data", token: "safe-task", patch: { facts: { license: { value: "unknown", evidence: "仍待查" } }, apiKey: "payload-key-fixture", auth: { token: "payload-bearer-fixture" }, cdpEndpoint: "ws://127.0.0.1:9999/devtools/browser/secret", canonical: "https://user:password@example.test/docs?path=story&token=url-secret" } });
    f.journal.append({ kind: "case.noted", caseId: "site", token: "safe-task", note: { station: "curation/facts", section: "交接", text: "echo payload-key-fixture; fixture-control-credential\nAuthorization: Bearer session-secret\nCookie: session=cookie-secret", by: "fixture" } });
    f.journal.append({ kind: "evidence.added", evidence: { id: "safe-evidence", kind: "text", station: "curation/facts", attempt: "safe-attempt", token: "safe-task", at: 1, label: "引用", meta: { password: "nested-password", token: "payload-token" } } });
    f.docs.write("case", "site");
    const json = fs.readFileSync(f.docs.caseJsonFile("site"), "utf8"), md = fs.readFileSync(f.docs.caseFile("site"), "utf8");
    for (const secret of ["fixture-control-credential", "payload-key-fixture", "payload-bearer-fixture", "url-secret", "session-secret", "cookie-secret", "nested-password", "payload-token", "user:password", "127.0.0.1:9999"]) {
      assert.ok(!json.includes(secret), secret); assert.ok(!md.includes(secret), secret);
    }
    assert.match(json, /safe-task/); assert.match(json, /safe-evidence/); assert.match(json, /path=story/);
    assert.equal(JSON.parse(json).runs[0].tokens[0].data.facts.license.value, "unknown");
    const { digest, ...value } = JSON.parse(json);
    assert.equal(digest, crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"));
    assert.match(md, new RegExp(digest));
  } finally { if (before === undefined) delete process.env.FACTORY_TOKEN; else process.env.FACTORY_TOKEN = before; f.close(); }
});

test("read-only Docs never mkdir or write, and unsafe item/context names cannot escape or collide", () => {
  const f = fixture();
  try {
    create(f.journal, "x", "../outside");
    const missing = path.join(f.dir, "read-only-documents"), readonly = new Docs(f.host, missing, "read only", { readOnly: true });
    assert.match(readonly.renderCase("../outside"), /案卷/);
    readonly.schedule("case", "../outside"); readonly.write("case", "../outside"); readonly.writeAllCases(); readonly.writeAllContexts(); readonly.flush();
    assert.equal(fs.existsSync(missing), false);
    const ids = ["..", "../outside", "a/b", "a:b", "A", "a", "CON", "con.txt", "name.", "~"], paths = ids.map((id) => f.docs.caseFile(id).toLowerCase());
    assert.equal(new Set(paths).size, ids.length);
    for (const id of ids) {
      f.docs.write("case", id);
      assert.ok(!path.relative(path.join(f.dir, "cases"), f.docs.caseFile(id)).startsWith(".."));
      assert.equal(JSON.parse(fs.readFileSync(f.docs.caseJsonFile(id), "utf8")).caseId, id);
    }
    assert.throws(() => f.docs.contextFile("../../outside"), /Unknown context/);
    assert.equal(fs.existsSync(path.join(f.dir, "CASE.md")), false);
  } finally { f.close(); }
});

test("junctions are rejected and failed atomic replacements preserve the prior complete file and clean only their temporary file", (t) => {
  const f = fixture();
  try {
    f.docs.write("case", "site");
    const file = f.docs.caseFile("site"), before = fs.readFileSync(file, "utf8"), rename = fs.renameSync;
    const mock = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => { if (String(to) === file) throw new Error("simulated rename failure"); return rename(from, to); });
    assert.throws(() => f.docs.write("case", "site"), /simulated rename failure/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["CASE.md", "case.json"].sort());
    mock.mock.restore();
    const outside = path.join(f.dir, "outside"), link = path.dirname(f.docs.caseFile("linked"));
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "CASE.md"), "must survive");
    try { fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.diagnostic("Directory symlinks unavailable; atomic replacement assertions passed"); return; } throw error; }
    assert.throws(() => f.docs.write("case", "linked"), /symbolic link or junction/);
    assert.equal(fs.readFileSync(path.join(outside, "CASE.md"), "utf8"), "must survive");
    assert.equal(fs.existsSync(path.join(outside, "case.json")), false);
  } finally { f.close(); }
});
