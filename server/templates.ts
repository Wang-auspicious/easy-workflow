import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { StationSpec, LineSpec } from '../shared/types.ts';
import type { Pack } from './spec/dsl.ts';
import { station, line } from './spec/dsl.ts';
import { installWorkflowPack, type JsonSchema, type WorkflowBinding, type WorkflowExecution, type WorkflowGuard, type WorkflowManifest } from './workflow-packs.ts';

const text = (minLength = 1): JsonSchema => ({ type: 'string', minLength });
const object = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });
const list = (items: JsonSchema): JsonSchema => ({ type: 'array', items });
const natural = { type: 'integer', minimum: 0 };
const brief = object({ brief: text(10), requirements: { ...list(text()), minItems: 1 } });
const textInput = object({ text: text(1) });
const urlInput = object({ url: { type: 'string', pattern: '^https?://' } });
const routeInput = object({ value: text() });
const templates = [
  { id: 'review-loop', name: '生产 + 审查回路', description: '依据 brief 与 requirements 写作，独立审查，不通过退回最多两轮；通过后保存可追溯 JSON 产物。', inputSchema: brief },
  { id: 'fanout', name: '扇出 · 汇总', description: '规范化文本，并行统计字词与提取高频关键词，汇总为报告；所有计算节点均为程序。', inputSchema: textInput },
  { id: 'collect', name: '采集 · 加工 · 审查 · 发布', description: '共享浏览器采集可见正文，程序规范化后由独立审查 Agent 对照原文核验，再保存产物。', inputSchema: urlInput },
  { id: 'triage', name: '分流 · 多线投递', description: '规则先识别网页链接与文本，模糊输入由分类 Agent 核对；分别进入文本报告线或网页采集线，仍不明的转人工。', inputSchema: routeInput },
];
export function listWorkflowTemplates() { return structuredClone(templates); }

export async function instantiateWorkflowTemplate(projectDir: string, request: { templateId: string; id: string; name: string; includeBuiltins?: boolean }, guard: WorkflowGuard, availableBuiltins: Pack[] = []): Promise<WorkflowManifest> {
  const card = templates.find(template => template.id === request.templateId);
  if (!card) throw new Error('未知工作流模板');
  const id = request.id, files: Record<string, string> = {}, bindings: Record<string, WorkflowBinding> = {};
  const schemas: Record<string, JsonSchema> = {
    input: card.inputSchema,
    text: textInput,
    document: object({ title: text(), body: text(10) }),
    review: object({ verdict: { enum: ['pass', 'return', 'escalate'] }, reason: text(), issues: list(text()) }),
    artifact: object({ path: text(), sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, bytes: { type: 'integer', minimum: 1 } }),
    statistics: object({ characters: natural, words: natural, paragraphs: natural }),
    keywords: object({ keywords: list(object({ word: text(), count: { type: 'integer', minimum: 1 } })) }),
    report: object({ text: text(), statistics: object({ characters: natural, words: natural, paragraphs: natural }), keywords: list(object({ word: text(), count: { type: 'integer', minimum: 1 } })) }),
    page: object({ url: text(), title: text(0), text: text(), via: text() }),
    source: object({ url: text(), title: text(), text: text(), via: text(), characters: natural }),
    route: object({ kind: { enum: ['text', 'link', 'unknown'] }, value: text() }),
  };
  const main: StationSpec[] = [], lines: LineSpec[] = [];
  const make = (lineId: string, nodeId: string, name: string, role: StationSpec['role'], kind: StationSpec['kind'], execute: WorkflowExecution, inputSchema: JsonSchema, outputSchema: string, input: WorkflowBinding['input'], outputKey: string, sourceRole = nodeId, extra: Partial<WorkflowBinding> = {}) => {
    const key = `${lineId}/${nodeId}`, contract = `${lineId}.${nodeId}.input`;
    schemas[contract] = inputSchema;
    const rolePath = `roles/${lineId}/${nodeId}/ROLE.md`;
    files[rolePath] = fs.readFileSync(fileURLToPath(new URL(`../packs/templates/${request.templateId}/roles/${sourceRole}/ROLE.md`, import.meta.url)), 'utf8');
    bindings[key] = { role: rolePath, inputSchema: contract, outputSchema, input, outputKey, execute, ...extra };
    return station({ id: nodeId, name, role, kind, resource: execute.kind === 'agent' ? 'model' : 'none', input: 'workflow-data', output: 'workflow-data', estimateSeconds: execute.kind === 'agent' ? 15 : 1, accept: ['输入及输出必须满足本节点 JSON Schema', '所有结果可追溯到当前任务输入，不伪造采集或审查'], tool: execute.kind === 'builtin' ? `workflow.${execute.name}` : undefined });
  };
  const data = (path: string) => ({ path });
  const store = () => station({ id: 'published', name: '已交付', role: 'store', kind: 'store', input: 'workflow-data', output: 'workflow-data' });
  const publish = (lineId: string, schema: string, source: string, roleName: string, reviewed = false) => make(lineId, 'publish', '保存已通过产物', 'publish', 'gate', { kind: 'builtin', name: 'publish-json' }, object({ result: schemas[schema], ...(reviewed ? { review: object({ verdict: { const: 'pass' }, reason: text(), issues: { type: 'array', maxItems: 0 } }) } : {}) }), 'artifact', { result: data(source), ...(reviewed ? { review: data('review') } : {}) }, `${lineId}Artifact`, roleName);
  const conditions: WorkflowManifest['conditions'] = {}, links: WorkflowManifest['links'] = [];
  let entry = '';
  if (request.templateId === 'review-loop') {
    main.push(make(id, 'produce', '文稿生产', 'write', 'agent', { kind: 'agent', instructions: '根据 brief 和 requirements 撰写可交付文稿。只使用已给出的事实，未知事实明确写出缺口；返工时逐项处理审查原因。提交 title 与 body。' }, brief, 'document', { brief: data('input.brief'), requirements: data('input.requirements') }, 'document'));
    const review = make(id, 'review', '独立质量审查', 'review', 'review', { kind: 'agent', instructions: '独立对照原始 brief 和每条 requirements 检查 document。具体指出缺陷，存在可修改问题则 return；缺失关键事实无法解决则 escalate；只有所有要求满足才 pass，pass 时 issues 必须为空。' }, object({ brief: text(10), requirements: list(text()), document: schemas.document }), 'review', { brief: data('input.brief'), requirements: data('input.requirements'), document: data('document') }, 'review', 'review', { reviewTarget: `${id}/produce` });
    review.returnTo = [{ station: 'produce', maxRounds: 2 }]; main.push(review, publish(id, 'document', 'document', 'publish', true), store());
    lines.push(line({ id, name: request.name, layer: 3, priority: 'mid', blurb: card.description, wired: true, stations: main, edges: [['produce', 'review'], ['review', 'publish'], ['publish', 'published']] })); entry = `${id}/produce`;
  } else if (request.templateId === 'fanout') {
    main.push(make(id, 'prepare', '文本标准化', 'process', 'program', { kind: 'builtin', name: 'normalize-text' }, textInput, 'text', { text: data('input.text') }, 'normalized'));
    main.push(make(id, 'statistics', '字词统计', 'verify', 'program', { kind: 'builtin', name: 'text-statistics' }, textInput, 'statistics', { text: data('normalized.text') }, 'statistics'));
    main.push(make(id, 'keywords', '高频词提取', 'process', 'program', { kind: 'builtin', name: 'keywords' }, textInput, 'keywords', { text: data('normalized.text') }, 'keywords'));
    main.push(make(id, 'aggregate', '合并分析结果', 'process', 'program', { kind: 'builtin', name: 'aggregate' }, object({ text: text(), statistics: schemas.statistics, keywords: schemas.keywords }), 'report', { text: data('normalized.text'), statistics: data('statistics'), keywords: data('keywords') }, 'report'));
    main.push(publish(id, 'report', 'report', 'publish'), store());
    lines.push(line({ id, name: request.name, layer: 3, priority: 'mid', blurb: card.description, wired: true, stations: main, edges: [['prepare', 'statistics'], ['prepare', 'keywords'], ['statistics', 'aggregate'], ['keywords', 'aggregate'], ['aggregate', 'publish'], ['publish', 'published']] })); entry = `${id}/prepare`;
  } else if (request.templateId === 'collect') {
    main.push(make(id, 'collect', '采集可见页面', 'capture', 'program', { kind: 'builtin', name: 'page-text' }, urlInput, 'page', { url: data('input.url') }, 'page'));
    main.push(make(id, 'process', '规范化来源记录', 'process', 'program', { kind: 'builtin', name: 'prepare-source' }, object({ page: schemas.page }), 'source', { page: data('page') }, 'source'));
    const review = make(id, 'review', '来源一致性审查', 'review', 'review', { kind: 'agent', instructions: '对照 page 原始可见文本和 source 规范记录，检查 URL、标题、正文、字符计数是否对应同一来源，是否有登录墙、空页面或正文截断造成不可交付。通过时 issues 为空；可重采问题 return；需要人处理的限制 escalate。' }, object({ page: schemas.page, source: schemas.source }), 'review', { page: data('page'), source: data('source') }, 'review', 'review', { reviewTarget: `${id}/collect` });
    review.returnTo = [{ station: 'collect', maxRounds: 2 }]; main.push(review, publish(id, 'source', 'source', 'publish', true), store());
    lines.push(line({ id, name: request.name, layer: 3, priority: 'mid', blurb: card.description, wired: true, stations: main, edges: [['collect', 'process'], ['process', 'review'], ['review', 'publish'], ['publish', 'published']] })); entry = `${id}/collect`;
  } else {
    const textLine = `${id}-text`, linkLine = `${id}-link`;
    main.push(make(id, 'route', '规则分流', 'sort', 'program', { kind: 'builtin', name: 'route' }, routeInput, 'route', { value: data('input.value') }, 'route'));
    main.push(make(id, 'classify', '模糊输入分类', 'judge', 'agent', { kind: 'agent', instructions: '只判断给定 value 是可分析文本还是完整 HTTP(S) 网页地址。不得补写、猜测或发明网址；仍不明确时 kind=unknown 并原样保留 value，由站长补充。' }, routeInput, 'route', { value: data('input.value') }, 'route', 'classify', { manualWhen: { path: 'kind', equals: 'unknown' }, preserveInput: { value: 'value' } }));
    conditions[`${id}.unknown`] = { path: 'route.kind', op: 'equals', value: 'unknown' };
    conditions[`${id}.text`] = { path: 'route.kind', op: 'equals', value: 'text' };
    conditions[`${id}.link`] = { path: 'route.kind', op: 'equals', value: 'link' };
    lines.push(line({ id, name: `${request.name} · 分流`, layer: 2, priority: 'mid', blurb: card.description, wired: true, stations: main, edges: [['route', 'classify', `${id}.unknown`]] }));
    const textNodes = [make(textLine, 'prepare', '标准化文本', 'process', 'program', { kind: 'builtin', name: 'normalize-text' }, textInput, 'text', { text: data('route.value') }, 'normalized', 'prepare'), make(textLine, 'statistics', '生成文本统计', 'verify', 'program', { kind: 'builtin', name: 'text-statistics' }, textInput, 'statistics', { text: data('normalized.text') }, 'statistics', 'statistics'), publish(textLine, 'statistics', 'statistics', 'publish'), store()];
    const linkNodes = [make(linkLine, 'collect', '采集链接正文', 'capture', 'program', { kind: 'builtin', name: 'page-text' }, urlInput, 'page', { url: data('route.value') }, 'page', 'collect'), publish(linkLine, 'page', 'page', 'publish'), store()];
    lines.push(line({ id: textLine, name: `${request.name} · 文本`, layer: 3, priority: 'mid', blurb: '程序分析文本并保存统计', wired: true, stations: textNodes, edges: [['prepare', 'statistics'], ['statistics', 'publish'], ['publish', 'published']] }), line({ id: linkLine, name: `${request.name} · 网页`, layer: 3, priority: 'mid', blurb: '复用共享浏览器读取真实正文', wired: true, stations: linkNodes, edges: [['collect', 'publish'], ['publish', 'published']] }));
    for (const from of ['route', 'classify']) { links.push({ from: `${id}/${from}`, to: `${textLine}/prepare`, when: `${id}.text`, kind: 'flow' }, { from: `${id}/${from}`, to: `${linkLine}/collect`, when: `${id}.link`, kind: 'flow' }); }
    entry = `${id}/route`;
  }
  const manifest: WorkflowManifest = { format: 1, id, name: request.name, version: '1.0.0', blurb: card.description, entry, inputSchema: 'input', lines, channels: [], links, resources: { browser: 8, model: 8, cpu: 4, http: 6 }, schemas, bindings, conditions };
  return installWorkflowPack(projectDir, { manifest, files, ...(request.includeBuiltins === false ? { builtins: [] } : {}) }, guard, availableBuiltins);
}
