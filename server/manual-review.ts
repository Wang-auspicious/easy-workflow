import type {Factory} from './factory.ts';
import {manualOwner, manualQueue, tokenWorkKey, type TokenState} from '../shared/project.ts';
import {ControlError} from './errors.ts';
import {buildV3} from '../packs/vislexicon/tools.ts';
import {loadTaxonomy, validateV3} from '../packs/vislexicon/v3.ts';
import {videoPreview} from '../packs/vislexicon/preview.ts';

const text = (value: unknown, max = 1200) => typeof value === 'string' ? value.slice(0, max) : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const reasonOf = (token: TokenState) => text(token.reason || token.data.manualReason);

function successorOf(factory: Factory, token: TokenState) {
  const key = tokenWorkKey(token);
  const newest = Object.values(factory.state.tokens).filter(other => other.id !== token.id && tokenWorkKey(other) === key && other.createdAt > token.createdAt).sort((a, b) => b.createdAt - a.createdAt)[0];
  const seen = new Set([token.id]);
  let current = token;
  while (typeof current.data.retriedBy === 'string') {
    const next = factory.state.tokens[current.data.retriedBy];
    if (!next || seen.has(next.id) || tokenWorkKey(next) !== key) break;
    seen.add(next.id); current = next;
  }
  if (current.id === token.id) return newest;
  return newest && newest.createdAt > current.createdAt ? newest : current;
}

function recommendation(token: TokenState) {
  const reason = reasonOf(token);
  if (manualOwner(token) === 'human') return {category: 'attention', owner: 'human', station: null, action: '核对当前问题对应的用户选择或真实登录/验证页面，保留具体接管入口'};
  if (token.status === 'parked' && /curation\/(?:identity|breadth|proof)$/.test(token.finishedAtNode ?? '')) return {category: 'capture', owner: 'agent', station: token.finishedAtNode!, action: '以 recentAttempts.steps 中当前执行拒收为准，旧 shotRepairs 只是此前要求；修复当前具体原因后从该工位恢复'};
  if (!['candidates', 'curation'].includes(token.line)) return {category: 'unknown', owner: 'agent', station: null, action: '按此线路的真实节点契约检查，不套用策展线工位'};
  if (/没有 pages\[\]|没有 role=identity|结构校验/u.test(reason)) return {category: 'structure', owner: 'agent', station: 'curation/assemble', action: '先查看 rebuild；可重建时复用原证据，从组装重跑终审与发布闸门'};
  const capture = ([[/目录摄影|breadth/u, 'breadth'], [/首屏摄影|identity/u, 'identity'], [/特写|proof/u, 'proof']] as const)
    .map(([pattern, station]) => ({station, index: reason.search(pattern)})).filter(match => match.index >= 0).sort((a, b) => a.index - b.index)[0];
  if (capture) return {category: 'capture', owner: 'agent', station: `curation/${capture.station}`, action: '按具体拒收原因改变取景、交互或选页；复用其他已通过证据，重跑受影响的审查'};
  if (/许可|facets\.access|facts\.|license|定价/iu.test(reason)) return {category: 'facts', owner: 'agent', station: 'curation/facts', action: '核对已保存事实和派生标签；先看 rebuild 是否已修复旧映射，否则重跑事实与独立审查'};
  return {category: 'unknown', owner: 'agent', station: null, action: '检查完整原因与最近失败；只有当前证据证明需要人类决定时才保留人工'};
}

/** Bounded, source-preserving triage. No model, mutation, approval or invented URLs. */
export async function manualReview(factory: Factory, options: {token?: string; tokens?: string[]; detail?: boolean; waitMs?: number; offset?: number; limit?: number} = {}) {
  if (options.tokens) {
    if (options.token) throw new ControlError(400, 'ambiguous_selection', 'token 与 tokens 不能同时传入');
    const ids = [...new Set(options.tokens)];
    const selected = () => ids.map(id => factory.state.tokens[id]);
    if (selected().some(token => !token)) throw new ControlError(404, 'token_not_found', '清单中有不存在的任务');
    if (options.waitMs && selected().some(token => token.status === 'active')) {
      await new Promise<void>(resolve => {
        const finish = () => {clearTimeout(timer); unsubscribe(); resolve();};
        const unsubscribe = factory.journal.subscribe(event => {if (event.kind === 'token.finished' && ids.includes(event.token)) finish();});
        const timer = setTimeout(finish, Math.min(options.waitMs!, 30_000));
      });
    }
    const results = selected().map(token => {
      const successor = successorOf(factory, token), current = successor ?? token;
      const last = factory.state.attempts[current.attempts.at(-1) ?? ''];
      return {token: token.id, title: token.title, status: current.status, gate: current.data.gate,
        owner: ['published', 'merged', 'rejected', 'removed'].includes(current.status) ? 'resolved' : manualOwner(current),
        successor: successor?.id, at: current.at, reason: current.status === 'published' ? '' : reasonOf(current).slice(0, 240),
        lastAttempt: last ? {node: last.node, ok: last.ok, summary: text(last.summary, 160), error: text(last.error, 160), lastStep: text(last.steps.at(-1)?.text, 240)} : undefined};
    });
    const counts: Record<string, number> = {};
    for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
    return {total: results.length, counts, needsUser: results.filter(result => result.owner === 'human').length,
      agentPending: results.filter(result => result.owner === 'agent').length, results,
      contract: '固定清单当前结果，数量合计等于total。manual 是旧内核状态，不代表需要人；只有 owner=human 才需要用户决定，额度耗尽仍是 Agent 技术待修。published须同时核对gate；successor不算本次新发布。active等待完成，不根据历史文字再次纠错。'};
  }
  const tokens = manualQueue(factory.state);
  if (!options.token) {
    const offset = options.offset ?? 0, limit = options.limit ?? 10;
    return {total: tokens.length, currentRunManual: factory.state.totals.manual,
      offset, nextOffset: offset + limit < tokens.length ? offset + limit : null,
      items: tokens.slice(offset, offset + limit).map(token => ({token: token.id, item: token.item, title: token.title,
        reason: reasonOf(token).slice(0, 240), evidenceCount: token.evidence.length, recommendation: recommendation(token)})),
      contract: '先用 token 读单件精简诊断，再执行正确的恢复能力。这里只诊断，不改状态、不批准发布。'};
  }
  const token = factory.state.tokens[options.token];
  if (!token) throw new ControlError(404, 'token_not_found', '没有这个任务');
  const data = token.data;
  const reco = recommendation(token);
  let rebuild: Record<string, unknown> | undefined;
  const successor = successorOf(factory, token);
  if (['candidates', 'curation'].includes(token.line)) {
    try {
      const taxonomy = await loadTaxonomy();
      const rebuilt = buildV3(data, token, factory.store, taxonomy);
      const problems = validateV3(rebuilt, taxonomy);
      const saved = record(data.draftV3);
      const changed = JSON.stringify(saved.pages) !== JSON.stringify(rebuilt.pages) ||
        JSON.stringify(record(saved.facets).access) !== JSON.stringify(rebuilt.facets.access);
      rebuild = {valid: problems.length === 0, problems, changed,
        pages: rebuilt.pages.map(page => ({role: page.role, sourceUrl: page.sourceUrl, sha256: page.shot.sha256})),
        access: rebuilt.facets.access, previousAccess: record(saved.facets).access,
        videoIssues: data.mode === 'video' ? videoPreview(data, factory.store).issues : []};
      if (changed && !problems.length && ['structure', 'facts'].includes(reco.category)) Object.assign(reco, {category: 'reassemble', station: 'curation/assemble', owner: 'agent',
        action: '当前程序重建已消除旧结构/派生字段问题。correct 到 curation/assemble，保留现有证据，再经真实终审与发布闸门。不要重跑阅读和摄影。'});
    } catch (error) {rebuild = {error: error instanceof Error ? error.message : '无法重建诊断', valid: false};}
  }
  const evidence = token.evidence.map(id => factory.state.evidence[id]).filter(Boolean);
  const latest = new Map<string, (typeof evidence)[number]>();
  for (const entry of evidence) if (entry.kind === 'image' || entry.kind === 'video') latest.set(text(entry.meta?.role) || entry.kind, entry);
  const captureRepairs = record(data.shotRepairs);
  const waitingHandoffs = Object.entries(record(data.agentHandoffs)).filter(([station]) => token.status === 'manual' &&
    token.finishedAtNode === station && /预算交接/u.test(token.reason ?? '')).map(([station, value]) => {
    const entry = record(value), report = record(entry.agentContract), handoff = record(entry.handoff);
    return {station, budget: report.budget, suggestion: text(handoff.suggestion), remaining: handoff.remaining,
      continuations: record(record(data.agentContinuations)[station]).count ?? 0};
  });
  if (token.status === 'manual' && waitingHandoffs.length) Object.assign(reco, {category: 'handoff', station: waitingHandoffs[0].station, owner: 'agent',
    action: '预算交接不等于内容需要人工。resume_handoff 原地续接已保存会话；每工位最多2次，不能用 correct 消耗纠错轮数。'});
  if (token.status === 'active') Object.assign(reco, {category: 'running', station: null, owner: 'agent', action: '当前正在排队或执行。等待当前节点完成，不要根据历史失败原因重复 correct。'});
  if (['published', 'rejected', 'removed'].includes(token.status)) Object.assign(reco, {category: 'resolved', station: null, owner: 'agent', action: '已到终态。以当前 status 和 gate 为准；旧拒收文字仅为历史，不要再次重跑。'});
  if (successor) Object.assign(reco, {category: 'superseded', station: null, action: '后续任务已接续此工作，检查 successor 的真实结果，不要重跑旧任务'});
  const recovery = reco.station ? {station: reco.station, manualCorrections: factory.runtime.manualCorrectionBudget(token.id, reco.station),
    contract: 'remaining 才是当前允许的手动纠错次数。rounds 是含自动返工的历史总数；旧 reason 的满轮数不代表此额度。'} : undefined;
  const result = {token: token.id, item: token.item, title: token.title, url: token.url, status: token.status,
    reason: ['manual', 'parked'].includes(token.status) ? reasonOf(token) : '', historicalReason: ['manual', 'parked'].includes(token.status) ? undefined : reasonOf(token),
    successor: successor ? {token: successor.id, status: successor.status, gate: successor.data.gate, digest: successor.data.digest} : null,
    at: token.at, rounds: token.rounds, recommendation: reco, rebuild, waitingHandoffs, recovery,
    current: {mode: data.mode, kind: data.kind, canonical: data.canonical,
      reviews: Object.fromEntries(['shotReview', 'fact-reviewVerdict', 'copy-reviewVerdict', 'auditVerdict', 'gate'].map(key => [key, data[key]])),
      draftProblems: data.draftProblems,
      images: Array.isArray(data.images) ? data.images.map(value => {const image = record(value); return {role: image.role, href: image.href, src: image.src, card: image.card, sha256: image.sha256};}) : [],
      video: Object.fromEntries(['src', 'card', 'poster', 'posterCard', 'finalUrl', 'url', 'evidence', 'issues'].map(key => [key, record(data.video)[key]])),
      readerPlan: Object.fromEntries(Object.entries(record(data.readerPlan)).slice(0, 4).map(([key, value]) => {
        const plan = record(value);
        return [key, {url: plan.url, locate: text(plan.locate, 800), reason: text(plan.reason, 400), alternatives: Array.isArray(plan.alternatives) ? plan.alternatives.slice(0, 4) : []}];
      })),
      captureRepairs: Object.fromEntries(Object.entries(captureRepairs).map(([key, value]) => {const repair = record(value); return [key, {action: repair.action, url: repair.url, reason: text(repair.reason)}];})),
      facts: Object.fromEntries(Object.entries(record(data.facts)).map(([key, value]) => {const fact = record(value); return [key, {value: fact.value, sourceUrl: fact.sourceUrl, quote: text(fact.quote, 500), scope: text(fact.scope, 500)}];})),
    },
    evidence: [...latest.values()].map(entry => ({id: entry.id, kind: entry.kind, role: entry.meta?.role, label: entry.label, src: entry.src, card: entry.card, poster: entry.poster, href: entry.meta?.href, attempt: entry.attempt})),
    recentAttempts: token.attempts.slice(-6).map(id => factory.state.attempts[id]).filter(Boolean).map(attempt => ({id: attempt.id, node: attempt.node, ok: attempt.ok, error: text(attempt.error, 600), summary: text(attempt.summary, 600), steps: attempt.steps.slice(-4).map(step => ({text: text(step.text, 300), detail: text(step.step?.text, 240)}))})),
    bounds: '仅当前输入、最近证据与6次执行摘要；完整案卷和原始事实继续保留。诊断不等于通过审查。'};
  if (options.detail) return result;
  const active = token.status === 'active' || ['published', 'rejected', 'removed'].includes(token.status) || Boolean(successor);
  return {token: result.token, title: result.title, item: result.item, url: result.url,
    status: result.status, gate: data.gate, at: result.at, successor: result.successor, recommendation: reco,
    reason: active ? '' : result.reason, rounds: result.rounds, recovery,
    rebuild: active ? undefined : rebuild,
    waitingHandoffs: active ? [] : waitingHandoffs,
    capture: !active && reco.category === 'capture' ? {
      role: reco.station?.split('/')[1],
      plan: result.current.readerPlan[reco.station?.split('/')[1] ?? ''],
      repair: result.current.captureRepairs[reco.station?.split('/')[1] ?? ''],
    } : undefined,
    recentAttempts: result.recentAttempts.slice(-2),
    contract: '当前状态优先。需要完整事实/证据时传 detail:true；核对固定清单用 tokens:[...]，在途可 waitMs:30000。'};
}
