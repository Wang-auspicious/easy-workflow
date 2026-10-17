import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { JournalEvent } from "../shared/types.ts";
import { apply, initialState } from "../shared/project.ts";
import { compile } from "../server/spec/compile.ts";
import { pack } from "../packs/vislexicon/pack.ts";
import { Journal } from "../server/journal.ts";
import { Docs } from "../server/docs.ts";
import { EvidenceStore } from "../server/evidence.ts";
import { Lessons, groupLessonObservations, projectLessons } from "../server/lessons.ts";
import { ensureProject } from "../server/workspace.ts";

const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const station = "curation/facts";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h2-lessons-"));
  ensureProject(dir, "lesson test");
  const rolesRoot = path.join(dir, "roles"), roleFile = path.join(rolesRoot, station, "ROLE.md");
  fs.mkdirSync(path.dirname(roleFile), { recursive: true });
  const role = "# 事实核验员\n\n铁律：每条事实都要有来源。\n";
  fs.writeFileSync(roleFile, role);
  const compiled = compile([pack]), journal = new Journal(path.join(dir, "journal.db")), state = initialState(compiled);
  journal.subscribe((e) => apply(state, e));
  const f = { compiled, journal, state, docs: undefined as Docs | undefined };
  const docs = f.docs = new Docs(f, dir, "lesson test");
  let lessons = new Lessons(f, dir, { rolesRoot });
  const store = new EvidenceStore(path.join(dir, "evidence"));
  const asset = store.put(Buffer.from("fixture immutable image bytes"), "webp");
  const emit = (e: JournalEvent) => journal.append(e);
  const start = (runId: string) => emit({ kind: "run.started", runId, title: runId });
  const end = (runId: string) => emit({ kind: "run.ended", runId, manual: true });
  const create = (item: string, token: string) => {
    emit({ kind: "token.created", token, line: "curation", item, url: `https://${item}.test/`, source: "manual" });
    emit({ kind: "token.data", token, patch: { key: item, dossier: { framework: ["Storybook"] } } });
  };
  const attempt = (token: string, ok = true, exposed = false) => {
    const id = `${token}-attempt`;
    emit({ kind: "attempt.started", attempt: id, token, node: station, worker: "fixture-worker", input: "fixture" });
    if (exposed) docs.envelope(compiled.nodes.find((n) => n.key === station)!, state.tokens[token].item, undefined, { token, attempt: id });
    emit({ kind: "attempt.finished", attempt: id, ok, summary: ok ? "source verified" : "review feedback", ms: 1, queuedMs: 0, ...(!ok ? { error: "HTTP 503" } : {}) });
  };
  const publish = (item: string, token: string, options: { trial?: string; expose?: boolean; create?: boolean; text?: string } = {}) => {
    if (options.create !== false) create(item, token);
    if (options.trial) lessons.bindValidation(options.trial, [token]);
    attempt(token, true, options.expose ?? Boolean(options.trial));
    const record = { schemaVersion: 3, entryId: item, official: { finalUrl: `https://${item}.test/`, checkedAt: "now" }, classification: { confirmedAt: "now" }, editorialVoice: { writtenAt: "today" }, editorial: { noteZh: options.text ?? "原始事实有直接证据。" }, pages: ["identity", "breadth", "proof"].map((role) => ({ role, shot: { src: asset.src } })), h2: { token, note: "test fixture" } };
    const digest = hash(JSON.stringify({ ...record, official: { ...record.official, checkedAt: "" }, classification: { ...record.classification, confirmedAt: "" }, editorialVoice: null }));
    fs.mkdirSync(path.join(dir, "published"), { recursive: true });
    fs.writeFileSync(path.join(dir, "published", `${item}.json`), JSON.stringify({ ...record, h2: { ...record.h2, digest, publishedAt: "now" } }, null, 2));
    emit({ kind: "token.data", token, patch: { gate: "pass", digest } });
    emit({ kind: "evidence.added", evidence: { id: `gate-${token}`, kind: "verdict", label: "发布闸门", station: "curation/gate", token, attempt: `${token}-gate`, at: Date.now(), tone: "ok", meta: { digest, entryId: item } } });
    emit({ kind: "token.finished", token, node: "curation/published", status: "published", reason: "fixture passed gate" });
  };
  const seed = () => {
    start("published-baselines"); publish("known-a", "old-a"); publish("known-b", "old-b"); end("published-baselines");
    start("failed-run"); create("failed-site", "bad"); attempt("bad", false);
    emit({ kind: "token.finished", token: "bad", node: station, status: "parked", reason: "HTTP 503" });
    emit({ kind: "candidate.disposition", candidate: { item: "failed-site", token: "bad", url: "https://failed-site.test/", title: "failed site", source: "manual", disposition: "retry", failure: { tag: "http_server", category: "network", retryable: true, message: "HTTP 503", nextAction: "先检查上游可用性，保留已有事实证据，再重跑失败工位。" } } });
    end("failed-run");
    return lessons.draftRun("failed-run")[0];
  };
  const trial = (draft = seed()) => lessons.beginValidation(draft.id, { digest: draft.digest, regressionItems: ["known-a", "known-b"] });
  const rerun = (id: string, expose = true) => {
    start("validation-run");
    publish("failed-site", "rerun-failed", { trial: id, expose });
    publish("known-a", "rerun-a", { trial: id, expose });
    publish("known-b", "rerun-b", { trial: id, expose, text: "回归中重新核实了资料。" });
    end("validation-run");
  };
  return { dir, f, emit, start, end, create, attempt, publish, seed, trial, rerun, docs, journal, roleFile, role, asset,
    get lessons() { return lessons; },
    reload() { lessons.close(); lessons = new Lessons(f, dir, { rolesRoot }); return lessons; },
    close() { lessons.close(); docs.flush(); journal.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('shared lessons inject five newest active entries and deletion survives replay without changing ROLE', () => {
  const f = fixture();
  try {
    f.seed();
    const evidence = Object.keys(f.f.state.attempts).slice(0, 1);
    for (let index = 0; index < 7; index++) f.lessons.writeShared({id: `shared-${index}`, node: station,
      text: `经验 ${index}`, evidence, at: index, status: 'active'});
    f.lessons.writeShared({id: 'trial', node: station, text: '尚未生效', evidence, at: 100, status: 'canary'});
    assert.deepEqual(f.lessons.activeFor(station), ['经验 6', '经验 5', '经验 4', '经验 3', '经验 2']);
    assert.throws(() => f.lessons.writeShared({id: 'long', node: station, text: '长'.repeat(301), evidence, at: 101, status: 'active'}));
    assert.throws(() => f.lessons.writeShared({id: 'fake', node: station, text: '虚构证据', evidence: ['missing'], at: 101, status: 'active'}));
    f.lessons.deleteShared('shared-6');
    assert.deepEqual(f.reload().activeFor(station), ['经验 5', '经验 4', '经验 3', '经验 2', '经验 1']);
    assert.equal(fs.readFileSync(f.roleFile, 'utf8'), f.role);
    assert.equal(f.lessons.activeFor('curation/style').length, 0);
  } finally { f.close(); }
});

test("round-end review conserves candidate, return and every consultation observation, without leaking later frameworks", () => {
  const f = fixture();
  try {
    const draft = f.seed();
    f.start("review-run"); f.create("second-site", "second");
    f.emit({ kind: "token.returned", token: "second", from: "curation/fact-review", to: station, reason: "出处没有支持这个事实", round: 1 });
    f.emit({ kind: "consult.opened", consult: "c", token: "second", reviewer: "curation/fact-review", owner: station, fields: ["facts.license"], problem: "出处没有支持这个事实", round: 1 });
    f.emit({ kind: "consult.replied", consult: "c", token: "second", owner: station, reply: "重新核对", ok: true });
    f.emit({ kind: "consult.closed", consult: "c", token: "second", outcome: "resolved", reason: "已核实" });
    f.end("review-run");
    f.start("later-run");
    f.emit({ kind: "token.data", token: "second", patch: { dossier: { framework: ["Next.js"] } } });
    const grouped = groupLessonObservations([...f.journal.read()], "review-run", f.f.compiled);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].length, 4, "consult replies/closures remain auditable, not discarded duplicates");
    assert.deepEqual(grouped[0][0].framework, ["storybook"]);
    assert.equal(grouped[0][0].station, station);
    assert.equal(grouped[0][0].failureType, "review_feedback");
    assert.equal(f.lessons.draftRun("failed-run")[0].digest, draft.digest);
    assert.equal(f.lessons.list().length, 1, "same ended run is idempotent");
    assert.throws(() => f.lessons.draftRun("later-run"), /尚未结束/);
  } finally { f.close(); }
});

test("LESSONS and pending CONTEXT persist from journal; private notes and stable ROLE bytes survive", () => {
  const f = fixture();
  try {
    const file = path.join(f.dir, "LESSONS.md");
    fs.appendFileSync(file, "\n站长手写说明：不要覆盖。\n");
    const draft = f.seed();
    assert.match(fs.readFileSync(file, "utf8"), /不要覆盖/);
    assert.match(fs.readFileSync(file, "utf8"), /candidate\.disposition#\d+/);
    assert.match(f.docs.renderContext(station), /待验证与批准/);
    assert.match(f.docs.renderContext("dispatcher"), /http_server/);
    assert.equal(fs.readFileSync(f.roleFile, "utf8"), f.role);
    f.reload().write();
    assert.equal(f.lessons.get(draft.id).status, "pending");
    assert.equal(fs.readFileSync(file, "utf8").split("<!-- H2:LESSONS:START -->").length, 2);
  } finally { f.close(); }
});

test('unchanged lessons skip writes while revisions and missing lessons or context files are repaired', t => {
  const f = fixture();
  try {
    const file = path.join(f.dir, 'LESSONS.md');
    // Missing-file recovery uses this existing default heading; human/template
    // text outside the managed block cannot be recreated from journal events.
    fs.writeFileSync(file, '# 经验（LESSONS）\n');
    const draft = f.seed();
    const original = fs.readFileSync(file, 'utf8');
    const write = t.mock.method(fs, 'writeFileSync');
    f.lessons.write();
    assert.equal(write.mock.callCount(), 0, 'identical lessons and contexts require no file write');
    assert.equal(fs.readFileSync(file, 'utf8'), original);

    const context = f.docs.contextFile(station);
    const contextBody = fs.readFileSync(context, 'utf8');
    fs.unlinkSync(context);
    f.lessons.write();
    assert.equal(fs.readFileSync(context, 'utf8'), contextBody,
      'unchanged LESSONS must still repair a missing station context');
    assert.equal(write.mock.calls.filter(call => call.arguments[0] === file).length, 0);

    f.lessons.revise(draft.id, {digest: draft.digest, suggestion: 'Changed fixture lesson with direct evidence.'}, 'user');
    assert.equal(write.mock.calls.filter(call => call.arguments[0] === file).length, 1);
    const revised = fs.readFileSync(file, 'utf8');
    assert.match(revised, /Changed fixture lesson with direct evidence/);
    fs.unlinkSync(file);
    f.lessons.write();
    assert.equal(fs.readFileSync(file, 'utf8'), revised, 'a missing lessons document is regenerated');
    assert.equal(write.mock.calls.filter(call => call.arguments[0] === file).length, 2);
    f.lessons.write();
    assert.equal(write.mock.calls.filter(call => call.arguments[0] === file).length, 2);
  } finally { f.close(); }
});

test('ordinary context reads retain only lesson records and do not rebuild the view for business events', t => {
  const f = fixture();
  try {
    const draft = f.seed();
    const expected = f.lessons.list();
    const context = f.lessons.pendingContext(station);
    // These cache invariants guard the measured permanent-retention regression;
    // public output alone cannot reveal a second copy of every business event.
    const cache = f.lessons as unknown as {cachedViews: unknown; cachedLessonEvents: {kind: string}[]};
    const originalView = cache.cachedViews;
    const marker = 'business-payload-must-not-stay-in-lessons-cache';
    for (let i = 0; i < 32; i++) {
      f.emit({kind: 'token.data', token: 'bad', patch: {unrelatedObservation: marker.repeat(300) + i}});
      assert.equal(f.lessons.pendingContext(station), context);
      assert.strictEqual(cache.cachedViews, originalView, 'a non-lesson event cannot invalidate the lesson projection');
    }
    assert.equal(cache.cachedLessonEvents.length, 1);
    assert.ok(cache.cachedLessonEvents.every(event => event.kind.startsWith('lesson.')));
    assert.ok(!JSON.stringify(cache.cachedLessonEvents).includes(marker));
    const returned = f.lessons.list();
    returned[0].suggestion = 'External mutation';
    returned[0].observations[0].framework.push('external framework');
    assert.deepEqual(f.lessons.list(), expected, 'callers still receive detached views');
    const fetched = f.lessons.get(draft.id);
    fetched.observations[0].message = 'External nested mutation';
    fetched.framework.push('external framework');
    assert.deepEqual(f.lessons.get(draft.id), expected[0], 'get also returns a detached nested view');
    const clone = t.mock.method(globalThis, 'structuredClone');
    const rendered = f.lessons.render();
    for (const node of [station, 'dispatcher', 'curation/copy']) {
      f.lessons.pendingContext(node);
      assert.equal(f.lessons.render(), rendered);
    }
    assert.equal(clone.mock.callCount(), 0, 'internal context and document rendering do not clone the full lesson cache');
    clone.mock.restore();

    f.create('ordinary', 'ordinary');
    f.emit({kind: 'attempt.started', attempt: 'ordinary-active', token: 'ordinary', node: station,
      worker: 'ordinary-worker', input: 'Ordinary production work'});
    const observer = t.mock.method(f.journal, 'readKinds', () => {
      assert.fail('The live lesson index must not reread journal kinds');
    });
    const historyObserver = t.mock.method(f.journal, 'read', () => {
      assert.fail('An ordinary context read must not reread journal history');
    });
    assert.equal(f.lessons.validationContext(station, 'ordinary', {token: 'ordinary', attempt: 'ordinary-active'}), '');
    assert.equal(observer.mock.callCount(), 0);
    assert.equal(historyObserver.mock.callCount(), 0);
    observer.mock.restore();
    historyObserver.mock.restore();

    const revised = f.lessons.revise(draft.id, {digest: draft.digest, suggestion: '保留直接出处，修复后重跑原工位。'}, 'user');
    assert.notEqual(revised.digest, draft.digest);
    assert.notStrictEqual(cache.cachedViews, originalView, 'a real lesson event refreshes the cached projection');
    const authoritative = projectLessons([...f.journal.read()]);
    assert.deepEqual(f.lessons.list(), authoritative);
    const revisedContext = f.lessons.pendingContext(station);
    assert.deepEqual(f.reload().list(), authoritative, 'restart reconstructs the same lesson state from the complete journal');
    assert.equal(f.lessons.pendingContext(station), revisedContext);
    assert.equal(fs.readFileSync(f.roleFile, 'utf8'), f.role, 'a cached draft is still not an approved production rule');
  } finally {f.close();}
});

test("restored and orphan consultation replies remain in the new round with unknown frameworks stated honestly", () => {
  const f = fixture();
  try {
    f.start("before-restart");
    f.emit({ kind: "token.created", token: "restored", line: "curation", item: "restored-site", url: "https://restored.test/", source: "manual" });
    f.emit({ kind: "consult.opened", consult: "previous", token: "restored", reviewer: "curation/fact-review", owner: station, fields: ["facts.license"], problem: "引用待核实", round: 1 });
    f.end("before-restart");
    f.start("after-restart");
    f.emit({ kind: "consult.replied", consult: "previous", token: "restored", owner: station, reply: "已经核实", ok: true });
    f.emit({ kind: "consult.closed", consult: "previous", token: "restored", outcome: "resolved", reason: "引用一致" });
    f.emit({ kind: "consult.replied", consult: "legacy-orphan", token: "restored", owner: station, reply: "保留缺失前文的回复", ok: false });
    f.end("after-restart");
    const observations = groupLessonObservations([...f.journal.read()], "after-restart", f.f.compiled).flat();
    assert.equal(observations.length, 3);
    assert.ok(observations.every((o) => o.station === station));
    assert.ok(observations.every((o) => o.framework.join() === "unknown"));
  } finally { f.close(); }
});

test('lesson snapshots preserve old run observations and recover undrafted work without history rereads', t => {
  const f = fixture();
  try {
    f.start('snapshot-old');
    f.create('snapshot-site', 'snapshot-token');
    f.attempt('snapshot-token', false);
    f.emit({kind: 'consult.opened', consult: 'snapshot-consult', token: 'snapshot-token',
      reviewer: 'curation/fact-review', owner: station, fields: ['facts.license'], problem: '出处需核对', round: 1});
    const middle = f.journal.seq;
    f.emit({kind: 'token.data', token: 'snapshot-token', patch: {dossier: {framework: ['Astro']}}});
    f.emit({kind: 'consult.replied', consult: 'snapshot-consult', token: 'snapshot-token', owner: station,
      reply: '同轮回复保留最初框架', ok: true});
    f.end('snapshot-old');
    const ended = f.journal.seq;
    f.start('snapshot-new');
    f.emit({kind: 'token.data', token: 'snapshot-token', patch: {dossier: {framework: ['Next.js']},
      unrelatedLargePayload: 'do-not-retain-business-data'.repeat(400)}});
    f.emit({kind: 'consult.closed', consult: 'snapshot-consult', token: 'snapshot-token',
      outcome: 'resolved', reason: '跨轮回复按当时上下文'});
    f.emit({kind: 'consult.replied', consult: 'snapshot-orphan', token: 'snapshot-token', owner: station,
      reply: '缺失开场的历史回复', ok: false});
    f.emit({kind: 'token.finished', token: 'snapshot-token', node: 'curation/manual', status: 'manual', reason: '待复核'});
    f.emit({kind: 'token.returned', token: 'snapshot-token', from: 'curation/manual', to: station,
      reason: '重做核验', round: 1});
    f.emit({kind: 'candidate.disposition', candidate: {token: 'snapshot-token', item: 'snapshot-site',
      url: 'https://snapshot-site.test/', title: 'snapshot', source: 'manual', disposition: 'retry',
      failure: {tag: 'http_server', category: 'network', retryable: true, message: 'HTTP 503'}}});
    f.end('snapshot-new');
    f.lessons.close();
    const events = [...f.journal.read()];
    const runs = ['snapshot-old', 'snapshot-new'];
    const expected = new Map(runs.map(run => [run, groupLessonObservations(events, run, f.f.compiled)]));
    const bySequence = (groups: ReturnType<typeof groupLessonObservations>) =>
      groups.flat().sort((left, right) => left.seq - right.seq);
    assert.deepEqual(expected.get('snapshot-old')?.flat().map(entry => entry.framework), [['storybook'], ['storybook']]);
    assert.ok(expected.get('snapshot-new')?.flat().every(entry => entry.framework.join() === 'next.js'));
    for (const cut of [middle, ended, events.at(-1)!.seq]) {
      const prefix = new Lessons(f.f, f.dir, {rolesRoot: path.join(f.dir, 'roles'), deferReplay: true});
      for (const event of events) if (event.seq <= cut) prefix.observe(event);
      const body = prefix.serialize();
      assert.ok(!body.includes('do-not-retain-business-data'));
      const restored = new Lessons(f.f, f.dir, {rolesRoot: path.join(f.dir, 'roles'), deferReplay: true});
      restored.restore(body);
      for (const event of events) if (event.seq > cut) restored.observe(event);
      for (const event of f.journal.read(events.at(-1)!.seq)) restored.observe(event);
      restored.start();
      const history = t.mock.method(f.journal, 'read', () => {
        assert.fail('Restored lesson drafts must use saved observations, without rereading history');
      });
      try {
        for (const run of runs) {
          const drafts = restored.draftRun(run);
          assert.deepEqual(bySequence(drafts.map(draft => draft.observations)), bySequence(expected.get(run)!));
        }
        assert.equal(history.mock.callCount(), 0);
        assert.equal(fs.readFileSync(f.roleFile, 'utf8'), f.role);
        assert.throws(() => restored.restore('{broken'), SyntaxError);
        assert.throws(() => restored.restore('{}'), /Invalid lessons snapshot/);
      } finally {
        history.mock.restore();
        restored.close();
      }
    }
  } finally { f.close(); }
});

test("approval requires original failure reruns, distinct pre-published baselines, and actual exposure to the draft", () => {
  const f = fixture();
  try {
    const draft = f.seed();
    assert.throws(() => f.lessons.beginValidation(draft.id, { digest: draft.digest, regressionItems: ["known-a", "known-a"] }), /至少两个/);
    assert.throws(() => f.lessons.beginValidation(draft.id, { digest: draft.digest, regressionItems: ["known-a", "unpublished"] }), /没有历史已发布/);
    const trial = f.trial(draft);
    assert.throws(() => f.lessons.bindValidation(trial.id, ["old-a"]), /尚未执行/);
    assert.throws(() => f.lessons.validate(trial.id), /尚未创建/);
    f.rerun(trial.id, false);
    assert.throws(() => f.lessons.validate(trial.id), /没有实际读到/);
    assert.throws(() => f.lessons.approve(draft.id, { digest: draft.digest, validationDigest: "pretend" }, "user"), /缺少当前草案/);
    assert.equal(fs.readFileSync(f.roleFile, "utf8"), f.role);
  } finally { f.close(); }
});

test("trial bindings cannot be added after execution or selectively replace a sample with a later token", () => {
  const f = fixture();
  try {
    const draft = f.seed(), trial = f.trial(draft);
    f.start("trial-binding");
    f.create("failed-site", "already-running"); f.attempt("already-running");
    assert.throws(() => f.lessons.bindValidation(trial.id, ["already-running"]), /尚未执行/);
    f.create("known-a", "first-binding");
    f.lessons.bindValidation(trial.id, ["first-binding"]);
    f.lessons.bindValidation(trial.id, ["first-binding"]);
    f.create("known-a", "second-binding");
    assert.throws(() => f.lessons.bindValidation(trial.id, ["second-binding"]), /只能绑定一个任务/);
  } finally { f.close(); }
});

test("candidate trial context follows the exact bound token and attempt when identical items run concurrently", () => {
  const f = fixture();
  try {
    const draft = f.seed(), trial = f.trial(draft), node = f.f.compiled.nodes.find((n) => n.key === station)!;
    f.start("concurrent-trial");
    f.create("failed-site", "bound-token"); f.create("failed-site", "ordinary-token");
    f.lessons.bindValidation(trial.id, ["bound-token"]);
    for (const token of ["bound-token", "ordinary-token"]) f.emit({ kind: "attempt.started", attempt: `${token}-live`, token, node: station, worker: "fixture", input: "same item" });
    const exposed = () => [...f.journal.read()].filter((e) => e.kind === "lesson.validation.exposed");
    assert.doesNotMatch(f.docs.envelope(node, "failed-site").text, /仅本次验证使用的候选经验/);
    assert.doesNotMatch(f.docs.envelope(node, "failed-site", undefined, { token: "ordinary-token", attempt: "ordinary-token-live" }).text, /仅本次验证使用的候选经验/);
    assert.doesNotMatch(f.docs.envelope(node, "failed-site", undefined, { token: "ordinary-token", attempt: "bound-token-live" }).text, /仅本次验证使用的候选经验/);
    assert.doesNotMatch(f.docs.envelope(node, "wrong-item", undefined, { token: "bound-token", attempt: "bound-token-live" }).text, /仅本次验证使用的候选经验/);
    assert.equal(exposed().length, 0);
    const context = f.docs.envelope(node, "failed-site", undefined, { token: "bound-token", attempt: "bound-token-live" }).text;
    assert.match(context, /仅本次验证使用的候选经验/); assert.ok(context.includes(draft.suggestion));
    assert.equal(exposed().length, 1);
    assert.equal(exposed()[0].kind === "lesson.validation.exposed" && exposed()[0].token, "bound-token");
    f.docs.envelope(node, "failed-site", undefined, { token: "bound-token", attempt: "bound-token-live" });
    assert.equal(exposed().length, 1, "repeated envelope reads cannot inflate proof of exposure");
    f.emit({ kind: "attempt.finished", attempt: "bound-token-live", ok: true, summary: "finished", ms: 1, queuedMs: 0 });
    assert.doesNotMatch(f.docs.envelope(node, "failed-site", undefined, { token: "bound-token", attempt: "bound-token-live" }).text, /仅本次验证使用的候选经验/);
    assert.equal(fs.readFileSync(f.roleFile, "utf8"), f.role);
  } finally { f.close(); }
});

test("only a user can approve a digest-bound validated lesson; append is exact, durable and idempotent", () => {
  const f = fixture();
  try {
    const draft = f.seed(), trial = f.trial(draft);
    f.rerun(trial.id);
    const validation = f.lessons.validate(trial.id);
    assert.equal(validation.failures.length, 1);
    assert.equal(validation.regressions.length, 2);
    assert.deepEqual(validation.regressions.find((s) => s.item === "known-b")?.changedFields, ["editorial.noteZh"]);
    assert.equal(f.lessons.get(draft.id).status, "validated");
    for (const actor of ["agent", "dispatcher"] as const) assert.throws(() => f.lessons.approve(draft.id, { digest: draft.digest, validationDigest: validation.evidenceDigest }, actor), /只有站长/);
    assert.throws(() => f.lessons.approve(draft.id, { digest: draft.digest, validationDigest: "stale" }, "user"), /缺少当前草案/);
    const result = f.lessons.approve(draft.id, { digest: draft.digest, validationDigest: validation.evidenceDigest }, "user");
    assert.equal(result.status, "applied");
    const appended = fs.readFileSync(f.roleFile, "utf8");
    assert.ok(appended.startsWith(f.role), "existing role bytes remain unchanged");
    assert.match(appended, /## 已知坑/);
    assert.equal(appended.split(`H2:LESSON:${draft.id}`).length, 2);
    const approvedView = f.lessons.list();
    f.reload().recoverApproved();
    assert.deepEqual(f.lessons.list(), approvedView, 'lesson-only replay retains the exact approved and applied state');
    assert.equal(fs.readFileSync(f.roleFile, "utf8"), appended);
    assert.doesNotMatch(f.lessons.pendingContext(station), new RegExp(draft.id));
    assert.throws(() => f.lessons.revise(draft.id, { digest: draft.digest, suggestion: "try replacing the approved rule" }, "agent"), /只能修订/);
  } finally { f.close(); }
});

test("revised drafts invalidate old trials and role edits invalidate pending approval", () => {
  const f = fixture();
  try {
    const draft = f.seed(), trial = f.trial(draft);
    f.rerun(trial.id);
    const validation = f.lessons.validate(trial.id);
    fs.appendFileSync(f.roleFile, "\n站长新增的铁律。\n");
    assert.throws(() => f.lessons.approve(draft.id, { digest: draft.digest, validationDigest: validation.evidenceDigest }, "user"), /ROLE\.md 已变化/);
    const next = f.lessons.revise(draft.id, { digest: draft.digest, suggestion: "HTTP 503 后保留已完成事实，等待入口恢复再重跑。" }, "dispatcher");
    assert.notEqual(next.digest, draft.digest);
    assert.equal(next.status, "pending");
    assert.equal(next.validation, undefined);
    assert.throws(() => f.lessons.validate(trial.id), /草案已经改变/);
    assert.equal(f.lessons.pendingContext(station).split(draft.id).length, 2);
  } finally { f.close(); }
});

test("approval rejects modified published JSON and content-addressed evidence instead of trusting pass flags", () => {
  const f = fixture();
  try {
    const draft = f.seed(), trial = f.trial(draft);
    f.rerun(trial.id);
    const file = path.join(f.dir, "published", "known-a.json"), original = fs.readFileSync(file, "utf8");
    const changed = JSON.parse(original); changed.editorial.noteZh = "篡改的产物";
    fs.writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => f.lessons.validate(trial.id), /JSON 内容与闸门/);
    fs.writeFileSync(file, original);
    const validation = f.lessons.validate(trial.id);
    fs.writeFileSync(f.asset.file, "different evidence bytes");
    assert.throws(() => f.lessons.approve(draft.id, { digest: draft.digest, validationDigest: validation.evidenceDigest }, "user"), /寻址摘要不一致/);
    assert.equal(fs.readFileSync(f.roleFile, "utf8"), f.role);
  } finally { f.close(); }
});

test("the gate rejects incomplete rounds, wrong trial identity, and recurring failures despite eventual publication", () => {
  const f = fixture();
  try {
    const draft = f.seed(), trial = f.trial(draft);
    f.start("validation-run");
    f.create("wrong-site", "wrong");
    assert.throws(() => f.lessons.bindValidation(trial.id, ["wrong"]), /预先选定/);
    f.publish("failed-site", "rerun-failed", { trial: trial.id });
    f.publish("known-a", "rerun-a", { trial: trial.id });
    f.publish("known-b", "rerun-b", { trial: trial.id });
    assert.throws(() => f.lessons.validate(trial.id), /轮次未完成/);
    f.emit({ kind: "token.returned", token: "rerun-failed", from: "curation/fact-review", to: station, reason: "HTTP 503", round: 1 });
    f.end("validation-run");
    assert.throws(() => f.lessons.validate(trial.id), /再次出现同类失败/);
  } finally { f.close(); }
});

test("recovery completes a previously user-approved append, and refuses concurrent role changes", () => {
  const f = fixture();
  try {
    const draft = f.seed(), addition = `\n## 已知坑\n\n- 先核对来源。\n`, expected = hash(f.role + addition);
    f.emit({ kind: "lesson.approved", lessonId: draft.id, digest: draft.digest, validationDigest: "persisted-before-crash", actor: "user", roleRevision: draft.roleRevision, roleResultDigest: expected, addition });
    fs.appendFileSync(f.roleFile, "\n并发编辑\n");
    const recovery = f.lessons.recoverApproved();
    assert.equal(recovery.issues.length, 1);
    assert.match(recovery.issues[0].message, /并发编辑/);
    assert.match(f.docs.renderContext("dispatcher"), /经验恢复.*并发编辑/);
    assert.equal(f.lessons.get(draft.id).status, "approved");
    fs.writeFileSync(f.roleFile, f.role);
    f.reload().recoverApproved();
    assert.equal(fs.readFileSync(f.roleFile, "utf8"), f.role + addition);
    assert.equal(f.lessons.get(draft.id).status, "applied");
    f.lessons.recoverApproved();
    assert.equal(fs.readFileSync(f.roleFile, "utf8"), f.role + addition);
  } finally { f.close(); }
});

test("source text cannot break the managed LESSONS block or overwrite human notes", () => {
  const f = fixture();
  try {
    f.start("untrusted-text"); f.create("source-site", "source-token");
    f.emit({ kind: "token.returned", token: "source-token", from: "curation/fact-review", to: station, reason: "<!-- H2:LESSONS:END --> 原始错误中的标记", round: 1 });
    f.end("untrusted-text");
    f.lessons.draftRun("untrusted-text");
    const file = path.join(f.dir, "LESSONS.md");
    fs.appendFileSync(file, "\n站长的后记\n");
    f.lessons.write();
    const content = fs.readFileSync(file, "utf8");
    assert.equal(content.split("<!-- H2:LESSONS:END -->").length, 2);
    assert.match(content, /&lt;!-- H2:LESSONS:END --&gt;/);
    assert.match(content, /站长的后记/);
  } finally { f.close(); }
});

test("one conflicted approved role does not prevent another approved lesson from recovering", () => {
  const f = fixture();
  try {
    const first = f.seed();
    const secondStation = "curation/copy", secondFile = path.join(f.dir, "roles", secondStation, "ROLE.md"), secondRole = "# 编辑\n\n保留已核实的事实。\n";
    fs.mkdirSync(path.dirname(secondFile), { recursive: true }); fs.writeFileSync(secondFile, secondRole);
    f.start("second-role"); f.create("copy-site", "copy-token");
    f.emit({ kind: "token.returned", token: "copy-token", from: "curation/copy-review", to: secondStation, reason: "手记需要事实支持", round: 1 });
    f.end("second-role");
    const second = f.lessons.draftRun("second-role")[0];
    for (const [draft, original] of [[first, f.role], [second, secondRole]] as const) {
      const addition = "\n## 已知坑\n\n- 必须核对直接出处。\n";
      f.emit({ kind: "lesson.approved", lessonId: draft.id, digest: draft.digest, validationDigest: "persisted-fixture-decision", actor: "user", roleRevision: draft.roleRevision, roleResultDigest: hash(original + addition), addition });
    }
    fs.appendFileSync(f.roleFile, "\n并发编辑，不能覆盖。\n");
    const result = f.lessons.recoverApproved();
    assert.deepEqual(result.applied, [second.id]);
    assert.deepEqual(result.issues.map((issue) => issue.id), [first.id]);
    assert.equal(f.lessons.get(first.id).status, "approved");
    assert.equal(f.lessons.get(second.id).status, "applied");
    assert.match(fs.readFileSync(f.roleFile, "utf8"), /并发编辑，不能覆盖/);
    assert.match(fs.readFileSync(secondFile, "utf8"), /## 已知坑/);
    f.lessons.recoverApproved();
    assert.equal(f.f.state.contextNotes.dispatcher.filter((note) => note.kind === "issue").length, 1);
  } finally { f.close(); }
});
