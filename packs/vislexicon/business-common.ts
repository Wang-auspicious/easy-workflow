import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import type { StationContext, StationResult } from '../../server/runtime.ts';
import type { Services } from './tools.ts';

export type BusinessTool = (ctx: StationContext, services: Services) => Promise<StationResult>;
export const dataOf = (ctx: StationContext): Record<string, any> => ctx.token.data;
export const hash = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex');
export function atomicJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp,JSON.stringify(value,null,2),{flag:'wx'}); fs.renameSync(temp,file); }
  finally { fs.rmSync(temp,{force:true}); }
}
export function command(file: string, args: string[], ctx: StationContext, cwd: string, timeout = 120000) {
  return new Promise<{stdout:string;stderr:string}>((resolve,reject)=> {
    execFile(file,args,{cwd,signal:ctx.signal,timeout,windowsHide:true,maxBuffer:4*1024*1024,env:{...process.env,PYTHONIOENCODING:'utf-8'}},(error,stdout,stderr)=>error?reject(new Error(`${path.basename(file)}: ${String(stderr||error.message).slice(-2500)}`)):resolve({stdout:String(stdout),stderr:String(stderr)}));
  });
}
export function work(ctx: StationContext, svc: Services) {
  const dir=path.join(svc.workDir,'business',hash(ctx.token.id).slice(0,20),hash(ctx.attempt).slice(0,20));fs.mkdirSync(dir,{recursive:true});return dir;
}
export function storedOriginal(ctx: StationContext, svc: Services, bytes: Buffer, ext: string, source: Record<string,unknown>) {
  const stored=svc.store.put(bytes,ext);
  const ev=ctx.addEvidence({id:`original-${stored.sha}`,kind:'text',label:'原始文件',src:stored.src,tone:'ok',meta:{...source,sha256:stored.sha,bytes:bytes.length}});
  return {...source,src:stored.src,sha256:stored.sha,bytes:bytes.length,evidence:ev.id};
}
export function publishBusiness(ctx: StationContext, svc: Services, line: string, value: Record<string,unknown>) {
  ctx.signal.throwIfAborted();
  const record={schemaVersion:1,line,source:ctx.token.url,item:ctx.token.item,token:ctx.token.id,...value};
  const digest=hash(JSON.stringify(record)), id=hash(ctx.token.item).slice(0,24);
  const file=path.join(svc.publishDir,'business',line,`${id}.json`);
  const artifact=svc.store.put(Buffer.from(JSON.stringify(record,null,2)),'json');
  ctx.addEvidence({id:`business-${digest.slice(0,20)}`,kind:'verdict',label:'发布验收',src:artifact.src,verdict:'通过',tone:'ok',meta:{digest,line}});
  ctx.signal.throwIfAborted();
  atomicJson(file,{...record,digest,publishedAt:new Date().toISOString()});
  return {digest,artifact:artifact.src,file};
}
