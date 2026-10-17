// 群组是从流程图上推出来的，这里锁住推导与投影的几条硬约定：
// 程序工位不被当成 Agent、返工环与跨段一定出现、一条往来只落在一个群里。
import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "../../server/spec/compile.ts";
import { pack } from "../../packs/vislexicon/pack.ts";
import { deriveRooms, ROOT_ROOM, speakersOf, talks } from "../../shared/rooms.ts";
import { buildRoomLines, routeComm, type RoomContext } from "../src/chat/rooms.ts";
import { apply, initialState, type FactoryState } from "../../shared/project.ts";
import type { Stamped } from "../../shared/types.ts";

const factory = compile([pack]);
const at = (seq: number, at: number) => ({ seq, at, run: "rooms-test" });
/** 验收只关心"谁在说话"，小人的外观由界面注入；这里给一只固定的。 */
const look = (key: string) => ({ shape: "blob" as const, hue: 250, state: "idle" as const });
const context = (state: FactoryState): RoomContext => ({ factory, state, look, now: 1000 });

const build = (events: Stamped[]): FactoryState => {
  const state = initialState(factory);
  for (const event of events) apply(state, event);
  return state;
};

test("群组从流程图上推出来：每一段工序、声明的返工环、跨段移交都在", () => {
  const rooms = deriveRooms(factory);
  assert.equal(rooms[0]!.id, ROOT_ROOM, "总台永远是第一个");

  const ids = rooms.map((room) => room.id);
  assert.equal(new Set(ids).size, ids.length, "群 id 不能重复");
  // 总台没有工位成员（它就是你 + 主调度），其余每个群至少两个工位。
  for (const room of rooms.filter((entry) => entry.kind !== "root")) assert.ok(room.members.length >= 2, `${room.id} 至少两个成员：${room.subtitle}`);

  // 策展线的四段工序都有群，而不是只有会说话最多的那一段。
  const parts = rooms.filter((room) => room.kind === "part");
  assert.deepEqual(parts.filter((room) => room.line === "curation").map((room) => room.name),
    ["读懂与判定", "取证与风格", "核验与发布"]);
  // 一条线全是程序工位时不产生群：候选层和来源层都不该出现。
  assert.equal(parts.filter((room) => room.line === "candidates" || room.line === "sources").length, 0);

  // 规格声明的 returnTo → 返工环，成员就是审查员和它能退回去的工位。
  const loop = rooms.find((room) => room.id === "loop:curation/shot-review");
  assert.ok(loop, "截图审查员的返工环必须出现");
  assert.deepEqual(loop.members.map((member) => member.key),
    ["curation/shot-review", "curation/identity", "curation/breadth", "curation/proof"]);

  // 跨段：两条信道各自成一个群。
  const bridges = rooms.filter((room) => room.kind === "bridge");
  for (const channel of factory.channels) assert.ok(bridges.some((room) => room.signal.includes(channel.id)),
    `信道 ${channel.id} 应当有对应的跨段群`);

  // 程序工位如实标注，不进头像栈。
  assert.ok(loop.members.some((member) => member.kind === "program" && !member.talks));
  assert.deepEqual(speakersOf(loop).map((member) => member.key), ["curation/shot-review"]);
  for (const room of rooms) for (const member of room.members) assert.equal(member.talks, talks(member));
  assert.equal(talks({ kind: "gate" }), false, "闸门是程序判定，不是 Agent");
  assert.equal(talks({ kind: "review" }), true, "审阅是模型在说话");
});

test("运行期真的发生的咨询会补出图上没有的群，图上已有的不重复补", () => {
  const base = deriveRooms(factory);
  // 终审员（核验与发布）与编目员（读懂与判定）跨了工序，静态图上没有共同群。
  const observed = deriveRooms(factory, [{ reviewer: "curation/audit", owner: "curation/catalog" }]);
  assert.equal(observed.length, base.length + 1);
  const room = observed.find((entry) => entry.id === "loop:curation/audit");
  assert.ok(room?.observed, "观测补出来的群要标出来");
  assert.deepEqual(room.members.map((member) => member.key), ["curation/audit", "curation/catalog"]);

  // 同一段工序里的往来已经被工序群装下了，不再补一个重复的群。
  const inside = deriveRooms(factory, [{ reviewer: "curation/fact-review", owner: "curation/facts" }]);
  assert.equal(inside.length, base.length);
});

test("真实事件落成往来：判定、退回、咨询、纠错、交付各说各的", () => {
  const events: Stamped[] = [
    { kind: "token.created", token: "t1", line: "curation", item: "d3-color", url: "https://d3js.org", source: "manual", ...at(1, 100) },
    { kind: "review.verdict", token: "t1", node: "curation/shot-review", verdict: "pass", reason: "三张图都可见", ...at(2, 200) },
    { kind: "review.verdict", token: "t1", node: "curation/fact-review", verdict: "return", returnTo: "curation/facts", reason: "许可没有引用来源", ...at(3, 300) },
    { kind: "token.returned", token: "t1", from: "curation/fact-review", to: "curation/facts", reason: "许可没有引用来源", round: 2, ...at(4, 400) },
    { kind: "consult.opened", consult: "k-1", token: "t1", reviewer: "curation/style", owner: "curation/proof", fields: ["shots.proof"], problem: "主体不可见", round: 1, ...at(5, 500) },
    { kind: "consult.replied", consult: "k-1", token: "t1", owner: "curation/proof", reply: "已重拍", ok: true, ...at(6, 600) },
    { kind: "consult.closed", consult: "k-1", token: "t1", outcome: "resolved", reason: "复查通过", ...at(7, 700) },
    { kind: "correction.created", correction: "c-1", token: "t1", node: "curation/proof", reason: "特写裁到导航栏了", ...at(8, 800) },
    { kind: "channel.emitted", channel: "curation.component-source.confirmed", token: "t1", item: "d3-color", ...at(9, 900) },
  ];
  const state = build(events);
  const comms = state.comms ?? [];
  assert.deepEqual(comms.map((entry) => entry.kind), ["verdict", "verdict", "return", "consult", "consult", "consult", "correction", "channel"]);

  const returned = comms.find((entry) => entry.kind === "return")!;
  assert.equal(returned.from, "curation/fact-review");
  assert.equal(returned.to, "curation/facts");
  assert.match(returned.text, /第 2 轮退回/);
  assert.equal(returned.tone, "warn");

  const opened = comms.find((entry) => entry.kind === "consult")!;
  assert.match(opened.text, /shots\.proof/);
  assert.match(opened.text, /主体不可见/);
  // 回复落在发起人那里，而不是留在被点名的工位。
  const replied = comms.find((entry) => entry.kind === "consult" && entry.from === "curation/proof")!;
  assert.equal(replied.from, "curation/proof");
  assert.equal(replied.to, "curation/style");
  assert.equal(replied.tone, "info");

  assert.equal(comms.find((entry) => entry.kind === "correction")!.from, "user");
  assert.equal(comms.find((entry) => entry.kind === "channel")!.from, "channel:curation.component-source.confirmed");
});

test("一条往来只落在一个群里，跨段交付落在跨段群并标出两端", () => {
  const state = build([
    { kind: "review.verdict", token: "t1", node: "curation/fact-review", verdict: "return", returnTo: "curation/facts", reason: "许可没有引用来源", ...at(1, 100) },
    { kind: "consult.opened", consult: "k-1", token: "t1", reviewer: "curation/audit", owner: "curation/catalog", fields: ["facets"], problem: "主类与编目不符", round: 1, ...at(2, 200) },
    { kind: "channel.emitted", channel: "curation.component-source.confirmed", token: "t1", item: "d3-color", ...at(3, 300) },
  ]);
  const rooms = deriveRooms(factory, [{ reviewer: "curation/audit", owner: "curation/catalog" }]);
  const ctx = context(state);
  const lines = rooms.filter((room) => room.kind !== "root").flatMap((room) => buildRoomLines(room, rooms, ctx));
  assert.equal(new Set(lines.map((line) => line.id)).size, lines.length, "同一条往来不能在多个群里重复");

  // 同类工序内部的退回留在这一段工序里，不让它掉进别的群。
  const within = rooms.find((room) => room.name === "核验与发布")!;
  assert.deepEqual(buildRoomLines(within, rooms, ctx).map((line) => line.text), ["退回：许可没有引用来源"]);

  // 跨工序的咨询落进它们自己那个群，而不是随便进一方的工序群。
  const crossing = rooms.find((room) => room.id === "loop:curation/audit")!;
  const crossingLines = buildRoomLines(crossing, rooms, ctx);
  assert.equal(crossingLines.length, 1);
  assert.equal(crossingLines[0]!.actor.key, "curation/audit");
  assert.equal(crossingLines[0]!.to?.key, "curation/catalog");

  // 交付只有信道 id：两端由这个群自己的人给出，不编一个不存在的说话人。
  const bridge = rooms.find((room) => room.kind === "bridge" && room.signal.includes("curation.component-source.confirmed"))!;
  const delivery = buildRoomLines(bridge, rooms, ctx);
  assert.equal(delivery.length, 1);
  assert.equal(delivery[0]!.actor.key, bridge.members[0]!.key);
  assert.equal(delivery[0]!.to?.key, bridge.members[1]!.key);
  assert.match(delivery[0]!.text, /交付《d3-color》/);
});

test("谁都进不去的往来不会凭空出现：没有工厂时不假装有群", () => {
  assert.deepEqual(deriveRooms(null).map((room) => room.id), [ROOT_ROOM]);
  const state = initialState();
  const entry = { id: "c-1", seq: 1, at: 1, token: "t", kind: "note", from: "curation/x", to: null, text: "hi" } as const;
  assert.equal(routeComm(entry, deriveRooms(factory)), null, "工厂里没有这个工位就没有群");
  assert.equal(buildRoomLines(deriveRooms(factory)[0]!, deriveRooms(factory), context(state)).length, 0, "总台不用工位往来流");
});
