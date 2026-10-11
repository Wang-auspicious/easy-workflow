// Repository facts straight from the source (Spec §35): GitHub metadata, the SPDX licence
// with its original LICENSE text and URL, and package.json. Shared by the scout and the
// station toolbox; every value carries the URL it came from.
import { rememberRead, webGet } from "./network.ts";
import { classifyFailure, type Failure } from "../shared/failures.ts";

export interface RepoMeta {
  repo: string; url: string; description: string | null; homepage: string | null;
  ownerType: string | null; ownerLogin: string | null; stars: number | null; pushedAt: string | null; archived: boolean | null; defaultBranch: string;
  license: { spdx: string | null; name: string | null; path: string | null; url: string | null; excerpt: string | null } | null;
  packageJson: { name?: string; license?: unknown; author?: unknown; repository?: unknown; homepage?: string; url: string } | null;
}

export class RepoError extends Error { failure: Failure; constructor(f: Failure) { super(f.message); this.failure = f; } }

/** owner/name from "owner/name", a GitHub URL, git+https or git@ forms; null when it is not a repo. */
export function repoOf(input: string): { owner: string; name: string; path?: string } | null {
  const s = input.trim().replace(/^git\+/, "").replace(/^git@github\.com:/, "https://github.com/").replace(/\.git(?=$|[/#?])/, "");
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(?:tree|blob)\/[^/]+\/(.+))?\/?(?:[#?].*)?$/.exec(s);
  if (!m || (!/github\.com/i.test(s) && /\./.test(m[1]))) return null;
  if (["orgs", "users", "topics", "features", "sponsors", "marketplace", "settings", "about"].includes(m[1].toLowerCase())) return null;
  return { owner: m[1], name: m[2], path: m[3] };
}

const tokenHeader = (): Record<string, string> => { const t = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN; return t ? { Authorization: `Bearer ${t}` } : {}; };

export async function fetchRepoMeta(input: string, signal?: AbortSignal): Promise<RepoMeta> {
  const r = repoOf(input);
  if (!r) throw new RepoError({ ...classifyFailure(`invalid URL: ${input}`, { stage: "url" }), owner: "agent", nextAction: "传 owner/name，例如 shadcn-ui/ui" });
  const api = `https://api.github.com/repos/${r.owner}/${r.name}`;
  const json = async (u: string) => {
    let res;
    try { res = await webGet(u, { signal, accept: "application/vnd.github+json", timeout: 15000, headers: tokenHeader() }); } catch (err) { throw new RepoError(classifyFailure(err, { url: u })); }
    if (res.status === 403 && /rate limit/i.test(res.body)) throw new RepoError({ ...classifyFailure("HTTP 429", { url: u, status: 429 }), message: "GitHub API 匿名额度已用完", nextAction: "稍后再试，或设置 GITHUB_TOKEN 环境变量；也可以用 fetch_text 直接读仓库页面和 LICENSE", owner: "system" });
    if (res.status >= 400) throw new RepoError(classifyFailure(`HTTP ${res.status}`, { url: u, status: res.status }));
    return JSON.parse(res.body);
  };
  const repo = await json(api);
  let license: RepoMeta["license"] = null;
  try {
    const l = await json(`${api}/license`);
    const text = Buffer.from(String(l.content ?? ""), "base64").toString("utf8");
    license = { spdx: l.license?.spdx_id ?? null, name: l.license?.name ?? null, path: l.path ?? null, url: l.html_url ?? null, excerpt: text.slice(0, 2500) };
  } catch { license = repo.license ? { spdx: repo.license.spdx_id ?? null, name: repo.license.name ?? null, path: null, url: null, excerpt: null } : null; }
  let packageJson: RepoMeta["packageJson"] = null;
  try {
    const res = await webGet(`https://raw.githubusercontent.com/${r.owner}/${r.name}/${repo.default_branch}/package.json`, { signal, timeout: 12000 });
    if (res.status < 400) { const p = JSON.parse(res.body); packageJson = { name: p.name, license: p.license, author: p.author, repository: p.repository, homepage: p.homepage, url: `https://github.com/${r.owner}/${r.name}/blob/${repo.default_branch}/package.json` }; }
  } catch { /* no package.json */ }
  const meta: RepoMeta = {
    repo: `${r.owner}/${r.name}`, url: repo.html_url, description: repo.description ?? null, homepage: repo.homepage || null,
    ownerType: repo.owner?.type ?? null, ownerLogin: repo.owner?.login ?? null, stars: repo.stargazers_count ?? null, pushedAt: repo.pushed_at ?? null, archived: repo.archived ?? null,
    defaultBranch: repo.default_branch, license, packageJson,
  };
  for (const src of repoSources(meta)) rememberRead(src.url, src.text);
  return meta;
}

/** Text that facts may quote: description, licence excerpt and package.json, each with its URL. */
export function repoSources(m: RepoMeta): { url: string; text: string }[] {
  const out = [{ url: m.url, text: [m.description, m.homepage ? `Homepage: ${m.homepage}` : "", `Owner: ${m.ownerLogin} (${m.ownerType})`, m.license?.spdx ? `License: ${m.license.spdx}` : ""].filter(Boolean).join("\n") }];
  if (m.license?.url && m.license.excerpt) out.push({ url: m.license.url, text: m.license.excerpt });
  if (m.packageJson) out.push({ url: m.packageJson.url, text: JSON.stringify({ name: m.packageJson.name, license: m.packageJson.license, author: m.packageJson.author, repository: m.packageJson.repository, homepage: m.packageJson.homepage }, null, 1) });
  return out;
}
