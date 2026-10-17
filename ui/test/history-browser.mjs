// Synthetic, isolated 35k+ event fixture through the real history/report/replay UI.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { compile } from '../../server/spec/compile.ts';
import { station, line } from '../../server/spec/dsl.ts';
import { layoutFactory } from '../../shared/layout.ts';
import { apply, initialState } from '../../shared/project.ts';

const startedAt = Date.now() - 60000, run = 'run-history-large', events = [];
const stations = Array.from({ length: 20 }, (_, index) => station({ id: `step-${index}`, name: `程序 ${index + 1}`, role: 'process', kind: 'program', resource: 'none' }));
const factory = compile([{ id: 'fixture', name: '历史验收', version: '1', blurb: '', lines: [line({ id: 'fixture', name: '真实界面隔离验收', layer: 3, priority: 'mid', wired: true, blurb: '', stations, edges: [] })], channels: [], links: [], conditions: {}, resources: { browser: 0, model: 0, http: 0, cpu: 0 }, order: [], collapsed: [], hints: {} }]);
const state = initialState(factory);
const emit = (event, at = startedAt) => { const stamped = { ...event, seq: events.length + 1, run, at }; events.push(stamped); apply(state, stamped); };
emit({ kind: 'run.started', runId: run, title: '35000+ 事件历史验收' });
for (let index = 0; index < 600; index++) {
  const token = `token-${index}`, attempt = `attempt-${index}`, node = `fixture/step-${index % 20}`, start = startedAt + index * 10;
  emit({ kind: 'token.created', token, line: 'fixture', item: token, url: '', source: 'fixture' }, start);
  emit({ kind: 'token.queued', token, node }, start);
  emit({ kind: 'attempt.started', token, node, attempt, worker: `worker-${index % 20}`, input: token }, start);
  for (let activity = 0; activity < 27; activity++) {
    const span = { id: `${attempt}:tool-${activity}`, kind: 'tool', source: 'tool-executor', startedAt: start + activity * 10, toolName: 'fixture-calculation', operation: `Step ${activity}` };
    emit({ kind: 'attempt.activity', attempt, activity: { ...span, status: 'running' } }, span.startedAt);
    emit({ kind: 'attempt.activity', attempt, activity: { ...span, endedAt: span.startedAt + 7, status: 'completed' } }, span.startedAt + 7);
  }
  emit({ kind: 'attempt.finished', attempt, ok: true, summary: '输入已处理', ms: 270, queuedMs: 0 }, start + 270);
  emit({ kind: 'token.finished', token, node, status: 'published', reason: 'Fixture result' }, start + 271);
}
emit({ kind: 'run.ended', runId: run, manual: true }, startedAt + 6500);
const nodes = factory.nodes.map(node => ({ ...node, key: node.key, stockStart: 0, stock: 0, plus: state.nodes[node.key].plus, sent: 0, merged: 0, rejected: 0, failed: 0, returned: 0, inRun: 30, processed: 30, medianMs: 270, p90Ms: 270, waitShare: 0, tokens: 0, cost: 0, timeShare: 0, workers: 1, forks: 0, retires: 0, topReasons: [], slowest: [] }));
const syntheticReport = { version: 3, status: 'ended', runId: run, title: '35000+ 事件历史验收', startedAt, endedAt: startedAt + 6500, netMs: 6500,
  totals: { ...state.totals, created: 600, parked: 0, failedAttempts: 0, perPublishedMs: 270, perPublishedCost: 0, perPublishedTokens: 0 },
  layers: [{ layer: 3, nodes }], flows: [], workers: [], insights: [], suggestions: [],
  attempts: Object.values(state.attempts).map(attempt => ({ ...attempt, item: attempt.token, input: 0, output: 0, cost: 0, ms: attempt.ms ?? 0, queuedMs: 0, summary: attempt.summary ?? '' })),
  items: { published: [], manual: [], corrected: [], merged: [], rejected: [], parked: [] } };
const report = process.env.HISTORY_REPORT_FILE ? JSON.parse(await fs.readFile(process.env.HISTORY_REPORT_FILE, 'utf8')) : syntheticReport;
assert.ok(events.length > 35000);
const vite = await createServer({ configFile: path.resolve('ui/vite.config.ts'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await vite.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const out = path.resolve('var/verification/history-ui'); await fs.mkdir(out, { recursive: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('pf.view', JSON.stringify('runs')); localStorage.setItem('pf.chatOpen', 'false');
    window.EventSource = class { constructor() { queueMicrotask(() => this.onopen?.({})); } addEventListener() {} close() {} };
    window.historyLongTasks = [];
    new PerformanceObserver(entries => window.historyLongTasks.push(...entries.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask', buffered: true });
  });
  let reportRequests = 0, reportMode = 'normal', releaseReport, journalRequests = 0, releaseJournal;
  const failures = [];
  page.on('requestfailed', request => { if (request.url().includes('/api/report/') || request.url().includes('/api/journal')) failures.push(request.url()); });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/factory') return route.fulfill({ json: { factory, layout: { designVersion: 6 }, defaultLayout: layoutFactory(factory.nodes, factory.edges, factory.ui.order, {}, []), settings: {}, model: 'fixture', keyPresent: false } });
    if (url.pathname === '/api/state') return route.fulfill({ json: initialState(factory) });
    if (url.pathname === '/api/runs') return route.fulfill({ json: [{ run, first: startedAt, last: startedAt + 6500, events: events.length, report: true }] });
    if (url.pathname.startsWith('/api/report/')) {
      reportRequests++;
      if (reportMode === 'hold') await new Promise(resolve => { releaseReport = resolve; });
      if (reportMode === 'error') return route.fulfill({ status: 503, json: { error: 'fixture unavailable' } });
      return route.fulfill({ json: report }).catch(() => {});
    }
    if (url.pathname === '/api/journal') {
      journalRequests++;
      if (process.env.HISTORY_INTERACTIONS) await new Promise(resolve => { releaseJournal = resolve; });
      if (!url.searchParams.has('limit')) return route.fulfill({ contentType: 'application/x-ndjson', body: events.map(event => JSON.stringify(event)).join('\n') });
      const since = Number(url.searchParams.get('since') ?? 0), through = Number(url.searchParams.get('through') ?? events.length), limit = Number(url.searchParams.get('limit'));
      const selected = events.filter(event => event.seq > since && event.seq <= through).slice(0, limit), nextSeq = selected.at(-1)?.seq ?? since;
      return route.fulfill({ json: { events: selected, nextSeq, through, done: nextSeq >= through } }).catch(() => {});
    }
    return route.fulfill({ json: { tabs: [], current: null, ok: true } });
  });
  const start = performance.now(); await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
  await page.locator('.dashboard-host .dash-head h1').waitFor({ timeout: 60000 });
  const loadedMs = performance.now() - start;
  await page.screenshot({ path: path.join(out, 'large-report.png') });
  const longTasks = await page.evaluate(() => window.historyLongTasks);
  const checks = [];
  if (process.env.HISTORY_INTERACTIONS) {
    await page.getByRole('button', { name: '过程回放', exact: true }).click();
    await page.getByRole('button', { name: '取消加载回放' }).click();
    releaseJournal?.();
    await page.getByRole('button', { name: '过程回放', exact: true }).waitFor();
    assert.ok(journalRequests <= 1); checks.push('replay loading is cancellable before any projection is changed');

    reportMode = 'hold';
    await page.locator('[data-tip^="画布 · 流水线"]').click();
    await page.locator('[data-tip="运行记录与回放"]').click();
    await page.getByRole('button', { name: '取消加载', exact: true }).waitFor();
    const count = reportRequests;
    await page.getByRole('button', { name: '取消加载', exact: true }).click();
    releaseReport?.();
    await page.getByRole('button', { name: '重新读取', exact: true }).waitFor();
    assert.equal(reportRequests, count); checks.push('report cancellation exits loading and exposes retry');

    reportMode = 'error';
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '503' }).waitFor();
    checks.push('HTTP failure is visible and does not become endless loading');

    reportMode = 'hold';
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await page.getByRole('button', { name: '取消加载', exact: true }).waitFor();
    const navigation = performance.now();
    await page.locator('[data-tip^="画布 · 流水线"]').click();
    await page.locator('.ws-layer.is-on').waitFor();
    assert.ok(performance.now() - navigation < 1000, 'rail navigation remains available during a pending report');
    releaseReport?.(); checks.push('leaving history aborts its fetch and keeps the canvas usable');
    assert.ok(failures.length >= 2, 'cancel and unmount must abort actual browser requests');
  }
  const result = { fixture: process.env.HISTORY_REPORT_FILE ? 'actual-report-copy' : 'synthetic', eventCount: events.length, attemptCount: report.attempts.length, intervalCount: report.attempts.reduce((sum, attempt) => sum + (attempt.metrics?.activity?.spans.length ?? 0), 0), loadedMs, reportRequests, checks, longTasks, maxLongTaskMs: Math.max(0, ...longTasks.map(task => task.duration)), errors };
  await fs.writeFile(path.join(out, `${process.env.HISTORY_REPORT_FILE ? 'actual-' : ''}${process.env.HISTORY_BASELINE ? 'baseline' : 'result'}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(errors, []);
  if (!process.env.HISTORY_BASELINE) assert.ok(result.maxLongTaskMs < 1000, `history blocks for ${result.maxLongTaskMs}ms`);
} finally { await browser.close(); await vite.close(); }
