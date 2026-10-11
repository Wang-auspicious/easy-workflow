// Where the VisLexicon repository lives and what this pack reads from it.
// Rules are read from VisLexicon, never copied (Spec §3.3).
import fs from "node:fs";
import path from "node:path";

export const VIS_ROOT = process.env.VISLEXICON_ROOT ?? "D:/Desktop/VisLexicon  视元";
export const FRONTEND = path.join(VIS_ROOT, "VisLexicon-browser-design-kit", "frontend");
const BUNDLED = process.env.VISLEXICON_BUNDLED;

const readJson = <T>(rel: string, fallback: T): T => {
  for (const root of [FRONTEND, BUNDLED].filter(Boolean) as string[]) {
    try { return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8").replace(/^\uFEFF/, "")) as T; } catch { /* optional local source */ }
  }
  return fallback;
};

export interface PreviewKind { mode: string; roles: Record<string, { pathPatterns?: string[]; linkText?: string[]; stageSelectors?: string[] }>; label?: string }
export const PREVIEW_RULES = readJson<{ viewport: { width: number; height: number }; kinds: Record<string, PreviewKind> }>(
  "public/spec/v1/preview-rules.json", { viewport: { width: 1280, height: 800 }, kinds: {} },
);
export const VOCAB = readJson<{ styles: { id: string; zh: string; en: string; plain: string }[] }>("public/spec/v1/vocab.json", { styles: [] });

export interface CatalogEntry { id: string; name: string; canonicalUrl: string; descriptionZh?: string; category?: string; subcategories?: string[]; tags?: string[]; sourceIds?: string[] }
export function loadCatalog(): CatalogEntry[] {
  return readJson<{ entries: CatalogEntry[] }>("public/data/curation-review/site-catalog-index.json", { entries: [] }).entries;
}
export function loadPublished(): { entryId: string; domain: string; homepage: string }[] {
  return readJson<{ items: { entryId: string; domain: string; homepage: string }[] }>("public/data/site-index.json", { items: [] }).items;
}

export const KIND_ZH: Record<string, string> = {
  gallery: "灵感合集", "component-source": "组件源", "design-system": "设计规范", assets: "素材与模板", tool: "工具与库", knowledge: "知识", work: "作品",
};
export const KINDS = Object.keys(KIND_ZH);

/** Verbatim excerpt of a cited VisLexicon Spec section ("vislexicon:Spec.md#2.4"), for the worker's context pack. */
const specCache: { text?: string } = {};
export function ruleExcerpt(ref: string, max = 2600): string {
  const m = /^vislexicon:Spec\.md#([\d.]+)$/.exec(ref);
  if (!m) return "";
  specCache.text ??= (() => {
    for (const root of [VIS_ROOT, BUNDLED].filter(Boolean) as string[]) {
      try { return fs.readFileSync(path.join(root, "Spec.md"), "utf8"); } catch { /* optional local source */ }
    }
    return "";
  })();
  const lines = specCache.text.split(/\r?\n/);
  const head = new RegExp("^#{2,4} " + m[1].replace(/\./g, "\\.") + "(\\s|$)");
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return "";
  const level = lines[start].match(/^#+/)![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) { const h = lines[i].match(/^(#+) /); if (h && h[1].length <= level) { end = i; break; } }
  return lines.slice(start, end).join("\n").slice(0, max);
}
