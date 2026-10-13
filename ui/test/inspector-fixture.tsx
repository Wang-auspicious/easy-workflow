// 工位卡片的隔离验收 fixture：不启动工厂、不连真实项目。
// 数据是构造的：一个审查工位，三个人（固定的人在忙、自动 fork 出来的人在忙、一个人被撤下），
// 过程里带思考、工具调用和证据，工位记录里有 fork 与撤下。
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "../src/styles/base.css";
import "../src/styles/shell.css";
import "../src/styles/panels.css";
import "../src/styles/studio.css";
import '../src/views/recovery.css';
import { Inspectors } from "../src/canvas/Inspector.tsx";
import { setState, getState, ingest, useStore } from "../src/store.ts";
import { apply, initialState } from "../../shared/project.ts";
import {uiState, uiEvent} from '../../shared/client-view.ts';
import {EvidenceBoard} from '../src/board/EvidenceBoard.tsx';
import {Settings} from '../src/views/Settings.tsx';
import { botFor } from "../../shared/palette.ts";
import type { CompiledFactory, CompiledNode, Stamped } from "../../shared/types.ts";
import type { Geometry } from "../src/canvas/geometry.ts";

const now = Date.now();
const station = (key: string, name: string, role: CompiledNode["role"], kind: CompiledNode["kind"]): CompiledNode => ({
  key, id: key, line: "curation", layer: 3, name, role, kind, num: "⑤", input: "候选", output: "结论",
  rules: ["vislexicon:review"], accept: ["结论有证据", "退回有理由"], resource: "model", estimateSeconds: 40,
  workers: { min: 1, max: 3, initial: 1, policy: "auto" }, bot: botFor(key, role),
  returnTo: [{ station: "curation/capture", maxRounds: 2 }], pseudo: "读入候选与证据 → 判定 → submit",
});
const nodes = [station("curation/review", "截图审查员", "review", "review"),
  station('curation/capture', '截图程序', 'process', 'program')];
const lines = [{ id: "curation", name: "策展线", layer: 3 as const, priority: "mid" as const, blurb: "fixture", stations: nodes, edges: [], wired: true }];
const factory: CompiledFactory = { nodes, lines, edges: [], packs: [], channels: [], resources: { browser: 0, model: 0, cpu: 0, http: 0 }, issues: [], digest: "fixture", specVersion: "fixture", ui: { order: ["curation"], hints: {}, collapsed: [] } };

const at = (seq: number) => ({ seq, at: now - 60_000 + seq * 1000 });
const fs = initialState(factory);
// 三个人：-1 在忙、-2 是自动 fork 出来的在忙、-3 被撤下。
const events: Stamped[] = [
  { kind: "worker.spawned", node: "curation/review", worker: "w1", label: "截图审查员-1", reason: "初始人数", ...at(1) } as Stamped,
  { kind: "worker.forked", node: "curation/review", worker: "w2", label: "截图审查员-2", reason: "队列超过阈值", ...at(2) } as Stamped,
  { kind: "worker.spawned", node: "curation/review", worker: "w3", label: "截图审查员-3", reason: "补充人数", ...at(3) } as Stamped,
  { kind: "token.created", token: "t1", line: "curation", item: "ai-line-art", url: "https://example.test/ai-line-art", title: "AI Line Art", source: "fixture", ...at(4) } as Stamped,
  { kind: "token.queued", token: "t1", node: "curation/review", ...at(5) } as Stamped,
  { kind: "attempt.started", attempt: "a1", token: "t1", node: "curation/review", worker: "w1", input: "ai-line-art", ...at(6) } as Stamped,
  { kind: "token.created", token: "t2", line: "curation", item: "bento-grid", url: "https://example.test/bento-grid", title: "Bento Grid", source: "fixture", ...at(7) } as Stamped,
  { kind: "token.queued", token: "t2", node: "curation/review", ...at(8) } as Stamped,
  { kind: "attempt.started", attempt: "a2", token: "t2", node: "curation/review", worker: "w2", input: "bento-grid", ...at(9) } as Stamped,
  { kind: "worker.retired", node: "curation/review", worker: "w3", reason: "空闲 125s", ...at(10) } as Stamped,
  { kind: "dispatch.note", node: "curation/review", tone: "fork", text: "[截图审查员] 队列 12 件，自动 fork 出第 2 个人", ...at(11) } as Stamped,
  { kind: "dispatch.note", node: "curation/review", tone: "info", text: "[截图审查员] 截图审查员-3 空闲 125s → 撤下（剩 2 人）", ...at(12) } as Stamped,
];
for (const e of events) apply(fs, e);
// 过程：思考 + 说话 + 工具（带证据）+ 一次拒收。
const step = (n: number, text: string, extra: Record<string, unknown> = {}) => ({ at: now - 50_000 + n * 1000, text, ...extra });
fs.attempts.a1.steps = [
  step(1, "先看图对不对得上条目描述。", { step: { tool: "think", ok: true } }),
  step(2, "对比描述里的关键词和截图内容。", { step: { tool: "think", ok: true } }),
  step(3, "打开原页面核对", { step: { tool: "http", ok: true, evidence: ["ev1"] } }),
  step(4, "截图 2 张", { step: { tool: "shot", ok: true, evidence: ["ev1", "ev2"] } }),
  step(5, "两张都对不上：构图与描述不符", { step: { tool: "reject", ok: false, evidence: ["ev2"] } }),
  step(6, "退回采集，附上不一致的证据。", { step: { tool: "submit", ok: true } }),
];
fs.attempts.a1.summary = "拒收：构图与描述不符";
fs.attempts.a1.ok = false;
fs.attempts.a1.endedAt = now - 40_000;
fs.attempts.a1.ms = 30_000;
fs.attempts.a1.usage = { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
fs.attempts.a2.steps = [
  step(20, "这张是 bento 网格，先数一下列数。", { step: { tool: "think", ok: true } }),
  step(21, "打开原页面", { step: { tool: "http", ok: true } }),
];
fs.evidence.ev1 = { id: "ev1", token: "t1", station: "curation/review", attempt: "a1", kind: "image", label: "原页面", src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='200'%3E%3Crect width='320' height='200' fill='%23dbeafe'/%3E%3Ctext x='16' y='110' font-size='20' fill='%232563eb'%3Eshot 1%3C/text%3E%3C/svg%3E", verdict: "待判定", at: now - 45_000 } as never;
fs.evidence.ev2 = { id: "ev2", token: "t1", station: "curation/review", attempt: "a1", kind: "image", label: "截图 2", src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='200'%3E%3Crect width='320' height='200' fill='%23fee2e2'/%3E%3Ctext x='16' y='110' font-size='20' fill='%23dc2626'%3Eshot 2%3C/text%3E%3C/svg%3E", verdict: "不一致", at: now - 44_000 } as never;
fs.evidence.evtext = {id: 'evtext', token: 't1', station: 'curation/review', attempt: 'a1', kind: 'verdict', label: '完整文字判定', verdict: '退回', meta: {rawText: 'FULL-EVIDENCE-NOT-IN-SUMMARY', verdicts: [{quote: '完整证据引文', accepted: false}]}, at: now - 43000} as never;
fs.evidenceOrder = ['ev1', 'ev2', 'evtext'];
fs.tokens.t1.evidence = [...fs.evidenceOrder];
fs.activity = events.filter((e) => e.kind === "dispatch.note").map((e, i) => ({ id: `n${i}`, role: "note" as const, text: (e as { text: string }).text, at: (e as { at: number }).at, tone: (e as { tone?: "info" | "fork" | "warn" }).tone, node: "curation/review" }));
fs.run = { id: "fixture-run", title: "候选 × 100", startedAt: now - 60_000, pausedMs: 0, status: "running" };
fs.agentDefaults = {
  station: {adapter: 'pi', provider: 'fixture-provider', model: 'fixture-model'},
  dispatcher: {adapter: 'pi', provider: 'dispatcher-provider', model: 'dispatcher-model'},
};

const geo: Geometry = { nodes: [], place: {}, capsules: [], capsuleOf: {}, docks: [], dockOf: {}, edges: [], returns: [], bounds: { x: 0, y: 0, w: 1200, h: 800 }, halls: [], bays: [], shelf: null };
setState({fs: uiState(fs), factory, ready: true, connected: true, version: 1, view: 'canvas', model: "fixture-model",
  settings: {browser: 2, model: 1, modelWorkers: 3, cpu: 2, http: 2, memoryFloorMB: 1024, socialPerMinute: 2, socialPerDay: 60},
  inspectors: [{ key: "curation/review", kind: "node", x: 40, y: 40, pinned: true }]});
(window as any).inspectorFixture = {getState, setState, fullState: fs, emit: (event: Stamped) => {
  const stamped = {...event, seq: fs.seq + 1, at: Date.now(), run: fs.run.id} as Stamped;
  apply(fs, stamped);
  ingest([uiEvent(stamped)]);
}};
function Fixture() {
  const view = useStore(state => state.view);
  return view === 'board' ? <EvidenceBoard /> : view === 'settings' ? <Settings /> : <Inspectors geo={geo} cam={{x: 0, y: 0, k: 1}} />;
}
createRoot(document.getElementById("root")!).render(
  <div className="app" style={{ ["--chat-w" as string]: "0px" }}>
    <main className="workspace" style={{ position: "relative", width: 760, height: 820 }}>
      <Fixture />
    </main>
  </div>,
);
