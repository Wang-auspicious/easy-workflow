import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { configureAgentStations, runAgentStation, type AgentStationDef } from '../server/agent-station.ts';
import { Toolbox } from '../server/toolbox.ts';
import { Broker } from '../server/broker.ts';
import type { Docs } from '../server/docs.ts';
import type { Journal } from '../server/journal.ts';
import type { StationContext } from '../server/runtime.ts';
import { closeNetwork } from '../server/network.ts';

test('station input and salvage retain the same quality contract as a normal submission', { timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-station-safety-'));
  const prior = Object.fromEntries(['FACTORY_STATION_COMMAND', 'FACTORY_STATION_MODEL'].map(key => [key, process.env[key]]));
  process.env.FACTORY_STATION_COMMAND = JSON.stringify([process.execPath, fileURLToPath(new URL('./fixtures/closed-agent-launcher.mjs', import.meta.url))]);
  process.env.FACTORY_STATION_MODEL = 'fixture-requested-model';
  const docs = { dir, envelope: () => ({ text: 'fixture envelope', sizes: { role: 0, project: 0, context: 0, caseFile: 0 } }) } as unknown as Docs;
  const toolbox = new Toolbox({ journal: { append: () => { throw new Error('unexpected write'); } } as unknown as Journal, broker: new Broker({ browser: 1, cpu: 1, http: 1, model: 1 }), docs: () => docs });
  configureAgentStations({ docs: () => docs, toolbox: () => toolbox });
  const ctx = { token: { id: 'fixture-task', item: 'fixture.test', data: {} }, node: { key: 'curation/reader' }, attempt: 'fixture-attempt', worker: { id: 'fixture-worker' }, signal: new AbortController().signal, progress: () => {} } as unknown as StationContext;
  let accepted = 0;
  const definition: AgentStationDef<{ score: number }> = {
    system: 'fixture station contract', schema: Type.Object({ score: Type.Integer() }, { additionalProperties: false }),
    input: () => ({ text: 'fixture input' }), check: out => out.score === 2 ? [] : ['score must be 2'],
    after: out => { accepted++; return { ok: true, summary: 'accepted', data: out }; },
  };
  try {
    await t.test('salvage cannot bypass an unresolved program check', async () => {
      const result = await runAgentStation({ ...definition, salvage: out => out }, ctx);
      assert.equal(result.ok, false, 'returning the same invalid classification is not a valid salvage');
      assert.match(result.error!, /score must be 2/); assert.equal(accepted, 0);
    });
    await t.test('salvage cannot produce data outside the declared output schema', async () => {
      const result = await runAgentStation({ ...definition, check: () => ['needs repair'], salvage: () => ({ score: 'two' } as unknown as { score: number }) }, ctx);
      assert.equal(result.ok, false); assert.equal(accepted, 0);
      assert.match(result.error!, /schema|score|Integer|number/i);
    });
    await t.test('a repair that satisfies the full contract is still accepted', async () => {
      const result = await runAgentStation({ ...definition, salvage: () => ({ score: 2 }) }, ctx);
      assert.equal(result.ok, true, result.error ?? 'a valid salvage must pass'); assert.equal(result.data?.score, 2); assert.equal(accepted, 1);
    });
    await t.test('a missing image stops before any model call instead of silently removing visual evidence', async () => {
      const result = await runAgentStation({ ...definition, check: undefined, input: () => ({ text: 'fixture input', images: [{ file: path.join(dir, 'removed-proof.webp'), label: 'proof' }] }) }, ctx);
      assert.equal(result.ok, false); assert.equal(result.failure?.tag, 'missing_artifact');
      assert.match(result.failure?.nextAction ?? '', /证据|恢复/);
      assert.equal(result.metrics?.time?.modelCalls ?? 0, 0); assert.equal(accepted, 1);
    });
    await t.test('a station can finish a bounded second local correction without restarting its work', async () => {
      process.env.FACTORY_STATION_MODEL = 'fixture-two-repairs';
      const before = accepted;
      const result = await runAgentStation({ ...definition, repairAttempts: 2 }, ctx);
      assert.equal(result.ok, true, 'the second local correction must get the opportunity to satisfy the same contract');
      assert.equal(result.data?.score, 2); assert.equal(accepted, before + 1);
      assert.equal(result.metrics?.time?.modelCalls, 3);
    });
    await t.test('additional local corrections stay bounded and never accept an invalid result', async () => {
      const before = accepted;
      const result = await runAgentStation({ ...definition, check: () => ['cannot pass'], repairAttempts: 2 }, ctx);
      assert.equal(result.ok, false); assert.equal(accepted, before);
      assert.equal(result.metrics?.time?.modelCalls, 3);
      assert.equal(result.agentContract?.ending, 'forced_handoff');
      assert.equal(result.agentContract?.repairs, 2);
      assert.equal(result.agentContract?.rounds, 3);
      assert.equal(result.failure, undefined);
      assert.ok(result.sessionCheckpoint?.pi, 'the failed corrections remain available to a later continuation');
    });
    await t.test('a closed agent can hand off through real scoped MCP without accepting partial work', async () => {
      process.env.FACTORY_STATION_MODEL = 'fixture-handoff';
      const before = accepted;
      const result = await runAgentStation(definition, ctx);
      assert.equal(result.ok, false);
      assert.equal(accepted, before, 'handoff must never invoke the successful submission callback');
      assert.equal(result.failure, undefined);
      assert.equal(result.agentContract?.ending, 'handoff');
      assert.equal(result.agentContract?.actualTokens, 155, 'input, output and both cache counters all consume budget');
      assert.deepEqual(result.handoff, {done: ['read fixture'], evidence: ['fixture-only observation'],
        remaining: ['verify score'], suggestion: 'Continue score verification.'});
      assert.ok(result.sessionCheckpoint?.pi);
      assert.ok(fs.existsSync(path.join(dir, result.sessionCheckpoint.pi.file)));
    });
  } finally {
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await closeNetwork();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('easy-workflow-station-safety-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
