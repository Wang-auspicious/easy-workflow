// 对话数据层的单测：状态判定、条目拼装、工具配对、工位记录。
// 跑法：node --test ui/test/transcript.test.ts（或 npm run test:ui）
import assert from "node:assert/strict";
import test from "node:test";
import { legacyReply, type ConversationEntry } from "../../shared/conversation.ts";
import { emptyLive, idleDispatcher, type LiveChat, type DispatcherStatus } from "../src/chat/live.ts";
import { buildTranscript, correctionReceipt, dispatcherState, toolLabel } from "../src/chat/transcript.ts";
import type { CompiledFactory, CompiledNode } from "../../shared/types.ts";
import { botFor } from "../../shared/palette.ts";

const dispatcher = (patch: Partial<DispatcherStatus> = {}): DispatcherStatus => ({ ...idleDispatcher(), ...patch });
const live = (patch: Partial<LiveChat> = {}): LiveChat => ({ ...emptyLive(), ...patch });
const assistant = (text: string) => legacyReply(text, 1000);

test('撤销只绑定真实纠错回执，不把任意输出中的 correction 当成按钮', () => {
  assert.equal(correctionReceipt('correct', {}, JSON.stringify({ ok: true, correction: 'c-direct' })), 'c-direct');
  assert.equal(correctionReceipt('easy_workflow_call', { name: 'correct' }, JSON.stringify({ ok: true, result: { ok: true, correction: 'c-wrapped' } })), 'c-wrapped');
  for (const output of ['plain text', JSON.stringify({ ok: false, correction: 'c-bad' }), JSON.stringify({ ok: true, result: { ok: false, correction: 'c-failed' } })]) assert.equal(correctionReceipt('correct', {}, output), undefined);
  assert.equal(correctionReceipt('inspect', {}, JSON.stringify({ correction: 'c-unrelated' })), undefined);
});

test("状态判定：没消息时空闲，收到任务先思考，吐字时说话，跑工具时执行", () => {
  assert.equal(dispatcherState(live(), dispatcher()), "idle");
  assert.equal(dispatcherState(live({ id: "turn-1" }), dispatcher({ busy: true, status: "running" })), "thinking");
  assert.equal(dispatcherState(live({ id: "turn-1", text: "正在" }), dispatcher({ busy: true })), "thinking");
  assert.equal(dispatcherState(live({ id: "turn-1", message: assistant("你好") }), dispatcher({ busy: true })), "speaking");
  assert.equal(dispatcherState(live({ id: "turn-1", tools: [{ name: "status", status: "start" }], message: assistant("查") }), dispatcher({ busy: true })), "work");
});

test("状态判定：恢复中是等待，中断后是失败，不把失败说成还在说", () => {
  assert.equal(dispatcherState(live(), dispatcher({ status: "recovering", busy: true })), "wait");
  assert.equal(dispatcherState(live(), dispatcher({ status: "interrupted" })), "wait");
  const aborted = assistant("");
  aborted.stopReason = "aborted";
  assert.equal(dispatcherState(live(), dispatcher({ status: "aborted" }), aborted), "fail");
});

test("工具标签与服务端渲染器用同一份中文名", () => {
  assert.equal(toolLabel("easy_workflow_call", { name: "status" }), "查看运行状态");
  assert.equal(toolLabel("easy_workflow_call", { name: "unknown" }), "调用 Easy Workflow · unknown");
  assert.equal(toolLabel("easy_workflow_help", { name: "run_control" }), "了解能力 · 控制运行");
  assert.equal(toolLabel("read_report"), "读取报告");
  assert.equal(toolLabel("unknown_tool"), "unknown_tool");
});

const node = (key: string, name: string, role: CompiledNode["role"]): CompiledNode => ({
  key, id: key, line: "curation", layer: 3, name, role, kind: "agent", input: "*", output: "*", rules: [], accept: [],
  resource: "none", estimateSeconds: 0, workers: { min: 0, max: 1, initial: 0, policy: "fixed" }, bot: botFor(key, role),
});
const factory: CompiledFactory = {
  nodes: [node("curation/sort", "分拣", "sort")], lines: [], edges: [], packs: [], channels: [],
  resources: { browser: 0, model: 0, cpu: 0, http: 0 }, issues: [], digest: "d", specVersion: "s",
  ui: { order: [], hints: {}, collapsed: [] },
};

test("一轮回答：思考、正文、工具调用按顺序出现，工具结果按 id 配对", () => {
  const reply = assistant("先看状态。");
  reply.content = [
    { type: "thinking", thinking: "先确认服务在线。" },
    { type: "text", text: "先看状态。" },
    { type: "toolCall", id: "call-1", name: "easy_workflow_call", arguments: { name: "status" } },
  ];
  const result = {
    role: "toolResult" as const, toolCallId: "call-1", toolName: "easy_workflow_call",
    content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }], isError: false, timestamp: 1100,
  };
  const entries: ConversationEntry[] = [
    { id: "u", turn: "t", message: { role: "user", content: "现在怎么样", timestamp: 900 } },
    { id: "a", turn: "t", message: reply },
    { id: "r", turn: "t", message: result },
  ];
  const items = buildTranscript({ entries, live: live(), dispatcher: dispatcher(), notes: [], factory });
  assert.equal(items.length, 2, "工具结果并入调用卡片，不单独成行");
  assert.equal(items[0].actor.kind, "user");
  assert.deepEqual(items[0].parts, [{ type: "text", text: "现在怎么样" }]);
  const parts = items[1].parts ?? [];
  assert.deepEqual(parts.map((p) => p.type), ["thinking", "text", "tool"]);
  const tool = parts[2] as Extract<(typeof parts)[number], { type: "tool" }>;
  assert.equal(tool.status, "done");
  assert.equal(tool.label, "查看运行状态", "已知工具名与服务端渲染器一致，不加前缀");
  assert.match(tool.args, /"status"/);
  assert.match(tool.result ?? "", /"ok": true/);
});

test("流式回答：只给最后一段正文加光标，思考块标记为进行中", () => {
  const reply = assistant("半句话");
  // 流式中的消息还没有结束原因；legacyReply 的默认值代表已完成的回答。
  (reply as { stopReason?: string }).stopReason = undefined;
  reply.content = [{ type: "thinking", thinking: "想想" }, { type: "text", text: "半句话" }];
  const items = buildTranscript({
    entries: [], live: live({ id: "t", messageId: "a", message: reply }),
    dispatcher: dispatcher({ busy: true, turn: "t" }), notes: [], factory,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].streaming, true);
  const parts = items[0].parts ?? [];
  assert.equal((parts[0] as { streaming: boolean }).streaming, true);
});

test("工位记录：带工位小人和真实状态，没有节点的广播不进对话", () => {
  const items = buildTranscript({
    entries: [], live: live(), dispatcher: dispatcher(), factory,
    station: () => ({ shape: "hex", hue: 186, state: "work" }),
    notes: [
      { id: "n1", role: "note", text: "[分拣] 已按来源分流", at: 5, tone: "info", node: "curation/sort" },
      { id: "n2", role: "note", text: "全局广播：运行开始", at: 6 },
      { id: "n3", role: "note", text: "[不存在] 无此工位", at: 7, node: "nope/nope" },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].notice, "已按来源分流", "节点名前缀由渲染层去掉");
  assert.deepEqual(items[0].actor, { kind: "station", name: "分拣", role: "sort", node: "curation/sort", shape: "hex", hue: 186, state: "work" });
});

test("条目按时间排序，用户只出现在主调度这条线上", () => {
  const entries: ConversationEntry[] = [
    { id: "u", turn: "t", message: { role: "user", content: "开始", timestamp: 200 } },
    { id: "a", turn: "t", message: assistant("好的"), },
  ];
  const items = buildTranscript({
    entries, live: live(), dispatcher: dispatcher(), factory,
    notes: [{ id: "n1", role: "note", text: "[分拣] 开工", at: 100, tone: "info", node: "curation/sort" }],
    station: () => ({ shape: "blob", hue: 186, state: "idle" }),
  });
  assert.deepEqual(items.map((i) => [i.at, i.actor.kind]), [[100, "station"], [200, "user"], [1000, "dispatcher"]]);
});
