// Pre-run health check (Spec §30.5): before a run starts or resumes, prove the network,
// the model endpoint, a real background screenshot, disk and the project folder work.
// A failed check blocks the run and says what to fix; the result is written to ENV.md.
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import type { PreflightCheck } from "../shared/types.ts";
import { networkFetch } from "./network.ts";
import { openPage, browserCommand } from "./browser.ts";
import { probeModelConnection } from "./pi.ts";
import { imageStats } from "./evidence.ts";
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

export async function checkModelEndpoint(timeoutMs = 20000): Promise<{ ok: boolean; detail: string; fix?: string }> {
  return probeModelConnection(timeoutMs);
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
      if (response.status < 500) return { ok: true, detail: tried.join("；") };
    } catch (error) {
      const cause = (error as { cause?: { code?: string } })?.cause?.code;
      tried.push(`${host} ${cause ?? String((error as Error)?.message ?? "连接失败").slice(0, 100)}`);
    }
  }
  return { ok: false, detail: tried.join("；") || "没有外网探测目标", fix: "外网探测均失败：检查系统代理和网络后重试" };
}

export async function preflight(dir: string, broker: Broker): Promise<{ ok: boolean; checks: PreflightCheck[] }> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? "";
  const checks = await Promise.all([
    check("dns", "DNS 与代理", async () => {
      await within(6000, dns.lookup("github.com"));
      return { ok: true, detail: proxy ? `走代理 ${proxy.replace(/\/\/[^@]*@/, "//")}` : "直连（未设置代理环境变量）" };
    }),
    check("web", "外网可达", () => checkExternalAccess()),
    check("model", "模型凭据与接口", () => checkModelEndpoint()),
    check("browser", "后台页能截出画面", async () => {
      const lease = broker.tryAcquire("browser");
      if (!lease) return { ok: true, detail: "浏览器名额都在使用中（已在工作，跳过）" };
      try {
        const { page, close } = await within(25000, openPage({ width: 640, height: 400 }, "en-US"));
        try {
          await page.goto("data:text/html,<body style='margin:0;background:%23fff'><div style='font:bold 64px sans-serif;padding:40px;color:%23123'>Easy Workflow preflight ■■■</div></body>");
          const { withBrowserFrames } = await import("./browser.ts");
          const png = await within(15000, withBrowserFrames(page, () => page.screenshot()));
          const stats = imageStats(png);
          return { ok: stats.content > 0.01, detail: `内容占比 ${(stats.content * 100).toFixed(1)}%`, fix: stats.content > 0.01 ? undefined : "后台页没有画面帧：重启应用；仍不行请报告给系统" };
        } finally { await close(); }
      } finally { lease.release(); }
    }),
    check("disk", "项目文件夹可写", async () => {
      const probe = path.join(dir, `.preflight-${process.pid}`);
      fs.writeFileSync(probe, "ok"); fs.rmSync(probe);
      const st = await fs.promises.statfs(dir);
      const freeGB = (st.bavail * st.bsize) / 1073741824;
      return { ok: freeGB > 1, detail: `可写，剩余 ${freeGB.toFixed(1)}GB`, fix: freeGB > 1 ? undefined : "磁盘剩余不足 1GB，清理后再开跑" };
    }),
    check("memory", "内存", async () => {
      const free = broker.freeMemMB();
      return { ok: true, detail: `空闲 ${free}MB，浏览器有效上限 ${broker.effectiveBrowser()}/${broker.limits.browser}${free < broker.memoryFloorMB ? "（低于底线，暂停领取新页面）" : ""}` };
    }),
    check("auth", "共享浏览器登录状态", async () => {
      const st = await within(8000, browserCommand({ action: "state" })) as { tabs?: { attention?: string; title?: string }[] };
      const need = (st.tabs ?? []).filter((t) => t.attention);
      return { ok: true, detail: need.length ? `${need.length} 个页面需要处理：${need.map((t) => t.title).join("、").slice(0, 120)}` : "没有需要处理的页面" };
    }),
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
