import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {aHashAsync, type EvidenceStore} from './evidence.ts';
import type {StationContext, StationResult} from './runtime.ts';

type JsonObject = Record<string, unknown>;
type Role = 'identity' | 'breadth' | 'proof';
interface Attachment {
  readonly path: string;
  readonly sourcePath: string;
  readonly sha256: string;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ?
    value as JsonObject : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function attachment(value: unknown): Attachment | null {
  const ref = object(value);
  return text(ref.path) && text(ref.sourcePath) && /^[0-9a-f]{64}$/i.test(text(ref.sha256)) ?
    {path: text(ref.path), sourcePath: text(ref.sourcePath).replaceAll('\\', '/'),
      sha256: text(ref.sha256)} : null;
}

function references(value: unknown): Attachment[] {
  return Array.isArray(value) ? value.map(attachment).filter((ref): ref is Attachment => ref !== null) : [];
}

function read(ref: Attachment): Buffer {
  const bytes = fs.readFileSync(ref.path);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== ref.sha256) {
    throw new Error(`External capture attachment integrity failure: ${ref.sourcePath}`);
  }
  return bytes;
}

function readObject(ref: Attachment): JsonObject {
  return object(JSON.parse(read(ref).toString('utf8')) as unknown);
}

function roleVerdict(role: Role, value: unknown): boolean {
  const verdict = text(value);
  const accepted = [
    `pass-for-${role}-image-pre-review-only`,
    `${role}-visible-only-pending-full-record-review`,
  ];
  if (role === 'identity') accepted.push('identity-readable-only-pending-full-role-review');
  return accepted.includes(verdict);
}

/** Recover an observed role, never a new role approval. Current image processing,
 * semantic review and publication gates still execute normally after this step. */
export async function reuseExternalCapture(ctx: StationContext,
    store: EvidenceStore): Promise<StationResult | null> {
  if (ctx.redo || !/^curation\/(identity|breadth|proof)$/.test(ctx.node.key)) return null;
  const role = ctx.node.key.slice('curation/'.length) as Role;
  const research = object(ctx.token.data.externalResearch);
  const entryId = text(research.entryId);
  const intakeId = text(research.intakeId);
  if (!entryId || !intakeId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(entryId)) return null;
  const captures = references(research.captures);
  const reviews = references(research.reviews);
  const suffix = `/captures/${entryId}/observation.json`;
  const observations = captures.filter(ref => ref.sourcePath.endsWith(suffix));
  if (observations.length !== 1) return null;
  const observationRef = observations[0];
  const observation = readObject(observationRef);
  if (observation.entryId !== entryId || !Array.isArray(observation.pages)) return null;
  const pages = observation.pages.map(object).filter(page => page.role === role);
  if (pages.length !== 1) return null;
  const page = pages[0];
  if ((Array.isArray(page.issues) && page.issues.length > 0) ||
      object(page.pixelStats).flatBlock === true) return null;
  const sourceUrl = text(page.sourceUrl);
  const finalUrl = text(page.finalUrl) || sourceUrl;
  if (!/^https?:\/\//i.test(sourceUrl) || !/^https?:\/\//i.test(finalUrl)) return null;
  const file = text(page.file);
  if (!file || path.basename(file) !== file || !file.endsWith('.webp')) return null;
  const imageRefs = captures.filter(ref => ref.sourcePath ===
    observationRef.sourcePath.slice(0, -'observation.json'.length) + file);
  if (imageRefs.length !== 1) return null;
  const imageRef = imageRefs[0];
  const bytes = read(imageRef);
  const imageSha = text(object(page.shot).sha256);
  if (imageSha !== imageRef.sha256) throw new Error('External capture observation image integrity failure');
  let accepted: {ref: Attachment; review: JsonObject; image: JsonObject} | null = null;
  for (const ref of reviews.filter(ref =>
    ref.sourcePath.endsWith(`/reviews/${entryId}.images-pre-review.json`))) {
    const review = readObject(ref);
    if (review.entryId !== entryId || !text(review.reviewerId) ||
        review.observationFileSha256 !== observationRef.sha256 || !Array.isArray(review.images)) continue;
    const images = review.images.map(object).filter(image => image.role === role);
    if (images.length !== 1) continue;
    const image = images[0];
    if (image.actuallyViewed !== true || !roleVerdict(role, image.verdict) || !text(image.finding)) continue;
    if (image.file !== file || image.sourceUrl !== sourceUrl ||
        (text(image.finalUrl) || sourceUrl) !== finalUrl) continue;
    if (image.sha256 !== imageSha) throw new Error('External capture independent image integrity failure');
    if (accepted) return null;
    accepted = {ref, review, image};
  }
  if (!accepted) return null;
  ctx.signal.throwIfAborted();
  const hash = await aHashAsync(bytes, {signal: ctx.signal});
  ctx.signal.throwIfAborted();
  const saved = store.put(bytes, 'webp');
  if (saved.sha !== imageSha) throw new Error('External capture evidence copy integrity failure');
  const provenance = {
    intakeId, entryId, role, sourceUrl, finalUrl,
    observation: observationRef, image: imageRef, review: accepted.ref,
    originalRoleVerdict: accepted.image.verdict,
    originalReviewVerdict: accepted.review.verdict,
    reviewerId: accepted.review.reviewerId, reviewedAt: accepted.review.reviewedAt,
    roleObservation: page, roleReview: accepted.image,
    sourceObservation: observation.sourceObservation ?? null,
    captureAttachments: captures,
    reuseScope: 'historical-role-observation-awaiting-current-review',
  };
  const evidence = ctx.addEvidence({
    id: `external-${role}-${saved.sha.slice(0, 16)}-${ctx.attempt}`,
    kind: 'image', src: saved.src, card: saved.src,
    label: `历史原站图 · ${role}`, meta: provenance,
  });
  const shots = {...object(ctx.token.data.shots), [role]: {
    file: saved.file, href: finalUrl, hash, evidence: evidence.id, title: text(page.title),
  }};
  const externalCaptureReuse = {...object(ctx.token.data.externalCaptureReuse), [role]: provenance};
  ctx.progress(`复用历史 ${role} 原图；保留原审核结论，等待本轮图片审核`,
    {tool: 'continuation', text: imageSha, ok: true});
  return {ok: true, summary: `复用历史 ${role} 角色观察`,
    data: {shots, externalCaptureReuse}};
}
