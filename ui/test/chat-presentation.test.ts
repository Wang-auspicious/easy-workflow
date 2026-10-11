import assert from "node:assert/strict";
import test from "node:test";
import { legacyReply, type ConversationEntry } from "../../shared/conversation.ts";
import { emptyLive, idleDispatcher } from "../src/chat/live.ts";
import { conversationView } from "../src/chat/presentation.ts";

test("timeout displays one recovery notice while preserving partial text and native error records", () => {
  const partial = legacyReply("已经完成两个工具调用", 1); partial.stopReason = "aborted";
  const error = legacyReply("", 2); error.stopReason = "error"; error.errorMessage = "The operation was aborted due to timeout";
  const entries: ConversationEntry[] = [{ id: "p", turn: "t", message: partial }, { id: "e", turn: "t", message: error }];
  const before = JSON.stringify(entries);
  const view = conversationView(entries, { ...emptyLive(), id: "t" }, { ...idleDispatcher(), turn: "t", busy: true, status: "recovering" });
  assert.equal(view.messages.filter(m => m.h2Failure).length, 1);
  assert.equal(view.messages[1].h2Failure?.label, "响应中断，主调度正在恢复");
  assert.match(view.messages[1].h2Failure!.detail, /timeout/);
  assert.deepEqual(view.messages[0].content, partial.content);
  assert.equal(JSON.stringify(entries), before);
});

test("recovered historical attempts no longer appear to be active failures", () => {
  const error = legacyReply("保留的分析", 1); error.stopReason = "error"; error.errorMessage = "timeout";
  const view = conversationView([{ id: "e", turn: "t", message: error }, { id: "r", turn: "t", message: legacyReply("已接着完成", 2) }], emptyLive(), idleDispatcher());
  assert.equal(view.messages[0].h2Failure?.label, "连接中断后已恢复");
});

test("finished transport keeps an unflushed partial reply without marking it as streaming", () => {
  const live = { ...emptyLive(), messageId: "partial", message: legacyReply("已投料 20 件", 1) };
  const view = conversationView([], live, { ...idleDispatcher(), turn: "t", status: "interrupted" });
  assert.equal(view.messages.length, 1);
  assert.equal(view.streamingMessage, undefined);
  assert.equal(conversationView([{ id: "partial", turn: "t", message: live.message }], live, idleDispatcher()).messages.length, 1);
});

test("an in-flight tool keeps its pending indicator and completed tool results remain paired", () => {
  const call = legacyReply("", 1);
  call.content = [{ type: "toolCall", id: "call-1", name: "status", arguments: {} }];
  const live = { ...emptyLive(), id: "t", messageId: "p", message: call };
  assert.deepEqual([...conversationView([], live, idleDispatcher()).pendingToolCalls], ["call-1"]);
  const result: ConversationEntry = { id: "tool-1", turn: "t", message: { role: "toolResult", toolCallId: "call-1", toolName: "status", content: [{ type: "text", text: "ready" }], isError: false, timestamp: 2 } };
  assert.deepEqual([...conversationView([result], live, idleDispatcher()).pendingToolCalls], []);
});
