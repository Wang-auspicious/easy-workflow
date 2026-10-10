// Opt-in real-site check. Isolated profile, no model work or catalogue changes.
import { _electron as electron, chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'h2-live-capture-'));
const out=path.join(root,'artifacts','failure-audit');fs.mkdirSync(out,{recursive:true});
const env={...process.env,FACTORY_PROFILE:profile,FACTORY_DESKTOP_TEST:'1',VISLEXICON_ROOT:path.join(profile,'no-catalogue')};
delete env.ELECTRON_RUN_AS_NODE;delete env.FACTORY_VIEW_VAR;
const app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[path.join(root,'dist','desktop')],env,timeout:45000});
let cdp;
try {
  const ui=await app.firstWindow();await ui.locator('.node').first().waitFor({timeout:30000});
  const urls=process.argv.slice(2).length?process.argv.slice(2):['https://valor-software.com/ngx-bootstrap','https://simeydotme.github.io/svelte-range-slider-pips/','https://virtuoso.dev'];
  const leases=[];for(const _url of urls)leases.push(await app.evaluate(()=>globalThis.__factoryBrowser({action:'lease'})));
  cdp=await chromium.connectOverCDP(leases[0].endpoint);
  const rows=await Promise.all(leases.map(async(lease,i)=>{
    try {
      let page;for(let n=0;n<40&&!page;n++){page=cdp.contexts().flatMap(c=>c.pages()).find(p=>p.url()===lease.marker);if(!page)await new Promise(r=>setTimeout(r,50));}
      assert.ok(page);await page.setViewportSize({width:1280,height:800});
      const response=await page.goto(urls[i],{waitUntil:'domcontentloaded',timeout:25000});
      assert.ok(response&&response.status()<400,`HTTP ${response?.status()}`);
      await page.waitForLoadState('networkidle',{timeout:7000}).catch(()=>{});
      const started=Date.now();
      await app.evaluate((_electron,id)=>globalThis.__factoryBrowser({action:"capture.begin",id}),lease.id);
      const png=await page.screenshot({path:path.join(out,`live-background-${i}.png`),timeout:8000});
      assert.ok(png.length>6000,'capture must contain a rendered page');
      const clip=await page.screenshot({clip:{x:40,y:40,width:600,height:400},fullPage:true,timeout:8000});assert.ok(clip.length>1000);
      const session=await page.context().newCDPSession(page);let frames=0;
      session.on('Page.screencastFrame',event=>{frames++;void session.send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{});});
      try {
        await session.send('Page.startScreencast',{format:'jpeg',quality:80,everyNthFrame:1});
        for(let n=0;n<15&&frames<2;n++){await page.mouse.wheel(0,120);await new Promise(r=>setTimeout(r,120));}
        assert.ok(frames>=2,'recording must produce real frames');
      }finally{await session.send('Page.stopScreencast').catch(()=>{});await session.detach();}
      const released=await app.evaluate((_electron,id)=>globalThis.__factoryBrowser({action:'capture.end',id}),lease.id);
      assert.equal(released.capturing,false);
      return {url:urls[i],title:await page.title(),status:response.status(),bytes:png.length,captureMs:Date.now()-started,frames,capturerReleased:true};
    }catch(error){return {url:urls[i],error:error.message};}
    finally{await app.evaluate((_electron,id)=>globalThis.__factoryBrowser({action:'release',id}),lease.id);}
  }));
  fs.writeFileSync(path.join(out,'live-capture.json'),JSON.stringify(rows,null,2));console.log(JSON.stringify(rows,null,2));
  assert.ok(rows.every(r=>!r.error),'some real sites still failed; see individual diagnoses');
}finally{await cdp?.close().catch(()=>{});await app.close();}
