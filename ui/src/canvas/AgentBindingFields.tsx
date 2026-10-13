import type {StationAgentBinding} from '../../../shared/types.ts';

export interface AgentBindingDraft {
  adapter: 'inherit' | StationAgentBinding['adapter'];
  provider: string;
  model: string;
  command: string;
  requestTimeoutMs: string;
}

export function agentBindingDraft(binding: StationAgentBinding | null): AgentBindingDraft {
  return {
    adapter: binding?.adapter ?? 'inherit',
    provider: binding?.adapter === 'pi' ? binding.provider ?? '' : '',
    model: binding?.model ?? '',
    command: binding && binding.adapter !== 'pi' ? JSON.stringify(binding.command) : '',
    requestTimeoutMs: binding && binding.adapter !== 'pi' && binding.requestTimeoutMs
      ? String(binding.requestTimeoutMs) : '',
  };
}

export const adapterLabel = (adapter: StationAgentBinding['adapter']) =>
  ({pi: 'Pi', 'claude-code': 'Claude Code', launcher: '自定义 launcher'})[adapter];

export function parseBindingDraft(draft: AgentBindingDraft, requirePiSelection = false): StationAgentBinding | null {
  if (draft.adapter === 'inherit') return null;
  const provider = draft.provider.trim();
  const model = draft.model.trim();
  if (draft.adapter === 'pi') {
    if (requirePiSelection && (!provider || !model)) throw new Error('请填写这个项目使用的 Provider 和模型。');
    return {adapter: 'pi', ...(provider ? {provider} : {}), ...(model ? {model} : {})};
  }
  let command: unknown;
  try {
    command = JSON.parse(draft.command);
  } catch {
    throw new Error('启动命令必须是 JSON 字符串数组，例如 ["claude"]。');
  }
  if (!Array.isArray(command) || !command.length || command.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('启动命令的每个参数都必须是非空字符串，不拼接 shell 命令。');
  }
  if (!model) throw new Error('请填写请求模型。实际模型仍以执行回执为准。');
  const requestTimeoutMs = draft.requestTimeoutMs.trim() ? Number(draft.requestTimeoutMs) : undefined;
  if (requestTimeoutMs !== undefined && (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 900000)) {
    throw new Error('请求超时必须是 1–900000 毫秒的整数。');
  }
  return {adapter: draft.adapter, command: command as string[], model, ...(requestTimeoutMs === undefined ? {} : {requestTimeoutMs})};
}

export function selectBindingAdapter(adapter: AgentBindingDraft['adapter'], configured: StationAgentBinding | null): AgentBindingDraft {
  if (adapter === 'inherit') return agentBindingDraft(null);
  if (adapter === configured?.adapter) return agentBindingDraft(configured);
  return {adapter, provider: '', model: '', command: adapter === 'claude-code' ? '["claude"]' : '', requestTimeoutMs: ''};
}

export function AgentBindingFields({draft, disabled, scope, change, selectAdapter}: {
  draft: AgentBindingDraft;
  disabled: boolean;
  scope: 'node' | 'station' | 'dispatcher';
  change: (field: keyof AgentBindingDraft, value: string) => void;
  selectAdapter: (adapter: AgentBindingDraft['adapter']) => void;
}) {
  const inherited = scope === 'node';
  return <>
    {scope !== 'dispatcher' && <label>执行适配器<select aria-label="执行适配器" disabled={disabled} value={draft.adapter} onChange={event => selectAdapter(event.target.value as AgentBindingDraft['adapter'])}>
      {inherited && <option value="inherit">继承默认</option>}
      <option value="pi">Pi</option><option value="claude-code">Claude Code</option><option value="launcher">自定义 launcher</option>
    </select></label>}
    {draft.adapter !== 'inherit' && <>
      {draft.adapter === 'pi' && <label>{inherited ? 'Provider（留空继承项目默认）' : 'Provider'}<input aria-label="Agent provider" disabled={disabled} required={!inherited} value={draft.provider} maxLength={200} onChange={event => change('provider', event.target.value)} placeholder={inherited ? '项目默认 provider' : '例如 opencode-go'} /></label>}
      <label>{draft.adapter === 'pi' && inherited ? '请求模型（留空继承项目默认）' : '请求模型'}<input aria-label="Agent 请求模型" disabled={disabled} required={!inherited || draft.adapter !== 'pi'} maxLength={200} value={draft.model} onChange={event => change('model', event.target.value)} placeholder={draft.adapter === 'pi' && inherited ? '项目默认模型' : '厂商支持的模型 ID 或别名'} /></label>
      {draft.adapter !== 'pi' && <>
        <label>启动命令（JSON argv）<textarea aria-label="Agent 启动命令" disabled={disabled} required rows={3} value={draft.command} onChange={event => change('command', event.target.value)} placeholder='["node", "path/to/launcher.mjs"]' /></label>
        <label>单次请求超时（毫秒，可留空）<input aria-label="Agent 请求超时" disabled={disabled} type="number" min={1} max={900000} step={1} value={draft.requestTimeoutMs} onChange={event => change('requestTimeoutMs', event.target.value)} placeholder="使用适配器默认值" /></label>
      </>}
    </>}
  </>;
}
