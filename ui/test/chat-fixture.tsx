// Isolated acceptance fixture: never boots a factory or contacts a live project.
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "../src/styles/base.css";
import "../src/styles/shell.css";
import "../src/styles/panels.css";
import "../src/styles/studio.css";
import "../src/views/recovery.css";
import { Chat } from "../src/chat/Chat.tsx";
import { Rail } from "../src/shell/Rail.tsx";
import { Toasts } from "../src/shell/Toasts.tsx";
import {Settings} from '../src/views/Settings.tsx';
import {Library} from '../src/views/Library.tsx';
import {BrowserView} from '../src/views/BrowserView.tsx';
import {PreviewChoice} from '../src/views/PreviewChoice.tsx';
import {Review} from '../src/views/Review.tsx';
import { connect } from "../src/api.ts";
import {getState, setState, useStore} from '../src/store.ts';
import { apply, initialState, type TokenState } from "../../shared/project.ts";
import { legacyReply } from "../../shared/conversation.ts";
import { botFor } from "../../shared/palette.ts";
import type { CompiledFactory, CompiledNode, Stamped } from "../../shared/types.ts";
import '../src/styles/materials.css';

const fs = initialState();
const now = Date.now();
fs.run = { id: "fixture-run", title: "候选 × 100", startedAt: now - 10000, pausedMs: 0, status: "running" };
fs.batch = { runId: fs.run.id, target: 100, maxInFlight: 12, intakeWindow: 6, maxRecoveries: 3, mode: "running", startedAt: fs.run.startedAt };
for (let i = 0; i < 20; i++) {
  const t: TokenState = { id: `token-${i}`, line: "curation", item: `site-${i}`, url: `https://site-${i}.example.test/`, title: `Fixture ${i}`, source: "fixture", status: i ? "parked" : "rejected", at: [], attempts: [], evidence: [], rounds: {}, corrections: 0, data: i ? { batchRecovery: { count: 1, nextAt: now + 40000, tag: "network_timeout", station: "capture", replan: false } } : {}, createdAt: now - 5000 };
  fs.tokens[t.id] = t; fs.tokenOrder.push(t.id);
}
// 一台最小的工厂：两个工位，用来验收"工位也能在右侧栏发消息"和它自己的小人状态。
const station = (key: string, line: string, name: string, role: CompiledNode["role"]): CompiledNode => ({
  key, id: key, line, layer: 3, name, role, kind: "agent", input: "*", output: "*", rules: [], accept: [],
  resource: "none", estimateSeconds: 0, workers: { min: 0, max: 1, initial: 0, policy: "fixed" }, bot: botFor(key, role),
});
const nodes = [station("curation/sort", "curation", "分拣", "sort"), station("curation/capture", "curation", "采集", "capture")];
const lines = [{ id: "curation", name: "策展线", layer: 3 as const, priority: "mid" as const, blurb: "fixture", stations: nodes, edges: [], wired: true }];
const factory: CompiledFactory = { nodes, lines, edges: [], packs: [], channels: [], resources: { browser: 0, model: 0, cpu: 0, http: 0 }, issues: [], digest: "fixture", specVersion: "fixture", ui: { order: ["curation"], hints: {}, collapsed: [] } };
// 工位状态用真实事件在一次性快照里生成，再拷进 fixture，避免污染批次统计。
const mint = (events: Stamped[]) => { const tmp = initialState(factory); for (const e of events) apply(tmp, e); return tmp.nodes; };
const at = (seq: number) => ({ seq, at: now - 4000 + seq });
fs.nodes = {
  ...mint([
    { kind: "token.created", token: "fixture-token", line: "curation", item: "site-0", url: "https://site-0.example.test/", source: "fixture", ...at(1) } as Stamped,
    { kind: "token.queued", token: "fixture-token", node: "curation/sort", ...at(2) } as Stamped,
    { kind: "attempt.started", attempt: "fixture-attempt", token: "fixture-token", node: "curation/sort", worker: "fixture-worker", input: "site-0", ...at(3) } as Stamped,
  ]),
};
// 采集工位刚刚失败过：小人应当显示失败状态，而不是跟着提示语猜。
fs.nodes["curation/capture"] = { ...fs.nodes["curation/sort"], key: "curation/capture", queue: [], active: [], workers: [], lastFailAt: now - 1000, lastOkAt: 0 };
fs.activity = [
  { id: "note-1", role: "note", text: "[分拣] 候选已按来源分流，采集限额还有 6 个位置", at: now - 3000, tone: "info", node: "curation/sort" },
  { id: "note-2", role: "note", text: "[采集] 截图超时，已退回候选库并记录标签", at: now - 2000, tone: "warn", node: "curation/capture" },
];

const partial = legacyReply("已核对这批网站的状态。现有图片和已经完成的工具结果已保留，接下来从失败工位继续。", now - 6000); partial.stopReason = "aborted";
// 已经结束的那一轮里留一个没返回的工具调用：验收"报错不自动展开，只在摘要下留一行原因"。
const dangling = legacyReply("查一下浏览器状态。", now - 9000);
dangling.content = [
  { type: "text", text: "查一下浏览器状态。" },
  { type: "toolCall", id: "call-2", name: "easy_workflow_call", arguments: { name: "browser" } },
];
const error = legacyReply("", now - 5000); error.stopReason = "error"; error.errorMessage = "The operation was aborted due to timeout";
// 一轮带思考与工具调用的回答：验收思考折叠、工具卡片和结果配对。
const withTools = legacyReply("先看一下当前状态。", now - 8000);
withTools.content = [
  { type: "thinking", thinking: "先确认服务是否在线，再决定要不要动工位。" },
  { type: "text", text: "先看一下当前状态。" },
  { type: "toolCall", id: "call-1", name: "easy_workflow_call", arguments: { name: "status" } },
];
const toolResult = {
  role: "toolResult" as const, toolCallId: "call-1", toolName: "easy_workflow_call",
  content: [{ type: "text" as const, text: JSON.stringify({ ok: true, running: 2, blocked: 19 }) }],
  isError: false, timestamp: now - 7500,
};
fs.conversation = [
  { id: "fixture-dangling", turn: "fixture-old", message: dangling },
  { id: "fixture-tools", turn: "fixture-tools", message: withTools },
  { id: "fixture-tools-result", turn: "fixture-tools", message: toolResult },
  { id: "fixture-turn", turn: "fixture-turn", message: { role: "user", content: "把 100 个网站持续处理完，有问题自行恢复。", timestamp: now - 7000 } },
  { id: "fixture-partial", turn: "fixture-turn", message: partial },
  { id: "fixture-error", turn: "fixture-turn", message: error },
];
fs.alerts = {
  network: { id: "network", at: now, kind: "auth", level: "red", item: "angular-ui", token: "token-2", url: "https://angular-ui.example.test/", message: "Angular UI：net::ERR_CONNECTION_CLOSED", nextAction: "请登录" },
  auth: { id: "auth", at: now - 100, kind: "auth", level: "red", item: "account", tab: "login-tab", url: "https://account.example.test/", message: "素材账户：需要登录才能查看私有文件" },
};
fs.recoveries["angular-ui"] = { item: "angular-ui", token: "token-2", title: "Angular UI", source: "fixture", url: "https://angular-ui.example.test/", disposition: "retry", at: now, attempts: 1, failure: { tag: "network_connection", category: "network", owner: "system", retryable: true, message: "公开入口连接中断，已保留先前成果" } };
setState({ fs, factory, ready: true, connected: true, chatOpen: true, chatList: true, chatWidth: 420, model: "fixture-model", version: 1,
  live: { id: "fixture-turn", text: "", tools: [] },
  dispatcher: { turn: "fixture-turn", status: "recovering", busy: true, attempt: 2, maxAttempts: 4, nextRetryAt: now + 40000, message: "连接超时，已保存上下文；稍后继续当前任务。", error: error.errorMessage, recoverable: true, updatedAt: now },
  browser: { tabs: [{ id: "login-tab", title: "素材账户", url: "https://account.example.test/login", owner: "agent", loading: false, attention: "登录后查看私有文件", attentionKind: "auth" }], active: "login-tab", bookmarks: [], history: [], retentionDays: 30, mode: "headless" },
});
(window as any).chatFixture = { getState, setState };
function FixtureWorkspace() {
  const view = useStore(state => state.view);
  if (view === 'settings') return <Settings />;
  if (view === 'library') return <Library />;
  if (view === 'browser') return <BrowserView />;
  if (view === 'review') return <Review />;
  if (view === 'candidates') return <PreviewChoice item="fixture-item" onMessage={message => setState({draft: message})} />;
  return <><h2>恢复流程验收</h2><p>隔离测试数据 · 不连接真实工厂</p></>;
}
createRoot(document.getElementById("root")!).render(<div className="app" style={{ "--chat-w": "420px" } as React.CSSProperties}><Rail /><main className="workspace"><FixtureWorkspace /></main><Chat /><Toasts /></div>);
connect(0);
