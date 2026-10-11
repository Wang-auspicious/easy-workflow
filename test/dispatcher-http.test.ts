import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fork, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

test("real HTTP chat acceptance, steering, idempotency, SSE reconnect and failed-turn continuation", { timeout: 45000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-chat-http-"));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const token = "chat-http-fixture-secret";
  let release!: () => void; const released = new Promise<void>(r => { release = r; });
  let modelCalls = 0, unavailable = false;
  const provider = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the request */ }
    modelCalls++;
    if (modelCalls === 1) await released;
    if (unavailable) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "invalid API key" } })); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const part of [{ choices: [{ index: 0, delta: { role: "assistant", content: "已核对并继续处理。" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }])
      res.write(`data: ${JSON.stringify({ id: "http-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", ...part })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(r => provider.listen(0, "127.0.0.1", r));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture-model" }));
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "provider-fixture-key" } }));
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, models: [{ id: "fixture-model", input: ["text"] }] } } }));
  let child: ChildProcess | undefined;
  try {
    child = fork(path.join(root, "server/main.ts"), [], { cwd: root, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"], env: {
      ...process.env, FACTORY_ROOT: root, FACTORY_VAR: path.join(dir, "workspace"), FACTORY_PORT: "0", FACTORY_TOKEN: token,
      FACTORY_DISCOVERY: "0", FACTORY_PREFLIGHT: "0", FACTORY_HTTP_CACHE: "0", FACTORY_START_PAUSED: "1", FACTORY_READONLY: "0",
      FACTORY_LAYOUT: path.join(dir, "layout.json"), VISLEXICON_ROOT: path.join(dir, "unconnected"), PI_CODING_AGENT_DIR: dir,
      FACTORY_MODEL: undefined, FACTORY_PROVIDER: undefined,
    } });
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture server startup timeout")), 20000);
      child!.once("error", reject); child!.once("exit", code => reject(new Error(`fixture server exit ${code}`)));
      child!.on("message", (message: { type?: string; url?: string }) => { if (message.type === "ready" && message.url) { clearTimeout(timer); resolve(message.url); } });
    });
    const request = async (route: string, body?: unknown) => {
      const res = await fetch(url + route, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      return { status: res.status, data: await res.json() as any };
    };
    const waitState = async (status: string) => {
      for (let i = 0; i < 100; i++) { const state = (await request("/api/state")).data; if (state.dispatcher.status === status) return state; await delay(50); }
      throw new Error(`dispatcher did not reach ${status}`);
    };
    const initial = await request("/api/chat", { text: "核对运行", attachments: [], requestId: "first-request" });
    assert.equal(initial.status, 202); assert.equal(initial.data.turn, "m-first-request");
    assert.equal((await request("/api/state")).data.dispatcher.busy, true);
    const duplicate = await request("/api/chat", { text: "核对运行", attachments: [], requestId: "first-request" });
    assert.equal(duplicate.data.duplicate, true);
    const steer = await request("/api/chat", { text: "完成后补充失败原因", attachments: [], requestId: "followup-request", mode: "followUp" });
    assert.equal(steer.status, 202); assert.equal(steer.data.queued, true); assert.equal(steer.data.mode, "followUp");
    release();
    const completed = await waitState("completed"); assert.equal(completed.dispatcher.busy, false); assert.equal(modelCalls, 2);
    const stream = await fetch(url + "/api/events?since=" + completed.seq, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    const reader = stream.body!.getReader(); let live = "";
    try { while (!live.includes('"kind":"chat.status"')) { const part = await reader.read(); assert.equal(part.done, false); live += new TextDecoder().decode(part.value); } }
    finally { await reader.cancel(); }
    assert.ok(live.includes('"busy":false')); assert.ok(live.includes('"status":"completed"'));
    assert.equal((await request("/api/chat/continue", {})).status, 409);
    unavailable = true;
    assert.equal((await request("/api/chat", { text: "暂时出错的消息", attachments: [], requestId: "failed-request" })).status, 202);
    const failed = await waitState("failed"); assert.equal(failed.dispatcher.recoverable, true);
    unavailable = false;
    assert.equal((await request("/api/chat/continue", {})).status, 202);
    const resumed = await waitState("completed");
    assert.equal(resumed.dispatcher.turn, "m-failed-request");
    assert.equal(resumed.conversation.filter((m: any) => m.message.role === "user").length, 3, "continuing and duplicate POST must not add user requests");
  } finally {
    release();
    if (child && child.exitCode === null) await new Promise<void>(resolve => {
      const timer = setTimeout(() => child!.kill(), 5000); child!.once("exit", () => { clearTimeout(timer); resolve(); });
      if (child!.connected) child!.send({ type: "shutdown" }); else child!.kill();
    });
    provider.closeAllConnections(); await new Promise<void>(r => provider.close(() => r()));
    assert.ok(path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()), "easy-workflow-chat-http-"))); fs.rmSync(dir, { recursive: true, force: true });
  }
});
