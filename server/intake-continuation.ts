import fs from 'node:fs';
import crypto from 'node:crypto';
import type {ExternalIntakeCandidate, ExternalIntakeManifest} from './external-intake.ts';
import {externalIntakeAttachments} from './external-intake.ts';
import type {Executor, StationContext, StationResult} from './runtime.ts';
import {parseHtml} from '../packs/vislexicon/tools.ts';
import type {Dossier} from '../packs/vislexicon/scout.ts';

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
function text(value: unknown): string {return typeof value === 'string' ? value : '';}
function readAttachment(value: unknown): JsonObject {
  const ref = object(value);
  if (!text(ref.path) || !text(ref.sha256)) return {};
  const bytes = fs.readFileSync(text(ref.path));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== ref.sha256) {
    throw new Error('External continuation attachment integrity failure');
  }
  return object(JSON.parse(bytes.toString('utf8')) as unknown);
}

/** References point at the copied immutable snapshot, never at mutable source files. */
export function externalResearchFor(manifest: ExternalIntakeManifest,
    candidate: ExternalIntakeCandidate): JsonObject {
  const files = externalIntakeAttachments(manifest, candidate.entryId);
  const current = object((candidate as unknown as JsonObject).currentAttachments);
  const find = (kind: string) => current[kind] ?? files.find(file => file.kind === kind);
  const facts = readAttachment(find('facts'));
  const plan = readAttachment(find('plan'));
  const pins = [
    ...(Array.isArray(facts.sourceFiles) ? facts.sourceFiles : []),
    ...Object.values(object(facts.facts)).filter(value => text(object(value).sourceFile)),
    ...(Array.isArray(plan.sourceBindings) ? plan.sourceBindings : []),
  ].map(object);
  const allSources = files.filter(file => file.kind === 'source');
  const sources = pins.flatMap(pin => {
    const suffix = (text(pin.sourceFile) || text(pin.file)).replace(/\\/g, '/')
      .replace(/^.*\/(sources\/)/, '$1');
    const file = allSources.find(ref => ref.sourcePath.endsWith(`/${suffix}`));
    if (!file) return [];
    if (pin.fileSha256 && pin.fileSha256 !== file.sha256) throw new Error('Pinned source wrapper integrity failure');
    return [{...file, expectedRawSha256: text(pin.rawSha256) || text(pin.sourceSha256) || text(pin.sha256)}];
  });
  return {
    intakeId: manifest.intakeId, entryId: candidate.entryId,
    publicationContract: 'site-entry-three-shots',
    inventorySha256: manifest.inventorySha256,
    factsPassed: candidate.stages.facts === 'passed', facts: find('facts'),
    plan: find('plan'), precopy: find('precopy'),
    sources: sources.length ? sources : allSources,
    captures: files.filter(file => file.kind === 'capture'),
    reviews: files.filter(file => file.kind === 'review'),
    capturedRoles: candidate.stages.capturedRoles,
    holds: candidate.holds, captureStatus: candidate.captureStatus,
    captureBlockers: candidate.captureBlockers,
    nextGap: candidate.nextGap,
  };
}

export function externalResearchHint(ctx: StationContext): string {
  const research = object(ctx.token.data.externalResearch);
  if (!text(research.entryId)) return '';
  const plan = readAttachment(research.plan);
  const precopy = readAttachment(research.precopy);
  return `\n\n已接回的历史准备（资料，不是新审核）：\n${JSON.stringify({
    entryId: research.entryId, factsAlreadyReviewed: research.factsPassed,
    pages: plan.pages, classificationProposal: plan.classificationProposal,
    editorial: precopy.editorial, missingRoles: precopy.missingRoles,
    holds: research.holds, captureStatus: research.captureStatus, captureBlockers: research.captureBlockers,
  }).slice(0, 10000)}\n沿用有效原页与取景提示，只补当前缺口；不要重新扩展调查。`;
}

function savedPages(research: JsonObject) {
  return (Array.isArray(research.sources) ? research.sources : []).flatMap(ref => {
    const reference = object(ref);
    if (!/\.json$/i.test(text(reference.sourcePath) || text(reference.path))) return [];
    const source = readAttachment(ref);
    const url = text(source.finalUrl) || text(source.sourceUrl) || text(source.url);
    const raw = text(source.raw) || text(source.body) || text(source.text);
    if (!/^https?:\/\//i.test(url) || !raw) return [];
    const expectedRaw = text(reference.expectedRawSha256);
    if (expectedRaw && crypto.createHash('sha256').update(raw).digest('hex') !== expectedRaw) {
      throw new Error('Pinned source body integrity failure');
    }
    const status = [source.httpStatus, source.statusCode, source.status]
      .filter(value => typeof value === 'number' || typeof value === 'string' && /^\d{3}$/.test(value))
      .map(Number)[0];
    if (!(status >= 200 && status < 300)) return [];
    if (/cf-chl-|just a moment|verify (?:you are|that you are) human|captcha/i.test(raw.slice(0, 12000))) return [];
    const parsed = parseHtml(raw, url, 24000);
    return [{url, raw, status, ...parsed}];
  });
}

/** Only reuse completed preparation. Corrections always reach their real owner. */
export async function reuseExternalStation(ctx: StationContext,
    execute: Executor): Promise<StationResult> {
  const research = object(ctx.token.data.externalResearch);
  if (!Object.keys(research).length) return execute(ctx);
  if (ctx.redo) {
    const result = await execute(ctx);
    return ctx.node.key === 'curation/facts' ? {...result, data: {...result.data,
      offers: [], externalOffersInvalidated: true, externalFactsReused: false}} : result;
  }
  if (ctx.node.key === 'curation/facts' && research.factsPassed === true) {
    const facts = readAttachment(research.facts);
    if (!Object.keys(object(facts.facts)).length) return execute(ctx);
    const pages = savedPages(research);
    ctx.progress('复用当前摘要已独审的事实与具体 offer；独立事实复核仍按本轮执行',
      {tool: 'continuation', text: text(research.entryId), ok: true});
    return {ok: true, summary: '接回已审事实，不重复模型核验', data: {
      facts: {...object(facts.facts), ...(facts.repositoryLicense ? {repositoryLicense: facts.repositoryLicense} : {})},
      offers: facts.offers ?? [], pricingNote: facts.pricingNote ?? '',
      factPages: pages.map(page => ({url: page.url, text: page.text})),
      factConflicts: Array.isArray(facts.conflicts) ? facts.conflicts : [],
      externalFactsReused: true,
    }};
  }
  if (ctx.node.key !== 'curation/scout') return execute(ctx);
  const pages = savedPages(research);
  const canonical = text(ctx.token.data.canonical) || ctx.token.url;
  const key = (url: string) => url.replace('://www.', '://').replace(/\/+$/, '');
  const home = pages.find(page => key(page.url) === key(canonical));
  if (!home) return execute(ctx);
  const dossier: Dossier = {
    url: canonical, finalUrl: home.url, status: home.status, title: home.title,
    description: home.description, text: home.text, headings: [],
    links: home.links.map(link => ({text: link.text, href: link.href, region: link.inNav ? 'nav' : 'main'})),
    framework: [], files: {llms: null, llmsFull: null, sitemap: [], sitemapCount: 0},
    pages: pages.filter(page => page !== home).map(page => ({url: page.url,
      title: page.title, text: page.text, why: '已保存的原站来源；不是本轮重新访问'})),
    repo: null, via: ['external-intake:immutable-http-snapshot'],
  };
  ctx.progress(`接回 ${pages.length} 份原站来源；跳过重复侦察`,
    {tool: 'continuation', text: text(research.inventorySha256), ok: true});
  return {ok: true, summary: '从持久原文继续阅读与实际取证', data: {
    dossier, title: home.title || ctx.token.title,
    home: {status: home.status, finalUrl: home.url, title: home.title, description: home.description,
      text: home.text, navLinks: home.links.filter(link => link.inNav)},
    externalSourcesReused: true,
  }};
}

export function continuationPriority(candidate: ExternalIntakeCandidate): number {
  const failedCapture = /held|incomplete|^needs-/.test(candidate.captureStatus ?? '');
  return (candidate.captureStatus === 'plan-ready-awaiting-camera' ? 30 : 0) +
    (failedCapture ? -100 : 0) + (candidate.stages.facts === 'content-blocked' ? -100 : 0) +
    (candidate.holds.some(hold => hold.includes('reconcile before feeding')) ? -1000 : 0) +
    (candidate.stages.plan === 'three-roles' ? 20 : 0) +
    (candidate.stages.facts === 'passed' ? 10 : 0) +
    (candidate.stages.precopy ? 5 : 0);
}
