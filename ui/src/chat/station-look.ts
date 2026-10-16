// 工位小人在对话里的样子：外观取自画布上的同一只（botFor + 布局 seed），
// 动作取自画布上同一套判定（Node.tsx 的 botState）。转录、群组栏、群组往来共用这一处，
// 避免三处各判一次、同一个工位在不同面板里脸色不一样。
import type { BotShape, CompiledFactory, Role } from "../../../shared/types.ts";
import type { GrokShapeName } from "./grokbot-shapes.ts";
import type { FactoryState } from "../../../shared/project.ts";
import { botFor } from "../../../shared/palette.ts";
import { botState } from "../canvas/Node.tsx";
import type { AvatarState } from "./avatar-look.ts";

export interface StationLook { shape: BotShape | GrokShapeName; hue: number; state: AvatarState }

export function stationLook(factory: CompiledFactory | null, state: FactoryState, bots: Record<string, number>, now: number) {
  return (key: string): StationLook | undefined => {
    const node = factory?.nodes.find((n) => n.key === key);
    if (!node) return undefined;
    const dormant = Boolean(node.dormant) || !factory?.lines.find((line) => line.id === node.line)?.wired;
    const look = botFor(key, node.role as Role, bots[key] !== undefined ? { seed: bots[key] } : undefined);
    return {
      shape: look.shape, hue: look.hue,
      state: botState(state.nodes[key], dormant, now, state.resources.waiting?.[key]),
    };
  };
}
