import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

type JsonObject = Record<string, unknown>;
const EXTRA = 'docs/verification/extra-200-20261013';
const CONTINUOUS = 'docs/verification/continuous-intake-20261014';
const DEFAULT_ID = 'vislexicon-20261014';
const ROLES = ['identity', 'breadth', 'proof'] as const;
const KINDS = ['classification', 'shots', 'facts', 'copy', 'final'] as const;

export interface ExternalIntakeAttachment {
  readonly kind: string;
  readonly sourcePath: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ExternalIntakeCandidate {
  readonly entryId: string;
  readonly ordinal: number;
  readonly title: string;
  readonly url: string;
  readonly observationOrdinals: readonly number[];
  readonly disposition: 'published' | 'excluded' | 'alias' | 'continue';
  readonly nextGap: string;
  readonly stages: {
    readonly facts: 'missing' | 'pending' | 'passed' | 'content-blocked';
    readonly plan: 'missing' | 'partial' | 'three-roles';
    readonly precopy: boolean;
    readonly capturedRoles: readonly string[];
    readonly fullDraft: boolean;
    readonly currentFiveKindApproval: boolean;
    readonly contentDigest: string | null;
  };
  readonly publication: JsonObject | null;
  readonly holds: readonly string[];
  readonly captureStatus?: string;
  readonly captureBlockers?: readonly string[];
  readonly attachments: readonly ExternalIntakeAttachment[];
  /** Exact files used for current stage decisions; old manifests may omit this. */
  readonly currentAttachments?: {
    readonly facts?: ExternalIntakeAttachment;
    readonly plan?: ExternalIntakeAttachment;
    readonly precopy?: ExternalIntakeAttachment;
  };
}

export interface ExternalIntakeManifest {
  readonly schemaVersion: 1;
  readonly intakeId: string;
  readonly sourceRoot: string;
  readonly storageDir: string;
  readonly manifestPath: string;
  readonly inventorySha256: string;
  readonly importedAt: string;
  readonly alreadyPresent: boolean;
  readonly publicationEvidenceScope: 'saved-main-receipt';
  readonly summary: {
    readonly rawObservations: number;
    readonly uniqueEntryIds: number;
    readonly facts: number;
    readonly factsPassed: number;
    readonly factsBlocked: number;
    readonly factsPending: number;
    readonly published: number;
    readonly unpublishedFacts: number;
    readonly continuationCandidates: number;
    readonly threeRolePlans: number;
    readonly fullDrafts: number;
    readonly currentFiveKindApprovals: number;
  };
  readonly candidates: readonly ExternalIntakeCandidate[];
  readonly files: readonly ExternalIntakeAttachment[];
  readonly warnings: readonly string[];
}

export interface ImportExternalIntakeOptions {
  readonly sourceRoot: string;
  readonly projectDir: string;
  readonly intakeId?: string;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ?
    value as JsonObject : {};
}

function rows(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object) : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function hash(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function intakeDir(projectDir: string, intakeId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(intakeId)) {
    throw new Error('Invalid external intake identifier');
  }
  return path.join(path.resolve(projectDir), 'context', 'external-intake', intakeId);
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) &&
    relative !== '..' && !path.isAbsolute(relative));
}

function resolvedDestination(destination: string): string {
  let existing = path.resolve(destination);
  const suffix: string[] = [];
  while (!fs.existsSync(existing)) {
    suffix.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}

function sourceFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
      const file = path.join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error(`Source link is not supported: ${file}`);
      if (item.isDirectory()) visit(file);
      else if (item.isFile()) result.push(path.relative(root, file).split(path.sep).join('/'));
    }
  };
  for (const relative of [EXTRA, CONTINUOUS]) {
    const directory = path.join(root, relative);
    if (fs.existsSync(directory)) visit(directory);
  }
  return result.sort();
}

function immutableWrite(file: string, bytes: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  try {
    fs.writeFileSync(file, bytes, {flag: 'wx'});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!fs.readFileSync(file).equals(Buffer.from(bytes))) {
      throw new Error(`Immutable external intake artifact changed: ${file}`);
    }
  }
}

function attachmentKind(sourcePath: string): string {
  if (/\/facts-drafts\/[^/]+\.json$/.test(sourcePath)) return 'facts';
  if (/\.facts-pre-review\.json$/.test(sourcePath)) return 'facts-review';
  if (/\/plans\/[^/]+\.json$/.test(sourcePath)) return 'plan';
  if (/\.precopy\.json$/.test(sourcePath)) return 'precopy';
  if (/\/sources\//.test(sourcePath)) return 'source';
  if (/\/drafts\/[^/]+\.json$/.test(sourcePath) || /\/records\/[^/]+\.json$/.test(sourcePath)) return 'draft';
  if (/\/reviews\/[^/]+\.json$/.test(sourcePath)) return 'review';
  if (/\/captures\//.test(sourcePath)) return 'capture';
  return 'source';
}

function commitPointer(manifest: ExternalIntakeManifest): void {
  const receiptPath = path.join(manifest.storageDir, 'receipts.jsonl');
  const lines = fs.existsSync(receiptPath) ? fs.readFileSync(receiptPath, 'utf8').split(/\r?\n/) : [];
  const recorded = lines.some(line => {
    if (!line.trim()) return false;
    try {
      const receipt = object(JSON.parse(line) as unknown);
      return receipt.inventorySha256 === manifest.inventorySha256 &&
        receipt.manifestPath === manifest.manifestPath;
    }
    catch { return false; }
  });
  if (!recorded) fs.appendFileSync(receiptPath, `${JSON.stringify({
    importedAt: manifest.importedAt, inventorySha256: manifest.inventorySha256,
    manifestPath: manifest.manifestPath, rawObservations: manifest.summary.rawObservations,
    sourcePreserved: true,
  })}\n`);
  const pointer = path.join(manifest.storageDir, 'current.json');
  const pointerBytes = `${JSON.stringify({manifestPath: manifest.manifestPath,
    inventorySha256: manifest.inventorySha256})}\n`;
  if (fs.existsSync(pointer) && fs.readFileSync(pointer, 'utf8') === pointerBytes) return;
  const temporary = `${pointer}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, pointerBytes, {flag: 'wx'});
  fs.renameSync(temporary, pointer);
}

/** Import immutable source bytes and a conservative continuation index. No network,
 * token creation, publication, source mutation, or domain-based identity merging. */
export function importExternalIntake(options: ImportExternalIntakeOptions): ExternalIntakeManifest {
  const sourceRoot = fs.realpathSync(options.sourceRoot);
  const intakeId = options.intakeId ?? DEFAULT_ID;
  const storageDir = resolvedDestination(intakeDir(options.projectDir, intakeId));
  if (inside(sourceRoot, storageDir)) throw new Error('External intake destination must be outside its source');
  const names = sourceFiles(sourceRoot);
  if (!names.includes(`${EXTRA}/selection.json`)) throw new Error('Missing external candidate selection');
  const files: ExternalIntakeAttachment[] = [];
  const inventory = new Map<string, ExternalIntakeAttachment>();
  for (const sourcePath of names) {
    const bytes = fs.readFileSync(path.join(sourceRoot, sourcePath));
    const sha256 = hash(bytes);
    const extension = path.extname(sourcePath).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 12);
    const destination = path.join(storageDir, 'objects', sha256.slice(0, 2), `${sha256}${extension}`);
    immutableWrite(destination, bytes);
    const attachment = {kind: attachmentKind(sourcePath), sourcePath, path: destination, sha256, bytes: bytes.length};
    files.push(attachment);
    inventory.set(sourcePath, attachment);
  }
  const inventorySha256 = hash(JSON.stringify(files.map(file =>
    [file.sourcePath, file.sha256, file.bytes])));
  // Index revisions retain prior immutable snapshots for the same raw inventory.
  const manifestPath = path.join(storageDir, 'snapshots', `${inventorySha256}.v3.json`);
  const warnings: string[] = [];
  const load = (relative: string): JsonObject => {
    const file = inventory.get(relative);
    if (!file) return {};
    try { return object(JSON.parse(fs.readFileSync(file.path, 'utf8')) as unknown); }
    catch { warnings.push(`Invalid JSON retained: ${relative}`); return {}; }
  };
  const jsonLines = (relative: string): JsonObject[] => {
    const file = inventory.get(relative);
    if (!file) return [];
    const result: JsonObject[] = [];
    for (const line of fs.readFileSync(file.path, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { result.push(object(JSON.parse(line) as unknown)); }
      catch { warnings.push(`Invalid JSONL line retained: ${relative}`); }
    }
    return result;
  };
  const selection = rows(load(`${EXTRA}/selection.json`).candidates);
  if (!selection.length) throw new Error('External selection contains no observations');
  const statuses = new Map(rows(load(`${EXTRA}/candidate-status.json`).items)
    .map(item => [text(item.entryId), item]));
  const receipts = jsonLines(`${EXTRA}/sync-receipts.jsonl`);
  const lanes = ['lane-a', 'lane-b'].map(lane => load(`${CONTINUOUS}/${lane}/status.json`));
  const captureStatuses = new Map<string, {entry: JsonObject; updatedAt: number}>();
  for (const lane of ['lane-a', 'lane-b']) {
    const captureStatus = load(`${CONTINUOUS}/${lane}/capture-status.json`);
    for (const entry of rows(captureStatus.entries)) {
      const entryId = text(entry.entryId);
      const updatedAt = Date.parse(text(entry.updatedAt) || text(captureStatus.updatedAt)) || 0;
      if (entryId && (!captureStatuses.has(entryId) ||
          updatedAt >= captureStatuses.get(entryId)!.updatedAt)) {
        captureStatuses.set(entryId, {entry, updatedAt});
      }
    }
  }
  const byId = new Map<string, JsonObject[]>();
  for (const row of selection) {
    const entryId = text(object(row.observation).id) || text(row.entryId);
    if (!entryId) throw new Error('Source observation has no exact entryId');
    const prior = byId.get(entryId) ?? [];
    prior.push(row);
    byId.set(entryId, prior);
  }
  const candidates: ExternalIntakeCandidate[] = [];
  for (const [entryId, observations] of byId) {
    const first = observations[0];
    const observation = object(first.observation);
    const url = (text(observation.canonicalUrl) || text(observation.url) || text(first.url)).trim();
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
    } catch {
      throw new Error(`External candidate requires a valid HTTP URL: ${entryId}`);
    }
    const attachments = files.filter(file => file.sourcePath.split('/').some(part =>
      part === entryId || part.startsWith(`${entryId}.`)));
    const fileOf = (relative: string) => inventory.get(relative);
    const factPath = `${EXTRA}/facts-drafts/${entryId}.json`;
    const fact = fileOf(factPath);
    let facts: ExternalIntakeCandidate['stages']['facts'] = fact ? 'pending' : 'missing';
    for (const lane of ['lane-a', 'lane-b']) {
      const review = load(`${CONTINUOUS}/${lane}/reviews/${entryId}.facts-pre-review.json`);
      if (!fact || review.factsDraftSha256 !== fact.sha256) continue;
      if (review.verdict === 'pass-for-facts-only') facts = 'passed';
      if (review.verdict === 'pass-for-facts-only-with-retained-content-blockers') facts = 'content-blocked';
    }
    const lanePlans = ['lane-b', 'lane-a'].map(lane => `${CONTINUOUS}/${lane}/plans/${entryId}.json`);
    const planPath = lanePlans.find(candidate => fileOf(candidate)) ?? `${EXTRA}/plans/${entryId}.json`;
    const plan = load(planPath);
    const pages = rows(plan.pages);
    const threeRolePlan = ROLES.every(role => pages.some(page => page.role === role && text(page.url)));
    const planStage = !fileOf(planPath) ? 'missing' : threeRolePlan ? 'three-roles' : 'partial';
    const observationPath = `${EXTRA}/captures/${entryId}/observation.json`;
    const capture = load(observationPath);
    const capturedRoles = ROLES.filter(role => rows(capture.pages).some(page => {
      const shot = object(page.shot);
      const image = fileOf(`${EXTRA}/captures/${entryId}/${text(page.file)}`);
      return page.role === role && image && shot.sha256 === image.sha256 &&
        object(page.pixelStats).flatBlock !== true && rows(page.issues).length === 0;
    }));
    const draftPaths = ['lane-b', 'lane-a'].map(lane => `${CONTINUOUS}/${lane}/drafts/${entryId}.json`);
    const draftPath = draftPaths.find(candidate => fileOf(candidate)) ?? `${EXTRA}/records/${entryId}.json`;
    const draftFile = fileOf(draftPath);
    const draft = load(draftPath);
    const digest = text(draft.digest) || null;
    const review = load(`${EXTRA}/reviews/${entryId}.json`);
    const reviewRows = rows(review.reviews);
    const currentApproval = Boolean(draftFile && digest && review.digest === digest &&
      review.draftFileSha256 === draftFile.sha256 &&
      KINDS.every(kind => reviewRows.some(item => item.kind === kind && item.verdict === 'pass' &&
        item.digest === digest)) && capturedRoles.length === 3);
    const publication = receipts.filter(receipt => receipt.entryId === entryId &&
      receipt.sourceSynchronized === true && receipt.publicProjectionVerified === true &&
      receipt.remotePushed === true && /^[a-f0-9]{40}$/i.test(text(receipt.gitCommit)))
      .sort((a, b) => text(a.at).localeCompare(text(b.at))).at(-1) ?? null;
    const holds: string[] = [];
    let disposition: ExternalIntakeCandidate['disposition'] = publication ? 'published' : 'continue';
    for (const lane of lanes) {
      if (Array.isArray(lane.scopeExclusions) && lane.scopeExclusions.includes(entryId) && !publication) {
        disposition = 'excluded';
      }
      for (const hold of [...rows(lane.identityHolds), ...rows(lane.captureHolds)]) {
        if (hold.entryId !== entryId) continue;
        if (text(hold.reason)) holds.push(text(hold.reason));
        if (Array.isArray(hold.blockers)) holds.push(...hold.blockers.filter((item): item is string => typeof item === 'string'));
        if (hold.status === 'accepted-alias' && !publication) disposition = 'alias';
      }
    }
    const status = statuses.get(entryId);
    if (!publication && status?.pushed === true) {
      // A status flag is not publication evidence, but do not silently refuel it.
      holds.push('Source claims pushed without a qualifying saved receipt; reconcile before feeding');
    }
    const precopyPath = ['lane-b', 'lane-a'].map(lane =>
      `${CONTINUOUS}/${lane}/materials/${entryId}.precopy.json`).find(candidate => fileOf(candidate));
    const precopyFile = precopyPath ? fileOf(precopyPath) : undefined;
    const precopy = Boolean(precopyFile);
    const captureStatus = captureStatuses.get(entryId)?.entry;
    const captureBlockers = captureStatus ? [
      ...(Array.isArray(captureStatus.blockers) ? captureStatus.blockers.filter(
        (value): value is string => typeof value === 'string') : []),
      ...rows(captureStatus.roles).filter(item => item.status === 'capture-held' && text(item.reason))
        .map(item => `${text(item.role)}: ${text(item.reason)}`),
    ] : [];
    let nextGap: string = disposition;
    if (disposition === 'continue') {
      if (facts === 'missing' || facts === 'pending') nextGap = 'facts-review';
      else if (facts === 'content-blocked') nextGap = 'source-content';
      else if (planStage !== 'three-roles') nextGap = 'capture-plan';
      else if (capturedRoles.length < 3) nextGap = 'capture';
      else if (!draftFile || !digest) nextGap = 'draft';
      else if (!currentApproval) nextGap = 'independent-review';
      else nextGap = 'publication';
    }
    candidates.push({entryId, ordinal: Number(first.selectionOrdinal) || 0,
      title: text(observation.name) || text(first.name) || entryId,
      url,
      observationOrdinals: observations.map(item => Number(item.selectionOrdinal) || 0),
      disposition, nextGap, stages: {facts, plan: planStage, precopy,
        capturedRoles, fullDraft: Boolean(draftFile && digest),
        currentFiveKindApproval: currentApproval, contentDigest: digest},
      publication, holds: [...new Set(holds)], attachments,
      ...(captureStatus ? {captureStatus: text(captureStatus.status),
        captureBlockers: [...new Set(captureBlockers)]} : {}),
      currentAttachments: {facts: fact, plan: fileOf(planPath), precopy: precopyFile}});
  }
  // Recheck the source after copying. Changed or added bytes remain uncommitted
  // objects; the previous current manifest stays authoritative on failure.
  if (JSON.stringify(sourceFiles(sourceRoot)) !== JSON.stringify(names)) {
    throw new Error('External source file inventory changed during import');
  }
  for (const file of files) {
    if (hash(fs.readFileSync(path.join(sourceRoot, file.sourcePath))) !== file.sha256) {
      throw new Error(`External source changed during import: ${file.sourcePath}`);
    }
  }
  if (fs.existsSync(manifestPath)) {
    const existing = parseManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown);
    commitPointer(existing);
    return {...existing, alreadyPresent: true};
  }
  const manifest: ExternalIntakeManifest = {
    schemaVersion: 1, intakeId, sourceRoot, storageDir, manifestPath,
    inventorySha256, importedAt: new Date().toISOString(), alreadyPresent: false,
    publicationEvidenceScope: 'saved-main-receipt',
    summary: {
      rawObservations: selection.length, uniqueEntryIds: candidates.length,
      facts: candidates.filter(item => item.stages.facts !== 'missing').length,
      factsPassed: candidates.filter(item => item.stages.facts === 'passed').length,
      factsBlocked: candidates.filter(item => item.stages.facts === 'content-blocked').length,
      factsPending: candidates.filter(item => item.stages.facts === 'pending').length,
      published: candidates.filter(item => item.disposition === 'published').length,
      unpublishedFacts: candidates.filter(item => item.disposition !== 'published' && item.stages.facts !== 'missing').length,
      continuationCandidates: candidates.filter(item => item.disposition === 'continue').length,
      threeRolePlans: candidates.filter(item => item.stages.plan === 'three-roles').length,
      fullDrafts: candidates.filter(item => item.stages.fullDraft).length,
      currentFiveKindApprovals: candidates.filter(item => item.stages.currentFiveKindApproval).length,
    }, candidates, files, warnings,
  };
  immutableWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  commitPointer(manifest);
  return manifest;
}

function parseManifest(value: unknown): ExternalIntakeManifest {
  const record = object(value);
  if (record.schemaVersion !== 1 || !Array.isArray(record.candidates) ||
      !Array.isArray(record.files) || !text(record.inventorySha256) || !text(record.storageDir)) {
    throw new Error('Invalid external intake manifest');
  }
  return record as unknown as ExternalIntakeManifest;
}

export function readExternalIntake(projectDir: string, intakeId = DEFAULT_ID): ExternalIntakeManifest | null {
  const directory = intakeDir(projectDir, intakeId);
  const pointer = path.join(directory, 'current.json');
  if (!fs.existsSync(pointer)) return null;
  const current = object(JSON.parse(fs.readFileSync(pointer, 'utf8')) as unknown);
  const manifestPath = text(current.manifestPath);
  if (!inside(path.join(directory, 'snapshots'), manifestPath)) throw new Error('Invalid intake manifest path');
  return parseManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown);
}

/** Return only copied immutable attachments. Verify bytes again at reuse time. */
export function externalIntakeAttachments(manifest: ExternalIntakeManifest,
    entryId: string): readonly ExternalIntakeAttachment[] {
  const candidate = manifest.candidates.find(item => item.entryId === entryId);
  if (!candidate) throw new Error(`Unknown external entryId: ${entryId}`);
  for (const file of candidate.attachments) {
    if (!inside(path.join(manifest.storageDir, 'objects'), file.path) ||
        hash(fs.readFileSync(file.path)) !== file.sha256) {
      throw new Error(`External attachment integrity failure: ${file.sourcePath}`);
    }
  }
  return candidate.attachments;
}
