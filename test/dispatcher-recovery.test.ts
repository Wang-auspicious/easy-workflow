import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Dispatcher } from "../server/dispatcher.ts";
import { Journal } from "../server/journal.ts";
import { closeModelTransport } from "../server/pi.ts";
import type { Factory } from "../server/factory.ts";
import type { FactoryControl } from "../server/control.ts";
import type { ConversationEntry } from "../shared/conversation.ts";

test("dispatcher recovers an actual Pi provider timeout after a completed write without repeating the write", { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-dispatcher-"));
  const previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "FACTORY_MODEL", "FACTORY_PROVIDER"].map(k => [k, process.env[k]]));
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.FACTORY_MODEL; delete process.env.FACTORY_PROVIDER;
  const bodies: any[] = [];
  let writes = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (bodies.length === 2) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "The operation was aborted due to timeout (local-fixture-secret)" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = bodies.length === 1
      ? { role: "assistant", tool_calls: [{ index: 0, id: "call-feed", type: "function", function: { name: "easy_workflow_call", arguments: JSON.stringify({ name: "feed_urls", arguments: { urls: ["https://fixture.invalid"] } }) } }] }
      : { role: "assistant", content: "已投料 1 件，并从原来的工具回执恢复了回答。" };
    for (const part of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: bodies.length === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
    ]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", ...part })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture-model" }));
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "local-fixture-secret" } }));
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, models: [{ id: "fixture-model", input: ["text"] }] } } }));
  const journal = new Journal(path.join(dir, "journal.db"));
  const conversation: ConversationEntry[] = [];
  const events: any[] = [];
  journal.subscribe(e => {
    if (e.kind === "chat.user") conversation.push({ id: e.id, turn: e.id, message: { role: "user", content: e.text, timestamp: e.at } });
    if (e.kind === "chat.message") conversation.push({ id: e.id, turn: e.turn, message: e.message });
  });
  const f = { project: { dir }, state: { conversation, evidence: {}, tokens: {}, run: { id: "test-run" } }, journal, docs: { envelope: () => ({ text: "dispatcher fixture" }) }, emit: (e: unknown) => events.push(e) } as unknown as Factory;
  const control = {
    bootstrap: () => ({ instructions: "Use the discovered tool." }),
    mutates: () => true,
    execute: async () => ({ result: { running: 0 } }),
    agentTools: () => [{ name: "easy_workflow_call", label: "Call", description: "Call", parameters: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name", "arguments"] }, execute: async () => { writes++; return { content: [{ type: "text", text: "已投料 1 件" }], details: { summary: "已投料 1 件", result: { task: "t-already-created", seq: journal.seq } } }; } }],
  } as unknown as FactoryControl;
  try {
    const dispatcher = new Dispatcher(f, control);
    await dispatcher.chat("投一个网站，并告诉我结果", []);
    const answer = [...journal.read()].filter(e => e.kind === "chat.assistant").at(-1);
    assert.ok(answer?.text.includes("从原来的工具回执恢复"), `expected recovery, got ${answer?.text}`);
    assert.equal(writes, 1, "a model retry must not repeat a completed write");
    assert.equal(bodies.length, 3);
    assert.ok(bodies[2].messages.some((m: any) => m.role === "tool" && m.tool_call_id === "call-feed"), "resume includes the original write receipt");
    assert.ok(events.some(e => e.kind === "chat.status" && e.status === "recovering"));
    assert.ok(!JSON.stringify(events).includes("local-fixture-secret"), "provider-echoed credentials must not enter live messages or recovery state");
    assert.equal(dispatcher.busy, false);
  } finally {
    await closeModelTransport(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); journal.close();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    assert.ok(path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()), "easy-workflow-dispatcher-")));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
