import type {StationAgentBinding} from '../../../shared/types.ts';

export interface AgentBindingDraft {
  adapter: 'inherit' | StationAgentBinding['adapter'];
  provider: string;
  model: string;
  command: string;
  requestTimeoutMs: string;
}

export interface PiModelChoice {
  readonly provider: string;
  readonly model: string;
  readonly name: string;
}

export function agentBindingDraft(binding: StationAgentBinding | null): AgentBindingDraft {
  return {
    adapter: binding?.adapter ?? 'inherit',
    provider: binding && 'provider' in binding ? binding.provider ?? '' : '',
    model: binding?.model ?? '',
    command: binding && binding.adapter !== 'pi' && binding.command ? JSON.stringify(binding.command) : '',
    requestTimeoutMs: binding && binding.adapter !== 'pi' && binding.requestTimeoutMs
      ? String(binding.requestTimeoutMs) : '',
  };
}

export const adapterLabel = (adapter: StationAgentBinding['adapter']) =>
  ({pi: 'Pi', 'claude-code': 'Claude Code', opencode: 'OpenCode', codex: 'Codex', launcher: '自定义 launcher'})[adapter];

export function parseBindingDraft(draft: AgentBindingDraft, requirePiSelection = false): StationAgentBinding | null {
  if (draft.adapter === 'inherit') return null;
  const provider = draft.provider.trim();
  const model = draft.model.trim();
  if (draft.adapter === 'pi') {
    if (requirePiSelection && (!provider || !model)) throw new Error('请填写这个项目使用的 Provider 和模型。');
    return {adapter: 'pi', ...(provider ? {provider} : {}), ...(model ? {model} : {})};
  }
  let command: string[] | undefined;
  if (draft.command.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft.command);
    } catch {
      throw new Error('启动命令必须是 JSON 字符串数组，例如 ["claude"]。');
    }
    if (!Array.isArray(parsed) || !parsed.length || parsed.some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error('启动命令的每个参数都必须是非空字符串，不拼接 shell 命令。');
    }
    command = parsed as string[];
  }
  if (draft.adapter === 'launcher' && (!command || !model)) throw new Error('自定义 launcher 需要启动命令和请求模型。');
  const requestTimeoutMs = draft.requestTimeoutMs.trim() ? Number(draft.requestTimeoutMs) : undefined;
  if (requestTimeoutMs !== undefined && (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 900000)) {
    throw new Error('请求超时必须是 1–900000 毫秒的整数。');
  }
  const timeout = requestTimeoutMs === undefined ? {} : {requestTimeoutMs};
  if (draft.adapter === 'launcher') return {adapter: 'launcher', command: command!, model, ...timeout};
  return {adapter: draft.adapter, ...(command ? {command} : {}), ...(model ? {model} : {}),
    ...(['opencode', 'codex'].includes(draft.adapter) && provider ? {provider} : {}), ...timeout};
}

export function selectBindingAdapter(adapter: AgentBindingDraft['adapter'], configured: StationAgentBinding | null): AgentBindingDraft {
  if (adapter === 'inherit') return agentBindingDraft(null);
  if (adapter === configured?.adapter) return agentBindingDraft(configured);
  return {adapter, provider: '', model: '', command: '', requestTimeoutMs: ''};
}

export function AgentBindingFields({draft, disabled, scope, change, selectAdapter, models, selectModel}: {
  draft: AgentBindingDraft;
  disabled: boolean;
  scope: 'node' | 'station' | 'dispatcher';
  change: (field: keyof AgentBindingDraft, value: string) => void;
  selectAdapter: (adapter: AgentBindingDraft['adapter']) => void;
  models?: readonly PiModelChoice[];
  selectModel?: (model: PiModelChoice) => void;
}) {
  const inherited = scope === 'node';
  const native = ['opencode', 'codex', 'claude-code'].includes(draft.adapter);
  const modelLabel = scope === 'node' ? '本节点已接入模型' : scope === 'station' ? '工位默认已接入模型' : '主调度已接入模型';
  const selectedModel = models?.findIndex(model => model.provider === draft.provider && model.model === draft.model) ?? -1;
  return <>
    <label>执行适配器<select aria-label="执行适配器" disabled={disabled} value={draft.adapter} onChange={event => selectAdapter(event.target.value as AgentBindingDraft['adapter'])}>
      {inherited && <option value="inherit">继承默认</option>}
      <option value="pi">Pi</option><option value="opencode">OpenCode</option><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="launcher">自定义 launcher</option>
    </select></label>
    {['pi', 'inherit'].includes(draft.adapter) && Boolean(models?.length) && selectModel &&
      <label>{modelLabel}<select aria-label={modelLabel} disabled={disabled} value={selectedModel < 0 ? '' : String(selectedModel)} onChange={event => {
        const model = models?.[Number(event.target.value)];
        if (model) selectModel(model);
      }}>
        <option value="" disabled>{inherited ? '选择模型，将保存为本节点独立配置' : '选择已接入模型'}</option>
        {models!.map((model, index) => <option key={`${model.provider}/${model.model}`} value={index}>{model.provider} / {model.name || model.model}</option>)}
      </select></label>}
    {draft.adapter !== 'inherit' && <>
      {draft.adapter === 'pi' && <label>{inherited ? 'Provider（留空继承项目默认）' : 'Provider'}<input aria-label="Agent provider" disabled={disabled} required={!inherited} value={draft.provider} maxLength={200} onChange={event => change('provider', event.target.value)} placeholder={inherited ? '项目默认 provider' : '例如 opencode-go'} /></label>}
      {['opencode', 'codex'].includes(draft.adapter) && <label>Provider（留空使用客户端配置）<input aria-label="Agent provider" disabled={disabled} value={draft.provider} maxLength={200} onChange={event => change('provider', event.target.value)} placeholder="客户端已配置的 Provider" /></label>}
      <label>{draft.adapter === 'pi' && inherited ? '请求模型（留空继承项目默认）' : native ? '请求模型（留空使用客户端配置）' : '请求模型'}<input aria-label="Agent 请求模型" disabled={disabled} required={!native && (!inherited || draft.adapter !== 'pi')} maxLength={200} value={draft.model} onChange={event => change('model', event.target.value)} placeholder={draft.adapter === 'pi' && inherited ? '项目默认模型' : native ? '客户端当前模型' : '厂商支持的模型 ID 或别名'} /></label>
      {draft.adapter !== 'pi' && <>
        <label>{native ? '启动命令（可留空自动查找本机 CLI）' : '启动命令（JSON argv）'}<textarea aria-label="Agent 启动命令" disabled={disabled} required={!native} rows={3} value={draft.command} onChange={event => change('command', event.target.value)} placeholder={native ? `例如 ["${draft.adapter === 'claude-code' ? 'claude' : draft.adapter}"]` : '["node", "path/to/launcher.mjs"]'} /></label>
        <label>单次请求超时（毫秒，可留空）<input aria-label="Agent 请求超时" disabled={disabled} type="number" min={1} max={900000} step={1} value={draft.requestTimeoutMs} onChange={event => change('requestTimeoutMs', event.target.value)} placeholder="使用适配器默认值" /></label>
      </>}
      {native && <p className="muted">凭据从该客户端的本机配置读取。{scope === 'dispatcher' ? '保存配置不会启动客户端；主调度的新对话使用它，恢复中的对话沿用原底座。' : '保存配置不会启动客户端；节点下次执行才使用它。'}客户端占用一个模型调用名额，工具中的额外模型调用也需要空位。</p>}
    </>}
  </>;
}
