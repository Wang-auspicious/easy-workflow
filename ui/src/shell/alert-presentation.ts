import type { Alert } from "../../../shared/types.ts";
import type { BrowserState } from "../../../shared/browser.ts";
import type { CandidateRecovery } from "../../../shared/failures.ts";
import { failureLabels } from "../../../shared/failures.ts";

/** Legacy alerts may say “auth” for connection errors; a label is not login evidence. */
export function alertPresentation(alert: Alert, recoveries: Record<string, CandidateRecovery>, browser: BrowserState) {
  const recovery = Object.values(recoveries).find(r => r.item === alert.item || Boolean(alert.token && r.token === alert.token));
  const tab = browser.tabs.find(t => t.id === alert.tab);
  const failure = recovery?.failure;
  const confirmedLogin = tab?.attentionKind === "auth" || tab?.attentionKind === "challenge";
  const systemFailure = failure && ["network_timeout", "network_dns", "network_connection", "http_rate_limit", "http_server", "http_forbidden", "browser_capture", "tool_error"].includes(failure.tag);
  const requiresUser = confirmedLogin || !systemFailure && ["tls", "model", "preflight"].includes(alert.kind);
  const label = confirmedLogin ? tab.attentionKind === "challenge" ? "人机验证" : "登录"
    : systemFailure ? failureLabels[failure.tag]
    : ({ tls: "站点证书", model: "模型配置 / 额度", preflight: "运行环境", browser: "浏览器恢复", auth: "访问状态待复核" }[alert.kind] ?? "访问检查");
  const url = alert.url || recovery?.url || tab?.url;
  let host = "";
  try { if (url) host = new URL(url).hostname; } catch { /* malformed URLs remain in diagnostics */ }
  return {
    requiresUser,
    label,
    title: recovery?.title || tab?.title || host || alert.item || "",
    message: (systemFailure ? failure.message : alert.message).split("\n")[0].slice(0, 200),
    details: alert.message,
    nextAction: confirmedLogin ? "打开保留的页面完成登录或验证，再检查访问状态。"
      : systemFailure ? "系统检查网络、可用入口和页面响应，保留已完成的成果。"
      : alert.kind === "auth" ? "尚未确认是登录问题。先重新检查当前页面的实际访问状态。"
      : alert.nextAction,
    url,
    tab: tab?.id,
  };
}
