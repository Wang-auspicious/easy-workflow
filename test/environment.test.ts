// Spec §30–§36: the environment Easy Workflow builds for agents — adaptive browser pool, advice-bearing
// failures, rendered CONTEXT / CASE documents, the station toolbox, direct reviewer
// consultation with bounded rounds, candidate normalization and v3 assembly.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h2-environment-"));
process.env.FACTORY_VAR = dir; process.env.FACTORY_PREFLIGHT = "0"; process.env.FACTORY_HTTP_CACHE = "0";
const { Broker } = await import("../server/broker.ts");
const { classifyFailure } = await import("../shared/failures.ts");
const { repoOf } = await import("../server/repo.ts");
const { resourceType, canonical } = await import("../packs/vislexicon/tools.ts");
const { webpSize, ownerOf, validateV3, loadTaxonomy } = await import("../packs/vislexicon/v3.ts");
const { CONTEXT_HEADER, CASE_HEADER } = await import("../server/docs.ts");
const { Factory } = await import("../server/factory.ts");
const { closeNetwork } = await import("../server/network.ts");
const { EvidenceStore } = await import("../server/evidence.ts");
const { FRONTEND } = await import("../packs/vislexicon/env.ts");
const taxonomyAvailable = [FRONTEND, process.env.VISLEXICON_BUNDLED].filter(Boolean).some(root => fs.existsSync(path.join(root!, "src", "data", "curation-taxonomy.js")));

test("browser pages default to 8 and shrink with free memory, then recover", () => {
  const b = new Broker({ browser: 8, model: 8, cpu: 4, http: 6 }, 1024);
  b.freeMem = () => 1024 + 250 * 20; assert.equal(b.effectiveBrowser(), 8);
  b.freeMem = () => 1024 + 250 * 3; assert.equal(b.effectiveBrowser(), 3);
  const leases = [b.tryAcquire("browser"), b.tryAcquire("browser")];
  assert.ok(leases.every(Boolean));
  b.freeMem = () => 1024 + 250 * 1; assert.equal(b.effectiveBrowser(), 3, "free memory already reflects open pages: one more fits");
  assert.ok(b.tryAcquire("browser"));
  b.freeMem = () => 1024 + 100; assert.equal(b.effectiveBrowser(), 3);
  assert.match(String(b.blocked("browser")), /内存不足/);
  b.freeMem = () => 900; assert.match(String(b.blocked("browser")), /空闲内存/);
  b.freeMem = () => 1024 + 250 * 20; assert.equal(b.blocked("browser"), null, "the cap grows back when memory recovers");
  b.modelHold = "余额不足"; assert.match(String(b.blocked("model")), /模型暂停/);
});

test("every failure says what to do next and who owns the fix", () => {
  const tls = classifyFailure(new Error("fetch failed", { cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }) }));
  assert.equal(tls.tag, "network_tls"); assert.equal(tls.owner, "user"); assert.match(tls.nextAction!, /红灯/);
  assert.equal(classifyFailure("HTTP 403", { status: 403 }).owner, "system");
  assert.equal(classifyFailure("试了 3 页都不合格").owner, "agent");
  const model = classifyFailure("401 Unauthorized: invalid api key", { stage: "model" });
  assert.equal(model.tag, "model_unavailable"); assert.equal(model.owner, "user");
  assert.equal(classifyFailure("timeout of 401ms", {}).tag, "network_timeout", "only model stations read 401 as a model problem");
});

test("candidate normalization: resource types, repository forms and entity keys", () => {
  assert.equal(resourceType("https://github.com/shadcn-ui/ui"), "repo");
  assert.equal(resourceType("https://www.npmjs.com/package/react"), "npm");
  assert.equal(resourceType("https://x.com/someone/status/1"), "social");
  assert.equal(resourceType("https://example.test/DESIGN.md"), "file");
  assert.equal(resourceType("https://example.test/docs/button"), "doc-page");
  assert.equal(resourceType("https://example.test"), "website");
  for (const raw of ["git+https://github.com/owner/repo.git", "git@github.com:owner/repo.git", "https://github.com/owner/repo/tree/main/packages/ui", "owner/repo"]) {
    const r = repoOf(raw); assert.equal(`${r?.owner}/${r?.name}`, "owner/repo", raw);
  }
  assert.equal(repoOf("https://github.com/owner/repo/tree/main/packages/ui")?.path, "packages/ui");
  assert.equal(repoOf("magicui.design/docs"), null);
  assert.equal(canonical("https://Example.test/?utm_source=x&path=/story/button"), "https://example.test/?path=%2Fstory%2Fbutton");
});

test("field ownership routes audit problems to the right station", () => {
  assert.equal(ownerOf("facts.license"), "curation/facts");
  assert.equal(ownerOf("facets.licenses"), "curation/facts");
  assert.equal(ownerOf("facets.technologies"), "curation/catalog");
  assert.equal(ownerOf("classification.subcategory"), "curation/catalog");
  assert.equal(ownerOf("pages[2].shot.alt"), "curation/copy");
  assert.equal(ownerOf("pages[2].shot"), "curation/manual", "a wrong image goes to the owner, not to the editor");
  assert.equal(ownerOf("editorial.noteZh"), "curation/copy");
});

test("WebP headers give real widths and heights", async () => {
  const store = new EvidenceStore(path.join(dir, "webp"));
  const { execFileSync } = await import("node:child_process");
  const png = execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=4x6", "-frames:v", "1", "-f", "image2", "-c:v", "png", "pipe:1"]);
  const webp = store.put(EvidenceStore.webp(png, 1280), "webp");
  assert.deepEqual(webpSize(webp.file), { width: 4, height: 6 });
});

test("v3 assembly passes VisLexicon's own validators and reports field-addressed problems", { skip: !taxonomyAvailable && "VisLexicon is not connected; set VISLEXICON_ROOT or VISLEXICON_BUNDLED to run the real validator" }, async () => {
  const tax = await loadTaxonomy();
  const good = {
    schemaVersion: 3, entryId: "fixture-ui", entityId: "entity-fixture-ui", status: "APPROVED",
    official: { inputUrl: "https://fixture.test", finalUrl: "https://fixture.test", checkedAt: new Date().toISOString() },
    editorial: { name: "Fixture UI", takeawayZh: "组件代码复制进项目，之后归你自己改", noteZh: "我们".padEnd(130, "看"), descriptionZh: "一个组件库。" },
    classification: { recordLevel: "entry", primaryCategory: "ui-implementation", subcategory: "general-ui-components", status: "confirmed", alternatives: [], reasons: [{ statement: "有可复制的组件", evidenceUrl: "https://fixture.test/docs" }], curatorId: "h2:curation/classify", reviewerId: "h2:curation/classify-review", confirmedAt: new Date().toISOString() },
    facets: Object.fromEntries(["scenarios", "deliverables", "actions", "media", "platforms", "technologies", "workflowStages", "audiences", "access", "licenses", "contentOrganization", "languages"].map((a) => [a, a === "deliverables" ? ["component"] : []])),
    pages: ["identity", "breadth", "proof"].map((role) => ({ role, sourceUrl: `https://fixture.test/${role}`, selectionRationale: "先看这里，左边在动右边是源码", shot: { src: `/evidence/aa/${role}.webp`, alt: "组件目录与分类列表" } })),
    facts: ["author", "organization", "repository", "license", "pricing"].map((field) => ({ field, value: "unknown", sourceUrl: "https://fixture.test", evidence: "看过首页" })),
  };
  assert.deepEqual(validateV3(good, tax), []);
  const bad = structuredClone(good) as any;
  bad.classification.subcategory = "icons-symbols"; bad.facets.technologies = ["cobol"]; bad.pages[2].shot.alt = "proof screenshot"; bad.editorial.takeawayZh = "收录 150 个组件";
  const fields = validateV3(bad, tax).map((p) => p.field);
  for (const f of ["classification.subcategory", "facets.technologies", "pages[2].shot.alt", "editorial.takeawayZh"]) assert.ok(fields.includes(f), `${f} in ${fields.join(", ")}`);
});

test("project folder, rendered CONTEXT / CASE, toolbox scope and bounded direct consultation", { timeout: 30000 }, async (t) => {
  const f = new Factory();
  await f.boot();
  try {
    await t.test("a project folder holds its documents and node contexts", () => {
      for (const p of ["PROJECT.md", "LESSONS.md", "project.json", "context", "cases", "work"]) assert.ok(fs.existsSync(path.join(dir, p)), p);
      assert.ok(fs.existsSync(f.docs.contextFile("curation/facts")));
      assert.ok(fs.existsSync(f.docs.contextFile("dispatcher")));
      assert.equal(f.settings.browser, 8);
    });
    await t.test("CONTEXT.md has a fixed format guard, version and instructions", () => {
      f.journal.append({ kind: "context.noted", node: "curation/facts", note: { kind: "instruction", text: "GitHub Pages 站先查仓库", by: "主调度" } });
      const md = f.docs.renderContext("curation/facts");
      assert.ok(md.includes(CONTEXT_HEADER));
      const sections = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
      assert.deepEqual(sections, ["版本", "本轮进度", "站长 / 主调度指示", "最近交接", "待解决问题", "工作笔记", "待批准的经验"]);
      assert.match(md, /ROLE\.md @ [0-9a-f]{12}/);
      assert.match(md, /GitHub Pages 站先查仓库/);
      const envelope = f.docs.envelope(f.compiled.nodes.find((n) => n.key === "curation/facts")!, "case-x", ["case_read", "fetch_text"]);
      assert.match(envelope.text, /# 事实核验员/); assert.match(envelope.text, /GitHub Pages 站先查仓库/); assert.match(envelope.text, /能力箱/); assert.match(envelope.text, /案卷/);
    });
    await t.test("the toolbox refuses tools outside the station's scope and explains bad arguments", async () => {
      const ctx = { node: "curation/classify", token: "t-x", caseId: "case-x", signal: new AbortController().signal };
      const denied = await f.toolbox.call(["case_read"], "repo_meta", { repo: "a/b" }, ctx) as any;
      assert.equal(denied.ok, false); assert.match(denied.failure.nextAction, /可用/);
      const badArgs = await f.toolbox.call(["case_note"], "case_note", { section: "x" }, ctx) as any;
      assert.equal(badArgs.ok, false); assert.match(badArgs.failure.nextAction, /env_help/);
      assert.equal((await f.toolbox.call(["case_note"], "case_note", { section: "拍摄提醒", text: "演示全在 iframe 里" }, ctx) as any).ok, true);
      assert.ok(f.state.cases["case-x"].some((n) => n.text === "演示全在 iframe 里"));
      const md = f.docs.renderCase("case-x");
      assert.ok(md.includes(CASE_HEADER)); assert.match(md, /拍摄提醒/);
      const help = f.toolbox.help(["page_text", "case_read"]) as any;
      assert.deepEqual(help.tools.map((x: { name: string }) => x.name), ["page_text", "case_read"]);
      assert.match(help.environment, /统一出口/);
    });
    await t.test("a reviewer that never passes hands over after three rounds with the full exchange", async () => {
      f.broker.memoryFloorMB = 0;
      f.runtime.start("consult rounds");
      let copies = 0;
      f.runtime.executors = (n) => async () => {
        if (n.key === "curation/copy-review") return { ok: true, summary: "still wrong", verdict: { verdict: "fix", reason: "noteZh 仍是空话", fixes: [{ station: "curation/copy", fields: ["editorial.noteZh"], problem: "noteZh 仍是空话" }] } };
        if (n.key === "curation/copy") { copies++; return { ok: true, summary: "rewrote", data: { reply: `第 ${copies} 次改写手记` } }; }
        return { ok: true, summary: "fixture" };
      };
      const token = f.runtime.create("curation/copy", { item: "stubborn", url: "https://fixture.test", source: "manual" });
      for (let i = 0; i < 300 && f.state.tokens[token.id].status === "active"; i++) await delay(10);
      assert.equal(f.state.tokens[token.id].status, "manual");
      assert.equal(copies, 4, "first draft plus three repairs");
      assert.match(f.state.tokens[token.id].reason ?? "", /3 轮/);
      const consults = Object.values(f.state.consults).filter((c) => c.token === token.id);
      assert.equal(consults.length, 3); assert.ok(consults.every((c) => c.outcome === "manual"));
      assert.match(f.docs.renderCase("stubborn"), /第 3 次改写手记/);
    });
    await t.test("owner-facing failures light a red alert; retrying the item clears it", async () => {
      f.runtime.executors = () => async () => { throw new Error("fetch failed", { cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }) }); };
      const token = f.runtime.create("curation/scout", { item: "expired-cert", url: "https://expired.test", source: "candidates/pool", data: { canonical: "https://expired.test" } });
      for (let i = 0; i < 200 && f.state.tokens[token.id].status === "active"; i++) await delay(10);
      assert.equal(f.state.tokens[token.id].status, "parked");
      const alert = f.state.alerts["tls:expired-cert"];
      assert.ok(alert); assert.equal(alert.kind, "tls"); assert.match(alert.nextAction ?? "", /红灯|证书/);
      f.runtime.executors = () => async () => ({ ok: true, summary: "fixture", finish: { status: "published", reason: "fixture" } });
      f.retryCandidates({ items: ["expired-cert"], count: 1 });
      assert.equal(f.state.alerts["tls:expired-cert"], undefined);
      await f.runtime.settle();
    });
  } finally {
    f.runtime.end(); await f.runtime.close(); f.docs.flush(); f.journal.close(); await closeNetwork();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
