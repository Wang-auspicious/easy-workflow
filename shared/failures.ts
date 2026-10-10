export type FailureTag = "invalid_url" | "http_not_found" | "network_timeout" | "network_dns" | "network_connection" | "network_tls" | "http_rate_limit" | "http_server" | "auth_required" | "browser_capture" | "tool_error" | "run_ended";
export interface Failure { tag:FailureTag; category:"invalid"|"network"|"auth"|"system"; message:string; url?:string; code?:string; status?:number; retryable:boolean }
export interface CandidateRecovery { item:string; token:string; url:string; title:string; source:string; category?:string; disposition:"retry"|"removed"|"claimed"|"resolved"; failure?:Failure; at:number; attempts:number }
export const failureLabels:Record<FailureTag,string>={invalid_url:"网址格式错误",http_not_found:"页面不存在",network_timeout:"网络超时",network_dns:"DNS 解析失败",network_connection:"连接中断",network_tls:"TLS / 证书问题",http_rate_limit:"访问限流",http_server:"站点暂时异常",auth_required:"登录或验证",browser_capture:"浏览器截图异常",tool_error:"工具执行异常",run_ended:"本轮中止，尚未完成"};

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
