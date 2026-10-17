import assert from "node:assert/strict";
import test from "node:test";
import { legacyReply } from "../../shared/conversation.ts";
import { emptyLive, idleDispatcher, reconcileChatLive, reduceChatLive } from "../src/chat/live.ts";

test('a fresh session clears the previous live fragment even on another connected window', () => {
  const old = {id: 'old', text: '', tools: [], messageId: 'old-reply', message: legacyReply('old answer', 1)};
  assert.deepEqual(reconcileChatLive(old, idleDispatcher()), emptyLive());
});

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
  const active = reduceChatLive(reduceChatLive(emptyLive(), { kind: 'chat.start', id: 'turn-1' }), { kind: 'chat.tool', name: 'status', status: 'start' });
  const ended = reconcileChatLive(active, { ...idleDispatcher(), turn: "turn-1", status: "interrupted", recoverable: true });
  assert.equal(ended.id, null);
  assert.deepEqual(ended.tools, []);
});

test("a replayed chat.start for the same turn cannot erase already received output", () => {
  const active = { id: "turn-1", text: "已投料", tools: [], messageId: "reply-1", message: legacyReply("已投料", 1) };
  assert.deepEqual(reduceChatLive(active, { kind: "chat.start", id: "turn-1" }), active);
});

test('busy snapshots discard missed tool endings without dropping partial replies or normal live tool order', () => {
  const partial = legacyReply('A durable reply is on its way', 1);
  const active = { id: 'turn-1', text: 'old deltas', tools: [{ name: 'old-call', status: 'start' }], messageId: 'reply-1', message: partial };
  const reset = reduceChatLive(active, { kind: 'chat.reset', turn: 'turn-1' });
  assert.deepEqual(reset.tools, []); assert.equal(reset.text, ''); assert.equal(reset.message, partial);
  assert.deepEqual(reduceChatLive(active, { kind: 'chat.reset', turn: 'older-turn' }), active);
  const started = reduceChatLive(reset, { kind: 'chat.tool', name: 'next-call', status: 'start' });
  const synced = reconcileChatLive(started, { ...idleDispatcher(), turn: 'turn-1', status: 'running', busy: true });
  assert.deepEqual(synced.tools, started.tools, 'ordinary busy status updates must not erase active tools');
  assert.deepEqual(reduceChatLive(synced, { kind: 'chat.tool', name: 'next-call', status: 'end', summary: 'done' }).tools, [{ name: 'next-call', status: 'end', summary: 'done' }]);
});

test('a new busy turn cannot inherit a completed turn partial after reconnect', () => {
  const previous = { ...emptyLive(), messageId: 'old-reply', message: legacyReply('Old response', 1) };
  const next = reconcileChatLive(previous, { ...idleDispatcher(), turn: 'new-turn', busy: true, status: 'running' });
  assert.deepEqual(next, { ...emptyLive(), id: 'new-turn' });
});
