import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'easy-workflow-verified-import-'));
process.env.FACTORY_VAR=path.join(root,'target');process.env.FACTORY_PREFLIGHT='0';process.env.VISLEXICON_ROOT=path.join(root,'none');process.env.VISLEXICON_BUNDLED=path.join(root,'taxonomy');
fs.mkdirSync(path.join(process.env.VISLEXICON_BUNDLED,'src/data'),{recursive:true});
fs.writeFileSync(path.join(process.env.VISLEXICON_BUNDLED,'src/data/curation-taxonomy.js'),`export const CURATION_CATEGORIES=[];export const CURATION_SUBCATEGORIES={};export const CURATION_FACET_AXES={access:[],licenses:[{id:'unknown',aliases:[]}]};export const facetsErrors=()=>[];export const classificationErrors=()=>[];`);
const {Factory}=await import('../server/factory.ts');const {Journal}=await import('../server/journal.ts');const {EvidenceStore}=await import('../server/evidence.ts');const {TOOLS}=await import('../packs/vislexicon/tools.ts');const {adoptVerifiedResult}=await import('../server/verified-import.ts');

test('verified adoption rechecks the gate, copies evidence, supersedes queued work and stays paused',async()=>{
 const f=new Factory();await f.boot();const source=path.join(root,'source'),j=new Journal(path.join(source,'journal.db')),store=new EvidenceStore(path.join(source,'evidence'));
 try{
  const roles=['identity','breadth','proof'];const images=roles.map((role,i)=>{const a=store.put(Buffer.from(`fixture evidence ${i}`),'webp');return {role,src:a.src,card:a.src,sha256:a.sha,href:`https://fixture.test/${role}`};});
  const data:any={canonical:'https://fixture.test/',host:'fixture.test',key:'fixture.test',kind:'knowledge',kindAgreed:true,mode:'shots',images,shotReview:'pass','fact-reviewVerdict':'pass','copy-reviewVerdict':'pass',auditVerdict:'pass',facts:Object.fromEntries(['author','organization','repository','license','pricing'].map(field=>[field,{value:'unknown',sourceUrl:'https://fixture.test/',quote:'',evidence:'fixture',scope:''}])),copy:{name:'Fixture',takeawayZh:'查看测试资料',noteZh:'测试资料只用于验证结果导入。'.repeat(10),rationale:Object.fromEntries(roles.map(r=>[r,'验证已采集页面'])),alt:Object.fromEntries(roles.map(r=>[r,'测试页面的可视内容'])),reasons:[{statement:'fixture',evidenceUrl:'https://fixture.test/'}]},catalogV3:{primaryCategory:'fixture',subcategory:'fixture',facets:{}}};
  j.append({kind:'factory.loaded',digest:f.compiled.digest,specVersion:f.compiled.specVersion});j.append({kind:'run.started',runId:'fixture-source',title:'fixture'});
  j.append({kind: 'token.created', token: 'source-prior', line: 'candidates', item: 'fixture', url: 'https://fixture.test/', source: 'manual'});
  j.append({kind: 'case.noted', caseId: 'fixture', token: 'source-prior', note: {
    station: 'curation/facts', section: 'result', text: 'Website retry evidence', by: 'fixture',
  }});
  j.append({kind:'token.created',token:'source-token',line:'curation',item:'fixture',url:'https://fixture.test/',source:'manual'});
  j.append({kind: 'token.data', token: 'source-token', patch: {retryOf: 'source-prior'}});
  const result=await TOOLS['curation.gate']({token:{id:'source-token',url:'https://fixture.test/',data},attempt:'fixture-gate',progress:()=>{},addEvidence:()=>{},signal:new AbortController().signal} as any,{store,workDir:source,publishDir:path.join(source,'published'),inFlight:()=>new Set()} as any);
  assert.equal(result.data?.gate,'pass',result.summary);
  j.append({kind:'token.data',token:'source-token',patch:{...data,...result.data}});j.append({kind:'token.finished',token:'source-token',status:'published',node:'curation/published',reason:'fixture gate'});
  j.append({kind: 'case.noted', caseId: 'fixture', token: 'source-token', note: {
    station: 'curation/audit', section: 'result', text: 'Website final review', by: 'fixture',
  }});
  j.append({kind: 'token.created', token: 'source-other-pack', item: 'fixture', line: 'other-line', url: '', source: 'manual'});
  j.append({kind: 'token.data', token: 'source-other-pack', patch: {workflowPack: 'other-pack'}});
  j.append({kind: 'token.finished', token: 'source-other-pack', status: 'published', node: 'other-line/published', reason: 'Independent source result'});
  j.append({kind: 'case.noted', caseId: 'fixture', token: 'source-other-pack', note: {
    station: 'other-line/work', section: 'result', text: 'Foreign workflow evidence', by: 'fixture',
  }});
  j.append({kind: 'case.noted', caseId: 'fixture', token: '', note: {
    station: 'legacy/work', section: 'result', text: 'Unattributed ambiguous legacy evidence', by: 'fixture',
  }});
  f.runtime.start('target');f.runtime.pause();const pending=f.runtime.create('candidates/route',{item:'fixture',url:'https://fixture.test/',source:'manual'});
  f.journal.append({kind: 'token.created', token: 'target-other-pack', item: 'fixture', line: 'other-line', url: '', source: 'manual'});
  f.journal.append({kind: 'token.data', token: 'target-other-pack', patch: {workflowPack: 'other-pack'}});
  f.journal.append({kind: 'token.finished', token: 'target-other-pack', status: 'published', node: 'other-line/published', reason: 'Independent target result'});
  f.journal.append({kind: 'case.noted', caseId: 'fixture', token: 'target-other-pack', note: {
    station: 'curation/facts', section: 'result', text: 'Website retry evidence', by: 'fixture',
  }});
  const adopted=await adoptVerifiedResult(f,source,'fixture');assert.equal(adopted.status,'published');
  assert.equal(f.runtime.paused,true);assert.equal(f.state.tokens[pending.id].status,'parked');assert.deepEqual(f.state.tokens[pending.id].at,[]);
  assert.equal(f.state.tokens[pending.id].data.retriedBy,adopted.token);
  assert.notEqual(adopted.token, 'target-other-pack');
  assert.equal(f.state.tokens['target-other-pack'].status, 'published');
  assert.equal(f.state.tokens['target-other-pack'].data.retriedBy, undefined);
  const importedNotes = f.state.cases.fixture.filter(note => note.token === adopted.token && note.by === 'verified-import');
  assert.deepEqual(importedNotes.map(note => note.text), ['Website retry evidence', 'Website final review'],
    'import preserves the original website retry chain, without merging same-item workflow notes or guessing legacy identity');
  assert.deepEqual(f.state.tokens[adopted.token].attempts.map(id=>f.state.attempts[id].node),['curation/gate']);
  assert.ok(fs.existsSync(f.store.resolve(images[0].src)!));
  assert.equal((await adoptVerifiedResult(f,source,'fixture')).alreadyPresent,true);
  const file=path.join(source,'published/fixture.test.json'),record=JSON.parse(fs.readFileSync(file,'utf8'));record.editorial.name='Changed after review';fs.writeFileSync(file,JSON.stringify(record));
  await assert.rejects(adoptVerifiedResult(f,source,'fixture'),/审核后被修改/);
 }finally{j.close();await f.runtime.close();f.docs.flush();f.lessons.close();f.journal.close();fs.rmSync(root,{recursive:true,force:true});}
});
