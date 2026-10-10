import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

test("independent service shares a persistent browser, retains auth failures and cancels leases",{timeout:30000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"h2-browser-test-"));
  const old=process.env.FACTORY_VAR;process.env.FACTORY_VAR=dir;
  const server=http.createServer((_req,res)=>{res.setHeader("content-type","text/html");res.end("<!doctype html><title>Shared browser fixture</title><p>Browser fixture</p>");});
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
  }finally{
    await closeBrowser();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(old===undefined)delete process.env.FACTORY_VAR;else process.env.FACTORY_VAR=old;
    assert.ok(path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()),"h2-browser-test-")));fs.rmSync(dir,{recursive:true,force:true});
  }
});
