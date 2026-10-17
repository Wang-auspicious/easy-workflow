// Window skeleton (Spec §10.2): a narrow rail, the workspace (canvas or another view), and
// the fixed dispatcher chat on the right. No top bar.
import { useEffect } from "react";
import { useStore, setState, getState } from "./store.ts";
import { Rail } from "./shell/Rail.tsx";
import { Chat, chatPanelWidth } from "./chat/Chat.tsx";
import { Canvas } from "./canvas/Canvas.tsx";
import { EvidenceBoard } from "./board/EvidenceBoard.tsx";
import { Library } from "./views/Library.tsx";
import { Runs } from "./views/Runs.tsx";
import { Candidates } from "./views/Candidates.tsx";
import { Review } from "./views/Review.tsx";
import { BrowserView } from "./views/BrowserView.tsx";
import { Settings } from "./views/Settings.tsx";
import { Report } from "./report/Report.tsx";
import { Tooltip } from "./shell/Tooltip.tsx";
import { Toasts } from "./shell/Toasts.tsx";
import { HoverPreviewHost } from "./shell/HoverPreview.tsx";
import {boot} from './api.ts';

export function App() {
  const ready = useStore((s) => s.ready);
  const view = useStore((s) => s.view);
  const chatOpen = useStore((s) => s.chatOpen);
  const chatWidth = useStore((s) => s.chatWidth);
  const roomRailOpen = useStore((s) => s.roomRailOpen);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "1" && e.altKey) setState({ view: "canvas" });
      if (e.key === "2" && e.altKey) setState({ view: "board" });
      if (e.key === "\\" && (e.ctrlKey || e.metaKey)) setState({ chatOpen: !getState().chatOpen });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app" style={{ ["--chat-w" as string]: `${chatOpen ? chatPanelWidth(chatWidth, roomRailOpen) : 64}px` }}>
      <Rail />
      <main className="workspace">
        {!ready ? <Booting /> : (
          <>
            <div className={`ws-layer ${view === "canvas" ? "is-on" : ""}`}><Canvas active={view === "canvas"} /></div>
            {view === "board" && <EvidenceBoard />}
            {view === "library" && <Library />}
            {view === "runs" && <Runs />}
            {view === "candidates" && <Candidates />}
            {view === "review" && <Review />}
            {view === "browser" && <BrowserView />}
            {view === "settings" && <Settings />}
            {view === "report" && <Report />}
          </>
        )}
      </main>
      <Chat />
      <Tooltip />
      <Toasts />
      <HoverPreviewHost />
    </div>
  );
}

function Booting() {
  const error = useStore(state => state.bootError);
  return (
    <div className="booting" role={error ? 'alert' : 'status'}>
      {!error && <div className="booting-dots"><i /><i /><i /></div>}
      <div>{error ? '暂时无法打开工作台' : '正在连接工厂…'}</div>
      {error && <><p className="muted">{error}</p><button className="btn" onClick={() => void boot().catch(() => {})}>重新连接</button></>}
    </div>
  );
}
