import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { classifyFailure, candidateFailure } from "../shared/failures.ts";
import type { StationContext } from "../server/runtime.ts";

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
      for(const [status,tag,retryable] of [[404,"http_not_found",false],[410,"http_not_found",false],[429,"http_rate_limit",true],[503,"http_server",true],[403,"auth_required",true]] as const){
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
      await factory.runtime.close();factory.journal.close();
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
      assert.equal(resumedAt,"curation/fetch","resume the failing station, not intake/classification");
      assert.ok(f.state.tokens[result.result.tokens[0].id].evidence.some(id=>f.state.evidence[id].meta?.reusedFrom==="before-retry"));
      assert.equal(f.state.recoveries.network.disposition,"resolved");
      assert.equal(f.state.recoveries.invalid.disposition,"removed");
      assert.equal(f.state.nodes["candidates/pool"].stock,1);
      await endRun(f);
    });
    await t.test("station failure parks immediately and preserves reason without blind repeated attempts",async()=>{
      const f=factory!;
      f.runtime.executors=()=>async()=>{throw new Error("fetch failed",{cause:Object.assign(new Error("connection reset"),{code:"ECONNRESET"})});};
      const tasks=f.retryCandidates({tag:"browser_capture",count:5});assert.equal(tasks.length,1);
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
      const patch=f.proposePatch({author:"user",summary:"test rename",ops:[{op:"set",station:"curation/fetch",field:"name",value:"首页抓取"}]});
      f.decidePatch(patch.patch.id,true);
      f.runtime.start("park after activation");f.runtime.pause();
      f.feed([`${base}/pending`]);await endRun(f);
      assert.equal(f.candidateFailures({tag:"run_ended",disposition:"retry"}).length,2);
      const expected=f.candidateFailures({disposition:"retry"}).length;
      await f.runtime.close();f.journal.close();factory=undefined;
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
      await f.runtime.close();f.journal.close();factory=undefined;
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
        if(n.key==="curation/fact-review"&&factReviews++===0)return {ok:true,summary:"fix facts",verdict:{verdict:"return",returnTo:"curation/facts",reason:"fixture missing quote"}};
        return {ok:true,summary:"fixture complete",data:n.key==="curation/gate"?{gate:"pass"}:undefined};
      };
      const token=f.runtime.create("curation/shot-review",{item:"branched-review",url:base,source:"manual"});
      for(let i=0;i<300&&f.state.tokens[token.id].status==="active";i++)await delay(10);
      assert.equal(f.state.tokens[token.id].status,"published");
      const styles=f.state.tokens[token.id].attempts.map(id=>f.state.attempts[id]).filter(a=>a.node==="curation/style");
      assert.equal(styles.length,1);assert.equal(styles[0].ok,true);
      assert.equal(factReviews,2);
      await endRun(f);
    });
    await t.test("completed items remain correctable after restarting an ended run",async()=>{
      let f=factory!;
      const previous=Object.values(f.state.tokens).find(t=>t.item==="branched-review")!;
      await f.runtime.close();f.journal.close();factory=undefined;
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
    if(factory){await factory.runtime.close();factory.journal.close();}
    fixture.closeAllConnections();await new Promise<void>(resolve=>fixture.close(()=>resolve()));
    await closeNetwork();fs.rmSync(dir,{recursive:true,force:true});
  }
});
