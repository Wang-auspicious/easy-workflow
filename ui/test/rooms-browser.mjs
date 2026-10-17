// 群组栏的验收：把真实的 Runtime 跑一遍，产出真实的工位往来（咨询 / 判定 / 退回 /
// 交付 / 纠错），再把界面指向这份日志，检查群组栏与群组往来是不是从真实数据长出来的。
//
// 运行：node ui/test/rooms-browser.mjs
// 隔离项目在临时目录，日志和截图写到 var/verification/rooms/。不调用任何外部模型。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, preview } from "vite";
import { chromium } from "playwright-core";
import { compile } from "../../server/spec/compile.ts";
import { pack } from "../../packs/vislexicon/pack.ts";
import { Runtime } from "../../server/runtime.ts";
import { Journal } from "../../server/journal.ts";
import { Broker } from "../../server/broker.ts";
import {KernelStore} from '../../server/kernel/store.ts';
import {createItem} from '../../server/kernel/item.ts';
import {BoardStore} from '../../server/board.ts';

const root = path.resolve(import.meta.dirname, "../..");
const v2 = process.argv.includes('--v2');
const out = path.join(root, v2 ? 'var/verification/rooms-v2' : 'var/verification/rooms');
await fs.mkdir(out, { recursive: true });

/* ---------------------------------------------------------------- 1. 真实运行，产出真实往来 */

/** 用真实 Runtime 和真实包跑出往来。工位执行体是脚本，但事件全部由运行时自己写。 */
async function seedProject(directory) {
  const journal = new Journal(path.join(directory, "journal.db"));
  const calls = {};
  const fix = (stations, fields, problem) => ({
    ok: true, summary: problem,
    verdict: { verdict: "fix", reason: problem, fixes: stations.map((station, i) => ({ station, fields: [fields[i] ?? fields[0]], problem, via: ["curation/process", "curation/shot-review"] })) },
  });
  const runtime = new Runtime(compile([pack]), journal, new Broker({ model: 8, browser: 8, http: 8, cpu: 4 }, 0), {
    shots: () => true, video: () => false, needsProof: () => true, noProof: () => false,
    complete: () => true, incomplete: () => false,
    website: () => true, skill: () => false, figure: () => false, deck: () => false, fx: () => false,
    agree: () => true, disagree: () => false, decided: (d) => typeof d.kind === "string" && d.kind !== "", undecided: (d) => !d.kind,
  }, node => async () => {
    const round = (calls[node.key] = (calls[node.key] ?? 0) + 1);
    if (round > 1) return { ok: true, summary: "复核通过" };
    switch (node.key) {
      // 声明的退回边：摄影审查把目录摄影退回去重拍（进"返工环"群）。
      case "curation/shot-review": return { ok: true, summary: "目录截图只截到页眉", verdict: { verdict: "return", returnTo: "curation/breadth", reason: "目录摄影只截到页眉，没有可比的两栏" } };
      // 实际咨询（同工序）：事实审查点名事实核验员改字段。
      case "curation/fact-review": return fix(["curation/facts"], ["facts.license"], "许可见字段没有引用来源");
      // 实际咨询（跨工序）：风格判定员只能去找组件特写摄影 → 观测出来的复审群。
      case "curation/style": return fix(["curation/proof"], ["shots.proof"], "组件主体不可见，只剩底衬");
      // 终审把问题同时给编辑和事实核验员。
      case "curation/audit": return fix(["curation/copy", "curation/facts"], ["copy.descriptionZh", "facts.license"], "描述与许可字段对不上来源");
      default: return { ok: true, summary: "通过" };
    }
  });
  runtime.ensureWorkers([]);
  runtime.start("群组栏验收 · 真实往来");
  const token = runtime.create("curation/plan", {
    item: "d3-color", url: "https://d3js.org/d3-color", source: "manual",
    data: { kind: "component-source", kindAgreed: true, mode: "shots", needsProof: "yes" },
  });
  // 站长的纠错：真实 correction.created（活还在跑的时候改）。
  await delay(30);
  runtime.correct({ token: token.id, node: "curation/proof" }, "特写裁到导航栏了", "只截舞台区域");
  for (let i = 0; i < 500 && !token.finished; i++) await delay(5);
  // 从判定汇合点进，让跨线信道真实发一次货（curation → components）。
  const crossed = runtime.create("curation/kind-join", {
    item: "radix-primitives", url: "https://radix-ui.com/primitives", source: "manual",
    data: { kind: "component-source", kindAgreed: true, mode: "shots", needsProof: "yes" },
  });
  for (let i = 0; i < 300 && !crossed.finished; i++) await delay(5);
  await runtime.settle();
  await runtime.close();
  journal.close();
  return { token: token.id, crossed: crossed.id };
}

/** UI fixture only: durable rows and journal events, no live model acceptance. */
async function seedV2(directory) {
  const compiled = compile([pack]);
  const journal = new Journal(path.join(directory, 'journal.db'));
  const store = new KernelStore(journal);
  const board = new BoardStore(journal, compiled, {'curation/proof': {outputKey: 'shots'}});
  const now = Date.now();
  const item = createItem(compiled, {id: 'ui-v2-shots', run: 'ui-v2-run', entry: 'curation/reader', item: '三屏协作样本',
    url: 'https://fixture.invalid/shots', source: 'isolated-ui-fixture', now, data: {title: '三屏协作样本', mode: 'shots', shots: {proof: 'fixture'}}});
  item.status = 'active';
  for (const state of Object.values(item.nodes)) state.status = 'pending';
  for (const [node, reason] of [['curation/plan', 'model'], ['curation/identity', 'budget'], ['curation/breadth', 'backoff'],
    ['curation/proof', 'room'], ['curation/process', 'resource']]) {
    Object.assign(item.nodes[node], {status: 'waiting', waitingFor: reason, waitingSince: now - 660000});
    if (reason === 'budget') item.nodes[node].agentBudget = {maxTokens: 60000, maxMs: 900000};
    if (reason === 'backoff') item.nodes[node].nextAt = now + 900000;
  }
  const parked = createItem(compiled, {id: 'ui-v2-auth', run: item.run, entry: 'curation/plan', item: '需要登录的素材',
    url: 'https://fixture.invalid/login', source: 'isolated-ui-fixture', now});
  parked.status = 'parked';
  parked.parked = {node: 'curation/proof', code: 'auth', reason: '来源页需要登录后继续', at: now};
  parked.nodes['curation/proof'].status = 'failed';
  const published = createItem(compiled, {id: 'ui-v2-published', run: item.run, entry: 'curation/plan', item: '已发布样本',
    url: 'https://fixture.invalid/published', source: 'isolated-ui-fixture', now});
  published.status = 'published';
  published.nodes['curation/published'].status = 'done';
  published.data.published = true;
  journal.atomic(() => {
    journal.append({kind: 'run.started', runId: item.run, title: 'E 界面 fixture · 不调用外部模型'});
    for (const value of [item, parked, published]) {
      store.save(value);
      journal.append({kind: 'token.created', token: value.id, line: value.line, item: value.item, title: value.item, url: value.url, source: value.source});
      journal.append({kind: 'token.data', token: value.id, patch: value.data});
    }
    journal.append({kind: 'token.finished', token: parked.id, node: 'curation/proof', status: 'manual', reason: parked.parked.reason});
    journal.append({kind: 'token.finished', token: published.id, node: 'curation/published', status: 'published', reason: 'Fixture publication state'});
    board.autoClaim(item, 'curation/proof', '已保存选中页面的主体证据（UI fixture）', {shots: item.data.shots}, []);
    const challenge = board.addPost({item, author: 'curation/shot-review', type: 'challenge', field: 'shots.proof',
      addressee: 'curation/proof', body: '特写没有完整展示组件主体，请保留页面路径并补充证据。'});
    board.addPost({item, author: 'curation/proof', type: 'answer', field: 'shots.proof', target: challenge.id,
      body: '已核对原页面：组件主体在选中舞台区域，补充截图后继续复核。'});
    const room = board.createRoom({item, field: 'shots.proof', topic: '核对三屏主体证据',
      participants: ['curation/shot-review', 'curation/style', 'curation/reader'], judge: 'program:shot-rules'});
    board.closeRoom(room.id, {status: 'resolved', value: {verified: true}});
    store.saveAttempt({id: 'ui-v2-progress', item: item.id, node: 'curation/shot-review', startedAt: now, endedAt: now + 1,
      status: 'ok', body: {summary: 'Fixture program receipt'}});
    journal.append({kind: 'attempt.started', attempt: 'ui-v2-progress', token: item.id, node: 'curation/shot-review', worker: 'fixture', input: '三屏复核'});
    journal.append({kind: 'attempt.progress', attempt: 'ui-v2-progress', text: '正在核对选中页面与像素统计（UI fixture 进展）'});
    journal.append({kind: 'attempt.finished', attempt: 'ui-v2-progress', ok: true, summary: '已保存三屏检查记录', ms: 1, queuedMs: 0});
    journal.append({kind: 'lesson.shared', lesson: {id: 'ui-v2-lesson', node: 'curation/proof', text: '复核前保留选中页面路径，截图必须包含组件主体。',
      evidence: ['ui-v2-progress'], at: now, status: 'active'}});
    journal.append({kind: 'run.paused', runId: item.run});
  });
  journal.close();
  return {token: item.id, parked: parked.id, lesson: 'ui-v2-lesson'};
}

/* ---------------------------------------------------------------- 2. 指向这份日志启动界面 */

async function serve(directory) {
  const token = "isolated-rooms-acceptance-only";
  const child = fork(path.join(root, "server/main.ts"), [], {
    cwd: root, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, FACTORY_ROOT: root, FACTORY_VAR: directory, FACTORY_LAYOUT: path.join(directory, "layout.json"),
      VISLEXICON_ROOT: path.join(directory, "unconnected"), FACTORY_PORT: "0", FACTORY_TOKEN: token,
      FACTORY_DISCOVERY: "0", FACTORY_PREFLIGHT: "0", FACTORY_HTTP_CACHE: "0", FACTORY_READONLY: "0", FACTORY_START_PAUSED: v2 ? '1' : '0', FACTORY_KERNEL: v2 ? 'v2' : 'v1' },
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  const backend = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`backend timeout: ${log}`)), 40000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`backend exited ${code}: ${log}`)); });
    child.on("message", (message) => { if (message.type === "ready") { clearTimeout(timer); resolve(message.url); } });
  });
  const vite = await createServer({
    configFile: path.join(root, "ui/vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false,
      fs: {allow: [root, await fs.realpath(path.join(root, 'node_modules'))]},
      proxy: { "/api": { target: backend, changeOrigin: false, headers: { authorization: `Bearer ${token}` } }, "/evidence": { target: backend, changeOrigin: false, headers: { authorization: `Bearer ${token}` } } } },
  });
  await vite.listen();
  return { url: `http://127.0.0.1:${vite.httpServer.address().port}`, close: async () => {
    await vite.close();
    if (child.exitCode === null) await new Promise((resolve) => { const timer = setTimeout(() => child.kill(), 5000); child.once("exit", () => { clearTimeout(timer); resolve(); }); if (child.connected) child.send({ type: "shutdown" }); else child.kill(); });
  } };
}

/* ---------------------------------------------------------------- 3. 检查界面 */

async function verifyV2(page, seeded, errors) {
  await page.waitForFunction(() => document.querySelector('.kernel-summary')?.textContent?.includes('已发布 1'));
  await page.getByRole('button', {name: '所有对话', exact: true}).click();
  assert.ok(await page.locator('[data-room="field:shots.*"] .talk-sub').innerText().then(text => !text.includes('围绕这一字段')), 'v2 discussion previews include real field events');
  const quiet = page.getByRole('button', {name: /还有.*个群暂时没有往来/});
  if (await quiet.count()) await quiet.click();
  assert.equal(await page.locator('.talk-row').count(), 6);
  const names = await page.locator('.talk-top b').allInnerTexts();
  for (const label of ['主调度', '分类', '三屏', '风格', '事实', '文案']) assert.ok(names.some(name => name.includes(label)), label);
  assert.ok(await page.locator('.kernel-attention').count() >= 2);
  assert.equal(await page.locator('.allocation-shortcut,.allocation-proposal').count(), 0);
  await page.screenshot({path: path.join(out, 'summary-attention.png')});
  await page.locator('[data-room="field:shots.*"]').click();
  await page.locator('.bub').filter({hasText: '特写没有完整展示组件主体，请保留页面路径并补充证据。'}).waitFor();
  assert.ok((await page.locator('.bub-verb').allInnerTexts()).includes('答复'));
  assert.equal(await page.locator('.bub').filter({hasText: '已保存选中页面的主体证据（UI fixture）'}).count(), 0, 'claims are not conversation rows');
  const toggle = page.getByRole('checkbox', {name: '显示进展'});
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await page.locator('.bub').filter({hasText: '正在核对选中页面与像素统计（UI fixture 进展）'}).count(), 0);
  await page.screenshot({path: path.join(out, 'shots-challenge.png')});
  await page.screenshot({path: path.join(out, 'progress-off.png')});
  await toggle.check();
  await page.locator('.bub').filter({hasText: '正在核对选中页面与像素统计（UI fixture 进展）'}).waitFor();
  await page.screenshot({path: path.join(out, 'progress-on.png')});
  await page.reload();
  await page.locator('.rail-conn.is-on').waitFor();
  await page.getByRole('checkbox', {name: '显示进展'}).waitFor();
  assert.equal(await page.getByRole('checkbox', {name: '显示进展'}).isChecked(), true, 'progress preference survives reload');
  await page.evaluate(async token => {
    const {toggleInspector} = await import('/src/canvas/Canvas.tsx');
    toggleInspector(token, 'token');
  }, seeded.token);
  await page.locator('.kernel-board-post[data-board-type="claim"]').waitFor();
  assert.ok(await page.locator('.kernel-board-chain').innerText().then(text => text.includes('已保存选中页面的主体证据')));
  await page.locator(`[data-inspector="${seeded.token}"]`).getByRole('button', {name: '关闭详情', exact: true}).click();
  await page.evaluate(async () => {
    const {toggleInspector} = await import('/src/canvas/Canvas.tsx');
    toggleInspector('curation/proof');
  });
  await page.locator('[data-inspector="curation/proof"]').getByRole('tab', {name: '说明', exact: true}).click();
  await page.locator('.kernel-lesson').waitFor();
  assert.equal(await page.getByRole('button', {name: '加一个人', exact: true}).count(), 0);
  assert.equal(await page.getByRole('button', {name: '撤一个', exact: true}).count(), 0);
  const deletion = page.waitForResponse(response => response.url().endsWith('/api/lessons/shared/delete') && response.request().method() === 'POST');
  await page.locator('.kernel-lesson').getByRole('button', {name: '删除', exact: true}).click();
  const receipt = await deletion;
  assert.equal(receipt.status(), 200, await receipt.text());
  await page.waitForFunction(() => document.querySelectorAll('.kernel-lesson').length === 0);
  const lessons = await page.evaluate(async () => (await (await fetch('/api/lessons/shared?node=curation%2Fproof')).json()).lessons);
  assert.ok(!lessons.some(lesson => lesson.id === seeded.lesson && lesson.status !== 'deleted'));
  await page.locator('[data-inspector="curation/proof"]').getByRole('button', {name: '关闭详情', exact: true}).click();
  for (const reason of ['model', 'budget', 'room', 'backoff']) assert.ok(await page.locator(`.node [data-waiting="${reason}"]`).count() > 0, `Missing ${reason} canvas count`);
  await page.evaluate(async () => {
    const {setState} = await import('/src/store.ts');
    setState({chatOpen: false});
  });
  await page.waitForFunction(() => document.querySelector('.cv')?.getBoundingClientRect().width > 1200);
  await delay(350);
  await page.evaluate(async () => {
    const {setState} = await import('/src/store.ts');
    const keys = ['curation/plan', 'curation/identity', 'curation/breadth', 'curation/proof', 'curation/process'];
    const boxes = keys.map(key => document.querySelector(`[data-node="${key}"]`)).filter(Boolean).map(element => ({
      x: parseFloat(element.style.left), y: parseFloat(element.style.top), w: parseFloat(element.style.width), h: parseFloat(element.style.height),
    }));
    const left = Math.min(...boxes.map(box => box.x)), top = Math.min(...boxes.map(box => box.y));
    const right = Math.max(...boxes.map(box => box.x + box.w)), bottom = Math.max(...boxes.map(box => box.y + box.h));
    setState({focus: {x: (left + right) / 2, y: (top + bottom) / 2, area: {w: right - left + 40, h: bottom - top + 40}, at: Date.now()}});
  });
  await delay(700);
  for (const reason of ['model', 'budget', 'room', 'backoff']) {
    const box = await page.locator(`.node [data-waiting="${reason}"]`).first().boundingBox();
    assert.ok(box && box.x >= 60 && box.x + box.width <= 1450 && box.y >= 0 && box.y + box.height <= 900,
      `${reason} must be visible in the actual canvas screenshot: ${JSON.stringify(box)}`);
  }
  await page.screenshot({path: path.join(out, 'canvas-waits.png')});
  assert.deepEqual(errors, []);
  const report = {ok: true, kind: 'isolated UI fixture, not live-model acceptance', groups: names,
    checked: ['summary-attention', 'field-conversation', 'claim-evidence-chain', 'progress-toggle-persistence', 'lesson-deletion', 'canvas-wait-colors', 'v2-worker-controls-hidden']};
  await fs.writeFile(path.join(out, 'fixture-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log(`screenshots: ${out}`);
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "easy-ui-rooms-"));
const errors = [];
let server, browser;
try {
  const seeded = v2 ? await seedV2(directory) : await seedProject(directory);
  server = await serve(directory);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 2,
    ...(v2 ? {reducedMotion: 'reduce'} : {}) });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem("pf.chatOpen", "true"); localStorage.setItem("pf.chatWidth", "320"); });
  await page.goto(server.url);
  await page.locator(".rail-conn.is-on").waitFor();
  await page.locator('.chat-head').waitFor();

  if (v2) {
    await verifyV2(page, seeded, errors);
  } else {

  assert.ok(await page.locator('.chat-pane').evaluate(el => el.getBoundingClientRect().width >= 320), 'saved sidebar widths keep the conversation readable');
  assert.equal(await page.locator('.chat-pane .pi-conversation').count(), 1);
  await page.locator('.composer textarea').fill('切换群组时保留主调度草稿');
  await page.screenshot({path: path.join(out, '01-rail-root.png')});
  const showList = async () => {
    await page.getByRole('button', {name: '所有对话', exact: true}).click();
    await page.locator('.talk-list').waitFor();
  };
  await showList();
  const trafficIds = await page.locator('.talk-row:not([data-room-kind="root"])').evaluateAll(rows => rows.map(row => row.dataset.room));
  const showQuiet = async () => {
    const more = page.getByRole('button', {name: /还有.*个群暂时没有往来/});
    if (await more.count()) await more.click();
  };
  await showQuiet();
  const rail = page.locator('.talk-list');
  const items = rail.locator('.talk-row');
  const names = await rail.locator('.talk-top b').allInnerTexts();
  const count = await items.count();
  assert.ok(count > 10, `群组栏应该列出流程上真实需要对话的地方，实际 ${count}`);

  // 群组是从流程推出来的：工序、返工环、跨段三类都要在。
  const text = names.join("\n");
  for (const expected of ["读懂与判定", "核验与发布", "组件源确认", "组件实例发布"]) {
    assert.ok(text.includes(expected), `缺少推导出来的群组：${expected}\n实际：${text}`);
  }
  const lanes = {part: await rail.locator('[data-room-kind="part"]').count(), loop: await rail.locator('[data-room-kind="loop"]').count(), bridge: await rail.locator('[data-room-kind="bridge"]').count()};
  assert.ok(lanes.loop > 0, "返工环必须出现");
  assert.ok(lanes.bridge >= 2, "跨段移交必须出现");
  assert.ok(lanes.part >= 8, `每一段工序都要有自己的群，实际 ${lanes.part}`);

  const rooms = await page.evaluate(async () => {
    const {deriveRooms} = await import('/src/chat/rooms.ts');
    const {getState} = await import('/src/store.ts');
    const state = getState();
    return deriveRooms(state.factory, Object.values(state.fs.consults ?? {}).map(c => ({reviewer: c.reviewer, owner: c.owner})));
  });
  const bridge = rail.locator('[data-room-kind="bridge"]').first();
  const bridgeId = await bridge.getAttribute('data-room');
  const bridgeRoom = rooms.find(room => room.id === bridgeId);
  await bridge.click();
  await page.locator('.room-intro').waitFor();
  assert.equal(bridgeRoom.members.length, 2);
  const memberText = await page.locator('.room-intro').innerText();
  for (const member of bridgeRoom.members) assert.ok(memberText.includes(member.name));
  await page.screenshot({ path: path.join(out, "02-bridge-room.png") });

  // 打开一个工序群：成员是这一段工序里所有工位，程序工位如实标注。
  await showList();
  await showQuiet();
  const partRoom = rooms.find(room => room.kind === 'part' && room.members.some(member => member.kind === 'program') && room.members.some(member => ['agent', 'review'].includes(member.kind)));
  assert.ok(partRoom, 'the roster retains program and Agent identities');
  await rail.locator(`[data-room="${partRoom.id}"]`).click();
  await page.locator('.room-intro').waitFor();
  const partText = await page.locator('.room-intro').innerText();
  for (const member of partRoom.members) assert.ok(partText.includes(member.name), `missing participant ${member.name}`);
  await page.screenshot({ path: path.join(out, "03-part-room.png") });

  // 真实往来：退回 / 咨询 / 判定 / 纠错至少各有一条落在某个群里。
  const kinds = await page.evaluate(async () => {
    const state = await (await fetch("/api/state")).json();
    return state?.comms ?? [];
  });
  const seenKinds = new Set(kinds.map((entry) => entry.kind));
  for (const kind of ["consult", "verdict", "return", "correction", "channel"]) {
    assert.ok(seenKinds.has(kind), `真实运行应当产生 ${kind} 往来，实际只有 ${[...seenKinds].join("、")}`);
  }
  // 一条消息只出现在最贴切的那个群里：各群行数之和不能超过真实往来条数。
  const projection = await page.evaluate(async () => {
    const [mod, look, store] = await Promise.all([import("/src/chat/rooms.ts"), import("/src/chat/station-look.ts"), import("/src/store.ts")]);
    const state = store.getState();
    const rooms = mod.deriveRooms(state.factory, Object.values(state.fs.consults ?? {}).map((c) => ({ reviewer: c.reviewer, owner: c.owner })));
    const ctx = { factory: state.factory, state: state.fs, look: look.stationLook(state.factory, state.fs, state.layout.bots, Date.now()), now: Date.now() };
    const perRoom = rooms.filter((room) => room.kind !== "root").map((room) => [room.name, mod.buildRoomLines(room, rooms, ctx)]);
    const lines = perRoom.flatMap(([, room]) => room);
    return { comms: (state.fs.comms ?? []).length, lines: lines.length, unique: new Set(lines.map((line) => line.id)).size, perRoom: perRoom.filter(([, room]) => room.length).map(([name, room]) => [name, room.length]) };
  });
  assert.equal(projection.unique, projection.lines, `同一条往来不能在多个群里重复出现：${JSON.stringify(projection)}`);
  assert.ok(projection.lines > 0 && projection.lines <= projection.comms, `群里的行应当来自真实往来：${JSON.stringify(projection)}`);

  await showList();
  const routed = await page.evaluate(() => [...document.querySelectorAll('.talk-list .talk-row')].map((item) => ({
    id: item.dataset.room,
    name: item.querySelector('.talk-top b')?.textContent ?? '',
    preview: item.querySelector('.talk-sub > span')?.textContent ?? '',
  })));
  const withTraffic = routed.filter(room => trafficIds.includes(room.id));
  assert.ok(withTraffic.length >= 3, `往来应当落在多个群里：${JSON.stringify(routed)}`);
  assert.ok(withTraffic.some((room) => /纠错|交付|退回|复查|要求改|闭环/.test(room.preview)), `群组预览要显示真实说过的话：${JSON.stringify(withTraffic)}`);
  assert.ok(withTraffic.some((room) => room.preview.includes("交付")), `跨线交付要落到跨段群里：${JSON.stringify(withTraffic)}`);

  // 点开有往来的那个群：行必须是真实事件，而且要能看出说了什么。
  assert.ok(withTraffic.length > 0, 'at least one room has real traffic');
  await rail.locator(`[data-room="${withTraffic[0].id}"]`).click();
  await page.locator('.room-intro').waitFor();
  const verbs = await page.locator('.bub-verb').allInnerTexts();
  assert.ok(verbs.length > 0, "有往来的群里必须有行");
  assert.ok(verbs.some((v) => ["提出修改", "退回", "判定", "交付", "纠错"].includes(v)), `群里的行要说清楚是什么往来：${verbs.join("、")}`);
  await page.screenshot({ path: path.join(out, "05-room-traffic.png") });

  await page.getByRole('button', {name: '收起对话', exact: true}).click();
  await page.locator('.chat.is-collapsed').waitFor();
  assert.equal(await page.locator('.composer textarea').isVisible(), false);
  await page.screenshot({ path: path.join(out, "04-rail-narrow.png") });
  await page.keyboard.press('Control+k');
  await page.locator('.composer textarea').waitFor();
  assert.equal(await page.locator('.composer textarea').inputValue(), '切换群组时保留主调度草稿');

  assert.deepEqual(errors, [], "界面不应有未捕获错误");
  console.log(JSON.stringify({
    ok: true, rooms: count, seeds: seeded,
    lanes,
    kinds: [...seenKinds], withTraffic,
  }, null, 2));
  console.log(`screenshots: ${out}`);
  }
} finally {
  await browser?.close();
  await server?.close();
  const absolute = path.resolve(directory), base = path.resolve(os.tmpdir()) + path.sep;
  if (!absolute.startsWith(base) || !path.basename(absolute).startsWith("easy-ui-rooms-")) throw new Error("unsafe cleanup path");
  await fs.rm(absolute, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
