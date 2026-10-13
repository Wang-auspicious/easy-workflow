import crypto from 'node:crypto';
import type { SourceSpec, SourceCandidate, Stamped } from '../shared/types.ts';
import type { Factory } from './factory.ts';
import { ControlError } from './errors.ts';
import { classifyFailure } from '../shared/failures.ts';
import { webGetBytes } from './network.ts';
import { workflowValue } from './workflow-packs.ts';
import { workflowEntry } from './workflow-entry.ts';
import { batchSummary, latestBatchTokens } from '../shared/batch.ts';

type Host = Pick<Factory, 'journal' | 'runtime' | 'compiled' | 'state' | 'workflowPacks' | 'toolbox' | 'settings' | 'broker' | 'batch' | 'channels'>;
type Poll = { nextAt: number; count: number; duplicates: number; invalid?: number; attention?: string; failure?: ReturnType<typeof classifyFailure> };
type Incoming = { url: string; title?: string; author?: string; publishedAt?: string; excerpt?: string; images?: string[] };
const MAX_BACKLOG = 500;
const CANDIDATE_PREVIEW_LIMIT = 50;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const plainRecord = (value: unknown): value is Record<string, unknown> =>
  record(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
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
  private readonly f: Host;
  private readonly definitions = new Map<string, SourceSpec>();
  private readonly polls = new Map<string, Poll>();
  private readonly requests = new Map<string, {at: number; nextAt: number}[]>();
  private readonly candidates = new Map<string, SourceCandidate>();
  private readonly authors = new Map<string, {accepted: number; rejected: number}>();
  private readonly jobs = new Map<string, {promise: Promise<unknown>; controller: AbortController}>();
  private readonly unsubscribe: () => void;
  private readonly now: () => number;
  private readonly random: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private scheduled = false;
  private polling = false;
  private closed = false;

  constructor(factory: Host, options: {now?: () => number; random?: () => number} = {}) {
    this.f = factory;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    for (const event of factory.journal.read()) this.apply(event);
    this.unsubscribe = () => {};
    if (process.env.FACTORY_READONLY === '1') return;
    // The complete committed batch must be projected before terminal consumers
    // inspect a candidate whose delivered receipt follows token.finished.
    const projection = factory.journal.subscribeProjection(event => this.apply(event));
    const consumer = factory.journal.subscribe(event => {
      if (event.kind === 'token.finished') this.completeCandidate(event.token);
      if (event.kind === 'source.candidate' && event.candidate.targetToken) {
        this.completeCandidate(event.candidate.targetToken);
      }
      if (['source.configured', 'source.candidate', 'run.started', 'run.resumed',
        'scope.paused', 'factory.loaded', 'batch.configured', 'token.finished'].includes(event.kind)) {
        this.schedule();
      }
    });
    this.unsubscribe = () => {
      projection();
      consumer();
    };
    for (const token of Object.values(factory.state.tokens)) this.completeCandidate(token.id);
  }

  private writable() {
    if (process.env.FACTORY_READONLY === '1') {
      throw new ControlError(403, 'read_only', '只读项目不能操作来源');
    }
    if (this.closed) throw new ControlError(409, 'sources_closed', '来源调度已关闭');
  }

  private apply(event: Stamped) {
    if (event.kind === 'source.configured') {
      this.definitions.set(event.source.id, event.source);
    }
    if (event.kind === 'source.polled') {
      this.polls.set(event.source, {
        nextAt: event.nextAt, count: event.count, duplicates: event.duplicates,
        invalid: event.invalid, attention: event.attention, failure: event.failure,
      });
    }
    if (event.kind === 'source.requested') {
      const requests = this.requests.get(event.platform) ?? [];
      requests.push({at: event.requestedAt, nextAt: event.nextRequestAt ?? event.requestedAt + 10000});
      this.requests.set(event.platform, requests.filter(request => event.requestedAt - request.at < 86400000));
    }
    if (event.kind === 'source.candidate') this.candidates.set(event.candidate.id, event.candidate);
    if (event.kind === 'source.reputation') {
      this.authors.set(`${event.platform}:${event.author}`, {accepted: event.accepted, rejected: event.rejected});
    }
  }

  list() {
    return [...this.definitions.values()].map(source => {
      const counts = {total: 0, pending: 0, blocked: 0, delivered: 0, acknowledged: 0, rejected: 0, failed: 0};
      const recent: SourceCandidate[] = [];
      for (const candidate of this.candidates.values()) {
        if (candidate.source !== source.id && !candidate.origins?.some(origin => origin.source === source.id)) continue;
        counts[candidate.status]++;
        recent[counts.total % CANDIDATE_PREVIEW_LIMIT] = candidate;
        counts.total++;
      }
      // A bounded ring preserves discovery order without materializing every
      // historical candidate again for a periodically refreshed UI response.
      const start = counts.total > recent.length ? counts.total % CANDIDATE_PREVIEW_LIMIT : 0;
      return {
        ...source,
        ...(this.polls.get(source.id) ?? {nextAt: 0, count: 0, duplicates: 0}),
        nextAllowedAt: this.allowedAt(source, this.now()),
        deferred: this.collectionDeferral(source),
        deliveryHold: this.deliveryHold(source),
        running: this.jobs.has(source.id),
        counts, candidateLimit: CANDIDATE_PREVIEW_LIMIT, hasMoreCandidates: counts.total > recent.length,
        candidates: [...recent.slice(start), ...recent.slice(0, start)]
          .map(candidate => ({...candidate, reputation: this.reputation(candidate)})),
      };
    });
  }

  targets() {
    return this.f.compiled.nodes.flatMap(node => {
      try {
        const {pack} = this.target({target: node.key});
        return [{key: node.key, name: node.name, line: node.line, packId: pack?.id}];
      } catch {
        return [];
      }
    });
  }

  /** Only a declared entry or an independent line root can receive raw input. */
  private target(source: Pick<SourceSpec, 'target'>) {
    const f = this.f;
    const node = f.runtime.nodes.get(source.target);
    const line = node && f.compiled.lines.find(line => line.id === node.line);
    if (!node || !line?.wired || node.dormant || node.kind === 'source') {
      throw new ControlError(422, 'source_target_missing', '来源目标必须是已启用流水线的合法入口');
    }
    const pack = f.workflowPacks?.manifests.find(pack => pack.lines.some(line => line.id === node.line));
    const declared = pack?.entry === node.key;
    if (!declared) {
      const roots = f.compiled.nodes.filter(candidate => candidate.line === line.id &&
        !f.compiled.edges.some(edge => edge.kind === 'flow' && edge.to === candidate.key &&
          f.runtime.nodes.get(edge.from)?.kind !== 'source'));
      const incomingChannel = f.compiled.channels.some(channel => channel.to.line === line.id);
      if (roots.length !== 1 || roots[0].key !== node.key || incomingChannel) {
        throw new ControlError(422, 'source_target_not_entry', '来源只能进入独立流水线的唯一入口，不能跳过已有上游');
      }
    }
    let bound = node;
    const visited = new Set<string>();
    while (bound.kind === 'store') {
      if (visited.has(bound.key)) break;
      visited.add(bound.key);
      const next = f.runtime.outFlow.get(bound.key) ?? [];
      if (next.length !== 1) break;
      const successor = f.runtime.nodes.get(next[0].to);
      if (!successor) break;
      bound = successor;
    }
    if (!f.runtime.runnable(bound) || !f.runtime.executors(bound) || pack && !pack.bindings[bound.key]) {
      throw new ControlError(422, 'source_target_not_entry', '来源入口必须连接真实执行契约，不能直接进入终态库存');
    }
    return {node, pack, declared};
  }

  configure(source: SourceSpec) {
    this.writable();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(source.id) || !source.name?.trim() ||
        !['rss', 'json', 'browser'].includes(source.format) ||
        !Number.isSafeInteger(source.intervalMs) || source.intervalMs < 10000 || source.intervalMs > 30 * 86400000) {
      throw new ControlError(422, 'invalid_source', '来源需要合法 id、名称、格式以及 10秒–30天的采集间隔');
    }
    for (const [field, maximum] of [['perMinute', 6], ['perDay', 300], ['limit', 100]] as const) {
      const value = source[field];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) {
        throw new ControlError(422, 'invalid_source_limit', `${field} 必须是 1–${maximum} 的整数`);
      }
    }
    let url: string;
    try {
      url = canonical(source.url);
    } catch {
      throw new ControlError(422, 'invalid_source_url', '来源需要无内嵌凭据的完整 HTTP(S) 地址');
    }
    const host = new URL(url).hostname;
    const social = socialHosts.find(([pattern]) => pattern.test(host))?.[1];
    if (social && source.format !== 'browser') {
      throw new ControlError(422, 'social_session_required', '社交来源必须使用共享浏览器和已有登录会话');
    }
    this.target(source);
    if (source.input !== undefined && !plainRecord(source.input) ||
        source.constants !== undefined && !plainRecord(source.constants)) {
      throw new ControlError(422, 'source_input_invalid', '来源输入映射和常量必须是普通对象');
    }
    for (const [key, selector] of Object.entries(source.input ?? {})) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || typeof selector !== 'string') {
        throw new ControlError(422, 'source_input_invalid', '来源输入映射无效');
      }
      workflowValue({}, selector);
    }
    if (Object.keys(source.constants ?? {}).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) {
      throw new ControlError(422, 'source_input_invalid', '来源输入常量包含保留字段');
    }
    const next: SourceSpec = {
      ...source, url, platform: social ?? (source.platform?.trim() || host),
      enabled: Boolean(source.enabled), perMinute: source.perMinute ?? 6,
      perDay: source.perDay ?? 300, limit: source.limit ?? 50,
    };
    if (JSON.stringify(this.definitions.get(next.id)) === JSON.stringify(next)) {
      return this.list().find(value => value.id === next.id)!;
    }
    this.f.journal.append({kind: 'source.configured', source: next});
    this.jobs.get(next.id)?.controller.abort(new Error('来源配置已更新'));
    if (this.timer) void this.runDue().catch(error => console.error('source scheduler', error));
    return this.list().find(value => value.id === next.id)!;
  }

  setEnabled(id: string, enabled: boolean) {
    const source = this.definitions.get(id);
    if (!source) throw new ControlError(404, 'source_not_found', '来源不存在');
    return this.configure({...source, enabled});
  }

  start() {
    if (this.timer || this.closed || process.env.FACTORY_READONLY === '1') return;
    this.timer = setInterval(() => {
      void this.runDue().catch(error => console.error('source scheduler', error));
    }, 5000);
    this.timer.unref();
    // A missed schedule is collected once; the successful/failed poll writes the
    // next deadline before the next periodic check or process restart.
    void this.runDue().catch(error => console.error('source scheduler', error));
    this.schedule();
  }

  private limits(source: SourceSpec) {
    const group = [...this.definitions.values()].filter(value =>
      value.platform === source.platform && (value.enabled || value.id === source.id));
    return {
      minute: Math.max(1, Math.floor(Math.min(6, this.f.settings.socialPerMinute, ...group.map(value => value.perMinute ?? 6)))),
      day: Math.max(1, Math.floor(Math.min(300, this.f.settings.socialPerDay, ...group.map(value => value.perDay ?? 300)))),
    };
  }

  private allowedAt(source: SourceSpec, now: number) {
    const requests = (this.requests.get(source.platform) ?? []).filter(request => now - request.at < 86400000);
    const limits = this.limits(source);
    const minute = requests.filter(request => now - request.at < 60000);
    return Math.max(
      requests.at(-1)?.nextAt ?? 0,
      minute.length >= limits.minute ? minute[minute.length - limits.minute].at + 60000 : 0,
      requests.length >= limits.day ? requests[requests.length - limits.day].at + 86400000 : 0,
    );
  }

  private backlog() {
    return [...this.candidates.values()].filter(candidate => !['acknowledged', 'rejected'].includes(candidate.status)).length;
  }

  private collectionDeferral(source: SourceSpec) {
    if (this.backlog() >= MAX_BACKLOG) {
      return {reason: `已有 ${MAX_BACKLOG} 件来源候选未解决，待下游处理后再采集`, nextAt: this.now() + 5000};
    }
    const allowed = this.allowedAt(source, this.now());
    if (allowed > this.now()) {
      return {reason: '平台访问次数或随机间隔尚未到期', nextAt: allowed};
    }
    const blocked = source.format !== 'browser' && this.f.broker.blocked('http');
    if (blocked) {
      return {reason: `等待共享 HTTP 名额：${blocked}`, nextAt: this.now() + 5000};
    }
  }

  async runDue() {
    if (this.polling || this.closed || process.env.FACTORY_READONLY === '1') return;
    this.polling = true;
    try {
      for (const source of this.definitions.values()) {
        if (this.closed) break;
        const poll = this.polls.get(source.id);
        if (source.enabled && !poll?.attention && (poll?.nextAt ?? 0) <= this.now()) await this.run(source.id);
      }
    } finally {
      this.polling = false;
    }
  }

  async run(id: string) {
    this.writable();
    const source = this.definitions.get(id);
    if (!source) throw new ControlError(404, 'source_not_found', '来源不存在');
    const existing = this.jobs.get(id);
    if (existing) return existing.promise;
    const deferred = this.collectionDeferral(source);
    if (deferred) return {deferred: true, ...deferred};
    const lease = source.format === 'browser' ? undefined : this.f.broker.tryAcquire('http');
    if (lease === null) {
      return {deferred: true, reason: '等待共享 HTTP 名额', nextAt: this.now() + 5000};
    }
    const now = this.now();
    const controller = new AbortController();
    const nextRequestAt = now + Math.ceil(60000 / this.limits(source).minute * (1 + this.random() * 0.2));
    try {
      this.f.journal.append({kind: 'source.requested', source: id, platform: source.platform, requestedAt: now, nextRequestAt});
      const promise = this.collect(source, controller.signal).finally(() => {
        this.jobs.delete(id);
        lease?.release();
      });
      this.jobs.set(id, {promise, controller});
      return promise;
    } catch (error) {
      lease?.release();
      throw error;
    }
  }

  private async collect(source: SourceSpec, signal: AbortSignal) {
    const nextAt = this.now() + source.intervalMs + Math.floor(source.intervalMs * this.random() * 0.1);
    try {
      let incoming: unknown[];
      if (source.format === 'browser') {
        const result: unknown = await this.f.toolbox.call(['page_text'], 'page_text', {url: source.url, max: 40000}, {node: `sources/${source.platform}`, signal});
        if (!record(result)) throw new Error('共享浏览器来源返回无效记录');
        if (result.ok === false) {
          const failure = record(result.failure) ? result.failure : undefined;
          throw Object.assign(new Error(typeof failure?.message === 'string' ? failure.message : '共享浏览器来源读取失败'), {failure});
        }
        const links: unknown = result.links;
        incoming = Array.isArray(links) ? links.filter(link => record(link) &&
          !['nav', 'footer'].includes(String(link.region ?? ''))).map(link => ({
            url: link.href, title: link.text,
            excerpt: typeof result.text === 'string' ? result.text.slice(0, 1000) : undefined,
          })) : [];
      } else {
        const result = await webGetBytes(source.url, {signal, timeout: 15000, maxBytes: 2 * 1024 * 1024});
        const body = new TextDecoder().decode(result.bytes);
        if (source.format === 'rss') incoming = feedItems(body);
        else {
          const parsed: unknown = JSON.parse(body);
          const items = Array.isArray(parsed) ? parsed : record(parsed) ? parsed.items ?? parsed.entries : undefined;
          if (!Array.isArray(items)) throw new Error('JSON 来源必须返回数组或 items/entries 数组');
          incoming = items;
        }
      }
      signal.throwIfAborted();
      let count = 0;
      let duplicates = 0;
      let invalid = 0;
      for (const raw of incoming.slice(0, source.limit ?? 50)) {
        if (!record(raw) || typeof raw.url !== 'string' || !raw.url.trim()) {
          invalid++;
          continue;
        }
        let url: string;
        try {
          url = canonical(raw.url, source.url);
        } catch {
          invalid++;
          continue;
        }
        if ((source.externalLinksOnly ?? source.format === 'browser') && new URL(url).origin === new URL(source.url).origin) continue;
        const id = `source-item-${hash(url)}`;
        const published = typeof raw.publishedAt === 'string' ? new Date(raw.publishedAt) : undefined;
        const candidate: SourceCandidate = {
          id, source: source.id, platform: source.platform, sourceUrl: source.url, url,
          title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.slice(0, 300) : new URL(url).hostname,
          author: typeof raw.author === 'string' ? raw.author.slice(0, 120) : undefined,
          publishedAt: published && Number.isFinite(published.getTime()) ? published.toISOString() : undefined,
          excerpt: typeof raw.excerpt === 'string' ? raw.excerpt.slice(0, 5000) : undefined,
          images: Array.isArray(raw.images) ? raw.images.slice(0, 8).flatMap(image => {
            if (typeof image !== 'string') return [];
            try { return [canonical(image, source.url)]; } catch { return []; }
          }) : undefined,
          discoveredAt: this.now(), status: 'pending',
        };
        const previous = this.candidates.get(id);
        if (previous) {
          duplicates++;
          const origin = this.origin(candidate);
          const origins = previous.origins ?? [this.origin(previous)];
          if (!origins.some(value => value.source === origin.source && value.sourceUrl === origin.sourceUrl)) {
            this.f.journal.append({kind: 'source.candidate', candidate: {...previous, origins: [...origins, origin]}});
          }
          continue;
        }
        if (this.backlog() >= MAX_BACKLOG) break;
        this.f.journal.append({kind: 'source.candidate', candidate});
        count++;
      }
      this.f.journal.append({kind: 'source.polled', source: source.id, nextAt, count, duplicates, invalid});
      this.schedule();
      return {ok: true, count, duplicates, invalid, nextAt};
    } catch (error) {
      if (signal.aborted) return {ok: false, cancelled: true};
      const reported = record(error) ? error.failure : undefined;
      const failure = record(reported) && typeof reported.message === 'string'
        ? reported as unknown as ReturnType<typeof classifyFailure>
        : classifyFailure(error, {url: source.url});
      const attention = failure.owner === 'user' || failure.tag === 'tool_error' ? failure.message : undefined;
      this.f.journal.append({kind: 'source.polled', source: source.id, nextAt, count: 0, duplicates: 0, attention, failure});
      return {ok: false, failure, attention, nextAt};
    }
  }

  private origin(candidate: SourceCandidate): NonNullable<SourceCandidate['origins']>[number] {
    const {source, sourceUrl, platform, author, publishedAt, excerpt, images} = candidate;
    return {source, sourceUrl, platform, author, publishedAt, excerpt, images};
  }

  private reputation(candidate: SourceCandidate) {
    const history = candidate.author && this.authors.get(`${candidate.platform}:${candidate.author}`);
    return history ? (history.accepted + 1) / (history.accepted + history.rejected + 2) : 0.5;
  }

  private completeCandidate(tokenId: string) {
    const token = this.f.state.tokens[tokenId];
    if (!token || token.status === 'active') return;
    const id = token.data.sourceCandidate;
    const candidate = typeof id === 'string' && this.candidates.get(id);
    if (!candidate || candidate.status === 'acknowledged' || !candidate.targetToken) return;
    let ancestor: typeof token | undefined = token;
    const visited = new Set<string>();
    while (ancestor && ancestor.id !== candidate.targetToken && !visited.has(ancestor.id)) {
      visited.add(ancestor.id);
      ancestor = this.f.state.tokens[String(ancestor.data.retryOf ?? '')];
    }
    if (!ancestor || ancestor.id !== candidate.targetToken) return;
    const accepted = token.status === 'published' || token.status === 'merged';
    const status = accepted ? 'acknowledged' : token.status === 'rejected' ? 'rejected' : 'failed';
    if (candidate.status === status && candidate.targetToken === tokenId) return;
    this.f.runtime.atomicTransition(() => {
      this.f.journal.append({kind: 'source.candidate', candidate: {
        ...candidate, status, targetToken: tokenId, reason: token.reason,
      }});
      const failure = token.data.failure as {owner?: string} | undefined;
      if (candidate.author && (accepted || status === 'rejected' || !failure || failure.owner === 'agent')) {
        const previous = this.authors.get(`${candidate.platform}:${candidate.author}`) ?? {accepted: 0, rejected: 0};
        const original = this.f.state.tokens[candidate.targetToken!];
        const originalFailure = original?.data.failure as {owner?: string} | undefined;
        const wasRejected = ['failed', 'rejected'].includes(candidate.status) &&
          (original?.status === 'rejected' || !originalFailure || originalFailure.owner === 'agent');
        if (!accepted && wasRejected) return;
        this.f.journal.append({kind: 'source.reputation', platform: candidate.platform, author: candidate.author,
          accepted: previous.accepted + Number(accepted),
          rejected: Math.max(0, previous.rejected + Number(!accepted) - Number(accepted && wasRejected)),
        });
      }
    });
  }

  private schedule() {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.closed) {
        try { this.pump(); } catch (error) { console.error('source delivery', error); }
      }
    });
  }

  private deliveryHold(source: SourceSpec) {
    const f = this.f;
    if (!source.enabled) return '来源已停用；单次采集只保存候选';
    if (!f.runtime.running || f.runtime.paused || f.runtime.ending) return '等待运行中的未暂停轮次';
    if (f.runtime.scopePaused(source.target)) return '来源下游已局部暂停';
    if (f.broker.modelHold) return f.broker.modelHold;
    const goal = f.state.batch?.runId === f.state.run.id ? batchSummary(f.state) : null;
    if (goal && (goal.mode !== 'running' || goal.modelCircuit || goal.remaining <= 0)) return '当前托管目标已暂停、阻塞或已领取足够任务';
    if (goal && (source.target !== 'candidates/tidy' || goal.category || goal.query)) return '保留候选，等待不受当前托管筛选范围限制的轮次';
    if (goal) {
      if (goal.active >= goal.maxInFlight) return `已达到 ${goal.maxInFlight} 件托管在途任务的入场上限`;
      const upstream = latestBatchTokens(f.state).filter(token => token.status === 'active' &&
        !f.runtime.tokens.get(token.id)?.done.has('curation/plan')).length;
      if (upstream >= goal.intakeWindow) return `已达到 ${goal.intakeWindow} 件前段任务的入场上限`;
      return;
    }
    const limit = 1;
    const inFlight = [...f.runtime.tokens.values()].filter(token => !token.finished).length;
    if (inFlight >= limit) return `已达到 ${limit} 件执行或排队任务的入场上限，等待现有任务让出名额`;
  }

  /** The batch owns managed admission so subscriber order cannot take its slot. */
  pump(): number {
    if (this.closed || process.env.FACTORY_READONLY === '1') return 0;
    if (this.f.state.batch?.runId === this.f.state.run.id) {
      this.f.batch.schedule();
      return 0;
    }
    const vacant = ![...this.f.runtime.tokens.values()].some(token => !token.finished);
    if (vacant && this.channelHasNextTurn()) {
      const admitted = this.f.channels?.pump() ?? 0;
      if (admitted) return admitted;
    }
    return this.admitUnmanaged(1);
  }

  /** A retry keeps its original place; only a new automatic root changes turns. */
  channelHasNextTurn() {
    const state = this.f.state;
    for (let i = state.tokenOrder.length - 1; i >= 0; i--) {
      const token = state.tokens[state.tokenOrder[i]];
      if (!token || token.createdAt < state.run.startedAt || token.data.retryOf) continue;
      if (token.data.channelDelivery || token.source.startsWith('channel:')) return false;
      if (token.data.sourceCandidate || token.source.startsWith('source:')) return true;
    }
    return false;
  }

  admitManaged(limit: number) {
    if (this.f.state.batch?.runId !== this.f.state.run.id) return 0;
    return this.admit(limit);
  }

  /** Called directly by the channel consumer, without delegating back to it. */
  admitUnmanaged(limit: number) {
    if (this.f.state.batch?.runId === this.f.state.run.id) return 0;
    return this.admit(limit);
  }

  private admit(limit: number) {
    const f = this.f;
    if (this.closed || process.env.FACTORY_READONLY === '1') return 0;
    let admitted = 0;
    const queued = [...this.candidates.values()]
      .filter(candidate => ['pending', 'blocked'].includes(candidate.status))
      .sort((a, b) => this.reputation(b) - this.reputation(a) || a.discoveredAt - b.discoveredAt);
    for (const candidate of queued) {
      if (admitted >= limit) break;
      const source = this.definitions.get(candidate.source);
      if (!source || this.deliveryHold(source)) continue;
      let input: Record<string, unknown>;
      let target: ReturnType<SourceSupervisor['target']>;
      try {
        target = this.target(source);
        const fields = {...candidate, text: candidate.excerpt || candidate.title, value: candidate.url};
        const properties = target.declared && target.pack
          ? target.pack.schemas[target.pack.inputSchema]?.properties
          : fields;
        input = source.input
          ? Object.fromEntries(Object.entries(source.input).map(([key, selector]) => [key, workflowValue(fields, selector)]))
          : Object.fromEntries(Object.keys(record(properties) ? properties : {url: {}})
            .filter(key => Object.hasOwn(fields, key)).map(key => [key, fields[key as keyof typeof fields]]));
        input = {...input, ...source.constants};
        if (target.pack) {
          const entry = workflowEntry(target.pack, input, target.declared ? undefined : target.node.line);
          if (entry !== source.target) throw new Error('来源目标不再是已安装包的合法入口');
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : '来源输入或入口契约无效';
        if (candidate.status !== 'blocked' || candidate.reason !== reason) {
          f.journal.append({kind: 'source.candidate', candidate: {...candidate, status: 'blocked', reason}});
        }
        continue;
      }
      f.runtime.atomicTransition(() => {
        const token = f.runtime.create(source.target, {
          item: candidate.id, url: candidate.url, title: candidate.title, source: `source:${source.id}`,
          data: {input, canonical: candidate.url, express: true, sourceCandidate: candidate.id,
            sourceRecord: {...candidate, reputation: this.reputation(candidate)},
            ...(target.pack ? {workflowPack: target.pack.id} : {}),
          },
        });
        f.journal.append({kind: 'source.candidate', candidate: {
          ...candidate, status: 'delivered', targetToken: token.id, reason: undefined,
        }});
      });
      admitted++;
    }
    return admitted;
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe();
    for (const job of this.jobs.values()) job.controller.abort(new Error('来源调度关闭'));
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise));
  }
}
