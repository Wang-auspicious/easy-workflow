import test, {after} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {compile} from '../server/spec/compile.ts';import {pack} from '../packs/vislexicon/pack.ts';import {readRole} from '../server/roles.ts';
import {EvidenceStore} from '../server/evidence.ts';import type {StationContext} from '../server/runtime.ts';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'h2-capture-recovery-'));
const previousProject=process.env.FACTORY_VAR;process.env.FACTORY_VAR=dir;
const {findStage,links,pageKey,shoot}=await import('../packs/vislexicon/capture.ts');
const {TOOLS}=await import('../packs/vislexicon/tools.ts');
const {facts,factReview,shotReview}=await import('../packs/vislexicon/agents.ts');
after(async()=>{
 const {closeBrowser}=await import('../server/browser.ts');const {closeNetwork}=await import('../server/network.ts');
 await closeBrowser();await closeNetwork();
 if(previousProject===undefined)delete process.env.FACTORY_VAR;else process.env.FACTORY_VAR=previousProject;
 assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('h2-capture-recovery-'));
 fs.rmSync(dir,{recursive:true,force:true});
});

test('every node has a role handbook; curation roles are handwritten and teach the toolbox',()=>{
 const f=compile([pack]);
 for(const n of f.nodes){const role=readRole(n.key);assert.ok(role.content.length>150,n.key);}
 const curation=f.nodes.filter(n=>n.line==='curation');
 for(const n of curation){const c=readRole(n.key).content;
   if(n.kind==='agent'||n.kind==='review'){assert.match(c,/铁律/,n.key);assert.match(c,/提交|怎么提交/,n.key);}
   else assert.match(c,/程序工位|资源库/,n.key);}
 for(const k of ['curation/reader','curation/facts','curation/arbiter','curation/audit'])assert.match(readRole(k).content,/env_call|能力箱/,k);
 assert.match(readRole('curation/classify-review').content,/独立/);assert.match(readRole('curation/proof').content,/Storybook/);assert.match(readRole('dispatcher').content,/实时状态/);
 assert.throws(()=>readRole('../../auth'));assert.throws(()=>readRole('missing/station'));
});

test('facts and reviewer share the same evidence; reframing does not blacklist a valid page',async()=>{
 const quote='Code licensed under MIT license conditions';
 const unknown={value:'unknown',sourceUrl:'https://fixture.test',quote:'',evidence:'looked at the home page',scope:''};
 const dossier={finalUrl:'https://fixture.test',title:'Fixture',description:'',text:'Header '.repeat(270)+quote,headings:[],links:[],framework:[],files:{llms:null,llmsFull:null,sitemap:[],sitemapCount:0},pages:[],repo:null,via:['http']};
 const ctx={token:{data:{canonical:'https://fixture.test',dossier}},signal:new AbortController().signal,progress:()=>{},addEvidence:()=>({})} as unknown as StationContext;
 await facts.input(ctx);
 const out={author:unknown,organization:unknown,repository:unknown,pricing:unknown,sourceCode:unknown,commercial:unknown,license:{value:'MIT',sourceUrl:'https://fixture.test',quote,evidence:'footer',scope:'repository code'},pricingNote:'',conflicts:[],reply:''};
 assert.deepEqual(facts.check!(out as never,ctx),[]);
 const result=await facts.after!(out as never,ctx,{rounds:1} as never);Object.assign(ctx.token.data,result.data);
 assert.ok((await factReview.input(ctx)).text.includes(quote),'the reviewer must see quotes beyond character 1800');
 assert.ok(facts.check!({...out,license:{...out.license,quote:quote+'; invented permission'}} as never,ctx).length,'a real prefix cannot validate an invented quote tail');
 const review=shotReview({} as EvidenceStore),url='https://fixture.test/demo';
 ctx.token.data.shots={proof:{href:url}};
 const reframe=await review.after!({verdict:'return',returnTo:'proof',repair:'reframe',reason:'Scroll to the actual demo',perImage:[]},ctx,{rounds:1} as never);
 assert.deepEqual(reframe.data?.rejectedPages,undefined);
 assert.equal((reframe.data?.shotRepairs as any).proof.url,url);
 const replace=await review.after!({verdict:'return',returnTo:'proof',repair:'replace-page',reason:'This page only contains installation',perImage:[]},ctx,{rounds:1} as never);
 assert.deepEqual(replace.data?.rejectedPages,[url]);
});

test('capture chooses a bounded demo, keeps SPA routes and survives review reshoots',{timeout:30000},async t=>{
 const {openPage,closeBrowser}=await import('../server/browser.ts');
 const fixture=http.createServer((req,res)=>{if(req.url==='/index.json'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({entries:{button:{id:'button--primary',title:'Button',name:'Primary',type:'story'},docs:{id:'button--docs',title:'Button',name:'Docs',type:'docs'}}}));}res.end('<!doctype html><title>Storybook fixture</title><div class="example-tabset" style="height:5000px"><div class="bd-example" style="width:400px;height:200px;background:#caf"><svg width="350" height="150"><rect width="140" height="80" fill="red"/><circle cx="220" cy="90" r="50" fill="blue"/></svg></div><pre>source code</pre></div>');});
 await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));
 try{const {page,close}=await openPage();try{
   assert.ok(fs.existsSync(path.join(dir,'browser','profile')),'browser profile belongs to this isolated test project');
   await page.goto(`http://127.0.0.1:${(fixture.address() as {port:number}).port}`);
   await t.test('5000px document wrapper cannot win over the rendered component',async()=>{const stage=await findStage(page);assert.equal(stage?.sel,'.bd-example');assert.ok(stage!.h<=200);});
   await t.test('Storybook index exposes docs and real iframe examples without losing query identity',async()=>{const l=await links(page);assert.ok(l.some(x=>x.href.includes('path=%2Fdocs%2Fbutton--docs')));assert.ok(l.some(x=>x.href.includes('iframe.html?id=button--primary')));assert.notEqual(pageKey('https://x.test/?path=/docs/a'),pageKey('https://x.test/?path=/docs/b'));});
   await t.test('unnamed live examples before source blocks are detected without capturing source',async()=>{
     await page.setContent('<main><h1>Button</h1><div><button style="width:100px;height:40px;background:blue;color:white">Click me</button></div><div><pre>const source = 1</pre></div></main>');
     const stage=await findStage(page);assert.equal(stage?.sel,'example-before-code');assert.ok(stage!.h<=40);
   });
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
 }finally{await close();}}finally{await closeBrowser();fixture.closeAllConnections();await new Promise<void>(r=>fixture.close(()=>r()));}
});
