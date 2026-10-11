// Read-only, run-scoped acceptance evidence. Never infer success from a draft's APPROVED flag.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { compile } from "../server/spec/compile.ts";
import { pack } from "../packs/vislexicon/pack.ts";

export const SITES = [
  { id: "magic-ui", host: "magicui.design" },
  { id: "uiverse", host: "uiverse.io" },
  { id: "laws-of-ux", host: "lawsofux.com" },
  { id: "carbon", host: "carbondesignsystem.com" },
  { id: "lucide", host: "lucide.dev" },
];
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const sum = xs => xs.reduce((a, b) => a + b, 0);
const hostOf = value => { try { return new URL(String(value)).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const readRecord = file => {
  if (!fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(file);
  return { file: path.resolve(file), sha256: sha(bytes), value: JSON.parse(bytes.toString("utf8")) };
};

/** JSON Pointer paths retain array order and every field, including runtime/release metadata. */
export function fieldDiff(baseline, current, pointer = "") {
  if (Object.is(baseline, current)) return [];
  if (baseline && current && typeof baseline === "object" && typeof current === "object" && Array.isArray(baseline) === Array.isArray(current)) {
    const keys = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort((a, b) => Array.isArray(baseline) ? Number(a) - Number(b) : a.localeCompare(b));
    return keys.flatMap(key => {
      const at = `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (!Object.hasOwn(baseline, key)) return [{ path: at, operation: "added", current: current[key] }];
      if (!Object.hasOwn(current, key)) return [{ path: at, operation: "removed", baseline: baseline[key] }];
      return fieldDiff(baseline[key], current[key], at);
    });
  }
  return [{ path: pointer || "/", operation: "changed", baseline, current }];
}

function readJournal(project, runId) {
  const file = path.join(project, "journal.db");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("BEGIN");
    const runs = db.prepare("SELECT run, MIN(at) AS firstAt, MAX(at) AS lastAt, COUNT(*) AS events FROM events WHERE run != '' GROUP BY run ORDER BY firstAt").all();
    const selected = runs.find(r => r.run === runId);
    if (!selected) throw new Error(`Run ${runId} not found. Available runs: ${runs.map(r => r.run).join(", ")}`);
    const cutoff = Number(db.prepare("SELECT MAX(seq) AS seq FROM events WHERE run = ?").get(runId).seq);
    const events = db.prepare("SELECT seq, at, run, body FROM events WHERE seq <= ? ORDER BY seq").all(cutoff).map(row => ({ ...JSON.parse(row.body), seq: Number(row.seq), at: Number(row.at), run: row.run }));
    db.exec("COMMIT");
    return { file, cutoff, events, runs };
  } finally { db.close(); }
}

function baselineFor(baselineDir, site) {
  const expected = path.join(baselineDir, `${site.id}.json`);
  const primary = readRecord(expected);
  if (primary) return { status: "current-published-baseline", expectedFile: expected, primary, alternatives: [] };
  // These are documented local authoring artifacts, not substitutes for the current release.
  const root = path.resolve(baselineDir, "../../../..");
  const alternatives = [site.id, `${site.id}-dev`].map(id => readRecord(path.join(root, "content-samples", "approved-v3", `${id}.json`))).filter(record => record && hostOf(record.value.official?.finalUrl ?? record.value.official?.inputUrl) === site.host).map(record => ({ ...record, status: "local-approved-sample-not-current-published" }));
  return { status: "missing-current-published-baseline", expectedFile: expected, primary: null, alternatives };
}

function pauseIntervals(events, until) {
  const ranges = []; let paused;
  for (const e of events) {
    if (e.kind === "run.paused" && paused === undefined) paused = e.at;
    if ((e.kind === "run.resumed" || e.kind === "run.ended") && paused !== undefined) { ranges.push([paused, e.at]); paused = undefined; }
  }
  if (paused !== undefined) ranges.push([paused, until]);
  return ranges;
}

export function compareRun({ project, runId, baselineDir, now = Date.now() }) {
  project = path.resolve(project); baselineDir = path.resolve(baselineDir);
  const journal = readJournal(project, runId);
  const events = journal.events.filter(e => e.run === runId);
  const runStart = events.find(e => e.kind === "run.started");
  const runEnd = events.findLast(e => e.kind === "run.ended");
  const snapshotAt = runEnd?.at ?? Math.max(now, events.at(-1)?.at ?? now);
  const pauses = pauseIntervals(events, snapshotAt);
  const nodes = new Map(compile([pack]).nodes.map(node => [node.key, node]));
  const tokens = new Map();
  for (const e of journal.events) {
    if (e.kind === "token.created") tokens.set(e.token, { id: e.token, item: e.item, url: e.url, title: e.title, createdAt: e.at, createdInRun: e.run, data: {}, status: "active" });
    const token = tokens.get(e.token);
    if (!token) continue;
    if (e.kind === "token.queued") Object.assign(token, { status: "active", finishedAt: null, finishRun: null, finishNode: null, reason: null });
    if (e.kind === "token.data") { Object.assign(token.data, e.patch); if (Object.hasOwn(e.patch, "draftV3")) token.draftEvent = { run: e.run, seq: e.seq, at: e.at }; }
    if (e.kind === "token.finished") Object.assign(token, { status: e.status, finishedAt: e.at, finishRun: e.run, finishNode: e.node, reason: e.reason });
  }
  // Only starts in this run are calls in this run. Inherited checkpoint attempts and
  // late finish events for older calls never enter the denominator.
  const starts = events.filter(e => e.kind === "attempt.started");
  const finishes = new Map(events.filter(e => e.kind === "attempt.finished").map(e => [e.attempt, e]));
  const attempts = starts.map(start => {
    const finish = finishes.get(start.attempt);
    const modelCalls = finish?.metrics?.modelTimeReported !== false && Number.isFinite(finish?.metrics?.time?.modelCalls) ? finish.metrics.time.modelCalls : null;
    return { id: start.attempt, token: start.token, node: start.node, kind: nodes.get(start.node)?.kind ?? "unknown", startedAt: start.at, endedAt: finish?.at ?? null, ms: finish?.ms ?? null, queuedMs: finish?.queuedMs ?? null, ok: finish?.ok ?? null, cancelled: finish?.cancelled ?? false, summary: finish?.summary ?? "", error: finish?.error ?? null, modelCalls, usage: finish?.metrics?.usageReported === false ? null : finish?.usage ?? null, metrics: finish?.metrics ?? null };
  });
  const activityKinds = new Set(["token.created", "token.queued", "attempt.started", "token.returned", "consult.opened", "token.finished"]);
  const activity = events.filter(e => activityKinds.has(e.kind) && e.token);
  const activeIds = new Set(activity.map(e => e.token));
  const publishedDir = path.join(project, "published");
  const inventory = fs.existsSync(publishedDir) ? fs.readdirSync(publishedDir).filter(file => file.endsWith(".json")).map(file => readRecord(path.join(publishedDir, file))) : [];
  const sites = SITES.map(site => {
    const matching = [...tokens.values()].filter(token => activeIds.has(token.id) && (hostOf(token.url) === site.host || hostOf(token.data.canonical) === site.host || token.item === site.host));
    const ids = new Set(matching.map(token => token.id));
    const mine = attempts.filter(attempt => ids.has(attempt.token));
    const timeline = activity.filter(e => ids.has(e.token));
    const latestId = timeline.at(-1)?.token;
    const latest = tokens.get(latestId);
    const startedAt = timeline[0]?.at ?? null;
    const endedAt = latest && latest.finishRun === runId ? latest.finishedAt : startedAt === null ? null : snapshotAt;
    const pausedMs = startedAt === null || endedAt === null ? 0 : sum(pauses.map(([start, end]) => Math.max(0, Math.min(end, endedAt) - Math.max(start, startedAt))));
    const agent = mine.filter(attempt => attempt.kind === "agent"), review = mine.filter(attempt => attempt.kind === "review");
    const missingModelMetrics = [...agent, ...review].filter(attempt => attempt.modelCalls === null).map(attempt => attempt.id);
    const recorded = mine.filter(attempt => attempt.modelCalls !== null);
    const returns = events.filter(e => e.kind === "token.returned" && ids.has(e.token)).map(e => ({ seq: e.seq, at: e.at, token: e.token, from: e.from, to: e.to, round: e.round, byHuman: e.byHuman ?? false, reason: e.reason }));
    const consultEvents = events.filter(e => e.kind.startsWith("consult.") && ids.has(e.token));
    const consultations = consultEvents.filter(e => e.kind === "consult.opened").map(e => ({ id: e.consult, token: e.token, reviewer: e.reviewer, owner: e.owner, fields: e.fields, problem: e.problem, round: e.round, openedAt: e.at, replies: consultEvents.filter(r => r.kind === "consult.replied" && r.consult === e.consult).map(r => ({ at: r.at, reply: r.reply, ok: r.ok })), outcome: consultEvents.findLast(r => r.kind === "consult.closed" && r.consult === e.consult)?.outcome ?? "open" }));
    const pairs = Object.values(consultations.reduce((map, consult) => {
      const key = `${consult.reviewer}>${consult.owner}`;
      const row = map[key] ??= { reviewer: consult.reviewer, owner: consult.owner, requests: 0, maxRound: 0 };
      row.requests++; row.maxRound = Math.max(row.maxRound, consult.round); return map;
    }, {}));
    const dispositions = events.filter(e => e.kind === "candidate.disposition" && ids.has(e.candidate.token)).map(e => ({ seq: e.seq, at: e.at, ...e.candidate }));
    const baseline = baselineFor(baselineDir, site);
    const receipt = latest?.status === "published" && latest.finishRun === runId;
    const published = receipt ? inventory.find(record => record.value.h2?.token === latest.id && latest.data.digest && record.value.h2?.digest === latest.data.digest) : null;
    let artifact = null;
    if (published) artifact = { kind: "published-this-run", file: published.file, sha256: published.sha256, token: latest.id, publicationVerified: true, value: published.value };
    else if (latest?.data.draftV3) {
      const value = latest.data.draftV3;
      const assembledHere = mine.some(attempt => attempt.token === latest.id && attempt.node === "curation/assemble" && attempt.ok) && (!value.h2?.token || value.h2.token === latest.id);
      artifact = { kind: assembledHere ? "assembled-draft-not-approved" : "inherited-draft-not-approved", file: null, sha256: sha(JSON.stringify(value)), token: latest.id, sourceToken: value.h2?.token ?? null, sourceEvent: latest.draftEvent, publicationVerified: false, validationProblems: latest.data.draftProblems ?? null, value };
    }
    const differences = baseline.primary && artifact ? fieldDiff(baseline.primary.value, artifact.value) : null;
    const alternativeComparisons = baseline.alternatives.map(record => ({ file: record.file, sha256: record.sha256, status: record.status, entryId: record.value.entryId, differences: artifact ? fieldDiff(record.value, artifact.value) : null }));
    const qualityWarnings = [];
    if (latest?.data.kind === "component-source" && latest.data.mode !== "video") {
      const count = latest.data.shots?.breadth?.previews;
      if (!Number.isInteger(count) || count < 4) qualityWarnings.push(`组件源 breadth 首屏预览计数${Number.isInteger(count) ? `为 ${count}，不足 4` : "缺失"}；继承的 shotReview=pass 不能证明满足当前门禁。`);
    }
    if (artifact?.value.style?.subjectVisible === false) qualityWarnings.push("产物 style.subjectVisible=false，主体不可见，不能视为截图质量通过。");
    return {
      id: site.id, host: site.host, observedInRun: matching.length > 0, status: latest?.status ?? "not-in-run", latestToken: latestId ?? null,
      reason: latest?.reason ?? null, publicationReceiptInRun: Boolean(receipt), publicationVerified: Boolean(published),
      timing: { startedAt, endedAt, ongoing: Boolean(latest && latest.finishRun !== runId), wallMs: startedAt === null ? null : Math.max(0, endedAt - startedAt), pausedMs, netWallMs: startedAt === null ? null : Math.max(0, endedAt - startedAt - pausedMs), attemptWorkMs: sum(mine.map(a => a.ms ?? 0)), queueMs: sum(mine.map(a => a.queuedMs ?? 0)) },
      counts: { attempts: mine.length, agentAttempts: agent.length, reviewAttempts: review.length, agentAndReviewAttempts: agent.length + review.length, finishedAttempts: mine.filter(a => a.endedAt !== null).length, failedAttempts: mine.filter(a => a.ok === false && !a.cancelled).length, cancelledAttempts: mine.filter(a => a.cancelled).length, modelCallsRecorded: recorded.length ? sum(recorded.map(a => a.modelCalls)) : null, modelMetricsCoverage: { withRecordedCount: recorded.length, attempts: mine.length, missingAgentReviewAttemptIds: missingModelMetrics }, modelCallsComplete: missingModelMetrics.length === 0 && mine.every(a => a.endedAt !== null), returned: returns.length, consultOpened: consultations.length },
      tokens: matching.map(token => ({ id: token.id, createdInRun: token.createdInRun, retryOf: token.data.retryOf ?? null, checkpointDone: token.data.checkpointDone ?? [], status: token.status, finishNode: token.finishNode ?? null, reason: token.reason ?? null })),
      attempts: mine, returns, consultations, consultPairs: pairs, dispositions,
      baseline: { status: baseline.status, expectedFile: baseline.expectedFile, file: baseline.primary?.file ?? null, sha256: baseline.primary?.sha256 ?? null },
      artifact, qualityWarnings, comparison: { status: !baseline.primary ? "not-comparable-current-baseline-missing" : !artifact ? "no-artifact-yet" : differences.length ? "differences-for-review" : "identical-fields", differenceCount: differences?.length ?? null, differences, alternativeComparisons },
    };
  });
  return {
    schemaVersion: 1, generatedAt: new Date(now).toISOString(), project, baselineDir, runId, title: runStart?.title ?? "", runStatus: runEnd ? "ended" : events.findLast(e => ["run.started", "run.paused", "run.resumed"].includes(e.kind))?.kind === "run.paused" ? "paused" : "running",
    journal: { file: journal.file, cutoffSeq: journal.cutoff, selectedEvents: events.length, otherRunIdsExcluded: journal.runs.filter(r => r.run !== runId).map(r => r.run) },
    coverage: { targetSites: SITES.length, observedSites: sites.filter(s => s.observedInRun).length, verifiedPublications: sites.filter(s => s.publicationVerified).length, currentPublishedBaselines: sites.filter(s => s.baseline.status === "current-published-baseline").length, acceptance: "not-certified-by-comparison-script" },
    methodology: ["Only attempt.started events in the explicit runId count as new attempts; checkpoint work and historical calls are excluded.", "Agent/review attempt counts and recorded metrics.time.modelCalls are separate. Missing metrics are unknown, never inferred as one call.", "Site elapsed time is current-run first activity to its latest terminal event or the snapshot, with pause overlap also reported. Attempt work time is a sum and can overlap.", "Published output requires a current-run publication receipt and a file whose h2.token and digest match that token's journal data. APPROVED on an assembled or inherited draft does not prove publication.", "Every differing JSON field is retained. Arrays are compared by index; metadata, paths and timestamps are not silently normalized.", "A missing current baseline remains not comparable. Local approved samples are separately labelled historical references."],
    sites,
  };
}

const cell = value => String(value ?? "—").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
export function renderComparison(report, jsonFile) {
  const lines = [`# Easy Workflow 策展对照：${report.runId}`, "", `项目：${report.project}`, "", `轮次：${report.title} · ${report.runStatus}。日志截点 seq ${report.journal.cutoffSeq}。完整递归差异：[JSON](${path.basename(jsonFile)})。`, "", `五站覆盖 ${report.coverage.observedSites}/5；本轮已核对发布文件 ${report.coverage.verifiedPublications}/5；当前发布基线 ${report.coverage.currentPublishedBaselines}/5。此报告不自动认定验收通过。`, "", "| 站点 | 本轮状态 | 耗时/净耗时(s) | Agent/Review attempts | 已记录模型调用 | 退回/直接沟通 | 产物 | 基线/差异 |", "|---|---|---:|---:|---:|---:|---|---|"];
  for (const site of report.sites) {
    const timing = site.timing.wallMs === null ? "—" : `${(site.timing.wallMs / 1000).toFixed(1)} / ${(site.timing.netWallMs / 1000).toFixed(1)}${site.timing.ongoing ? "（进行中）" : ""}`;
    lines.push(`| ${site.id} | ${cell(site.status)} | ${timing} | ${site.counts.agentAttempts}/${site.counts.reviewAttempts} | ${site.counts.modelCallsRecorded ?? "未知"}${site.counts.modelCallsComplete ? "" : "（不完整）"} | ${site.counts.returned}/${site.counts.consultOpened} | ${site.artifact?.kind ?? "尚无产物"} | ${site.baseline.file ? `${site.comparison.differenceCount ?? "—"} 处` : "当前基线缺失"} |`);
  }
  for (const site of report.sites) {
    lines.push("", `## ${site.id}`, "", `当前结果：${site.status}；${site.reason ?? "尚无终止原因"}。`, "", `基线：${site.baseline.file ?? `缺失 ${site.baseline.expectedFile}`}。`, "", `产物：${site.artifact?.file ?? site.artifact?.kind ?? "尚未组装"}；发布文件核验：${site.publicationVerified ? "已核对" : "未通过/尚无发布产物"}。`);
    if (site.tokens.some(token => token.retryOf)) lines.push("", `恢复链：${site.tokens.filter(token => token.retryOf).map(token => `${token.retryOf} → ${token.id}`).join("；")}。继承工位不计入本轮 attempts。`);
    if (site.consultPairs.length) lines.push("", `审核往来：${site.consultPairs.map(pair => `${pair.reviewer} → ${pair.owner}：${pair.requests} 次，本轮记录的最大 round ${pair.maxRound}`).join("；")}。`);
    if (site.dispositions.length) lines.push("", ...site.dispositions.map(disposition => `- 候选处置 ${disposition.disposition}：${disposition.failure?.tag ?? "—"}；${disposition.failure?.message ?? ""}`));
    if (site.qualityWarnings.length) lines.push("", ...site.qualityWarnings.map(warning => `- 质量验收未证实：${warning}`));
    const groups = {};
    for (const difference of site.comparison.differences ?? []) { const group = difference.path.split("/")[1] || "/"; groups[group] = (groups[group] ?? 0) + 1; }
    if (Object.keys(groups).length) lines.push("", `逐字段差异（完整值见 JSON）：${Object.entries(groups).map(([field, count]) => `${field} ${count}`).join("；")}。`);
    for (const alternate of site.comparison.alternativeComparisons) lines.push("", `补充参照：${alternate.file}（${alternate.status}），${alternate.differences?.length ?? "尚无产物可比较"} 处差异；不能当作当前发布基线。`);
  }
  lines.push("", "## 统计口径", "", ...report.methodology.map(rule => `- ${rule}`), "", `排除的其他轮次：${report.journal.otherRunIdsExcluded.join("、") || "无"}。`, "");
  return lines.join("\n");
}

function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = ({ "--project": "project", "--runId": "runId", "--run-id": "runId", "--baseline": "baselineDir", "--baseline-dir": "baselineDir", "--output": "output" })[args[i]];
    if (!key || !args[i + 1]) throw new Error("Usage: node scripts/curation-compare.mjs --project PROJECT --runId RUN_ID --baseline SITE_JSON_DIR --output REPORT.json");
    options[key] = args[i + 1];
  }
  for (const key of ["project", "runId", "baselineDir", "output"]) if (!options[key]) throw new Error(`Missing required option ${key}`);
  const report = compareRun(options);
  const base = path.resolve(options.output).replace(/\.(json|md)$/i, "");
  fs.mkdirSync(path.dirname(base), { recursive: true });
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(`${base}.md`, renderComparison(report, `${base}.json`));
  console.log(JSON.stringify({ json: `${base}.json`, markdown: `${base}.md`, runId: report.runId, coverage: report.coverage, sites: report.sites.map(site => ({ id: site.id, status: site.status, artifact: site.artifact?.kind ?? null, attempts: site.counts.agentAndReviewAttempts, modelCallsRecorded: site.counts.modelCallsRecorded, differences: site.comparison.differenceCount })) }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
