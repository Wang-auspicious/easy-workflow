// H2 tool renderer for Pi Web UI. Tool results stay beside their original call.
import { html } from "lit";
const names = { status: "查看运行状态", inspect: "查看详情", run_control: "控制运行", feed_urls: "投料", pull_candidates: "取候选", workers: "调整工位", correct: "纠错", propose_patch: "起草规格补丁", settings: "工作设置", journal: "读取过程", report: "读取报告", candidates: "查询候选" };
export function renderTool(name, args, result, pending) {
  const target = args?.name ?? args?.tool;
  const label = name === "h2_help" ? `了解能力${target ? ` · ${names[target] ?? target}` : ""}` : name === "h2_call" ? names[target] ?? target ?? "调用 H2" : name;
  let output = result?.content?.filter(c => c.type === "text").map(c => c.text).join("\n") ?? "";
  try { output = JSON.stringify(JSON.parse(output), null, 2); } catch { /* Plain text results remain plain text. */ }
  const error = result?.isError;
  return { isCustom: true, content: html`<details class="pi-tool ${error ? "has-error" : ""}" ?open=${error}>
    <summary><span class="tool-status ${pending && !result ? "is-pending" : ""}">${error ? "!" : result ? "✓" : "·"}</span><span>${label}</span><span class="tool-state">${error ? "失败" : result ? "完成" : pending ? "执行中" : "等待"}</span></summary>
    <div class="tool-detail"><span class="detail-label">调用参数</span><code-block .code=${JSON.stringify(args ?? {}, null, 2)}></code-block>
    ${result ? html`<span class="detail-label">返回结果</span><code-block .code=${output || "已停止，未返回结果"}></code-block>` : ""}</div>
  </details>` };
}
