// 群组头像：把成员的小人拼成一只（Grok Bot 的堆叠几何）。
//
// 2 人斜对角（每只 2/3），3 人品字、4 人四方（每只 5/9），超过 4 个画前 3 只
// 加一个溢出块（缩到 0.74）。同一只群头像在收起态和列表里都长这样，位置固定，
// 不会因为谁在跑而跳来跳去。
import { memo } from "react";
import type { BotShape } from "../../../shared/types.ts";
import { Avatar, type AvatarState } from "./Avatar.tsx";
import type { GrokShapeName } from "./grokbot-shapes.ts";

export interface StackMember { key: string; shape?: BotShape | GrokShapeName; hue: number; state: AvatarState; title?: string }

/** Grok Bot 的布局函数，逐字搬运：给定人数和画布边长，算每只的位置和直径。 */
export function stackLayout(count: number, frame: number, max = 4): { x: number; y: number; size: number }[] {
  if (count <= 1) return [{ x: 0, y: 0, size: frame }];
  if (count === 2) {
    const size = (frame * 2) / 3, offset = frame - size;
    return [{ x: 0, y: 0, size }, { x: offset, y: offset, size }];
  }
  const size = (frame * 5) / 9, offset = frame - size;
  if (count === 3) return [{ x: offset / 2, y: 0, size }, { x: 0, y: offset, size }, { x: offset, y: offset, size }];
  if (count <= max) return [
    { x: 0, y: 0, size }, { x: offset, y: 0, size }, { x: 0, y: offset, size }, { x: offset, y: offset, size },
  ];
  return [{ x: offset / 2, y: 0, size }, { x: 0, y: offset, size }, { x: offset, y: offset, size }];
}

export const OVERFLOW_SCALE = 0.74;

export const GroupAvatar = memo(function GroupAvatar({ members, size, max = 4 }: {
  members: readonly StackMember[]; size: number; max?: number;
}) {
  const shown = members.slice(0, members.length > max ? 3 : members.length);
  const overflow = members.length - shown.length;
  const boxes = stackLayout(members.length, size, max);
  return (
    <span className="gstack" style={{ width: size, height: size }} aria-hidden>
      {shown.map((member, index) => {
        const box = boxes[index]!;
        return (
          <span key={member.key} className="gstack-slot" style={{ left: box.x, top: box.y, width: box.size, height: box.size }}>
            <Avatar shape={member.shape} hue={member.hue} state={member.state} size={box.size} title={member.title} />
          </span>
        );
      })}
      {overflow > 0 && (
        <span className="gstack-more" style={{
          right: 0, bottom: 0, width: size * OVERFLOW_SCALE * 0.62, height: size * OVERFLOW_SCALE * 0.62,
          fontSize: Math.max(8, size * OVERFLOW_SCALE * 0.34),
        }}>+{overflow}</span>
      )}
    </span>
  );
});
