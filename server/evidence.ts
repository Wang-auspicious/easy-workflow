// Evidence store (Spec §11): content-addressed, immutable files under var/evidence.
// Screenshots are kept as WebP only (full 1280 + card 720); the PNG a capture produces
// is converted and dropped (VisLexicon decision 2026-10-09).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {execFile, execFileSync, spawn, type ChildProcess} from 'node:child_process';
import type {Failure} from '../shared/failures.ts';

export interface ImageProcessOptions {
  signal?: AbortSignal;
  /** Includes time waiting for the shared image-processing slot. */
  timeoutMs?: number;
}

export interface FfmpegOptions extends ImageProcessOptions {
  input?: Buffer;
  maxBuffer?: number;
}

interface ImageWaiter {
  enter: () => void;
}

// This is separate from Broker.cpu: program stations already own that lease.
// One native codec process keeps memory and CPU use bounded across all callers.
let imageBusy = false;
const imageWaiters: ImageWaiter[] = [];
const MAX_IMAGE_WAITERS = 32;

function releaseImageSlot() {
  const next = imageWaiters.shift();
  if (next) next.enter();
  else imageBusy = false;
}

async function acquireImageSlot(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  if (!imageBusy) {
    imageBusy = true;
    return releaseImageSlot;
  }
  if (imageWaiters.length >= MAX_IMAGE_WAITERS) {
    throw Object.assign(new Error('Image processing queue is full; retry after current work completes'), {code: 'FFMPEG_QUEUE_FULL'});
  }
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      const index = imageWaiters.indexOf(waiter);
      if (index >= 0) imageWaiters.splice(index, 1);
      reject(signal.reason);
    };
    const waiter: ImageWaiter = {
      enter: () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
    };
    imageWaiters.push(waiter);
    signal.addEventListener('abort', abort, {once: true});
  });
  return releaseImageSlot;
}

function stopImageProcess(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.resolve();
  if (process.platform !== 'win32') {
    child.kill('SIGKILL');
    return Promise.resolve();
  }
  // ffmpeg may be a Windows package-manager shim. Kill its child tree too.
  return new Promise(resolve => {
    execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, timeout: 5000}, error => {
        if (error && child.exitCode === null) child.kill('SIGKILL');
        resolve();
      });
  });
}

function executeFfmpeg(args: readonly string[], options: FfmpegOptions, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-nostdin', ...args], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    const chunks: Buffer[] = [];
    const maxBuffer = options.maxBuffer ?? 1 << 25;
    let bytes = 0;
    let stderr = Buffer.alloc(0);
    let failure: unknown;
    let cleanup: Promise<void> | undefined;
    const stop = (error: unknown) => {
      failure ??= error;
      cleanup ??= stopImageProcess(child);
    };
    const abort = () => stop(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > maxBuffer) {
        stop(Object.assign(new Error(`ffmpeg output exceeded ${maxBuffer} bytes`), {code: 'FFMPEG_OUTPUT_LIMIT'}));
      } else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-16 * 1024);
    });
    child.once('error', error => {failure ??= error;});
    child.stdin.on('error', error => stop(error));
    child.once('close', async code => {
      signal.removeEventListener('abort', abort);
      await cleanup;
      if (failure) reject(failure);
      else if (signal.aborted) reject(signal.reason);
      else if (code !== 0) reject(new Error(`ffmpeg exited ${code}: ${stderr.toString('utf8').trim().slice(-4000)}`));
      else resolve(Buffer.concat(chunks, bytes));
    });
    child.stdin.end(options.input);
  });
}

function localImageError(error: unknown): Error & {failure: Failure} {
  const localError = error instanceof Error ? error : new Error(String(error));
  const code = (localError as {code?: unknown}).code;
  const failure: Failure = {
    tag: 'tool_error', category: 'system', owner: 'system', retryable: true,
    code: typeof code === 'string' ? code : 'FFMPEG_PROCESS_FAILED',
    message: localError.message,
    nextAction: '检查本地图像处理依赖、输入文件与资源占用后，从当前工位重试；保留原始证据，不要改用模型或网络重试。',
  };
  return Object.assign(localError, {failure});
}

/** Shared binary codec boundary: queued cancellation never starts a process, and
 * running cancellation releases capacity only after the child has closed. */
export async function runFfmpeg(args: readonly string[], options: FfmpegOptions = {}): Promise<Buffer> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxBuffer = options.maxBuffer ?? 1 << 25;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 ||
      !Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > 1 << 27) {
    throw localImageError(new RangeError('Invalid ffmpeg timeout or output limit'));
  }
  const timeout = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(Object.assign(new Error(`Image processing exceeded ${timeoutMs}ms`), {
    name: 'TimeoutError', code: 'FFMPEG_TIMEOUT',
  })), timeoutMs);
  let release: (() => void) | undefined;
  try {
    release = await acquireImageSlot(signal);
    return await executeFfmpeg(args, options, signal);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    throw localImageError(error);
  } finally {
    clearTimeout(timer);
    release?.();
  }
}

export class EvidenceStore {
  root: string;
  readOnly: boolean;
  constructor(root: string, readOnly = false) { this.root = root; this.readOnly = readOnly; if (!readOnly) fs.mkdirSync(root, { recursive: true }); }

  /** Writes bytes once; returns the sha256 and the served path. */
  put(buf: Buffer, ext: string): { sha: string; src: string; file: string } {
    if (this.readOnly) throw new Error("Evidence store is read-only");
    if (!/^[a-z0-9]{1,12}$/.test(ext)) throw new Error('Invalid evidence extension');
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const dir = path.join(this.root, sha.slice(0, 2));
    const file = path.join(dir, `${sha}.${ext}`);
    fs.mkdirSync(dir, {recursive: true});
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Evidence directory must not be a link');
    let damaged = false;
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Evidence path must be a regular file');
      if (stat.size === buf.length && this.fileDigest(file) === sha) {
        return {sha, src: `/evidence/${sha.slice(0, 2)}/${sha}.${ext}`, file};
      }
      damaged = true;
    }

    const id = crypto.randomUUID();
    const temporary = path.join(dir, `.${sha}.${ext}.${id}.tmp`);
    const quarantine = path.join(dir, `.${sha}.${ext}.corrupt-${id}`);
    let quarantined = false;
    let ownsTemporary = false;
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      ownsTemporary = true;
      try {
        fs.writeFileSync(descriptor, buf);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      if (damaged) {
        fs.renameSync(file, quarantine);
        quarantined = true;
      }
      fs.renameSync(temporary, file);
      ownsTemporary = false;
    } catch (error) {
      if (quarantined && !fs.existsSync(file)) fs.renameSync(quarantine, file);
      throw error;
    } finally {
      if (ownsTemporary) fs.unlinkSync(temporary);
    }
    return { sha, src: `/evidence/${sha.slice(0, 2)}/${sha}.${ext}`, file };
  }

  private fileDigest(file: string): string {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const descriptor = fs.openSync(file, 'r');
    try {
      let size: number;
      while ((size = fs.readSync(descriptor, buffer)) > 0) hash.update(buffer.subarray(0, size));
      return hash.digest('hex');
    } finally {
      fs.closeSync(descriptor);
    }
  }

  resolve(served: string): string | null {
    const m = /^\/evidence\/([0-9a-f]{2})\/([0-9a-f]{64})\.(webp|mp4|json|txt|jpg|png|md|pptx|pdf|zip|py)$/.exec(served);
    return m ? path.join(this.root, m[1], `${m[2]}.${m[3]}`) : null;
  }

  /** PNG/JPEG → WebP at a given width (ffmpeg libwebp). */
  static webp(buf: Buffer, width: number, quality = 80): Buffer {
    return execFileSync("ffmpeg", ["-loglevel", "error", "-f", "image2pipe", "-i", "pipe:0", "-vf", `scale='min(${width},iw)':-2:flags=lanczos`, "-c:v", "libwebp", "-quality", String(quality), "-f", "webp", "pipe:1"], { input: buf, maxBuffer: 1 << 27 });
  }

  static webpAsync(buf: Buffer, width: number, quality = 80, options: ImageProcessOptions = {}): Promise<Buffer> {
    return runFfmpeg(['-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-vf', `scale='min(${width},iw)':-2:flags=lanczos`, '-c:v', 'libwebp', '-quality', String(quality), '-f', 'webp', 'pipe:1'], {...options, input: buf, maxBuffer: 1 << 27});
  }

  /** Any image → JPEG for model input (the endpoint takes JPEG reliably). */
  static jpeg(file: string, width = 720): Buffer {
    return execFileSync("ffmpeg", ["-loglevel", "error", "-i", file, "-vf", `scale='min(${width},iw)':-2`, "-f", "image2", "-c:v", "mjpeg", "-q:v", "4", "pipe:1"], { maxBuffer: 1 << 25 });
  }

  static jpegAsync(file: string, width = 720, options: ImageProcessOptions = {}): Promise<Buffer> {
    return runFfmpeg(['-loglevel', 'error', '-i', file, '-vf', `scale='min(${width},iw)':-2`, '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1'], {...options, maxBuffer: 1 << 25});
  }
}

/* ------------------------------------------------------------------ pixel checks (ported from VisLexicon capture-shots.mjs) */

function grayPixels(img: Buffer, width: number, height: number): Buffer {
  return execFileSync("ffmpeg", ["-loglevel", "error", "-f", "image2pipe", "-i", "pipe:0", "-vf", `scale=${width}:${height}`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { input: img, maxBuffer: 1 << 22 });
}

export function imageStats(img: Buffer) {
  const px = grayPixels(img, 160, 100);
  return statsFromPixels(px);
}

export async function imageStatsAsync(img: Buffer, options: ImageProcessOptions = {}) {
  const pixels = await grayPixelsAsync(img, 160, 100, options);
  return statsFromPixels(pixels);
}

function grayPixelsAsync(img: Buffer, width: number, height: number, options: ImageProcessOptions) {
  return runFfmpeg(['-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-vf', `scale=${width}:${height}`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], {...options, input: img, maxBuffer: 1 << 22});
}

function statsFromPixels(px: Buffer) {
  const hist = new Array(256).fill(0);
  let sum = 0;
  for (const v of px) { hist[v]++; sum += v; }
  const mean = sum / px.length;
  let variance = 0;
  for (const v of px) variance += (v - mean) ** 2;
  const mode = hist.indexOf(Math.max(...hist));
  let content = 0;
  for (const v of px) if (Math.abs(v - mode) > 24) content++;
  content /= px.length;
  const flatBlock = 1 - content > 0.45 && mode > 25 && mode < 225;
  return { std: Math.sqrt(variance / px.length), content, mode, flatBlock };
}

export function aHash(img: Buffer): string {
  const px = grayPixels(img, 8, 8);
  return hashFromPixels(px);
}

export async function aHashAsync(img: Buffer, options: ImageProcessOptions = {}): Promise<string> {
  return hashFromPixels(await grayPixelsAsync(img, 8, 8, options));
}

function hashFromPixels(px: Buffer): string {
  const mean = px.reduce((a, b) => a + b, 0) / px.length;
  return [...px].map((v) => (v > mean ? "1" : "0")).join("");
}

export const hamming = (a: string, b: string) => [...a].filter((c, i) => c !== b[i]).length;

/** Pixel statistics the style vetoes use (256×160; VisLexicon site-style.mjs). */
export function pixelStats(file: string) {
  const rgb = execFileSync("ffmpeg", ["-loglevel", "error", "-i", file, "-vf", "scale=256:160", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 1 << 20 });
  return colorStatsFromPixels(rgb);
}

export async function pixelStatsAsync(file: string, options: ImageProcessOptions = {}) {
  const rgb = await runFfmpeg(['-loglevel', 'error', '-i', file, '-vf', 'scale=256:160', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {...options, maxBuffer: 1 << 20});
  return colorStatsFromPixels(rgb);
}

function colorStatsFromPixels(rgb: Buffer) {
  let luma = 0, sat = 0, vivid = 0;
  const n = rgb.length / 3;
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i] / 255, g = rgb[i + 1] / 255, b = rgb[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const s = max === 0 ? 0 : (max - min) / max;
    luma += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sat += s;
    if (s > 0.5 && max > 0.6) vivid++;
  }
  return { luma: luma / n, sat: sat / n, vivid: vivid / n };
}
