import assert from "node:assert/strict";
import test from "node:test";
import { legacyReply } from "../../shared/conversation.ts";
import { emptyLive, idleDispatcher, reconcileChatLive, reduceChatLive } from "../src/chat/live.ts";

test("message_end keeps the partial answer visible until the queued journal update is rendered", () => {
  const started = reduceChatLive(emptyLive(), { kind: "chat.start", id: "turn-1" });
  const streaming = reduceChatLive(started, { kind: "chat.pi", turn: "turn-1", id: "reply-1", message: legacyReply("已检查前 20 个网站", 1) });
  const pendingJournal = reduceChatLive(streaming, { kind: "chat.pi", turn: "turn-1", id: "reply-1", message: null });
  assert.deepEqual(pendingJournal.message, streaming.message, "the journal applies on the next animation frame; clearing now loses the answer");
  assert.deepEqual(reduceChatLive(pendingJournal, { kind: "chat.end", id: "turn-1" }).message, streaming.message);
});

test("a delayed end for an older turn cannot stop the current answer", () => {
  const active = reduceChatLive(emptyLive(), { kind: "chat.start", id: "turn-2" });
  assert.equal(reduceChatLive(active, { kind: "chat.end", id: "turn-1" }).id, "turn-2");
});

test("reconnecting after missing chat.end releases the composer without resending a user action", () => {
  const active = reduceChatLive(emptyLive(), { kind: "chat.start", id: "turn-1" });
  const ended = reconcileChatLive(active, { ...idleDispatcher(), turn: "turn-1", status: "interrupted", recoverable: true });
  assert.equal(ended.id, null);
});

test("a replayed chat.start for the same turn cannot erase already received output", () => {
  const active = { id: "turn-1", text: "已投料", tools: [], messageId: "reply-1", message: legacyReply("已投料", 1) };
  assert.deepEqual(reduceChatLive(active, { kind: "chat.start", id: "turn-1" }), active);
});
