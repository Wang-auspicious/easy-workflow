// Apply a retained, independently reviewed Entry URL decision. This is neither
// an off-site override nor publication approval, and never changes raw input.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual as same} from 'node:util';
import type {Factory} from './factory.ts';
import type {TokenState} from '../shared/project.ts';
import {latestRunTokens, recoveryKey} from '../shared/project.ts';
import type {ExternalIntakeAttachment} from './external-intake.ts';
import {ControlError} from './errors.ts';
import {proofCheckpointSha256} from './capture-supplement.ts';
import {canonical} from '../packs/vislexicon/tools.ts';
import {loadPublished, VIS_ROOT} from '../packs/vislexicon/env.ts';

type Row = Record<string, unknown>;
type Actor = 'agent' | 'dispatcher' | 'user';
interface Ref {path: string; sha256: string}
export interface EntryUrlDecisionRequest {
  token: string;
  runId: string;
  expectedCheckpointSha256: string;
  idempotencyKey: string;
  manifestPath: string;
  manifestSha256: string;
  reason: string;
}
const sha = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const fail = (code: string, message: string): never => {throw new ControlError(409, `entry_url_${code}`, message);};
const requireValue = (condition: unknown, code: string, message: string): void => {if (!condition) fail(code, message);};
const website = (token: TokenState) => ['candidates', 'curation'].includes(token.line) && !token.data.workflowPack && !token.data.channelDelivery;
const downstream = new Set(['identity', 'breadth', 'proof', 'process', 'shot-review', 'style', 'copy', 'copy-review', 'assemble', 'audit', 'gate', 'published', 'manual', 'fact-review'].map(key => `curation/${key}`));

function keys(value: Row, allowed: string[]) {
  requireValue(Object.keys(value).every(key => allowed.includes(key)), 'manifest_invalid', '入口决议含不支持字段，不能导入任意补丁或审批');
}
function json(bytes: Buffer): Row {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (Object.keys(object(value)).length) return object(value);
  } catch { /* Stable error without echoing source content. */ }
  return fail('manifest_invalid', '入口决议需要非空 JSON 对象');
}
function ref(value: unknown): Ref {
  const row = object(value); keys(row, ['path', 'sha256']);
  requireValue(text(row.path) && /^[a-f0-9]{64}$/.test(text(row.sha256)), 'integrity', '文件须有精确路径和 SHA256');
  return {path: text(row.path), sha256: text(row.sha256)};
}
function approvedRoots(f: Factory): string[] {
  return [...new Set([f.project.dir, VIS_ROOT, f.externalIntake?.sourceRoot, f.externalIntake?.storageDir]
    .filter((value): value is string => Boolean(value && fs.existsSync(value))).map(value => fs.realpathSync(value)))];
}
function readFile(file: string, base: string, roots: string[], limit: number): Buffer {
  try {
    const real = fs.realpathSync(path.resolve(base, file));
    requireValue(roots.some(root => {
      const relative = path.relative(root, real);
      return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }), 'path_outside_root', '决议文件超出项目或已配置资料根目录');
    const stat = fs.statSync(real);
    requireValue(stat.isFile() && stat.size > 0 && stat.size <= limit, 'file_invalid', '决议文件大小或类型不符合限制');
    return fs.readFileSync(real);
  } catch (error) {
    if (error instanceof ControlError) throw error;
    return fail('file_invalid', '决议引用文件不存在或无法读取');
  }
}
function bound(input: Ref, base: string, roots: string[], limit = 1 << 20): Buffer {
  const bytes = readFile(input.path, base, roots, limit);
  requireValue(sha(bytes) === input.sha256, 'integrity', '决议原字节与声明 SHA256 不符');
  return bytes;
}
function https(value: unknown): URL {
  try {
    const url = new URL(text(value));
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && !url.search && url.pathname !== '/') return url;
  } catch { /* Fail closed. */ }
  return fail('scope_invalid', 'URL 决议仅支持明确 HTTPS 项目路径，不含凭据、端口、查询或作者根目录');
}
function requestHash(p: EntryUrlDecisionRequest, projectDir: string) {
  return sha(JSON.stringify({token: p.token, runId: p.runId, expectedCheckpointSha256: p.expectedCheckpointSha256,
    idempotencyKey: p.idempotencyKey, manifestPath: path.resolve(projectDir, p.manifestPath), manifestSha256: p.manifestSha256, reason: p.reason}));
}
function replay(f: Factory, p: EntryUrlDecisionRequest, requestSha256: string): Row | undefined {
  for (const token of Object.values(f.state.tokens)) {
    const receipt = object(token.data.entryUrlDecisionReceipt);
    if (receipt.runId !== p.runId || receipt.idempotencyKey !== p.idempotencyKey) continue;
    requireValue(receipt.requestSha256 === requestSha256, 'idempotency_conflict', '同一入口决议 key 不能对应不同请求');
    return {...receipt, alreadyPresent: true};
  }
  return undefined;
}
function checkpoint(f: Factory, p: EntryUrlDecisionRequest) {
  const previous = f.state.tokens[p.token];
  requireValue(previous && website(previous) && previous.status === 'parked' && previous.finishedAtNode === 'curation/identity' &&
    !previous.data.retriedBy && latestRunTokens(f.state).some(token => token.id === p.token), 'target_changed', '只接受当前精确尚未领取的 identity 停点');
  const live = f.runtime.tokens.get(previous!.id), failure = object(previous!.data.failure);
  requireValue(failure.tag === 'tool_error' && failure.message === 'offSite' && failure.retryable === true,
    'target_changed', '只处理已保存的入口迁移 offSite 原因，不能作为任意重试接口');
  requireValue(f.runtime.running && f.runtime.paused && !f.runtime.ending && f.state.run.status === 'paused' && p.runId === f.state.run.id &&
    ![...f.runtime.workers.values()].some(pool => pool.some(worker => worker.busy)) &&
    ![...f.runtime.tokens.values()].some(token => token.inflight.size) &&
    Object.values(f.broker.used).every(value => value === 0) && f.broker.modelRequests.active === 0 && f.broker.modelRequests.queued === 0,
  'run_not_quiescent', '仅能在原轮次暂停且所有工位和资源排空后应用入口决议；接口保持暂停');
  requireValue(f.state.digest === f.compiled.digest && proofCheckpointSha256(f, previous!) === p.expectedCheckpointSha256,
    'checkpoint_changed', '规格或原检查点已变化，请重新 inspect');
  const saved = object(previous!.data.runtimeCheckpoint), done = saved.done, rounds = object(saved.rounds);
  requireValue(live?.finished && saved.version === 1 && typeof saved.entry === 'string' && f.runtime.nodes.has(saved.entry) &&
    Array.isArray(done) && done.every(key => typeof key === 'string' && f.runtime.nodes.has(key)) && new Set(done).size === done.length &&
    saved.rounds && !Array.isArray(saved.rounds) && Object.entries(rounds).every(([key, value]) => f.runtime.nodes.has(key) && Number.isSafeInteger(value) && Number(value) >= 0) &&
    same(saved.rounds, live.rounds) && same(saved.rounds, previous!.rounds) &&
    Array.isArray(saved.notes) && saved.notes.every(note => Array.isArray(note) && note.length === 2 && typeof note[0] === 'string' &&
      f.runtime.nodes.has(note[0]) && typeof object(note[1]).reason === 'string' && typeof object(note[1]).byHuman === 'boolean') &&
    !saved.consult && !live.consult && (!saved.pendingConsults || Array.isArray(saved.pendingConsults) && saved.pendingConsults.length === 0) && !live.pendingConsults?.length,
  'checkpoint_missing', '需完整原检查点与预算，且无未解决审核会话');
  requireValue(['reader', 'catalog', 'plan', 'facts'].every(key => (done as unknown[]).includes(`curation/${key}`)) &&
    !(done as unknown[]).some(key => downstream.has(String(key))) && previous!.data.mode === 'shots',
  'upstream_incompatible', '需保留已完成事实/计划，缺失三图与已取消事实复审必须仍未完成');
  const candidate = f.state.recoveries[recoveryKey(previous!)];
  requireValue(candidate?.token === previous!.id && candidate.disposition === 'retry' && candidate.item === previous!.item,
    'recovery_changed', '恢复记录已被另一任务领取或不再等待修复');
  requireValue(f.state.nodes['candidates/pool']?.stock >= 1, 'recovery_changed', '候选库存不足，不能无库存续接');
  requireValue(!previous!.data.entryUrlDecisionReceipt && !previous!.data.ownerCaptureTargets, 'target_changed', '不能覆盖已应用决议或既有明确取景归属');
  return {previous: previous!, saved, candidate: candidate!};
}

function headers(raw: string, start: string) {
  let current = start;
  const chain: Row[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const status = /^HTTP\/\S+\s+(\d{3})\b([^\r\n]*)/i.exec(block.trim());
    if (!status || /connection established/i.test(status[2])) continue;
    const code = Number(status[1]), location = /(?:^|\r?\n)location:\s*([^\r\n]+)/i.exec(block)?.[1].trim() ?? null;
    const next = location ? new URL(location, current).href : null;
    chain.push({responseUrl: current, httpStatus: code, location, redirectedTo: next});
    if (next) current = next;
  }
  requireValue(chain.length === 3 && chain[0].httpStatus === 301 && chain[1].httpStatus === 301 && chain[2].httpStatus === 200 &&
    !chain[2].location && chain.slice(0, 2).every(row => row.location), 'source_invalid', '须保留两次真实 301 和最终 200，代理 CONNECT 不算迁移');
  return chain;
}

function prepare(f: Factory, p: EntryUrlDecisionRequest, previous: TokenState, roots: string[]) {
  const bytes = bound({path: p.manifestPath, sha256: p.manifestSha256}, f.project.dir, roots);
  const manifest = json(bytes); keys(manifest, ['schemaVersion', 'kind', 'entryId', 'proposal', 'review', 'retainedPlan']);
  requireValue(manifest.schemaVersion === 1 && manifest.kind === 'entry-url-repair' && manifest.entryId === previous.item,
    'manifest_invalid', '清单必须精确绑定当前 Entry 的 URL 决议');
  const research = object(previous.data.externalResearch), intake = f.externalIntake;
  const entry = intake?.candidates.find(row => row.entryId === previous.item);
  requireValue(entry && entry.disposition === 'continue' && !entry.publication && research.entryId === previous.item &&
    research.inventorySha256 === intake?.inventorySha256 && research.intakeId === intake?.intakeId,
  'entry_mismatch', '当前 Entry 不属于原持久资料清单，或已有发布身份');
  const attachments = entry!.attachments;
  const archives: {bytes: Buffer; sha256: string; sourcePath: string}[] = [];
  const readAttachment = (attachment: ExternalIntakeAttachment) => {
    const content = bound(attachment, f.project.dir, roots, 8 << 20);
    requireValue(content.length === attachment.bytes, 'integrity', '保留附件长度变化');
    archives.push({bytes: content, sha256: attachment.sha256, sourcePath: attachment.sourcePath});
    return json(content);
  };
  const retainedRef = (value: unknown, suffix: string, currentSourcePath?: string) => {
    const input = ref(value), content = bound(input, path.dirname(path.resolve(f.project.dir, p.manifestPath)), roots);
    const matches = attachments.filter(row => row.sourcePath.endsWith(suffix) && row.sha256 === input.sha256 &&
      (!currentSourcePath || row.sourcePath === currentSourcePath));
    requireValue(matches.length === 1, 'integrity', '决议/审查/计划必须来自该 Entry 已保留的精确附件');
    const attachment = matches[0], retained = readAttachment(attachment);
    requireValue(sha(content) === attachment.sha256, 'integrity', '决议与保留附件不相同');
    return {value: retained, sha256: attachment.sha256};
  };
  const proposed = retainedRef(manifest.proposal, `/identity-decisions/${previous.item}.json`);
  const reviewed = retainedRef(manifest.review, `/reviews/${previous.item}.identity-decision-review.json`);
  const planned = retainedRef(manifest.retainedPlan, `/plans/${previous.item}.json`, entry!.currentAttachments?.plan?.sourcePath);
  const proposal = proposed.value, review = reviewed.value, plan = planned.value;
  keys(proposal, ['schemaVersion', 'entryId', 'selectionOrdinal', 'authorId', 'proposedAt', 'decision', 'status', 'decisionScope',
    'originalInputUrl', 'proposedUrl', 'originalOrigin', 'proposedOrigin', 'stableRepository', 'stableRepositoryId', 'reasonZh',
    'redirectEvidence', 'evidence', 'originalObservationPreserved', 'rawSelectionSha256', 'assignmentSha256', 'originalInputRewritten',
    'mutationApplied', 'centralSelectionChanged', 'captureHostGuardChanged', 'renderedPagesVerified', 'clientRedirectRuntimeVerified',
    'fullFiveKindApproval', 'countedAsCompleted', 'existingFacts', 'pending', 'reviewerInstructions']);
  keys(review, ['schemaVersion', 'entryId', 'selectionOrdinal', 'reviewerId', 'reviewedAt', 'proposalFile', 'proposalSha256', 'verdict',
    'approvedDecision', 'approvedOriginalInputUrl', 'approvedCanonicalUrl', 'approvedScope', 'reason', 'evidenceAudits', 'redirectAudit',
    'repositoryAudit', 'rawSelectionSha256', 'assignmentSha256', 'rawSelectionCountBefore', 'rawSelectionCountAfter',
    'originalObservationPreserved', 'existingFacts', 'centralMutationApplied', 'entityMergeApproved', 'newCandidateCreated',
    'captureOriginOverrideApproved', 'captureHostGuardChanged', 'cameraSlotAuthorized', 'classificationInherited', 'recordDigest',
    'screenshotsViewed', 'fullFiveKindApproval', 'countedAsCompleted', 'limitations', 'problems']);
  requireValue(proposal.schemaVersion === 1 && review.schemaVersion === 1 && proposal.entryId === previous.item && review.entryId === previous.item &&
    proposal.selectionOrdinal === entry!.ordinal && review.selectionOrdinal === entry!.ordinal &&
    proposal.decision === 'repair-entry-url' && proposal.status === 'PROPOSED' && review.approvedDecision === 'repair-entry-url' &&
    review.verdict === 'pass-for-entry-url-repair-only' && review.proposalSha256 === proposed.sha256 &&
    text(proposal.authorId) && text(review.reviewerId) && review.reviewerId !== proposal.authorId &&
    proposal.originalObservationPreserved === true && review.originalObservationPreserved === true && proposal.originalInputRewritten === false &&
    proposal.mutationApplied === false && proposal.fullFiveKindApproval === false && review.fullFiveKindApproval === false &&
    review.recordDigest === null && Array.isArray(review.problems) && review.problems.length === 0,
  'decision_invalid', '只消费独立审过的未应用精确入口决议，不接受发布审批或已应用决议');
  for (const [value, names] of [[proposal, ['centralSelectionChanged', 'captureHostGuardChanged', 'renderedPagesVerified', 'clientRedirectRuntimeVerified', 'countedAsCompleted']],
    [review, ['centralMutationApplied', 'entityMergeApproved', 'newCandidateCreated', 'captureOriginOverrideApproved', 'captureHostGuardChanged',
      'cameraSlotAuthorized', 'classificationInherited', 'screenshotsViewed', 'countedAsCompleted']]] as [Row, string[]][]) {
    requireValue(names.every(key => value[key] === undefined || value[key] === false), 'decision_invalid', 'URL 决议不能携带合并、摄影或成品审批');
  }
  requireValue(/^[a-f0-9]{64}$/.test(text(proposal.rawSelectionSha256)) && /^[a-f0-9]{64}$/.test(text(proposal.assignmentSha256)) &&
    proposal.rawSelectionSha256 === review.rawSelectionSha256 && proposal.assignmentSha256 === review.assignmentSha256 &&
    Number.isSafeInteger(review.rawSelectionCountBefore) && Number(review.rawSelectionCountBefore) >= 1 &&
    review.rawSelectionCountBefore === review.rawSelectionCountAfter, 'decision_invalid', '原观察与指派身份不能被改写');
  const oldUrl = https(proposal.originalInputUrl), newUrl = https(proposal.proposedUrl);
  requireValue(oldUrl.href === previous.url && oldUrl.href === entry!.url && canonical(oldUrl.href) === previous.data.canonical &&
    oldUrl.origin === proposal.originalOrigin && newUrl.origin === proposal.proposedOrigin &&
    oldUrl.pathname.replace(/\/$/, '') === newUrl.pathname.replace(/\/$/, '') && oldUrl.origin !== newUrl.origin &&
    review.approvedOriginalInputUrl === oldUrl.href && review.approvedCanonicalUrl === newUrl.href,
  'scope_invalid', '只接受原 Entry 同一项目路径的明确迁移，不可扩展到作者根或其他项目');
  const factsRef = entry!.currentAttachments?.facts;
  requireValue(factsRef && [proposal, review].every(value => object(value.existingFacts).sha256 === factsRef.sha256 &&
    object(value.existingFacts).modified === false && object(value.existingFacts).approvalInherited === false),
    'integrity', '原事实附件绑定变化');
  const retainedFacts = readAttachment(factsRef!);
  requireValue(same(retainedFacts.facts, previous.data.facts) && same(retainedFacts.offers, previous.data.offers) &&
    ['author', 'organization', 'repository', 'license', 'pricing', 'sourceCode', 'commercial', 'repositoryLicense'].every(key => Object.hasOwn(object(retainedFacts.facts), key)),
  'upstream_incompatible', '事实或 offer 已有不同版本，须先审计，不能借 URL 决议覆盖');
  requireValue(entry!.currentAttachments?.plan?.sha256 === planned.sha256 && plan.entryId === previous.item, 'integrity', '只使用当前已保留取景计划');
  const sourceRef = (reference: Row) => {
    const name = text(reference.sourceFile);
    requireValue(name && !name.includes('\\') && path.posix.normalize(name) === name && !name.startsWith('../') && !path.posix.isAbsolute(name), 'source_invalid', '来源路径不合法');
    const matches = attachments.filter(row => row.kind === 'source' && row.sourcePath.endsWith('/' + name));
    requireValue(matches.length === 1 && matches[0].sha256 === reference.fileSha256, 'integrity', '来源不属于当前 Entry 的保留附件');
    const source = readAttachment(matches[0]), rawSha256 = text(reference.rawSha256 ?? reference.sourceSha256);
    requireValue(source.entryId === previous.item && typeof source.raw === 'string' && sha(source.raw) === rawSha256 && source.sha256 === rawSha256 &&
      (reference.sourceUrl === undefined || reference.sourceUrl === source.sourceUrl),
      'integrity', '来源原文 SHA 不匹配');
    if (reference.quote !== undefined) requireValue(typeof reference.quote === 'string' && reference.quote.length > 0 &&
      Number.isSafeInteger(reference.characterOffset) && Number(reference.characterOffset) >= 0 &&
      (source.raw as string).slice(Number(reference.characterOffset), Number(reference.characterOffset) + reference.quote.length) === reference.quote,
    'source_invalid', '来源引用不是保存原文中的精确位置');
    return source;
  };
  const evidence = Array.isArray(proposal.evidence) ? proposal.evidence.map(object) : [];
  const audits = Array.isArray(review.evidenceAudits) ? review.evidenceAudits.map(object) : [];
  requireValue(evidence.length === 8 && audits.length === 8, 'decision_invalid', '缺少完整八项引用及独立绑定');
  const readSources = evidence.map((item, index) => {
    const audit = audits[index];
    requireValue(item.observedEntryId === previous.item && ['sourceFile', 'fileSha256', 'sourceSha256', 'sourceUrl', 'quote', 'characterOffset'].every(key => same(item[key], audit[key])) &&
      audit.exactOriginalVerified === true && audit.quoteSha256 === sha(text(item.quote)), 'decision_invalid', '引用与独立审查不相符');
    return sourceRef(item);
  });
  const redirectRef = object(proposal.redirectEvidence), redirected = sourceRef(redirectRef);
  requireValue(redirectRef.observedEntryId === previous.item && redirected.inputUrl === oldUrl.href && redirected.readUrl === oldUrl.href &&
    redirected.finalUrl === newUrl.href && redirected.httpStatus === 200 && redirected.exitCode === 0 &&
    sha(text(redirected.responseHeadersRaw)) === redirectRef.responseHeadersSha256, 'source_invalid', '原请求或 HTTP 迁移证据不完整');
  const chain = headers(text(redirected.responseHeadersRaw), oldUrl.href);
  requireValue(same(chain, redirectRef.redirectChain) && same(chain, object(review.redirectAudit).redirectChain) &&
    chain[2].responseUrl === newUrl.href && redirectRef.numRedirects === 2 && redirectRef.responseCode === 200 && redirectRef.curlExitCode === 0 &&
    object(review.redirectAudit).rawBodySha256 === sha(text(redirected.raw)) && object(review.redirectAudit).responseHeadersRawSha256 === sha(text(redirected.responseHeadersRaw)),
  'source_invalid', '完整响应头与原决议/独立审查链不符');
  const stableRepository = text(proposal.stableRepository);
  requireValue(/^[\w.-]+\/[\w.-]+$/.test(stableRepository) && Number.isSafeInteger(proposal.stableRepositoryId), 'source_invalid', '缺少稳定项目仓库');
  const repo = readSources.find(source => source.sourceUrl === `https://api.github.com/repos/${stableRepository}`);
  const repository = repo ? json(Buffer.from(text(repo.raw))) : {};
  const historicalHome = (value: string) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port && !url.search && !url.hash &&
        url.hostname === oldUrl.hostname && url.pathname.replace(/\/$/, '') === oldUrl.pathname.replace(/\/$/, '');
    } catch {return false;}
  };
  requireValue(repository.id === proposal.stableRepositoryId && repository.full_name === stableRepository &&
    historicalHome(text(repository.homepage)) && text(redirected.raw).includes(`https://github.com/${stableRepository}`) &&
    object(review.repositoryAudit).stableRepositoryId === repository.id && object(review.repositoryAudit).fullName === stableRepository &&
    readSources.some(source => text(source.sourceUrl).startsWith(`https://github.com/${stableRepository}/blob/`) &&
      (text(source.raw).match(/https?:\/\/[^\s<>"')\]]+/g) ?? []).some(historicalHome)),
  'source_invalid', '稳定仓库、原文档回链与最终页面并未构成同一项目身份关系');
  const pages = Array.isArray(plan.pages) ? plan.pages.map(object) : [];
  requireValue(pages.length === 3 && new Set(pages.map(page => page.role)).size === 3, 'target_unverified', '需唯一的三角色原取景计划');
  const readerPlan: Row = {};
  for (const role of ['identity', 'breadth', 'proof']) {
    const page = pages.find(row => row.role === role);
    requireValue(page, 'target_unverified', '缺少原角色目标');
    const url = new URL(text(page!.url));
    requireValue(url.protocol === 'https:' && url.origin === newUrl.origin && !url.username && !url.password && !url.port && !url.search && !url.hash &&
      (role === 'identity' ? url.href === newUrl.href : text(redirected.raw).includes(`href="${url.pathname.slice(newUrl.pathname.length)}"`) &&
        url.pathname.startsWith(newUrl.pathname) && !url.pathname.slice(newUrl.pathname.length).includes('/')),
    'target_unverified', '只能采用原页面直接链接的精确项目目标');
    let locate = text(object(object(previous.data.readerPlan)[role]).locate);
    if (page!.scrollSelector) {
      requireValue(/^#[a-zA-Z][\w-]*$/.test(text(page!.scrollSelector)), 'target_unverified', '只支持原计划的单一真实锚点');
      const source = attachments.filter(row => row.kind === 'source').map(row => {
        const content = bound(row, f.project.dir, roots, 8 << 20); const candidate = json(content);
        return candidate.sourceUrl === url.href ? {candidate, row, content} : undefined;
      }).find(Boolean);
      requireValue(source, 'target_unverified', '目标锚点缺少原正文支持');
      requireValue(source!.candidate.entryId === previous.item && sha(text(source!.candidate.raw)) === source!.candidate.sha256,
        'integrity', '取景锚点原正文的 Entry 或 SHA 不符');
      const raw = text(source!.candidate.raw), anchor = `id="${text(page!.scrollSelector).slice(1)}"`, offset = raw.indexOf(anchor);
      const heading = offset >= 0 ? /<h[1-6][^>]*>([\s\S]*?)(?:<small\b|<\/h[1-6]>)/i.exec(raw.slice(offset))?.[1] : undefined;
      locate = (heading ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      requireValue(locate.length >= 2 && locate.length <= 100, 'target_unverified', '原锚点必须有可实见的精确标题');
      archives.push({bytes: source!.content, sha256: source!.row.sha256, sourcePath: source!.row.sourcePath});
    }
    readerPlan[role] = {...object(object(previous.data.readerPlan)[role]), url: url.href, alternatives: [],
      ...(locate ? {locate} : {}), reason: text(page!.reason) || '应用已审入口迁移；实际取景及独立审核仍待执行。'};
  }
  return {bytes, proposal, review, proposed, reviewed, planned, readerPlan, archives, oldUrl: oldUrl.href, newUrl: newUrl.href};
}

function noCollision(f: Factory, previous: TokenState, oldUrl: string, newUrl: string) {
  const urls = new Set([canonical(oldUrl), canonical(newUrl)]);
  requireValue(!Object.values(f.state.tokens).some(token => website(token) && token.item === previous.item && token.status === 'published') &&
    !loadPublished().some(row => row.entryId === previous.item), 'already_published', '已发布 Entry 不能用入口决议重新恢复');
  requireValue(!latestRunTokens(f.state).some(token => website(token) && token.item !== previous.item &&
    [token.url, token.data.canonical, object(token.data.entryUrlDecisionReceipt).originalInputUrl,
      object(token.data.entryUrlDecisionReceipt).operationalCanonical].some(value => urls.has(canonical(text(value))))) &&
    !loadPublished().some(row => row.entryId !== previous.item && urls.has(canonical(row.homepage))) &&
    !f.catalog.some(row => row.id !== previous.item && urls.has(canonical(row.canonicalUrl))),
  'identity_collision', '原/新 URL 与另一 Entry 冲突，需要独立身份决议，不能自动合并');
}

/** One audited identity input, one durable successor, no new review allowance. */
export async function applyEntryUrlDecision(f: Factory, p: EntryUrlDecisionRequest, actor: Actor) {
  const requestSha256 = requestHash(p, f.project.dir), existing = replay(f, p, requestSha256);
  if (existing) return existing;
  const before = checkpoint(f, p), roots = approvedRoots(f), input = prepare(f, p, before.previous, roots);
  noCollision(f, before.previous, input.oldUrl, input.newUrl);
  const manifest = f.store.put(input.bytes, 'json');
  const original = f.store.put(Buffer.from(JSON.stringify({token: before.previous, checkpoint: before.saved})), 'json');
  const sourceObjects = [...new Map(input.archives.map(row => [row.sha256, row])).values()].map(row => ({
    sourcePath: row.sourcePath, sha256: row.sha256, object: f.store.put(row.bytes, 'json').src}));
  const rawImages = Object.entries(object(before.previous.data.shots)).flatMap(([role, value]) => {
    const file = text(object(value).file);
    if (!file) return [];
    const bytes = readFile(file, f.project.dir, roots, 16 << 20);
    return [{role, originalFile: file, sha256: sha(bytes), object: f.store.put(bytes, path.extname(file).slice(1) || 'bin').src}];
  });
  let result: Row = {};
  f.runtime.atomicTransition(() => {
    const priorReplay = replay(f, p, requestSha256);
    if (priorReplay) {result = priorReplay; return;}
    const {previous, saved, candidate} = checkpoint(f, p);
    noCollision(f, previous, input.oldUrl, input.newUrl);
    const data = structuredClone(previous.data);
    for (const key of ['failure', 'manualReason', 'retriedBy', 'gate', 'digest', 'published', 'draftV3', 'draftProblems', 'copy', 'style', 'needsPick', 'previewChoices']) delete data[key];
    const operationalCanonical = canonical(input.newUrl)!;
    Object.assign(data, {canonical: operationalCanonical, host: new URL(operationalCanonical).hostname,
      key: operationalCanonical.replace(/^https?:\/\//, ''), readerPlan: input.readerPlan,
      breadthCandidates: [text(object(input.readerPlan.breadth).url)],
      'fact-reviewVerdict': 'pending', shotReview: 'pending', 'copy-reviewVerdict': 'pending', auditVerdict: 'pending',
      reviews: (Array.isArray(data.reviews) ? data.reviews : []).filter(review => !downstream.has(`curation/${text(object(review).station).replace(/^curation\//, '')}`)),
      retryOf: previous.id, recoveryRoot: saved.entry, recoveryStation: 'curation/identity'});
    const next = f.runtime.create('curation/identity', {item: previous.item, url: previous.url, title: previous.title,
      source: previous.source, category: previous.category, data});
    next.data.runtimeCheckpoint = structuredClone(saved);
    requireValue(f.runtime.restoreCheckpoint(next), 'checkpoint_missing', '原检查点无法恢复');
    f.runtime.restoreFlow(next); f.runtime.resumeFrontier(next, 'curation/identity');
    const receipt = {schemaVersion: 1, decisionId: `entry-url-${crypto.randomUUID()}`, previousToken: previous.id, token: next.id,
      entryId: previous.item, runId: p.runId, idempotencyKey: p.idempotencyKey, requestSha256,
      previousCheckpointSha256: p.expectedCheckpointSha256, manifestSha256: p.manifestSha256, manifest: manifest.src,
      proposalSha256: input.proposed.sha256, reviewSha256: input.reviewed.sha256, retainedPlanSha256: input.planned.sha256,
      originalInputUrl: previous.url, operationalCanonical, oldKey: previous.data.key, newKey: next.data.key,
      preservedRounds: {...next.rounds}, originalSnapshot: original.src, sourceObjects, rawImages,
      recoveryKey: recoveryKey(previous), previousRecoveryAttempts: candidate.attempts,
      resumeAt: 'curation/identity', queued: true, paused: true, review: 'pending', publicationApproval: false, actor, reason: p.reason};
    Object.assign(next.data, {entryUrlDecisionReceipt: receipt, checkpointDone: [...next.done]});
    f.journal.append({kind: 'token.data', token: next.id, patch: {...next.data}}); f.runtime.checkpoint(next);
    for (const id of previous.evidence) {
      const evidence = f.state.evidence[id];
      if (evidence) f.journal.append({kind: 'evidence.added', evidence: {...evidence, id: `${id}-${next.id}`, token: next.id,
        meta: {...evidence.meta, reusedFrom: id, entryUrlDecision: receipt.decisionId}}});
    }
    Object.assign(f.runtime.tokens.get(previous.id)!.data, {retriedBy: next.id, entryUrlDecisionReceipt: receipt});
    f.journal.append({kind: 'token.data', token: previous.id, patch: {retriedBy: next.id, entryUrlDecisionReceipt: receipt}});
    f.journal.append({kind: 'candidate.disposition', candidate: {...candidate, token: next.id, url: input.newUrl, disposition: 'claimed'}});
    f.runtime.stockDelta('candidates/pool', -1, '已审入口迁移从原检查点续接，原预算与历史保留');
    f.journal.append({kind: 'case.noted', caseId: previous.item, token: next.id, note: {station: 'curation/identity', section: '入口 URL 决议',
      by: actor, text: `${p.reason}\n${JSON.stringify(receipt)}`}});
    result = {...receipt, alreadyPresent: false};
  });
  return result;
}
