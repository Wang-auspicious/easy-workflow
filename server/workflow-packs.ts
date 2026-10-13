import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Check, Errors } from 'typebox/value';
import type { TSchema } from 'typebox';
import type { CompiledNode, EdgeSpec, LineSpec, PackSpec, StationAgentBinding } from '../shared/types.ts';
import type { AgentStationDef } from './agent-station.ts';
import type { Executor, StationContext, StationResult } from './runtime.ts';
import type { Pack } from './spec/dsl.ts';
import { compile, type Patch } from './spec/compile.ts';
import { ControlError } from './errors.ts';
import { invokeWorkflowTool, type WorkflowTool } from './workflow-tools.ts';
import type { Journal } from './journal.ts';
import {parseAgentBinding} from './agent-bindings.ts';
export type { WorkflowTool } from './workflow-tools.ts';

export type JsonSchema = Record<string, unknown>;
export interface WorkflowRole { station: string; path: string; revision: string; content: string }
export type WorkflowInput = { path: string; default?: unknown } | { value: unknown };
export interface WorkflowCondition { path: string; op: 'equals' | 'in' | 'exists' | 'truthy'; value?: unknown }
export type WorkflowExecution =
  | { kind: 'builtin'; name: 'normalize-text' | 'text-statistics' | 'keywords' | 'aggregate' | 'page-text' | 'prepare-source' | 'route' | 'publish-json' }
  | { kind: 'agent'; instructions: string; tools?: string[]; timeoutMs?: number; agent?: StationAgentBinding }
  | { kind: 'node'; module: string; export?: string }
  | { kind: 'tool'; tool: string };
export interface WorkflowBinding {
  role: string;
  inputSchema: string;
  outputSchema: string;
  input: Record<string, WorkflowInput>;
  outputKey: string;
  execute: WorkflowExecution;
  reviewTarget?: string;
  manualWhen?: { path: string; equals: unknown };
  preserveInput?: Record<string, string>;
}
export interface WorkflowManifest extends PackSpec {
  format: 1;
  entry: string;
  inputSchema: string;
  links: EdgeSpec[];
  schemas: Record<string, JsonSchema>;
  bindings: Record<string, WorkflowBinding>;
  conditions: Record<string, WorkflowCondition>;
  tools?: Record<string, WorkflowTool>;
}
export interface WorkflowServices {
  journal?: Journal;
  runAgent?: (def: AgentStationDef & { role: WorkflowRole }, ctx: StationContext) => Promise<StationResult>;
  callCapability?: (name: string, args: Record<string, unknown>, ctx: StationContext) => Promise<any>;
}
export type WorkflowAgentRunner = NonNullable<WorkflowServices['runAgent']>;
export interface WorkflowGuard { running: boolean; paused?: boolean; ending?: boolean; inflight?: number; assertIdle?: () => void }
export interface WorkflowIndex { version: 1; builtins: string[]; packages: { id: string; revision: string }[] }
export interface LoadedWorkflowPacks {
  packs: Pack[];
  conditions: Pack['conditions'];
  executor(node: CompiledNode, runAgent?: WorkflowAgentRunner): Executor | null;
  role(key: string): WorkflowRole | undefined;
  manifests: WorkflowManifest[];
  index: WorkflowIndex;
}
const slug = /^[a-z][a-z0-9-]{0,63}$/;
const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
function bad(message: string): never { throw new ControlError(422, 'invalid_workflow_pack', message); }
const safeKey = (key: string) => key.length > 0 && !['__proto__', 'prototype', 'constructor'].includes(key);

export function assertWorkflowIdle(guard: WorkflowGuard) {
  guard.assertIdle?.();
  if (guard.running || guard.paused || guard.ending || (guard.inflight ?? 0) > 0) throw new ControlError(409, 'workflow_structure_busy', '请先结束当前轮次并等待在途任务回收，再安装或修改流水线');
}
function contained(root: string, relative: string) {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !safeKey(part) || part === '.' || part === '..')) bad('包内文件必须使用安全的相对路径');
  const file = path.resolve(root, relative), base = path.resolve(root);
  if (!file.startsWith(base + path.sep)) bad('包文件不能越出包目录');
  return file;
}
function readContained(root: string, relative: string) {
  const file = contained(root, relative);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) bad(`缺少包文件 ${relative}`);
  const resolved = fs.realpathSync(file), base = fs.realpathSync(root);
  if (!resolved.startsWith(base + path.sep)) bad('包文件不能通过链接越出包目录');
  if (fs.statSync(file).size > 1024 * 1024) bad(`包文件 ${relative} 超过 1MiB`);
  return fs.readFileSync(file, 'utf8');
}
function packFiles(directory: string) {
  const files: Record<string, string> = {};
  const visit = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) bad('安装包不能包含符号链接');
    const file = path.join(dir, entry.name), relative = path.relative(directory, file).split(path.sep).join('/');
    if (entry.isDirectory()) { if (['roles', 'tools'].includes(relative.split('/')[0])) visit(file); }
    else if (/^(roles|tools)\//.test(relative) && /\.(md|json|js|mjs|cjs|ts)$/.test(relative)) files[relative] = readContained(directory, relative);
  } }; visit(directory);
  return files;
}
export function workflowValue(data: unknown, selector: string): unknown {
  if (!selector) return data;
  const parts = selector.split('.');
  if (parts.some(part => !safeKey(part))) bad('输入映射包含非法属性');
  let value: any = data;
  for (const part of parts) value = value !== null && typeof value === 'object' && Object.hasOwn(value, part) ? value[part] : undefined;
  return value;
}
function verify(schema: JsonSchema, value: unknown, label: string) {
  if (!Check(schema as TSchema, value)) bad(`${label} 不符合 schema：${[...Errors(schema as TSchema, value)].slice(0, 5).map(error => `${error.instancePath} ${error.message}`).join('；')}`);
}
function condition(def: WorkflowCondition) {
  return (data: Record<string, unknown>) => {
    const value = workflowValue(data, def.path);
    return def.op === 'exists' ? value !== undefined : def.op === 'truthy' ? Boolean(value) : def.op === 'in' ? Array.isArray(def.value) && def.value.includes(value) : JSON.stringify(value) === JSON.stringify(def.value);
  };
}

function materialize(manifest: WorkflowManifest, directory: string, projectDir: string): { pack: Pack; roles: Map<string, WorkflowRole> } {
  if (!record(manifest) || manifest.format !== 1 || !slug.test(manifest.id) || typeof manifest.name !== 'string' || !manifest.name.trim() || typeof manifest.version !== 'string') bad('包必须声明 format:1、合法 id、name 与 version');
  if (!Array.isArray(manifest.lines) || !Array.isArray(manifest.channels) || !Array.isArray(manifest.links) || !record(manifest.schemas) || !record(manifest.bindings) || !record(manifest.conditions)) bad('包缺少 lines/channels/links/schemas/bindings/conditions');
  if (!record(manifest.resources) || !['browser', 'model', 'cpu', 'http'].every(key => Number.isInteger(manifest.resources[key as keyof typeof manifest.resources]) && manifest.resources[key as keyof typeof manifest.resources] >= 0)) bad('资源配额必须是非负整数');
  for (const [name, schema] of Object.entries(manifest.schemas)) {
    if (!safeKey(name) || !record(schema)) bad('schema 必须是具名 JSON Schema 对象');
    try { Check(schema as TSchema, {}); } catch { bad(`schema ${name} 含不受支持的声明`); }
  }
  if (!manifest.schemas[manifest.inputSchema]) bad('包缺少入口 inputSchema');
  const keys = new Set<string>();
  for (const line of manifest.lines) {
    if (!record(line) || !slug.test(line.id) || !Array.isArray(line.stations) || !Array.isArray(line.edges) || ![1, 2, 3].includes(line.layer) || !['high', 'mid', 'low'].includes(line.priority) || typeof line.wired !== 'boolean') bad('流水线必须声明合法 id、layer、priority、wired、stations 与 edges');
    for (const station of line.stations) {
      if (!slug.test(station.id) || typeof station.input !== 'string' || typeof station.output !== 'string' || !Array.isArray(station.accept) || !Array.isArray(station.rules) || !record(station.workers)) bad(`${line.id} 的工位必须声明完整 I/O、验收与工人配置`);
      keys.add(`${line.id}/${station.id}`);
    }
    if (line.wired && !line.stations.some(station => station.kind !== 'source' && station.kind !== 'store')) bad(`已接线的 ${line.id} 必须至少包含一个可执行工位`);
  }
  if (!keys.has(manifest.entry) && (manifest.entry !== '' || manifest.lines.some(line => line.wired))) bad('入口工位不存在');
  const roles = new Map<string, WorkflowRole>(), contracts: NonNullable<Pack['contracts']> = {};
  for (const [key, binding] of Object.entries(manifest.bindings)) {
    if (!keys.has(key) || !record(binding) || !record(binding.input) || typeof binding.outputKey !== 'string' || !safeKey(binding.outputKey) || !record(binding.execute)) bad(`工位绑定 ${key} 无效`);
    if (binding.execute.kind !== 'agent' && 'agent' in binding.execute) {
      bad(`${key} 是程序执行器，不能声明工位 Agent 配置`);
    }
    if (binding.execute.kind === 'agent') {
      if (typeof binding.execute.instructions !== 'string' || binding.execute.instructions.trim().length < 20) bad(`${key} 的 Agent 必须有具体任务指令`);
      if (binding.execute.agent !== undefined) {
        try {
          binding.execute.agent = parseAgentBinding(binding.execute.agent);
        } catch (error) {
          bad(`${key} 的 Agent 配置无效：${error instanceof Error ? error.message : '参数不符合契约'}`);
        }
      }
    }
    if (!manifest.schemas[binding.inputSchema] || !manifest.schemas[binding.outputSchema]) bad(`${key} 缺少输入或输出 schema`);
    for (const [field, selector] of Object.entries(binding.input)) {
      if (!safeKey(field) || !record(selector) || (!('value' in selector) && (!('path' in selector) || typeof selector.path !== 'string'))) bad(`${key} 的输入映射无效`);
      if ('path' in selector) workflowValue({}, selector.path);
    }
    const content = readContained(directory, binding.role);
    if (content.trim().length < 40) bad(`${key} 的 ROLE.md 必须说明职责、交接和失败处理`);
    let code = JSON.stringify(binding.execute);
    if (binding.execute.kind === 'node') code += readContained(directory, binding.execute.module);
    else if (binding.execute.kind === 'tool') {
      const tool = manifest.tools?.[binding.execute.tool]; if (!tool || !['http', 'cli', 'mcp'].includes(tool.kind)) bad(`${key} 引用的外部工具不存在`);
      if (tool.timeoutMs !== undefined && (!Number.isSafeInteger(tool.timeoutMs) || tool.timeoutMs < 1 || tool.timeoutMs > 300000)) bad(`${key} 的工具超时必须在 1–300000ms`);
      if (tool.kind === 'http') {
        let url: URL; try { url = new URL(tool.url); } catch { bad(`${key} 的 HTTP 工具地址无效`); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || tool.method && !['GET', 'POST'].includes(tool.method)) bad(`${key} 的 HTTP 工具必须声明无内嵌凭据的 HTTP(S) 地址和 GET/POST 方法`);
      } else if (typeof tool.command !== 'string' || !tool.command.trim() || tool.args && (!Array.isArray(tool.args) || tool.args.some(arg => typeof arg !== 'string')) || tool.kind === 'mcp' && !tool.tool) bad(`${key} 的进程工具命令、参数或 MCP 工具名无效`);
      code += JSON.stringify(tool);
    } else if (binding.execute.kind !== 'agent' && (binding.execute.kind !== 'builtin' || !['normalize-text', 'text-statistics', 'keywords', 'aggregate', 'page-text', 'prepare-source', 'route', 'publish-json'].includes(binding.execute.name))) bad(`${key} 没有已实现的执行器`);
    const revision = digest(content + code + JSON.stringify([binding, manifest.schemas[binding.inputSchema], manifest.schemas[binding.outputSchema]])).slice(0, 16);
    roles.set(key, { station: key, path: path.relative(projectDir, contained(directory, binding.role)).split(path.sep).join('/'), revision, content });
    contracts[key] = { role: binding.role, inputSchema: binding.inputSchema, outputSchema: binding.outputSchema, executor: binding.execute.kind, revision, outputKey: binding.outputKey };
  }
  for (const [key, def] of Object.entries(manifest.conditions)) {
    if (!safeKey(key) || !record(def) || typeof def.path !== 'string' || !['equals', 'exists', 'in', 'truthy'].includes(def.op)) bad(`条件 ${key} 无效`);
    workflowValue({}, def.path);
  }
  const pack: Pack = { ...manifest, conditions: Object.fromEntries(Object.entries(manifest.conditions).map(([name, value]) => [name, condition(value)])), contracts, order: manifest.lines.map(line => line.id), collapsed: [], hints: {} };
  // Cross-pack links are checked only after all enabled packs have been loaded.
  return { pack, roles };
}

export function readWorkflowIndex(projectDir: string, builtins: Pack[] = []): WorkflowIndex {
  const file = path.join(projectDir, 'packs', 'installed.json');
  if (!fs.existsSync(file)) return { version: 1, builtins: builtins.map(pack => pack.id), packages: [] };
  const index = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkflowIndex;
  if (index.version !== 1 || !Array.isArray(index.builtins) || !Array.isArray(index.packages) || index.packages.some(entry => !slug.test(entry.id) || !/^[a-f0-9]{20}$/.test(entry.revision))) bad('项目流水线安装清单无效');
  return index;
}
const revisionDirectory = (projectDir: string, id: string, revision: string) => path.join(projectDir, 'packs', id, 'versions', revision);

export async function loadWorkflowPacks(projectDir: string, options: { builtins?: Pack[]; services?: WorkflowServices } = {}): Promise<LoadedWorkflowPacks> {
  const index = readWorkflowIndex(projectDir, options.builtins), packs: Pack[] = [], manifests: WorkflowManifest[] = [];
  const roles = new Map<string, WorkflowRole>();
  const executors = new Map<string, (ctx: StationContext, runAgent?: WorkflowAgentRunner) => Promise<StationResult>>();
  for (const id of index.builtins) { const pack = options.builtins?.find(pack => pack.id === id); if (!pack) bad(`项目依赖的内置包 ${id} 不可用`); packs.push(pack); }
  for (const installed of index.packages) {
    const directory = revisionDirectory(projectDir, installed.id, installed.revision);
    const manifest = JSON.parse(readContained(directory, 'pack.json')) as WorkflowManifest;
    if (manifest.id !== installed.id) bad('包标识与安装清单不一致');
    const loaded = materialize(manifest, directory, projectDir);
    packs.push(loaded.pack); manifests.push(manifest);
    for (const [key, role] of loaded.roles) roles.set(key, role);
    for (const [key, binding] of Object.entries(manifest.bindings)) {
      let moduleExecute: ((input: unknown, context: unknown) => Promise<unknown>) | undefined;
      if (binding.execute.kind === 'node') {
        const url = pathToFileURL(contained(directory, binding.execute.module)); url.searchParams.set('revision', installed.revision);
        const module = await import(url.href); moduleExecute = module[binding.execute.export ?? 'execute'];
        if (typeof moduleExecute !== 'function') bad(`${key} 的模块没有可调用的执行函数`);
      }
      const role = loaded.roles.get(key)!;
      executors.set(key, async (ctx, runAgent) => {
        ctx.signal.throwIfAborted();
        const input = Object.fromEntries(Object.entries(binding.input).map(([name, selector]) => [name, 'value' in selector ? structuredClone(selector.value) : workflowValue(ctx.token.data, selector.path) ?? selector.default]).filter(([, value]) => value !== undefined));
        verify(manifest.schemas[binding.inputSchema], input, `${key} 输入`);
        const workDir = path.join(projectDir, 'work', digest(ctx.token.id).slice(0, 20));
        const finish = (output: any): StationResult => {
          ctx.signal.throwIfAborted(); verify(manifest.schemas[binding.outputSchema], output, `${key} 输出`);
          for (const [field, source] of Object.entries(binding.preserveInput ?? {})) if (JSON.stringify(workflowValue(output, field)) !== JSON.stringify(workflowValue(input, source))) bad(`${key} 不得改写输入字段 ${source}`);
          const result: StationResult = { ok: true, summary: `${ctx.node.name}完成并通过输出契约校验`, data: { [binding.outputKey]: output } };
          if (binding.reviewTarget) {
            if (output.verdict === 'pass' && output.issues?.length) bad('审查通过不能同时保留未解决问题');
            result.verdict = { verdict: output.verdict, reason: output.reason, ...(output.verdict === 'return' ? { returnTo: binding.reviewTarget } : {}) };
          }
          if (binding.manualWhen && JSON.stringify(workflowValue(output, binding.manualWhen.path)) === JSON.stringify(binding.manualWhen.equals)) result.finish = { status: 'manual', reason: '规则与独立分类均无法确定去向，请补充输入后继续' };
          return result;
        };
        if (binding.execute.kind === 'agent') {
          const def: AgentStationDef & { role: WorkflowRole } = { role, agent: binding.execute.agent, system: `${role.content}\n\n${binding.execute.instructions}`, schema: manifest.schemas[binding.outputSchema] as TSchema, tools: binding.execute.tools ?? [], timeoutMs: binding.execute.timeoutMs, input: () => ({ text: JSON.stringify(input) }), after: output => finish(output), check: output => [
            ...(binding.reviewTarget && output.verdict === 'pass' && output.issues?.length ? ['通过审查时 issues 必须为空；否则退回并说明原因'] : []),
            ...Object.entries(binding.preserveInput ?? {}).filter(([field, source]) => JSON.stringify(workflowValue(output, field)) !== JSON.stringify(workflowValue(input, source))).map(([, source]) => `必须原样保留输入字段 ${source}，不能补造内容`),
          ] };
          const run = runAgent ?? options.services?.runAgent ?? (await import('./agent-station.ts')).runAgentStation;
          return run(def, ctx);
        }
        const output = binding.execute.kind === 'node' ? await moduleExecute!(input, { signal: ctx.signal, workDir, projectDir, node: ctx.node.key, item: ctx.token.item, progress: ctx.progress })
          : binding.execute.kind === 'tool' ? await invokeWorkflowTool(manifest.tools![binding.execute.tool], input, {
            signal: ctx.signal, workDir, packDir: directory,
            operation: options.services?.journal ? {
              journal: options.services.journal, token: ctx.token, node: ctx.node.key,
              revision: `${installed.revision}:${loaded.pack.contracts?.[key]?.revision ?? ''}`,
            } : undefined,
          })
          : await builtin(binding.execute.name, input, ctx, projectDir, manifest.id, options.services ?? {});
        return finish(output);
      });
    }
  }
  const compiled = compile(packs); if (compiled.issues.length) bad(compiled.issues.map(issue => `${issue.at}: ${issue.message}`).join('；'));
  return {
    packs, conditions: Object.assign({}, ...packs.map(pack => pack.conditions)),
    executor: (node, runAgent) => {
      const execute = executors.get(node.key);
      return execute ? context => execute(context, runAgent) : null;
    },
    role: key => roles.get(key), manifests, index,
  };
}

async function builtin(name: Extract<WorkflowExecution, { kind: 'builtin' }>['name'], input: Record<string, any>, ctx: StationContext, projectDir: string, packId: string, services: WorkflowServices): Promise<unknown> {
  if (name === 'normalize-text') return { text: String(input.text).normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\t ]+/g, ' ').trim() };
  if (name === 'text-statistics') { const text = String(input.text); return { characters: [...text].length, words: text.split(/\s+/u).filter(Boolean).length, paragraphs: text.split(/\n\s*\n/).filter(value => value.trim()).length }; }
  if (name === 'keywords') {
    const counts = new Map<string, number>(); for (const word of String(input.text).toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []) counts.set(word, (counts.get(word) ?? 0) + 1);
    return { keywords: [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).slice(0, 12).map(([word, count]) => ({ word, count })) };
  }
  if (name === 'aggregate') return { text: input.text, statistics: input.statistics, keywords: input.keywords.keywords };
  if (name === 'route') { const text = String(input.value).trim(); let url: URL | undefined; try { url = new URL(text); } catch {} return { kind: url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? 'link' : text.length >= 20 ? 'text' : 'unknown', value: text }; }
  if (name === 'page-text') {
    if (!services.callCapability) throw new Error('共享 page_text 能力未接入，不能把未采集内容当作成功');
    const page = await services.callCapability('page_text', { url: input.url, max: 12000 }, ctx);
    if (page?.ok === false) throw Object.assign(new Error(page.failure?.message ?? '采集失败'), { failure: page.failure });
    if (typeof page?.text !== 'string' || !page.text.trim()) throw new Error('采集页面没有可见正文');
    return { url: page.finalUrl ?? page.url ?? input.url, title: page.title ?? '', text: page.text, via: page.via ?? 'browser' };
  }
  if (name === 'prepare-source') return { url: input.page.url, title: input.page.title || new URL(input.page.url).hostname, text: input.page.text.trim(), characters: [...input.page.text.trim()].length, via: input.page.via };
  if (name === 'publish-json') {
    ctx.signal.throwIfAborted();
    const body = JSON.stringify({ workflow: packId, item: ctx.token.item, result: input.result }, null, 2) + '\n';
    const hash = digest(body), relative = ['outputs', packId, `${hash}.json`].join('/'), target = path.join(projectDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) {
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      try { fs.writeFileSync(temporary, body, { flag: 'wx' }); ctx.signal.throwIfAborted(); fs.renameSync(temporary, target); }
      finally { if (fs.existsSync(temporary)) fs.rmSync(temporary); }
    }
    return { path: relative, sha256: hash, bytes: Buffer.byteLength(body) };
  }
  throw new Error(`未知内置工作流程序 ${name}`);
}

export interface InstallWorkflowRequest { directory?: string; manifest?: WorkflowManifest; files?: Record<string, string>; replace?: boolean; builtins?: string[] }
const installs = new Map<string, Promise<unknown>>();
async function withInstallLock<T>(projectDir: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(projectDir), previous = installs.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(action); installs.set(key, current);
  try { return await current; } finally { if (installs.get(key) === current) installs.delete(key); }
}
export function installWorkflowPack(projectDir: string, request: InstallWorkflowRequest, guard: WorkflowGuard, availableBuiltins: Pack[] = []): Promise<WorkflowManifest> {
  return withInstallLock(projectDir, () => installWorkflowPackUnlocked(projectDir, request, guard, availableBuiltins));
}
async function installWorkflowPackUnlocked(projectDir: string, request: InstallWorkflowRequest, guard: WorkflowGuard, availableBuiltins: Pack[]): Promise<WorkflowManifest> {
  assertWorkflowIdle(guard);
  let manifest = request.manifest, files = { ...request.files };
  if (request.directory) {
    const source = fs.realpathSync(request.directory); manifest = JSON.parse(readContained(source, 'pack.json'));
    files = packFiles(source);
  }
  if (!manifest || !slug.test(manifest.id)) bad('安装请求缺少合法包清单');
  const index = readWorkflowIndex(projectDir, availableBuiltins);
  if (index.packages.some(entry => entry.id === manifest!.id) && !request.replace) throw new ControlError(409, 'workflow_pack_exists', '包已安装；更新必须明确 replace:true');
  if (request.builtins) {
    if (request.builtins.some(id => !availableBuiltins.some(pack => pack.id === id))) bad('所选内置包不可用');
    index.builtins = [...new Set(request.builtins)];
  }
  files['pack.json'] = JSON.stringify(manifest, null, 2) + '\n';
  if (Object.values(files).reduce((total, content) => total + Buffer.byteLength(content), 0) > 8 * 1024 * 1024) bad('包文本总量超过 8MiB');
  const revision = digest(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).slice(0, 20);
  const destination = revisionDirectory(projectDir, manifest.id, revision), staging = path.join(projectDir, 'packs', `.install-${crypto.randomUUID()}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    for (const [relative, content] of Object.entries(files)) { const file = contained(staging, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
    const loaded = materialize(manifest, staging, projectDir);
    const others = index.packages.filter(entry => entry.id !== manifest!.id).map(entry => {
      const directory = revisionDirectory(projectDir, entry.id, entry.revision);
      return materialize(JSON.parse(readContained(directory, 'pack.json')), directory, projectDir).pack;
    });
    const patchFile = path.join(projectDir, 'patches.json');
    const patches = fs.existsSync(patchFile) ? JSON.parse(fs.readFileSync(patchFile, 'utf8')) as Patch[] : [];
    if (!Array.isArray(patches)) bad('项目 patches.json 必须是补丁数组');
    const checked = compile([...availableBuiltins.filter(pack => index.builtins.includes(pack.id)), ...others, loaded.pack], patches);
    if (checked.issues.length) bad(checked.issues.map(issue => `${issue.at}: ${issue.message}`).join('；'));
    for (const [key, binding] of Object.entries(manifest.bindings)) if (binding.execute.kind === 'node') {
      const url = pathToFileURL(contained(staging, binding.execute.module));
      let module: Record<string, unknown>;
      try { module = await import(url.href); } catch { bad(`${key} 的 Node 执行模块不能加载，请检查模块语法与本地依赖`); }
      if (typeof module[binding.execute.export ?? 'execute'] !== 'function') bad(`${key} 的 Node 模块缺少声明的执行函数`);
    }
    // Imports may await module initialization. Recheck the live runtime before
    // the synchronous index swap, so a newly started run cannot change structure.
    assertWorkflowIdle(guard);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (!fs.existsSync(destination)) fs.renameSync(staging, destination);
    const existing = index.packages.findIndex(entry => entry.id === manifest!.id);
    if (existing < 0) index.packages.push({ id: manifest.id, revision }); else index.packages[existing] = { id: manifest.id, revision };
    const indexFile = path.join(projectDir, 'packs', 'installed.json'), temporary = `${indexFile}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(index, null, 2) + '\n'); fs.renameSync(temporary, indexFile); }
    finally { if (fs.existsSync(temporary)) fs.rmSync(temporary); }
    return structuredClone(manifest);
  } finally {
    const absolute = path.resolve(staging), boundary = path.resolve(projectDir, 'packs');
    if (absolute.startsWith(boundary + path.sep) && fs.existsSync(absolute)) fs.rmSync(absolute, { recursive: true, force: true });
  }
}

export async function addWorkflowLine(projectDir: string, packId: string, addition: { line: LineSpec; bindings: Record<string, WorkflowBinding>; schemas: Record<string, JsonSchema>; files: Record<string, string>; tools?: Record<string, WorkflowTool>; conditions?: Record<string, WorkflowCondition> }, guard: WorkflowGuard, availableBuiltins: Pack[] = []) {
  return withInstallLock(projectDir, async () => {
  assertWorkflowIdle(guard);
  const entry = readWorkflowIndex(projectDir, availableBuiltins).packages.find(entry => entry.id === packId);
  if (!entry) throw new ControlError(404, 'workflow_pack_not_found', '请先安装或创建项目流水线包');
  const directory = revisionDirectory(projectDir, packId, entry.revision), manifest = JSON.parse(readContained(directory, 'pack.json')) as WorkflowManifest;
  if (manifest.lines.some(line => line.id === addition.line.id)) throw new ControlError(409, 'workflow_line_exists', '同名流水线已存在');
  const files = packFiles(directory);
  for (const [relative, content] of Object.entries(addition.files)) { if (files[relative] !== undefined && files[relative] !== content) bad('添加流水线不能同时改写已有职责或执行代码'); files[relative] = content; }
  if (Object.keys(addition.bindings).some(key => !key.startsWith(`${addition.line.id}/`))) bad('新增绑定必须属于新流水线');
  for (const [name, schema] of Object.entries(addition.schemas)) if (manifest.schemas[name] && JSON.stringify(manifest.schemas[name]) !== JSON.stringify(schema)) bad('添加流水线不能同时覆盖已有 schema');
  const workflowEntry = manifest.entry || `${addition.line.id}/${addition.line.stations.find(station => station.kind !== 'source' && station.kind !== 'store')?.id ?? addition.line.stations[0]?.id ?? ''}`;
  return installWorkflowPackUnlocked(projectDir, { manifest: { ...manifest, entry: workflowEntry, lines: [...manifest.lines, addition.line], bindings: { ...manifest.bindings, ...addition.bindings }, schemas: { ...manifest.schemas, ...addition.schemas }, tools: { ...manifest.tools, ...addition.tools }, conditions: { ...manifest.conditions, ...addition.conditions } }, files, replace: true }, guard, availableBuiltins);
  });
}
