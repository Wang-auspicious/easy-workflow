import fs from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {Check} from 'typebox/value';
import type {BoardPost} from '../shared/board.ts';
import type {CompiledFactory, RoomView} from '../shared/types.ts';
import type {AgentInput} from './agent-station.ts';
import type {StationContext} from './runtime.ts';
import {EvidenceStore, pixelStatsAsync} from './evidence.ts';
import {checkImage, breadthPreviewIssues} from '../packs/vislexicon/capture.ts';
import {style} from '../packs/vislexicon/agents.ts';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];
const pick = (value: unknown, keys: string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(record(value), key)).map(key => [key, record(value)[key]]));
const fieldValue = (data: Record<string, unknown>, field: string) => field.split('.').reduce<unknown>((value, key) =>
  ['__proto__', 'prototype', 'constructor'].includes(key) ? undefined : record(value)[key], data);
const match = (pattern: string, field: string) => pattern === field || pattern.endsWith('.*') && field.startsWith(pattern.slice(0, -1));
const imageFields = ['role', 'src', 'card', 'poster', 'posterCard', 'sha256', 'href', 'evidence', 'title', 'capturedAt'];

/** New collaboration input contains exactly the participant's declared view.
 * Original session history remains that node's own history, never another node's. */
export function collaborationView(compiled: CompiledFactory, data: Record<string, unknown>, node: string, field: string): Record<string, unknown> {
  const policy = compiled.rooms?.find(policy => match(policy.field, field));
  let view: RoomView | undefined = policy?.views[node];
  if (node.startsWith('program:')) view = 'shots+pixels';
  if (!view && policy?.judge === node) {
    view = field === 'kind' ? 'dossier+home' : field.startsWith('facts.') ? 'source-quotes'
      : field === 'copy' ? 'facts+style' : 'shots+pixels';
  }
  if (!view) return structuredClone({viewKind: 'field', field, value: fieldValue(data, field)});
  const dossier = record(data.dossier), files = record(dossier.files);
  const images = rows(data.images).map(image => pick(image, imageFields));
  const textDossier = {...pick(dossier, ['url', 'finalUrl', 'status', 'title', 'description', 'text', 'headings']),
    pages: rows(dossier.pages).map(page => pick(page, ['url', 'title', 'text', 'why'])), files: pick(files, ['llms', 'llmsFull'])};
  let selected: Record<string, unknown>;
  switch (view) {
    case 'dossier': selected = {dossier: textDossier}; break;
    case 'dossier+home': {
      const home = images.filter(image => image.role === 'identity' || image.role === 'poster');
      if (!home.length) {
        const image = pick(data.homeScreenshot ?? record(data.home).screenshot ?? record(data.shots).identity, imageFields);
        if (image.src || image.card) home.push({...image, role: 'identity'});
      }
      selected = {dossier: textDossier, images: home, homeScreenshotAvailable: home.length > 0};
      break;
    }
    case 'shots': selected = {images}; break;
    case 'shots+pixels': selected = {images, pixels: {}}; break;
    case 'plan+sitemap': selected = {readerPlan: data.readerPlan, sitemap: files.sitemap ?? []}; break;
    case 'sources': selected = {sources: [...rows(data.factPages), ...rows(dossier.pages)]
      .map(page => pick(page, ['url', 'title', 'text', 'sourceUrl', 'quote'])),
      sourceHome: pick(dossier, ['url', 'finalUrl', 'title', 'text']), repository: data.repo}; break;
    case 'source-quotes': selected = {quotes: Object.entries(record(data.facts)).map(([field, fact]) =>
      ({field, ...pick(fact, ['sourceUrl', 'quote', 'evidence', 'scope'])})),
      sourceExcerpts: rows(data.factPages).map(page => pick(page, ['url', 'text']))}; break;
    case 'facts+style': selected = {facts: data.facts, style: data.style}; break;
  }
  return structuredClone({viewKind: view, ...selected});
}

export function collaborationImages(view: Record<string, unknown>, store: EvidenceStore): AgentInput['images'] {
  return rows(view.images).map(image => {
    const reference = image.card ?? image.src ?? image.posterCard ?? image.poster;
    const file = typeof reference === 'string' ? store.resolve(reference) : undefined;
    return {file: file && fs.existsSync(file) ? file : '', label: String(image.role ?? image.title ?? image.evidence ?? '讨论证据')};
  });
}

/** Stats come from the allowed durable images, never from a participant's claim. */
export async function collaborationPixels(view: Record<string, unknown>, store: EvidenceStore, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (view.viewKind !== 'shots+pixels') return view;
  const pixels: Record<string, unknown> = {};
  for (const image of collaborationImages(view, store) ?? []) {
    signal?.throwIfAborted();
    if (!image.file) continue; // runStationDialogue rejects the declared missing image before calling any model.
    pixels[image.label] = await pixelStatsAsync(image.file, {signal});
  }
  return {...view, pixels};
}

function proposedValues(posts: BoardPost[]): unknown[] {
  const round = Math.max(0, ...posts.map(post => post.round));
  const values: unknown[] = [];
  for (const post of posts) {
    if (post.round !== round || post.type !== 'claim') continue;
    try {
      const proposal = record(JSON.parse(post.body));
      if (Object.hasOwn(proposal, 'value') && !values.some(value => isDeepStrictEqual(value, proposal.value))) values.push(proposal.value);
    } catch { /* No program conclusion can be extracted from malformed evidence. */ }
  }
  return values;
}

/** Only an unambiguous surviving proposal is a program verdict. The rule
 * implementations are the existing capture checks and style vetoes; thresholds
 * and acceptance schemas are never duplicated or weakened here. */
export async function judgeCollaboration(name: string, ctx: StationContext, posts: BoardPost[], store: EvidenceStore): Promise<{decided: true; value: unknown} | {decided: false}> {
  try { return await judgeKnownRules(name, ctx, posts, store); }
  catch {
    ctx.signal.throwIfAborted();
    // Unavailable source bytes or rule libraries are not evidence for a verdict.
    // The room driver will use its declared Agent judge with the same evidence.
    return {decided: false};
  }
}

async function judgeKnownRules(name: string, ctx: StationContext, posts: BoardPost[], store: EvidenceStore): Promise<{decided: true; value: unknown} | {decided: false}> {
  ctx.signal.throwIfAborted();
  const candidates = proposedValues(posts);
  if (!candidates.length) return {decided: false};
  const accepted: unknown[] = [];
  if (name === 'style-veto' || name === 'program:style-veto') {
    const definition = style(store);
    const skipped = await definition.skip?.(ctx);
    if (skipped) return {decided: false};
    // input prepares the same pixel statistics and library used by normal style
    // checks, but does not call a model or run the station's after/publish hook.
    await definition.input(ctx);
    for (const candidate of candidates) {
      if (Check(definition.schema, candidate) && !(definition.check?.(candidate as Parameters<NonNullable<typeof definition.check>>[0], ctx) ?? []).length) accepted.push(candidate);
    }
  } else if (name === 'shot-rules' || name === 'program:shot-rules') {
    const data = ctx.token.data;
    if (data.mode === 'video') return {decided: false};
    const role = posts[0]?.field.split('.')[1];
    const images = rows(data.images);
    const originals = [...Object.values(record(data.shots)), ...images];
    for (const candidate of candidates) {
      ctx.signal.throwIfAborted();
      // A program can verify captured bytes, not invent a replacement URL or
      // certify a new model-authored capture record without provenance.
      if (!originals.some(value => isDeepStrictEqual(value, candidate))) continue;
      const proposed = record(candidate);
      const image = images.find(image => typeof proposed.evidence === 'string' && image.evidence === proposed.evidence || typeof proposed.src === 'string' && image.src === proposed.src);
      const reference = image?.src ?? proposed.src;
      const file = typeof reference === 'string' ? store.resolve(reference) : undefined;
      if (!file || !fs.existsSync(file)) continue;
      const otherHashes = images.filter(other => other !== image && typeof other.ahash === 'string').map(other => String(other.ahash));
      const checked = await checkImage(fs.readFileSync(file), otherHashes, {signal: ctx.signal});
      const breadth = role === 'breadth' ? record(record(data.shots).breadth) : undefined;
      const issues = [...checked.issues, ...(breadth ? breadthPreviewIssues(String(data.kind ?? ''), breadth.previews, breadth.visual as never) : [])];
      if (!issues.length) accepted.push(candidate);
    }
  }
  ctx.signal.throwIfAborted();
  return accepted.length === 1 ? {decided: true, value: structuredClone(accepted[0])} : {decided: false};
}
