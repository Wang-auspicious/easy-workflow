// An explicit new proof input for an exhausted manual checkpoint, never a retry
// allowance or an imported review. Raw captures and old decisions remain immutable.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {Factory} from './factory.ts';
import type {TokenState} from '../shared/project.ts';
import {latestRunTokens, recoveryKey} from '../shared/project.ts';
import {ControlError} from './errors.ts';
import {hamming} from './evidence.ts';
import {checkImage, pageKey} from '../packs/vislexicon/capture.ts';
import {VIS_ROOT} from '../packs/vislexicon/env.ts';

type ObjectValue = Record<string, unknown>;
type Actor = 'agent' | 'dispatcher' | 'user';
interface FileRef {path: string; sha256: string}
interface CaptureInput {
  role: string;
  manifest: ObjectValue;
  imageRef: FileRef;
  imageBytes: Buffer;
  stateBytes: Buffer;
  observationBytes: Buffer;
  state: ObjectValue;
  hash: string;
  native: boolean;
  ext: string;
  targetDecision?: ObjectValue;
}
export interface ProofSupplementRequest {
  token: string;
  runId: string;
  expectedCheckpointSha256: string;
  idempotencyKey: string;
  manifestPath: string;
  manifestSha256: string;
  reason: string;
}

const DOWNSTREAM = ['process', 'shot-review', 'style', 'copy', 'copy-review', 'assemble', 'audit', 'gate', 'published', 'manual'].map(key => `curation/${key}`);
const sha = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const fail = (code: string, message: string): never => {throw new ControlError(409, code, message);};
const same = isDeepStrictEqual;
const website = (token: TokenState) => ['candidates', 'curation'].includes(token.line) && !token.data.workflowPack && !token.data.channelDelivery;

function replay(f: Factory, p: ProofSupplementRequest, requestSha256: string): ObjectValue | undefined {
  for (const token of Object.values(f.state.tokens)) {
    const receipt = object(token.data.proofSupplementReceipt);
    if (receipt.idempotencyKey !== p.idempotencyKey || receipt.runId !== p.runId) continue;
    if (receipt.requestSha256 !== requestSha256) fail('supplement_idempotency_conflict', '同一补证 key 不能对应不同请求');
    return {...receipt, alreadyPresent: true};
  }
  return undefined;
}

/** Read through inspect; unrelated journal traffic does not invalidate this CAS. */
export function proofCheckpointSha256(f: Factory, token: TokenState): string | undefined {
  if (!website(token)) return undefined;
  return sha(JSON.stringify({spec: f.compiled.digest, run: f.state.run.id, token: token.id,
    status: token.status, finishedAt: token.finishedAt, rounds: token.rounds, data: token.data}));
}

function keys(value: ObjectValue, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('supplement_manifest_invalid', '补证清单含不支持字段；不能导入审核或任意业务补丁');
}

function ref(value: unknown): FileRef {
  const source = object(value);
  keys(source, ['path', 'sha256']);
  if (!string(source.path) || !/^[a-f0-9]{64}$/.test(string(source.sha256))) fail('supplement_manifest_invalid', '补证文件需要路径和原始 SHA256');
  return {path: string(source.path), sha256: string(source.sha256)};
}

function roots(f: Factory): string[] {
  return [...new Set([f.project.dir, VIS_ROOT, f.externalIntake?.sourceRoot, f.externalIntake?.storageDir]
    .filter((root): root is string => Boolean(root && fs.existsSync(root))).map(root => fs.realpathSync(root)))];
}

function readFile(file: string, approved: string[], base: string, maxBytes: number): Buffer {
  const real = fs.realpathSync(path.resolve(base, file));
  if (!approved.some(root => {
    const relative = path.relative(root, real);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  })) fail('supplement_path_outside_root', '补证文件超出项目或已配置资料根目录');
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) fail('supplement_file_invalid', '补证文件格式或大小不符合限额');
  return fs.readFileSync(real);
}

function readBound(file: FileRef, approved: string[], base: string, maxBytes = 8 << 20): Buffer {
  const bytes = readFile(file.path, approved, base, maxBytes);
  if (sha(bytes) !== file.sha256) fail('supplement_integrity', '补证原始字节与 SHA256 不符');
  return bytes;
}

function json(bytes: Buffer): ObjectValue {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (Object.keys(object(value)).length) return object(value);
  } catch { /* The caller receives a stable validation error. */ }
  return fail('supplement_manifest_invalid', '补证 JSON 必须是非空对象');
}

function entry(token: TokenState): string {return string(object(token.data.externalResearch).entryId);}

function captureView(state: ObjectValue): ObjectValue {
  const view = {...state};
  // These are derived process bindings, not changes to the original browser
  // observation. The image bytes are independently bound to their real SHA.
  delete view.sha256;
  delete view.finalWebPSha256;
  return view;
}

function checkpoint(f: Factory, p: ProofSupplementRequest): {previous: TokenState; saved: ObjectValue} {
  const previous = f.state.tokens[p.token];
  if (!previous || !website(previous) || previous.status !== 'manual' || previous.finishedAtNode !== 'curation/manual' ||
      !latestRunTokens(f.state).some(token => token.id === p.token) || previous.data.retriedBy) {
    return fail('supplement_target_changed', '仅当前轮次尚未领取的精确待人工网站任务可补证');
  }
  if (!f.runtime.running || !f.runtime.paused || f.runtime.ending || f.state.run.status !== 'paused' ||
      p.runId !== f.state.run.id || [...f.runtime.workers.values()].some(pool => pool.some(worker => worker.busy)) ||
      [...f.runtime.tokens.values()].some(token => token.inflight.size)) {
    return fail('supplement_run_not_quiescent', '补证仅能在原轮次暂停且所有在途工位退出后接入；接口保持暂停');
  }
  if (f.state.digest !== f.compiled.digest || proofCheckpointSha256(f, previous) !== p.expectedCheckpointSha256) {
    return fail('supplement_checkpoint_changed', '原规格或检查点已变化，请重新读取任务再选择补证');
  }
  if (previous.data.proofSupplementReceipt) return fail('supplement_already_used', '该人工停点的后继已使用一次补证，不能新增纠错次数');
  const saved = object(previous.data.runtimeCheckpoint);
  const original = f.runtime.tokens.get(previous.id);
  const done = saved.done;
  const rounds = object(saved.rounds);
  if (!original?.finished || saved.version !== 1 || !f.runtime.nodes.has(string(saved.entry)) ||
      !Array.isArray(done) || !done.every(key => typeof key === 'string' && f.runtime.nodes.has(key)) ||
      !Object.values(rounds).every(value => Number.isSafeInteger(value) && Number(value) >= 0) ||
      !saved.rounds || Array.isArray(saved.rounds) || !same(saved.rounds, original.rounds) ||
      !Array.isArray(saved.notes) || !saved.notes.every(note => Array.isArray(note) && note.length === 2 &&
        typeof note[0] === 'string' && typeof object(note[1]).reason === 'string' && typeof object(note[1]).byHuman === 'boolean') ||
      saved.consult || original.consult || saved.pendingConsults && !Array.isArray(saved.pendingConsults) ||
      (Array.isArray(saved.pendingConsults) && saved.pendingConsults.length > 0) || original.pendingConsults?.length) {
    return fail('supplement_checkpoint_missing', '需完整原检查点且无未解决的并行审核会话，不能猜测恢复入口');
  }
  const required = ['plan', 'identity', 'breadth', 'facts', 'fact-review'].map(key => `curation/${key}`);
  const facts = object(previous.data.facts);
  if (!entry(previous) || entry(previous) !== previous.item || previous.data.mode !== 'shots' ||
      !required.every(key => done.includes(key)) || previous.data['fact-reviewVerdict'] !== 'pass' ||
      !['author', 'organization', 'repository', 'license', 'pricing', 'sourceCode', 'commercial'].every(key => object(facts[key]).value !== undefined)) {
    return fail('supplement_upstream_incomplete', '补证必须保留完整原 Entry、两张原图及已完成的事实分支');
  }
  return {previous, saved};
}

function nativeCapture(f: Factory, manifest: ObjectValue, image: FileRef): ObjectValue | undefined {
  const origin = object(manifest.origin);
  const role = string(manifest.role);
  if (origin.kind === 'attempt') {
    keys(origin, ['kind', 'token', 'attempt', 'evidence']);
    const token = f.state.tokens[string(origin.token)];
    const attempt = f.state.attempts[string(origin.attempt)];
    const evidence = f.state.evidence[string(origin.evidence)];
    if (!token || !website(token) || entry(token) !== manifest.entryId || !attempt?.endedAt || !attempt.ok || attempt.cancelled ||
        attempt.token !== token.id || attempt.node !== `curation/${role}` || !evidence || evidence.token !== token.id ||
        evidence.attempt !== attempt.id || evidence.station !== `curation/${role}` || object(evidence.meta).role !== role) {
      fail('supplement_origin_invalid', '历史补证缺少该 Entry 的真实 proof attempt 与原证据绑定');
    }
    let state = string(evidence!.src).includes(image.sha256) ? object(object(evidence!.meta).captureState) : undefined;
    // Full-size process output can differ from the capture evidence card. Retain
    // that actual journal binding rather than pretending the 720 card is native.
    if (!state) for (const event of f.journal.read()) {
      if (event.kind !== 'token.data' || event.token !== token!.id) continue;
      const shot = object(object(event.patch.shots)[role]);
      const images = Array.isArray(event.patch.images) ? event.patch.images.map(object) : [];
      if (shot.evidence === evidence!.id &&
          (string(shot.file).includes(image.sha256) || images.some(row => row.role === role && row.evidence === evidence!.id && row.sha256 === image.sha256))) {
        const candidate = object(shot.captureState);
        if (same(captureView(object(object(evidence!.meta).captureState)), captureView(candidate))) state = candidate;
      }
    }
    if (!state) fail('supplement_origin_invalid', '原 attempt、图像与取景 state 没有实际 SHA 绑定');
    return state;
  } else if (origin.kind === 'observation') {
    keys(origin, ['kind']);
  } else fail('supplement_origin_invalid', '补证需真实原 attempt 或原生采集 observation/receipt');
  return undefined;
}

function imageSize(bytes: Buffer): {width: number; height: number} | undefined {
  if (bytes.length < 30) return undefined;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
  }
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return undefined;
  switch (bytes.toString('ascii', 12, 16)) {
    case 'VP8 ': return {width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff};
    case 'VP8L': {
      const value = bytes.readUInt32LE(21);
      return {width: (value & 0x3fff) + 1, height: ((value >> 14) & 0x3fff) + 1};
    }
    case 'VP8X': return {width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3)};
    default: return undefined;
  }
}

function sourceAllowed(previous: TokenState, role: string, sourceUrl: string, finalUrl: string, saved: ObjectValue,
    suppliedDecision?: unknown): ObjectValue | undefined {
  const targetKey = (href: string) => {
    try {
      const url = new URL(href);
      url.hostname = url.hostname.replace(/^www\./, '');
      return pageKey(url.href);
    } catch {return pageKey(href);}
  };
  const targets = (targetRole: string) => {
    const plan = object(object(previous.data.readerPlan)[targetRole]);
    const owner = object(object(previous.data.ownerCaptureTargets)[targetRole]);
    const candidates = [plan.url, owner.url,
      ...(Array.isArray(plan.alternatives) ? plan.alternatives.map(value => object(value).url) : [])];
    for (const note of Array.isArray(saved.notes) ? saved.notes : []) {
      if (!Array.isArray(note) || note[0] !== `curation/${targetRole}`) continue;
      try { candidates.push(object(object(JSON.parse(string(object(note[1]).note))).captureTarget).url); } catch { /* Ordinary notes are not target declarations. */ }
    }
    return candidates.filter((url): url is string => typeof url === 'string' && /^https?:\/\//.test(url));
  };
  const allowed = new Set([string(previous.data.canonical), ...targets(role)].map(targetKey));
  let decision: ObjectValue | undefined;
  if (suppliedDecision !== undefined) {
    decision = object(suppliedDecision);
    keys(decision, ['fromRole', 'url', 'reason']);
    if (!['identity', 'breadth', 'proof'].includes(string(decision.fromRole)) || decision.fromRole === role ||
        !string(decision.url) || !string(decision.reason).trim()) {
      fail('supplement_target_decision_invalid', '跨角色目标须声明另一真实角色、已知精确 URL 和非空原因；声明不代表审核通过');
    }
    if (!targets(string(decision.fromRole)).some(url => targetKey(url) === targetKey(string(decision!.url))) ||
        targetKey(finalUrl) !== targetKey(string(decision.url))) {
      fail('supplement_source_unplanned', '跨角色补证只能重新指派该 Entry 原角色已知的精确页面，不能新增兄弟页或不同查询/路由');
    }
    allowed.add(targetKey(string(decision.url)));
  }
  try {
    const canonical = new URL(string(previous.data.canonical));
    const source = new URL(sourceUrl), final = new URL(finalUrl);
    if (![source, final].every(url => ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
        url.hostname.replace(/^www\./, '') === canonical.hostname.replace(/^www\./, '')) ||
        !allowed.has(targetKey(finalUrl))) throw new Error();
  } catch {fail('supplement_source_unplanned', '补证必须来自该 Entry 已有的精确 proof 目标，不能仅凭同域导入兄弟内容');}
  return decision;
}

/** Append one observed proof revision and queue only its affected downstream path. */
export async function supplementProof(f: Factory, p: ProofSupplementRequest, actor: Actor) {
  const requestSha256 = sha(JSON.stringify(p));
  const existing = replay(f, p, requestSha256);
  if (existing) return existing;
  const prepared = checkpoint(f, p);
  const {previous, saved} = prepared;
  const approved = roots(f);
  const manifestBytes = readBound({path: p.manifestPath, sha256: p.manifestSha256}, approved, f.project.dir, 1 << 20);
  const manifest = json(manifestBytes);
  keys(manifest, ['schemaVersion', 'entryId', 'role', 'image', 'state', 'observation', 'origin', 'targetDecision', 'additionalCaptures']);
  if (manifest.schemaVersion !== 1 || manifest.entryId !== entry(previous) || manifest.role !== 'proof') fail('supplement_entry_mismatch', '补证清单必须精确绑定当前 Entry 的 proof');
  const extra: unknown[] = manifest.additionalCaptures === undefined ? [] : Array.isArray(manifest.additionalCaptures)
    ? manifest.additionalCaptures : fail('supplement_manifest_invalid', 'additionalCaptures 必须是明确的采集记录列表');
  if (extra.length > 2 || extra.some(value => !['identity', 'breadth'].includes(string(object(value).role))) ||
      new Set(extra.map(value => object(value).role)).size !== extra.length) fail('supplement_manifest_invalid', '仅允许各一份显式 identity/breadth 补证；proof 必选');
  const manifests = [manifest, ...extra.map(object)];
  const inputs: CaptureInput[] = [];
  const base = path.dirname(path.resolve(f.project.dir, p.manifestPath));
  const shots = object(previous.data.shots);
  const priorImages = Array.isArray(previous.data.images) ? previous.data.images.map(object) : [];
  for (const manifest of manifests) {
    keys(manifest, ['schemaVersion', 'entryId', 'role', 'image', 'state', 'observation', 'origin', 'targetDecision', ...(manifest === manifests[0] ? ['additionalCaptures'] : [])]);
    const role = string(manifest.role);
    if (manifest.schemaVersion !== 1 || manifest.entryId !== entry(previous)) fail('supplement_entry_mismatch', '每份补证都必须精确绑定同一 Entry');
    const imageRef = ref(manifest.image);
    const imageBytes = readBound(imageRef, approved, base, 16 << 20);
    const native = nativeCapture(f, manifest, imageRef);
    const stateBytes = manifest.state ? readBound(ref(manifest.state), approved, base, 1 << 20) :
      native ? Buffer.from(JSON.stringify(native)) : fail('supplement_state_invalid', '原生采集 receipt 必须引用实际 state 文件');
    const stateRef = {sha256: sha(stateBytes)};
    const observationBytes = manifest.observation ? readBound(ref(manifest.observation), approved, base) :
      native ? Buffer.from(JSON.stringify({entryId: manifest.entryId, role, origin: manifest.origin,
        sourceUrl: native.sourceUrl, finalUrl: native.finalUrl, capturedAt: native.capturedAt,
        sha256: imageRef.sha256, stateSha256: stateRef.sha256})) : fail('supplement_origin_invalid', '补证需实际采集 observation/receipt');
    const observationRef = {sha256: sha(observationBytes)};
    const rawState = json(stateBytes), observation = json(observationBytes);
    const state = Object.keys(object(rawState.browserState)).length ? {...object(rawState.browserState),
      capturedAt: rawState.capturedAt, sourceUrl: rawState.sourceUrl, finalUrl: rawState.finalUrl,
      sha256: rawState.shotSha256} : rawState;
    const sourceUrl = string(state.sourceUrl), finalUrl = string(state.finalUrl);
    if (native && !same(captureView(native), captureView(state))) fail('supplement_origin_invalid', '导出的 state 快照必须与原 journal 中的取景对象一致');
    if (state.method !== 'browser-native' || !Number.isFinite(Date.parse(string(state.capturedAt))) ||
        !Array.isArray(state.actions) || !Array.isArray(state.controls) || !Array.isArray(object(state.scroll).containers) ||
        !Number.isFinite(object(state.scroll).x) || !Number.isFinite(object(state.scroll).y) ||
        !Number.isSafeInteger(object(state.viewport).width) || !Number.isSafeInteger(object(state.viewport).height) ||
        Number(object(state.viewport).width) < 1 || Number(object(state.viewport).height) < 1 ||
        state.sha256 && state.sha256 !== imageRef.sha256 ||
        rawState.entryId && rawState.entryId !== manifest.entryId || rawState.role && rawState.role !== role) {
      fail('supplement_state_invalid', '补证必须保留实际原生取景状态与原拍摄时间及图像 SHA');
    }
    const size = imageSize(imageBytes);
    const expectedSize = state.clip ? object(state.clip) : object(state.viewport);
    if (!size || size.width !== expectedSize.width || size.height !== expectedSize.height) {
      fail('supplement_dimensions_invalid', '补证需原始截图尺寸与实际 state 一致，不能用 720 卡片代替原图');
    }
    const page = Array.isArray(observation.pages) ? observation.pages.map(object).filter(row => row.role === role) : [observation];
    if (observation.entryId !== manifest.entryId || page.length !== 1 || page[0].role !== role ||
        (object(page[0].shot).sha256 ?? page[0].sha256) !== imageRef.sha256 ||
        (page[0].captureStateSha256 ?? page[0].stateSha256) !== stateRef.sha256 ||
        (page[0].sourceUrl ?? page[0].requestedUrl) !== sourceUrl || page[0].finalUrl !== finalUrl ||
        page[0].capturedAt !== state.capturedAt) fail('supplement_observation_invalid', '原 observation/receipt、图像、state、Entry 与来源未逐层绑定');
    if (!native && observation.ok !== true) fail('supplement_origin_invalid', '需真实采集完成回执，不能从待拍计划构造补证');
    const targetDecision = sourceAllowed(previous, role, sourceUrl, finalUrl, saved, manifest.targetDecision);
    const checked = await checkImage(imageBytes, [], {stage: role === 'proof'});
    if (checked.issues.length) fail('supplement_image_invalid', `补证原图未通过既有图像检查：${checked.issues.join('；')}`);
    const hash = checked.hash;
    const current = priorImages.find(image => image.role === role);
    if (role === 'proof' && (current?.sha256 === imageRef.sha256 || string(object(shots[role]).file).includes(imageRef.sha256) ||
        string(object(shots[role]).hash) && hamming(hash, string(object(shots[role]).hash)) <= 6)) {
      fail('supplement_unchanged_proof', '补证与当前拒收 proof 没有实质图像变化');
    }
    // Known returned captures remain rejected even if renamed or re-encoded.
    const observed = new Map<string, ObjectValue>();
    for (const event of f.journal.read()) {
      if (!('token' in event) || !f.state.tokens[event.token] || !website(f.state.tokens[event.token]) || entry(f.state.tokens[event.token]) !== entry(previous)) continue;
      if (event.kind === 'token.data' && object(event.patch.shots)[role]) observed.set(event.token, object(object(event.patch.shots)[role]));
      const prior = observed.get(event.token);
      if (event.kind === 'review.verdict' && event.verdict === 'return' && event.returnTo === `curation/${role}` && prior &&
          (string(prior.file).includes(imageRef.sha256) || string(prior.hash) && hamming(hash, string(prior.hash)) <= 6)) {
        fail('supplement_known_rejected', '这份 proof 内容已有未解决的拒收记录，不能作为新的补证次数');
      }
    }
    const ext = path.extname(imageRef.path).slice(1).toLowerCase();
    if (!['png', 'webp'].includes(ext)) fail('supplement_file_invalid', '补证仅接受原始 PNG/WebP 截图');
    inputs.push({role, manifest, imageRef, imageBytes, stateBytes, observationBytes, state, hash, native: Boolean(native), ext, targetDecision});
  }
  const roles = inputs.map(input => input.role);
  for (const role of ['identity', 'breadth'].filter(role => !roles.includes(role))) {
    const shot = object(shots[role]);
    const image = priorImages.find(row => row.role === role && row.evidence === shot.evidence);
    const file = image && f.store.resolve(string(image.src));
    if (!image || !file || !f.state.evidence[string(shot.evidence)] ||
        sha(readFile(file, approved, f.project.dir, 16 << 20)) !== image.sha256) {
      fail('supplement_upstream_incomplete', '保留原图必须仍存在并与原证据 SHA 一致');
    }
  }
  const finalHashes = ['identity', 'breadth', 'proof'].map(role => inputs.find(input => input.role === role)?.hash ?? string(object(shots[role]).hash));
  for (let i = 0; i < finalHashes.length; i++) for (let j = i + 1; j < finalHashes.length; j++) {
    if (!/^[01]{64}$/.test(finalHashes[i]) || !/^[01]{64}$/.test(finalHashes[j]) || hamming(finalHashes[i], finalHashes[j]) <= 6) {
      fail('supplement_image_invalid', '最终三张图必须继续通过既有图像去重检查');
    }
  }
  // Every read/codec await happens before the synchronous commit and final CAS.
  const concurrent = replay(f, p, requestSha256);
  if (concurrent) return concurrent;
  checkpoint(f, p);
  const manifestObject = f.store.put(manifestBytes, 'json');
  const priorReviewState = f.store.put(Buffer.from(JSON.stringify({reviews: previous.data.reviews ?? [],
    readerPlan: previous.data.readerPlan,
    shotReview: previous.data.shotReview, copyReviewVerdict: previous.data['copy-reviewVerdict'],
    auditVerdict: previous.data.auditVerdict, gate: previous.data.gate, digest: previous.data.digest})), 'json');
  const supplementId = `proof-${crypto.randomUUID()}`;
  const captures = inputs.map(input => ({...input, evidenceId: `${supplementId}-${input.role}`,
    image: f.store.put(input.imageBytes, input.ext), stateObject: f.store.put(input.stateBytes, 'json'),
    observationObject: f.store.put(input.observationBytes, 'json')}));
  const proof = captures[0];
  let result: ObjectValue = {};
  f.runtime.atomicTransition(() => {
    checkpoint(f, p);
    const data = structuredClone(previous.data);
    for (const key of ['failure', 'manualReason', 'retriedBy', 'gate', 'digest', 'published', 'draftV3', 'draftProblems', 'style', 'copy']) delete data[key];
    Object.assign(data, {shotReview: 'pending', 'copy-reviewVerdict': 'pending', auditVerdict: 'pending',
      reviews: (Array.isArray(data.reviews) ? data.reviews : []).filter(review =>
        typeof object(review).station === 'string' && !DOWNSTREAM.includes(`curation/${string(object(review).station).replace(/^curation\//, '')}`)),
      readerPlan: {...object(data.readerPlan), ...Object.fromEntries(captures.map(capture => [capture.role, {
        ...object(object(data.readerPlan)[capture.role]), url: capture.state.finalUrl,
        reason: '原始补证输入，待独立审查；按本次原生取景核对角色和内容。', targetDecision: capture.targetDecision}]))},
      images: structuredClone(priorImages.filter(row => !roles.includes(string(row.role)))),
      shots: {...object(data.shots), ...Object.fromEntries(captures.map(capture => [capture.role, {
        file: capture.image.file, href: capture.state.finalUrl, hash: capture.hash,
        evidence: capture.evidenceId, capturedAt: capture.state.capturedAt, captureState: capture.state}]))},
      retryOf: previous.id, recoveryRoot: saved.entry, recoveryStation: 'curation/process',
      suppliedCaptureRoles: roles});
    const token = f.runtime.create('curation/process', {item: previous.item, url: previous.url,
      title: previous.title, source: previous.source, category: previous.category, data});
    const nextCheckpoint = structuredClone(saved);
    nextCheckpoint.done = [...new Set([...(saved.done as string[]).filter(key => !DOWNSTREAM.includes(key)), ...roles.map(role => `curation/${role}`)])];
    token.data.runtimeCheckpoint = nextCheckpoint;
    f.runtime.restoreCheckpoint(token);
    f.runtime.restoreFlow(token);
    f.runtime.resumeFrontier(token, 'curation/process');
    token.data.checkpointDone = [...token.done];
    const receipt = {supplementId, previousToken: previous.id, token: token.id, entryId: entry(previous),
      role: 'proof', runId: p.runId, idempotencyKey: p.idempotencyKey, requestSha256,
      manifestSha256: p.manifestSha256, originalImageSha256: proof.imageRef.sha256,
      stateSnapshotSha256: sha(proof.stateBytes), sourceObservationSha256: sha(proof.observationBytes),
      stateProvenance: proof.native ? 'journal-snapshot' : 'original-file',
      observationProvenance: proof.native ? 'journal-snapshot' : 'original-file',
      sourceUrl: proof.state.sourceUrl, finalUrl: proof.state.finalUrl, capturedAt: proof.state.capturedAt, actor, reason: p.reason,
      previousCheckpointSha256: p.expectedCheckpointSha256, preservedRounds: {...token.rounds},
      invalidatedStations: DOWNSTREAM, resumeAt: 'curation/process', queued: true, review: 'pending',
      targetDecisions: captures.filter(capture => capture.targetDecision).map(capture => ({role: capture.role, ...capture.targetDecision})),
      supersededReviewState: priorReviewState.src,
      rawObjects: {image: proof.image.src, state: proof.stateObject.src, observation: proof.observationObject.src, manifest: manifestObject.src},
      captures: captures.map(capture => ({role: capture.role, targetDecision: capture.targetDecision, imageSha256: capture.imageRef.sha256,
        stateSnapshotSha256: sha(capture.stateBytes), sourceObservationSha256: sha(capture.observationBytes),
        capturedAt: capture.state.capturedAt, sourceUrl: capture.state.sourceUrl, finalUrl: capture.state.finalUrl,
        origin: capture.manifest.origin, image: capture.image.src, state: capture.stateObject.src,
        observation: capture.observationObject.src, stateProvenance: capture.native ? 'journal-snapshot' : 'original-file'}))};
    Object.assign(token.data, {proofSupplementReceipt: receipt});
    f.journal.append({kind: 'token.data', token: token.id, patch: {
      ...data, runtimeCheckpoint: nextCheckpoint, checkpointDone: [...token.done], proofSupplementReceipt: receipt,
    }});
    f.runtime.checkpoint(token);
    for (const id of previous.evidence) {
      const evidence = f.state.evidence[id];
      if (evidence) f.journal.append({kind: 'evidence.added', evidence: {...evidence,
        id: `${id}-${token.id}`, token: token.id, meta: {...evidence.meta, reusedFrom: id}}});
    }
    for (const capture of captures) f.journal.append({kind: 'evidence.added', evidence: {id: capture.evidenceId, kind: 'image', token: token.id,
      station: `curation/${capture.role}`, attempt: object(capture.manifest.origin).kind === 'attempt'
        ? string(object(capture.manifest.origin).attempt) : `external-import:${p.manifestSha256}`,
      at: Date.parse(string(capture.state.capturedAt)), src: capture.image.src, label: `补证原图 · ${capture.role} · 待独立审查`,
      meta: {role: capture.role, captureState: capture.state, origin: capture.manifest.origin, targetDecision: capture.targetDecision, supplementId,
        manifest: manifestObject.src, observation: capture.observationObject.src, state: capture.stateObject.src, review: 'pending'}}});
    f.journal.append({kind: 'token.data', token: previous.id, patch: {retriedBy: token.id, proofSupplementReceipt: receipt}});
    const candidate = f.state.recoveries[recoveryKey(previous)];
    if (candidate?.token === previous.id) {
      f.journal.append({kind: 'candidate.disposition', candidate: {...candidate, token: token.id, disposition: 'claimed'}});
      if (candidate.disposition === 'retry') f.runtime.stockDelta('candidates/pool', -1, '由真实 proof 补证接续，保留原重试历史');
    }
    f.runtime.stockDelta('curation/manual', -1, '真实 proof 补证接续；历史人工到达保留');
    f.journal.append({kind: 'case.noted', caseId: previous.item, token: token.id, note: {
      station: 'curation/process', section: 'proof 补证', by: actor,
      text: `${p.reason}\n${JSON.stringify(receipt)}`}});
    result = {...receipt, alreadyPresent: false};
  });
  return result;
}
