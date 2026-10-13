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
import type {StationAgentBinding} from '../shared/types.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-packs-'));
process.env.FACTORY_VAR = root;
const { Runtime } = await import('../server/runtime.ts');
const { Journal } = await import('../server/journal.ts');
const { Broker } = await import('../server/broker.ts');
const { initialState, apply } = await import('../shared/project.ts');
const { closeNetwork } = await import('../server/network.ts');
const idle = { running: false };
after(async () => { await closeNetwork(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });

function outputWriterFixture(id: string) {
  const textSchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
  const files: Record<string, string> = {};
  const bindings: WorkflowManifest['bindings'] = {};
  const nodes = ['entry', 'left', 'right', 'publish'].map(key => {
    const role = `roles/${key}/ROLE.md`;
    files[role] = `# ${key} fixture contract\n\nProcess only the supplied input and return the declared output schema. Preserve the actual result and reject missing input instead of inventing a successful handoff.`;
    bindings[`${id}/${key}`] = key === 'publish'
      ? { role, inputSchema: 'publication', outputSchema: 'artifact', input: { result: { path: 'result' } }, outputKey: 'artifact', execute: { kind: 'builtin', name: 'publish-json' } }
      : { role, inputSchema: 'text', outputSchema: 'text', input: { text: key === 'entry' ? { path: 'input.text' } : { value: `${key} branch` } }, outputKey: key === 'entry' ? 'normalized' : 'result', execute: { kind: 'builtin', name: 'normalize-text' } };
    return station({ id: key, name: key, role: 'process', kind: 'program', resource: 'none', input: 'text', output: 'text', accept: ['Return the supplied text under the declared output key'] });
  });
  nodes.push(station({ id: 'published', name: 'Published', role: 'store', kind: 'store', input: 'text', output: 'text' }));
  const manifest: WorkflowManifest = { format: 1, id, name: id, version: '1', blurb: 'Output collision fixture', entry: `${id}/entry`, inputSchema: 'text',
    lines: [line({ id, name: id, layer: 3, priority: 'mid', wired: true, blurb: 'Parallel data writers', stations: nodes, edges: [['entry', 'left'], ['entry', 'right'], ['left', 'publish'], ['right', 'publish'], ['publish', 'published']] })],
    links: [], channels: [], conditions: {}, resources: { browser: 0, model: 0, cpu: 0, http: 0 }, bindings,
    schemas: { text: textSchema, publication: { type: 'object', properties: { result: textSchema }, required: ['result'], additionalProperties: false }, artifact: { type: 'object', properties: { path: { type: 'string' }, sha256: { type: 'string' }, bytes: { type: 'number' } }, required: ['path', 'sha256', 'bytes'], additionalProperties: false } } };
  return { manifest, files };
}

test('parallel workflow writers are rejected before replacing the installed index and on reload', async () => {
  const dir = path.join(root, 'output-collision'), request = outputWriterFixture('collision');
  const valid = structuredClone(request);
  valid.manifest.bindings['collision/right'].outputKey = 'rightResult';
  await installWorkflowPack(dir, valid, idle);
  const indexFile = path.join(dir, 'packs/installed.json'), before = fs.readFileSync(indexFile, 'utf8');
  // Before this guard, both writers started before either committed and the token
  // published successfully with only {text:'right branch'} left under result.
  await assert.rejects(installWorkflowPack(dir, { ...request, replace: true }, idle), /collision\/left, collision\/right.*outputKey "result"/);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), before);
  const invalidKey = structuredClone(valid);
  invalidKey.manifest.bindings['collision/right'].outputKey = ['result'] as unknown as string;
  await assert.rejects(installWorkflowPack(dir, { ...invalidKey, replace: true }, idle), /工位绑定 collision\/right 无效/);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), before);

  const installed = readWorkflowIndex(dir).packages[0], file = path.join(dir, 'packs', installed.id, 'versions', installed.revision, 'pack.json');
  const original = fs.readFileSync(file, 'utf8');
  try {
    fs.writeFileSync(file, JSON.stringify(request.manifest));
    await assert.rejects(loadWorkflowPacks(dir), /并行工位.*outputKey "result"/);
  } finally { fs.writeFileSync(file, original); }
});

test('ordered replacement and independent token entries keep their actual data semantics', async () => {
  for (const variant of ['ordered', 'independent']) {
    const dir = path.join(root, `output-${variant}`), request = outputWriterFixture(variant);
    request.manifest.lines[0].edges = variant === 'ordered'
      ? [{ from: 'entry', to: 'left' }, { from: 'left', to: 'right' }, { from: 'right', to: 'publish' }, { from: 'publish', to: 'published' }]
      : request.manifest.lines[0].edges.filter(edge => !(edge.from === 'entry' && edge.to === 'right'));
    if (variant === 'independent') request.manifest.channels = [{ id: 'deliver-independent', from: { line: variant, station: 'left' }, to: { line: variant, station: 'right' }, label: 'A separate consumer token' }];
    await installWorkflowPack(dir, request, idle);
    const loaded = await loadWorkflowPacks(dir), compiled = compile(loaded.packs);
    assert.deepEqual(compiled.issues, []);
    const journal = new Journal(':memory:'), state = initialState(compiled), broker = new Broker({ model: 0, browser: 0, cpu: 0, http: 0 }, 0);
    journal.subscribeProjection(event => apply(state, event));
    const runtime = new Runtime(compiled, journal, broker, loaded.conditions, loaded.executor);
    runtime.roleResolver = key => loaded.role(key)!;
    try {
      runtime.ensureWorkers([]); runtime.start(variant);
      const entries = variant === 'ordered' ? [request.manifest.entry] : [request.manifest.entry, `${variant}/right`];
      const tokens = entries.map((entry, index) => runtime.create(entry, { item: `${variant}-${index}`, url: '', source: 'manual', data: { input: { text: 'original' } } }));
      await runtime.settle();
      assert.deepEqual(tokens.map(token => state.tokens[token.id].status), tokens.map(() => 'published'));
      assert.deepEqual(tokens.map(token => token.data.result), variant === 'ordered' ? [{ text: 'right branch' }] : [{ text: 'left branch' }, { text: 'right branch' }]);
      for (const token of tokens) {
        const artifact = token.data.artifact as { path: string };
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, artifact.path), 'utf8')).result, token.data.result);
      }
      if (tokens.length > 1) assert.notEqual(tokens[0].data, tokens[1].data);
    } finally { await runtime.close(); journal.close(); }
  }
});

test('accepted graph patches and cross-pack flow links cannot introduce output races', async () => {
  const dir = path.join(root, 'output-patches'), request = outputWriterFixture('ordered-patch');
  request.manifest.lines[0].edges = [{ from: 'entry', to: 'left' }, { from: 'left', to: 'right' }, { from: 'right', to: 'publish' }, { from: 'publish', to: 'published' }];
  await installWorkflowPack(dir, request, idle);
  const loaded = await loadWorkflowPacks(dir);
  const changed = compile(loaded.packs, [{ id: 'parallelize', summary: 'Parallelize the two writers', author: 'user', at: 'fixture', status: 'accepted', ops: [
    { op: 'remove-edge', from: 'ordered-patch/left', to: 'ordered-patch/right' },
    { op: 'add-edge', from: 'ordered-patch/entry', to: 'ordered-patch/right' },
    { op: 'add-edge', from: 'ordered-patch/left', to: 'ordered-patch/publish' },
  ] }]);
  assert.ok(changed.issues.some(issue => issue.message.includes('outputKey "result"')));

  const extra = outputWriterFixture('other-pack');
  extra.manifest.lines[0].edges = structuredClone(request.manifest.lines[0].edges);
  await installWorkflowPack(dir, extra, idle);
  const before = fs.readFileSync(path.join(dir, 'packs/installed.json'), 'utf8');
  extra.manifest.links = [{ from: 'ordered-patch/entry', to: 'other-pack/entry' }];
  await assert.rejects(installWorkflowPack(dir, { ...extra, replace: true }, idle), /并行工位.*outputKey "result"/);
  assert.equal(fs.readFileSync(path.join(dir, 'packs/installed.json'), 'utf8'), before);
});

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

test('workflow Agent defaults are validated, versioned and forwarded without changing other stations', async () => {
  const dir = path.join(root, 'station-agent-bindings');
  const manifest = await instantiateWorkflowTemplate(dir, {templateId: 'review-loop', id: 'bound-agents', name: 'Bound Agent fixture', includeBuiltins: false}, idle);
  const installed = readWorkflowIndex(dir).packages[0];
  const directory = path.join(dir, 'packs', installed.id, 'versions', installed.revision);
  const files = Object.fromEntries(Object.values(manifest.bindings).map(binding => [binding.role, fs.readFileSync(path.join(directory, binding.role), 'utf8')]));
  const bindings: StationAgentBinding[] = [
    {adapter: 'pi', provider: 'fixture-provider', model: 'fixture-pi'},
    {adapter: 'claude-code', command: ['claude'], model: 'fixture-claude', requestTimeoutMs: 12000},
    {adapter: 'launcher', command: ['node', 'fixture-launcher.mjs'], model: 'fixture-launcher'},
  ];
  const revisions = new Set<string>();
  for (const agent of bindings) {
    const request = structuredClone(manifest);
    const producer = request.bindings['bound-agents/produce'].execute;
    assert.equal(producer.kind, 'agent');
    if (producer.kind !== 'agent') throw new Error('Fixture producer is not an Agent');
    producer.agent = agent.adapter === 'pi' ? {...agent, provider: ` ${agent.provider} `, model: ` ${agent.model} `} : agent;
    const normalizedManifest = await installWorkflowPack(dir, {manifest: request, files, replace: true}, idle);
    const seen = new Map<string, StationAgentBinding | undefined>();
    const loaded = await loadWorkflowPacks(dir, {services: {runAgent: async (definition, ctx) => {
      seen.set(ctx.node.key, definition.agent);
      const output = ctx.node.key.endsWith('/produce')
        ? {title: 'Fixture document', body: 'The supplied fixture requirement has been fulfilled explicitly.'}
        : {verdict: 'pass', reason: 'The supplied requirement was checked.', issues: []};
      return definition.after(output, ctx, {rounds: 1, issues: []});
    }}});
    revisions.add(loaded.role('bound-agents/produce')!.revision);
    const compiled = compile(loaded.packs);
    const journal = new Journal(':memory:');
    const state = initialState(compiled);
    journal.subscribeProjection(event => apply(state, event));
    const runtime = new Runtime(compiled, journal, new Broker({model: 2, cpu: 1}, 0), loaded.conditions, loaded.executor);
    runtime.roleResolver = key => loaded.role(key)!;
    try {
      runtime.ensureWorkers([]);
      runtime.start('Workflow binding fixture');
      const token = runtime.create(manifest.entry, {item: agent.adapter, url: '', source: 'manual', data: {input: {brief: 'Produce the supplied fixture requirement explicitly.', requirements: ['State the requirement.']}}});
      await runtime.settle();
      assert.equal(state.tokens[token.id].status, 'published');
      assert.deepEqual(seen.get('bound-agents/produce'), agent);
      assert.equal(seen.has('bound-agents/review'), true);
      assert.equal(seen.get('bound-agents/review'), undefined, 'the reviewer keeps its existing inherited default');
      const reloaded = await loadWorkflowPacks(dir);
      assert.equal(reloaded.role('bound-agents/produce')!.revision, loaded.role('bound-agents/produce')!.revision);
    } finally {
      await runtime.close();
      journal.close();
    }
    if (agent.adapter === 'pi') {
      await installWorkflowPack(dir, {manifest: normalizedManifest, files, replace: true}, idle);
      const normalizedReload = await loadWorkflowPacks(dir);
      assert.equal(normalizedReload.role('bound-agents/produce')!.revision, loaded.role('bound-agents/produce')!.revision,
        'equivalent normalized defaults keep the same station revision after reinstall and reload');
    }
  }
  assert.equal(revisions.size, 3, 'changing the adapter participates in the station contract revision');
  const indexFile = path.join(dir, 'packs/installed.json');
  const before = fs.readFileSync(indexFile, 'utf8');
  for (const agent of [null, {adapter: 'unsupported'}, {adapter: 'pi', command: ['claude']},
    {adapter: 'claude-code', command: 'claude', model: 'fixture'},
    {adapter: 'claude-code', command: [], model: 'fixture'},
    {adapter: 'launcher', command: ['node'], model: ''},
    {adapter: 'launcher', command: ['node'], model: 'fixture', requestTimeoutMs: 0}]) {
    const invalid = structuredClone(manifest);
    Object.assign(invalid.bindings['bound-agents/produce'].execute, {agent});
    await assert.rejects(installWorkflowPack(dir, {manifest: invalid, files, replace: true}, idle), /Agent 配置无效/);
    assert.equal(fs.readFileSync(indexFile, 'utf8'), before);
  }
  const program = structuredClone(manifest);
  Object.assign(program.bindings['bound-agents/publish'].execute, {agent: {adapter: 'pi'}});
  await assert.rejects(installWorkflowPack(dir, {manifest: program, files, replace: true}, idle), /程序执行器/);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), before);
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
  const journal = new Journal(path.join(dir, 'journal.db'));
  const controller = new AbortController(), context = { signal: controller.signal, workDir, packDir,
    operation: {journal, token: {id: 'external-fixture', data: {}}, node: 'external/execute', revision: 'fixture-1'},
  };
  try {
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
  } finally { journal.close(); }
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

test('external POST with a lost response is not repeated after a new journal and retry token', async () => {
  const dir = path.join(root, 'effect-unknown');
  let journal = new Journal(path.join(dir, 'journal.db'));
  let writes = 0;
  const server = http.createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    writes++;
    response.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as {port: number}).port;
  const tool = {kind: 'http' as const, url: `http://127.0.0.1:${port}/effect`};
  const context = () => ({
    signal: new AbortController().signal,
    workDir: path.join(dir, 'work'),
    packDir: dir,
    operation: {journal, token: {id: 'original', data: {}}, node: 'fixture/publish', revision: 'version-1'},
  });
  try {
    await assert.rejects(invokeWorkflowTool(tool, {value: 7}, context()));
    journal.close(); journal = new Journal(path.join(dir, 'journal.db'));
    const retry = context();
    retry.operation.token = {id: 'retry', data: {retryOf: 'original'}};
    await assert.rejects(invokeWorkflowTool(tool, {value: 7}, retry));
    assert.equal(writes, 1, 'a transport error cannot prove that the remote write did not occur');
    const receipts = [...journal.read()].filter(event => event.kind === 'operation.recorded');
    assert.equal(receipts.at(-1)?.operation.phase, 'uncertain');
  } finally {
    journal.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('completed external results survive restart and are reused for the same version and canonical input', async t => {
  const dir = path.join(root, 'effect-completed');
  let journal = new Journal(path.join(dir, 'journal.db'));
  let writes = 0;
  const server = http.createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    writes++;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({receipt: writes}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as {port: number}).port;
  const tool = {kind: 'http' as const, url: `http://127.0.0.1:${port}/effect`};
  const context = () => ({
    signal: new AbortController().signal, workDir: path.join(dir, 'work'), packDir: dir,
    operation: {journal, token: {id: 'original', data: {}}, node: 'fixture/publish', revision: 'version-1'},
  });
  try {
    assert.deepEqual(await invokeWorkflowTool(tool, {a: 1, b: 2}, context()), {receipt: 1});
    journal.close(); journal = new Journal(path.join(dir, 'journal.db'));
    t.mock.method(String.prototype, 'localeCompare', () => 0);
    const retry = context();
    retry.operation.token = {id: 'retry', data: {retryOf: 'original'}};
    assert.deepEqual(await invokeWorkflowTool(tool, {b: 2, a: 1}, retry), {receipt: 1});
    assert.equal(writes, 1);
  } finally {
    journal.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('CLI side effects with invalid output stay uncertain and cannot spawn again on retry', async () => {
  const dir = path.join(root, 'effect-cli');
  fs.mkdirSync(dir, {recursive: true});
  const countFile = path.join(dir, 'effects.txt');
  fs.writeFileSync(path.join(dir, 'effect.mjs'), "import fs from 'node:fs';for await(const c of process.stdin){}fs.appendFileSync(process.argv[2],'effect\\n');process.stdout.write('lost-json-result');");
  const tool = {kind: 'cli' as const, command: '$node', args: ['$pack/effect.mjs', countFile]};
  let journal = new Journal(path.join(dir, 'journal.db'));
  const context = () => ({
    signal: new AbortController().signal, workDir: path.join(dir, 'work'), packDir: dir,
    operation: {journal, token: {id: 'original', data: {}}, node: 'fixture/cli', revision: 'v1'},
  });
  try {
    await assert.rejects(invokeWorkflowTool(tool, {}, context()), {code: 'EXTERNAL_OPERATION_UNKNOWN'});
    journal.close(); journal = new Journal(path.join(dir, 'journal.db'));
    const retry = context();
    retry.operation.token = {id: 'retry', data: {retryOf: 'original'}};
    await assert.rejects(invokeWorkflowTool(tool, {}, retry), {code: 'EXTERNAL_OPERATION_UNKNOWN'});
    assert.equal(fs.readFileSync(countFile, 'utf8'), 'effect\n');
    assert.equal([...journal.read()].filter(event => event.kind === 'operation.recorded').at(-1)?.operation.phase, 'uncertain');
  } finally { journal.close(); }
});

test('local CLI preflight errors do not create an uncertain effect or launch a child', async () => {
  const dir = path.join(root, 'effect-cli-preflight');
  const journal = new Journal(path.join(dir, 'journal.db'));
  const context = {
    signal: new AbortController().signal, workDir: path.join(dir, 'work'), packDir: dir,
    operation: {journal, token: {id: 'preflight-work', data: {}}, node: 'fixture/cli', revision: 'v1'},
  };
  const command = {kind: 'cli' as const, command: '$node', args: ['-e', "throw new Error('child must not launch')"]};
  try {
    assert.equal(process.env.EASY_WORKFLOW_FIXTURE_MISSING_ENV_950F2B, undefined);
    await assert.rejects(invokeWorkflowTool({...command, envFrom: {REQUIRED: 'EASY_WORKFLOW_FIXTURE_MISSING_ENV_950F2B'}}, {}, context), /缺少环境变量/);
    const invalidDirectory = path.join(dir, 'file-instead-of-directory');
    fs.writeFileSync(invalidDirectory, 'fixture file');
    await assert.rejects(invokeWorkflowTool(command, {}, {...context, workDir: invalidDirectory}));
    const cyclic: {self?: unknown} = {};
    cyclic.self = cyclic;
    await assert.rejects(invokeWorkflowTool(command, cyclic, context), {code: 'workflow_input_invalid'});
    assert.equal([...journal.read()].filter(event => event.kind === 'operation.recorded').length, 0);
  } finally { journal.close(); }
});

test('a receipt write failure leaves durable intent that prevents re-execution after restart', async () => {
  const dir = path.join(root, 'effect-receipt-fault');
  let journal = new Journal(path.join(dir, 'journal.db'));
  let writes = 0;
  const server = http.createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    writes++;
    response.end(JSON.stringify({receipt: writes}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const tool = {kind: 'http' as const, url: `http://127.0.0.1:${(server.address() as {port: number}).port}/effect`};
  const context = () => ({
    signal: new AbortController().signal, workDir: dir, packDir: dir,
    operation: {journal, token: {id: 'original', data: {}}, node: 'fixture/publish', revision: 'v1'},
  });
  try {
    const append = journal.append.bind(journal);
    journal.append = event => {
      if (event.kind === 'operation.recorded' && event.operation.phase !== 'started') throw new Error('Fixture storage unavailable after external effect');
      return append(event);
    };
    await assert.rejects(invokeWorkflowTool(tool, {value: 1}, context()), {code: 'EXTERNAL_OPERATION_UNKNOWN'});
    assert.equal(writes, 1);
    assert.deepEqual([...journal.read()].filter(event => event.kind === 'operation.recorded').map(event => event.operation.phase), ['started']);
    journal.close(); journal = new Journal(path.join(dir, 'journal.db'));
    await assert.rejects(invokeWorkflowTool(tool, {value: 1}, context()), {code: 'EXTERNAL_OPERATION_UNKNOWN'});
    assert.equal(writes, 1);
    assert.equal([...journal.read()].filter(event => event.kind === 'operation.recorded').at(-1)?.operation.reason, 'interrupted');
  } finally {
    journal.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('intent must commit before I/O, while changed input, version and independent work get distinct effects', async () => {
  const dir = path.join(root, 'effect-identity');
  let journal = new Journal(path.join(dir, 'journal.db'));
  let writes = 0;
  const server = http.createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    writes++;
    response.end(JSON.stringify({receipt: writes}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const tool = {kind: 'http' as const, url: `http://127.0.0.1:${(server.address() as {port: number}).port}/effect`};
  const context = (id = 'original', data: Record<string, unknown> = {}, revision = 'v1') => ({
    signal: new AbortController().signal, workDir: dir, packDir: dir,
    operation: {journal, token: {id, data}, node: 'fixture/publish', revision},
  });
  try {
    const append = journal.append.bind(journal);
    journal.append = event => {
      if (event.kind === 'operation.recorded') throw new Error('Fixture intent write failed');
      return append(event);
    };
    await assert.rejects(invokeWorkflowTool(tool, {value: 1}, context()), /intent write failed/);
    assert.equal(writes, 0); journal.append = append;
    assert.deepEqual(await invokeWorkflowTool(tool, {value: 1}, context()), {receipt: 1});
    journal.append({kind: 'token.data', token: 'retry-1', patch: {retryOf: 'original'}});
    assert.deepEqual(await invokeWorkflowTool(tool, {value: 1, omitted: undefined}, context('retry-1', {retryOf: 'original'})), {receipt: 1});
    journal.close(); journal = new Journal(path.join(dir, 'journal.db'));
    assert.deepEqual(await invokeWorkflowTool(tool, {value: 1}, context('retry-2', {retryOf: 'retry-1'})), {receipt: 1});
    assert.deepEqual(await invokeWorkflowTool(tool, {value: 2}, context('retry-2', {retryOf: 'retry-1'})), {receipt: 2});
    assert.deepEqual(await invokeWorkflowTool(tool, {value: 2}, context('retry-2', {retryOf: 'retry-1'}, 'v2')), {receipt: 3});
    assert.deepEqual(await invokeWorkflowTool(tool, {value: 1}, context('fresh-work')), {receipt: 4});
    assert.deepEqual(await invokeWorkflowTool(tool, {value: 1}, context('child-1', {channelDelivery: 'delivery-1'})), {receipt: 5});
    assert.deepEqual(await invokeWorkflowTool(tool, {value: 1}, context('child-retry', {channelDelivery: 'delivery-1'})), {receipt: 5});
    assert.deepEqual(await invokeWorkflowTool(tool, {value: 1}, context('child-2', {channelDelivery: 'delivery-2'})), {receipt: 6});
    assert.equal(writes, 6);
  } finally {
    journal.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('HTTP GET and explicitly read-only MCP remain callable without a mutation ledger', async () => {
  const dir = path.join(root, 'effect-readonly');
  fs.mkdirSync(dir, {recursive: true});
  let reads = 0;
  const server = http.createServer((_request, response) => { reads++; response.end(JSON.stringify({read: reads})); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const context = {signal: new AbortController().signal, workDir: path.join(dir, 'work'), packDir: dir};
  try {
    const tool = {kind: 'http' as const, method: 'GET' as const, url: `http://127.0.0.1:${(server.address() as {port: number}).port}/read`};
    assert.deepEqual(await invokeWorkflowTool(tool, {}, context), {read: 1});
    assert.deepEqual(await invokeWorkflowTool(tool, {}, context), {read: 2});
    await assert.rejects(invokeWorkflowTool({...tool, method: 'POST'}, {}, context), {code: 'operation_context_required'});
    assert.equal(reads, 2);
    fs.writeFileSync(path.join(dir, 'readonly.mjs'), "import readline from 'node:readline';for await(const s of readline.createInterface({input:process.stdin})){const m=JSON.parse(s);if(!m.id)continue;const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}}}:m.method==='tools/list'?{tools:[{name:'read',annotations:{readOnlyHint:true},inputSchema:{type:'object'}}]}:{structuredContent:{read:true}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}");
    const mcp = {kind: 'mcp' as const, command: '$node', args: ['$pack/readonly.mjs'], tool: 'read'};
    assert.deepEqual(await invokeWorkflowTool(mcp, {}, context), {read: true});
    assert.deepEqual(await invokeWorkflowTool(mcp, {}, context), {read: true});
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a shared in-flight effect executes once and a cancelled waiter does not cancel its owner', async () => {
  const dir = path.join(root, 'effect-concurrent');
  const journal = new Journal(path.join(dir, 'journal.db'));
  let writes = 0;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const ready = new Promise<void>(resolve => { release = resolve; });
  const server = http.createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    writes++;
    entered();
    await ready;
    response.end(JSON.stringify({receipt: writes}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const tool = {kind: 'http' as const, url: `http://127.0.0.1:${(server.address() as {port: number}).port}/effect`};
  const context = {
    signal: new AbortController().signal, workDir: dir, packDir: dir,
    operation: {journal, token: {id: 'shared-work', data: {}}, node: 'fixture/publish', revision: 'v1'},
  };
  let first: Promise<unknown> | undefined;
  try {
    first = invokeWorkflowTool(tool, {value: 1}, context);
    await started;
    const controller = new AbortController();
    const second = invokeWorkflowTool(tool, {value: 1}, {...context, signal: controller.signal});
    controller.abort(new Error('Fixture cancelled duplicate waiter'));
    await assert.rejects(second, /cancelled duplicate waiter/);
    assert.equal(writes, 1);
    release();
    assert.deepEqual(await first, {receipt: 1});
    assert.deepEqual(await invokeWorkflowTool(tool, {value: 1}, context), {receipt: 1});
    assert.equal(writes, 1);
  } finally {
    release(); await first?.catch(() => {});
    journal.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Factory keeps an uncertain external write manual across restart and cancels sibling work', async () => {
  process.env.FACTORY_PREFLIGHT = '0';
  process.env.FACTORY_START_PAUSED = '1';
  process.env.FACTORY_RESUME_MANAGED = '0';
  process.env.VISLEXICON_ROOT = path.join(root, 'unconnected');
  const {Factory} = await import('../server/factory.ts');
  let writes = 0;
  const server = http.createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    writes++;
    response.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = outputWriterFixture('effect-runtime');
  request.manifest.bindings['effect-runtime/right'].outputKey = 'rightResult';
  request.manifest.bindings['effect-runtime/left'].execute = {kind: 'tool', tool: 'remote-write'};
  request.manifest.tools = {'remote-write': {kind: 'http', url: `http://127.0.0.1:${(server.address() as {port: number}).port}/effect`}};
  await installWorkflowPack(root, {...request, builtins: []}, idle);
  let factory = new Factory();
  let closed = false;
  let cancelledSibling = false;
  let recoveries = 0;
  const shutdown = async () => {
    factory.channels?.close(); await factory.runtime.close(); factory.docs.flush(); factory.lessons.close(); factory.journal.close(); closed = true;
  };
  try {
    await factory.boot(); factory.broker.memoryFloorMB = 0;
    const executor = factory.runtime.executors;
    factory.runtime.executors = node => node.key !== 'effect-runtime/right' ? executor(node) : async ctx => {
      await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => { cancelledSibling = true; resolve(); }, {once: true}));
      return {ok: true, summary: 'Cancelled sibling must not commit', data: {rightResult: 'must not publish'}};
    };
    factory.runtime.onRecovery = () => { recoveries++; };
    factory.runtime.start('External receipt recovery');
    const token = factory.runtime.create(request.manifest.entry, {item: 'effect-case', url: 'https://fixture.test', source: 'manual', data: {workflowPack: request.manifest.id, input: {text: 'fixture'}}});
    await factory.runtime.settle();
    assert.equal(factory.state.tokens[token.id].status, 'manual');
    assert.equal((factory.state.tokens[token.id].data.failure as {code: string}).code, 'EXTERNAL_OPERATION_UNKNOWN');
    assert.equal(cancelledSibling, true); assert.equal(recoveries, 0); assert.equal(writes, 1);
    assert.equal(factory.state.tokens[token.id].data.rightResult, undefined);
    await shutdown(); factory = new Factory(); closed = false;
    await factory.boot(); factory.broker.memoryFloorMB = 0;
    factory.runtime.resume(); await factory.runtime.settle();
    assert.equal(factory.state.tokens[token.id].status, 'manual'); assert.equal(writes, 1);
    assert.equal(Object.keys(factory.state.recoveries).length, 0);
    factory.runtime.correct({token: token.id, node: 'effect-runtime/left'}, 'Verify that an unresolved effect cannot be repeated');
    await factory.runtime.settle();
    assert.equal(factory.state.tokens[token.id].status, 'manual'); assert.equal(writes, 1);
    assert.equal(factory.state.nodes['effect-runtime/published'].stock, 0);
  } finally {
    if (!closed) await shutdown();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
