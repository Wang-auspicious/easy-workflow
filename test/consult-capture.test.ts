import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import vm from "node:vm";
import type { Page } from "playwright-core";
import { compile } from "../server/spec/compile.ts";
import { pack } from "../packs/vislexicon/pack.ts";
import { Runtime, type StationContext, type StationResult } from "../server/runtime.ts";
import { Journal } from "../server/journal.ts";
import { Broker } from "../server/broker.ts";
import { reader, shotReview, style } from "../packs/vislexicon/agents.ts";
import { breadthPreviewIssues, previewsInViewport } from "../packs/vislexicon/capture.ts";
import type { EvidenceStore } from "../server/evidence.ts";

const compiled = compile([pack]);
const ctx = (data: Record<string, unknown>) => ({ token: { data }, attempt: "fixture", addEvidence: () => ({}) }) as unknown as StationContext;
const hidden = { subjectVisible: false, mixed: false, styles: [], signatureZh: "" };
const pass = { perImage: [], verdict: "pass" as const, reason: "all visible" };

test('external reader permits distinct same-entry frames and supplies exact entry scope to independent image review', async () => {
  const canonical = 'https://d3js.org/d3-color';
  const understanding = Object.fromEntries(['who', 'takeaway', 'size', 'terms'].map(key =>
    [key, {url: canonical, text: key === 'takeaway' ? 'd3-color colour parsing and colour-space conversion functions' : key}]));
  const plan = {identity: {url: canonical, reason: 'Library identity', locate: '「d3-color」'},
    breadth: {url: canonical, reason: 'Own API range', locate: '「API reference」', alternatives: []},
    proof: {url: canonical, reason: 'Own conversion example', locate: '「color.rgb」', alternatives: []}};
  const external = ctx({canonical, host: 'd3js.org', title: 'd3-color', kind: 'tool', mode: 'shots',
    externalResearch: {intakeId: 'vislexicon-20261014', entryId: 'd3-color-1241bf3b'},
    understanding, readerPlan: plan, images: ['identity', 'breadth', 'proof'].map((role, index) => ({
      role, href: canonical, card: role + '.webp', sha256: role, captureState: {
        method: 'browser-native', viewport: {width: 1280, height: 800}, scroll: {x: 0, y: index * 1000}, sha256: role,
      },
    }))});
  const output = {understanding, plan, factLeads: [], blockers: [], handoff: ''};
  assert.deepEqual(await reader.check!(output as never, external), []);
  assert.ok((await reader.check!({...output, plan: {...plan, proof: {...plan.proof, locate: plan.breadth.locate}}} as never, external)).length);
  assert.ok((await reader.check!({...output, plan: {...plan, identity: {...plan.identity, url: 'https://d3js.org/'}}} as never, external)).length);
  assert.ok((await reader.check!(output as never, ctx({canonical, host: 'd3js.org'}))).length, 'ordinary paths retain their different-page contract');
  const input = await shotReview({resolve: (value: string) => value} as EvidenceStore).input(external);
  assert.ok(input.text.includes('d3-color-1241bf3b'));
  assert.ok(input.text.includes(understanding.takeaway.text));
  assert.match(input.text, /兄弟|sibling/);
  assert.match(input.text, /API|技术库/);
  assert.ok(input.text.includes('browser-native') && input.text.includes('2000'));
});

test("style sends invisible subjects back to photography through processing and review", async () => {
  const result = await style({} as EvidenceStore).after!(hidden, ctx({ kind: "component-source", shots: {} }), { rounds: 1 } as never);
  assert.equal(result.verdict?.verdict, "fix", "invisible components cannot advance into copywriting");
  assert.ok(result.verdict?.fixes?.length);
  for (const fix of result.verdict!.fixes!) {
    assert.ok(["curation/breadth", "curation/proof"].includes(fix.station));
    assert.deepEqual(fix.via, ["curation/process", "curation/shot-review"]);
  }
});

test("program vetoes fewer than four component previews even when the model passes", async () => {
  const review = shotReview({} as EvidenceStore);
  for (const previews of [0, 1, 3, undefined]) {
    const result = await review.after!(pass, ctx({ kind: "component-source", shots: { breadth: { href: "https://fixture.test/docs", previews } } }), { rounds: 1 } as never);
    assert.equal(result.verdict?.verdict, "return", `breadth previews=${previews}`);
    assert.equal(result.verdict?.returnTo, "curation/breadth");
  }
  for (const kind of ["component-source", "design-system", "knowledge"]) {
    const result = await review.after!(pass, ctx({ kind, shots: { breadth: { previews: kind === "component-source" ? 4 : 0 } } }), { rounds: 1 } as never);
    assert.equal(result.verdict?.verdict, "pass", kind);
  }
});

test("candidate health checks use HTTP quota", () => {
  assert.equal(compiled.nodes.find(n => n.key === "candidates/tidy")?.resource, "http");
});

test("preview counting deduplicates overlapping selectors and excludes offscreen or hidden media", async () => {
  const node = (x: number, y: number, w = 120, h = 90, visibility = "visible") => ({
    visibility, children: [] as any[],
    getBoundingClientRect: () => ({ left: x, right: x + w, top: y, bottom: y + h, width: w, height: h }),
    closest: () => null, contains(other: unknown) { return other === this || this.children.includes(other); },
  });
  const first = node(20, 20), second = node(200, 20), third = node(400, 20), fourth = node(600, 20);
  const nested = node(20, 20), thumbnail = node(20, 20), hidden = node(800, 20, 120, 90, "hidden");
  nested.children.push(first, thumbnail); first.children.push(thumbnail);
  const media = [thumbnail, node(0, -200), node(1400, 0), hidden];
  const stages = [nested, first, second, third, fourth];
  const page = { evaluate: async (fn: Function, selectors: string[]) => vm.runInNewContext(`(${fn.toString()})(selectors)`, {
    selectors, innerWidth: 1280, innerHeight: 800, HTMLImageElement: class {},
    getComputedStyle: (el: { visibility: string }) => ({ visibility: el.visibility, display: "block", opacity: "1" }),
    document: { querySelectorAll: (selector: string) => selector === "main img, main canvas, main video" ? media : stages },
  }) } as unknown as Page;
  assert.equal(await previewsInViewport(page), 4);
  stages.splice(2);
  assert.equal(await previewsInViewport(page), 1, "one stage matching every selector is still one preview");
  assert.ok(breadthPreviewIssues("component-source", 3).length);
  assert.deepEqual(breadthPreviewIssues("component-source", 4), []);
});

async function runConsult(recheck: (calls: number) => StationResult,
  extra?: (key: string, call: number, context: StationContext, runtime: Runtime) => Promise<StationResult | undefined>) {
  const journal = new Journal(":memory:");
  const broker = new Broker({ model: 8, browser: 8, http: 8, cpu: 4 }, 0);
  const calls: Record<string, number> = {};
  const order: string[] = [];
  const runtime = new Runtime(compiled, journal, broker, {
    shots: () => true, video: () => false, needsProof: () => true, noProof: () => false,
    complete: () => true, incomplete: () => false,
  }, n => async context => {
    calls[n.key] = (calls[n.key] ?? 0) + 1;
    order.push(n.key);
    const additional = await extra?.(n.key, calls[n.key], context, runtime);
    if (additional) return additional;
    if (n.key === "curation/style" && calls[n.key] === 1) return {
      ok: true, summary: "subject missing", verdict: { verdict: "fix", reason: "subject missing", fixes: [{ station: "curation/proof", fields: ["shots.proof"], problem: "subject missing", via: ["curation/process", "curation/shot-review"] }] },
    };
    if (n.key === "curation/shot-review" && calls[n.key] > 1) return recheck(calls[n.key]);
    return { ok: true, summary: "fixture passed" };
  });
  runtime.ensureWorkers([]);
  runtime.start("nested capture review regression");
  const token = runtime.create("curation/plan", { item: "fixture", url: "https://fixture.test", source: "manual" });
  try {
    for (let i = 0; i < 200 && !token.finished; i++) await delay(5);
    assert.ok(token.finished, "consultation must settle");
    const events = [...journal.read()];
    return { token, calls, order, events, finished: events.findLast(e => e.kind === "token.finished")! };
  } finally { await runtime.close(); journal.close(); }
}

test("a return inside the repair chain reshoots and rechecks before the original reviewer", async () => {
  const result = await runConsult(calls => calls === 2
    ? { ok: true, summary: "still blank", verdict: { verdict: "return", returnTo: "curation/proof", reason: "preview is still blank" } }
    : { ok: true, summary: "visible now", verdict: { verdict: "pass", reason: "rendered component visible" } });
  assert.equal(result.finished.kind === "token.finished" && result.finished.status, "published");
  assert.equal(result.calls["curation/shot-review"], 3, "the intermediary review cannot be swallowed");
  assert.equal(result.calls["curation/proof"], 3);
  assert.equal(result.calls["curation/process"], 3);
  assert.equal(result.calls["curation/style"], 2);
  assert.equal(result.calls["curation/facts"], 1, "the independent facts branch stays intact");
  assert.ok(result.events.filter(e => e.kind === "consult.closed").every(e => e.outcome === "resolved"));
});

test('owner repair explanations survive a checkpoint and intermediary processing', async () => {
  const reply = 'Reframed the actual component and removed the offscreen card claim.';
  let restored = false;
  let reviewerNote = '';
  const result = await runConsult(() => ({
    ok: true, summary: 'The intermediate image check passed.',
    verdict: {verdict: 'pass', reason: 'The visible component is correct.'},
  }), async (key, call, context, runtime) => {
    if (key === 'curation/proof' && call === 2) {
      return {ok: true, summary: 'Owner repair completed.', data: {reply}};
    }
    if (key === 'curation/process' && call === 2) {
      const token = runtime.tokens.get(context.token.id)!;
      token.data.runtimeCheckpoint = JSON.parse(JSON.stringify(token.data.runtimeCheckpoint));
      token.consult = undefined;
      runtime.restoreCheckpoint(token);
      restored = true;
      return {ok: true, summary: 'Images assembled.'};
    }
    if (key === 'curation/style' && call === 2) reviewerNote = context.redo?.reason ?? '';
    return undefined;
  });
  assert.ok(restored);
  assert.ok(reviewerNote.includes(reply), 'the original reviewer receives the owner explanation after reconstruction');
  const replied = result.events.find(event => event.kind === 'consult.replied');
  assert.ok(replied?.kind === 'consult.replied' && replied.reply.includes(reply));
  assert.equal(result.calls['curation/proof'], 2, 'restoration cannot rerun the completed owner');
  assert.equal(result.calls['curation/style'], 2);
});

test("an intermediary fix retains the parent consultation until both reviews pass", async () => {
  const result = await runConsult(calls => calls === 2
    ? { ok: true, summary: "fix framing", verdict: { verdict: "fix", reason: "wrong frame", fixes: [{ station: "curation/proof", fields: ["shots.proof"], problem: "crop the preview", via: ["curation/process"] }] } }
    : { ok: true, summary: "fixed", verdict: { verdict: "pass", reason: "framing correct" } },
  async (key, call) => key === 'curation/proof' && call > 1
    ? {ok: true, summary: 'Frame repaired.', data: {reply: `Specific framing repair ${call}.`}} : undefined);
  assert.equal(result.calls["curation/shot-review"], 3);
  assert.equal(result.calls["curation/style"], 2);
  const opened = result.events.filter(e => e.kind === "consult.opened");
  assert.deepEqual(opened.map(e => e.reviewer), ["curation/style", "curation/shot-review"]);
  const parentReply = result.events.find(event => event.kind === 'consult.replied' && event.consult === opened[0].consult);
  assert.ok(parentReply?.kind === 'consult.replied' && parentReply.reply.includes('Specific framing repair 3.'),
    'the parent sees the later nested correction, not only the first owner response');
  assert.equal(result.events.filter(e => e.kind === "consult.closed").length, 2);
  assert.equal(result.finished.kind === "token.finished" && result.finished.status, "published");
});

test("repeated intermediary returns stop at the specified limit and close all consultations", async () => {
  const result = await runConsult(() => ({ ok: true, summary: "still blank", verdict: { verdict: "return", returnTo: "curation/proof", reason: "preview remains blank" } }));
  assert.equal(result.finished.kind === "token.finished" && result.finished.status, "manual");
  assert.equal(result.calls["curation/style"], 1, "the parent reviewer must not see rejected repairs");
  assert.equal(result.calls["curation/shot-review"], 4, "two permitted return repairs, then manual");
  const closed = result.events.filter(e => e.kind === "consult.closed");
  assert.ok(closed.length > 0 && closed.every(e => e.outcome === "manual"));
});

test("an intermediary escalation is preserved and never advances the original reviewer", async () => {
  const result = await runConsult(() => ({ ok: true, summary: "needs owner", verdict: { verdict: "escalate", reason: "no eligible preview" } }));
  assert.equal(result.finished.kind === "token.finished" && result.finished.status, "manual");
  assert.equal(result.calls["curation/style"], 1);
});

test("repeated intermediary fixes retain every exchange and stop after three repairs", async () => {
  const result = await runConsult(() => ({ ok: true, summary: "still wrong", verdict: { verdict: "fix", reason: "wrong crop", fixes: [{ station: "curation/proof", fields: ["shots.proof"], problem: "crop the rendered component", via: ["curation/process"] }] } }));
  assert.equal(result.finished.kind === "token.finished" && result.finished.status, "manual");
  assert.equal(result.calls["curation/shot-review"], 5, "initial review, then three intermediate repairs");
  assert.equal(result.calls["curation/style"], 1);
  const opened = result.events.filter(e => e.kind === "consult.opened");
  assert.equal(opened.length, 4, "one parent and three child repair requests");
  assert.equal(result.events.filter(e => e.kind === "consult.closed" && e.outcome === "manual").length, 4);
});

test("invalid via stations cannot silently bypass a required repair review", async () => {
  const result = await runConsult(() => ({ ok: true, summary: "unknown reviewer", verdict: { verdict: "fix", reason: "check the crop", fixes: [{ station: "curation/proof", fields: ["shots.proof"], problem: "crop", via: ["curation/missing-review"] }] } }));
  assert.equal(result.finished.kind === "token.finished" && result.finished.status, "manual");
  assert.equal(result.calls["curation/style"], 1);
});

test("independent reviewers queue concurrent fixes without overwriting a capture consultation", async () => {
  const result = await runConsult(() => ({ ok: true, summary: "visible", verdict: { verdict: "pass", reason: "component visible" } }), async (key, call) => {
    if (key === "curation/proof" && call === 2) await delay(70);
    if (key === "curation/fact-review" && call === 1) {
      await delay(30);
      return { ok: true, summary: "missing source", verdict: { verdict: "fix", reason: "license lacks its source", fixes: [{ station: "curation/facts", fields: ["facts.license"], problem: "cite the license source" }] } };
    }
    return undefined;
  });
  assert.equal(result.finished.kind === "token.finished" && result.finished.status, "published");
  assert.equal(result.calls["curation/style"], 2);
  assert.equal(result.calls["curation/facts"], 2);
  assert.equal(result.calls["curation/fact-review"], 2);
  assert.equal(result.events.filter(e => e.kind === "consult.closed" && e.outcome === "resolved").length, 2);
});

test("cancelled model attempts preserve the actual usage and timing metrics", async () => {
  const journal = new Journal(":memory:");
  const metrics = { time: { firstTokenMs: 10, outputMs: 20, toolMs: 0, programMs: 0, modelCalls: 1, toolCalls: 0 } };
  const usage = { input: 123, output: 45, cost: 0.01 };
  const runtime = new Runtime(compiled, journal, new Broker({ model: 8 }, 0), {}, () => async () => {
    await delay(30);
    return { ok: true, summary: "completed after cancellation", usage, metrics };
  });
  runtime.ensureWorkers([]);
  runtime.start("cancelled usage");
  runtime.create("curation/style", { item: "cancel", url: "https://fixture.test", source: "manual" });
  try {
    await delay(10);
    runtime.end();
    await runtime.settle();
    const event = [...journal.read()].find(e => e.kind === "attempt.finished");
    assert.ok(event?.kind === "attempt.finished" && event.cancelled);
    assert.deepEqual(event.usage, usage);
    assert.deepEqual(event.metrics, metrics);
  } finally { await runtime.close(); journal.close(); }
});
