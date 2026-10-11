// One tooltip for the whole app: any element with data-tip gets it (quiet, fast, no clutter).
import { useEffect, useState } from "react";

export function Tooltip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; side: string } | null>(null);
  useEffect(() => {
    let timer = 0;
    let current: HTMLElement | null = null;
    const over = (e: PointerEvent) => {
      const el = (e.target as HTMLElement).closest?.("[data-tip]") as HTMLElement | null;
      if (el === current) return;
      current = el;
      clearTimeout(timer);
      setTip(null);
      if (!el) return;
      timer = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        const side = el.dataset.tipSide ?? "bottom";
        if (side === "right") setTip({ text: el.dataset.tip!, x: r.right + 10, y: r.top + r.height / 2, side });
        else if (side === "top") setTip({ text: el.dataset.tip!, x: r.left + r.width / 2, y: r.top - 8, side });
        else setTip({ text: el.dataset.tip!, x: r.left + r.width / 2, y: r.bottom + 8, side });
      }, 380);
    };
    const out = () => { clearTimeout(timer); };
    const down = () => { clearTimeout(timer); setTip(null); current = null; };
    window.addEventListener("pointerover", over);
    window.addEventListener("pointerout", out);
    window.addEventListener("pointerdown", down);
    return () => { window.removeEventListener("pointerover", over); window.removeEventListener("pointerout", out); window.removeEventListener("pointerdown", down); };
  }, []);
  if (!tip) return null;
  const style: React.CSSProperties = tip.side === "right" ? { left: tip.x, top: tip.y, transform: "translate(0, -50%)" } : tip.side === "top" ? { left: tip.x, top: tip.y, transform: "translate(-50%, -100%)" } : { left: tip.x, top: tip.y };
  return <div className="tip" style={style}>{tip.text}</div>;
}
