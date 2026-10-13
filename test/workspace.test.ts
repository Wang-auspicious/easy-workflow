import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { initialState, apply } from "../shared/project.ts";
import { legacyReply, transcriptMessage } from "../shared/conversation.ts";
import type { JournalEvent, Stamped } from "../shared/types.ts";
import { compile } from "../server/spec/compile.ts";
import { pack } from "../packs/vislexicon/pack.ts";
import { Journal } from "../server/journal.ts";
import { Runtime } from "../server/runtime.ts";
import { Broker } from "../server/broker.ts";
import { buildReport } from "../server/report.ts";
import type { Factory } from "../server/factory.ts";
import { inspectPart } from "../shared/parts.ts";

test("Pi transcript preserves ordered tool pairs; scheduling notes never become conversation",()=>{
  const s=initialState();let seq=0;
  const emit=(e:JournalEvent)=>apply(s,{...e,seq:++seq,at:100+seq,run:""} as Stamped);
  emit({kind:"chat.user",id:"turn",text:"看状态",attachments:[]});
  emit({kind:"dispatch.note",text:"撤下闲置工人",tone:"fork"});
  const assistant=legacyReply("先查看。",101);assistant.content.push({type:"toolCall",id:"call-1",name:"h2_call",arguments:{name:"status",arguments:{}}});
  emit({kind:"chat.message",id:"pi-1",turn:"turn",message:assistant});
  emit({kind:"chat.message",id:"tool-1",turn:"turn",message:{role:"toolResult",toolName:"h2_call",toolCallId:"call-1",isError:false,timestamp:102,content:[{type:"text",text:"idle"}]}});
  emit({kind:"chat.message",id:"pi-2",turn:"turn",message:legacyReply("空闲",103)});
  emit({kind:"chat.assistant",id:"turn-r",text:"空闲",tools:[]});
  assert.deepEqual(s.conversation.map(e=>e.message.role),["user","assistant","toolResult","assistant"]);
  assert.equal(s.chat.length,2);assert.equal(s.activity.length,1);
  const image={role:"user" as const,timestamp:1,content:[{type:"image" as const,data:"private-binary",mimeType:"image/png"}]};
  assert.ok(!JSON.stringify(transcriptMessage(image)).includes("private-binary"));assert.equal(image.content[0].data,"private-binary");
});

test("worker idle time starts at run start and resumes after pauses",async()=>{
  const f=compile([pack]),j=new Journal(":memory:"),r=new Runtime(f,j,new Broker(f.resources,0),{},()=>null);
  try{
    r.ensureWorkers([]);const count=()=>[...r.workers.values()].reduce((n,p)=>n+p.length,0),initial=count();
    for(const p of r.workers.values())for(const w of p)w.idleSince=Date.now()-800000;
    r.start("empty");r.balance();assert.equal(count(),initial);
    r.pause();for(const p of r.workers.values())for(const w of p)w.idleSince=Date.now()-800000;
    r.resume();r.balance();assert.equal(count(),initial);
    assert.equal([...j.read()].filter(e=>e.kind==="worker.retired").length,0);
  }finally{await r.close();j.close();}
});

test("historical reports isolate runs and deduct an unfinished pause",()=>{
  const compiled=compile([pack]),events:Stamped[]=[];let run="";
  const add=(at:number,e:JournalEvent)=>{if(e.kind==="run.started")run=e.runId;events.push({...e,seq:events.length+1,at,run} as Stamped);};
  add(1000,{kind:"run.started",runId:"run-first",title:"First"});
  add(1100,{kind:"token.created",token:"t1",line:"curation",item:"one",url:"https://example.test",source:"sources/watch"});
  add(1110,{kind:"attempt.started",attempt:"a1",token:"t1",node:"curation/classify",worker:"w1",input:"one"});
  add(1200,{kind:"attempt.finished",attempt:"a1",ok:true,summary:"done",ms:90,queuedMs:10,usage:{input:5,output:2,cost:.01}});
  add(1250,{kind:"token.finished",token:"t1",node:"curation/published",status:"published",reason:"done"});
  add(1300,{kind:"run.paused",runId:"run-first"});
  add(2000,{kind:"run.ended",runId:"run-first",manual:true});
  add(3000,{kind:"run.started",runId:"run-second",title:"Second"});
  add(3100,{kind:"token.created",token:"t2",line:"curation",item:"two",url:"https://example.test/2",source:"sources/watch"});
  const state=initialState(compiled);for(const e of events)apply(state,e);
  const f={compiled,state,journal:{seq:events.length,lastSequence:(id:string,through=events.length)=>events.findLast(e=>e.run===id&&e.seq<=through)?.seq??0,read:(since=0,id?:string,through=events.length)=>events.filter(e=>e.seq>since&&e.seq<=through&&(!id||e.run===id))}} as unknown as Factory;
  const report=buildReport(f,"run-first");
  assert.equal(report.netMs,300);assert.equal(report.status,"ended");assert.equal(report.totals.created,1);assert.equal(report.totals.published,1);assert.deepEqual(report.totals.usage,{input:5,output:2,cost:.01});assert.equal(report.attempts[0].item,"one");
  assert.equal(state.run.id,"run-second");
});

test("part metrics count a branched task once, across multiple active stations",()=>{
  const f=compile([pack]),s=initialState(f);let seq=0;const emit=(e:JournalEvent)=>apply(s,{...e,seq:++seq,at:100+seq,run:""} as Stamped);
  emit({kind:"token.created",token:"t",line:"curation",item:"one",url:"https://example.test",source:"sources/watch"});
  emit({kind:"attempt.started",attempt:"a",token:"t",node:"curation/style",worker:"w1",input:""});emit({kind:"attempt.started",attempt:"b",token:"t",node:"curation/facts",worker:"w2",input:""});
  const part=inspectPart(f,s,{id:"content",name:"内容",line:"curation",stations:["curation/style","curation/facts"]});assert.equal(part.totals.inFlight,1);assert.equal(part.totals.active,1);assert.equal(part.recent.length,2);
});

test("bookmarks retain drag order; history expiry does not erase recent visits",()=>{
  const {BrowserData}=createRequire(import.meta.url)("../app/browser-data.cjs");const dir=fs.mkdtempSync(path.join(os.tmpdir(),"h2-browser-data-"));
  try{const file=path.join(dir,"browser.json"),d=new BrowserData(file);d.history=[{url:"https://old.test",at:Date.now()-31*86400000}];d.visit("https://recent.test","Recent");d.change("bookmark.move",{id:"bilibili",before:"x"});d.change("bookmark.add",{url:"https://custom.test",title:"Custom"});const reload=new BrowserData(file);assert.equal(reload.bookmarks[0].id,"bilibili");assert.equal(reload.history.length,1);assert.equal(reload.history[0].title,"Recent");assert.throws(()=>reload.change("bookmark.add",{url:"javascript:alert(1)"}));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
