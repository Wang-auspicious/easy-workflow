import test, {after} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {compile} from '../server/spec/compile.ts';import {pack} from '../packs/vislexicon/pack.ts';import {readRole} from '../server/roles.ts';
import {EvidenceStore, runFfmpeg} from '../server/evidence.ts';import type {StationContext} from '../server/runtime.ts';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'h2-capture-recovery-'));
const previousProject=process.env.FACTORY_VAR;process.env.FACTORY_VAR=dir;
const {findStage,links,pageKey,shoot,checkImage,letterbox,locateCaptureTarget}=await import('../packs/vislexicon/capture.ts');
const {TOOLS}=await import('../packs/vislexicon/tools.ts');
const {facts,factReview,shotReview}=await import('../packs/vislexicon/agents.ts');
after(async()=>{
 const {closeBrowser}=await import('../server/browser.ts');const {closeNetwork}=await import('../server/network.ts');
 await closeBrowser();await closeNetwork();
 if(previousProject===undefined)delete process.env.FACTORY_VAR;else process.env.FACTORY_VAR=previousProject;
 assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('h2-capture-recovery-'));
 fs.rmSync(dir,{recursive:true,force:true});
});

test('image checks and letterboxing yield to HTTP while retaining pixel quality and cancellation', async () => {
  const png = await runFfmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x400:rate=1', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1']);
  const server = http.createServer((_request, response) => response.end('responsive'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  let finished = false;
  try {
    const response = fetch(url);
    const processing = (async () => {
      const padded = await letterbox(png, {width: 640, height: 400});
      const checked = await checkImage(padded, [], {stage: true});
      finished = true;
      return {padded, checked};
    })();
    assert.equal(await (await response).text(), 'responsive');
    assert.equal(finished, false, 'native image work cannot block an unrelated HTTP response');
    const {padded, checked} = await processing;
    assert.deepEqual([padded.readUInt32BE(16), padded.readUInt32BE(20)], [640, 400]);
    assert.deepEqual(checked.issues, []);
    assert.ok((await checkImage(padded, [checked.hash])).issues.includes('duplicate'));
    const controller = new AbortController();
    controller.abort(new Error('Fixture image cancellation'));
    await assert.rejects(checkImage(png, [], {signal: controller.signal}), /Fixture image cancellation/);
    await assert.rejects(letterbox(png, {width: 640, height: 400}, {signal: controller.signal}), /Fixture image cancellation/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
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

test('reframing locates visible labels inside mixed-language review instructions', async () => {
  const {openPage, closeBrowser} = await import('../server/browser.ts');
  const {page, close} = await openPage();
  try {
    await page.setContent('<main><h1>Product catalogue</h1><div style="height:1800px"></div><section><h2>This sections hues</h2><p>Click to copy</p><p>Elements</p></section><div style="height:1200px"></div><section><h2>OUR WORK</h2><p>Illustrations</p></section></main>');
    const happyHues = await locateCaptureTarget(page, [
      '同一问题第二次出现：proof仍只拍到单个插图特写。上次/palettes/17只裁到单个插图，看不到拍摄单要求的Elements组Background #fef6e4、Button #f582ae等与Illustration组两列HEX列表及其下方真实网页按钮、卡片与插图渲染；这次/palettes/16同样只拍到粉色浏览器插图+太阳笑脸，没有色值条块和按钮卡片。请在同一页/palettes/16往上重新取景，居中同框拍到This sections hues/Click to copy的Elements与Illustration两组HEX列表及其紧贴下方的真实按钮、卡片与SVG插图，不要只裁插图特写。',
      '页面顶部 Toggle palettes / Try changing the palette! hero示例区正下方约764px处第一个 This sections hues / Click to copy 色块条区（标题Curated colors in context下，非代码块非iframe）：Elements组 Background #fef6e4、Headline #001858、Button #f582ae等与Illustration组 Main #f3d2c1、Secondary #8bd3dd等两列HEX列表，及其紧贴下方的真实网页按钮、卡片与SVG插图渲染同框居中取景，不要只裁单个插图',
    ]);
    assert.equal(happyHues.matched, 'This sections hues');
    assert.ok(happyHues.scrollY! > 1000, 'the real requested section must enter the viewport');
    assert.ok(happyHues.anchors.every(anchor => !/[。；]|上次|重新取景/.test(anchor)));

    const manyPixels = await locateCaptureTarget(page, [
      'proof页对但取景偏了：当前https://www.manypixels.co/our-work/illustrations只拍到页头和Illustrations筛选条，未按拍摄单点开灯箱。请同一页点击OUR WORK网格区任一插画缩略图，待灯箱大图弹出后居中重拍灯箱内的单个作品大图，不要只拍列表顶边。',
      '页面 OUR WORK 网格区任一插画缩略图，点击 open lightbox 后弹出的灯箱大图即单个作品渲染，位于网格之上、无代码块、无 iframe；非免费图库单素材独立页，特此注明把握不足。',
    ]);
    assert.equal(manyPixels.matched, 'OUR WORK');
    assert.ok(!manyPixels.anchors.some(anchor => anchor.includes('https:')));
    const missing = await locateCaptureTarget(page, ['请滚动到「Missing demo」并重新取景。']);
    assert.equal(missing.matched, undefined, 'a missing requested section cannot silently use the current viewport');
  } finally {
    await close();
    await closeBrowser();
  }
});

test('external site entries retain native three-shot capture state through WebP processing', {timeout: 60000}, async () => {
  const {openPage, closeBrowser} = await import('../server/browser.ts');
  const fixture = http.createServer((_request, response) => response.end('<!doctype html><style>body{margin:0;background:#cee;color:#123;font:18px sans-serif}main{padding:24px}.space{height:1300px}.demo{width:500px;background:#fca;padding:20px}svg{display:block}</style><main><h1>Native example source</h1><p>Original page introduction</p><svg width="900" height="400"><rect width="440" height="380" fill="#3264d8"/><circle cx="670" cy="200" r="180" fill="#e94f73"/></svg><div class="space"></div><section class="demo"><h2>Actual demo</h2><svg width="460" height="250"><rect width="210" height="220" fill="#3264d8"/><circle cx="330" cy="125" r="100" fill="#e94f73"/></svg><input aria-label="Visible colour" value="#3264d8"><input type="password" value="never-copy-this"><input type="hidden" value="also-private"><div id="nested" style="height:60px;overflow:auto"><div style="height:250px">Nested scroll region</div></div></section><div style="height:700px"></div></main>'));
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(fixture.address() as {port: number}).port}`;
  const externalResearch = {intakeId: 'vislexicon-20261014', entryId: 'native-example'};
  const context = {token: {id: 'native-entry', item: 'native-example', url: base, data: {
    kind: 'work', mode: 'video', canonical: base, host: '127.0.0.1', externalResearch,
    readerPlan: {proof: {url: base + '/demo', locate: '请滚动到「Actual demo」后取景。'}}, shots: {},
  }}, attempt: 'a-native', signal: new AbortController().signal, progress() {}, addEvidence: (value: unknown) => value} as unknown as StationContext;
  const svc = {store: new EvidenceStore(path.join(dir, 'native-evidence')), workDir: path.join(dir, 'native-work'),
    publishDir: path.join(dir, 'native-published'), inFlight: () => new Set<string>()};
  try {
    assert.equal((await TOOLS['curation.plan'](context, svc)).data?.mode, 'shots');
    const identity = await TOOLS['curation.identity'](context, svc);
    assert.equal(identity.ok, true, JSON.stringify(identity));
    assert.equal(identity.data?.mode, 'shots', 'resumed video mode must not override the site-entry contract');
    Object.assign(context.token.data, identity.data, {kind: 'component-source', shots: {}});
    const result = await TOOLS['curation.proof'](context, svc);
    assert.equal(result.ok, true, result.error ?? result.summary);
    const shot = (result.data?.shots as Record<string, any>).proof;
    const png = fs.readFileSync(shot.file);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1280, 800]);
    assert.equal(shot.captureState.method, 'browser-native');
    assert.equal(shot.captureState.sourceUrl, base + '/demo');
    assert.equal(shot.captureState.finalUrl, base + '/demo');
    assert.deepEqual(shot.captureState.viewport, {width: 1280, height: 800});
    assert.equal(shot.captureState.clip, null);
    assert.ok(shot.captureState.scroll.y > 1000);
    assert.ok(shot.captureState.text.includes('Actual demo'));
    assert.ok(shot.captureState.controls.some((control: any) => control.value === '#3264d8'));
    assert.ok(!JSON.stringify(shot.captureState).includes('never-copy-this'));
    assert.ok(!JSON.stringify(shot.captureState).includes('also-private'));
    assert.ok(!Number.isNaN(Date.parse(shot.capturedAt)));
    Object.assign(context.token.data, result.data, {mode: 'shots'});
    const processed = await TOOLS['curation.process'](context, svc);
    assert.equal(processed.ok, true);
    const image = (processed.data?.images as any[])[0];
    assert.equal(image.captureState.sha256, image.sha256);
    assert.equal(image.captureState.finalWebPSha256, image.sha256);
    assert.equal(image.captureState.sourceUrl, base + '/demo');
    assert.equal(image.capturedAt, shot.capturedAt);
    const originalIdentity = (identity.data?.shots as Record<string, any>).identity;
    Object.assign(context.token.data, {shots: {identity: originalIdentity},
      readerPlan: {proof: {url: base + '/', locate: '请滚动到「Actual demo」后取景。'}}});
    const samePage = await TOOLS['curation.proof'](context, svc);
    assert.equal(samePage.ok, true, 'a located lower section of the entry page must not be excluded as an already used URL');
    const samePageShot = (samePage.data?.shots as Record<string, any>).proof;
    assert.ok(samePageShot.captureState.scroll.y > 1000);
    assert.notEqual(samePageShot.hash, originalIdentity.hash);
    assert.equal((samePage.data?.shots as Record<string, any>).identity, originalIdentity);
    Object.assign(context.token.data, {shots: {identity: originalIdentity},
      readerPlan: {proof: {url: base + '/obsolete', locate: 'Missing old section'}},
      shotRepairs: {proof: {action: 'reframe', url: base + '/old-frame', reason: 'Old review instruction'}}});
    const corrected = await TOOLS['curation.proof']({...context, redo: {byHuman: true,
      reason: 'Repair the exact entry instance while retaining other roles.',
      note: JSON.stringify({captureTarget: {role: 'proof', url: base + '/requested', locate: '「Actual demo」'}}),
    }}, svc);
    assert.equal(corrected.ok, true, corrected.error ?? corrected.summary);
    assert.equal((corrected.data?.shots as Record<string, any>).proof.href, base + '/requested');
    assert.equal((corrected.data?.shots as Record<string, any>).proof.location.matched, 'Actual demo');
    const sameFrame = await TOOLS['curation.proof']({...context, redo: {byHuman: true,
      reason: 'Check that a different role cannot reuse the identity frame.',
      note: JSON.stringify({captureTarget: {role: 'proof', url: base + '/', locate: '「Native example source」'}}),
    }}, svc);
    assert.equal(sameFrame.ok, false, 'same URL permission must retain pixel duplicate rejection');
    await assert.rejects(TOOLS['curation.proof']({...context, redo: {byHuman: true,
      reason: 'Invalid explicit capture target.',
      note: JSON.stringify({captureTarget: {role: 'proof', url: 'https://outside.invalid/', locate: '「Actual demo」'}}),
    }}, svc), /同站/);
    const {page, close} = await openPage();
    try {
      await page.goto(base + '/controls');
      await page.evaluate(() => {const nested = document.querySelector('#nested')!; nested.scrollTop = 55; nested.scrollIntoView();});
      const {sampleBrowserCapture} = await import('../packs/vislexicon/capture.ts');
      const state = await sampleBrowserCapture(page);
      assert.ok(state.scroll.containers.some(container => container.y === 55));
    } finally {await close();}
  } finally {
    await closeBrowser();
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
});

test('owner proof targets survive checkpoint restore and automatic rework without sibling fallback', {timeout: 60000}, async () => {
  const requests: string[] = [];
  let showEntryTarget = true;
  const fixture = http.createServer((request, response) => {
    requests.push(request.url ?? '/');
    const heading = request.url === '/sibling' ? 'Sibling demo' : showEntryTarget ? 'Download Decoy Font' : 'Entry changed';
    response.end(`<!doctype html><style>body{margin:0;background:#cee;color:#123;font:18px sans-serif}main{padding:24px}</style><main><h1>Entry fixture</h1><div style="height:1300px"></div><section><h2>${heading}</h2><svg width="900" height="400"><rect width="440" height="380" fill="#3264d8"/><circle cx="670" cy="200" r="180" fill="#e94f73"/></svg><p>Original rendered font specimen</p></section><div style="height:700px"></div></main>`);
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(fixture.address() as {port: number}).port}`;
  const context = {token: {id: 'pinned-owner-entry', item: 'decoy-fixture', url: base + '/entry', data: {
    kind: 'work', canonical: base + '/entry', host: '127.0.0.1',
    externalResearch: {intakeId: 'vislexicon-20261014', entryId: 'decoy-fixture'},
    facts: {retained: 'Already verified facts'}, shots: {},
  }}, attempt: 'a-pinned-owner', signal: new AbortController().signal, progress() {},
  addEvidence: (value: unknown) => value} as unknown as StationContext;
  const svc = {store: new EvidenceStore(path.join(dir, 'owner-evidence')), workDir: path.join(dir, 'owner-work'),
    publishDir: path.join(dir, 'owner-published'), inFlight: () => new Set<string>()};
  try {
    const owner = await TOOLS['curation.proof']({...context, redo: {byHuman: true,
      reason: 'Use this entry specimen; preserve verified facts and the other roles.',
      note: JSON.stringify({captureTarget: {role: 'proof', url: base + '/entry', locate: '「Download Decoy Font」'}}),
    }}, svc);
    assert.equal(owner.ok, true, owner.error ?? owner.summary);
    const restored = {...context, token: {...context.token, data: JSON.parse(JSON.stringify({
      ...context.token.data, ...owner.data,
      readerPlan: {proof: {url: base + '/sibling', locate: '「Sibling demo」'}},
      shotRepairs: {proof: {action: 'replace-page', url: base + '/sibling', reason: 'A stale downstream repair'}},
      rejectedPages: [base + '/entry'],
    }))}, redo: {byHuman: false, reason: 'Breadth was repaired; refresh downstream proof.'}};
    requests.length = 0;
    const automatic = await TOOLS['curation.proof'](restored, svc);
    assert.equal(automatic.ok, true, automatic.error ?? automatic.summary);
    assert.equal((automatic.data?.shots as Record<string, any>).proof.href, base + '/entry',
      'a later automatic repair must keep the owner-validated entry target after JSON checkpoint restore');
    assert.ok(!requests.includes('/sibling'), 'a sibling entry must never be visited as fallback for the pinned role');
    assert.deepEqual(restored.token.data.facts, {retained: 'Already verified facts'});
    Object.assign(restored.token.data, automatic.data);
    const sameShot = (automatic.data?.shots as Record<string, any>).proof;
    restored.token.data.shots = {identity: sameShot};
    const duplicate = await TOOLS['curation.proof'](restored, svc);
    assert.equal(duplicate.ok, false, 'a durable target must still reject a pixel duplicate of another role');
    assert.deepEqual(duplicate.data?.needsPick, {proof: [base + '/entry']});
    restored.token.data.shots = {};
    showEntryTarget = false;
    const missing = await TOOLS['curation.proof'](restored, svc);
    assert.equal(missing.ok, false, 'a missing owner anchor must stop rather than fall back to a sibling');
    assert.equal(missing.failure?.tag, 'needs_selection');
    assert.deepEqual(missing.data?.needsPick, {proof: [base + '/entry']});
    assert.ok(!requests.includes('/sibling'));
  } finally {
    const {closeBrowser} = await import('../server/browser.ts');
    await closeBrowser();
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
});

test('external corrections locate a distant breadth section and open only a verified read-only preview', {timeout: 60000}, async () => {
  const requests: string[] = [];
  const messages: string[] = [];
  const fixture = http.createServer((request, response) => {
    requests.push(request.url ?? '/');
    if (request.url === '/art.svg') {
      response.setHeader('content-type', 'image/svg+xml');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#2545bf"/><circle cx="400" cy="250" r="190" fill="#f86893"/></svg>');
      return;
    }
    const image = `http://${request.headers.host}/art.svg`;
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><main><h1>Entry homepage</h1><div style="height:4000px"></div><section><h2>JETBRAINS MONO FONT FAMILY</h2><svg width="650" height="300"><rect width="300" height="280" fill="#3264d8"/><circle cx="490" cy="150" r="140" fill="#e94f73"/></svg><a href="#" class="w-lightbox" style="display:block;width:350px;height:90px;background:#fc9">Open original illustration<script type="application/json" class="w-json">${JSON.stringify({items: [{url: image, type: 'image'}]})}</script></a><a href="/download.ttf" download class="w-lightbox">Unsafe download<script type="application/json" class="w-json">${JSON.stringify({items: [{url: image, type: 'image'}]})}</script></a></section><div style="height:800px"></div></main><div class="w-lightbox-backdrop" style="display:none;position:fixed;inset:0;background:#050508;align-items:center;justify-content:center"><img class="w-lightbox-image" src="${image}"></div><script>document.querySelector('a.w-lightbox').addEventListener('click', event => {event.preventDefault();document.querySelector('.w-lightbox-backdrop').style.display='flex';});</script>`);
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(fixture.address() as {port: number}).port}`;
  const context = {token: {id: 'explicit-preview-entry', item: 'entry', url: base, data: {
    kind: 'assets', canonical: base, host: '127.0.0.1', externalResearch: {intakeId: 'vislexicon-20261014', entryId: 'entry'},
    shots: {}, readerPlan: {breadth: {url: base}, proof: {url: base + '/old', locate: 'Old missing target'}},
  }}, attempt: 'a-explicit-preview', signal: new AbortController().signal, progress(message: string) {messages.push(message);},
  addEvidence: (value: unknown) => value} as unknown as StationContext;
  const svc = {store: new EvidenceStore(path.join(dir, 'preview-evidence')), workDir: path.join(dir, 'preview-work'),
    publishDir: path.join(dir, 'preview-published'), inFlight: () => new Set<string>()};
  const correction = (role: string, interaction?: unknown) => ({...context, redo: {byHuman: true,
    reason: 'Use the exact entry section and retain other completed evidence.',
    note: JSON.stringify({captureTarget: {role, url: base, locate: '「JETBRAINS MONO FONT FAMILY」', interaction}})}});
  try {
    const breadth = await TOOLS['curation.breadth'](correction('breadth'), svc);
    assert.equal(breadth.ok, true, `${JSON.stringify(breadth)}\n${messages.join('\n')}`);
    assert.ok((breadth.data?.shots as Record<string, any>).breadth.captureState.scroll.y > 3500);
    const proof = await TOOLS['curation.proof'](correction('proof', {kind: 'open-preview', index: 0}), svc);
    assert.equal(proof.ok, true, `${JSON.stringify(proof)}\n${messages.join('\n')}`);
    const state = (proof.data?.shots as Record<string, any>).proof.captureState;
    assert.ok(state.actions.some((action: string) => action.includes('open-preview') && action.includes('/art.svg')));
    assert.equal(state.clip, null);
    await assert.rejects(TOOLS['curation.proof'](correction('proof', {kind: 'open-preview', index: 1}), svc), /下载|preview|预览/);
    assert.ok(!requests.includes('/download.ttf'), 'invalid preview links must be rejected before clicking');
    await assert.rejects(TOOLS['curation.proof'](correction('proof', {kind: 'script', script: 'alert(1)'}), svc), /取景目标/);
  } finally {
    const {closeBrowser} = await import('../server/browser.ts');
    await closeBrowser();
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
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
     const ctx={token:{data:{mode:'shots',shots:{identity:{file:original,href:page.url(),hash:'',evidence:'original-evidence'}}}},signal:new AbortController().signal,progress:()=>{}} as unknown as StationContext;
     const svc={store,workDir:work,publishDir:path.join(dir,'publish'),inFlight:()=>new Set<string>()};
     const first=await TOOLS['curation.process'](ctx,svc);assert.equal(first.ok,true);assert.ok(!fs.existsSync(original));
     Object.assign(ctx.token.data,first.data);const canonical=(ctx.token.data.shots as any).identity.file;assert.ok(fs.existsSync(canonical));
     const second=await TOOLS['curation.process'](ctx,svc);assert.equal(second.ok,true);assert.deepEqual(second.data?.images,first.data?.images);assert.ok(fs.existsSync(canonical));
     (ctx.token.data.shots as any).identity.file=original;
     assert.equal((await TOOLS['curation.process'](ctx,svc)).ok,true,'legacy deleted PNG references recover from the same evidence WebP');
   });
 }finally{await close();}}finally{await closeBrowser();fixture.closeAllConnections();await new Promise<void>(r=>fixture.close(()=>r()));}
});
