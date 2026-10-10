import { EnvHttpProxyAgent, fetch as proxyFetch } from "undici";
let transport:EnvHttpProxyAgent|undefined;
export const networkFetch:typeof globalThis.fetch=(input,init)=>{
  transport??=new EnvHttpProxyAgent({noProxy:["localhost","127.0.0.1","::1",process.env.NO_PROXY??process.env.no_proxy??""].join(",")});
  return proxyFetch(input as Parameters<typeof proxyFetch>[0],{...init,dispatcher:transport} as Parameters<typeof proxyFetch>[1]) as unknown as Promise<Response>;
};
export async function closeNetwork(){const t=transport;transport=undefined;await t?.destroy();}
