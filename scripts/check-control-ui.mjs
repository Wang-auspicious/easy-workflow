// Targeted browser verification; uses a temporary workspace and no model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { apply } from '../shared/project.ts';
import { legacyReply } from '../shared/conversation.ts';
import { buildReport } from '../server/report.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-control-ui-'));
const out = path.join(root, 'artifacts', 'parts-workspace');
fs.mkdirSync(out, { recursive: true });
const token = 'isolated-ui-test';
const child = fork(path.join(root, 'server/main.ts'), [], { cwd: root, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, FACTORY_DISCOVERY: '0', FACTORY_VAR: dir, FACTORY_LAYOUT: path.join(dir, 'layout.json'), FACTORY_PORT: '0', FACTORY_TOKEN: token, FACTORY_READONLY: '0' } });
let browser;
let log = '';
child.stdout.on('data', b => { log += b; });
child.stderr.on('data', b => { log += b; });
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(log || 'server timeout')), 20000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(log)); });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.on('message', m => { if (m.type === 'ready') { clearTimeout(timer); resolve(m.url); } });
  });
  const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && fs.existsSync(p));
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
  await context.addCookies([{ name: 'pf_auth', value: token, url }]);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));
  await page.goto(url);
  await page.waitForSelector('[data-node]');
  await page.waitForSelector('.rail-conn.is-on');
  assert.match(await page.locator('.hud').textContent(), /尚未运行/);
  assert.match(await page.locator('.hud-done').textContent(), /0\/0/);
  assert.match(await page.locator('[data-node="curation/proof"] .node-footer').textContent(), /本轮\s*0/);
  assert.equal(await page.locator('.thumb--mock, .node-work, .sample-trace').count(), 0);
  assert.doesNotMatch(await page.locator('body').textContent(), /队列曾达到|已新增一个/);
  assert.equal(await page.locator('img.bot-gif').count(), 0);
  assert.ok(await page.locator('.node-header .station-icon').count() > 0);
  assert.match(await page.locator('[data-node="curation/classify"] .node-model').textContent(), /pi · .+/);
  assert.doesNotMatch(await page.locator('[data-node="curation/classify"] .node-metrics').textContent(), /模型|输入|deepseek/);
  assert.match(await page.locator('[data-node="curation/fetch"] .node-metrics').textContent(), /待处理.*进行中/);
  assert.equal(await page.locator('.att-strip .att').count(), 0, 'no fabricated attachment');
  const readable = await page.evaluate(() => {
    const scale = new DOMMatrix(getComputedStyle(document.querySelector('.cv-world')).transform).a;
    const title = document.querySelector('[data-node="curation/classify"] .node-name');
    const canvas = document.querySelector('.cv').getBoundingClientRect();
    const fullCards = [...document.querySelectorAll('.node:not(.node--source)')].filter(n => { const r = n.getBoundingClientRect(); return r.left >= canvas.left && r.right <= canvas.right && r.top >= canvas.top + 100 && r.bottom <= canvas.bottom - 40; }).length;
    return { scale, titlePx: parseFloat(getComputedStyle(title).fontSize) * scale, metricsPx: parseFloat(getComputedStyle(document.querySelector('.node-metric')).fontSize) * scale, fullCards };
  });
  assert.ok(readable.titlePx >= 14, `title ${readable.titlePx}px must be readable by default`);
  assert.ok(readable.metricsPx >= 11.5);
  assert.ok(readable.fullCards >= 8, `only ${readable.fullCards} complete cards visible`);
  await page.screenshot({ path: path.join(out, 'workspace-1440.png'), fullPage: true });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.waitForFunction(() => document.querySelector('.cv').getBoundingClientRect().height === 768);
  await page.screenshot({ path: path.join(out, 'workspace-1366.png'), fullPage: true });
  await page.setViewportSize({ width: 1800, height: 1280 });
  await page.keyboard.press('w');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 350)));
  await page.screenshot({ path: path.join(out, 'reference-1800.png'), fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.press('f');
  await page.screenshot({ path: path.join(out, 'overview.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => document.querySelector('.cv').getBoundingClientRect().height === 900);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator('.section-picker').selectOption({ label: '分类校验' });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const header = page.locator('[data-node="curation/classify"] .node-header');
  const beforeDrag = await header.boundingBox();
  await page.mouse.move(beforeDrag.x + 80, beforeDrag.y + 22);
  await page.mouse.down();
  await page.mouse.move(beforeDrag.x + 130, beforeDrag.y + 92, { steps: 7 });
  await page.mouse.up();
  const afterDrag = await header.boundingBox();
  assert.ok(Math.abs(afterDrag.x - beforeDrag.x - 50) < 2 && Math.abs(afterDrag.y - beforeDrag.y - 70) < 2, `node follows the pointer at current scale: ${JSON.stringify({ beforeDrag, afterDrag })}`);
  const detached = await page.evaluate(() => {
    const errors = [];
    for (const edge of document.querySelectorAll('[data-edge]')) {
      const curve = edge.querySelector('.edge-line');
      for (const [key, distance] of [[edge.dataset.from, 0], [edge.dataset.to, curve.getTotalLength()]]) {
        const target = [...document.querySelectorAll('[data-node], [data-capsule]')].find(n => n.dataset.node === key || `capsule:${n.dataset.capsule}` === key);
        const box = target.getBoundingClientRect();
        const p = curve.getPointAtLength(distance), q = new DOMPoint(p.x, p.y).matrixTransform(curve.getScreenCTM());
        if (q.x < box.left - 2 || q.x > box.right + 2 || q.y < box.top - 2 || q.y > box.bottom + 2) errors.push(key);
      }
    }
    return errors;
  });
  assert.deepEqual(detached, [], 'edges remain attached after dragging');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.ctl-btn').filter({ hasText: '重排' }).click();
  await page.waitForFunction(() => document.querySelector('[data-node="curation/classify"]').style.left === '636px');
  await page.locator('.section-picker').selectOption({ label: '分类校验' });
  await page.locator('[data-node="curation/classify"] .node-header').click();
  const inspector = page.locator('[data-inspector="curation/classify"]');
  await inspector.getByRole('button', { name: '钉在画布上' }).click();
  const anchor = () => page.evaluate(() => {
    const r = document.querySelector('[data-inspector="curation/classify"]').getBoundingClientRect();
    const cv = document.querySelector('.cv').getBoundingClientRect();
    const m = new DOMMatrix(getComputedStyle(document.querySelector('.cv-world')).transform);
    return { x: (r.left - cv.left - m.e) / m.a, y: (r.top - cv.top - m.f) / m.a, width: r.width, scale: m.a };
  });
  const pinned = await anchor();
  await page.keyboard.press('-');
  const zoomed = await anchor();
  assert.ok(Math.abs(zoomed.x - pinned.x) < 1 && Math.abs(zoomed.y - pinned.y) < 1, 'pinned inspector stays in canvas coordinates');
  assert.ok(Math.abs(zoomed.width / pinned.width - zoomed.scale / pinned.scale) < 0.01, 'pinned inspector scales with the canvas');
  await page.screenshot({ path: path.join(out, 'pinned-inspector.png'), fullPage: true });
  await inspector.locator('.insp-head button').last().click();
  await page.locator('.section-picker').selectOption({ label: '资源采集' });
  assert.equal(await page.locator('img.bot-gif, svg.bot').count(), 0);
  await page.screenshot({ path: path.join(out, 'capture-section.png'), fullPage: true });
  await page.getByRole('button', { name: '查看资源采集详情' }).click();
  await page.locator('.inspector--part').getByRole('button', { name: '处理过程', exact: true }).click();
  assert.match(await page.locator('.inspector--part').textContent(), /7 个工位/);
  await page.screenshot({ path: path.join(out, 'part-detail.png'), fullPage: true });
  await page.locator('.inspector--part .insp-head button').last().click();
  await page.locator('.chat-avatar-btn').click();
  await page.waitForSelector('.composer textarea');
  await page.route('**/api/chat', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'dispatcher_busy', error: '主调度还在回答上一条' }) }));
  await page.locator('.composer textarea').fill('保留这条没有发送成功的消息');
  await page.locator('button.send').click();
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === '保留这条没有发送成功的消息');
  assert.match(await page.locator('.toast').textContent(), /主调度还在回答上一条/);

  const call = async (tool, args) => {
    const response = await fetch(`${url}/api/tools/${tool}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const draft = await call('propose_patch', { summary: 'UI 检查改名', ops: [{ op: 'set', station: 'curation/proof', field: 'name', value: '特写同步验证' }] });
  await call('decide_patch', { id: draft.result.id, accept: true });
  await page.waitForFunction(() => document.querySelector('[data-node="curation/proof"]')?.textContent.includes('特写同步验证'));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForSelector('.station-icon');
  // UI-only fixtures live in this isolated context. Never inject them into a user's journal.
  const baseline = await page.evaluate(async()=> (await fetch('/api/state')).json());
  const spec = await page.evaluate(async()=> (await fetch('/api/factory')).json());
  const fixturePage = await context.newPage();
  fixturePage.on('pageerror',err=>pageErrors.push(err.message));
  await fixturePage.route('**/api/state',async route=>{
    const state=structuredClone(baseline), now=Date.now();state.seq=100000;
    state.run={id:'run-ui-fixture',title:'界面验证样本',startedAt:now-120000,pausedMs:0,status:'running'};
    const help=legacyReply('',now-2000);help.content=[{type:'toolCall',id:'fixture-help',name:'h2_help',arguments:{name:'status'}}];
    const inspect=legacyReply('',now-1000);inspect.content=[{type:'toolCall',id:'fixture-status',name:'h2_call',arguments:{name:'status',arguments:{}}}];
    state.conversation=[
      {id:'fixture-user',turn:'fixture-turn',message:{role:'user',content:'检查当前运行状态，不要投料。',timestamp:now-3000}},
      {id:'fixture-help-call',turn:'fixture-turn',message:help},
      {id:'fixture-help-result',turn:'fixture-turn',message:{role:'toolResult',toolCallId:'fixture-help',toolName:'h2_help',content:[{type:'text',text:'{"name":"status","inputSchema":{"type":"object","properties":{}}}'}],isError:false,timestamp:now-1900}},
      {id:'fixture-status-call',turn:'fixture-turn',message:inspect},
      {id:'fixture-status-result',turn:'fixture-turn',message:{role:'toolResult',toolCallId:'fixture-status',toolName:'h2_call',content:[{type:'text',text:'{"run":{"status":"idle"},"tokensActive":0}'}],isError:false,timestamp:now-900}},
      {id:'fixture-answer',turn:'fixture-turn',message:legacyReply('当前没有正在运行的任务。\n\n- 队列为空\n- 没有正在执行的工位\n\n可以选择候选条目开始新一轮。',now-500)},
    ];
    const unsafe=legacyReply('安全渲染检查 <img src=x onerror="window.fixtureUnsafe=true"> [链接](javascript:alert(1))',now);
    state.conversation.push({id:'render-check',turn:'render-check',message:unsafe});
    state.activity=[{id:'routine',role:'note',text:'自动撤下闲置工人',tone:'info',at:now}];
    const tokenId='fixture-task';
    state.tokens[tokenId]={id:tokenId,item:'界面验证任务',line:'curation',url:'https://example.test',source:'sources/watch',status:'active',at:['curation/identity'],attempts:['fixture-attempt'],evidence:[],rounds:{},corrections:0,data:{},createdAt:now};state.tokenOrder.push(tokenId);
    state.nodes['curation/identity'].active=['fixture-attempt'];state.attempts['fixture-attempt']={id:'fixture-attempt',node:'curation/identity',token:tokenId,worker:'fixture-worker',input:'验证动态效果',startedAt:now,steps:[],usage:{input:0,output:0,cost:0}};
    state.transfers=[{seq:100000,at:now,token:tokenId,from:'curation/identity',to:'curation/process',returned:false}];
    await route.fulfill({contentType:'application/json',body:JSON.stringify(state)});
  });
  await fixturePage.goto(url);
  await fixturePage.locator('.pi-conversation assistant-message').first().waitFor();
  assert.ok(await fixturePage.locator('.pi-conversation tool-message').count()>=2);
  assert.equal(await fixturePage.locator('.chat-log .note').count(),0);
  assert.equal(await fixturePage.locator('.pi-conversation img').count(),0);
  assert.equal(await fixturePage.evaluate(()=>window.fixtureUnsafe),undefined);
  await fixturePage.locator('.pi-conversation .pi-tool summary').first().click();
  assert.ok(await fixturePage.locator('.pi-conversation .pi-tool[open] code-block').count()>0);
  await fixturePage.locator('.pi-conversation .pi-tool summary').first().click();
  await fixturePage.screenshot({path:path.join(out,'pi-conversation.png'),fullPage:true});
  const shimmer=await fixturePage.locator('[data-node="curation/identity"]').evaluate(el=>getComputedStyle(el,'::after').animationName);
  assert.equal(shimmer,'station-sweep');
  await fixturePage.locator('.edge-flash').first().waitFor({state:'detached',timeout:7000});
  await fixturePage.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await fixturePage.locator('[data-node="curation/identity"]').evaluate(el=>getComputedStyle(el,'::after').display),'none');

  const events=[];let seq=0;const at=Date.now()-240000;
  const add=(offset,e)=>events.push({...e,seq:++seq,at:at+offset,run:'run-ui-fixture'});
  add(0,{kind:'run.started',runId:'run-ui-fixture',title:'网站入库 · 界面验证样本'});
  for(let i=0;i<18;i++){
    const node=['curation/classify','curation/style','curation/copy'][i%3],token=`demo-${i}`;
    add(i*12000+100,{kind:'token.created',token,line:'curation',item:`验证条目 ${i+1}`,url:'https://example.test',source:'sources/watch'});
    add(i*12000+1000,{kind:'attempt.started',attempt:`demo-a-${i}`,token,node,worker:'demo-worker',input:'验证输入'});
    add(i*12000+2000,{kind:'attempt.progress',attempt:`demo-a-${i}`,text:'读取页面证据并核对结果'});
    add(i*12000+7000,{kind:'attempt.finished',attempt:`demo-a-${i}`,ok:i!==7,summary:i===7?'证据不足':'已完成核对',ms:6000,queuedMs:700,usage:{input:1800+i*80,output:150+i*12,cost:.004}});
    add(i*12000+7100,{kind:'token.finished',token,node,status:i===7?'manual':'published',reason:'界面验证样本'});
  }
  add(240000,{kind:'run.ended',runId:'run-ui-fixture',manual:true});
  const fakeFactory={compiled:spec.factory,state:baseline,journal:{read:(since=0,run)=>events.filter(e=>e.seq>since&&(!run||run===e.run))}};
  const report=buildReport(fakeFactory,'run-ui-fixture');
  await fixturePage.route('**/api/runs',route=>route.fulfill({contentType:'application/json',body:JSON.stringify([{run:report.runId,first:at,last:at+240000,events:events.length,report:true}])}));
  await fixturePage.route('**/api/report/*',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(report)}));
  await fixturePage.locator('.rail-item[data-tip="运行记录与回放"]').click();
  await fixturePage.locator('.dash-kpis').waitFor();
  await fixturePage.screenshot({path:path.join(out,'run-dashboard-fixture.png'),fullPage:true});
  await fixturePage.locator('.dash-ranks button').first().click();
  assert.ok(await fixturePage.locator('.node-summary').count());
  await fixturePage.locator('.dash-attempts>button').first().click();
  assert.match(await fixturePage.locator('.attempt-detail').textContent(),/读取页面证据/);
  await fixturePage.screenshot({path:path.join(out,'run-detail-fixture.png'),fullPage:true});
  await fixturePage.getByRole('button',{name:'Token 用量',exact:true}).click();
  await fixturePage.getByRole('button',{name:'时段 3',exact:true}).click();
  assert.ok(await fixturePage.locator('.dash-clear').count());
  await fixturePage.close();
  assert.deepEqual(pageErrors, []);
  const result = { ok: true, checks: ['real zero counters and no fabricated attachments', 'readable complete working part', 'uniform workload metrics and secondary model metadata', 'dragging keeps connectors attached', 'pinned inspector follows world coordinates and scale', 'part statistics and process detail', 'section navigation with reduced motion', 'failed chat restores draft and shows error', 'external patch updates visible graph', 'native Pi transcript and paired collapsible tools', 'sanitized message rendering', 'real-event animation lifetime and reduced motion', 'interactive run dashboard and attempt detail (isolated fixtures)', 'no browser exceptions'], readability: readable, viewports: [[1440, 900], [1366, 768], [1800, 1280]] };
  fs.writeFileSync(path.join(out, 'ui-check.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
    const timer = setTimeout(() => child.kill(), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send({ type: 'shutdown' }); else child.kill();
  });
  assert.ok(path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()), 'h2-control-ui-')));
  fs.rmSync(dir, { recursive: true, force: true });
}
