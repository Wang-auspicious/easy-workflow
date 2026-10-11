import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { configureAgentStations, runAgentStation, combineAgentAttempts } from "../server/agent-station.ts";
import { Toolbox } from "../server/toolbox.ts";
import { Broker } from "../server/broker.ts";
import type { Docs } from "../server/docs.ts";
import type { Journal } from "../server/journal.ts";
import type { StationContext } from "../server/runtime.ts";
import { closeNetwork } from "../server/network.ts";

test("closed launcher receives envelope first, calls scoped MCP, repairs and reports real usage", { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h2-closed-agent-test-"));
  const previous = Object.fromEntries(["FACTORY_STATION_COMMAND", "FACTORY_STATION_MODEL", "FACTORY_TOKEN", "FACTORY_AGENT_CONNECTION"].map(k => [k, process.env[k]]));
  process.env.FACTORY_STATION_COMMAND = JSON.stringify([process.execPath, fileURLToPath(new URL("./fixtures/closed-agent-launcher.mjs", import.meta.url))]);
  process.env.FACTORY_STATION_MODEL = "fixture-requested-model";
  process.env.FACTORY_TOKEN = "not-for-station";
  process.env.FACTORY_AGENT_CONNECTION = "not-for-station.json";
  const docs = { dir, envelope: () => ({ text: "fixture envelope", sizes: { role: 16, project: 0, context: 0, caseFile: 0 } }) } as unknown as Docs;
  const toolbox = new Toolbox({ journal: { append: () => { throw new Error("unexpected journal write"); } } as unknown as Journal, broker: new Broker({ browser: 1, http: 1, model: 1, cpu: 1 }), docs: () => docs });
  configureAgentStations({ docs: () => docs, toolbox: () => toolbox });
  const progress: string[] = [];
  const ctx = { token: { id: "fixture-task", item: "fixture.test" }, node: { key: "curation/reader" }, attempt: "fixture-attempt", worker: { id: "fixture-worker" }, signal: new AbortController().signal, progress: (text: string) => progress.push(text) } as unknown as StationContext;
  try {
    const result = await runAgentStation({ system: "fixture station contract", schema: Type.Object({ score: Type.Integer() }, { additionalProperties: false }),
      input: () => ({ text: "fixture input" }), check: (out: { score: number }) => out.score === 1 ? [] : ["score must be 1"],
      after: (out, _ctx, meta) => ({ ok: true, summary: `score ${out.score}`, data: { rounds: meta.rounds } }) }, ctx);
    assert.equal(result.ok, true, result.error ?? "closed agent must complete");
    assert.equal(result.data?.rounds, 2);
    assert.deepEqual(result.usage, { input: 200, output: 40, cost: .002, cacheRead: 60, cacheWrite: 10 });
    assert.deepEqual(result.metrics?.execution, { adapter: "closed-command", model: "fixture-actual-model" });
    assert.equal(result.metrics?.usageReported, true);
    assert.equal(result.metrics?.usageComplete, true);
    assert.equal(result.metrics?.cacheUsageComplete, true);
    assert.equal(result.metrics?.modelTimeReported, true);
    assert.equal(result.metrics?.time?.modelCalls, 2);
    assert.equal(result.metrics?.time?.firstTokenMs, 16);
    assert.equal(result.metrics?.time?.outputMs, 24);
    assert.equal(result.metrics?.time?.toolCalls, 2);
    assert.ok(progress.some(p => p.includes("程序检查全部通过")));
    assert.ok(!progress.join("\n").includes("not-for-station"));
    assert.ok(fs.existsSync(path.join(dir, "work", "fixture-task")));
    const simple = { system: "fixture station contract", schema: Type.Object({ score: Type.Integer() }, { additionalProperties: false }), input: () => ({ text: "fixture input" }), after: () => ({ ok: true, summary: "done" }) };
    process.env.FACTORY_STATION_MODEL = "fixture-no-cache";
    const noCache = await runAgentStation(simple, ctx);
    assert.equal(noCache.ok, true); assert.equal(noCache.usage?.cacheRead, undefined); assert.equal(noCache.usage?.cacheWrite, undefined);
    assert.equal(noCache.metrics?.usageComplete, true); assert.equal(noCache.metrics?.cacheUsageComplete, false);
    process.env.FACTORY_STATION_MODEL = "fixture-no-usage";
    const noUsage = await runAgentStation(simple, ctx);
    assert.equal(noUsage.ok, true); assert.equal(noUsage.usage, undefined);
    assert.equal(noUsage.metrics?.usageReported, false); assert.equal(noUsage.metrics?.usageComplete, false);
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await closeNetwork();
    assert.ok(path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()), "h2-closed-agent-test-")));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("automatic retry retains the failed call's observed usage and phase metrics", () => {
  const first = { ok: false, summary: "connection error", usage: { input: 10, output: 2, cost: .01, cacheRead: 3, cacheWrite: 0 }, metrics: { usageReported: true, modelTimeReported: true, time: { firstTokenMs: 5, outputMs: 7, toolMs: 0, programMs: 0, modelCalls: 1, toolCalls: 0 } } };
  const second = { ok: true, summary: "done", usage: { input: 20, output: 4, cost: .02, cacheRead: 0, cacheWrite: 1 }, metrics: { usageReported: true, modelTimeReported: true, time: { firstTokenMs: 6, outputMs: 9, toolMs: 2, programMs: 0, modelCalls: 1, toolCalls: 1 } } };
  const result = combineAgentAttempts(first, second);
  assert.deepEqual(result.usage, { input: 30, output: 6, cost: .03, cacheRead: 3, cacheWrite: 1 });
  assert.deepEqual(result.metrics?.time, { firstTokenMs: 11, outputMs: 16, toolMs: 2, programMs: 0, modelCalls: 2, toolCalls: 1 });
});
