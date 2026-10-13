import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EvidenceStore } from "../server/evidence.ts";
import { TOOLS, buildV3 } from "../packs/vislexicon/tools.ts";
import { copy, copyReview, audit } from "../packs/vislexicon/agents.ts";
import { derivedFacets, validateV3, ALL_AXES, type Taxonomy } from "../packs/vislexicon/v3.ts";
import type { StationContext } from "../server/runtime.ts";

const tax: Taxonomy = { categories: [], subcategories: {}, axes: { access: ["free", "freemium", "paid", "open-source"].map(id => ({id,label:id,aliases:[]})), licenses: ["unknown", "MIT", "CC0-1.0"].map(id => ({id,label:id,aliases:[]})) }, facetsErrors: () => [], classificationErrors: () => [] };
const fact = (value: string, sourceUrl = "https://fixture.test", quote = "source text") => ({value,sourceUrl,quote,evidence:"读过来源",scope:""});

test("video artifacts survive process, copy, assembly and final reviewer as one real identity page", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-video-publication-"));
  try {
    const store = new EvidenceStore(path.join(root, "evidence"));
    const poster = store.put(execFileSync("ffmpeg", ["-v","error","-f","lavfi","-i","color=c=blue:s=320x180","-frames:v","1","-c:v","libwebp","-f","webp","pipe:1"]), "webp");
    const file = path.join(root, "clip.mp4");
    execFileSync("ffmpeg", ["-v","error","-f","lavfi","-i","color=c=blue:s=320x180:d=0.2","-c:v","libx264","-y",file]);
    const video = store.put(fs.readFileSync(file), "mp4");
    const d: Record<string, any> = {
      mode:"video",canonical:"https://fixture.test",home:{finalUrl:"https://fixture.test/showcase#work"},title:"Fixture",kind:"work",kindAgreed:true,
      video:{src:video.src,card:video.src,poster:poster.src,posterCard:poster.src,evidence:"recorded",issues:[]}, images:[],
      copy:{ name:"Fixture",takeawayZh:"浏览作品与设计细节",noteZh:"我们".padEnd(125,"看"),descriptionZh:"作品展示。",descriptionEn:"Work showcase.",rationale:{identity:"从首页作品开始浏览"},alt:{identity:"页面中蓝色的作品区域"},reasons:[{statement:"呈现原创作品",evidenceUrl:"https://fixture.test"}],reply:"" },
      facts:Object.fromEntries(["author","organization","repository","license","pricing"].map(f=>[f,fact("unknown")])),catalogV3:{primaryCategory:"single-site-showcase",subcategory:"portfolio",facets:Object.fromEntries(ALL_AXES.map(a=>[a,[]]))},
    };
    const ctx = {token:{id:"video-token",url:d.canonical,data:d},attempt:"process",progress:()=>{},addEvidence:(e:unknown)=>e} as unknown as StationContext;
    const svc={store,workDir:root,publishDir:path.join(root,"published"),inFlight:()=>new Set<string>()};
    const result=await TOOLS["curation.process"](ctx,svc);
    assert.equal(result.ok,true); assert.equal((result.data?.images as any[])?.length,1);
    Object.assign(d,result.data);
    assert.equal(d.images[0].href,d.home.finalUrl); assert.equal(d.images[0].sha256,poster.sha);
    const input=await copy(store).input(ctx);
    assert.equal(input.images?.length,1); assert.match(input.text,/录屏封面/);
    assert.deepEqual(copy(store).check!(d.copy,ctx),[]);
    const record=buildV3(d,ctx.token,store,tax);
    assert.deepEqual(validateV3(record,tax),[]);
    assert.equal(record.pages.length,1); assert.equal(record.pages[0].shot.width,320);
    assert.equal(record.pages[0].sourceUrl,d.home.finalUrl); assert.equal(record.preview.mode,"video");
    const review=await copyReview(store).input(ctx); assert.match(review.text,/pages\[0\]=identity/); assert.doesNotMatch(review.text,/pages\[1\]=breadth/);
    assert.equal((await audit(store).input(ctx)).images?.length,1);
    fs.writeFileSync(poster.file,"tampered");
    const broken=await TOOLS["curation.process"](ctx,svc);
    assert.equal(broken.ok,false); assert.match(broken.error??"",/摘要不匹配/);
    assert.equal(buildV3(d,ctx.token,store,tax).pages.length,0,"old approval cannot hide missing immutable media");
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test("a public repository and artwork CC0 never imply an open-source code license", async () => {
  const facts={pricing:fact("freemium"),repository:fact("https://github.com/example/repo"),sourceCode:fact("open"),license:{...fact("CC0-1.0"),scope:"仅生成图；不含源码"}};
  assert.deepEqual(derivedFacets(facts,tax).access,["freemium"]);
  assert.deepEqual(derivedFacets({...facts,repositoryLicense:fact("unknown")},tax).access,["freemium"]);
  assert.deepEqual(derivedFacets({...facts,repositoryLicense:fact("MIT","https://github.com/example/repo/blob/main/LICENSE")},tax).access,["freemium","open-source"]);
  const station=audit({resolve:()=>null} as unknown as EvidenceStore);
  const ctx={token:{data:{}},attempt:"review",addEvidence:(e:unknown)=>e} as unknown as StationContext;
  const result=await station.after!({verdict:"fix",reason:"",problems:[{field:"facets.access",problem:"公开可读不等于代码许可"}]},ctx,{rounds:1,issues:[]});
  assert.equal(result.verdict?.fixes?.[0].station,"curation/facts");
  assert.deepEqual(result.verdict?.fixes?.[0].fields,["facts.pricing","facts.sourceCode","facts.repositoryLicense"]);
  assert.match(result.verdict?.fixes?.[0].problem??"",/派生字段/);
});
