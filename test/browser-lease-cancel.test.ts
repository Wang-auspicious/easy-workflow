import test from 'node:test';
import assert from 'node:assert/strict';
import {fork, spawn} from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

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

test('cancellation during CDP connection returns promptly and releases the native lease', { timeout: 10000 }, async () => {
  let discovery!: () => void, response: http.ServerResponse | undefined;
  const discovered = new Promise<void>(resolve => { discovery = resolve; });
  const server = http.createServer((_req, res) => { response = res; discovery(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const child = fork(path.resolve('test/fixtures/browser-cdp-cancel.mjs'), [], { env: { ...process.env, FACTORY_BROWSER_BRIDGE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let releases = 0, stderr = '', aborted!: () => void;
  const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  child.stderr!.on('data', value => { stderr += value; });
  child.on('message', (message: any) => {
    if (message.type === 'test:aborted') aborted();
    if (message.type !== 'browser:request') return;
    if (message.args.action === 'lease') child.send({ type: 'browser:reply', id: message.id, result: { id: 'connecting-page', marker: 'about:blank#connecting-page', endpoint } });
    else if (message.args.action === 'release') {
      releases++; assert.equal(message.args.id, 'connecting-page'); assert.equal(message.args.discard, true);
      child.send({ type: 'browser:reply', id: message.id, result: {} });
    }
  });
  try {
    await discovered; child.send({ type: 'test:cancel' });
    assert.equal(await Promise.race([cancelled.then(() => true), delay(300, false)]), true);
    assert.equal(releases, 1);
    response?.writeHead(503); response?.end('fixture connection stopped');
    assert.equal(await exited, 0, stderr);
  } finally {
    if (child.exitCode === null) { child.kill(); await exited; }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('concurrent desktop leases share the pending lazy CDP connection and both release on cancellation', {timeout: 15000}, async () => {
  let resolveDiscovery!: () => void;
  const discovered = new Promise<void>(resolve => { resolveDiscovery = resolve; });
  const responses: http.ServerResponse[] = [];
  const server = http.createServer((_request, response) => {
    responses.push(response);
    resolveDiscovery();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const source = `
    import {openPage, closeBrowser} from ${JSON.stringify(new URL('../server/browser.ts', import.meta.url).href)};
    const controller = new AbortController();
    process.on('message', message => {
      if (message?.type === 'test:cancel') controller.abort(new Error('cancelled shared CDP'));
    });
    const results = await Promise.allSettled([
      openPage(undefined, undefined, controller.signal),
      openPage(undefined, undefined, controller.signal),
    ]);
    if (results.some(result => result.status !== 'rejected' || result.reason.message !== 'cancelled shared CDP')) {
      throw new Error('Both pending leases must be cancelled');
    }
    process.send({type: 'test:aborted'});
    await closeBrowser();
    process.exit(0);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: {...process.env, FACTORY_BROWSER_BRIDGE: '1'}, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  let leases = 0;
  const releases = new Set<string>();
  let resolveCancelled!: () => void;
  const cancelled = new Promise<void>(resolve => { resolveCancelled = resolve; });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  child.stderr!.on('data', value => { stderr += value; });
  child.on('message', (message: any) => {
    if (message.type === 'test:aborted') resolveCancelled();
    if (message.type !== 'browser:request') return;
    if (message.args.action === 'lease') {
      const id = `concurrent-page-${++leases}`;
      child.send({type: 'browser:reply', id: message.id, result: {id, marker: `about:blank#${id}`, endpoint}});
    } else if (message.args.action === 'release') {
      assert.equal(message.args.discard, true);
      releases.add(message.args.id);
      child.send({type: 'browser:reply', id: message.id, result: {}});
    }
  });
  try {
    await discovered;
    child.send({type: 'test:cancel'});
    assert.equal(await Promise.race([cancelled.then(() => true), delay(300, false)]), true);
    assert.equal(leases, 2);
    assert.deepEqual([...releases].sort(), ['concurrent-page-1', 'concurrent-page-2']);
    assert.equal(responses.length, 1, 'both leases must share one pending CDP discovery');
    for (const response of responses) {
      response.writeHead(503);
      response.end('Fixture connection stopped');
    }
    assert.equal(await exited, 0, stderr);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
