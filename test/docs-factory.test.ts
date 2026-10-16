import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Journal } from "../server/journal.ts";
import {Docs} from '../server/docs.ts';
import {apply, initialState} from '../shared/project.ts';
import {compile} from '../server/spec/compile.ts';
import {pack} from '../packs/vislexicon/pack.ts';

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
    let fullReads = 0;
    const originalRead = Journal.prototype.read;
    const bootRead = t.mock.method(Journal.prototype, 'read', function* (this: Journal, since = 0, run?: string, through?: number) {
      if (since === 0 && run === undefined) fullReads++;
      yield* originalRead.call(this, since, run, through);
    });
    const originalWrite = Docs.prototype.write;
    const bootMock = t.mock.method(Docs.prototype, 'write', function(this: Docs, kind: 'context' | 'case', id: string) {
      if (kind === 'case') bootWrites++;
      return originalWrite.call(this, kind, id);
    });
    f = new Factory(); await f.boot();
    assert.equal(fullReads, 1, 'startup shares exactly one full replay, including bounded journal reads');
    bootRead.mock.restore();
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

test('document snapshots retain cross-run indexes independently of a newer factory projection', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-doc-snapshot-'));
  const journal = new Journal(path.join(directory, 'journal.db'));
  const compiled = compile([pack]);
  const state = initialState(compiled);
  journal.subscribeProjection(event => apply(state, event));
  const host = {journal, compiled, state};
  const reference = new Docs(host, directory, 'snapshot fixture');
  try {
    journal.append({kind: 'run.started', runId: 'old-doc-run', title: 'Old case'});
    journal.append({kind: 'token.created', token: 'old-doc-token', item: 'shared-case', line: 'curation',
      source: 'manual', url: 'https://example.test/'});
    journal.append({kind: 'attempt.started', attempt: 'old-doc-attempt', token: 'old-doc-token',
      node: 'curation/facts', worker: 'fixture', input: 'Old source'});
    const middle = journal.seq;
    journal.append({kind: 'attempt.progress', attempt: 'old-doc-attempt', text: 'Keep old observation'});
    journal.append({kind: 'token.data', token: 'old-doc-token', patch: {facts: {license: 'old'}}});
    journal.append({kind: 'attempt.finished', attempt: 'old-doc-attempt', ok: true,
      summary: 'Old result', ms: 1, queuedMs: 0});
    journal.append({kind: 'run.ended', runId: 'old-doc-run', manual: true});
    const ended = journal.seq;
    journal.append({kind: 'run.started', runId: 'new-doc-run', title: 'New case'});
    journal.append({kind: 'token.data', token: 'old-doc-token', patch: {facts: {license: 'new'}}});
    journal.append({kind: 'case.noted', caseId: 'legacy-without-token', token: 'missing',
      note: {station: 'curation/facts', section: 'handoff', text: 'Legacy note', by: 'fixture'}});
    const events = [...journal.read()];
    for (const cut of [middle, ended, journal.seq]) {
      const prefix = new Docs(host, directory, 'snapshot fixture', {deferReplay: true});
      for (const event of events) if (event.seq <= cut) prefix.observeReplay(event);
      const restored = new Docs(host, directory, 'snapshot fixture', {deferReplay: true});
      restored.restore(prefix.serialize());
      for (const event of events) if (event.seq > cut) restored.observe(event);
      const read = t.mock.method(journal, 'read', () => {
        assert.fail('Restored document indexes must not reread journal history');
      });
      try {
        assert.deepEqual(restored.caseIds(), reference.caseIds());
        for (const id of reference.caseIds()) {
          assert.deepEqual(restored.caseData(id), reference.caseData(id));
        }
        assert.equal(restored.caseData('shared-case').runs[0].tokens[0].data.facts &&
          (restored.caseData('shared-case').runs[0].tokens[0].data.facts as {license: string}).license, 'old');
        const before = restored.serialize();
        assert.throws(() => restored.restore('{broken'), SyntaxError);
        assert.throws(() => restored.restore('{}'), /Invalid docs snapshot/);
        assert.equal(restored.serialize(), before, 'failed restore leaves the valid document index intact');
        assert.equal(read.mock.callCount(), 0);
      } finally {
        read.mock.restore();
      }
    }
    const live = new Docs(host, directory, 'snapshot fixture', {deferReplay: true});
    live.restore(reference.serialize());
    live.start();
    journal.append({kind: 'attempt.progress', attempt: 'old-doc-attempt', text: 'Late indexed event'});
    assert.deepEqual(live.caseData('shared-case'), reference.caseData('shared-case'));
    live.flush();
  } finally {
    reference.flush();
    journal.close();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
