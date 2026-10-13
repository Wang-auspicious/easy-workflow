import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { instantiateWorkflowTemplate, listWorkflowTemplates } from '../server/templates.ts';
import { installWorkflowPack, loadWorkflowPacks, readWorkflowIndex, addWorkflowLine, type WorkflowManifest, type WorkflowServices } from '../server/workflow-packs.ts';
import { invokeWorkflowTool, describeWorkflowTool } from '../server/workflow-tools.ts';
import { compile } from '../server/spec/compile.ts';
import { station, line } from '../server/spec/dsl.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-packs-'));
process.env.FACTORY_VAR = root;
const { Runtime } = await import('../server/runtime.ts');
const { Journal } = await import('../server/journal.ts');
const { Broker } = await import('../server/broker.ts');
const { initialState, apply } = await import('../shared/project.ts');
const { closeNetwork } = await import('../server/network.ts');
const idle = { running: false };
after(async () => { await closeNetwork(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });

test('all four templates compile and execute their concrete programs, review returns and selected branches', async () => {
  const dir = path.join(root, 'templates');
  for (const template of listWorkflowTemplates()) await instantiateWorkflowTemplate(dir, { templateId: template.id, id: template.id, name: template.name, includeBuiltins: false }, idle);
  let reviews = 0, productions = 0, collects = 0;
  const loaded = await loadWorkflowPacks(dir, { services: {
    runAgent: async (def, ctx) => {
      assert.match(def.role.path, /^packs\//); assert.ok(def.role.content.length > 40);
      const input = JSON.parse((await def.input(ctx)).text);
      const output = ctx.node.key === 'review-loop/produce' ? (productions++, { title: 'Fixture report', body: 'A concrete report that satisfies the supplied requirement.' })
        : ctx.node.key === 'review-loop/review' ? (++reviews === 1 ? { verdict: 'return', reason: 'state the requirement explicitly', issues: ['requirement needs a concrete statement'] } : { verdict: 'pass', reason: 'each requirement was checked', issues: [] })
        : ctx.node.key.endsWith('/classify') ? { kind: 'unknown', value: input.value }
        : { verdict: 'pass', reason: 'source matches the captured page', issues: [] };
      assert.deepEqual(def.check?.(output, ctx) ?? [], []);
      return def.after(output, ctx, { rounds: 0, issues: [] });
    },
    callCapability: async (name, args, ctx) => { ctx.signal.throwIfAborted(); assert.equal(name, 'page_text'); collects++; return { ok: true, finalUrl: args.url, title: 'Fixture source', text: 'The fixture source contains actual supplied evidence.', via: 'browser-fixture' }; },
  } });
  const compiled = compile(loaded.packs); assert.deepEqual(compiled.issues, []);
  assert.ok(compiled.nodes.every(node => !node.key.startsWith('curation/')));
  const journal = new Journal(':memory:'), state = initialState(compiled), broker = new Broker({ model: 4, cpu: 2, browser: 2, http: 2 }, 0);
  journal.subscribeProjection(event => apply(state, event));
  const runtime = new Runtime(compiled, journal, broker, loaded.conditions, loaded.executor); runtime.roleResolver = key => loaded.role(key)!;
  try {
    runtime.ensureWorkers([]); runtime.start('concrete templates');
    const inputs = [
      ['review-loop', { brief: 'Write a concise fixture report with an explicit conclusion.', requirements: ['State the conclusion.'] }],
      ['fanout', { text: 'Alpha beta alpha\n\nGamma' }],
      ['collect', { url: 'https://fixture.test/source' }],
      ['triage', { value: 'A sufficiently long text that belongs in the analysis line.' }],
      ['triage', { value: 'https://fixture.test/linked' }],
      ['triage', { value: '?' }],
    ] as const;
    const tokens = inputs.map(([id, input], i) => runtime.create(loaded.manifests.find(pack => pack.id === id)!.entry, { item: `${id}-${i}`, url: '', source: 'manual', data: { input } }));
    await runtime.settle();
    assert.deepEqual(tokens.map(token => state.tokens[token.id].status), ['published', 'published', 'published', 'published', 'published', 'manual']);
    assert.equal(productions, 2); assert.equal(reviews, 2); assert.equal(collects, 2);
    assert.deepEqual(tokens[1].data.statistics, { characters: 23, words: 4, paragraphs: 2 });
    const report = tokens[1].data.report as { keywords: { word: string; count: number }[] }; assert.deepEqual(report.keywords[0], { word: 'alpha', count: 2 });
    assert.equal(tokens[3].done.has('triage-link/collect'), false); assert.equal(tokens[4].done.has('triage-text/prepare'), false);
    for (const token of tokens.slice(0, -1)) {
      const artifact = Object.values(token.data).find(value => value && typeof value === 'object' && 'sha256' in value) as { path: string; sha256: string; bytes: number };
      assert.ok(artifact); const file = path.join(dir, artifact.path); assert.equal(fs.statSync(file).size, artifact.bytes);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).item, token.item);
    }
    const reload = await loadWorkflowPacks(dir); assert.equal(compile(reload.packs).digest, compiled.digest);
  } finally { await runtime.close(); journal.close(); }
});

test('install is idle-only, rejects missing contracts and keeps the last valid index after failure', async () => {
  const dir = path.join(root, 'validation');
  const manifest = await instantiateWorkflowTemplate(dir, { templateId: 'fanout', id: 'analysis', name: 'Analysis', includeBuiltins: false }, idle);
  const before = fs.readFileSync(path.join(dir, 'packs/installed.json'), 'utf8');
  for (const guard of [{ running: true }, { running: false, paused: true }, { running: false, ending: true }, { running: false, inflight: 1 }]) await assert.rejects(() => instantiateWorkflowTemplate(dir, { templateId: 'fanout', id: 'extra', name: 'Extra' }, guard), /先结束/);
  const installed = readWorkflowIndex(dir).packages[0], directory = path.join(dir, 'packs', installed.id, 'versions', installed.revision);
  const files = Object.fromEntries(Object.values(manifest.bindings).map(binding => [binding.role, fs.readFileSync(path.join(directory, binding.role), 'utf8')]));
  const missing = structuredClone(manifest); delete missing.bindings['analysis/statistics'];
  await assert.rejects(() => installWorkflowPack(dir, { manifest: missing, files, replace: true }, idle), /requires role/);
  await assert.rejects(() => installWorkflowPack(dir, { manifest, files: {}, replace: true }, idle), /缺少包文件/);
  await assert.rejects(() => installWorkflowPack(dir, { manifest, files: { ...files, '../outside.txt': 'bad' }, replace: true }, idle), /相对路径/);
  assert.equal(fs.readFileSync(path.join(dir, 'packs/installed.json'), 'utf8'), before);
  const extra = line({ id: 'extra', name: 'Additional analysis', layer: 3, priority: 'low', blurb: 'New concrete line', wired: true, stations: [station({ id: 'count', name: 'Count text', kind: 'program', role: 'process', resource: 'none', accept: ['Return real word and character counts'] }), station({ id: 'published', name: 'Done', kind: 'store', role: 'store' })], edges: [['count', 'published']] });
  const updated = await addWorkflowLine(dir, manifest.id, { line: extra, schemas: {}, bindings: { 'extra/count': { role: 'roles/extra/count/ROLE.md', inputSchema: 'text', outputSchema: 'statistics', input: { text: { path: 'input.text' } }, outputKey: 'extraCounts', execute: { kind: 'builtin', name: 'text-statistics' } } }, files: { 'roles/extra/count/ROLE.md': '# Count input text\n\nCount real Unicode characters, whitespace separated words and paragraphs. Reject missing input instead of inventing empty results.' } }, idle);
  assert.equal(updated.lines.length, 2); assert.ok((await loadWorkflowPacks(dir)).executor(compile((await loadWorkflowPacks(dir)).packs).nodes.find(node => node.key === 'extra/count')!));
});

test('external CLI, HTTP, Node and MCP adapters execute declared contracts; MCP schemas are discovered per call', async () => {
  const dir = path.join(root, 'external'), packDir = path.join(dir, 'pack'), workDir = path.join(dir, 'work'); fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'cli.mjs'), "let s='';for await(const c of process.stdin)s+=c;const i=JSON.parse(s);process.stdout.write(JSON.stringify({value:i.value*2}));");
  fs.writeFileSync(path.join(packDir, 'mcp.mjs'), "import readline from 'node:readline';for await(const s of readline.createInterface({input:process.stdin})){const m=JSON.parse(s);if(!m.id)continue;let result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}}}:m.method==='tools/list'?{tools:[{name:'double',inputSchema:{type:'object',properties:{value:{type:'number'}},required:['value'],additionalProperties:false}}]}:{structuredContent:{value:m.params.arguments.value*2}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}");
  const controller = new AbortController(), context = { signal: controller.signal, workDir, packDir };
  assert.deepEqual(await invokeWorkflowTool({ kind: 'cli', command: '$node', args: ['$pack/cli.mjs'] }, { value: 7 }, context), { value: 14 });
  const mcp = { kind: 'mcp' as const, command: '$node', args: ['$pack/mcp.mjs'], tool: 'double' };
  assert.equal((await describeWorkflowTool(mcp, context) as { name: string }).name, 'double');
  assert.deepEqual(await invokeWorkflowTool(mcp, { value: 8 }, context), { value: 16 });
  await assert.rejects(invokeWorkflowTool(mcp, { value: 'wrong type' }, context), /当前参数 schema/);
  const server = http.createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ value: JSON.parse(body).value * 3 })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { assert.deepEqual(await invokeWorkflowTool({ kind: 'http', url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }, { value: 9 }, context), { value: 27 }); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  fs.writeFileSync(path.join(packDir, 'hang.mjs'), 'setInterval(()=>{},1000);');
  const cancelled = invokeWorkflowTool({ kind: 'cli', command: '$node', args: ['$pack/hang.mjs'] }, {}, context);
  await delay(50); controller.abort(new Error('fixture owner cancellation'));
  await assert.rejects(cancelled, /fixture owner cancellation/);
});

test('Node exports, accepted patches and live-idle guards are checked before changing the installed index', async () => {
  const dir = path.join(root, 'node-validation');
  const manifest = await instantiateWorkflowTemplate(dir, { templateId: 'fanout', id: 'node-analysis', name: 'Node analysis', includeBuiltins: false }, idle);
  const indexFile = path.join(dir, 'packs', 'installed.json'), before = fs.readFileSync(indexFile, 'utf8');
  const revision = readWorkflowIndex(dir).packages[0], directory = path.join(dir, 'packs', revision.id, 'versions', revision.revision);
  const files = Object.fromEntries(Object.values(manifest.bindings).map(binding => [binding.role, fs.readFileSync(path.join(directory, binding.role), 'utf8')]));
  manifest.bindings['node-analysis/statistics'].execute = { kind: 'node', module: 'tools/count.mjs' };
  await assert.rejects(installWorkflowPack(dir, { manifest, files: { ...files, 'tools/count.mjs': 'export const execute = 42;' }, replace: true }, idle), /缺少声明的执行函数/);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), before);
  const code = 'export function execute(input){return {characters:[...input.text].length,words:input.text.split(/\\s+/).length,paragraphs:1};}';
  fs.writeFileSync(path.join(dir, 'patches.json'), JSON.stringify([{ id: 'bad-existing-patch', status: 'accepted', ops: [{ op: 'set', station: 'missing/station', field: 'name', value: 'Missing' }] }]));
  await assert.rejects(installWorkflowPack(dir, { manifest, files: { ...files, 'tools/count.mjs': code }, replace: true }, idle), /unknown station/);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), before); fs.rmSync(path.join(dir, 'patches.json'));
  let busy = false;
  const slow = installWorkflowPack(dir, { manifest, files: { ...files, 'tools/count.mjs': 'await new Promise(resolve=>setTimeout(resolve,50));' + code }, replace: true }, { running: false, assertIdle: () => { if (busy) throw new Error('fixture started while validating'); } });
  await delay(10); busy = true;
  await assert.rejects(slow, /started while validating/); assert.equal(fs.readFileSync(indexFile, 'utf8'), before);
  await installWorkflowPack(dir, { manifest, files: { ...files, 'tools/count.mjs': code }, replace: true }, idle);
  const loaded = await loadWorkflowPacks(dir), node = compile(loaded.packs).nodes.find(node => node.key === 'node-analysis/statistics')!;
  const result = await loaded.executor(node)!({ token: { id: 'node-test', item: 'node-test', data: { normalized: { text: 'one two' } } }, node, signal: new AbortController().signal, progress: () => {} } as any);
  assert.deepEqual(result.data?.statistics, { characters: 7, words: 2, paragraphs: 1 });
  const concurrent = path.join(root, 'concurrent-install');
  await Promise.all(['first', 'second'].map(id => instantiateWorkflowTemplate(concurrent, { templateId: 'fanout', id, name: id, includeBuiltins: false }, idle)));
  assert.deepEqual(readWorkflowIndex(concurrent).packages.map(pack => pack.id), ['first', 'second']);
});
