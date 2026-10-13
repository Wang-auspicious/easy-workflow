// Pre-run health check (Spec §30.5): before a run starts or resumes, prove the network,
// the model endpoint, a real background screenshot, disk and the project folder work.
// A failed check blocks the run and says what to fix; the result is written to ENV.md.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import {Type} from 'typebox';
import type {PreflightCheck, StationAgentBinding} from '../shared/types.ts';
import {networkFetch, networkRoute} from './network.ts';
import {openPage, browserCommand} from './browser.ts';
import {probeModelConnection, type PiModelSelection} from './pi.ts';
import {parseAgentBinding} from './agent-bindings.ts';
import {ClosedStationAgent, closedAgentConfig, type StationTool} from './mcp-station.ts';
import {factorySecrets, redactText} from './mcp-security.ts';
import { imageStatsAsync } from './evidence.ts';
import type { Broker } from "./broker.ts";
import { projectPaths } from "./workspace.ts";

async function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`超过 ${ms / 1000}s`)), ms); })]); }
  finally { clearTimeout(timer!); }
}

async function check(id: string, label: string, fn: () => Promise<{ ok: boolean; detail: string; fix?: string }>): Promise<PreflightCheck> {
  const t0 = Date.now();
  try { return { id, label, ...(await fn()), ms: Date.now() - t0 }; }
  catch (err) { return { id, label, ok: false, detail: String((err as Error).message ?? err).slice(0, 240), ms: Date.now() - t0 }; }
}

interface AgentHealth {
  ok: boolean;
  detail: string;
  fix?: string;
}

interface AgentPreflightOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function checkModelEndpoint(timeoutMs = 20000, selection?: PiModelSelection,
  signal?: AbortSignal): Promise<AgentHealth> {
  return probeModelConnection(timeoutMs, selection, signal);
}

function healthLabel(binding: StationAgentBinding) {
  return binding.adapter === 'pi' ? `Pi ${binding.provider ?? '默认供应商'}/${binding.model ?? '默认模型'}` :
    `${binding.adapter} ${binding.model}`;
}

function createHealthDirectory(dir: string) {
  const projectDirectory = fs.realpathSync(dir);
  const workDirectory = path.join(projectDirectory, 'work');
  try {
    fs.mkdirSync(workDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const work = fs.lstatSync(workDirectory);
  if (!work.isDirectory() || work.isSymbolicLink()) {
    throw new Error('模型体检的 work 目录必须是项目内的真实文件夹，不能是符号链接');
  }
  const directory = fs.mkdtempSync(path.join(workDirectory, '.preflight-'));
  return {directory, projectDirectory, workDirectory};
}

function removeHealthDirectory(scope: ReturnType<typeof createHealthDirectory>) {
  const directory = path.resolve(scope.directory);
  const workDirectory = path.resolve(scope.workDirectory);
  if (path.dirname(directory) !== workDirectory || !path.basename(directory).startsWith('.preflight-') ||
      path.dirname(workDirectory) !== path.resolve(scope.projectDirectory) ||
      fs.realpathSync(workDirectory) !== workDirectory || fs.lstatSync(workDirectory).isSymbolicLink()) {
    throw new Error('模型体检目录的边界已改变，未执行清理');
  }
  // Only this invocation's freshly created directory is owned by the probe.
  // Never scan or remove directories left by another attempt or user session.
  fs.rmSync(directory, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
}

async function checkClosedEndpoint(dir: string, binding: Exclude<StationAgentBinding, {adapter: 'pi'}>,
  options: AgentPreflightOptions): Promise<AgentHealth> {
  options.signal?.throwIfAborted();
  const timeoutMs = Math.min(options.timeoutMs ?? 20000, binding.requestTimeoutMs ?? 20000);
  const scope = createHealthDirectory(dir);
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason);
  const timer = setTimeout(() => controller.abort(new Error(`模型体检超过 ${timeoutMs / 1000}s`)), timeoutMs);
  options.signal?.addEventListener('abort', cancel, {once: true});
  let agent: ClosedStationAgent | undefined;
  const stop = () => agent?.abort();
  controller.signal.addEventListener('abort', stop, {once: true});
  try {
    const config = closedAgentConfig(scope.directory, scope, {...binding, requestTimeoutMs: timeoutMs});
    if (!config) throw new Error('未取得所选闭源客户端的配置');
    const nonce = crypto.randomBytes(24).toString('hex');
    let submitted = false;
    let actualModel: string | undefined;
    const submit: StationTool = {
      name: 'submit',
      label: '健康检查回执',
      description: 'Return the exact nonce to verify this isolated model connection. This is not a business task.',
      parameters: Type.Object({nonce: Type.Literal(nonce)}, {additionalProperties: false}),
      execute: async (_id: string, args: unknown, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        controller.signal.throwIfAborted();
        if (!args || typeof args !== 'object' || Array.isArray(args) ||
            (args as Record<string, unknown>).nonce !== nonce) {
          throw new Error('健康检查 nonce 不匹配');
        }
        submitted = true;
        return {content: [{type: 'text', text: '{"ok":true,"healthCheck":true}'}]};
      },
    };
    agent = new ClosedStationAgent(config,
      'This is an isolated Easy Workflow health check. Call the supplied submit tool once with the exact nonce. ' +
      'Do not perform any business task, read files, change settings, or invoke other tools.',
      [submit], reply => { actualModel = reply.model; });
    const pending = agent.prompt(`Call submit with {"nonce":"${nonce}"}, then finish.`);
    if (options.signal?.aborted) cancel();
    if (controller.signal.aborted) agent.abort();
    await pending;
    controller.signal.throwIfAborted();
    if (!submitted || !actualModel) {
      return {
        ok: false, detail: '客户端已结束，但没有完成本次 scoped submit 健康回执',
        fix: '确认所选客户端已认证、支持工位 MCP submit，并返回实际模型；版本信息不代表可以执行工位',
      };
    }
    return {ok: true, detail: `实际模型 ${actualModel} 已完成 scoped submit 健康回执`};
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', stop);
    // prompt settles only after its process and authenticated MCP scope close.
    removeHealthDirectory(scope);
  }
}

/** Probe the adapters that can actually run, without mutating global model settings. */
export async function checkAgentEndpoints(dir: string, agents: readonly StationAgentBinding[] = [{adapter: 'pi'}],
  options: AgentPreflightOptions = {}): Promise<AgentHealth> {
  const timeoutMs = options.timeoutMs ?? 20000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000) {
    return {ok: false, detail: '模型体检超时必须是 1–900000 毫秒的整数'};
  }
  const results: AgentHealth[] = [];
  const seen = new Set<string>();
  for (const candidate of agents) {
    let binding: StationAgentBinding;
    try {
      binding = parseAgentBinding(candidate);
    } catch (error) {
      results.push({ok: false, detail: `未执行不受支持的 Agent 配置：${error instanceof Error ? error.message : '无效配置'}`});
      continue;
    }
    const key = JSON.stringify(binding);
    if (seen.has(key)) continue;
    seen.add(key);
    const label = healthLabel(binding);
    if (options.signal?.aborted) {
      results.push({ok: false, detail: `${label}：体检已取消，未完成验证`});
      continue;
    }
    try {
      const result = binding.adapter === 'pi' ?
        await checkModelEndpoint(timeoutMs, binding, options.signal) :
        await checkClosedEndpoint(dir, binding, {...options, timeoutMs});
      results.push({...result, detail: `${label}：${result.detail}`});
    } catch (error) {
      results.push({
        ok: false,
        detail: `${label}：${options.signal?.aborted ? '体检已取消，未完成验证' :
          error instanceof Error ? error.message : '模型体检失败'}`,
        fix: '修复这个工位实际使用的客户端、认证或连接后重新体检',
      });
    }
  }
  if (!results.length) return {ok: false, detail: '没有选择需要验证的 Agent，未执行模型检查'};
  const secrets = factorySecrets();
  return {
    ok: results.every(result => result.ok),
    detail: redactText(results.map(result => result.detail).join('；'), secrets),
    fix: results.some(result => !result.ok) ?
      redactText([...new Set(results.filter(result => !result.ok).map(result => result.fix ?? '修复所选工位配置后重新体检'))].join('；'), secrets) : undefined,
  };
}

export function checkMemoryCapacity(broker: Broker) {
  const free=broker.freeMemMB(),ok=free>=broker.memoryFloorMB;
  return {ok,detail:`空闲 ${free}MB，浏览器有效上限 ${broker.effectiveBrowser()}/${broker.limits.browser}${ok?'':'（低于底线，暂停领取新页面）'}`,fix:ok?undefined:`可用内存低于 ${broker.memoryFloorMB}MB；释放不用的页面或应用后重新体检，等待期间保留工作检查点`};
}

export async function checkDnsProxy(url = 'https://github.com/', timeoutMs = 6000) {
  const route = networkRoute(url);
  await within(timeoutMs, dns.lookup(route.hostname));
  return { ok: true, detail: `${route.label}；${route.proxy ? '代理主机可解析，目标域名由代理解析' : '域名可解析'}` };
}

export async function checkBrowserCapture(broker: Broker, options: { open?: typeof openPage; timeoutMs?: number } = {}) {
  const resource = broker.tryAcquire('browser');
  if (!resource) return { ok: false, detail: `暂时不能验证后台截图：${broker.blocked('browser') ?? '没有浏览器名额'}`, fix: '等待页面释放或内存恢复后重新体检；没有做截图验证，不能报告截图正常' };
  const controller = new AbortController(), timeoutMs = options.timeoutMs ?? 40000;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    const error = new Error(`后台截图检查超过 ${timeoutMs / 1000}s`);
    controller.abort(error); reject(error);
  }, timeoutMs); });
  const capture = (async () => {
    try {
      const { page, close } = await (options.open ?? openPage)({ width: 640, height: 400 }, 'en-US', controller.signal);
      try {
        controller.signal.throwIfAborted();
        await page.goto("data:text/html,<body style='margin:0;background:%23fff'><div style='font:bold 64px sans-serif;padding:40px;color:%23123'>Easy Workflow preflight ■■■</div></body>", { timeout: timeoutMs });
        controller.signal.throwIfAborted();
        const { withBrowserFrames } = await import('./browser.ts');
        const png = await withBrowserFrames(page, () => page.screenshot({ timeout: timeoutMs }));
        controller.signal.throwIfAborted();
        const stats = await imageStatsAsync(png, {signal: controller.signal, timeoutMs});
        return { ok: stats.content > 0.01, detail: `内容占比 ${(stats.content * 100).toFixed(1)}%`, fix: stats.content > 0.01 ? undefined : '后台页没有画面帧：重启应用；仍不行请报告给系统' };
      } finally { await close(); }
    } finally { resource.release(); }
  })();
  try { return await Promise.race([capture, deadline]); }
  finally { clearTimeout(timer!); }
}

/** One unavailable third-party probe must not be mistaken for a total Internet outage. */
export async function checkExternalAccess(urls = ["https://api.github.com/zen", "https://example.com/"], timeoutMs = 10000): Promise<{ ok: boolean; detail: string; fix?: string }> {
  const tried: string[] = [];
  for (const url of urls) {
    const host = new URL(url).host;
    try {
      const response = await networkFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      await response.body?.cancel();
      tried.push(`${host} HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 407) return { ok: true, detail: tried.join("；") };
    } catch (error) {
      const cause = (error as { cause?: { code?: string } })?.cause?.code;
      tried.push(`${host} ${cause ?? String((error as Error)?.message ?? "连接失败").slice(0, 100)}`);
    }
  }
  return { ok: false, detail: tried.join("；") || "没有外网探测目标", fix: "外网探测均失败：检查系统代理和网络后重试" };
}

export interface PreflightRequirements {
  network?: boolean;
  model?: boolean;
  browser?: boolean;
  agents?: StationAgentBinding[];
  signal?: AbortSignal;
}
export async function preflight(dir: string, broker: Broker, requirements: PreflightRequirements = {}): Promise<{ ok: boolean; checks: PreflightCheck[] }> {
  const agents = requirements.agents ?? (requirements.model === false ? [] : [{adapter: 'pi'} as const]);
  const checks = await Promise.all([
    ...(requirements.network === false ? [] : [check("dns", "DNS 与代理", () => checkDnsProxy()), check("web", "外网可达", () => checkExternalAccess())]),
    ...(agents.length ? [check('model', '模型凭据与接口', () => checkAgentEndpoints(dir, agents, {signal: requirements.signal}))] : []),
    ...(requirements.browser === false ? [] : [check("browser", "后台页能截出画面", () => checkBrowserCapture(broker))]),
    check("disk", "项目文件夹可写", async () => {
      const probe = path.join(dir, `.preflight-${process.pid}`);
      fs.writeFileSync(probe, "ok"); fs.rmSync(probe);
      const st = await fs.promises.statfs(dir);
      const freeGB = (st.bavail * st.bsize) / 1073741824;
      return { ok: freeGB > 1, detail: `可写，剩余 ${freeGB.toFixed(1)}GB`, fix: freeGB > 1 ? undefined : "磁盘剩余不足 1GB，清理后再开跑" };
    }),
    check("memory", "内存", async () => requirements.browser === false ? { ok: true, detail: `空闲 ${broker.freeMemMB()}MB；当前工作流不申请浏览器，浏览器内存底线不适用` } : checkMemoryCapacity(broker)),
    ...(requirements.browser === false ? [] : [check("auth", "共享浏览器登录状态", async () => {
      const st = await within(8000, browserCommand({ action: "state" })) as { tabs?: { attention?: string; title?: string }[] };
      const need = (st.tabs ?? []).filter((t) => t.attention);
      return { ok: true, detail: need.length ? `${need.length} 个页面需要处理：${need.map((t) => t.title).join("、").slice(0, 120)}` : "没有需要处理的页面" };
    })]),
  ]);
  const ok = checks.every((c) => c.ok);
  writeEnv(dir, checks, broker);
  return { ok, checks };
}

export function writeEnv(dir: string, checks: PreflightCheck[], broker: Broker) {
  const file = projectPaths(dir).env;
  let manual = "";
  try { manual = fs.readFileSync(file, "utf8").split("<!-- manual -->")[1] ?? ""; } catch { /* first write */ }
  const rows = checks.map((c) => `| ${c.ok ? "✓" : "✗"} ${c.label} | ${c.detail.replace(/\|/g, "/")} | ${c.fix ?? ""} | ${c.ms}ms |`).join("\n");
  fs.writeFileSync(file, `# 环境（ENV）

> 上半部分由 Easy Workflow 在每次开跑前自动重写；分隔线以下是人工补充，程序不会改动。Agent 遇到环境问题先看这里。

## 最近一次体检 · ${new Date().toLocaleString("zh-CN", { hour12: false })}

| 项目 | 结果 | 怎么修 | 用时 |
|---|---|---|---|
${rows}

## 环境约定

- 网络：所有请求走统一出口，自动使用系统代理，按主机限速，短暂错误自动重试一次，成功的 GET 缓存 6 小时（项目文件夹 cache/http）。
- 浏览器：自动采集默认最多 ${broker.limits.browser} 页，按空闲内存自动收缩（每页约 250MB，底线 ${broker.memoryFloorMB}MB）。
- 证书错误、需要登录、模型额度问题会亮红灯通知站长；Agent 不绕过证书、不自动登录、不填凭据。
- 每次工位处理最多调用 10 次工具。

<!-- manual -->${manual || "\n\n## 人工补充\n\n（在这里写环境注意事项，比如哪些站需要代理、哪些站必须登录。）\n"}`);
}
