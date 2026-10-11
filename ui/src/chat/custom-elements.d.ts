// pi-web-ui 的 Markdown / 代码块以自定义元素注册（见 PiBlocks.ts），在 JSX 里按元素写。
import type { HTMLAttributes, RefAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "markdown-block": HTMLAttributes<HTMLElement> & RefAttributes<HTMLElement> & { content?: string; isThinking?: boolean };
      "code-block": HTMLAttributes<HTMLElement> & RefAttributes<HTMLElement> & { code?: string };
    }
  }
}
