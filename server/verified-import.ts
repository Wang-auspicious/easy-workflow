import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {Factory} from './factory.ts';
import {Journal} from './journal.ts';
import {apply, initialState, recoveryKey, type TokenState} from '../shared/project.ts';
import {EvidenceStore} from './evidence.ts';
import {ControlError} from './errors.ts';
import {loadTaxonomy, validateV3} from '../packs/vislexicon/v3.ts';

function websiteRoot(token: TokenState): boolean {
  return !token.data.workflowPack && !token.data.channelDelivery && !token.source.startsWith('channel:') &&
    ['candidates', 'curation'].includes(token.line);
}

/** Adopt one actually published item, with its evidence and review lineage.
 * Importing does not assert publication: the current local gate executes again. */
export async function adoptVerifiedResult(f: Factory, sourceProject: string, item: string) {
  const source=fs.realpathSync(sourceProject), target=fs.realpathSync(f.docs.dir);
  if(source===target)throw new ControlError(400,'same_project','来源和当前项目相同');
  const j=new Journal(path.join(source,'journal.db'),true), state=initialState(f.compiled);
  try {for(const event of j.read())apply(state,event);} finally {j.close();}
  const original=Object.values(state.tokens).filter(t=>t.item===item&&t.status==='published'&&websiteRoot(t)).sort((a,b)=>b.createdAt-a.createdAt)[0];
  if(!original)throw new ControlError(422,'not_published','来源项目没有该条目的真实发布记录');
  if(state.digest!==f.state.digest)throw new ControlError(409,'spec_changed','两个项目的工作流规格不同，不能直接接回审核结果');
  const data=structuredClone(original.data) as Record<string,any>;
  const file=path.join(source,'published',`${String(data.key??data.host).replace(/[\/:*?"<>|]+/g,'~')}.json`);
  const bytes=fs.readFileSync(file), record=JSON.parse(bytes.toString('utf8'));
  if(record.h2?.token!==original.id||record.h2?.digest!==data.digest||data.gate!=='pass')throw new ControlError(422,'unverified_record','发布文件与来源的闸门记录不一致');
  const {digest:_,publishedAt:__,...h2}=record.h2;
  const digest=crypto.createHash('sha256').update(JSON.stringify({...record,official:{...record.official,checkedAt:''},classification:{...record.classification,confirmedAt:''},editorialVoice:null,h2})).digest('hex');
  if(digest!==data.digest)throw new ControlError(422,'changed_record','发布文件在审核后被修改，必须重新审核');
  const problems=validateV3(record,await loadTaxonomy());
  if(problems.length)throw new ControlError(422,'invalid_record','发布文件不符合当前结构规则',problems);
  const sourceStore=new EvidenceStore(path.join(source,'evidence'),true);
  const served=new Set<string>();
  const collect=(value:unknown)=>{if(typeof value==='string'&&/^\/evidence\//.test(value))served.add(value);else if(Array.isArray(value))value.forEach(collect);else if(value&&typeof value==='object')Object.values(value).forEach(collect);};
  collect(record);collect(data.images);collect(data.video);
  for(const id of original.evidence)collect(state.evidence[id]);
  const assets=[...served].map(url=>{
    const resolved=sourceStore.resolve(url);
    if(!resolved)throw new ControlError(422,'invalid_asset','产物含非法证据路径');
    const real=fs.realpathSync(resolved),root=fs.realpathSync(sourceStore.root);
    if(!real.startsWith(root+path.sep))throw new ControlError(422,'invalid_asset','证据文件超出来源项目');
    const content=fs.readFileSync(real),sha=crypto.createHash('sha256').update(content).digest('hex');
    if(path.basename(real).split('.')[0]!==sha)throw new ControlError(422,'changed_asset','截图内容与审核时的哈希不一致');
    return {url,content,ext:path.extname(real).slice(1)};
  });
  const latest=Object.values(f.state.tokens).filter(t=>t.item===item&&websiteRoot(t)).sort((a,b)=>b.createdAt-a.createdAt)[0];
  const receipt=crypto.createHash('sha256').update(bytes).digest('hex');
  if(latest?.status==='published')return {token:latest.id,status:'published',alreadyPresent:true};
  if(f.importing||!f.runtime.running||!f.runtime.paused||[...f.runtime.workers.values()].some(pool=>pool.some(w=>w.busy)))throw new ControlError(409,'project_busy','接回成果前请暂停当前轮次并等待在途工位退出');
  f.importing=true;
  const goal=f.state.batch, trial=f.broker.recoveryToken;
  let token:ReturnType<Factory['runtime']['create']>|undefined;
  try {
    for(const asset of assets)if(f.store.put(asset.content,asset.ext).src!==asset.url)throw new Error('Evidence hash mismatch');
    // Source screenshots can retain an old absolute location. Rebind immutable
    // evidence paths only; never let the resumed gate write into the source.
    const rebase=(value:any):any=>{
      if(typeof value==='string') {const match=value.replace(/\\/g,'/').match(/\/evidence\/[0-9a-f]{2}\/[0-9a-f]{64}\.(?:webp|mp4|json|txt|jpg|png)$/);return match&&!value.startsWith('/evidence/')?f.store.resolve(match[0])??value:value;}
      if(Array.isArray(value))return value.map(rebase);
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rebase(v)]));
      return value;
    };
    for(const key of ['failure','batchRecovery','stationSessions','gate','digest','retriedBy','manualReason','capacityWait'])delete data[key];
    const importSource={project:source,token:original.id,entryId:record.entryId,receipt,at:Date.now()};
    if(goal)f.journal.append({kind:'batch.configured',batch:{...goal,mode:'paused'}});
    token=f.runtime.create('curation/gate',{item,url:original.url,title:original.title,source:latest?.source??original.source,data:{...rebase(data),retryOf:latest?.id,importSource}});
    f.broker.recoveryToken=token.id;
    if(latest){
      const prior=f.runtime.tokens.get(latest.id);if(prior)prior.finished=true;
      for(const queue of f.runtime.queues.values()){const at=queue.indexOf(latest.id);if(at>=0)queue.splice(at,1);}
      if(latest.status==='active')f.journal.append({kind:'token.finished',token:latest.id,node:latest.at[0]??latest.finishedAtNode??'curation/gate',status:'parked',reason:'由接回的已验收成果替代，停止重复处理'});
      f.journal.append({kind:'token.data',token:latest.id,patch:{retriedBy:token.id}});
    }
    const indexed = latest && f.state.recoveries[recoveryKey(latest)];
    const recovery = indexed?.token === latest?.id ? indexed : undefined;
    if(recovery){f.journal.append({kind:'candidate.disposition',candidate:{...recovery,token:token.id,disposition:'claimed'}});if(recovery.disposition==='retry')f.runtime.stockDelta('candidates/pool',-1,'接回已通过审核的成果');}
    for(const id of original.evidence){const e=state.evidence[id];if(e)f.journal.append({kind:'evidence.added',evidence:{...e,id:`${id}-${token.id}`,token:token.id,at:Date.now(),meta:{...e.meta,importSource}}});}
    const belongsToWebsite = (tokenId: string, tokens: Record<string, TokenState>) => {
      const owner = tokens[tokenId];
      return owner?.item === item && websiteRoot(owner);
    };
    // CASE files are grouped by item for legacy compatibility. Only a recorded
    // website token proves ownership; same-item packs and unscoped old notes do not.
    const existing = new Set((f.state.cases[item] ?? [])
      .filter(note => belongsToWebsite(note.token, f.state.tokens))
      .map(note => JSON.stringify([note.station, note.section, note.text])));
    for (const note of state.cases[item] ?? []) {
      if (!belongsToWebsite(note.token, state.tokens) ||
        existing.has(JSON.stringify([note.station, note.section, note.text]))) continue;
      f.journal.append({kind: 'case.noted', caseId: item, token: token.id, note: {...note, by: 'verified-import'}});
    }
    f.journal.append({kind:'dispatch.note',node:'curation/gate',tone:'info',text:`${original.title??item}：从已验证项目接回完整成果与审核记录，重新检查当前发布闸门，不重复模型审核`});
    f.runtime.resume();await f.runtime.settle();
    const status=f.state.tokens[token.id].status;
    if(status!=='published')throw new ControlError(422,'gate_rejected','成果已接回，但当前发布闸门未通过；保留检查记录，不标为已发布',{token:token.id,status});
    return {token:token.id,status,sourceToken:original.id,receipt};
  } finally {
    f.runtime.pause();f.broker.recoveryToken=trial===latest?.id?null:trial;
    if(goal){
      const circuit=goal.modelCircuit?.state==='trial'&&goal.modelCircuit.trialToken===latest?.id?{...goal.modelCircuit,state:'open' as const,trialToken:undefined,nextAt:Date.now()+30000}:goal.modelCircuit;
      if(circuit?.state==='open')f.broker.modelHold=Object.values(f.state.alerts).find(a=>a.kind==='model')?.message??'模型仍需通过真实工位恢复验证';
      f.journal.append({kind:'batch.configured',batch:{...f.state.batch!,mode:goal.mode,modelCircuit:circuit}});
    }
    f.importing=false;
  }
}
