// VisLexicon v3 entry records (Spec §35): the curation line's product is the same JSON the
// VisLexicon build validates. Taxonomy and validators are imported from VisLexicon at run
// time, never copied; field ownership tells the final auditor whom to ask (Spec §34).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FRONTEND, KIND_ZH } from "./env.ts";

export interface Taxonomy {
  categories: { id: string; label: string }[];
  subcategories: Record<string, { id: string; label: string }[]>;
  axes: Record<string, { id: string; label: string; aliases: string[] }[]>;
  facetsErrors: (f: unknown) => string[];
  classificationErrors: (r: unknown) => string[];
}

let taxonomy: Taxonomy | null = null;
export async function loadTaxonomy(): Promise<Taxonomy> {
  if (taxonomy) return taxonomy;
  const roots = [FRONTEND, process.env.VISLEXICON_BUNDLED].filter(Boolean) as string[];
  for (const root of roots) {
    const file = path.join(root, "src", "data", "curation-taxonomy.js");
    if (!fs.existsSync(file)) continue;
    const m = await import(pathToFileURL(file).href);
    taxonomy = { categories: [...m.CURATION_CATEGORIES], subcategories: m.CURATION_SUBCATEGORIES, axes: m.CURATION_FACET_AXES, facetsErrors: m.facetsErrors, classificationErrors: m.classificationErrors };
    return taxonomy;
  }
  throw new Error("找不到 VisLexicon 的 curation-taxonomy.js；请在桌面端连接 VisLexicon 资料目录");
}
export const taxonomyLoaded = () => taxonomy;

/** Facet axes the catalog agent chooses; access and licenses are derived from verified facts. */
export const CHOSEN_AXES = ["scenarios", "deliverables", "actions", "media", "platforms", "technologies", "workflowStages", "audiences", "contentOrganization", "languages"] as const;
export const ALL_AXES = [...CHOSEN_AXES.slice(0, 8), "access", "licenses", ...CHOSEN_AXES.slice(8)] as const;

/** Which v3 primary categories fit each Spec v1 kind (VisLexicon Spec §2.8, reversed). */
export const KIND_CATEGORIES: Record<string, string[]> = {
  "component-source": ["ui-implementation", "visual-implementation"],
  "design-system": ["ui-implementation", "reference-standards"],
  assets: ["visual-assets", "templates-design-files"],
  tool: ["creation-tools", "delivery-development-tools", "research-quality-tools", "visual-implementation"],
  knowledge: ["learning-editorial", "reference-standards"],
  gallery: ["case-inspiration-collections", "directories-indexes", "community-marketplaces"],
  work: ["single-site-showcase"],
};

/** Field → station that owns it. The auditor's fix requests are routed by this table. */
export const FIELD_OWNERS: [RegExp, string][] = [
  [/^pages\[\d\]\.shot$/, "curation/manual"],
  [/^editorial\.(name|descriptionZh|takeawayZh|noteZh)$/, "curation/copy"],
  [/^editorial\.pricing$/, "curation/facts"],
  [/^pages\[\d\]\.(selectionRationale|shot\.alt)$/, "curation/copy"],
  [/^classification\.(primaryCategory|subcategory)$/, "curation/catalog"],
  [/^classification\.reasons/, "curation/copy"],
  [/^facets\.(access|licenses)/, "curation/facts"],
  [/^facets\./, "curation/catalog"],
  [/^facts/, "curation/facts"],
  [/^style/, "curation/style"],
];
export function ownerOf(field: string) { return FIELD_OWNERS.find(([re]) => re.test(field))?.[1] ?? null; }

const SPDX_OK = /^[A-Za-z0-9.+-]+$/;

/** Mechanical facets from verified facts (VisLexicon agentGuidance rule): never guessed. */
export function derivedFacets(facts: Record<string, any>, tax: Taxonomy) {
  const access: string[] = [];
  const price = facts?.pricing?.value;
  if (price === "free") access.push("free");
  else if (price === "freemium") access.push("freemium");
  else if (price === "paid") access.push("paid");
  if (facts?.sourceCode?.value === "open") access.push("open-source");
  const lic = String(facts?.license?.value ?? "unknown");
  const licenseIds = new Set(tax.axes.licenses.flatMap((v) => [v.id, ...v.aliases].map((x) => x.toLowerCase())));
  const licenses = lic === "unknown" ? ["unknown"] : licenseIds.has(lic.toLowerCase()) ? [lic] : SPDX_OK.test(lic) && licenseIds.has("custom") ? ["custom"] : ["unknown"];
  const accessIds = new Set(tax.axes.access.map((v) => v.id));
  return { access: access.filter((a) => accessIds.has(a)), licenses: licenses.filter((l) => licenseIds.has(l.toLowerCase())) };
}

/** Width and height from a WebP header (VP8, VP8L, VP8X). */
export function webpSize(file: string): { width: number; height: number } | null {
  try {
    const b = fs.readFileSync(file);
    if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") return null;
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
    if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  } catch { /* unreadable */ }
  return null;
}

const nonEmpty = (v: unknown) => typeof v === "string" && v.trim().length > 0;
const isHttp = (v: unknown) => { try { return ["http:", "https:"].includes(new URL(String(v)).protocol); } catch { return false; } };

export interface V3Problem { field: string; problem: string }

/** The same checks VisLexicon's build runs before projecting an entry (assertBundle), plus
 *  the taxonomy validators, returned as field-addressed problems instead of a thrown error. */
export function validateV3(rec: Record<string, any>, tax: Taxonomy): V3Problem[] {
  const out: V3Problem[] = [];
  const need = (field: string, ok: boolean, problem: string) => { if (!ok) out.push({ field, problem }); };
  need("status", rec.status === "APPROVED", "status 必须是 APPROVED");
  need("entryId", nonEmpty(rec.entryId) && /^[a-z0-9][a-z0-9-]*$/.test(rec.entryId), "entryId 必须是小写 kebab-case");
  need("editorial.name", nonEmpty(rec.editorial?.name), "缺少 editorial.name");
  need("official.checkedAt", nonEmpty(rec.official?.checkedAt), "缺少 official.checkedAt");
  need("official.finalUrl", isHttp(rec.official?.finalUrl), "official.finalUrl 不是 http(s) 地址");
  const pages = rec.pages ?? [];
  need("pages", pages.length > 0, "没有 pages[]");
  pages.forEach((p: any, i: number) => {
    need(`pages[${i}].role`, nonEmpty(p.role), "缺少 role");
    need(`pages[${i}].selectionRationale`, nonEmpty(p.selectionRationale), "缺少导览 selectionRationale");
    need(`pages[${i}].sourceUrl`, isHttp(p.sourceUrl), "sourceUrl 不是 http(s) 地址");
    need(`pages[${i}].shot.src`, nonEmpty(p.shot?.src), "缺少截图");
    need(`pages[${i}].shot.alt`, nonEmpty(p.shot?.alt) && !/screenshot|evidence/i.test(p.shot?.alt ?? ""), "alt 缺失或是模板句");
  });
  need("pages", pages.some((p: any) => p.role === "identity"), "没有 role=identity 的页面");
  need("facts", (rec.facts ?? []).length > 0, "没有 facts[]");
  (rec.facts ?? []).forEach((f: any, i: number) => need(`facts[${i}].sourceUrl`, isHttp(f.sourceUrl), `${f.field} 的 sourceUrl 不是 http(s) 地址`));
  for (const field of ["author", "organization", "repository", "license", "pricing"]) need(`facts.${field}`, (rec.facts ?? []).some((f: any) => f.field === field), `缺少最低要求的事实 ${field}`);
  need("classification.reasons", (rec.classification?.reasons ?? []).length > 0, "没有收录理由");
  (rec.classification?.reasons ?? []).forEach((r: any, i: number) => need(`classification.reasons[${i}].evidenceUrl`, isHttp(r.evidenceUrl), "收录理由缺少证据网址"));
  const facets = rec.facets ?? {};
  for (const axis of ALL_AXES) need(`facets.${axis}`, Array.isArray(facets[axis]), `facets 缺少轴 ${axis}`);
  // Structural problems in fields the program builds are bugs for the system, not tasks for an agent.
  const sys = (e: string) => /is not allowed|must be a canonical|requires (curatorId|reviewerId|entityId)|unknown record level|unknown classification status/.test(e);
  for (const e of tax.facetsErrors(facets)) { const axis = /facets\.(\w+)|unknown (\w+) facet/.exec(e); out.push({ field: sys(e) ? "system:facets" : `facets.${axis?.[1] ?? axis?.[2] ?? "?"}`, problem: e }); }
  for (const e of tax.classificationErrors({ ...rec.classification, entityId: rec.entityId, entryId: rec.entryId, name: rec.editorial?.name })) out.push({ field: sys(e) ? "system:classification" : /subcategory|does not belong/.test(e) ? "classification.subcategory" : "classification.primaryCategory", problem: e });
  const t = rec.editorial?.takeawayZh ?? "";
  need("editorial.takeawayZh", [...t].length > 0 && [...t].length <= 28 && !/\d/.test(t), "takeawayZh 必须 1–28 字且不含数字");
  const note = rec.editorial?.noteZh ?? "";
  need("editorial.noteZh", [...note].length >= 120 && [...note].length <= 180 && !/[!！]/.test(note), "noteZh 必须 120–180 字、不用感叹号");
  return out;
}

export const kindLabel = (k: string) => KIND_ZH[k] ?? k;
