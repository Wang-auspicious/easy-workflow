import { Workflow, Images, Library, History, Globe, Settings2 } from "lucide-react";
import { setState, useStore, type View } from "../store.ts";

const ITEMS: { view: View; icon: typeof Workflow; label: string; key?: string }[] = [
  { view: "canvas", icon: Workflow, label: "画布 · 流水线", key: "Alt 1" },
  { view: "board", icon: Images, label: "证据板", key: "Alt 2" },
  { view: "library", icon: Library, label: "流水线库" },
  { view: "runs", icon: History, label: "运行记录与回放" },
  { view: "browser", icon: Globe, label: "内置浏览器" },
];

export function Rail() {
  const view = useStore((s) => s.view);
  const connected = useStore((s) => s.connected);
  const replay = useStore((s) => s.replay);
  const browser = useStore((s) => s.browser);
  const evidenceCount = useStore((s) => s.fs.evidenceOrder.length);
  return (
    <nav className="rail">
      <div className="rail-mark" data-tip="Pi Factory">
        <Workflow size={24} strokeWidth={1.8} />
      </div>
      <div className="rail-items">
        {ITEMS.map(({ view: v, icon: Icon, label, key }) => (
          <button key={v} className={`rail-item ${view === v || (v === "runs" && view === "report") ? "is-on" : ""}`} onClick={() => setState({ view: v })} data-tip={key ? `${label}  ${key}` : label} data-tip-side="right">
            <Icon size={19} strokeWidth={1.7} />
            {v === "browser" && (browser.tabs.some(t => t.attention) ? <i className="rail-browser-alert" aria-label="浏览器需要检查" /> : browser.tabs.length > 0 && <span className="rail-badge num" aria-label={`${browser.tabs.length} 个网页`}>{browser.tabs.length}</span>)}
            {v === "board" && evidenceCount > 0 && <span className="rail-badge num">{evidenceCount > 999 ? "999+" : evidenceCount}</span>}
          </button>
        ))}
      </div>
      <div className="rail-foot">
        <button className={`rail-item ${view === "settings" ? "is-on" : ""}`} onClick={() => setState({ view: "settings" })} data-tip="设置" data-tip-side="right">
          <Settings2 size={19} strokeWidth={1.7} />
        </button>
        <span className={`rail-conn ${replay ? "is-replay" : connected ? "is-on" : ""}`} data-tip={replay ? "回放中（离线）" : connected ? "已连接工厂" : "未连接"} data-tip-side="right" />
      </div>
    </nav>
  );
}
