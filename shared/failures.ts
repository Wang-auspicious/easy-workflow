export type FailureTag = "invalid_url" | "http_not_found" | "page_unavailable" | "network_timeout" | "network_dns" | "network_connection" | "network_tls" | "http_rate_limit" | "http_server" | "auth_required" | "browser_capture" | "tool_error" | "run_ended" | "needs_selection" | "missing_artifact" | "quality_rejected" | "model_unavailable";
export interface Failure { tag:FailureTag; category:"invalid"|"network"|"auth"|"system"; message:string; url?:string; code?:string; status?:number; retryable:boolean;
  /** What to do next, written for the agent or person who owns the fix (Spec §30.4). */
  nextAction?:string;
  /** Who can fix it: the agent itself, the owner (login, certificate, credentials) or the system (bug / environment). */
  owner?:"agent"|"user"|"system";
  /** Methods already tried, so nobody repeats them. */
  tried?:string[] }
export interface CandidateRecovery { item:string; token:string; url:string; title:string; source:string; category?:string; disposition:"retry"|"removed"|"claimed"|"resolved"; failure?:Failure; at:number; attempts:number }
export const failureLabels:Record<FailureTag,string>={invalid_url:"网址格式错误",http_not_found:"页面不存在",page_unavailable:"采集子页面失效",network_timeout:"网络超时",network_dns:"DNS 解析失败",network_connection:"连接中断",network_tls:"TLS / 证书问题",http_rate_limit:"访问限流",http_server:"站点暂时异常",auth_required:"访问受限 / 登录验证",browser_capture:"浏览器截图异常",tool_error:"工具执行异常",run_ended:"本轮中止，尚未完成",needs_selection:"需要重新选页",missing_artifact:"产物引用失效",quality_rejected:"图像质量不合格",model_unavailable:"模型不可用（额度 / 凭据 / 限流）"};

export function recoveryAdvice(f:Failure|undefined) {
  const tag=f?.tag;
  if(tag==="auth_required")return "到内置浏览器完成登录或验证，再从失败工位继续。";
  if(tag==="network_tls")return "等待站点证书修复，或提供正确入口；不能忽略 TLS 校验。";
  if(tag==="needs_selection"||tag==="page_unavailable")return "检查已试候选，补充合适的目录 / 演示页；继续时保留分类和已拍图片。";
  if(tag==="missing_artifact")return "先从持久证据恢复已有图片；只补拍确实丢失的角色。";
  if(tag==="quality_rejected")return "针对空白、重复或裁剪错误重拍对应角色，不重做整站。";
  if(tag==="invalid_url"||tag==="http_not_found")return "入口已排除，保留出处与处置记录。";
  return "排除故障后从失败工位继续，复用已经完成的成果。";
}

/** A dead detail/demo link is not evidence that the candidate's homepage is dead. */
export function candidateFailure(failure:Failure, entryURL:string):Failure {
  const key=(url:string)=>url.split("#")[0].replace(/\/$/,"");
  if(failure.tag==="http_not_found" && failure.url && key(failure.url)!==key(entryURL))
    return withAdvice({...failure,tag:"page_unavailable",category:"system",retryable:true,nextAction:undefined,owner:undefined,message:`采集子页面失效，需要重新选择页面：${failure.url}（${failure.message}）`});
  return failure;
}

export function classifyFailure(error:unknown, context:{url?:string;status?:number;stage?:string}={}):Failure {
  const e=error as {message?:string;code?:string;cause?:{code?:string;message?:string}};
  const code=e?.cause?.code??e?.code;
  const detail=[e?.cause?.code,e?.cause?.message].filter(Boolean).join(": ");
  const message=(String(e?.message??error??"未知错误")+(detail?` (${detail})`:"")).replace(/\u001b\[[0-9;]*m/g,"").slice(0,1200);
  const text=`${code??""} ${message} ${e?.cause?.message??""}`;
  const status=context.status??(Number(text.match(/(?:HTTP|httpError:)[ :]*(\d{3})/i)?.[1]??0)||undefined);
  let tag:FailureTag="tool_error",category:Failure["category"]="system";
  if(context.stage==="model"&&/401|403|429|quota|insufficient|credit|balance|rate.?limit|unauthori[sz]ed|api key|余额|额度/i.test(text)){tag="model_unavailable";category="auth";}
  else if(context.stage==="url"||/invalid url|无法解析.*网址/i.test(text)){tag="invalid_url";category="invalid";}
  else if(status===404||status===410){tag="http_not_found";category="invalid";}
  else if([401,403].includes(status??0)||/登录|验证|captcha|loginWall|challenge/i.test(text)){tag="auth_required";category="auth";}
  else if(/原图丢失|[.](png|webp).*missing/i.test(text)){tag="missing_artifact";}
  else if(/没找到.*(舞台|目录|特写)|没有合格|所有候选|试了 \d+ 页|needsPick/i.test(text)){tag="needs_selection";}
  else if(/duplicate images|图片重复|blank\(|stage-nearly-empty|iframe-empty/i.test(text)){tag="quality_rejected";}
  else if(/screenshot|captureScreenshot|screencast|截图|出帧/i.test(text)||context.stage==="capture"){tag="browser_capture";}
  else if(status===429){tag="http_rate_limit";category="network";}
  else if((status??0)>=500){tag="http_server";category="network";}
  else if(/ENOTFOUND|EAI_AGAIN|ERR_NAME|DNS/i.test(text)){tag="network_dns";category="network";}
  else if(isTlsFailure(error)){tag="network_tls";category="network";}
  else if(/timeout|timed? ?out|ETIMEDOUT|超时/i.test(text)){tag="network_timeout";category="network";}
  else if(/fetch failed|ECONN|ERR_CONNECTION|socket|network|导航|navigation/i.test(text)){tag="network_connection";category="network";}
  return withAdvice({tag,category,message,url:context.url,code,status,retryable:category!=="invalid"});
}

/** A reset before a TLS connection exists is a connection error, not a bad certificate. */
export function isTlsFailure(error: unknown): boolean {
  const e = error as { message?: string; code?: string; cause?: { code?: string; message?: string } };
  const text = `${e?.code ?? ""} ${e?.cause?.code ?? ""} ${e?.message ?? error ?? ""} ${e?.cause?.message ?? ""}`;
  if (/certificate|CERT_|ERR_(?:SSL|TLS)_|SSL_ERROR|证书/i.test(text)) return true;
  if (/ECONN|ERR_CONNECTION|socket disconnected|timeout|timed? ?out|ETIMEDOUT/i.test(text)) return false;
  return /\b(?:TLS|SSL)\b/i.test(text);
}

const OWNER:Record<FailureTag,"agent"|"user"|"system">={invalid_url:"agent",http_not_found:"agent",page_unavailable:"agent",network_timeout:"system",network_dns:"system",network_connection:"system",network_tls:"user",http_rate_limit:"system",http_server:"system",auth_required:"user",browser_capture:"system",tool_error:"system",run_ended:"system",needs_selection:"agent",missing_artifact:"system",quality_rejected:"agent",model_unavailable:"user"};
const NEXT:Record<FailureTag,string>={
  invalid_url:"网址无法使用：检查是否为仓库写法或拼写错误；确实无效就排除并保留出处。",
  http_not_found:"入口 404/410：换一个同站入口（首页、文档首页），确实不存在才排除。",
  page_unavailable:"子页面失效：从拍摄单的备选页或站点目录里换一页，不要删除整站。",
  network_timeout:"网络超时：环境已自动重试一次；稍后按原因批量重试，不在原地连续重试。",
  network_dns:"DNS 解析失败：检查代理或域名；不能据此判定网址永久无效。",
  network_connection:"连接中断：环境会尝试用共享浏览器补取；仍失败就按原因稍后重试。",
  network_tls:"证书错误：已亮红灯通知站长；不要跳过校验，等站长处理或给出正确入口。",
  http_rate_limit:"被限流：降低该主机的请求频率，稍后重试。",
  http_server:"站点暂时异常（5xx）：稍后重试，不改动已完成的成果。",
  auth_required:"需要登录或验证：已亮红灯并保留页面；等站长在内置浏览器完成登录后按原因重试。",
  browser_capture:"截图异常：环境问题，页面池会自动重建；本次作废重排，不计站点失败。",
  tool_error:"工具异常：记录完整错误交给系统修复，不要反复尝试同一方法。",
  run_ended:"本轮已结束：下轮从失败工位继续，复用已有成果。",
  needs_selection:"没有合格页面：列出试过的页和拒收原因，交阅读员或站长指定页面。",
  missing_artifact:"产物引用失效：先从持久证据恢复，只补做确实丢失的部分。",
  quality_rejected:"图像不合格：按拒收原因在原页重新取景或换备选页。",
  model_unavailable:"模型不可用：已暂停领取模型任务并亮红灯；站长检查额度、凭据或代理后按原因重试。",
};
export function withAdvice(f:Failure):Failure { return {...f,owner:f.owner??OWNER[f.tag],nextAction:f.nextAction??NEXT[f.tag]}; }

export class ClassifiedFailure extends Error {
  failure:Failure;
  constructor(failure:Failure){super(failure.message);this.failure=failure;}
}
