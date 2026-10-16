import type {JsonSchema, WorkflowBinding, WorkflowManifest} from '../../../server/workflow-packs.ts';
import {parseObject} from './workflows.ts';

export const draftOperations = [
  {id: 'normalize-text', name: '文本标准化'},
  {id: 'text-statistics', name: '字词统计'},
  {id: 'keywords', name: '高频词提取'},
  {id: 'aggregate', name: '合并文本分析'},
  {id: 'publish-json', name: '保存 JSON 产物'},
] as const;
export type DraftOperation = typeof draftOperations[number]['id'];
export interface DraftNode {
  readonly id: string;
  name: string;
  operation: DraftOperation;
  inputSchema: string;
  outputSchema: string;
  mapping: string;
  accept: string;
}
export interface WorkflowDraft {
  id: string;
  name: string;
  inputSchema: string;
  nodes: DraftNode[];
  edges: {from: string; to: string}[];
}
const json = (value: unknown) => JSON.stringify(value, null, 2);
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const text = {type: 'string', minLength: 1};
const textSchema = object({text});
const statistics = object({characters: {type: 'integer', minimum: 0}, words: {type: 'integer', minimum: 0}, paragraphs: {type: 'integer', minimum: 0}});
const words = {type: 'array', items: object({word: text, count: {type: 'integer', minimum: 1}})};
const keywords = object({keywords: words});

export function emptyWorkflowDraft(): WorkflowDraft {
  return {id: `flow-${crypto.randomUUID().slice(0, 8)}`, name: '', inputSchema: json(textSchema), nodes: [], edges: []};
}

export function newDraftNode(operation: DraftOperation, nodes: readonly DraftNode[]): DraftNode {
  let serial = 1;
  while (nodes.some(node => node.id === `step-${serial}`)) serial++;
  const id = `step-${serial}`;
  const source = [...nodes].reverse().find(node => node.operation === 'normalize-text');
  const previous = nodes.at(-1);
  const sourcePath = source ? `${source.id}.text` : 'input.text';
  let inputSchema = textSchema;
  let outputSchema: JsonSchema = operation === 'text-statistics' ? statistics : operation === 'keywords' ? keywords : textSchema;
  let mapping: WorkflowBinding['input'] = {text: {path: sourcePath}};
  if (operation === 'aggregate') {
    inputSchema = object({text, statistics, keywords});
    outputSchema = object({text, statistics, keywords: words});
    mapping = {
      text: {path: sourcePath},
      statistics: {path: nodes.find(node => node.operation === 'text-statistics')?.id ?? 'statistics'},
      keywords: {path: nodes.find(node => node.operation === 'keywords')?.id ?? 'keywords'},
    };
  }
  if (operation === 'publish-json') {
    let result: JsonSchema = {type: 'object'};
    try {if (previous) result = parseObject(previous.outputSchema, '上一步输出');} catch { /* Keep the new node editable when the previous draft is incomplete. */ }
    inputSchema = object({result});
    outputSchema = object({path: text, sha256: {type: 'string', pattern: '^[a-f0-9]{64}$'}, bytes: {type: 'integer', minimum: 1}});
    mapping = {result: {path: previous?.id ?? 'input'}};
  }
  return {id, name: draftOperations.find(value => value.id === operation)!.name, operation,
    inputSchema: json(inputSchema), outputSchema: json(outputSchema), mapping: json(mapping),
    accept: operation === 'publish-json' ? '产物实际保存并返回文件路径、SHA-256 与字节数。' : '输出满足本节点契约，所有计算基于当前任务输入，不伪造数据。'};
}

/** Removing a node removes its connections and data selectors; missing inputs remain visible for repair. */
export function removeDraftNode(draft: WorkflowDraft, id: string): WorkflowDraft {
  return {...draft, edges: draft.edges.filter(edge => edge.from !== id && edge.to !== id), nodes: draft.nodes.filter(node => node.id !== id).map(node => {
    try {
      const mapping = parseObject(node.mapping, '输入映射');
      const remaining = Object.fromEntries(Object.entries(mapping).filter(([, value]) => {
        const path = value && typeof value === 'object' && 'path' in value ? value.path : undefined;
        return typeof path !== 'string' || (path !== id && !path.startsWith(`${id}.`));
      }));
      return {...node, mapping: json(remaining)};
    } catch {return node;}
  })};
}

export function compileWorkflowDraft(draft: WorkflowDraft): {manifest: WorkflowManifest; files: Record<string, string>} {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(draft.id)) throw new Error('工作流标识须以小写字母开头，只含小写字母、数字和连字符，最多 64 字符。');
  if (!draft.name.trim()) throw new Error('请填写工作流名称。');
  if (!draft.nodes.length) throw new Error('请先添加一个程序节点。');
  const ids = new Set(draft.nodes.map(node => node.id));
  if (ids.size !== draft.nodes.length || ids.has('published')) throw new Error('节点标识不能重复或使用保留标识 published。');
  const edges = draft.edges;
  if (new Set(edges.map(edge => `${edge.from}:${edge.to}`)).size !== edges.length) throw new Error('同一条连线不能重复添加。');
  if (edges.some(edge => !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to)) throw new Error('连线必须连接两个不同的现有节点。');
  const roots = draft.nodes.filter(node => !edges.some(edge => edge.to === node.id));
  if (roots.length !== 1) throw new Error('工作流需要唯一入口，请连接所有独立节点。');
  const ancestors = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const walk = (id: string): Set<string> => {
    if (visiting.has(id)) throw new Error('工作流存在循环，请删除产生循环的连线。');
    if (ancestors.has(id)) return ancestors.get(id)!;
    visiting.add(id);
    const upstream = new Set<string>();
    for (const edge of edges.filter(edge => edge.to === id)) {
      upstream.add(edge.from);
      for (const ancestor of walk(edge.from)) upstream.add(ancestor);
    }
    visiting.delete(id);
    ancestors.set(id, upstream);
    return upstream;
  };
  for (const id of ids) walk(id);
  if (draft.nodes.some(node => node.id !== roots[0].id && !ancestors.get(node.id)?.has(roots[0].id))) throw new Error('所有节点都必须能从入口到达。');
  const sinks = draft.nodes.filter(node => !edges.some(edge => edge.from === node.id));
  if (sinks.some(node => node.operation !== 'publish-json')) throw new Error('每个分支末端需要“保存 JSON 产物”节点，才能交付实际文件。');
  const schemas: Record<string, JsonSchema> = {input: parseObject(draft.inputSchema, '工作流输入契约')};
  const bindings: WorkflowManifest['bindings'] = {};
  const files: Record<string, string> = {};
  for (const node of draft.nodes) {
    if (!node.name.trim()) throw new Error(`${node.id} 需要节点名称。`);
    const accept = node.accept.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!accept.length) throw new Error(`${node.name}需要至少一条验收条件。`);
    const input = parseObject(node.mapping, `${node.name}输入映射`);
    const inputSchema = parseObject(node.inputSchema, `${node.name}输入契约`);
    schemas[`${node.id}.input`] = inputSchema;
    schemas[`${node.id}.output`] = parseObject(node.outputSchema, `${node.name}输出契约`);
    if (Array.isArray(inputSchema.required)) for (const field of inputSchema.required) {
      if (typeof field === 'string' && !(field in input)) throw new Error(`${node.name}缺少必填输入映射 ${field}。`);
    }
    for (const [field, value] of Object.entries(input)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${node.name}的 ${field} 映射需要 {path} 或 {value}。`);
      if ('value' in value && !('path' in value)) continue;
      if (!('path' in value) || typeof value.path !== 'string' || 'value' in value) throw new Error(`${node.name}的 ${field} 映射无效。`);
      const source = value.path.split('.')[0];
      if (source !== 'input' && !ancestors.get(node.id)?.has(source)) throw new Error(`${node.name}引用了未连接的上游 ${source}，请补充连线或修改输入映射。`);
    }
    const role = `roles/${node.id}/ROLE.md`;
    files[role] = `# ${node.name}\n\n本节点使用已有程序 ${node.operation} 执行。只处理当前任务映射后的输入，按输入输出契约校验，保留真实结果与失败原因。不得编造外部采集、模型调用或产物。\n\n验收条件：\n${accept.map(value => `- ${value}`).join('\n')}\n`;
    bindings[`${draft.id}/${node.id}`] = {role, inputSchema: `${node.id}.input`, outputSchema: `${node.id}.output`, input: input as WorkflowBinding['input'], outputKey: node.id, execute: {kind: 'builtin', name: node.operation}};
  }
  return {manifest: {
    format: 1, id: draft.id, name: draft.name.trim(), version: '1.0.0', blurb: '由空白工作流编辑器创建的程序流程。',
    entry: `${draft.id}/${roots[0].id}`, inputSchema: 'input', schemas, bindings, conditions: {}, links: [], channels: [],
    resources: {browser: 0, model: 0, cpu: 0, http: 0},
    lines: [{id: draft.id, name: draft.name.trim(), blurb: '独立程序流程', layer: 3, priority: 'mid', wired: true,
      stations: [...draft.nodes.map(node => ({id: node.id, name: node.name.trim(), role: node.operation === 'publish-json' ? 'publish' as const : 'process' as const,
        kind: node.operation === 'publish-json' ? 'gate' as const : 'program' as const, input: 'workflow-data', output: 'workflow-data', rules: [],
        accept: node.accept.split(/\r?\n/).map(value => value.trim()).filter(Boolean), resource: 'none' as const, estimateSeconds: 1,
        workers: {min: 1, max: 3, initial: 1, policy: 'auto' as const}})),
      {id: 'published', name: '已交付', role: 'store', kind: 'store', input: 'workflow-data', output: 'workflow-data', rules: [], accept: [], resource: 'none', estimateSeconds: 0,
        workers: {min: 0, max: 0, initial: 0, policy: 'fixed'}}],
      edges: [...edges, ...sinks.map(node => ({from: node.id, to: 'published'}))].map(edge => ({...edge, kind: 'flow'})),
    }],
  }, files};
}
