import crypto from 'node:crypto';
import { Check } from 'typebox/value';
import type { TSchema } from 'typebox';
import type { SourceSpec, SourceCandidate, Stamped } from '../shared/types.ts';
import type { Factory } from './factory.ts';
import { ControlError } from './errors.ts';
import { classifyFailure } from '../shared/failures.ts';
import { webGet } from './network.ts';
import { workflowValue } from './workflow-packs.ts';

type Host = Pick<Factory, 'journal' | 'runtime' | 'compiled' | 'state' | 'workflowPacks' | 'toolbox'>;
type Poll = { nextAt: number; count: number; duplicates: number; attention?: string };
type Incoming = { url: string; title?: string; author?: string; publishedAt?: string; excerpt?: string; images?: string[] };
const socialHosts: [RegExp, string][] = [[/(^|\.)(x|twitter)\.com$/, 'x'], [/(^|\.)xiaohongshu\.com$|(^|\.)xhslink\.com$/, 'xhs'], [/(^|\.)bilibili\.com$|(^|\.)b23\.tv$/, 'bilibili'], [/(^|\.)douyin\.com$/, 'douyin']];
function canonical(value: string, base?: string) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('来源只接受无内嵌凭据的 HTTP(S) 地址');
  for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort(); if (!/^#(?:\/|!)/.test(url.hash)) url.hash = '';
  return url.href;
}
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
const decode = (text: string) => text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[\da-f]+|\d+);/gi, entity => {
  const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
  if (named[entity]) return named[entity];
  const code = Number.parseInt(entity.slice(entity[2].toLowerCase() === 'x' ? 3 : 2, -1), entity[2].toLowerCase() === 'x' ? 16 : 10);
  return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
}).replace(/\s+/g, ' ').trim();
function feedItems(xml: string): Incoming[] {
  const text = (block: string, tags: string[]) => decode(new RegExp(`<(?:${tags.join('|')})\\b[^>]*>([\\s\\S]*?)<\\/(?:${tags.join('|')})>`, 'i').exec(block)?.[1] ?? '');
  return [...xml.matchAll(/<(item|entry|url)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(([, , block]) => ({
    url: text(block, ['link', 'loc']) || /<link\b[^>]*href=["']([^"']+)["']/i.exec(block)?.[1] || '',
    title: text(block, ['title']), author: text(block, ['dc:creator', 'author']),
    publishedAt: text(block, ['pubDate', 'published', 'updated', 'lastmod']), excerpt: text(block, ['description', 'summary', 'content:encoded', 'content']),
  }));
}

export class SourceSupervisor {
  private f: Host;
  private definitions = new Map<string, SourceSpec>();
  private polls = new Map<string, Poll>();
  private requests = new Map<string, { at: number; nextAt: number }[]>();
  private candidates = new Map<string, SourceCandidate>();
  private authors = new Map<string, { accepted: number; rejected: number }>();
  private jobs = new Map<string, { promise: Promise<unknown>; controller: AbortController }>();
  private unsubscribe: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private scheduled = false;
  private polling = false;
  private closed = false;
  private now: () => number;
  private random: () => number;
  constructor(factory: Host, options: { now?: () => number; random?: () => number } = {}) {
    this.f = factory; this.now = options.now ?? Date.now; this.random = options.random ?? Math.random;
    for (const event of factory.journal.read()) this.apply(event);
    this.unsubscribe = process.env.FACTORY_READONLY === '1' ? () => {} : factory.journal.subscribe(event => {
      this.apply(event);
      if (event.kind === 'token.finished') this.completeCandidate(event.token);
      if (['source.candidate', 'run.started', 'run.resumed', 'scope.paused', 'token.finished'].includes(event.kind)) this.schedule();
    });
    if (process.env.FACTORY_READONLY !== '1') for (const candidate of this.candidates.values()) if (candidate.targetToken) this.completeCandidate(candidate.targetToken);
  }
  private writable() { if (process.env.FACTORY_READONLY === '1') throw new ControlError(403, 'read_only', '只读项目不能操作来源'); }
  private apply(event: Stamped) {
    if (event.kind === 'source.configured') { this.definitions.set(event.source.id, event.source); if (event.source.enabled) this.polls.delete(event.source.id); }
    if (event.kind === 'source.polled') this.polls.set(event.source, { nextAt: event.nextAt, count: event.count, duplicates: event.duplicates, attention: event.attention });
    if (event.kind === 'source.requested') {
      const requests = this.requests.get(event.platform) ?? []; requests.push({ at: event.requestedAt, nextAt: event.nextRequestAt ?? event.requestedAt + 10000 });
      this.requests.set(event.platform, requests.filter(request => event.requestedAt - request.at < 86400000));
    }
    if (event.kind === 'source.candidate') this.candidates.set(event.candidate.id, event.candidate);
    if (event.kind === 'source.reputation') this.authors.set(`${event.platform}:${event.author}`, { accepted: event.accepted, rejected: event.rejected });
  }
  list() {
    return [...this.definitions.values()].map(source => ({ ...source, ...(this.polls.get(source.id) ?? { nextAt: 0, count: 0, duplicates: 0 }),
      nextAllowedAt: this.allowedAt(source, this.now()), running: this.jobs.has(source.id),
      candidates: [...this.candidates.values()].filter(candidate => candidate.source === source.id).map(candidate => ({ ...candidate, reputation: this.reputation(candidate) })),
    }));
  }
  configure(source: SourceSpec) {
    this.writable();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(source.id) || !source.name?.trim() || !['rss', 'json', 'browser'].includes(source.format) || !Number.isSafeInteger(source.intervalMs) || source.intervalMs < 10000 || source.intervalMs > 30 * 86400000) throw new ControlError(422, 'invalid_source', '来源需要合法 id、名称、格式以及 10秒–30天的采集间隔');
    const url = canonical(source.url), host = new URL(url).hostname, social = socialHosts.find(([pattern]) => pattern.test(host))?.[1];
    if (social && source.format !== 'browser') throw new ControlError(422, 'social_session_required', '社交来源必须使用共享浏览器和已有登录会话');
    const target = this.f.runtime.nodes.get(source.target);
    if (!target) throw new ControlError(422, 'source_target_missing', '来源下游工位不存在');
    for (const [key, selector] of Object.entries(source.input ?? {})) { if (['__proto__', 'constructor', 'prototype'].includes(key) || typeof selector !== 'string') throw new ControlError(422, 'source_input_invalid', '来源输入映射无效'); workflowValue({}, selector); }
    const next = { ...source, url, platform: social ?? (source.platform?.trim() || host), enabled: Boolean(source.enabled), perMinute: Math.min(6, Math.max(1, Number(source.perMinute) || 6)), perDay: Math.min(300, Math.max(1, Number(source.perDay) || 300)), limit: Math.min(100, Math.max(1, Number(source.limit) || 50)) };
    this.f.journal.append({ kind: 'source.configured', source: next });
    if (!next.enabled) this.jobs.get(next.id)?.controller.abort(new Error('来源已停用'));
    return this.list().find(value => value.id === next.id)!;
  }
  setEnabled(id: string, enabled: boolean) { const source = this.definitions.get(id); if (!source) throw new ControlError(404, 'source_not_found', '来源不存在'); return this.configure({ ...source, enabled }); }
  start() {
    if (this.timer || this.closed || process.env.FACTORY_READONLY === '1') return;
    this.timer = setInterval(() => { void this.runDue().catch(error => console.error('source scheduler', error)); }, 5000); this.timer.unref();
    this.schedule();
  }
  private limits(source: SourceSpec) {
    const group = [...this.definitions.values()].filter(value => value.platform === source.platform && (value.enabled || value.id === source.id));
    return { minute: Math.min(6, ...group.map(value => value.perMinute ?? 6)), day: Math.min(300, ...group.map(value => value.perDay ?? 300)) };
  }
  private allowedAt(source: SourceSpec, now: number) {
    const requests = (this.requests.get(source.platform) ?? []).filter(request => now - request.at < 86400000), limits = this.limits(source);
    const minute = requests.filter(request => now - request.at < 60000);
    return Math.max(requests.at(-1)?.nextAt ?? 0, minute.length >= limits.minute ? minute[minute.length - limits.minute].at + 60000 : 0, requests.length >= limits.day ? requests[requests.length - limits.day].at + 86400000 : 0);
  }
  async runDue() {
    if (this.polling || this.closed || process.env.FACTORY_READONLY === '1') return;
    this.polling = true;
    try { for (const source of this.definitions.values()) { const poll = this.polls.get(source.id); if (source.enabled && !poll?.attention && (poll?.nextAt ?? 0) <= this.now()) await this.run(source.id); } }
    finally { this.polling = false; }
  }
  async run(id: string) {
    this.writable();
    if (this.closed) throw new ControlError(409, 'sources_closed', '来源调度已关闭');
    const source = this.definitions.get(id); if (!source) throw new ControlError(404, 'source_not_found', '来源不存在');
    const existing = this.jobs.get(id); if (existing) return existing.promise;
    const now = this.now(), allowed = this.allowedAt(source, now);
    if (allowed > now) return { deferred: true, nextAt: allowed, reason: '平台访问次数或随机间隔尚未到期' };
    const controller = new AbortController();
    const nextRequestAt = now + Math.ceil(60000 / this.limits(source).minute * (1 + this.random() * 0.2));
    this.f.journal.append({ kind: 'source.requested', source: id, platform: source.platform, requestedAt: now, nextRequestAt });
    const promise = this.collect(source, controller.signal).finally(() => { this.jobs.delete(id); });
    this.jobs.set(id, { promise, controller }); return promise;
  }
  private async collect(source: SourceSpec, signal: AbortSignal) {
    const nextAt = this.now() + source.intervalMs + Math.floor(source.intervalMs * this.random() * 0.1);
    try {
      let incoming: Incoming[];
      if (source.format === 'browser') {
        const result = await this.f.toolbox.call(['page_text'], 'page_text', { url: source.url, max: 40000 }, { node: `sources/${source.platform}`, signal });
        if (result.ok === false) throw Object.assign(new Error(result.failure?.message ?? '共享浏览器来源读取失败'), { failure: result.failure });
        incoming = ((result as { links?: { href: string; text?: string; region?: string }[] }).links ?? []).filter(link => !['nav', 'footer'].includes(link.region ?? '')).map(link => ({ url: link.href, title: link.text, excerpt: (result as { text?: string }).text?.slice(0, 1000) }));
      } else {
        const result = await webGet(source.url, { signal, cache: false, timeout: 15000 });
        if (result.status >= 400) throw Object.assign(new Error(`HTTP ${result.status}`), { failure: classifyFailure(`HTTP ${result.status}`, { url: source.url, status: result.status }) });
        if (source.format === 'rss') incoming = feedItems(result.body);
        else { const parsed = JSON.parse(result.body); incoming = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.entries; if (!Array.isArray(incoming)) throw new Error('JSON 来源必须返回数组或 items/entries 数组'); }
      }
      signal.throwIfAborted();
      let count = 0, duplicates = 0;
      for (const raw of incoming.slice(0, source.limit ?? 50)) {
        let url: string; try { url = canonical(raw.url, source.url); } catch { continue; }
        if ((source.externalLinksOnly ?? source.format === 'browser') && new URL(url).origin === new URL(source.url).origin) continue;
        const id = `source-item-${hash(url)}`;
        if (this.candidates.has(id)) { duplicates++; continue; }
        const published = raw.publishedAt && new Date(raw.publishedAt);
        const candidate: SourceCandidate = { id, source: source.id, platform: source.platform, sourceUrl: source.url, url, title: String(raw.title || new URL(url).hostname).slice(0, 300), author: typeof raw.author === 'string' ? raw.author.slice(0, 120) : undefined,
          publishedAt: published && Number.isFinite(published.getTime()) ? published.toISOString() : undefined, excerpt: typeof raw.excerpt === 'string' ? raw.excerpt.slice(0, 5000) : undefined,
          images: Array.isArray(raw.images) ? raw.images.slice(0, 8).flatMap(image => { try { return [canonical(image, source.url)]; } catch { return []; } }) : undefined, discoveredAt: this.now(), status: 'pending' };
        this.f.journal.append({ kind: 'source.candidate', candidate }); count++;
      }
      this.f.journal.append({ kind: 'source.polled', source: source.id, nextAt, count, duplicates }); this.schedule();
      return { ok: true, count, duplicates, nextAt };
    } catch (error) {
      if (signal.aborted) return { ok: false, cancelled: true };
      const failure = (error as { failure?: ReturnType<typeof classifyFailure> })?.failure ?? classifyFailure(error, { url: source.url });
      const attention = failure.owner === 'user' || failure.tag === 'tool_error' ? failure.message : undefined;
      this.f.journal.append({ kind: 'source.polled', source: source.id, nextAt, count: 0, duplicates: 0, attention, failure });
      return { ok: false, failure, attention, nextAt };
    }
  }
  private reputation(candidate: SourceCandidate) {
    const history = candidate.author && this.authors.get(`${candidate.platform}:${candidate.author}`);
    return history ? (history.accepted + 1) / (history.accepted + history.rejected + 2) : 0.5;
  }
  private completeCandidate(tokenId: string) {
    const token = this.f.state.tokens[tokenId]; if (!token || token.status === 'active') return;
    const id = token.data.sourceCandidate;
    const candidate = typeof id === 'string' && this.candidates.get(id); if (!candidate || candidate.status === 'acknowledged' || candidate.targetToken !== tokenId) return;
    const accepted = token.status === 'published' || token.status === 'merged';
    if (candidate.status === 'failed' && !accepted) return;
    this.f.runtime.atomicTransition(() => {
      this.f.journal.append({ kind: 'source.candidate', candidate: { ...candidate, status: accepted ? 'acknowledged' : 'failed', reason: token.reason } });
      const failure = token.data.failure as { owner?: string } | undefined;
      if (candidate.author && (accepted || !failure || failure.owner === 'agent')) {
        const previous = this.authors.get(`${candidate.platform}:${candidate.author}`) ?? { accepted: 0, rejected: 0 };
        this.f.journal.append({ kind: 'source.reputation', platform: candidate.platform, author: candidate.author, accepted: previous.accepted + Number(accepted), rejected: previous.rejected + Number(!accepted) });
      }
    });
  }
  private schedule() {
    if (this.scheduled || this.closed) return; this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; if (!this.closed) try { this.pump(); } catch (error) { console.error('source delivery', error); } });
  }
  pump() {
    const f = this.f;
    if (this.closed || !f.runtime.running || f.runtime.paused || f.runtime.ending) return;
    let slots = Math.max(0, 12 - [...f.runtime.tokens.values()].filter(token => !token.finished).length);
    const queued = [...this.candidates.values()].filter(candidate => ['pending', 'blocked'].includes(candidate.status)).sort((a, b) => this.reputation(b) - this.reputation(a) || a.discoveredAt - b.discoveredAt);
    for (const candidate of queued) {
      if (slots <= 0) break;
      const source = this.definitions.get(candidate.source); if (!source?.enabled || f.runtime.scopePaused(source.target)) continue;
      const node = f.runtime.nodes.get(source.target), targetLine = node && f.compiled.lines.find(line => line.id === node.line);
      if (!node || !targetLine?.wired || node.dormant) continue;
      const pack = f.workflowPacks?.manifests.find(pack => pack.lines.some(line => line.id === node.line));
      const fields = { ...candidate, text: candidate.excerpt || candidate.title, value: candidate.url };
      const input = source.input ? Object.fromEntries(Object.entries(source.input).map(([key, selector]) => [key, workflowValue(fields, selector)])) : Object.fromEntries(Object.keys(pack?.schemas[pack.inputSchema]?.properties as object ?? { url: {} }).filter(key => Object.hasOwn(fields, key)).map(key => [key, fields[key as keyof typeof fields]]));
      Object.assign(input, source.constants);
      if (pack?.entry === source.target && !Check(pack.schemas[pack.inputSchema] as TSchema, input)) {
        if (candidate.status !== 'blocked') f.journal.append({ kind: 'source.candidate', candidate: { ...candidate, status: 'blocked', reason: '来源输入映射不满足下游 schema，请补充映射或常量' } });
        continue;
      }
      f.runtime.atomicTransition(() => {
        const token = f.runtime.create(source.target, { item: candidate.id, url: candidate.url, title: candidate.title, source: `source:${source.id}`, data: { input, canonical: candidate.url, express: true, sourceCandidate: candidate.id, sourceRecord: { ...candidate, reputation: this.reputation(candidate) }, ...(pack ? { workflowPack: pack.id } : {}) } });
        f.journal.append({ kind: 'source.candidate', candidate: { ...candidate, status: 'delivered', targetToken: token.id, reason: undefined } });
      }); slots--;
    }
  }
  async close() { this.closed = true; clearInterval(this.timer); this.unsubscribe(); for (const job of this.jobs.values()) job.controller.abort(new Error('来源调度关闭')); await Promise.allSettled([...this.jobs.values()].map(job => job.promise)); }
}
