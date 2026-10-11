// 小人的外观与状态词，不依赖 React，方便在 node 里单测（ui/test/transcript.test.ts）。
// 形状数据来自 Grok Bot（grokbot-shapes.ts）。
import type { BotShape } from "../../../shared/types.ts";
import { GROK_SHAPES, SHAPE_MAP, type GrokShapeName } from "./grokbot-shapes.ts";

/** 小人的动作状态。什么时候用哪个状态，由 transcript.ts 依真实运行状态判定。 */
export type AvatarState = "idle" | "thinking" | "speaking" | "work" | "wait" | "returned" | "fail" | "sleep";

/** 行头里的状态词。说清楚"现在在干什么"。 */
export const STATE_TEXT: Record<AvatarState, string> = {
  idle: "空闲", thinking: "思考中", speaking: "正在回答", work: "执行中",
  wait: "等待中", returned: "刚交回", fail: "已中断", sleep: "休眠",
};

const isGrokShape = (s: string): s is GrokShapeName => s in GROK_SHAPES;

/** 画布上的 BotShape 与对话里是同一只：circle→blob、drop→teardrop 等。 */
export function grokShape(shape: BotShape | GrokShapeName | undefined): GrokShapeName {
  if (shape && isGrokShape(shape)) return shape;
  return (shape && SHAPE_MAP[shape]) || "blob";
}
