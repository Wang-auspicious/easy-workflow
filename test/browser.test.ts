import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";

test("independent service shares a persistent browser, retains auth failures and cancels leases",{timeout:45000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"h2-browser-test-"));
  const old=process.env.FACTORY_VAR;process.env.FACTORY_VAR=dir;
  let reloadAllowed = false;
  const server=http.createServer((req,res)=>{
    res.setHeader("content-type","text/html");
    if(req.url==="/blocked"||(req.url==="/reload-target"&&!reloadAllowed)){res.statusCode=403;res.end("<!doctype html><title>Attention Required! | Cloudflare</title><h1>Sorry, you have been blocked</h1><p>You are unable to access fixture.test</p>");return;}
    if(req.url==="/status-only"){res.statusCode=403;res.end("<!doctype html><title>Service response</title><p>This request was not accepted.</p>");return;}
    if(req.url==="/challenge"){res.end("<!doctype html><title>Just a moment...</title><p>Checking your browser before accessing the site.</p>");return;}
    res.end("<!doctype html><title>Shared browser fixture</title><p>Browser fixture</p>");
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const {openPage,browserCommand,browserAttention,closeBrowser}=await import("../server/browser.ts");
  try{
    const abort=new AbortController(),a=await openPage(undefined,undefined,abort.signal);
    await a.context.addCookies([{name:"shared-fixture",value:"present",url,expires:Date.now()/1000+3600}]);
    await a.page.goto(url);const b=await openPage();await b.page.goto(url);
    assert.match(await b.page.evaluate(()=>document.cookie),/shared-fixture=present/);
    assert.equal((await browserCommand({action:"state"})).tabs.length,2);
    await browserAttention(b.page,"登录需要检查");await b.close();
    const held=(await browserCommand({action:"state"})).tabs.find((t:{attention?:string})=>t.attention);assert.ok(held);
    await browserCommand({action:"close",id:held.id});
    const closed=a.page.waitForEvent("close");abort.abort();await closed;await a.close();
    assert.equal((await browserCommand({action:"state"})).tabs.length,0);
    await closeBrowser();
    const again=await openPage();await again.page.goto(url);assert.match(await again.page.evaluate(()=>document.cookie),/shared-fixture=present/);await again.close();
    await t.test("real HTTP 403 and blocked text survive automatic checks and preserve the tab",async()=>{
      const heldPage=await openPage();
      assert.equal((await heldPage.page.goto(`${url}/blocked`))?.status(),403);
      await browserAttention(heldPage.page,"HTTP 403，需要检查验证或访问限制");
      const id=(await browserCommand({action:"state"})).tabs.find((tab:{url:string})=>tab.url===`${url}/blocked`)!.id;
      await browserCommand({action:"attention.check",id});
      assert.match((await browserCommand({action:"state"})).tabs.find((tab:{id:string})=>tab.id===id)?.attention??"",/拒绝访问|验证|403|受限/);
      await heldPage.close();
      assert.ok((await browserCommand({action:"state"})).tabs.some((tab:{id:string})=>tab.id===id),"a denied page remains available for the user");
      await browserCommand({action:"navigate",id,url:`${url}/ready`});
      await browserCommand({action:"attention.check",id});
      assert.equal((await browserCommand({action:"state"})).tabs.find((tab:{id:string})=>tab.id===id)?.attention,undefined,"a successful navigation clears the old denial");
      await browserCommand({action:"close",id});
    });
    await t.test("status-only denial and verification pages remain marked until successful reload",async()=>{
      const page=await openPage();
      for(const route of ["status-only","challenge","reload-target"]){
        await page.page.goto(`${url}/${route}`);
        const id=(await browserCommand({action:"state"})).tabs.find((tab:{url:string})=>tab.url===`${url}/${route}`)!.id;
        await browserCommand({action:"attention.check",id});
        assert.ok((await browserCommand({action:"state"})).tabs.find((tab:{id:string})=>tab.id===id)?.attention,route);
      }
      reloadAllowed=true;
      const id=(await browserCommand({action:"state"})).tabs.find((tab:{url:string})=>tab.url===`${url}/reload-target`)!.id;
      await browserCommand({action:"reload",id});await browserCommand({action:"attention.check",id});
      assert.equal((await browserCommand({action:"state"})).tabs.find((tab:{id:string})=>tab.id===id)?.attention,undefined);
      await page.close();
    });
    await t.test("desktop checks the same real blocked and recovered DOM without clearing denial",async()=>{
      const {BrowserManager,noteBrowserResponse}=createRequire(import.meta.url)("../app/browser-manager.cjs");
      const page=await openPage();
      const tab={id:"desktop-fixture",view:{webContents:{isDestroyed:()=>false,getURL:()=>page.page.url(),isLoading:()=>false,executeJavaScript:(source:string)=>page.page.evaluate(source)}},attention:"HTTP 403"};
      const manager=Object.create(BrowserManager.prototype);manager.tabs=new Map([[tab.id,tab]]);manager.publish=()=>{};
      const navigate=async(route:string)=>{const response=await page.page.goto(`${url}/${route}`);noteBrowserResponse(tab,{url:page.page.url(),status:response!.status(),mainFrame:true,resourceType:"mainFrame"});await manager.check(tab);};
      await navigate("blocked");
      assert.match(tab.attention??"",/拒绝访问|验证|403|受限/);
      await navigate("status-only");
      assert.match(tab.attention??"",/403/,"a clean-looking 403 cannot clear the HTTP denial");
      const execute=tab.view.webContents.executeJavaScript;
      tab.view.webContents.executeJavaScript=async()=>{throw new Error("fixture navigation destroyed the execution context");};
      await manager.check(tab);assert.match(tab.attention??"",/403/,"a failed probe cannot clear an existing denial");
      tab.view.webContents.executeJavaScript=execute;
      await navigate("challenge");
      assert.match(tab.attention??"",/验证/);
      await navigate("ready");
      assert.equal(tab.attention,undefined);
      await page.close();
    });
  }finally{
    await closeBrowser();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(old===undefined)delete process.env.FACTORY_VAR;else process.env.FACTORY_VAR=old;
    assert.ok(path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()),"h2-browser-test-")));fs.rmSync(dir,{recursive:true,force:true});
  }
});
