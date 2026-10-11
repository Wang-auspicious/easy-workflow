// Run report (Spec §10.12): built from the journal when the owner ends a run by hand.
// Per-layer node diffs, station cards, a worker Gantt, and the metrics nobody asked for
// but everybody wants once they see them — each with a number, a sparkline and a link.
import fs from "node:fs";
import path from "node:path";
import type { Stamped } from "../shared/types.ts";
import { apply, initialState, median, quantile, type FactoryState } from "../shared/project.ts";
import { VAR, type Factory } from "./factory.ts";

export interface Insight { id: string; title: string; value: string; detail: string; spark?: number[]; tone: "good" | "warn" | "info"; node?: string; token?: string; score: number }
export interface Suggestion { title: string; why: string; prompt: string; node?: string }

export interface RunReport {
  version: 3; status: FactoryState["run"]["status"];
  runId: string; title: string; startedAt: number; endedAt: number; netMs: number;
  totals: FactoryState["totals"] & { created: number; parked:number; failedAttempts:number; perPublishedMs: number; perPublishedCost: number; perPublishedTokens: number };
  layers: { layer: number; nodes: NodeRow[] }[];
  flows: { from: string; to: string; n: number; returned: number }[];
  workers: WorkerRow[];
  insights: Insight[];
  suggestions: Suggestion[];
  attempts: { id:string; node:string; token:string; item:string; startedAt:number; endedAt?:number; ms:number; queuedMs:number; input:number; output:number; cost:number; ok?:boolean; cancelled?:boolean; summary:string; steps:{at:number;text:string}[] }[];
  items: { published: ItemRow[]; manual: ItemRow[]; corrected: ItemRow[]; merged: ItemRow[]; rejected: ItemRow[]; parked:ItemRow[] };
}
interface NodeRow {
  key: string; name: string; role: string; layer: number; line: string; stockStart: number; stock: number; plus: number; sent: number; merged: number; rejected: number; failed: number;
  returned: number; inRun: number; processed: number; medianMs: number; p90Ms: number; waitShare: number; tokens: number; cost: number; timeShare: number; workers: number; forks: number; retires: number;
  topReasons: { reason: string; n: number }[]; slowest: { item: string; ms: number }[];
}
interface WorkerRow { id: string; label: string; node: string; nodeName: string; done: number; busyMs: number; idleShare: number; spawnedAt: number; retiredAt?: number; forked: boolean; spans: [number, number, string][]; items: string[] }
interface ItemRow { token: string; item: string; title?: string; reason?: string; thumbs: string[]; node?: string; ms?: number; cost?: number }

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const secs = (ms: number) => (ms >= 60000 ? `${(ms / 60000).toFixed(1)} 分` : `${(ms / 1000).toFixed(1)} 秒`);

export function buildReport(f: Factory, runId: string): RunReport {
  const events: Stamped[] = [...f.journal.read(0, runId)];
  const start = events.find((e) => e.kind === "run.started");
  const end = [...events].reverse().find((e) => e.kind === "run.ended");
  // Reconstruct the requested run, including its initial stock and worker pools.
  // Current in-memory counters may already belong to a completely different run.
  const s = initialState(f.compiled);
  const last = events.at(-1)?.seq ?? 0;
  for (const event of f.journal.read()) { if (event.seq > last) break; apply(s,event); }
  const startedAt = start?.at ?? s.run.startedAt, endedAt = end?.at ?? Date.now();
  let pausedMs = 0, pauseAt = 0;
  for (const e of events) { if (e.kind === "run.paused") pauseAt = e.at; if (e.kind === "run.resumed" && pauseAt) { pausedMs += e.at - pauseAt; pauseAt = 0; } }
  if (pauseAt) pausedMs += endedAt - pauseAt;
  const netMs = Math.max(0, endedAt - startedAt - pausedMs);
  const nodeOf = new Map(f.compiled.nodes.map((n) => [n.key, n]));
  const tokenIds = new Set(events.flatMap(e=>e.kind==="token.created"||e.kind==="token.queued"?[e.token]:[]));
  const attemptIds = new Set(events.flatMap(e=>e.kind==="attempt.started"?[e.attempt]:[]));
  const tokens = [...new Map(Object.values(s.tokens).filter((t) => tokenIds.has(t.id)).map(t=>[t.item,t])).values()];
  const attempts = Object.values(s.attempts).filter((a) => attemptIds.has(a.id));

  /* per-node reasons and slowest items */
  const reasons = new Map<string, Map<string, number>>();
  const bump = (k: string, r: string) => { const m = reasons.get(k) ?? reasons.set(k, new Map()).get(k)!; const key = r.replace(/https?:\/\/\S+/g, "").slice(0, 46); m.set(key, (m.get(key) ?? 0) + 1); };
  const flows = new Map<string, { from: string; to: string; n: number; returned: number }>();
  for (const e of events) {
    if (e.kind === "token.returned") bump(e.from === "human" ? e.to : e.from, e.reason);
    if (e.kind === "token.finished" && e.status !== "published") bump(e.node, e.reason);
    if (e.kind === "attempt.progress" && e.step?.tool === "reject") { const a = s.attempts[e.attempt]; if (a) bump(a.node, `拒收：${e.step.text.split(",")[0]}`); }
    if (e.kind === "token.queued" && e.from) {
      const k = `${e.from}->${e.node}`;
      const fl = flows.get(k) ?? flows.set(k, { from: e.from, to: e.node, n: 0, returned: 0 }).get(k)!;
      if (e.returned) fl.returned++; else fl.n++;
    }
  }
  const totalWork = sum(attempts.map((a) => a.ms ?? 0)) || 1;
  const rows: NodeRow[] = [];
  for (const n of f.compiled.nodes) {
    const st = s.nodes[n.key];
    if (!st) continue;
    const mine = attempts.filter((a) => a.node === n.key && a.ms !== undefined);
    const touched = st.inRun || st.processed || st.plus || st.sent || (st.stockStart !== null && st.stockStart !== st.stock) || mine.length;
    if (!touched) continue;
    const okMs = mine.filter((a) => a.ok).map((a) => a.ms!);
    const work = sum(mine.map((a) => a.ms!)), wait = sum(mine.map((a) => a.queuedMs ?? 0));
    const slow = [...mine].sort((a, b) => b.ms! - a.ms!).slice(0, 3).map((a) => ({ item: s.tokens[a.token]?.item ?? a.token, ms: a.ms! }));
    const top = [...(reasons.get(n.key) ?? new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, k]) => ({ reason, n: k }));
    rows.push({
      key: n.key, name: n.name, role: n.role, layer: n.layer, line: n.line, stockStart: st.stockStart ?? st.stock, stock: st.stock, plus: st.plus, sent: st.sent, merged: st.merged, rejected: st.rejected, failed: st.failed,
      returned: st.returned, inRun: st.inRun, processed: st.processed, medianMs: median(okMs), p90Ms: quantile(okMs, 0.9), waitShare: wait / Math.max(1, wait + work),
      tokens: sum(mine.map((a) => a.usage.input + a.usage.output)), cost: sum(mine.map((a) => a.usage.cost)), timeShare: work / totalWork,
      workers: st.workers.length, forks: st.forks, retires: st.retires, topReasons: top, slowest: slow,
    });
  }
  const layers = [1, 2, 3].map((layer) => ({ layer, nodes: rows.filter((r) => r.layer === layer) })).filter((l) => l.nodes.length);

  /* workers */
  const workers: WorkerRow[] = Object.values(s.workers).filter((w) => (w.retiredAt ?? Infinity) >= startedAt && w.spawnedAt <= endedAt).map((w) => {
    const spans = w.spans.filter((sp) => sp[0] >= startedAt).map((sp) => [sp[0], sp[1] ?? endedAt, sp[2]] as [number, number, string]);
    const life = Math.max(1, Math.min(w.retiredAt ?? endedAt, endedAt) - Math.max(w.spawnedAt, startedAt));
    const busy = sum(spans.map((sp) => sp[1] - sp[0]));
    return { id: w.id, label: w.label, node: w.node, nodeName: nodeOf.get(w.node)?.name ?? w.node, done: spans.length, busyMs: busy, idleShare: 1 - busy / life, spawnedAt: w.spawnedAt, retiredAt: w.retiredAt, forked: w.forked, spans, items: [...new Set(spans.map((sp) => s.tokens[sp[2]]?.item ?? sp[2]))].slice(0, 30) };
  }).filter((w) => w.done || w.forked || w.retiredAt);

  /* items */
  const thumbs = (tid: string) => (s.tokens[tid]?.evidence ?? []).map((id) => s.evidence[id]).filter((e) => e && (e.kind === "image" || e.kind === "video")).slice(-3).map((e) => e!.poster ?? e!.card ?? e!.src ?? "");
  const tokenCost = (tid: string) => sum((s.tokens[tid]?.attempts ?? []).map((a) => s.attempts[a]?.usage.cost ?? 0));
  const row = (t: (typeof tokens)[number]): ItemRow => ({ token: t.id, item: t.item, title: t.title, reason: t.reason, thumbs: thumbs(t.id), node: t.finishedAtNode, ms: (t.finishedAt ?? endedAt) - t.createdAt, cost: tokenCost(t.id) });
  const items = {
    published: tokens.filter((t) => t.status === "published").map(row),
    manual: tokens.filter((t) => t.status === "manual").map(row),
    corrected: tokens.filter((t) => t.corrections > 0).map(row),
    merged: tokens.filter((t) => t.status === "merged").map(row),
    rejected: tokens.filter((t) => t.status === "rejected").map(row),
    parked: tokens.filter(t=>t.status==="parked").map(row),
  };
  const usage = { input: sum(attempts.map((a) => a.usage.input)), output: sum(attempts.map((a) => a.usage.output)), cost: sum(attempts.map((a) => a.usage.cost)) };
  const pub = Math.max(1, items.published.length);
  const totals = {
    ...s.totals, usage, created: tokens.length, published:items.published.length,manual:items.manual.length,merged:items.merged.length,rejected:items.rejected.length,parked:items.parked.length, failedAttempts:attempts.filter(a=>a.ok===false&&!a.cancelled).length,
    perPublishedMs: items.published.length ? median(items.published.map((r) => r.ms ?? 0)) : 0,
    perPublishedCost: usage.cost / pub, perPublishedTokens: (usage.input + usage.output) / pub,
  };

  const insights = mine({ ...f, state:s } as Factory, events, rows, workers, tokens, attempts, startedAt, endedAt);
  const suggestions = suggest(rows, insights, f);
  return { version:3, status:s.run.status, runId, title: start?.kind === "run.started" ? start.title : s.run.title, startedAt, endedAt, netMs, totals, layers, flows: [...flows.values()], workers, insights, suggestions, items,
    attempts: attempts.map(a=>({id:a.id,node:a.node,token:a.token,item:s.tokens[a.token]?.title || s.tokens[a.token]?.item || a.token,startedAt:a.startedAt,endedAt:a.endedAt,ms:a.ms ?? Math.max(0,endedAt-a.startedAt),queuedMs:a.queuedMs ?? 0,input:a.usage.input,output:a.usage.output,cost:a.usage.cost,ok:a.ok,cancelled:a.cancelled,summary:a.summary || a.error || "进行中",steps:a.steps.map(st=>({at:st.at,text:st.text}))})) };
}

/* ------------------------------------------------------------------ insight mining */

function mine(f: Factory, events: Stamped[], rows: NodeRow[], workers: WorkerRow[], tokens: FactoryState["tokens"][string][], attempts: FactoryState["attempts"][string][], t0: number, t1: number): Insight[] {
  const s = f.state;
  const out: Insight[] = [];
  const name = (k: string) => f.compiled.nodes.find((n) => n.key === k)?.name ?? k;
  const minutes = Math.max(1, Math.ceil((t1 - t0) / 60000));
  const bucket = (pred: (e: Stamped) => boolean) => { const b = new Array(Math.min(40, minutes)).fill(0); for (const e of events) if (pred(e)) b[Math.min(b.length - 1, Math.floor(((e.at - t0) / (t1 - t0 || 1)) * b.length))]++; return b; };

  // 1. Throughput curve.
  const pubs = events.filter((e) => e.kind === "token.finished" && e.status === "published");
  if (pubs.length) out.push({ id: "throughput", title: "实测吞吐", value: `${(pubs.length / ((t1 - t0) / 3600000)).toFixed(1)} 站/小时`, detail: `本轮发布 ${pubs.length} 条；每分钟发布数如右。Spec N2 的目标是 ≥ 120 站/小时（优化后），这里是实测值。`, spark: bucket((e) => e.kind === "token.finished" && e.status === "published"), tone: "info", score: 5 });

  // 2. Bottleneck drift: which station had the longest queue, minute by minute.
  const queueLen = new Map<string, number>();
  const lead: string[] = [];
  let next = t0 + 60000;
  for (const e of events) {
    while (e.at > next && next <= t1) { lead.push([...queueLen.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ""); next += 60000; }
    if (e.kind === "token.queued") queueLen.set(e.node, (queueLen.get(e.node) ?? 0) + 1);
    if (e.kind === "attempt.started") queueLen.set(e.node, Math.max(0, (queueLen.get(e.node) ?? 0) - 1));
  }
  const changes = lead.filter((k, i) => k && i > 0 && k !== lead[i - 1]);
  const leaders = [...new Set(lead.filter(Boolean))];
  if (leaders.length) out.push({ id: "drift", title: "瓶颈漂移", value: leaders.slice(0, 3).map(name).join(" → "), detail: `按分钟看“队列最长的工位”，本轮换了 ${changes.length} 次。瓶颈不是固定的：配比要跟着它走，而不是按初始估计一次定死。`, tone: changes.length > 2 ? "warn" : "info", node: leaders[0], score: 4 + changes.length * 0.3 });

  // 3. Balance efficiency: busy share spread among stations.
  const busy = workers.filter((w) => w.done).map((w) => 1 - w.idleShare);
  if (busy.length > 3) {
    const sorted = [...workers].filter((w) => w.done).sort((a, b) => a.idleShare - b.idleShare);
    const hi = sorted[0], lo = sorted[sorted.length - 1];
    out.push({ id: "balance", title: "工人忙闲差", value: `${pct(1 - hi.idleShare)} vs ${pct(1 - lo.idleShare)}`, detail: `最忙的 ${hi.label} 忙了 ${pct(1 - hi.idleShare)} 的时间，最闲的 ${lo.label} 只忙了 ${pct(1 - lo.idleShare)}。差距越小，配比越接近“一对三”的理想节拍。`, spark: sorted.map((w) => Math.round((1 - w.idleShare) * 100)), tone: hi.idleShare < 0.15 ? "warn" : "info", node: hi.node, score: 4.5 });
  }

  // 4. Waiting vs working.
  const waits = rows.filter((r) => r.processed >= 3).sort((a, b) => b.waitShare - a.waitShare);
  if (waits[0] && waits[0].waitShare > 0.3) out.push({ id: "wait", title: "排队比干活久", value: `${name(waits[0].key)} ${pct(waits[0].waitShare)}`, detail: `货在 ${name(waits[0].key)} 前面排队的时间占它在这里总时间的 ${pct(waits[0].waitShare)}。这是加人（或拆工位）最有回报的地方。`, spark: waits.slice(0, 8).map((r) => Math.round(r.waitShare * 100)), tone: "warn", node: waits[0].key, score: 5 + waits[0].waitShare * 3 });

  // 5. Wasted browser time on rejected pages.
  let rejectedPages = 0;
  const rejectBy = new Map<string, number>();
  for (const e of events) if (e.kind === "attempt.progress" && e.step?.tool === "reject") {
    rejectedPages++;
    const m = /拒收 (\S+)/.exec(e.text);
    if (m) { const p = m[1].replace(/：.*$/, "").replace(/\/[^/]+$/, "/*"); rejectBy.set(p, (rejectBy.get(p) ?? 0) + 1); }
  }
  const capture = rows.filter((r) => r.role === "capture");
  if (rejectedPages) {
    const top = [...rejectBy.entries()].sort((a, b) => b[1] - a[1])[0];
    const avgVisit = 9;
    out.push({ id: "rejects", title: "拍了又扔的页面", value: `${rejectedPages} 页 ≈ ${secs(rejectedPages * avgVisit * 1000)}`, detail: `浏览器打开后被规则拒收的页（空舞台、文档页、弹层…）。最常见：${top ? `${top[0]}（${top[1]} 次）` : "—"}。把它们挡在开页之前，浏览器时间就省下来了。`, tone: "warn", node: capture[0]?.key, score: 4 + Math.min(3, rejectedPages / 5) });
  }

  // 6. Model redo share.
  let checks = 0, redos = 0;
  for (const e of events) if (e.kind === "attempt.progress" && e.step?.tool === "check") { checks++; if (e.step.ok === false) redos++; }
  if (checks) out.push({ id: "redo", title: "模型重答率", value: pct(redos / checks), detail: `${checks} 次模型提交里 ${redos} 次没过程序检查、被要求重答。VisLexicon 单 agent 实跑时风格判定是 24%；高于它说明提示词或 schema 要改。`, tone: redos / checks > 0.24 ? "warn" : "good", score: 3.5 + (redos / checks) * 4 });

  // 7. Classifier agreement.
  const both = tokens.filter((t) => t.data.kind1 && t.data.kind2);
  if (both.length >= 2) {
    const agree = both.filter((t) => t.data.kindAgreed).length;
    out.push({ id: "agreement", title: "两个分类员的一致率", value: pct(agree / both.length), detail: `③ 和 ④ 独立判类，${both.length} 件里 ${agree} 件一致；不一致的 ${both.length - agree} 件走了仲裁。一致率是分类规则清晰度的直接读数。`, tone: agree / both.length >= 0.85 ? "good" : "warn", node: "curation/classify-review", score: 4 + (1 - agree / both.length) * 3 });
  }

  // 8. Reviewer return rates and first-pass yield after a return.
  const reviewers = rows.filter((r) => r.role === "review" && r.processed);
  const returnedTokens = tokens.filter((t) => Object.keys(t.rounds).length);
  if (reviewers.length) {
    const rr = reviewers.map((r) => ({ r, rate: r.returned / Math.max(1, r.processed) })).sort((a, b) => b.rate - a.rate);
    const fixedFirst = returnedTokens.filter((t) => Object.values(t.rounds).every((x) => x === 1) && t.status === "published").length;
    out.push({ id: "reviewers", title: "审查员退回率", value: rr.slice(0, 3).map((x) => `${x.r.name} ${pct(x.rate)}`).join(" · "), detail: `退回过的 ${returnedTokens.length} 件里，${fixedFirst} 件返工一次就过。退回率最高的审查员说明它前面的生产工位最需要改规则。`, spark: rr.map((x) => Math.round(x.rate * 100)), tone: rr[0].rate > 0.3 ? "warn" : "info", node: rr[0].r.key, score: 3.5 + rr[0].rate * 3 });
  }

  // 9. Source yield.
  const bySource = new Map<string, { n: number; pub: number }>();
  for (const t of tokens) { const k = t.source; const v = bySource.get(k) ?? bySource.set(k, { n: 0, pub: 0 }).get(k)!; v.n++; if (t.status === "published") v.pub++; }
  if (bySource.size) {
    const lines = [...bySource.entries()].map(([k, v]) => `${k === "manual" ? "手贴" : name(k)} ${v.pub}/${v.n}`);
    const cats = new Map<string, { n: number; pub: number }>();
    for (const t of tokens) { const k = t.category ?? "—"; const v = cats.get(k) ?? cats.set(k, { n: 0, pub: 0 }).get(k)!; v.n++; if (t.status === "published") v.pub++; }
    const bestCat = [...cats.entries()].filter(([, v]) => v.n >= 2).sort((a, b) => b[1].pub / b[1].n - a[1].pub / a[1].n)[0];
    out.push({ id: "yield", title: "来源转化率", value: lines.join(" · "), detail: `从候选到发布。${bestCat ? `按候选目录分类看，「${bestCat[0]}」转化最高（${bestCat[1].pub}/${bestCat[1].n}）。` : ""}下一轮可以优先从转化高的分类取货。`, tone: "info", score: 3 });
  }

  // 10. Dedupe / dead sites.
  const merged = tokens.filter((t) => t.status === "merged").length, dead = tokens.filter((t) => t.status === "rejected").length;
  if (merged + dead) out.push({ id: "dedupe", title: "进线前就该挡掉的", value: `${merged} 重复 · ${dead} 打不开`, detail: `${pct((merged + dead) / Math.max(1, tokens.length))} 的候选在 ①② 就出线了。候选库里死站的比例可以提前用 HEAD 请求批量清理。`, tone: (merged + dead) / Math.max(1, tokens.length) > 0.15 ? "warn" : "info", node: "curation/fetch", score: 3 + ((merged + dead) / Math.max(1, tokens.length)) * 4 });

  // 11. Fork payback.
  const forks = events.filter((e) => e.kind === "worker.forked");
  if (forks.length) {
    const e = forks[0] as Stamped & { kind: "worker.forked" };
    const before = attempts.filter((a) => a.node === e.node && a.startedAt < e.at).map((a) => a.queuedMs ?? 0);
    const after = attempts.filter((a) => a.node === e.node && a.startedAt >= e.at).map((a) => a.queuedMs ?? 0);
    out.push({ id: "fork", title: "fork 的回本", value: before.length && after.length ? `排队 ${secs(median(before))} → ${secs(median(after))}` : `${forks.length} 次 fork`, detail: `本轮自动 fork ${forks.length} 次、撤 ${events.filter((x) => x.kind === "worker.retired").length} 次。第一次是 ${name(e.node)}：fork 前后这一站的中位排队时间如左。`, tone: "good", node: e.node, score: 4.2 });
  }

  // 12. Cost per published entry and the most expensive items.
  const costByToken = tokens.map((t) => ({ t, c: t.attempts.reduce((acc, a) => acc + (s.attempts[a]?.usage.cost ?? 0), 0), tok: t.attempts.reduce((acc, a) => acc + (s.attempts[a]?.usage.input ?? 0) + (s.attempts[a]?.usage.output ?? 0), 0) })).sort((a, b) => b.c - a.c);
  if (costByToken.length && costByToken[0].c > 0) {
    const pubCost = costByToken.filter((x) => x.t.status === "published");
    const stationTok = rows.filter((r) => r.tokens).sort((a, b) => b.tokens - a.tokens);
    out.push({ id: "cost", title: "一条发布的模型成本", value: pubCost.length ? `$${(sum(pubCost.map((x) => x.c)) / pubCost.length).toFixed(4)} · ${Math.round(sum(pubCost.map((x) => x.tok)) / pubCost.length).toLocaleString()} tok` : "—", detail: `最贵的工位是 ${stationTok[0] ? `${stationTok[0].name}（${pct(stationTok[0].tokens / Math.max(1, sum(stationTok.map((r) => r.tokens))))} 的 token）` : "—"}；最贵的一件货是 ${costByToken[0].t.item}（$${costByToken[0].c.toFixed(4)}）。`, spark: stationTok.slice(0, 10).map((r) => r.tokens), tone: "info", token: costByToken[0].t.id, score: 3.8 });
  }

  // 13. Close-up difficulty: pages tried per proof.
  const proofs = attempts.filter((a) => a.node === "curation/proof" && a.ok);
  if (proofs.length) {
    const tried = proofs.map((a) => a.steps.filter((x) => x.text.startsWith("打开")).length);
    out.push({ id: "proof-pages", title: "特写平均试几页", value: `${(sum(tried) / tried.length).toFixed(1)} 页`, detail: `组件特写要试的页数决定了浏览器时间。Spec §7.4 的优化（先 HTTP 预检打分、只拍前 2 名）就是冲这个数字去的。`, spark: tried, tone: sum(tried) / tried.length > 3 ? "warn" : "good", node: "curation/proof", score: 3.6 });
  }

  // 14. Kinds and styles of this run.
  const kinds = new Map<string, number>();
  for (const t of tokens) if (t.data.kind) kinds.set(String(t.data.kind), (kinds.get(String(t.data.kind)) ?? 0) + 1);
  if (kinds.size) out.push({ id: "kinds", title: "这一轮收到了什么", value: [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ${n}`).join(" · "), detail: `分类分布。录屏路线触发 ${tokens.filter((t) => t.data.mode === "video").length} 次。`, tone: "info", score: 2.5 });

  return out.sort((a, b) => b.score - a.score).slice(0, 10);
}

function suggest(rows: NodeRow[], insights: Insight[], f: Factory): Suggestion[] {
  const out: Suggestion[] = [];
  const name = (k: string) => f.compiled.nodes.find((n) => n.key === k)?.name ?? k;
  const wait = insights.find((i) => i.id === "wait");
  if (wait?.node) {
    const n = f.compiled.nodes.find((x) => x.key === wait.node)!;
    out.push({ title: `给「${name(wait.node)}」把人数上限从 ${n.workers.max} 提到 ${n.workers.max + 1}`, why: wait.detail, prompt: `「${name(wait.node)}」排队时间占比太高（${wait.value}）。请起草补丁把 workers.max 提到 ${n.workers.max + 1}，并说明对浏览器 / 模型配额的影响。`, node: wait.node });
  }
  const rej = insights.find((i) => i.id === "rejects");
  if (rej) out.push({ title: "把最常被拒收的页型挡在开页之前", why: rej.detail, prompt: `本轮“拍了又扔”的页面有 ${rej.value}。请看特写 / 目录摄影里被拒收最多的路径，给出 preview-rules 的拒收前缀建议（先列证据，不要直接改）。`, node: rej.node });
  const redo = insights.find((i) => i.id === "redo" && i.tone === "warn");
  if (redo) out.push({ title: "降低模型重答率", why: redo.detail, prompt: `模型重答率 ${redo.value}。请找出重答最多的工位和最常见的检查失败原因，建议怎么改它的提示词或 schema。` });
  const ag = insights.find((i) => i.id === "agreement" && i.tone === "warn");
  if (ag) out.push({ title: "看看分类员为什么意见不一", why: ag.detail, prompt: "列出本轮 ③④ 分类不一致的货、各自的回答和引用，判断是规则表述问题还是页面信息不足。" });
  const dd = insights.find((i) => i.id === "dedupe" && i.tone === "warn");
  if (dd) out.push({ title: "先清理候选库里的死站", why: dd.detail, prompt: "候选库里打不开的站比例偏高。请估算全库死站数量，并起草一个只发 HEAD 请求的清理工位放在候选层（补丁草稿，待我确认）。" });
  const slow = [...rows].filter((r) => r.processed >= 3 && r.p90Ms > 2.5 * r.medianMs && r.medianMs > 2000).sort((a, b) => b.p90Ms / b.medianMs - a.p90Ms / a.medianMs)[0];
  if (slow) out.push({ title: `「${slow.name}」长尾很重`, why: `P90 ${secs(slow.p90Ms)} 是中位 ${secs(slow.medianMs)} 的 ${(slow.p90Ms / slow.medianMs).toFixed(1)} 倍；最慢的是 ${slow.slowest.map((x) => x.item).join("、")}。`, prompt: `「${slow.name}」P90 远高于中位数。看看最慢的几件（${slow.slowest.map((x) => x.item).join("、")}）慢在哪一步，要不要加超时或拆工位。`, node: slow.key });
  return out.slice(0, 5);
}

const endingRuns=new WeakMap<Factory,Promise<RunReport|null>>();
export async function endRun(f:Factory):Promise<RunReport|null> {
  const pending=endingRuns.get(f);if(pending)return pending;
  f.runtime.ending=true;
  const task=finishRun(f).finally(()=>{f.runtime.ending=false;endingRuns.delete(f);});endingRuns.set(f,task);return task;
}
async function finishRun(f: Factory) {
  const runId = f.runtime.end() ?? (f.state.run.status === "ended" ? f.state.run.id : null);
  if (!runId) return null;
  await f.runtime.settle();
  const existing=readReport(runId);if(existing)return existing;
  const report = buildReport(f, runId);
  const dir = path.join(VAR, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
  f.journal.append({ kind: "report.ready", runId });
  return report;
}

export function readReport(runId: string): RunReport | null {
  try { const report = JSON.parse(fs.readFileSync(path.join(VAR, "runs", runId, "report.json"), "utf8")); return report.version === 3 ? report : null; } catch { return null; }
}
