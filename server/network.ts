// One network exit for every station and agent tool (Spec §30.3): system proxy with
// loopback bypass, per-host pacing, one backoff retry for transient errors and a
// project-local cache of successful GETs. Certificates are always verified.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EnvHttpProxyAgent, fetch as proxyFetch } from "undici";

let transport: EnvHttpProxyAgent | undefined;
export const networkFetch: typeof globalThis.fetch = (input, init) => {
  transport ??= new EnvHttpProxyAgent({ noProxy: ["localhost", "127.0.0.1", "::1", process.env.NO_PROXY ?? process.env.no_proxy ?? ""].join(",") });
  return proxyFetch(input as Parameters<typeof proxyFetch>[0], { ...init, dispatcher: transport } as Parameters<typeof proxyFetch>[1]) as unknown as Promise<Response>;
};
export async function closeNetwork() { const t = transport; transport = undefined; await t?.destroy(); }

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
let cacheDir: string | null = null;
let defaultTtl = 6 * 3600_000;
export function configureNetwork(opts: { cacheDir?: string | null; ttlMs?: number }) {
  if (opts.cacheDir !== undefined) cacheDir = opts.cacheDir;
  if (opts.ttlMs !== undefined) defaultTtl = opts.ttlMs;
  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });
}

/* per-host pacing: at most 2 requests in flight and 250ms between starts */
const hosts = new Map<string, { inFlight: number; last: number; queue: (() => void)[] }>();
async function slot(host: string) {
  const h = hosts.get(host) ?? hosts.set(host, { inFlight: 0, last: 0, queue: [] }).get(host)!;
  while (h.inFlight >= 2) await new Promise<void>((r) => h.queue.push(r));
  h.inFlight++;
  const wait = h.last + 250 - Date.now();
  h.last = Math.max(Date.now(), h.last + 250);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  return () => { h.inFlight--; h.queue.shift()?.(); };
}

export interface WebResult { status: number; finalUrl: string; body: string; contentType: string; via: "http" | "cache"; tried: string[] }

const transient = (status: number) => status === 429 || status >= 500;
const errorText = (e: unknown) => `${String((e as Error)?.message ?? e)} ${String((e as { cause?: { code?: string; message?: string } })?.cause?.code ?? "")} ${String((e as { cause?: { message?: string } })?.cause?.message ?? "")}`;
const isTls = (e: unknown) => /certificate|CERT_|TLS|SSL/i.test(errorText(e));
const transientError = (e: unknown) => !isTls(e) && /timeout|ECONNRESET|ECONNREFUSED|socket|fetch failed|UND_ERR/i.test(errorText(e));

/** GET a URL as text. Throws the underlying error (classified by callers) after one retry. */
export async function webGet(url: string, opts: { signal?: AbortSignal; timeout?: number; ttlMs?: number; cache?: boolean; accept?: string; headers?: Record<string, string> } = {}): Promise<WebResult> {
  const key = crypto.createHash("sha1").update(url).digest("hex");
  const file = cacheDir && opts.cache !== false ? path.join(cacheDir, key.slice(0, 2), `${key}.json`) : null;
  const ttl = opts.ttlMs ?? defaultTtl;
  if (file) {
    try {
      const hit = JSON.parse(fs.readFileSync(file, "utf8")) as WebResult & { at: number };
      if (Date.now() - hit.at < ttl) return { ...hit, via: "cache", tried: ["cache"] };
    } catch { /* miss */ }
  }
  let host = "";
  try { host = new URL(url).host; } catch { throw new Error(`invalid URL: ${url}`); }
  const tried: string[] = [];
  for (let round = 0; round < 2; round++) {
    opts.signal?.throwIfAborted();
    const release = await slot(host);
    let retry = false;
    try {
      tried.push(round ? "http-retry" : "http");
      const signal = AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(opts.timeout ?? 20000)]);
      const res = await networkFetch(url, { redirect: "follow", signal, headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.8,zh-CN;q=0.6", ...(opts.accept ? { Accept: opts.accept } : {}), ...(opts.headers ?? {}) } });
      const body = await res.text();
      const out: WebResult = { status: res.status, finalUrl: res.url || url, body, contentType: res.headers.get("content-type") ?? "", via: "http", tried };
      if (round === 0 && transient(res.status)) retry = true;
      else {
        if (file && res.status < 300 && body.length < 5_000_000) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify({ ...out, at: Date.now() }));
        }
        return out;
      }
      if (retry) { release(); await new Promise((r) => setTimeout(r, res.status === 429 ? 3000 : 800)); continue; }
    } catch (err) {
      opts.signal?.throwIfAborted();
      if (round === 0 && transientError(err)) { retry = true; }
      else { (err as { tried?: string[] }).tried = tried; throw err; }
    } finally { if (!retry) release(); }
    release();
    await new Promise((r) => setTimeout(r, 800));
  }
  throw Object.assign(new Error(`request failed twice: ${url}`), { tried });
}

/* Pages an agent actually read during recent work, so checks can verify quotes against
 * what was read through the toolbox, not only against pre-fetched excerpts. */
const reads = new Map<string, string>();
export function rememberRead(url: string, text: string) {
  const key = url.replace(/[#].*$/, "").replace(/\/+$/, "");
  reads.delete(key); reads.set(key, text.slice(0, 60000));
  while (reads.size > 400) reads.delete(reads.keys().next().value!);
}
export function readText(url: string) { return reads.get(url.replace(/[#].*$/, "").replace(/\/+$/, "")); }
