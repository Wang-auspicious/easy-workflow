import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { classifyFailure, candidateFailure } from "../shared/failures.ts";
import type { Executor, StationContext } from "../server/runtime.ts";
import {line, station} from '../server/spec/dsl.ts';
import {installWorkflowPack, type WorkflowManifest} from '../server/workflow-packs.ts';

// Every database, catalogue and report belongs to this test process.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h2-recovery-"));
process.env.FACTORY_VAR = dir; process.env.FACTORY_PREFLIGHT = "0";
process.env.VISLEXICON_ROOT = path.join(dir, "no-catalogue");
const { Factory } = await import("../server/factory.ts");
const { FactoryControl } = await import("../server/control.ts");
const { Journal } = await import("../server/journal.ts");
const { endRun, readReport } = await import("../server/report.ts");
const { TOOLS, canonical, httpGet } = await import("../packs/vislexicon/tools.ts");
const { closeNetwork } = await import("../server/network.ts");
const { SourceSupervisor } = await import('../server/sources.ts');
const {pack} = await import('../packs/vislexicon/pack.ts');

test("failed fetches, durable candidate recovery, tagged retry and paused-run termination", {timeout:30000}, async t => {
  let factory:InstanceType<typeof Factory>|undefined;
  const fixture = http.createServer((req,res) => {
    const code=Number(req.url?.slice(1))||200;
    res.writeHead(code,{"content-type":"text/html"});
    res.end("<title>Recovery fixture</title><a href='/docs'>Docs</a>");
  });
  await new Promise<void>(resolve=>fixture.listen(0,"127.0.0.1",resolve));
  const base=`http://127.0.0.1:${(fixture.address() as {port:number}).port}`;
  try {
    await t.test("URL normalization and errors preserve recoverability and nested causes",()=>{
      assert.equal(canonical("git+https://github.com/owner/repo.git"),"https://github.com/owner/repo");
      assert.equal(canonical("https://git+https/github.com/owner/repo.git"),"https://github.com/owner/repo");
      for(const u of ["javascript:alert(1)","file:///test","https://name:password@example.test","https://"])
        assert.equal(canonical(u),null,u);
      const dns=classifyFailure(new Error("fetch failed",{cause:Object.assign(new Error("name lookup failed"),{code:"ENOTFOUND"})}));
      assert.equal(dns.tag,"network_dns");assert.equal(dns.retryable,true);assert.match(dns.message,/ENOTFOUND/);
      for(const [status,tag,retryable] of [[404,"http_not_found",false],[410,"http_not_found",false],[429,"http_rate_limit",true],[503,"http_server",true],[403,"http_forbidden",true]] as const){
        const f=classifyFailure(`HTTP ${status}`,{status});assert.equal(f.tag,tag);assert.equal(f.retryable,retryable);
      }
      assert.equal(classifyFailure("page.screenshot: Timeout 30000ms exceeded").tag,"browser_capture");
      assert.equal(classifyFailure("page.goto: Timeout 40000ms exceeded").tag,"network_timeout");
      const deadDemo=classifyFailure("HTTP 404",{url:"https://example.test/demos/old",status:404});
      assert.equal(candidateFailure(deadDemo,"https://example.test").retryable,true,"a broken demo must not remove its valid homepage");
      assert.equal(candidateFailure(deadDemo,"https://example.test/demos/old").retryable,false,"a dead candidate entry itself is removed");
    });
    await t.test("real HTTP errors are failed station results; successful text remains evidence",async()=>{
      const evidence:unknown[]=[];
      for(const status of [200,404,429,503]){
        const ctx={token:{url:`${base}/${status}`,data:{}},signal:new AbortController().signal,attempt:`a${status}`,progress:()=>{},addEvidence:(e:unknown)=>{evidence.push(e);return e;}} as unknown as StationContext;
        const result=await TOOLS["curation.fetch"](ctx,{} as never);
        assert.equal(result.ok,status===200);assert.equal(result.finish,undefined);
        if(status!==200)assert.equal(result.failure?.status,status);
      }
      assert.equal(evidence.length,1);
      const response=await httpGet(`${base}/200`,new AbortController().signal);assert.equal(response.status,200);
    });
    await t.test("boot migrates legacy false successes once and excludes superseded failures",async()=>{
      const j=new Journal(path.join(dir,"journal.db"));
      j.append({kind:"run.started",runId:"legacy",title:"Legacy failures"});
      for(const [item,url,error] of [
        ["network",`${base}/200`,"打不开：fetch failed"],
        ["invalid","https://git+https/github.com/owner/repo.git","打不开：fetch failed"],
        ["capture",`${base}/200#capture`,"page.screenshot: Timeout 30000ms exceeded"],
        ["later-success",`${base}/200#success`,"打不开：fetch failed"],
      ]){
        j.append({kind:"token.created",token:item,line:"curation",item,url,source:"candidates/pool"});
        j.append({kind:"attempt.started",attempt:`a-${item}`,token:item,node:"curation/fetch",worker:"legacy-worker",input:item});
        j.append({kind:"attempt.finished",attempt:`a-${item}`,ok:item!=="capture",summary:error,ms:10,queuedMs:0,error:item==="capture"?error:undefined});
        j.append({kind:"token.finished",token:item,node:"curation/fetch",status:"rejected",reason:error});
      }
      j.append({kind:"token.created",token:"new-success",item:"later-success",url:base,line:"curation",source:"candidates/pool"});
      j.append({kind:"token.finished",token:"new-success",node:"curation/published",status:"published",reason:"done"});
      j.append({kind:"run.ended",runId:"legacy",manual:true});j.close();
      factory=new Factory();await factory.boot();
      assert.equal(factory.candidateFailures({disposition:"retry"}).length,2);
      assert.equal(factory.candidateFailures({disposition:"removed"}).length,1);
      assert.equal(factory.state.recoveries["later-success"],undefined);
      assert.equal(factory.state.attempts["a-network"].ok,false);
      assert.equal(factory.state.nodes["candidates/pool"].stock,2);
      await factory.runtime.close();factory.docs.flush();factory.lessons.close();factory.journal.close();
      factory=new Factory();await factory.boot();
      assert.equal(factory.state.nodes["candidates/pool"].stock,2);
      assert.equal(factory.state.recoveries.network.attempts,1);
    });
    await t.test("explicit tagged retry claims once and keeps invalid candidates excluded",async()=>{
      const f=factory!,control=new FactoryControl(f);
      assert.match(control.bootstrap().instructions,/candidate_failures/);
      f.journal.append({kind:"token.data",token:"network",patch:{canonical:base,kind:"tool",home:{title:"Existing evidence"}}});
      f.journal.append({kind:"evidence.added",evidence:{id:"before-retry",token:"network",station:"curation/fetch",attempt:"a-network",at:Date.now(),kind:"text",label:"Existing evidence"}});
      let resumedAt="";
      f.runtime.executors=n=>async ctx=>{resumedAt=n.key;assert.equal(ctx.token.data.kind,"tool");return {ok:true,summary:"fixture complete",finish:{status:"published",reason:"test outcome"}};};
      const result=await control.execute("retry_candidates",{tag:"network_connection",count:10});
      assert.equal(result.result.count,1);
      const again=await control.execute("retry_candidates",{tag:"network_connection",count:10});assert.equal(again.result.count,0);
      await f.runtime.settle();
      assert.equal(resumedAt,"curation/scout","resume the failing station (legacy fetch is now the scout), not intake/classification");
      assert.ok(f.state.tokens[result.result.tokens[0].id].evidence.some(id=>f.state.evidence[id].meta?.reusedFrom==="before-retry"));
      assert.equal(f.state.recoveries.network.disposition,"resolved");
      assert.equal(f.state.recoveries.invalid.disposition,"removed");
      assert.equal(f.state.nodes["candidates/pool"].stock,1);
      await endRun(f);
    });
    await t.test("station failure parks immediately and preserves reason without blind repeated attempts",async()=>{
      const f=factory!;
      f.runtime.executors=()=>async()=>{throw new Error("fetch failed",{cause:Object.assign(new Error("connection reset"),{code:"ECONNRESET"})});};
      f.raiseAlert({id:"browser:capture",kind:"browser",level:"red",item:"capture",message:"Browser pool recovery exhausted",nextAction:"Retry after repair"});
      const tasks=f.retryCandidates({tag:"browser_capture",count:5});assert.equal(tasks.length,1);
      assert.equal(f.state.alerts["browser:capture"],undefined,"retry clears the repaired browser pool alert");
      await f.runtime.settle();
      const token=f.state.tokens[tasks[0].id];
      assert.equal(token.status,"parked");assert.equal(token.attempts.length,1);
      assert.equal(f.state.recoveries.capture.failure?.tag,"network_connection");
      assert.equal(f.state.recoveries.capture.attempts,2);
      assert.equal(f.state.nodes["candidates/pool"].stock,1);
      const report=await endRun(f);assert.equal(report?.attempts[0].ok,false);
    });
    await t.test("ending a paused run cancels in-flight work, waits for cleanup and writes one report",async()=>{
      const f=factory!;
      let cancelled=0;
      let notifyStarted!:()=>void;
      const started=new Promise<void>(resolve=>{notifyStarted=resolve;});
      f.runtime.executors=()=>async ctx=>{
        await new Promise<void>((_resolve,reject)=>{ctx.signal.addEventListener("abort",()=>{cancelled++;void delay(25).then(()=>reject(new Error("aborted")));},{once:true});notifyStarted();});
        return {ok:true,summary:"must never commit"};
      };
      const tokens=f.retryCandidates({tag:"network_connection",count:5});assert.equal(tokens.length,1);
      await started;
      f.runtime.pause();
      const p1=endRun(f),p2=endRun(f);
      assert.throws(()=>f.runtime.start("too early"),/正在结束/);
      const [a,b]=await Promise.all([p1,p2]);assert.equal(a?.runId,b?.runId);
      assert.equal(cancelled,1);assert.equal(f.state.run.status,"ended");
      assert.ok(Object.values(f.state.nodes).every(n=>!n.active.length&&!n.queue.length));
      assert.ok(Object.values(f.state.workers).every(w=>w.busy===null));
      assert.equal(f.state.nodes["candidates/tidy"].failed,0,"manual cancellation is not a tool failure");
      assert.equal(readReport(a!.runId)?.status,"ended");
      assert.equal(f.state.recoveries.capture.failure?.tag,"run_ended");
      assert.equal([...f.journal.read(0,a!.runId)].filter(e=>e.kind==="report.ready").length,1);
    });
    await t.test("recovery hooks remain active after graph activation and survive another restart",async()=>{
      const f=factory!;
      const patch=f.proposePatch({author:"user",summary:"test rename",ops:[{op:"set",station:"curation/scout",field:"name",value:"侦察"}]});
      f.decidePatch(patch.patch.id,true);
      f.runtime.start("park after activation");f.runtime.pause();
      f.feed([`${base}/pending`]);await endRun(f);
      assert.equal(f.candidateFailures({tag:"run_ended",disposition:"retry"}).length,2);
      const expected=f.candidateFailures({disposition:"retry"}).length;
      await f.runtime.close();f.docs.flush();f.lessons.close();f.journal.close();factory=undefined;
      factory=new Factory();await factory.boot();
      assert.equal(factory.candidateFailures({disposition:"retry"}).length,expected);
      assert.equal(factory.state.nodes["candidates/pool"].stock,expected);
    });
    await t.test("checkpoint retry can return upstream, survive restart and count one logical item",async()=>{
      let f=factory!;
      // These executors are in-memory fixtures, not actual browser processes.
      f.broker.memoryFloorMB=0;
      const until=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await delay(10);assert.ok(check(),"runtime must reach the expected checkpoint");};
      f.runtime.start("checkpoint review recovery");
      f.runtime.executors=n=>async()=>n.key==="curation/proof"
        ? {ok:false,summary:"missing artifact",error:"identity.png missing"}
        : {ok:true,summary:"fixture evidence"};
      const first=f.runtime.create("curation/identity",{item:"checkpoint-item",url:base,source:"candidates/pool",data:{canonical:base,kind:"tool",mode:"shots",needsProof:true}});
      await until(()=>f.state.tokens[first.id].status==="parked");
      f.runtime.executors=n=>async()=>{
        if(n.key==="curation/shot-review"){
          f.runtime.pause();
          return {ok:true,summary:"reshoot identity",verdict:{verdict:"return",returnTo:"curation/identity",reason:"fixture review"}};
        }
        return {ok:true,summary:"reuse existing evidence"};
      };
      const [retry]=f.retryCandidates({items:["checkpoint-item"],count:1});
      await until(()=>f.runtime.queues.get("curation/identity")!.includes(retry.id));
      assert.equal(f.state.attempts[f.state.tokens[retry.id].attempts[0]].node,"curation/proof");
      await f.runtime.close();f.docs.flush();f.lessons.close();f.journal.close();factory=undefined;
      factory=new Factory();await factory.boot();f=factory;
      f.broker.memoryFloorMB=0;
      const resumed=f.runtime.tokens.get(retry.id)!;
      assert.ok(resumed.closure.has("curation/identity"));
      assert.ok(!resumed.done.has("curation/identity"),"return invalidation must survive restart");
      assert.equal(resumed.notes.get("curation/identity")?.reason,"fixture review","review instructions must survive restart");
      const executed:string[]=[];
      f.runtime.executors=n=>async()=>{executed.push(n.key);return {ok:true,summary:"fixture complete",data:n.key==="curation/gate"?{gate:"pass"}:undefined};};
      f.runtime.resume();await until(()=>f.state.tokens[retry.id].status!=="active");
      assert.equal(f.state.tokens[retry.id].status,"published");
      assert.equal(executed[0],"curation/identity");
      assert.ok(executed.includes("curation/process"));
      const report=await endRun(f);
      assert.equal(report?.totals.created,1,"retry is not a second logical item");
      assert.equal(report?.totals.parked,0,"superseded failure is no longer pending");
      assert.ok(report?.attempts.some(a=>a.token===first.id&&!a.ok),"original failed work stays in the cost/audit record");
    });
    await t.test("a facts review return does not cancel the independent style branch",async()=>{
      const f=factory!;f.broker.memoryFloorMB=0;f.runtime.start("independent review branches");
      let factReviews=0;
      f.runtime.executors=n=>async()=>{
        if(n.key==="curation/style")await delay(100);
        if(n.key==="curation/fact-review"&&factReviews++===0)return {ok:true,summary:"fix facts",verdict:{verdict:"fix",reason:"fixture missing quote",fixes:[{station:"curation/facts",fields:["facts.license"],problem:"fixture missing quote"}]}};
        return {ok:true,summary:"fixture complete",data:n.key==="curation/gate"?{gate:"pass"}:undefined};
      };
      const token=f.runtime.create("curation/plan",{item:"branched-review",url:base,source:"manual"});
      for(let i=0;i<300&&f.state.tokens[token.id].status==="active";i++)await delay(10);
      assert.equal(f.state.tokens[token.id].status,"published");
      const styles=f.state.tokens[token.id].attempts.map(id=>f.state.attempts[id]).filter(a=>a.node==="curation/style");
      assert.equal(styles.length,1);assert.equal(styles[0].ok,true);
      assert.equal(factReviews,2);
      const consults=Object.values(f.state.consults).filter(c=>c.token===token.id);
      assert.equal(consults.length,1);assert.equal(consults[0].owner,"curation/facts");assert.equal(consults[0].outcome,"resolved");
      const facts=f.state.tokens[token.id].attempts.map(id=>f.state.attempts[id]).filter(a=>a.node==="curation/facts");
      assert.equal(facts.length,2,"the owner re-runs once for the reviewer, without replaying unrelated stations");
      assert.ok((f.state.cases["branched-review"]??[]).some(n=>n.section.startsWith("审核")),"reviews are written to the case file");
      await endRun(f);
    });
    await t.test("completed items remain correctable after restarting an ended run",async()=>{
      let f=factory!;
      const previous=Object.values(f.state.tokens).find(t=>t.item==="branched-review")!;
      await f.runtime.close();f.docs.flush();f.lessons.close();f.journal.close();factory=undefined;
      factory=new Factory();await factory.boot();f=factory;
      f.runtime.executors=()=>async()=>({ok:true,summary:"fixture corrected",finish:{status:"published",reason:"fixture"}});
      assert.equal(f.runtime.correct({token:previous.id,node:"curation/facts"},"Verify the source again").ok,true);
      await f.runtime.settle();const report=await endRun(f);assert.equal(report?.totals.created,1,"historical corrections still appear in the current report");
    });
    await t.test("choosing a concrete preview page validates the URL and resumes the selected checkpoint",async()=>{
      const f=factory!;f.broker.memoryFloorMB=0;f.runtime.start("page choice");
      f.runtime.executors=()=>async()=>({ok:false,summary:"没有合格的特写",error:"needsPick"});
      const old=f.runtime.create("curation/proof",{item:"page-choice",url:base,source:"candidates/pool",data:{canonical:base,kind:"component-source",keptEvidence:true}});
      for(let i=0;i<100&&f.state.tokens[old.id].status==="active";i++)await delay(10);
      const control=new FactoryControl(f),url=`${base}/demo?path=/docs/button`;
      await assert.rejects(control.execute("choose_preview_page",{item:old.item,role:"proof",url:"https://unrelated.test/demo"}),/该站点/);
      await assert.rejects(control.execute("choose_preview_page",{item:old.item,role:"proof",url:`${base}/llms.txt`}),/可视页面/);
      f.runtime.executors=n=>async ctx=>{assert.equal(n.key,"curation/proof");assert.equal((ctx.token.data.previewChoices as any).proof,url);assert.equal(ctx.token.data.keptEvidence,true);return {ok:true,summary:"fixture pass",finish:{status:"published",reason:"fixture"}};};
      const response=await control.execute("choose_preview_page",{item:old.item,role:"proof",url});
      await f.runtime.settle();assert.equal(f.state.tokens[response.result.token].status,"published");
      await assert.rejects(control.execute("choose_preview_page",{item:old.item,role:"proof",url}),/不在待处理/);
      await endRun(f);
    });
  } finally {
    if(factory){await factory.runtime.close();factory.docs.flush();factory.lessons.close();factory.journal.close();}
    fixture.closeAllConnections();await new Promise<void>(resolve=>fixture.close(()=>resolve()));
    await closeNetwork();fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('unmanaged network recovery preserves source, channel and manual checkpoints with two durable attempts', {timeout: 30000}, async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  const finish = async (factory: InstanceType<typeof Factory>) => {
    factory.recovery.close();
    await factory.sources.close();
    factory.channels?.close();
    await factory.runtime.close();
    factory.docs.flush();
    factory.lessons.close();
    factory.journal.close();
  };
  const settle = async (factory: InstanceType<typeof Factory>) => {
    await new Promise<void>(resolve => setImmediate(resolve));
    await factory.runtime.settle();
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  for (const origin of ['manual', 'source', 'channel'] as const) {
    let factory = new Factory();
    const item = 'network-' + origin;
    const failedStation = origin === 'channel' ? 'components/describe' : 'curation/reader';
    const preparedStation = origin === 'channel' ? 'components/adapter' : 'curation/scout';
    let prepared = 0;
    let attempts = 0;
    const execute: Executor = async ctx => {
      if (ctx.token.item === 'healthy-source') return {ok: true, summary: 'Healthy next source', finish: {status: 'published', reason: 'fixture'}};
      if (ctx.node.key === preparedStation) {
        prepared++;
        ctx.addEvidence({id: `prepared-${origin}`, kind: 'text', label: 'Existing preparation'});
        return {ok: true, summary: 'Prepared once', data: {retained: 'saved work', canonical: ctx.token.url}};
      }
      if (ctx.node.key === failedStation) {
        attempts++;
        assert.equal(ctx.token.data.retained, 'saved work');
        // The manual case deliberately lets a later-started parallel branch
        // succeed before this failure. Its success must not hide the failed node.
        if (origin === 'manual') await new Promise<void>(resolve => setImmediate(resolve));
        if (origin === 'source' || attempts < 3) return {ok: false, summary: 'Fixture timeout', failure: {
          tag: 'network_timeout', category: 'network', message: 'Fixture timeout', retryable: true, owner: 'system',
        }};
        return {ok: true, summary: 'Recovered', finish: {status: 'published', reason: 'fixture'}};
      }
      return {ok: true, summary: 'Local fixture step'};
    };
    const latest = () => {
      const token = Object.values(factory.state.tokens).findLast(value => value.item === item &&
        !value.data.retriedBy && (origin !== 'channel' || value.data.channelDelivery));
      assert.ok(token);
      return {token, plan: token.data.__runtimeRecovery as {state: string; nextAt: number; networkAttempts: number}};
    };
    try {
      await factory.boot();
      factory.broker.memoryFloorMB = 0;
      factory.runtime.executors = () => execute;
      factory.runtime.start('Unmanaged ' + origin);
      if (origin === 'source') {
        await factory.sources.close();
        factory.sources = new SourceSupervisor(factory);
        factory.sources.configure({id: 'fixture', name: 'Fixture source', url: 'https://feed.example/items',
          platform: 'fixture', format: 'json', target: 'candidates/tidy', intervalMs: 86400000, enabled: true});
        factory.journal.append({kind: 'source.polled', source: 'fixture', nextAt: Date.now() + 86400000, count: 0, duplicates: 0});
        for (const id of [item, 'healthy-source']) factory.journal.append({kind: 'source.candidate', candidate: {
          id, source: 'fixture', platform: 'fixture', sourceUrl: 'https://feed.example/items',
          url: `https://${id}.example/`, title: id, discoveredAt: Date.now(), status: 'pending',
        }});
      } else if (origin === 'channel') {
        const parent = factory.runtime.create('curation/published', {item, url: 'https://channel.example/', source: 'manual'});
        factory.journal.append({kind: 'channel.emitted', channel: 'curation.component-source.confirmed',
          token: parent.id, item, inventory: 'consumer'});
        factory.runtime.setScopePaused({scope: 'line', key: 'curation', paused: true, reason: 'Independent parent remains queued'});
        factory.runtime.create('curation/scout', {item: 'waiting-parent', url: 'https://parent.example/', source: 'manual'});
      } else {
        factory.runtime.create('curation/scout', {item, url: 'https://manual.example/', source: 'manual'});
      }
      await settle(factory);
      assert.equal(attempts, 1);
      assert.equal(latest().plan.state, 'waiting');
      assert.equal(latest().plan.networkAttempts, 0);
      if (origin === 'manual') assert.equal(factory.state.attempts[latest().token.attempts.at(-1)!].ok, true,
        'the reproduction includes an unrelated later-started successful branch');
      if (origin === 'source') assert.equal(factory.sources.list()[0].counts.acknowledged, 1,
        'a failed item cannot occupy the source intake slot');
      const deadline = latest().plan.nextAt;
      factory.runtime.pause();
      await finish(factory);
      factory = new Factory();
      await factory.boot();
      factory.broker.memoryFloorMB = 0;
      factory.runtime.executors = () => execute;
      assert.equal(latest().plan.nextAt, deadline, 'restart cannot shorten the durable wait');
      t.mock.timers.tick(60000);
      factory.recovery.pump();
      await settle(factory);
      assert.equal(attempts, 1, 'global pause keeps an overdue retry queued');
      factory.runtime.resume();
      factory.recovery.pump();
      await settle(factory);
      assert.equal(attempts, 2);
      assert.equal(prepared, 1);
      assert.equal(latest().plan.networkAttempts, 1);
      factory.runtime.setScopePaused({scope: 'station', key: failedStation, paused: true, reason: 'Inspect retry'});
      t.mock.timers.tick(60000);
      factory.recovery.pump();
      await settle(factory);
      assert.equal(attempts, 2);
      factory.runtime.setScopePaused({scope: 'station', key: failedStation, paused: false, reason: 'Resume retry'});
      factory.recovery.pump();
      await settle(factory);
      assert.equal(attempts, 3);
      assert.equal(prepared, 1);
      assert.equal(latest().plan.networkAttempts, 2);
      assert.equal(latest().plan.state, origin === 'source' ? 'exhausted' : 'completed');
      assert.equal(latest().token.status, origin === 'source' ? 'parked' : 'published');
      assert.ok(latest().token.evidence.some(id => factory.state.evidence[id].meta?.reusedFrom));
      for (let i = 0; i < 3; i++) {t.mock.timers.tick(3600000); factory.recovery.pump(); await settle(factory);}
      assert.equal(attempts, 3, 'exhausted automatic budgets never become an unbounded loop');
      if (origin === 'channel') {
        assert.equal(factory.channels!.status()[0].status, 'acknowledged');
        assert.equal(Object.values(factory.state.tokens).find(token => token.item === 'waiting-parent')?.status, 'active',
          'an independent child does not wait for its parent workflow to finish');
      }
    } finally {
      await finish(factory);
      assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
      fs.rmSync(dir, {recursive: true, force: true});
    }
  }
});

test('unmanaged recovery rejects broken channel checkpoints and ambiguous item ownership without stopping storage', {timeout: 30000}, async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  const factory = new Factory();
  const settle = async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    await factory.runtime.settle();
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  try {
    await factory.boot();
    factory.broker.memoryFloorMB = 0;
    factory.runtime.executors = node => async ctx => {
      if (ctx.token.data.retryOf || ctx.token.item === 'unrelated') return {ok: true, summary: 'Fixture publication', finish: {status: 'published', reason: 'fixture'}};
      return node.key === 'components/describe' || node.key === 'curation/reader'
        ? {ok: false, summary: 'Fixture timeout', failure: {tag: 'network_timeout', category: 'network', message: 'Fixture timeout', retryable: true, owner: 'system'}}
        : {ok: true, summary: 'Fixture preparation'};
    };
    factory.runtime.start('Checkpoint validation is not a storage failure');
    const parent = factory.runtime.create('curation/published', {item: 'broken-child', url: 'https://child.example/', source: 'manual'});
    factory.journal.append({kind: 'channel.emitted', channel: 'curation.component-source.confirmed', token: parent.id, item: parent.item, inventory: 'consumer'});
    await settle();
    const failed = factory.channels!.status()[0].targetToken!;
    assert.ok(factory.state.tokens[failed].data.__runtimeRecovery);
    factory.journal.append({kind: 'token.data', token: failed, patch: {runtimeCheckpoint: null}});
    t.mock.timers.tick(60000);
    factory.recovery.pump();
    await settle();
    assert.equal((factory.state.tokens[failed].data.__runtimeRecovery as {state: string}).state, 'blocked');
    assert.equal(factory.state.tokens[failed].data.retriedBy, undefined);
    assert.equal(factory.runtime.running, true);
    assert.equal(factory.runtime.paused, false);
    const left = factory.runtime.create('curation/reader', {item: 'shared-item', url: 'https://left.example/', source: 'manual'});
    const right = factory.runtime.create('components/describe', {item: 'shared-item', url: 'https://right.example/', source: 'manual'});
    await settle();
    const owner = factory.state.recoveries['shared-item'].token;
    const other = owner === left.id ? right.id : left.id;
    t.mock.timers.tick(60000);
    factory.recovery.pump();
    await settle();
    assert.equal(factory.state.tokens[other].data.retriedBy, undefined, 'an item-key collision must never claim the other workflow');
    assert.equal((factory.state.tokens[other].data.__runtimeRecovery as {state: string}).state, 'blocked');
    const retried = Object.values(factory.state.tokens).filter(token => token.data.retryOf);
    assert.equal(retried.length, 1);
    assert.equal(retried[0].data.retryOf, owner);
    const independent = factory.runtime.create('curation/reader', {item: 'unrelated', url: 'https://healthy.example/', source: 'manual'});
    await settle();
    assert.equal(factory.state.tokens[independent.id].status, 'published');
  } finally {
    factory.recovery.close();
    await factory.sources.close();
    factory.channels?.close();
    await factory.runtime.close();
    factory.docs.flush();
    factory.lessons.close();
    factory.journal.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('native workflow and channel recovery belong to their tokens rather than an unrelated website batch', {timeout: 30000}, async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  for (const origin of ['manual', 'channel', 'source'] as const) {
    for (const mode of ['running', 'stopped', 'paused'] as const) await t.test(`${origin} with ${mode} website batch`, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-native-recovery-'));
      const schema = {type: 'object', properties: {text: {type: 'string'}}, required: ['text'], additionalProperties: false};
      const role = '# Native fixture role\nPreserve the provided text and original preparation. A transient local fixture error must resume only the failed stage; never repeat completed upstream work.';
      const bindings: WorkflowManifest['bindings'] = {};
      for (const id of ['prepare', 'work']) bindings[`native-fixture/${id}`] = {
        role: 'roles/worker/ROLE.md', inputSchema: 'text', outputSchema: 'text',
        input: {text: {path: id === 'prepare' ? 'input.text' : 'prepared.text'}},
        outputKey: id === 'prepare' ? 'prepared' : 'result',
        execute: {kind: 'node', module: 'tools/worker.mjs', export: id},
      };
      const manifest: WorkflowManifest = {
        format: 1, id: 'native-fixture', name: 'Native recovery fixture', version: '1', blurb: 'No network or model',
        entry: 'native-fixture/prepare', inputSchema: 'text', schemas: {text: schema}, bindings,
        resources: {model: 1, browser: 1, cpu: 2, http: 1}, links: [], conditions: {},
        lines: [line({id: 'native-fixture', name: 'Native fixture', layer: 3, priority: 'mid', wired: true,
          blurb: 'Native module checkpoint fixture', stations: [
            ...['prepare', 'work'].map(id => station({id, name: id, kind: 'program', role: 'process', resource: 'cpu',
              input: 'text', output: 'text', accept: ['Return the unchanged fixture text'],
              workers: {min: 1, max: 1, initial: 1, policy: 'fixed'}})),
            station({id: 'published', name: 'Done', kind: 'store', role: 'store'}),
          ], edges: [['prepare', 'work'], ['work', 'published']]})],
        channels: origin === 'channel' ? [{id: 'fixture.native', from: {line: 'curation', station: 'published'},
          to: {line: 'native-fixture', station: 'prepare'}, label: 'Independent native child'}] : [],
      };
      const request = {manifest, builtins: ['vislexicon'], files: {
        'roles/worker/ROLE.md': role,
        'tools/worker.mjs': `const calls = new Map();
export function prepare(input) { return input; }
export async function work(input, context) {
  const count = (calls.get(context.item) ?? 0) + 1;
  calls.set(context.item, count);
  const failure = input.text === 'auth' ? {tag:'auth_required',category:'auth',owner:'user',retryable:true,message:'loginWall fixture'}
    : input.text === 'uncertain' ? {tag:'tool_error',category:'system',owner:'user',retryable:false,code:'EXTERNAL_OPERATION_UNKNOWN',message:'External write outcome unknown'} : null;
  if (failure) throw Object.assign(new Error(failure.message), {failure});
  if (input.text === 'cancel') await new Promise((_, reject) => {
    context.signal.addEventListener('abort', () => reject(context.signal.reason), {once:true});
  });
  if (count === 1 || input.text === 'exhausted') throw Object.assign(new Error('Controlled native timeout'), {code: 'ETIMEDOUT'});
  return input;
}
`,
      }};
      const factory = new Factory(directory);
      const settle = async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
        await factory.runtime.settle();
        await new Promise<void>(resolve => setImmediate(resolve));
      };
      const attemptsAt = (node: string) => Object.values(factory.state.attempts).filter(attempt => attempt.node === node).length;
      const latest = () => Object.values(factory.state.tokens).findLast(token => token.line === 'native-fixture' && !token.data.retriedBy)!;
      try {
        await installWorkflowPack(directory, request, {running: false}, [pack]);
        await factory.boot();
        factory.broker.memoryFloorMB = 0;
        factory.catalog = [];
        const originalExecutor = factory.runtime.executors;
        factory.runtime.executors = node => node.key === 'curation/reader' ? async () => ({ok: false,
          summary: 'Website checkpoint waits for its own batch', failure: {
            tag: 'network_timeout', category: 'network', owner: 'system', retryable: true, message: 'Website fixture timeout',
          }}) : originalExecutor(node);
        if (origin === 'source') {
          await factory.sources.close();
          factory.sources = new SourceSupervisor(factory);
          factory.sources.configure({id: 'native-source', name: 'Native source', url: 'https://never-polled.example/items',
            format: 'json', platform: 'fixture', target: manifest.entry, intervalMs: 86400000,
            enabled: true, constants: {text: 'retained native input'}});
        }
        factory.runtime.start('Native recovery with website batch');
        factory.batch.configure({target: 1, maxInFlight: 1, intakeWindow: 1});
        if (mode === 'stopped') factory.batch.setMode('stopped');
        const item = `native-${origin}`;
        if (origin === 'channel') {
          const parent = factory.runtime.create('curation/published', {item, url: '', source: 'manual', data: {input: {text: 'retained native input'}}});
          factory.journal.append({kind: 'channel.emitted', channel: 'fixture.native', token: parent.id, item, inventory: 'consumer'});
        } else {
          factory.runtime.create(manifest.entry, {item, url: '', source: origin === 'source' ? 'source:native-source' : 'manual',
            data: {workflowPack: manifest.id, input: {text: 'retained native input'},
              ...(origin === 'source' ? {sourceCandidate: item, sourceRecord: {source: 'native-source'}} : {})}});
        }
        await settle();
        assert.equal(attemptsAt('native-fixture/work'), 1);
        assert.equal(latest().status, 'parked');
        const plan = latest().data.__runtimeRecovery as {state: string; nextAt: number};
        assert.equal(plan?.state, 'waiting', 'an unrelated website goal cannot suppress this native checkpoint plan');
        if (mode === 'paused') factory.batch.setMode('paused');
        factory.runtime.pause();
        t.mock.timers.tick(60000);
        factory.recovery.pump();
        await settle();
        assert.equal(attemptsAt('native-fixture/work'), 1, 'global pause always wins');
        factory.runtime.setScopePaused({scope: 'station', key: 'native-fixture/work', paused: true, reason: 'Inspect native retry'});
        factory.runtime.resume();
        factory.recovery.pump();
        await settle();
        assert.equal(attemptsAt('native-fixture/work'), 1, 'the failed station pause always wins');
        if (origin === 'source') factory.sources.setEnabled('native-source', false);
        factory.runtime.setScopePaused({scope: 'station', key: 'native-fixture/work', paused: false, reason: 'Native retry ready'});
        factory.recovery.pump();
        await settle();
        if (origin === 'source') {
          assert.equal(attemptsAt('native-fixture/work'), 1, 'a disabled source cannot resume its failed candidate');
          factory.sources.setEnabled('native-source', true);
          factory.recovery.pump();
          await settle();
        }
        assert.equal(attemptsAt('native-fixture/work'), 2);
        assert.equal(attemptsAt('native-fixture/prepare'), 1, 'completed native preparation is not executed again');
        assert.equal(latest().status, 'published');
        assert.deepEqual(latest().data.result, {text: 'retained native input'});
        assert.equal((latest().data.__runtimeRecovery as {state: string}).state, 'completed');
        if (origin === 'channel') assert.equal(factory.channels!.status().find(delivery => delivery.channel === 'fixture.native')?.status, 'acknowledged');
        if (mode !== 'running') {
          const website = factory.runtime.create('curation/reader', {item: 'stopped-website', url: '', source: 'candidates/pool'});
          await settle();
          t.mock.timers.tick(60000);
          factory.batch.pump();
          factory.recovery.pump();
          await settle();
          assert.equal(factory.state.tokens[website.id].status, 'parked');
          assert.equal(attemptsAt('curation/reader'), 1, 'the paused or stopped website goal still owns and holds its own retry');
        }
        if (origin === 'manual' && mode === 'stopped') {
          const attemptsFor = (item: string, node = 'native-fixture/work') => Object.values(factory.state.attempts)
            .filter(attempt => attempt.node === node && factory.state.tokens[attempt.token]?.item === item).length;
          for (const boundary of ['auth', 'uncertain', 'exhausted', 'cancel'] as const) {
            const item = `boundary-${boundary}`;
            const token = factory.runtime.create(manifest.entry, {item, url: '', source: 'manual',
              data: {workflowPack: manifest.id, input: {text: boundary}}});
            if (boundary === 'cancel') {
              for (let i = 0; i < 100 && !attemptsFor(item); i++) await new Promise<void>(resolve => setImmediate(resolve));
              assert.equal(attemptsFor(item), 1);
              factory.runtime.end();
              await settle();
              factory.runtime.start('A new run cannot revive a cancelled native attempt');
            } else await settle();
            for (let i = 0; i < 4; i++) {
              t.mock.timers.tick(60000);
              factory.recovery.pump();
              await settle();
            }
            const current = Object.values(factory.state.tokens).findLast(value => value.item === item && !value.data.retriedBy)!;
            assert.equal(attemptsFor(item), boundary === 'exhausted' ? 3 : 1,
              'auth, unknown effects and cancellation are never automatic retries; transient retries stop at two');
            assert.equal(attemptsFor(item, 'native-fixture/prepare'), 1);
            if (boundary === 'exhausted') assert.equal((current.data.__runtimeRecovery as {state: string}).state, 'exhausted');
            if (boundary === 'uncertain') {
              assert.equal(factory.state.tokens[token.id].status, 'manual');
              assert.equal(factory.state.recoveries[item], undefined);
            }
          }
        }
      } finally {
        factory.recovery?.close();
        await factory.sources?.close();
        factory.channels?.close();
        await factory.runtime?.close();
        factory.docs?.flush();
        factory.lessons?.close();
        factory.journal.close();
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        fs.rmSync(directory, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
      }
    });
  }
});
