import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Type } from "typebox";
import { piStatus, models, closeModelTransport } from "../server/pi.ts";
import { runAgentStation } from "../server/agent-station.ts";
import type { StationContext } from "../server/runtime.ts";

test("Pi profile, structured station submission, repair and cancellation", { timeout: 15000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h2-pi-test-"));
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, model: process.env.FACTORY_MODEL, provider: process.env.FACTORY_PROVIDER };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.FACTORY_MODEL; delete process.env.FACTORY_PROVIDER;
  let requestCount = 0, hold = false, arrivals: (() => void) | undefined;
  const bodies: any[] = [];
  const sessionHeaders: (string | string[] | undefined)[] = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer local-fixture-secret");
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    sessionHeaders.push(req.headers["x-opencode-session"]);
    requestCount++;
    if (hold) { arrivals?.(); return; }
    const value = requestCount === 1 ? -1 : 7;
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const part of [
      { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${requestCount}`, type: "function", function: { name: "submit", arguments: JSON.stringify({ value }) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
    ]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", ...part })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture-model" }));
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "local-fixture-secret" } }));
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: "fixture-model", input: ["text"] }] } } }));
  const authBefore = fs.readFileSync(path.join(dir, "auth.json"), "utf8");
  const ctx = (signal: AbortSignal) => ({ node: { key: "curation/classify" }, token: { id: "t-test" }, worker: { id: "w-test" }, attempt: "a-test", signal, progress: () => {} }) as unknown as StationContext;
  const definition = {
    system: "Return a structured value.", schema: Type.Object({ value: Type.Number() }), input: () => ({ text: "Return 7." }),
    check: (value: { value: number }) => value.value < 0 ? ["value must be positive"] : [],
    after: (value: { value: number }) => ({ ok: true, summary: "submitted", data: value }),
  };
  try {
    await t.test("uses Pi defaults and credentials without exposing or rewriting secrets", async () => {
      const info = piStatus();
      assert.equal(info.source, "pi"); assert.equal(info.id, "fixture-model"); assert.equal(info.ready, true);
      assert.ok(!JSON.stringify(info).includes("local-fixture-secret"));
      assert.equal(models().model.provider, "fixture");
    });
    await t.test("a real Pi Agent submits through the schema and repairs failed checks", async () => {
      const result = await runAgentStation(definition, ctx(new AbortController().signal));
      assert.equal(result.ok, true); assert.deepEqual(result.data, { value: 7 });
      assert.equal(requestCount, 2);
      assert.ok(JSON.stringify(bodies[0]).includes("H2 station contract v2"));
      assert.ok(JSON.stringify(bodies[0]).includes("职责与场景"),"each model receives its own ROLE.md");
      assert.equal(bodies[0].tools.length, 1, "station agents get only their own submit tool");
      assert.ok(JSON.stringify(bodies[1]).includes("value must be positive"));
      assert.equal(fs.readFileSync(path.join(dir, "auth.json"), "utf8"), authBefore);
    });
    await t.test("cancels an in-flight provider request before committing station output", async () => {
      hold = true;
      const arrived = new Promise<void>((resolve) => { arrivals = resolve; });
      const ctrl = new AbortController();
      const pending = runAgentStation(definition, ctx(ctrl.signal));
      const rejected = assert.rejects(pending, { name: "AbortError" });
      await arrived; ctrl.abort(); await rejected;
      assert.equal(requestCount, 3, "cancelled calls do not start a repair");
    });
    await t.test("Pi custom OpenCode models retain the required provider session header", async () => {
      hold = false;
      fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultProvider: "opencode-go", defaultModel: "fixture-model" }));
      const profile = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8"));
      profile.providers["opencode-go"] = profile.providers.fixture;
      fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify(profile));
      fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "opencode-go": { type: "api_key", key: "local-fixture-secret" } }));
      const previousKey = process.env.OPENCODE_API_KEY;
      delete process.env.OPENCODE_API_KEY;
      try {
        const result = await runAgentStation(definition, ctx(new AbortController().signal));
        assert.equal(result.ok, true);
        assert.equal(sessionHeaders.at(-1), "w-test-a-test");
      } finally { if (previousKey !== undefined) process.env.OPENCODE_API_KEY = previousKey; }
    });
  } finally {
    await closeModelTransport();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.dir], ["FACTORY_MODEL", saved.model], ["FACTORY_PROVIDER", saved.provider]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
