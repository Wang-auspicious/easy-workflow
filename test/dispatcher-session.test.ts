import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { Dispatcher, type DispatcherOptions } from "../server/dispatcher.ts";
import { dispatcherOperationKey } from "../server/dispatcher-recovery.ts";
import { Journal } from "../server/journal.ts";
import { EvidenceStore } from "../server/evidence.ts";
import { legacyReply, type ConversationEntry } from "../shared/conversation.ts";
import type { Factory } from "../server/factory.ts";
import type { FactoryControl } from "../server/control.ts";

const answer = (text = "继续完成了") => legacyReply(text, Date.now());
const failure = (text = "The operation was aborted due to timeout") => ({ ...answer(""), stopReason: "error" as const, errorMessage: text });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const tool = (id = "write-one") => ({ ...answer(""), stopReason: "toolUse" as const,
  content: [{ type: "toolCall" as const, id, name: "easy_workflow_call", arguments: { name: "feed_urls", arguments: { urls: ["https://fixture.invalid"] } } }] });

function fixture(handler: (count: number, context: TranscriptContext, signal: AbortSignal) => Promise<AssistantMessage> | AssistantMessage, options: DispatcherOptions = {}, execute?: () => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-chat-"));
  const journal = new Journal(path.join(dir, "journal.db"));
  const conversation: ConversationEntry[] = [];
  const events: any[] = []; let calls = 0; let writes = 0;
  journal.subscribe(e => {
    if (e.kind === "chat.user") conversation.push({ id: e.id, turn: e.id, message: { role: "user", content: e.text, timestamp: e.at } });
    if (e.kind === "chat.message") conversation.push({ id: e.id, turn: e.turn, message: e.message });
  });
  const f = { project: { dir }, state: { conversation, evidence: {}, tokens: {}, run: { id: "test-run" } }, journal, store: new EvidenceStore(path.join(dir, "evidence")),
    docs: { envelope: () => ({ text: "test dispatcher" }) }, emit: (e: unknown) => events.push(e) } as unknown as Factory;
  const control = { bootstrap: () => ({ instructions: "Call the fixture tool", tools: [] }), mutates: () => true, execute: async () => ({ result: { running: 0 } }),
    agentTools: () => [{ name: "easy_workflow_call", label: "Call", description: "Call", parameters: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name", "arguments"] },
      execute: async () => { writes++; await execute?.(); return { content: [{ type: "text", text: "created t-fixture" }], details: { summary: "created t-fixture", result: { task: "t-fixture" } } }; } }] } as unknown as FactoryControl;
  const opts: DispatcherOptions = { requestTimeoutMs: 1000, retryDelaysMs: [1, 1], ...options, modelFactory: () => ({
    models: {} as never, model: { id: "fixture", provider: "fixture", api: "openai-completions", baseUrl: "", name: "fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    stream: (_model, context, options) => {
      const stream = createAssistantMessageEventStream(); const count = ++calls;
      queueMicrotask(async () => {
        let message: AssistantMessage;
        try { message = await handler(count, context, options!.signal!); }
        catch (error) { message = { ...failure(String(error)), stopReason: options?.signal?.aborted ? "aborted" : "error" }; }
        stream.push({ type: "start", partial: message });
        if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
        else stream.push({ type: "done", reason: message.stopReason === "pending" ? "stop" : message.stopReason, message });
      });
      return stream;
    },
  }) };
  const newDispatcher = () => new Dispatcher(f, control, opts);
  return { journal, conversation, events, newDispatcher, factory: f, get calls() { return calls; }, get writes() { return writes; }, cleanup: () => {
    journal.close(); assert.ok(path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()), "easy-workflow-chat-"))); fs.rmSync(dir, { recursive: true, force: true });
  } };
}

test("per-provider timeout recovers through the real Pi Agent without stopping the conversation", async () => {
  const f = fixture(async (count, _context, signal) => {
    if (count === 1) await delay(200, undefined, { signal });
    return answer();
  }, { requestTimeoutMs: 20 });
  try {
    const dispatcher = f.newDispatcher(); await dispatcher.chat("continue", []);
    assert.equal(f.calls, 2); assert.equal(dispatcher.status.status, "completed");
    assert.ok(f.events.some(e => e.kind === "chat.status" && e.status === "recovering"));
    assert.ok(f.conversation.every(e => e.message.role !== "assistant" || !["error", "aborted"].includes(e.message.stopReason)));
  } finally { f.cleanup(); }
});

test("tools may outlive a provider timeout budget; long tool loops have no 120s conversation guillotine", async () => {
  const f = fixture(count => count === 1 ? tool() : answer(), { requestTimeoutMs: 20 }, () => delay(70));
  try {
    const dispatcher = f.newDispatcher(); await dispatcher.chat("long workflow", []);
    assert.equal(f.writes, 1); assert.equal(f.calls, 2); assert.equal(dispatcher.status.status, "completed");
    assert.equal(f.events.filter(e => e.kind === "chat.status" && e.status === "recovering").length, 0);
  } finally { f.cleanup(); }
});

test("user abort does not retry, remains explicitly resumable, and is not auto-started after restart", async () => {
  const arrival = deferred();
  const f = fixture(async (count, _context, signal) => { if (count === 1) { arrival.resolve(); await delay(10000, undefined, { signal }); } return answer(); });
  try {
    const dispatcher = f.newDispatcher(); const pending = dispatcher.chat("stop me", []);
    await arrival.promise; dispatcher.abort(); await pending;
    assert.equal(f.calls, 1); assert.equal(dispatcher.status.status, "aborted"); assert.equal(dispatcher.status.recoverable, true);
    const restarted = f.newDispatcher(); await restarted.recover(); assert.equal(f.calls, 1);
    await restarted.resume(); assert.equal(f.calls, 2); assert.equal(restarted.status.status, "completed");
    assert.equal(f.conversation.filter(m => m.message.role === "user").length, 1);
  } finally { f.cleanup(); }
});

test("retry exhaustion stays recoverable across restart and authentication failures do not spin", async () => {
  const f = fixture(count => count <= 3 ? failure() : answer());
  try {
    const dispatcher = f.newDispatcher(); await dispatcher.chat("keep progress", []);
    assert.equal(f.calls, 3); assert.equal(dispatcher.status.status, "failed"); assert.equal(dispatcher.status.recoverable, true);
    const restarted = f.newDispatcher(); await restarted.resume();
    assert.equal(f.calls, 4); assert.equal(restarted.status.status, "completed");
    assert.equal(f.conversation.filter(m => m.message.role === "user").length, 1);
  } finally { f.cleanup(); }
  const auth = fixture(() => failure("401 invalid API key"));
  try { const dispatcher = auth.newDispatcher(); await dispatcher.chat("auth failure", []); assert.equal(auth.calls, 1); assert.equal(dispatcher.status.status, "failed"); }
  finally { auth.cleanup(); }
});

test("service restart and a regenerated tool ID cannot repeat a successful side effect", async () => {
  const arrival = deferred();
  const f = fixture(async (count, _context, signal) => {
    if (count === 1 || count === 3) return tool(count === 1 ? "original-id" : "new-model-id");
    if (count === 2) { arrival.resolve(); await delay(10000, undefined, { signal }); }
    return answer();
  });
  try {
    const dispatcher = f.newDispatcher(); const pending = dispatcher.chat("feed once", []);
    await arrival.promise; dispatcher.interrupt(); await pending; assert.equal(dispatcher.status.status, "interrupted");
    const restarted = f.newDispatcher(); await restarted.recover();
    assert.equal(restarted.status.status, "completed"); assert.equal(f.calls, 4); assert.equal(f.writes, 1);
  } finally { f.cleanup(); }
});

test("healthy same-turn repeated writes with new call IDs remain real operations", async () => {
  const f = fixture(count => count <= 2 ? tool(`intentional-${count}`) : answer());
  try {
    const dispatcher = f.newDispatcher(); await dispatcher.chat("按两次投料执行，每次一件", []);
    assert.equal(dispatcher.status.status, "completed"); assert.equal(f.calls, 3); assert.equal(f.writes, 2);
  } finally { f.cleanup(); }
});

test("already streamed partial answers survive a timeout and restart", async () => {
  const f = fixture(count => count === 1 ? { ...failure(), content: [{ type: "text", text: "已完成的回答段落。" }] } : answer());
  try {
    const dispatcher = f.newDispatcher(); await dispatcher.chat("keep the partial answer", []);
    assert.equal(dispatcher.status.status, "completed");
    assert.ok(f.conversation.some(e => e.message.role === "assistant" && JSON.stringify(e.message.content).includes("已完成的回答段落")));
  } finally { f.cleanup(); }
});

test("restart places delivered steering after the original tool receipt, never between a tool call and its result", async () => {
  const toolEntered = deferred(); const releaseTool = deferred(); const waiting = deferred(); let restartedContext: TranscriptContext | undefined;
  const f = fixture(async (count, context, signal) => {
    if (count === 1) return tool();
    if (count === 2) { waiting.resolve(); await delay(10000, undefined, { signal }); }
    restartedContext = context; return answer();
  }, {}, async () => { toolEntered.resolve(); await releaseTool.promise; });
  try {
    const dispatcher = f.newDispatcher(); const pending = dispatcher.chat("original", []);
    await toolEntered.promise; dispatcher.steer("在工具完成后补充的要求", []); releaseTool.resolve();
    await waiting.promise; dispatcher.interrupt(); await pending;
    const restarted = f.newDispatcher(); await restarted.recover();
    const messages = restartedContext!.messages;
    const call = messages.findIndex(m => m.role === "assistant" && m.content.some(c => c.type === "toolCall"));
    assert.equal(messages[call + 1]?.role, "toolResult");
    assert.equal(messages[call + 2]?.role, "user");
    assert.ok(JSON.stringify(messages[call + 2]).includes("在工具完成后补充的要求"));
    assert.equal(messages.filter(m => m.role === "toolResult").length, 1); assert.equal(f.writes, 1);
  } finally { f.cleanup(); }
});

test("crash between effect and receipt creates an uncertain result and never replays the write", async () => {
  let synthetic = false;
  const f = fixture((count, context) => {
    if (count === 1) { synthetic = context.messages.some(m => m.role === "toolResult" && JSON.stringify(m.content).includes("可能已经生效")); return tool("new-id-after-crash"); }
    return answer();
  });
  try {
    const id = "m-crash"; const call = tool("crashed-id");
    f.journal.append({ kind: "chat.user", id, text: "feed once", attachments: [] });
    f.journal.append({ kind: "chat.message", id: `${id}-pi-1`, turn: id, message: call });
    f.journal.append({ kind: "chat.checkpoint", checkpoint: { state: { turn: id, status: "running", busy: true, attempt: 1, maxAttempts: 3, recoverable: false, message: "", updatedAt: Date.now() }, prompted: true,
      messageNumber: 1, request: { text: "feed once", attachments: [] }, scope: id, inputs: [], operations: [{ key: dispatcherOperationKey("easy_workflow_call", call.content[0]!.arguments), scope: id, callId: "crashed-id", name: "feed_urls", phase: "started" }] } });
    const restarted = f.newDispatcher(); await restarted.recover();
    assert.equal(synthetic, true); assert.equal(f.writes, 0); assert.equal(restarted.status.status, "completed");
    const result = f.conversation.find(e => e.message.role === "toolResult" && e.message.toolCallId === "new-id-after-crash")!.message;
    assert.ok(result.role === "toolResult" && result.isError);
  } finally { f.cleanup(); }
});

test("Pi steering and follow-up inputs survive a provider retry and each enter context exactly once", async () => {
  for (const mode of ["steer", "followUp"] as const) {
    const arrival = deferred(); const release = deferred(); let matches = 0;
    const f = fixture(async (count, context) => {
      if (count === 1) { arrival.resolve(); await release.promise; return failure(); }
      matches = context.messages.filter(m => m.role === "user" && JSON.stringify(m.content).includes("补充要求")).length;
      return answer();
    });
    try {
      const dispatcher = f.newDispatcher(); const pending = dispatcher.chat("original task", []);
      await arrival.promise; assert.equal(dispatcher.steer("补充要求", [], mode).ok, true); release.resolve(); await pending;
      assert.equal(matches, 1, mode); assert.equal(dispatcher.status.status, "completed");
      const replay = [...f.journal.read()].filter(e => e.kind === "chat.checkpoint").at(-1)!;
      assert.equal(replay.checkpoint.inputs[0]?.delivered, true);
    } finally { f.cleanup(); }
  }
});

test("a lost HTTP acceptance receipt may be retried with the same requestId without a new task", async () => {
  const f = fixture(() => answer());
  try {
    const dispatcher = f.newDispatcher(); await dispatcher.chat("only once", [], "client-request-id");
    const duplicate = await dispatcher.chat("only once", [], "client-request-id");
    assert.ok("duplicate" in duplicate && duplicate.duplicate); assert.equal(f.calls, 1);
    const restarted = f.newDispatcher(); assert.ok(restarted.receipt("client-request-id"));
    assert.equal(f.conversation.filter(m => m.message.role === "user").length, 1);
  } finally { f.cleanup(); }
});

test("steered evidence images reach Pi before and after restart while binary content stays out of the journal", async () => {
  const first = deferred(); const release = deferred(); const second = deferred(); const seen: boolean[] = [];
  const f = fixture(async (count, context, signal) => {
    if (count === 1) { first.resolve(); await release.promise; return answer("first answer"); }
    seen.push(context.messages.some(m => m.role === "user" && Array.isArray(m.content) && m.content.some(c => c.type === "image" && c.mimeType === "image/jpeg" && c.data.length > 20)));
    if (count === 2) { second.resolve(); await delay(10000, undefined, { signal }); }
    return answer();
  });
  try {
    const png = execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=4x6", "-frames:v", "1", "-f", "image2", "-c:v", "png", "pipe:1"], { windowsHide: true });
    const stored = f.factory.store.put(png, "png");
    f.factory.state.evidence["image-fixture"] = { id: "image-fixture", kind: "screenshot", token: "test-token", station: "curation/shots", label: "test image", card: stored.src } as never;
    const dispatcher = f.newDispatcher(); const pending = dispatcher.chat("original", []);
    await first.promise; dispatcher.steer("看这张新增截图", [{ type: "evidence", id: "image-fixture", label: "test image" }]); release.resolve();
    await second.promise; dispatcher.interrupt(); await pending;
    const restarted = f.newDispatcher(); await restarted.recover();
    assert.deepEqual(seen, [true, true]);
    assert.ok(!JSON.stringify([...f.journal.read()]).includes('"type":"image"'), "only evidence references, never base64 image messages, are persisted");
  } finally { f.cleanup(); }
});
