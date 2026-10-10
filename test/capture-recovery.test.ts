import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {compile} from '../server/spec/compile.ts';import {pack} from '../packs/vislexicon/pack.ts';import {readRole} from '../server/roles.ts';
import {findStage,links,pageKey,shoot} from '../packs/vislexicon/capture.ts';import {TOOLS} from '../packs/vislexicon/tools.ts';import {EvidenceStore} from '../server/evidence.ts';import type {StationContext} from '../server/runtime.ts';

test('all default nodes have distinct task roles and dispatcher has bounded recovery duties',()=>{
 const f=compile([pack]);assert.equal(f.nodes.length,66);
 for(const n of f.nodes){const role=readRole(n.key);assert.match(role.content,new RegExp(n.key));assert.match(role.content,/情况判断与处理/);assert.match(role.content,/完成和交接/);}
 assert.match(readRole('curation/classify-review').content,/独立/);assert.match(readRole('curation/proof').content,/Storybook/);assert.match(readRole('dispatcher').content,/实时状态/);
 assert.throws(()=>readRole('../../auth'));assert.throws(()=>readRole('missing/station'));
});

test('capture chooses a bounded demo, keeps SPA routes and survives review reshoots',{timeout:30000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'h2-capture-recovery-'));process.env.FACTORY_VAR=dir;
 const {openPage,closeBrowser}=await import('../server/browser.ts');
 const fixture=http.createServer((req,res)=>{if(req.url==='/index.json'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({entries:{button:{id:'button--primary',title:'Button',name:'Primary',type:'story'},docs:{id:'button--docs',title:'Button',name:'Docs',type:'docs'}}}));}res.end('<!doctype html><title>Storybook fixture</title><div class="example-tabset" style="height:5000px"><div class="bd-example" style="width:400px;height:200px;background:#caf"><svg width="350" height="150"><rect width="140" height="80" fill="red"/><circle cx="220" cy="90" r="50" fill="blue"/></svg></div><pre>source code</pre></div>');});
 await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));
 try{const {page,close}=await openPage();try{
   await page.goto(`http://127.0.0.1:${(fixture.address() as {port:number}).port}`);
   await t.test('5000px document wrapper cannot win over the rendered component',async()=>{const stage=await findStage(page);assert.equal(stage?.sel,'.bd-example');assert.ok(stage!.h<=200);});
   await t.test('Storybook index exposes docs and real iframe examples without losing query identity',async()=>{const l=await links(page);assert.ok(l.some(x=>x.href.includes('path=%2Fdocs%2Fbutton--docs')));assert.ok(l.some(x=>x.href.includes('iframe.html?id=button--primary')));assert.notEqual(pageKey('https://x.test/?path=/docs/a'),pageKey('https://x.test/?path=/docs/b'));});
   await t.test('image processing stores durable references and reuses unaffected roles after a reshoot',async()=>{
     const work=path.join(dir,'work');fs.mkdirSync(work);const original=path.join(work,'identity.png');fs.writeFileSync(original,await shoot(page));
     const store=new EvidenceStore(path.join(dir,'evidence'));
     const ctx={token:{data:{mode:'shots',shots:{identity:{file:original,href:page.url(),hash:'',evidence:'original-evidence'}}}},progress:()=>{}} as unknown as StationContext;
     const svc={store,workDir:work,publishDir:path.join(dir,'publish'),inFlight:()=>new Set<string>()};
     const first=await TOOLS['curation.process'](ctx,svc);assert.equal(first.ok,true);assert.ok(!fs.existsSync(original));
     Object.assign(ctx.token.data,first.data);const canonical=(ctx.token.data.shots as any).identity.file;assert.ok(fs.existsSync(canonical));
     const second=await TOOLS['curation.process'](ctx,svc);assert.equal(second.ok,true);assert.deepEqual(second.data?.images,first.data?.images);assert.ok(fs.existsSync(canonical));
     (ctx.token.data.shots as any).identity.file=original;
     assert.equal((await TOOLS['curation.process'](ctx,svc)).ok,true,'legacy deleted PNG references recover from the same evidence WebP');
   });
 }finally{await close();}}finally{await closeBrowser();fixture.closeAllConnections();await new Promise<void>(r=>fixture.close(()=>r()));fs.rmSync(dir,{recursive:true,force:true});}
});
