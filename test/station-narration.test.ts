import assert from "node:assert/strict";
import test from "node:test";
import { createStationNarration } from "../server/agent-station.ts";

test("station narration retains all streamed lines, long text and a short unfinished tail", () => {
  const emitted: string[] = [];
  let clock = 2000;
  const trace = createStationNarration(text => emitted.push(text), () => clock);
  const first = "需要逐个核对真实组件的标题、图片和来源，不能只用目录文字判断。".repeat(8);
  trace.push(first + "\n第二段要核对");
  assert.equal(emitted[0], first + "\n第二段要核对");
  clock += 10;
  trace.push("组件的预览。\n接着核对事实来源");
  trace.push("与许可");
  assert.equal(emitted.length, 1);
  trace.flush(); // assistant ends or begins a tool before the throttle expires
  assert.equal(emitted.join(""), first + "\n第二段要核对组件的预览。\n接着核对事实来源与许可");
  trace.flush();
  assert.equal(emitted.length, 2, "end-of-attempt flush must not duplicate text");
});

test("station narration removes filler across chunks without losing substantive text", () => {
  const emitted: string[] = [];
  const trace = createStationNarration(text => emitted.push(text), () => 0);
  trace.push("Hm"); trace.push("m...\nAct"); trace.push("ually, 主体需要重新拍摄。\nThe title actually contains useful evidence.\n");
  trace.flush();
  assert.deepEqual(emitted, ["主体需要重新拍摄。\nThe title actually contains useful evidence."]);
  trace.push("Hmm"); trace.flush();
  trace.push("Actually"); trace.flush();
  assert.equal(emitted.length, 1);
});
