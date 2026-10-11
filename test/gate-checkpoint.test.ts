import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { StationContext } from "../server/runtime.ts";
import type { EvidenceStore } from "../server/evidence.ts";

// This fixture isolates the screenshot contract; taxonomy validation has its own tests.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "h2-gate-checkpoint-"));
process.env.VISLEXICON_ROOT = path.join(root, "no-external-taxonomy");
process.env.VISLEXICON_BUNDLED = path.join(root, "taxonomy");
const dataDir = path.join(process.env.VISLEXICON_BUNDLED, "src", "data");
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, "curation-taxonomy.js"), `
export const CURATION_CATEGORIES = [];
export const CURATION_SUBCATEGORIES = {};
export const CURATION_FACET_AXES = {access: [], licenses: [{id: "unknown", aliases: []}]};
export const facetsErrors = () => [];
export const classificationErrors = () => [];
`);
const { TOOLS } = await import("../packs/vislexicon/tools.ts");
const { Runtime } = await import("../server/runtime.ts");
const { Broker } = await import("../server/broker.ts");
const { Journal } = await import("../server/journal.ts");
const { compile } = await import("../server/spec/compile.ts");
const { pack } = await import("../packs/vislexicon/pack.ts");
const { shotReview } = await import("../packs/vislexicon/agents.ts");
const compiled = compile([pack]);
const store = { resolve: () => null } as unknown as EvidenceStore;
const svc = { store, workDir: root, publishDir: path.join(root, "published"), inFlight: () => new Set<string>() };
const publication = path.join(svc.publishDir, "fixture.test.json");
const previousPublication = '{"historical":"preserve until the repaired gate passes"}\n';

function inheritedData(previews?: number) {
  const roles = ["identity", "breadth", "proof"];
  return {
    canonical: "https://fixture.test", host: "fixture.test", key: "fixture.test", title: "Fixture", kind: "component-source", kindAgreed: true, mode: "shots",
    retryOf: "historical-token", recoveryStation: "curation/gate", recoveryRoot: "curation/plan",
    shots: { breadth: { href: "https://fixture.test/docs", previews } },
    images: roles.map(role => ({ role, href: `https://fixture.test/${role}`, src: `/evidence/${role}.webp`, card: `/evidence/${role}.webp` })),
    shotReview: "pass", "fact-reviewVerdict": "pass", "copy-reviewVerdict": "pass", auditVerdict: "pass",
    style: { applicable: true, subjectVisible: true },
    facts: Object.fromEntries(["author", "organization", "repository", "license", "pricing"].map(field => [field, { value: "unknown", sourceUrl: "https://fixture.test", evidence: "已检查一手说明" }])),
    catalogV3: { primaryCategory: "ui-implementation", subcategory: "general-ui-components", facets: {} },
    copy: { name: "Fixture", takeawayZh: "组件代码直接带走", noteZh: "我们".padEnd(130, "看"), rationale: Object.fromEntries(roles.map(role => [role, "页面里的真实组件预览"])), alt: Object.fromEntries(roles.map(role => [role, "页面里的组件预览"])), reasons: [{ statement: "交付可复用组件", evidenceUrl: "https://fixture.test/docs" }] },
  };
}

test("the final gate rejects inherited image approval and resumes the screenshot checkpoint", async t => {
  fs.mkdirSync(svc.publishDir, { recursive: true });
  try {
    await t.test("missing and insufficient counts request repairs without overwriting the historical file", async () => {
      for (const previews of [undefined, 0, 3]) {
        fs.writeFileSync(publication, previousPublication);
        const ctx = { token: { id: "new-token", url: "https://fixture.test", data: inheritedData(previews) }, attempt: "gate", progress: () => {}, addEvidence: () => ({}) } as unknown as StationContext;
        const result = await TOOLS["curation.gate"](ctx, svc);
        assert.equal(result.verdict?.verdict, "fix", `an inherited pass with previews=${previews} is not sufficient`);
        assert.equal(result.verdict?.fixes?.[0]?.station, "curation/breadth");
        assert.deepEqual(result.verdict?.fixes?.[0]?.via?.slice(0, 2), ["curation/process", "curation/shot-review"]);
        assert.notEqual(result.data?.gate, "pass");
        assert.notEqual(result.data?.shotReview, "pass");
        assert.equal(fs.readFileSync(publication, "utf8"), previousPublication);
      }
    });
    await t.test("a real restored flow repairs related evidence before gate publication", async () => {
      fs.writeFileSync(publication, previousPublication);
      const journal = new Journal(":memory:");
      const order: string[] = [];
      const runtime = new Runtime(compiled, journal, new Broker({ model: 8, cpu: 4, browser: 8, http: 6 }, 0), {
        shots: () => true, video: () => false, needsProof: () => true, noProof: () => false, complete: data => data.gate === "pass", incomplete: data => data.gate !== "pass",
      }, node => async ctx => {
        order.push(node.key);
        if (node.key === "curation/gate" || node.key === "curation/assemble") return TOOLS[node.tool!](ctx, svc);
        assert.equal(fs.readFileSync(publication, "utf8"), previousPublication, "no intermediate repair may overwrite the historical publication");
        if (node.key === "curation/breadth") return { ok: true, summary: "new gallery has four previews", data: { shots: { breadth: { href: "https://fixture.test/gallery", previews: 4 } } } };
        if (node.key === "curation/shot-review") return shotReview(store).after!({ verdict: "pass", reason: "four rendered previews visible", perImage: [] }, ctx, { rounds: 1, issues: [] });
        if (node.key === "curation/style") return { ok: true, summary: "new image style checked", data: { style: { applicable: true, subjectVisible: true } } };
        if (node.key === "curation/copy-review") return { ok: true, summary: "new captions reviewed", data: { "copy-reviewVerdict": "pass" }, verdict: { verdict: "pass", reason: "caption matches new image" } };
        if (node.key === "curation/audit") return { ok: true, summary: "updated record reviewed", data: { auditVerdict: "pass" }, verdict: { verdict: "pass", reason: "updated record reviewed" } };
        return { ok: true, summary: "related checkpoint repaired" };
      });
      runtime.ensureWorkers([]); runtime.start("retry historical gate");
      const token = runtime.create("curation/gate", { item: "fixture.test", url: "https://fixture.test", source: "candidates/pool", data: inheritedData() });
      // This is the same restored closure/done mechanism used by retryCandidates.
      token.entry = "curation/plan"; token.closure = runtime.closureOf(token.entry);
      token.done = new Set([...token.closure].filter(key => !["curation/gate", "curation/published", "curation/manual"].includes(key)));
      runtime.restoreFlow(token);
      try {
        for (let i = 0; i < 100 && !token.finished; i++) await delay(5);
        assert.ok(token.finished);
        assert.deepEqual(order, ["curation/gate", "curation/breadth", "curation/process", "curation/shot-review", "curation/style", "curation/copy", "curation/copy-review", "curation/assemble", "curation/audit", "curation/gate"]);
        assert.equal(token.data.gate, "pass");
        assert.equal(JSON.parse(fs.readFileSync(publication, "utf8")).h2.token, token.id);
        const requests = [...journal.read()].filter(event => event.kind === "consult.opened");
        assert.equal(requests.length, 1); assert.equal(requests[0].reviewer, "curation/gate");
      } finally { await runtime.close(); journal.close(); }
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
