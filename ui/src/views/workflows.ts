import type { EdgeSpec, PackSpec } from '../../../shared/types.ts';
import { api } from '../api.ts';

export type InputSchema = { type?: string; title?: string; description?: string; minLength?: number; required?: string[]; properties?: Record<string, InputSchema>; items?: InputSchema; enum?: unknown[] };
export interface WorkflowTemplate { id: string; name: string; description: string; inputSchema: InputSchema }
export interface InstalledWorkflow extends PackSpec {
  entry: string; inputSchema: string; schemas: Record<string, InputSchema>; links?: EdgeSpec[];
  bindings: Record<string, { inputSchema: string; input: Record<string, { path?: string; value?: unknown }> }>;
}
export interface WorkflowCatalog { templates: WorkflowTemplate[]; installed: InstalledWorkflow[] }
export interface WorkflowReceipt<T> { ok: boolean; summary?: string; result: T }
const userRoutes: Record<string, string> = {
  workflow_template: '/api/workflows/template', workflow_install: '/api/workflows/install',
  workflow_line: '/api/workflows/line', workflow_feed: '/api/workflows/feed',
  allocation_plan: '/api/allocation-plan', undo_correction: '/api/correct/undo',
  business_feed: '/api/business/feed', run_control: '/api/run',
};
export async function workflowCall<T>(name: string, parameters: Record<string, unknown>) {
  const receipt = await api.post<WorkflowReceipt<T>>(userRoutes[name] ?? `/api/tools/${name}`, parameters);
  if (!receipt.ok) throw new Error(receipt.summary || '操作没有完成，请查看服务回执。');
  return receipt;
}
export function parseObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${label}不是有效的 JSON，请检查引号、逗号与括号。`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是一个 JSON 对象。`);
  return value as Record<string, unknown>;
}
export function workflowInput(schema: InputSchema, values: Record<string, string>) {
  const input: Record<string, unknown> = {};
  for (const [field, rule] of Object.entries(schema.properties ?? {})) {
    const value = values[field] ?? '';
    if (!value.trim() && !schema.required?.includes(field)) continue;
    if (rule.enum) {
      const option = rule.enum.find(option => JSON.stringify(option) === value);
      if (option === undefined) throw new Error(`${field} 需要选择一个有效选项。`);
      input[field] = option;
    } else if (rule.type === 'array' && rule.items?.type === 'string') input[field] = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    else if (rule.type === 'number' || rule.type === 'integer') {
      const number = Number(value); if (!value.trim() || !Number.isFinite(number)) throw new Error(`${field} 需要有效数字。`); input[field] = number;
    } else if (rule.type === 'boolean') input[field] = value === 'true';
    else if (rule.type === 'string' || !rule.type) input[field] = value;
    else { try { input[field] = JSON.parse(value); } catch { throw new Error(`${field} 需要有效 JSON。`); } }
  }
  return input;
}
export const inputLabel = (field: string) => ({ text: '原始文本', url: '网页地址', brief: '任务说明', requirements: '验收要求', value: '待处理内容' } as Record<string, string>)[field] ?? field;

/** Only independent lines with one bound root are direct intake choices. */
export function workflowEntries(pack: InstalledWorkflow) {
  return pack.lines.flatMap<{ line: string; name: string; entry: string; schema?: InputSchema }>(line => {
    if (!line.wired) return [];
    if (pack.entry.startsWith(`${line.id}/`)) return [{ line: line.id, name: line.name, entry: pack.entry, schema: pack.schemas[pack.inputSchema] }];
    if ((pack.links ?? []).some(edge => edge.to.startsWith(`${line.id}/`) && !edge.from.startsWith(`${line.id}/`) && edge.kind !== 'return') || pack.channels.some(channel => channel.to.line === line.id)) return [];
    const roots = line.stations.filter(station => !line.edges.some(edge => edge.kind !== 'return' && (edge.to === station.id || edge.to === `${line.id}/${station.id}`)));
    if (roots.length !== 1) return [];
    const entry = `${line.id}/${roots[0].id}`, binding = pack.bindings[entry];
    if (!binding) return [];
    const contract = pack.schemas[binding.inputSchema], properties: Record<string, InputSchema> = {}, required: string[] = [];
    let complex = !contract?.properties;
    for (const [field, selector] of Object.entries(binding.input)) {
      if (!selector.path?.startsWith('input.')) continue;
      const key = selector.path.slice(6);
      if (key.includes('.') || !contract?.properties?.[field]) { complex = true; continue; }
      properties[key] = contract.properties[field]; if (contract.required?.includes(field)) required.push(key);
    }
    return [{ line: line.id, name: line.name, entry, schema: complex ? undefined : { type: 'object', properties, required } }];
  });
}
