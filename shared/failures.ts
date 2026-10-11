export type FailureTag = "invalid_url" | "http_not_found" | "page_unavailable" | "network_timeout" | "network_dns" | "network_connection" | "network_tls" | "http_rate_limit" | "http_server" | "auth_required" | "browser_capture" | "tool_error" | "run_ended" | "needs_selection" | "missing_artifact" | "quality_rejected";
export interface Failure { tag:FailureTag; category:"invalid"|"network"|"auth"|"system"; message:string; url?:string; code?:string; status?:number; retryable:boolean }
export interface CandidateRecovery { item:string; token:string; url:string; title:string; source:string; category?:string; disposition:"retry"|"removed"|"claimed"|"resolved"; failure?:Failure; at:number; attempts:number }
export const failureLabels:Record<FailureTag,string>={invalid_url:"网址格式错误",http_not_found:"页面不存在",page_unavailable:"采集子页面失效",network_timeout:"网络超时",network_dns:"DNS 解析失败",network_connection:"连接中断",network_tls:"TLS / 证书问题",http_rate_limit:"访问限流",http_server:"站点暂时异常",auth_required:"访问受限 / 登录验证",browser_capture:"浏览器截图异常",tool_error:"工具执行异常",run_ended:"本轮中止，尚未完成",needs_selection:"需要重新选页",missing_artifact:"产物引用失效",quality_rejected:"图像质量不合格"};

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
    return {...failure,tag:"page_unavailable",category:"system",retryable:true,message:`采集子页面失效，需要重新选择页面：${failure.url}（${failure.message}）`};
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
  if(context.stage==="url"||/invalid url|无法解析.*网址/i.test(text)){tag="invalid_url";category="invalid";}
  else if(status===404||status===410){tag="http_not_found";category="invalid";}
  else if([401,403].includes(status??0)||/登录|验证|captcha|loginWall|challenge/i.test(text)){tag="auth_required";category="auth";}
  else if(/原图丢失|[.](png|webp).*missing/i.test(text)){tag="missing_artifact";}
  else if(/没找到.*(舞台|目录|特写)|没有合格|所有候选|试了 \d+ 页|needsPick/i.test(text)){tag="needs_selection";}
  else if(/duplicate images|图片重复|blank\(|stage-nearly-empty|iframe-empty/i.test(text)){tag="quality_rejected";}
  else if(/screenshot|captureScreenshot|screencast|截图|出帧/i.test(text)||context.stage==="capture"){tag="browser_capture";}
  else if(status===429){tag="http_rate_limit";category="network";}
  else if((status??0)>=500){tag="http_server";category="network";}
  else if(/ENOTFOUND|EAI_AGAIN|ERR_NAME|DNS/i.test(text)){tag="network_dns";category="network";}
  else if(/certificate|CERT_|TLS|SSL/i.test(text)){tag="network_tls";category="network";}
  else if(/timeout|timed? ?out|ETIMEDOUT|超时/i.test(text)){tag="network_timeout";category="network";}
  else if(/fetch failed|ECONN|ERR_CONNECTION|socket|network|导航|navigation/i.test(text)){tag="network_connection";category="network";}
  return {tag,category,message,url:context.url,code,status,retryable:category!=="invalid"};
}

export class ClassifiedFailure extends Error {
  failure:Failure;
  constructor(failure:Failure){super(failure.message);this.failure=failure;}
}
