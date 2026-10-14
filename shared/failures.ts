export type FailureTag = "invalid_url" | "http_not_found" | "page_unavailable" | "network_timeout" | "network_dns" | "network_connection" | "network_tls" | "http_rate_limit" | "http_server" | "http_forbidden" | "auth_required" | "browser_capture" | "tool_error" | "run_ended" | "needs_selection" | "missing_artifact" | "quality_rejected" | "model_unavailable" | "model_transport";
export interface Failure { tag:FailureTag; category:"invalid"|"network"|"auth"|"system"; message:string; url?:string; requestedUrl?:string; code?:string; status?:number; retryable:boolean;
  /** What to do next, written for the agent or person who owns the fix (Spec §30.4). */
  nextAction?:string;
  dependency?: import('./types.ts').ModelDependency;
  /** Who can fix it: the agent itself, the owner (login, certificate, credentials) or the system (bug / environment). */
  owner?:"agent"|"user"|"system";
  /** Methods already tried, so nobody repeats them. */
  tried?:string[] }
export interface CandidateRecovery {
  /** Stable work identity; absent only in journals written before identity scoping. */
  key?: string;
  line?: string;
  workflowPack?: string;
  item: string;
  token: string;
  url: string;
  title: string;
  source: string;
  category?: string;
  disposition: 'retry' | 'manual' | 'removed' | 'claimed' | 'resolved';
  /** Original executable frontier when a retry policy escalates to review. */
  recoveryStation?: string;
  failure?: Failure;
  at: number;
  attempts: number;
}
export const failureLabels:Record<FailureTag,string>={invalid_url:"网址格式错误",http_not_found:"页面不存在",page_unavailable:"采集子页面失效",network_timeout:"网络超时",network_dns:"DNS 解析失败",network_connection:"连接中断",network_tls:"TLS / 证书问题",http_rate_limit:"访问限流",http_server:"站点暂时异常",http_forbidden:"服务器拒绝请求",auth_required:"登录 / 人机验证",browser_capture:"浏览器截图异常",tool_error:"工具执行异常",run_ended:"本轮中止，尚未完成",needs_selection:"需要重新选页",missing_artifact:"产物引用失效",quality_rejected:"图像质量不合格",model_unavailable:"模型凭据 / 额度不可用",model_transport:"模型服务连接 / 超时"};

export function recoveryAdvice(f:Failure|undefined) {
  const tag=f?.tag;
  if(tag==="model_transport"||tag==="model_unavailable")return f?.nextAction ?? NEXT[tag];
  if(tag==="auth_required")return "到内置浏览器完成登录或验证，再从失败工位继续。";
  if(tag==="http_forbidden")return "系统检查公开入口与共享浏览器的实际响应；403 本身不能证明需要登录。";
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
  const navigationKey=(url:string)=>{
    try {
      const u=new URL(url);
      for(const name of [...u.searchParams.keys()])if(/^(utm_|ref$|ref_|source$|fbclid$|gclid$|mc_|_ga$|_gl$)/i.test(name))u.searchParams.delete(name);
      u.searchParams.sort();
      return `${u.host.replace(/^www\./,"")}${u.pathname.replace(/\/+$/,"")}${u.search}`;
    } catch { return key(url); }
  };
  // Only the original navigation proves that a restricted page was optional. A
  // public-looking homepage may itself redirect to /login, which still needs a user.
  if(failure.tag==="auth_required" && failure.requestedUrl && navigationKey(failure.requestedUrl)!==navigationKey(entryURL))
    return withAdvice({...failure,tag:"needs_selection",category:"system",retryable:true,nextAction:"采集子页面需要登录或验证：先从公开目录和备选链接重新选页，保留现有成果与访问现场；不要求用户为可选素材登录。",owner:"agent",message:`采集子页面访问受限，先寻找公开替代页：${failure.requestedUrl}（${failure.message}）`});
  if(failure.tag==="http_not_found" && failure.url && key(failure.url)!==key(entryURL))
    return withAdvice({...failure,tag:"page_unavailable",category:"system",retryable:true,nextAction:undefined,owner:undefined,message:`采集子页面失效，需要重新选择页面：${failure.url}（${failure.message}）`});
  return failure;
}

export function classifyFailure(error:unknown, context:{url?:string;requestedUrl?:string;status?:number;stage?:string}={}):Failure {
  const e=error as {message?:string;code?:string;cause?:{code?:string;message?:string}};
  const code=e?.cause?.code??e?.code;
  const detail=[e?.cause?.code,e?.cause?.message].filter(Boolean).join(": ");
  const message=(String(e?.message??error??"未知错误")+(detail?` (${detail})`:"")).replace(/\u001b\[[0-9;]*m/g,"").slice(0,1200);
  const text=`${code??""} ${message} ${e?.cause?.message??""}`;
  const status=context.status??(Number(text.match(/(?:HTTP|httpError:)[ :]*(\d{3})/i)?.[1]??0)||undefined);
  // Provider error codes need no HTTP status in streamed SDK failures. Match
  // explicit codes/prefixes, not a validation message merely naming a field.
  const providerServiceFailure = ['server_error', 'internal_server_error', 'service_unavailable', 'overloaded_error']
    .includes(typeof code === 'string' ? code.toLowerCase() : '') ||
    /^(?:server_error|internal_server_error|service_unavailable|overloaded_error)\s*:/i.test(message.trim()) ||
    (status !== undefined && status >= 500 && status <= 599);
  let tag:FailureTag="tool_error",category:Failure["category"]="system";
  if (/MODEL_CAPACITY_REENTRANT/.test(text)) return {
    tag: 'tool_error', category: 'system', code: 'MODEL_CAPACITY_REENTRANT', message,
    retryable: false, owner: 'agent', nextAction: '该客户端等待的工具又申请同一模型名额；请把嵌套模型步骤拆成独立工位，或显式配置足够容量。不会自动付费重试。',
  };
  if (/MODEL_CIRCUIT_OPEN|MODEL_CAPACITY_TIMEOUT/.test(text)) return {
    tag: 'tool_error', category: 'system', code: text.includes('MODEL_CIRCUIT_OPEN') ? 'MODEL_CIRCUIT_OPEN' : 'MODEL_CAPACITY_TIMEOUT',
    message, retryable: true, owner: 'system', nextAction: '共享模型尚未放行；保留原工位与会话等待，不记为新的供应商故障。',
  };
  if (context.stage === 'model' && isTlsFailure(error)) return withAdvice({ tag: 'model_unavailable', category: 'auth', message, url: context.url, requestedUrl: context.requestedUrl, code, status, retryable: true, owner: 'user', nextAction: '模型连接的 TLS / 证书校验失败：已暂停模型任务；先修复证书或代理配置，再确认恢复。不会忽略证书校验或自动重复请求。' });
  if(context.stage==="model"&&([401,402,403].includes(status??0)||/401|403|quota|insufficient|credit|balance|unauthori[sz]ed|api key|余额|额度/i.test(text))){tag="model_unavailable";category="auth";}
  else if(context.stage==="model"&&(providerServiceFailure||/MODEL_CIRCUIT_OPEN|timeout|timed?[ _]?out|超时|ECONN|ENOTFOUND|EAI_AGAIN|CERT_|ERR_(?:SSL|TLS)_|fetch failed|connection error|socket|terminated|overloaded|temporarily|rate.?limit|\b429\b|\b50[0-9]\b/i.test(text))){tag="model_transport";category="system";}
  else if(context.stage==="url"||/invalid url|无法解析.*网址/i.test(text)){tag="invalid_url";category="invalid";}
  else if(status===404||status===410){tag="http_not_found";category="invalid";}
  // Error codes identify the failed operation before words in its URL or context.
  // A navigation to /login can fail on the network; “验证” also occurs in evidence
  // and certificate validation and is not proof of an authentication wall.
  else if(/ENOTFOUND|EAI_AGAIN|ERR_NAME|DNS/i.test(text)){tag="network_dns";category="network";}
  else if(isTlsFailure(error)){tag="network_tls";category="network";}
  else if(/ECONN|ERR_CONNECTION|socket|fetch failed|connection error/i.test(text)){tag="network_connection";category="network";}
  else if(status===401||/loginWall|(?:需要|要求|完成|必须|请先).{0,8}登录|登录(?:墙|状态需要检查)|(?:sign|log)[ -]?in (?:to (?:continue|view|access)|required)|captcha|human verification|verify you are human|checking your browser|人机验证|页面需要完成验证/i.test(text)){tag="auth_required";category="auth";}
  else if(status===403){tag="http_forbidden";category="network";}
  else if(/原图丢失|[.](png|webp).*missing/i.test(text)){tag="missing_artifact";}
  else if(/需要重新选页|没找到.*(舞台|目录|特写)|没有合格|所有候选|试了 \d+ 页|needsPick/i.test(text)){tag="needs_selection";}
  else if(/duplicate images|图片重复|blank\(|stage-nearly-empty|iframe-empty/i.test(text)){tag="quality_rejected";}
  else if(/screenshot|captureScreenshot|screencast|截图|出帧/i.test(text)||context.stage==="capture"){tag="browser_capture";}
  else if(status===429){tag="http_rate_limit";category="network";}
  else if((status??0)>=500){tag="http_server";category="network";}
  else if(/timeout|timed?[ _]?out|ETIMEDOUT|超时/i.test(text)){tag="network_timeout";category="network";}
  else if(/fetch failed|connection error|ECONN|ERR_CONNECTION|socket|network|导航|navigation/i.test(text)){tag="network_connection";category="network";}
  return withAdvice({tag,category,message,url:context.url,requestedUrl:context.requestedUrl,code,status,retryable:category!=="invalid"});
}

/** A reset before a TLS connection exists is a connection error, not a bad certificate. */
export function isTlsFailure(error: unknown): boolean {
  const e = error as { message?: string; code?: string; cause?: { code?: string; message?: string } };
  const text = `${e?.code ?? ""} ${e?.cause?.code ?? ""} ${e?.message ?? error ?? ""} ${e?.cause?.message ?? ""}`;
  if (/certificate|CERT_|ERR_(?:SSL|TLS)_|SSL_ERROR|证书/i.test(text)) return true;
  if (/ECONN|ERR_CONNECTION|socket disconnected|timeout|timed? ?out|ETIMEDOUT/i.test(text)) return false;
  return /\b(?:TLS|SSL)\b/i.test(text);
}

const OWNER:Record<FailureTag,"agent"|"user"|"system">={invalid_url:"agent",http_not_found:"agent",page_unavailable:"agent",network_timeout:"system",network_dns:"system",network_connection:"system",network_tls:"user",http_rate_limit:"system",http_server:"system",http_forbidden:"system",auth_required:"user",browser_capture:"system",tool_error:"system",run_ended:"system",needs_selection:"agent",missing_artifact:"system",quality_rejected:"agent",model_unavailable:"user",model_transport:"system"};
const NEXT:Record<FailureTag,string>={
  model_transport:"模型服务连接中断、超时或限流：停止补新料并冷却，只允许一个真实工位试恢复；成功后继续已有检查点。不是网站打不开，不删除站点、不消耗选页重试额度。",
  invalid_url:"网址无法使用：检查是否为仓库写法或拼写错误；确实无效就排除并保留出处。",
  http_not_found:"入口 404/410：换一个同站入口（首页、文档首页），确实不存在才排除。",
  page_unavailable:"子页面失效：从拍摄单的备选页或站点目录里换一页，不要删除整站。",
  network_timeout:"网络超时：环境已自动重试一次；稍后按原因批量重试，不在原地连续重试。",
  network_dns:"DNS 解析失败：检查代理或域名；不能据此判定网址永久无效。",
  network_connection:"连接中断：环境会尝试用共享浏览器补取；仍失败就按原因稍后重试。",
  network_tls:"证书错误：已亮红灯通知站长；不要跳过校验，等站长处理或给出正确入口。",
  http_rate_limit:"被限流：降低该主机的请求频率，稍后重试。",
  http_server:"站点暂时异常（5xx）：稍后重试，不改动已完成的成果。",
  http_forbidden:"服务器拒绝请求（403）：系统先用共享浏览器核对公开入口；只有实际登录墙或人机验证才交用户处理，不能据此要求登录。",
  auth_required:"需要登录或验证：已亮红灯并保留页面；等站长在内置浏览器完成登录后按原因重试。",
  browser_capture:"截图异常：环境问题，页面池会自动重建；本次作废重排，不计站点失败。",
  tool_error:"工具异常：记录完整错误交给系统修复，不要反复尝试同一方法。",
  run_ended:"本轮已结束：下轮从失败工位继续，复用已有成果。",
  needs_selection:"需要重新选页：列出试过的页和拒收原因，交阅读员重新查找公开页面。",
  missing_artifact:"产物引用失效：先从持久证据恢复，只补做确实丢失的部分。",
  quality_rejected:"图像不合格：按拒收原因在原页重新取景或换备选页。",
  model_unavailable:"模型不可用：已暂停领取模型任务并亮红灯；站长检查额度、凭据或代理后按原因重试。",
};
export function withAdvice(f:Failure):Failure { return {...f,owner:f.owner??OWNER[f.tag],nextAction:f.nextAction??NEXT[f.tag]}; }

export class ClassifiedFailure extends Error {
  failure:Failure;
  constructor(failure:Failure){super(failure.message);this.failure=failure;}
}
