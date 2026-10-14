import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Journal } from "../server/journal.ts";
import {Docs} from '../server/docs.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-case-boot-"));
Object.assign(process.env, { FACTORY_VAR: dir, FACTORY_PREFLIGHT: "0", FACTORY_HTTP_CACHE: "0", FACTORY_DISCOVERY: "0", FACTORY_START_PAUSED: "1", VISLEXICON_ROOT: path.join(dir, "unconnected") });
const { Factory } = await import("../server/factory.ts");
const { closeNetwork } = await import("../server/network.ts");
const close = async (f: InstanceType<typeof Factory>) => { await f.runtime.close(); f.lessons.close(); f.docs.flush(); f.journal.close(); };
const waitForCase = async (f: InstanceType<typeof Factory>, item: string) => {
  const file = f.docs.caseJsonFile(item);
  const digest = f.docs.caseData(item).digest;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).digest === digest) return; } catch { /* Backfill may still be pending. */ }
    await delay(25);
  }
  assert.fail('Background case repair did not complete');
};

test("Factory rebuilds legacy cases on boot, batches live progress and flushes late data/evidence before close", async (t) => {
  const seed = new Journal(path.join(dir, "journal.db"));
  seed.append({ kind: "run.started", runId: "legacy", title: "historical case" });
  seed.append({ kind: "token.created", token: "legacy-item", item: "case-site", source: "manual", line: "curation", url: "https://example.test/" });
  seed.append({ kind: "token.finished", token: "legacy-item", status: "published", node: "curation/published", reason: "historical fixture" });
  seed.append({ kind: "run.ended", runId: "legacy", manual: true }); seed.close();
  let f: InstanceType<typeof Factory> | undefined;
  try {
    let bootWrites = 0;
    const originalWrite = Docs.prototype.write;
    const bootMock = t.mock.method(Docs.prototype, 'write', function(this: Docs, kind: 'context' | 'case', id: string) {
      if (kind === 'case') bootWrites++;
      return originalWrite.call(this, kind, id);
    });
    f = new Factory(); await f.boot();
    assert.equal(bootWrites, 0, 'startup must not synchronously rebuild historical case files');
    await waitForCase(f, 'case-site');
    bootMock.mock.restore();
    const file = f.docs.caseJsonFile("case-site"), markdown = f.docs.caseFile("case-site");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).runs[0].id, "legacy");
    let caseWrites = 0;
    const write = f.docs.write.bind(f.docs);
    const mock = t.mock.method(f.docs, "write", (kind: "context" | "case", id: string) => { if (kind === "case") caseWrites++; return write(kind, id); });
    f.journal.append({ kind: "run.started", runId: "live", title: "progress batch" });
    f.journal.append({ kind: "token.created", token: "live-item", item: "case-site", source: "manual", line: "curation", url: "https://example.test/" });
    f.journal.append({ kind: "attempt.started", attempt: "live-attempt", token: "live-item", node: "curation/facts", worker: "fixture", input: "facts" });
    for (let i = 0; i < 120; i++) f.journal.append({ kind: "attempt.progress", attempt: "live-attempt", text: `progress ${i}`, step: { tool: "fetch_text", text: "fixture source" } });
    assert.equal(caseWrites, 0, "journal listeners must not write files for each streamed progress event");
    await delay(950);
    assert.equal(caseWrites, 1, "a stream burst has one case write");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).runs[1].attempts[0].actions.length, 120);
    f.journal.append({ kind: "evidence.added", evidence: { id: "late-evidence", kind: "text", label: "late source", station: "curation/facts", token: "live-item", attempt: "live-attempt", at: Date.now(), meta: { sourceUrl: "https://example.test/about" } } });
    f.journal.append({ kind: "token.data", token: "live-item", patch: { facts: { author: { value: "unknown" } } } });
    f.journal.append({ kind: "review.verdict", token: "live-item", node: "curation/fact-review", verdict: "return", returnTo: "curation/facts", reason: "source missing" });
    f.journal.append({ kind: "correction.created", correction: "late-fix", token: "live-item", node: "curation/facts", reason: "need source", evidence: "late-evidence" });
    f.journal.append({ kind: "attempt.finished", attempt: "live-attempt", ok: false, summary: "source missing", ms: 20, queuedMs: 0 });
    f.journal.append({ kind: "token.finished", token: "live-item", status: "manual", node: "curation/manual", reason: "source missing" });
    f.journal.append({ kind: "run.ended", runId: "live", manual: true });
    assert.equal(caseWrites, 1);
    await close(f); f = undefined;
    assert.equal(caseWrites, 2, "close-time flush drains the pending batch immediately");
    mock.mock.restore();
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(persisted.runs[1].status, "ended");
    assert.equal(persisted.runs[1].evidence[0].id, "late-evidence");
    assert.equal(persisted.runs[1].corrections[0].correction, "late-fix");
    assert.ok(persisted.runs[1].decisions.some((e: { kind: string }) => e.kind === "review.verdict"));
    fs.writeFileSync(file, "broken derived JSON"); fs.writeFileSync(markdown, "stale derived markdown");
    f = new Factory(); await f.boot(); await waitForCase(f, 'case-site');
    const rebuilt = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(rebuilt, f.docs.caseData("case-site"));
    assert.equal(fs.readFileSync(markdown, "utf8"), f.docs.renderCase("case-site"));
    let writesAfterClose = 0;
    const closeMock = t.mock.method(f.docs, 'write', (kind: 'context' | 'case', id: string) => {
      writesAfterClose++;
      return originalWrite.call(f!.docs, kind, id);
    });
    f.docs.scheduleAllCases();
    f.docs.flush();
    assert.equal(writesAfterClose, 0, 'shutdown cancels historical backfill instead of rebuilding the library');
    await delay(40);
    assert.equal(writesAfterClose, 0, 'cancelled backfill must not write after shutdown');
    closeMock.mock.restore();
    await close(f); f = undefined;

    const bytes = fs.readFileSync(file), mdBytes = fs.readFileSync(markdown);
    process.env.FACTORY_READONLY = "1";
    f = new Factory(); await f.boot();
    f.docs.write("case", "case-site"); f.docs.writeAllCases(); f.docs.schedule("case", "new-read-only-case"); f.docs.flush();
    assert.deepEqual(fs.readFileSync(file), bytes); assert.deepEqual(fs.readFileSync(markdown), mdBytes);
    assert.equal(fs.existsSync(f.docs.caseJsonFile("new-read-only-case")), false);
  } finally {
    if (f) await close(f);
    await closeNetwork(); delete process.env.FACTORY_READONLY;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
