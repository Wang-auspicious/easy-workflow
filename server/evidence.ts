// Evidence store (Spec §11): content-addressed, immutable files under var/evidence.
// Screenshots are kept as WebP only (full 1280 + card 720); the PNG a capture produces
// is converted and dropped (VisLexicon decision 2026-10-09).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export class EvidenceStore {
  root: string;
  readOnly: boolean;
  constructor(root: string, readOnly = false) { this.root = root; this.readOnly = readOnly; if (!readOnly) fs.mkdirSync(root, { recursive: true }); }

  /** Writes bytes once; returns the sha256 and the served path. */
  put(buf: Buffer, ext: string): { sha: string; src: string; file: string } {
    if (this.readOnly) throw new Error("Evidence store is read-only");
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const dir = path.join(this.root, sha.slice(0, 2));
    const file = path.join(dir, `${sha}.${ext}`);
    if (!fs.existsSync(file)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, buf); }
    return { sha, src: `/evidence/${sha.slice(0, 2)}/${sha}.${ext}`, file };
  }

  resolve(served: string): string | null {
    const m = /^\/evidence\/([0-9a-f]{2})\/([0-9a-f]{64})\.(webp|mp4|json|txt|jpg|png|md|pptx|pdf|zip|py)$/.exec(served);
    return m ? path.join(this.root, m[1], `${m[2]}.${m[3]}`) : null;
  }

  /** PNG/JPEG → WebP at a given width (ffmpeg libwebp). */
  static webp(buf: Buffer, width: number, quality = 80): Buffer {
    return execFileSync("ffmpeg", ["-loglevel", "error", "-f", "image2pipe", "-i", "pipe:0", "-vf", `scale='min(${width},iw)':-2:flags=lanczos`, "-c:v", "libwebp", "-quality", String(quality), "-f", "webp", "pipe:1"], { input: buf, maxBuffer: 1 << 27 });
  }

  /** Any image → JPEG for model input (the endpoint takes JPEG reliably). */
  static jpeg(file: string, width = 720): Buffer {
    return execFileSync("ffmpeg", ["-loglevel", "error", "-i", file, "-vf", `scale='min(${width},iw)':-2`, "-f", "image2", "-c:v", "mjpeg", "-q:v", "4", "pipe:1"], { maxBuffer: 1 << 25 });
  }
}

/* ------------------------------------------------------------------ pixel checks (ported from VisLexicon capture-shots.mjs) */

function grayPixels(img: Buffer, width: number, height: number): Buffer {
  return execFileSync("ffmpeg", ["-loglevel", "error", "-f", "image2pipe", "-i", "pipe:0", "-vf", `scale=${width}:${height}`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { input: img, maxBuffer: 1 << 22 });
}

export function imageStats(img: Buffer) {
  const px = grayPixels(img, 160, 100);
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
  const mean = px.reduce((a, b) => a + b, 0) / px.length;
  return [...px].map((v) => (v > mean ? "1" : "0")).join("");
}

export const hamming = (a: string, b: string) => [...a].filter((c, i) => c !== b[i]).length;

/** Pixel statistics the style vetoes use (256×160; VisLexicon site-style.mjs). */
export function pixelStats(file: string) {
  const rgb = execFileSync("ffmpeg", ["-loglevel", "error", "-i", file, "-vf", "scale=256:160", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 1 << 20 });
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
