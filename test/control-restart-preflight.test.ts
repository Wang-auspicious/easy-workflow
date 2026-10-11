import assert from "node:assert/strict";
import test from "node:test";
import { Factory } from "../server/factory.ts";
import { FactoryControl } from "../server/control.ts";
import { ControlError } from "../server/errors.ts";
import { Journal } from "../server/journal.ts";
import { Runtime } from "../server/runtime.ts";
import { Broker } from "../server/broker.ts";
import { compile } from "../server/spec/compile.ts";
import { pack } from "../packs/vislexicon/pack.ts";
import { apply, initialState } from "../shared/project.ts";

process.env.FACTORY_READONLY = "0";
const station = "curation/breadth";

function fixture() {
  // Real control, Factory recovery methods, Runtime and SQLite projection. Only
  // external health checks are replaced; no server, model or browser is started.
  const factory = Object.create(Factory.prototype) as Factory;
  factory.compiled = compile([pack]);
  factory.state = initialState(factory.compiled);
  factory.journal = new Journal(":memory:");
  factory.journal.subscribe(event => apply(factory.state, event));
  factory.broker = new Broker({ browser: 0, model: 0, http: 0, cpu: 0 }, 0);
  factory.runtime = new Runtime(factory.compiled, factory.journal, factory.broker, pack.conditions, () => null);
  const oldRun = factory.runtime.start("completed fixture run");
  const token = factory.runtime.create(station, {
    item: "example.test", url: "https://example.test/", source: "manual",
    data: { canonical: "https://example.test/", kind: "design-system" },
  });
  factory.runtime.end();
  factory.journal.append({ kind: "candidate.disposition", candidate: {
    item: token.item, token: token.id, url: token.url, title: token.item, source: "manual", disposition: "retry",
    failure: { tag: "network_connection", category: "network", message: "fixture failure", retryable: true },
  } });
  const control = new FactoryControl(factory);
  return { factory, control, token, oldRun, async close() { await factory.runtime.close(); factory.journal.close(); } };
}

const commands = ["correct", "choose_preview_page"] as const;
function argumentsFor(command: typeof commands[number], token: string) {
  return command === "correct"
    ? { token, station, reason: "repeat the selected capture" }
    : { item: "example.test", role: "breadth", url: "https://example.test/catalogue#palette" };
}

for (const command of commands) {
  test(`${command}: failed preflight cannot start a run, correct a token or claim a candidate`, async () => {
    const context = fixture(), { factory, control, token, oldRun } = context;
    try {
      let checks = 0;
      factory.ensureReady = async () => {
        checks++;
        factory.journal.append({ kind: "preflight.checked", ok: false, checks: [] });
        throw new ControlError(412, "preflight_failed", "fixture preflight failed");
      };
      const before = factory.journal.seq, tokens = structuredClone(factory.state.tokens);
      await assert.rejects(control.execute(command, argumentsFor(command, token.id)),
        (error: unknown) => error instanceof ControlError && error.status === 412 && error.code === "preflight_failed");
      assert.equal(checks, 1);
      assert.equal(factory.runtime.running, false);
      assert.equal(factory.state.run.id, oldRun);
      assert.equal(factory.state.run.status, "ended");
      assert.deepEqual(factory.state.tokens, tokens);
      assert.equal(factory.state.recoveries[token.item].disposition, "retry");
      assert.deepEqual([...factory.journal.read(before)].map(event => event.kind), ["preflight.checked"]);
    } finally { await context.close(); }
  });

  test(`${command}: waits for successful preflight before starting and recording recovery`, async () => {
    const context = fixture(), { factory, control, token, oldRun } = context;
    let release!: () => void;
    const checked = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const checking = new Promise<void>(resolve => { entered = resolve; });
    try {
      let checks = 0;
      factory.ensureReady = async () => {
        checks++;
        entered();
        await checked;
        factory.journal.append({ kind: "preflight.checked", ok: true, checks: [] });
        return factory.state.preflight!;
      };
      const before = factory.journal.seq;
      const execution = control.execute(command, argumentsFor(command, token.id));
      await checking;
      assert.equal(factory.journal.seq, before, "no recovery mutation is allowed while the health check is pending");
      assert.equal(factory.runtime.running, false);
      release();
      const receipt = await execution;
      assert.equal(checks, 1);
      assert.notEqual(receipt.runId, oldRun);
      const events = [...factory.journal.read(before)];
      const preflight = events.find(event => event.kind === "preflight.checked")!;
      const start = events.find(event => event.kind === "run.started")!;
      const recovery = events.find(event => command === "correct"
        ? event.kind === "correction.created"
        : event.kind === "candidate.disposition" && event.candidate.disposition === "claimed")!;
      assert.ok(preflight.seq < start.seq && start.seq < recovery.seq);
      assert.equal(recovery.run, receipt.runId);
      if (command === "correct") {
        assert.equal(factory.state.totals.corrections, 1);
        assert.equal([...factory.journal.read(0, receipt.runId)].filter(event => event.kind === "correction.created").length, 1);
        assert.equal([...factory.journal.read(0, oldRun)].filter(event => event.kind === "correction.created").length, 0,
          "correcting a completed token must not append the correction to the ended run");
      } else {
        assert.equal(factory.state.recoveries[token.item].disposition, "claimed");
        assert.equal((factory.state.tokens[receipt.result.token].data.previewChoices as { breadth?: string }).breadth, "https://example.test/catalogue#palette");
      }
    } finally { release(); await context.close(); }
  });

  test(`${command}: an existing running round does not repeat preflight or change run id`, async () => {
    const context = fixture(), { factory, control, token } = context;
    try {
      const runId = factory.runtime.start("already running");
      let checks = 0;
      factory.ensureReady = async () => { checks++; throw new Error("an active run must not be probed again"); };
      const before = factory.journal.seq;
      const receipt = await control.execute(command, argumentsFor(command, token.id));
      assert.equal(checks, 0);
      assert.equal(receipt.runId, runId);
      assert.equal([...factory.journal.read(before)].some(event => event.kind === "run.started"), false);
      assert.equal(command === "correct" ? factory.state.totals.corrections : factory.state.recoveries[token.item].disposition,
        command === "correct" ? 1 : "claimed");
    } finally { await context.close(); }
  });
}

test("invalid correction targets keep their rejection without a model health check", async () => {
  const context = fixture(), { factory, control, token } = context;
  try {
    let checks = 0;
    factory.ensureReady = async () => { checks++; throw new Error("invalid commands must not call a model"); };
    const before = factory.journal.seq;
    for (const target of [
      { token: "missing-token", station },
      { token: token.id, station: "missing/station" },
      { token: token.id, station: "curation/published" },
      { token: token.id, station: "curation/reader" },
    ]) {
      await assert.rejects(control.execute("correct", { ...target, reason: "invalid fixture target" }),
        (error: unknown) => error instanceof ControlError && error.status === 409 && error.code === "operation_failed");
    }
    assert.equal(checks, 0);
    assert.equal(factory.runtime.running, false);
    assert.equal(factory.journal.seq, before);
  } finally { await context.close(); }
});
