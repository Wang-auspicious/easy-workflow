// One network exit for every station and agent tool (Spec §30.3): system proxy with
// loopback bypass, per-host pacing, one backoff retry for transient errors and a
// project-local cache of successful GETs. Certificates are always verified.
import crypto from "node:crypto";
import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Agent as DirectAgent, EnvHttpProxyAgent, fetch as proxyFetch } from "undici";
import { isTlsFailure } from "../shared/failures.ts";

let transport: EnvHttpProxyAgent | undefined;
const noProxy = () => ["localhost", "127.0.0.1", "::1", process.env.NO_PROXY ?? process.env.no_proxy ?? ""].join(",");
/** Describe the actual DNS hop without exposing proxy credentials or URL paths. */
export function networkRoute(url: string): { proxy: boolean; hostname: string; label: string } {
  const target = new URL(url), host = target.hostname.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '').toLowerCase();
  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  const bypass = noProxy().split(/[,\s]+/).filter(Boolean).some(value => {
    const bracketed = value.match(/^\[(.+)\](?::(\d+))?$/);
    const separated = !bracketed && (value.match(/:/g) ?? []).length === 1 ? value.match(/^(.+):(\d+)$/) : null;
    const hostname = (bracketed?.[1] ?? separated?.[1] ?? value).replace(/^\*?\./, '').replace(/\.$/, '').toLowerCase();
    const entryPort = Number(bracketed?.[2] ?? separated?.[2]);
    return (!entryPort || entryPort === port) && (hostname === '*' || (!value.startsWith('*') && host === hostname) || host.endsWith(`.${hostname}`));
  });
  const httpProxy = process.env.http_proxy ?? process.env.HTTP_PROXY;
  const configured = (target.protocol === 'https:' ? process.env.https_proxy ?? process.env.HTTPS_PROXY : '') || httpProxy;
  if (bypass || !configured) return { proxy: false, hostname: host, label: `直连 ${target.host}` };
  try { const endpoint = new URL(configured); return { proxy: true, hostname: endpoint.hostname.replace(/^\[(.*)\]$/, '$1'), label: `代理 ${endpoint.protocol}//${endpoint.host}` }; }
  catch { throw new Error('代理地址格式无效；请检查 HTTP_PROXY / HTTPS_PROXY 配置'); }
}
export const networkFetch: typeof globalThis.fetch = (input, init) => {
  transport ??= new EnvHttpProxyAgent({ noProxy: noProxy() });
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
interface HostQueue { inFlight: number; last: number; queue: { grant: () => void }[]; timer?: ReturnType<typeof setTimeout> }
const hosts = new Map<string, HostQueue>();
function pump(host: string, h: HostQueue) {
  clearTimeout(h.timer); h.timer = undefined;
  if (!h.queue.length) {
    if (!h.inFlight) h.timer = setTimeout(() => { if (hosts.get(host) === h) hosts.delete(host); }, Math.max(0, h.last + 250 - Date.now())).unref();
    return;
  }
  if (h.inFlight >= 2) return;
  const wait = h.last + 250 - Date.now();
  if (wait > 0) { h.timer = setTimeout(() => pump(host, h), wait); return; }
  h.inFlight++; h.last = Date.now(); h.queue.shift()!.grant();
  pump(host, h);
}
function slot(host: string, signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  const h = hosts.get(host) ?? hosts.set(host, { inFlight: 0, last: 0, queue: [] }).get(host)!;
  return new Promise((resolve, reject) => {
    const abort = () => { const i = h.queue.indexOf(waiter); if (i < 0) return; h.queue.splice(i, 1); signal?.removeEventListener('abort', abort); reject(signal!.reason); pump(host, h); };
    const waiter = { grant: () => {
      signal?.removeEventListener('abort', abort);
      let released = false;
      resolve(() => { if (released) return; released = true; h.inFlight--; pump(host, h); });
    } };
    h.queue.push(waiter); signal?.addEventListener('abort', abort, { once: true }); pump(host, h);
  });
}

export interface WebResult { status: number; finalUrl: string; body: string; contentType: string; via: "http" | "cache"; tried: string[] }

const transient = (status: number) => status === 429 || status >= 500;
const errorText = (e: unknown) => `${String((e as Error)?.message ?? e)} ${String((e as { cause?: { code?: string; message?: string } })?.cause?.code ?? "")} ${String((e as { cause?: { message?: string } })?.cause?.message ?? "")}`;
export const transientNetworkError = (e: unknown) => !isTlsFailure(e) && /timeout|ECONNRESET|ECONNREFUSED|socket|fetch failed|UND_ERR/i.test(errorText(e));

/** GET a URL as text. Throws the underlying error (classified by callers) after one retry. */
export async function webGet(url: string, opts: { signal?: AbortSignal; timeout?: number; ttlMs?: number; cache?: boolean; accept?: string; headers?: Record<string, string> } = {}): Promise<WebResult> {
  opts.signal?.throwIfAborted();
  const headers = new Headers({ "User-Agent": UA, "Accept-Language": "en-US,en;q=0.8,zh-CN;q=0.6", ...(opts.accept ? { Accept: opts.accept } : {}) });
  for (const [name, value] of Object.entries(opts.headers ?? {})) headers.set(name, value);
  // Different representations cannot share a cache entry. Authenticated content
  // stays out of the project cache, even when the URL also has a public response.
  const key = crypto.createHash("sha256").update(JSON.stringify([url, [...headers].sort()])).digest("hex");
  const file = cacheDir && opts.cache !== false && !headers.has('authorization') && !headers.has('cookie') ? path.join(cacheDir, key.slice(0, 2), `${key}.json`) : null;
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
    const release = await slot(host, opts.signal);
    let retryDelay = 800;
    try {
      opts.signal?.throwIfAborted();
      tried.push(round ? "http-retry" : "http");
      const signal = AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(opts.timeout ?? 20000)]);
      const res = await networkFetch(url, { redirect: "follow", signal, headers });
      const body = await res.text();
      opts.signal?.throwIfAborted();
      const out: WebResult = { status: res.status, finalUrl: res.url || url, body, contentType: res.headers.get("content-type") ?? "", via: "http", tried };
      if (round === 0 && transient(res.status)) retryDelay = res.status === 429 ? 3000 : 800;
      else {
        if (file && res.status >= 200 && res.status < 300 && body.length < 5_000_000 && !/(?:^|,)\s*(?:no-store|no-cache|private)(?:\s|,|=|$)/i.test(res.headers.get('cache-control') ?? '') && !res.headers.has('set-cookie') && res.headers.get('vary')?.trim() !== '*') {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify({ ...out, at: Date.now() }));
        }
        return out;
      }
    } catch (err) {
      opts.signal?.throwIfAborted();
      if (round !== 0 || !transientNetworkError(err)) { (err as { tried?: string[] }).tried = tried; throw err; }
    } finally { release(); }
    try { await delay(retryDelay, undefined, { signal: opts.signal }); }
    catch (error) { opts.signal?.throwIfAborted(); throw error; }
  }
  throw Object.assign(new Error(`request failed twice: ${url}`), { tried });
}

/** Binary originals use the same proxy, host quota and cancellation as text reads.
 * Never decode/re-encode them: their content digest is the provenance contract. */
export async function webGetBytes(url: string, opts: { signal?: AbortSignal; timeout?: number; maxBytes?: number } = {}) {
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("Only credential-free HTTP(S) sources are allowed");
  const limit = opts.maxBytes ?? 64 * 1024 * 1024;
  for (let round = 0; round < 2; round++) {
    const signal = AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(opts.timeout ?? 60000)]);
    const release = await slot(target.host, signal);
    try {
      const response = await networkFetch(url, { signal, headers: { "User-Agent": UA }, redirect: "follow" });
      if (Number(response.headers.get("content-length") ?? 0) > limit) { await response.body?.cancel(); throw new Error(`Original exceeds ${limit} bytes`); }
      if (!response.ok) { await response.body?.cancel(); if (!round && transient(response.status)) continue; throw new Error(`HTTP ${response.status}: ${url}`); }
      const parts: Buffer[] = []; let size = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Source has no body");
      try { while (true) { signal.throwIfAborted(); const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > limit) throw new Error(`Original exceeds ${limit} bytes`); parts.push(Buffer.from(next.value)); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return { bytes: Buffer.concat(parts), finalUrl: response.url || url, contentType: response.headers.get("content-type") ?? "", etag: response.headers.get("etag") };
    } catch (error) { signal.throwIfAborted(); if (round || !transientNetworkError(error)) throw error; }
    finally { release(); }
    await delay(800, undefined, { signal: opts.signal });
  }
  throw new Error(`Original download failed twice: ${url}`);
}

/* Pages an agent actually read during recent work, so checks can verify quotes against
 * what was read through the toolbox, not only against pre-fetched excerpts. */
const reads = new Map<string, string>();
// Validation must use this attempt's evidence, not another worker's last read of
// the same URL. Keep all versions: a short follow-up must not erase a full page.
const evidenceReads = new AsyncLocalStorage<{ url: string; text: string }[]>();
export function evidenceURL(url: string) {
  try {
    const parsed = new URL(url);
    // #/ and #! select actual SPA documents. Only in-page section anchors may
    // share evidence; a quote from another route cannot substantiate this page.
    if (!/^#(?:\/|!)/.test(parsed.hash)) parsed.hash = '';
    return parsed.origin + parsed.pathname.replace(/\/+$/, '') + parsed.search + parsed.hash;
  } catch { return url; }
}
export const withEvidenceReads = <T>(run: () => Promise<T>) => evidenceReads.run([], run);
export const readEvidence = (url?: string) => (evidenceReads.getStore() ?? []).filter(p => !url || evidenceURL(p.url) === evidenceURL(url));
export function rememberRead(url: string, text: string) {
  const key = evidenceURL(url);
  const local = evidenceReads.getStore();
  if (local && !local.some(p => evidenceURL(p.url) === key && p.text === text)) local.push({ url, text });
  reads.delete(key); reads.set(key, text.slice(0, 60000));
  while (reads.size > 400) reads.delete(reads.keys().next().value!);
}
export function readText(url: string) { return reads.get(evidenceURL(url)); }

/** A site that fails through the proxy is tried once directly, only to say which path is
 *  broken. Stations never switch to the direct path on their own (one network exit). */
export async function diagnoseReach(url: string, signal?: AbortSignal): Promise<{ proxy: string; directOk: boolean; direct: string } | null> {
  const configuredProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!configuredProxy) return null;
  // Diagnostics are persisted in failures and shown to agents. A proxy URL can
  // contain credentials or private query parameters, so expose only its origin.
  let proxy = '已配置的代理';
  try { const endpoint = new URL(configuredProxy); proxy = `${endpoint.protocol}//${endpoint.host}`; } catch { /* Keep malformed values private too. */ }
  const direct = new DirectAgent({ connect: { timeout: 8000 } });
  try {
    const res = await proxyFetch(url, { redirect: "follow", dispatcher: direct, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10000)]), headers: { "User-Agent": UA } });
    await res.body?.cancel().catch(() => {});
    return { proxy, directOk: res.status < 500, direct: `直连返回 HTTP ${res.status}` };
  } catch (e) {
    return { proxy, directOk: false, direct: `直连也失败（${errorText(e).trim().slice(0, 80)}）` };
  } finally { await direct.destroy().catch(() => {}); }
}
