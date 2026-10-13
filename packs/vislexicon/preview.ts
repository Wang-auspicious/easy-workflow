import fs from "node:fs";
import crypto from "node:crypto";
import type { EvidenceStore } from "../../server/evidence.ts";
import { webpSize } from "./v3.ts";

export interface PreviewImage { role: string; src: string; card: string; sha256: string; href: string; evidence?: string; title?: string }

/** The recording's poster is its identity page. It must retain the recording URL and
 * immutable bytes; a video never invents the two other static screenshot roles. */
export function videoPreview(data: Record<string, any>, store: EvidenceStore): { images: PreviewImage[]; issues: string[] } {
  const video = data.video;
  if (!video) return { images: [], issues: ["没有录屏"] };
  const issues: string[] = [];
  const read = (key: string, image: boolean) => {
    const src = video[key], file = typeof src === "string" ? store.resolve(src) : null;
    if (!file || !fs.existsSync(file)) { issues.push(`录屏 ${key} 的持久文件不存在`); return null; }
    const bytes = fs.readFileSync(file), sha = crypto.createHash("sha256").update(bytes).digest("hex");
    if (!bytes.length || !src.includes(`/${sha}.`)) { issues.push(`录屏 ${key} 的内容摘要不匹配`); return null; }
    if (image ? !webpSize(file) : bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") {
      issues.push(`录屏 ${key} 不是有效的 ${image ? "WebP 封面" : "MP4 文件"}`); return null;
    }
    return { src, sha };
  };
  read("src", false); read("card", false);
  const poster = read("poster", true), card = read("posterCard", true);
  // Pre-migration recordings used home.finalUrl in record(); preserve that exact
  // source when recovering, never substitute a separately selected screenshot.
  const href = video.finalUrl ?? video.url ?? data.home?.finalUrl ?? data.canonical;
  try { if (!["http:", "https:"].includes(new URL(href).protocol)) throw new Error(); }
  catch { issues.push("录屏缺少可验证的来源网址"); }
  if (Array.isArray(video.issues) && video.issues.length) issues.push(...video.issues.map(String));
  return { issues, images: !issues.length && poster && card ? [{ role: "identity", src: poster.src, card: card.src, sha256: poster.sha, href, evidence: video.evidence, title: video.title ?? data.title }] : [] };
}

export function publicationImages(data: Record<string, any>, store: EvidenceStore): PreviewImage[] {
  return data.mode === "video" ? videoPreview(data, store).images : (data.images ?? []);
}
