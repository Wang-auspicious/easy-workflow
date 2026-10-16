// Request ordering and failed-save recovery through the real UI and API module.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';
import {compile} from '../../server/spec/compile.ts';
import {station, line} from '../../server/spec/dsl.ts';
import {initialState} from '../../shared/project.ts';
import {layoutFactory} from '../../shared/layout.ts';

const factory = compile([{id: 'api-fixture', name: '连接与保存验收', version: '1', blurb: '',
  lines: [line({id: 'fixture', name: '隔离工作流', layer: 3, priority: 'mid', wired: true, blurb: '',
    stations: [station({id: 'step', name: '处理', role: 'process', kind: 'program', resource: 'none'})], edges: []})],
  channels: [], links: [], conditions: {}, resources: {browser: 0, model: 0, http: 0, cpu: 0}, order: [], collapsed: [], hints: {}}]);
const snapshot = initialState(factory);
const metadata = {factory, layout: {designVersion: 4}, defaultLayout: layoutFactory(factory.nodes, [], [], {}, []), settings: {}, model: 'fixture', keyPresent: false};
const server = await createServer({configFile: path.resolve('ui/vite.config.ts'), logLevel: 'error', server: {host: '127.0.0.1', port: 0, strictPort: false}});
await server.listen();
const browser = await chromium.launch({executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
const out = path.resolve('var/verification/api-ui');
await fs.mkdir(out, {recursive: true});
try {
  const page = await browser.newPage({viewport: {width: 1360, height: 900}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.clear();
    window.testStreams = [];
    window.EventSource = class {
      constructor() { window.testStreams.push(this); queueMicrotask(() => this.onopen?.({})); }
      addEventListener() {}
      close() {}
    };
  });
  let failBoot = true;
  let holdLayout = true;
  let failLayout = false;
  let releaseLayout;
  let releaseFactory;
  let holdFactory = false;
  let holdState = false;
  let releaseState;
  const writes = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/factory') {
      if (holdFactory) await new Promise(resolve => { releaseFactory = resolve; });
      return route.fulfill(failBoot ? {status: 503, json: {error: '隔离服务暂未就绪'}} : {json: metadata}).catch(() => {});
    }
    if (url.pathname === '/api/state') {
      if (holdState) await new Promise(resolve => { releaseState = resolve; });
      return route.fulfill({json: snapshot}).catch(() => {});
    }
    if (url.pathname === '/api/layout') {
      writes.push(route.request().postDataJSON());
      if (holdLayout) await new Promise(resolve => { releaseLayout = resolve; });
      return route.fulfill(failLayout ? {status: 500, json: {error: '隔离存储暂不可写'}} : {json: {ok: true}});
    }
    return route.fulfill({json: {tabs: [], current: null, ok: true}});
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.getByRole('alert').filter({hasText: '隔离服务暂未就绪'}).waitFor();
  await page.screenshot({path: path.join(out, 'connection-retry.png')});
  failBoot = false;
  await page.getByRole('button', {name: '重新连接', exact: true}).click();
  await page.waitForFunction(async () => (await import('/src/store.ts')).getState().ready);
  const save = x => page.evaluate(async x => {
    const store = await import('/src/store.ts');
    const api = await import('/src/api.ts');
    api.saveLayout({...store.getState().layout, pos: {'fixture/step': {x, y: 20}}});
  }, x);
  await save(10);
  while (!releaseLayout) await new Promise(resolve => setTimeout(resolve, 20));
  await save(20);
  await page.waitForTimeout(650);
  assert.equal(writes.length, 1, 'a second save waits for the first receipt');
  holdLayout = false;
  releaseLayout();
  await page.waitForResponse(response => response.url().endsWith('/api/layout') && response.request().postDataJSON().pos['fixture/step'].x === 20);
  assert.deepEqual(writes.map(write => write.pos['fixture/step'].x), [10, 20]);
  failLayout = true;
  await save(30);
  await page.getByRole('button', {name: '重试保存', exact: true}).waitFor();
  failLayout = false;
  await page.getByRole('button', {name: '重试保存', exact: true}).click();
  await page.waitForResponse(response => response.url().endsWith('/api/layout') && response.ok());
  assert.equal(writes.at(-1).pos['fixture/step'].x, 30);
  const count = writes.length;
  await page.evaluate(async () => {
    const store = await import('/src/store.ts');
    const api = await import('/src/api.ts');
    store.setState({replay: {run: 'old', playing: false, speed: 1, at: 0, start: 0, end: 0, events: [], cursor: 0}});
    api.saveLayout({...store.getState().layout, pos: {}});
  });
  await page.waitForTimeout(650);
  assert.equal(writes.length, count, 'replay cannot write layout');
  assert.equal(await page.evaluate(async () => (await import('/src/store.ts')).getState().layout.pos['fixture/step'].x), 30);
  await page.evaluate(async () => {
    const store = await import('/src/store.ts');
    const api = await import('/src/api.ts');
    store.setState({replay: null});
    const old = window.testStreams.at(-1);
    api.connect(0);
    store.setState({connected: false});
    old.onopen();
    if (store.getState().connected) throw new Error('obsolete stream changed connection state');
  });
  // A save can finish after boot read its layout but before it receives state.
  holdState = true;
  await page.evaluate(async () => { window.pendingBoot = (await import('/src/api.ts')).boot(); });
  while (!releaseState) await new Promise(resolve => setTimeout(resolve, 20));
  await save(99);
  await page.waitForResponse(response => response.url().endsWith('/api/layout') && response.ok());
  // A newer spec refresh must also win over boot's older metadata response.
  metadata.factory = {...factory, nodes: factory.nodes.map(node => ({...node, name: '更新后的工位'}))};
  await page.evaluate(async () => { await (await import('/src/api.ts')).refreshSpec(); });
  holdState = false;
  releaseState();
  await page.evaluate(async () => { await window.pendingBoot; });
  const refreshed = await page.evaluate(async () => {
    const state = (await import('/src/store.ts')).getState();
    return {x: state.layout.pos['fixture/step'].x, name: state.factory.nodes[0].name};
  });
  assert.equal(refreshed.x, 99, 'boot cannot roll back a layout saved while state loaded');
  assert.equal(refreshed.name, '更新后的工位', 'boot cannot replace newer spec metadata');
  holdFactory = true;
  await page.evaluate(async () => { void (await import('/src/api.ts')).boot(); });
  while (!releaseFactory) await new Promise(resolve => setTimeout(resolve, 20));
  await page.evaluate(async () => {
    const store = await import('/src/store.ts');
    (await import('/src/api.ts')).disconnect();
    store.setState({replay: {run: 'old', playing: false, speed: 1, at: 0, start: 0, end: 0, events: [], cursor: 0}});
  });
  releaseFactory();
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(async () => (await import('/src/store.ts')).getState().replay.run), 'old');
  assert.deepEqual(errors, []);
  const checks = ['visible startup failure and retry', 'serialized layout writes', 'failed save retains draft and retries', 'replay is read-only', 'obsolete stream ignored', 'boot cannot replace a newly saved layout', 'boot cannot replace newer spec metadata', 'boot cannot replace replay'];
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({checks, errors}, null, 2));
  console.log(JSON.stringify({checks, errors}));
} finally {
  await browser.close();
  await server.close();
}
