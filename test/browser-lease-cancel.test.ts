import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import path from 'node:path';

test('cancelling a desktop lease returns immediately and releases its late native page', {timeout:10000}, async () => {
  const child=fork(path.resolve('test/fixtures/browser-late-lease.mjs'),[],{env:{...process.env,FACTORY_BROWSER_BRIDGE:'1'},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  let aborted=false,releases=0,stderr='';
  child.stderr!.on('data',data=>stderr+=data);
  child.on('message',(message:any)=>{
    if(message.type==='test:aborted'){aborted=true;}
    if(message.type!=='browser:request')return;
    if(message.args.action==='lease'){
      child.send({type:'test:cancel'});
      setTimeout(()=>child.send({type:'browser:reply',id:message.id,result:{id:'late-page',marker:'about:blank#late-page',endpoint:'http://127.0.0.1:1'}}),100);
    } else if(message.args.action==='release'){
      releases++;assert.equal(message.args.id,'late-page');assert.equal(message.args.discard,true);
      assert.equal(aborted,true,'owner cancellation must finish before a delayed native response');
      child.send({type:'browser:reply',id:message.id,result:{}});child.send({type:'test:cleaned'});
    }
  });
  try {
    const code=await new Promise(resolve=>{child.once('exit',resolve);child.once('error',error=>{stderr+=error.message;resolve(-1);});});
    assert.equal(code,0,stderr);assert.equal(releases,1);
  } finally {if(child.exitCode===null)child.kill();}
});
