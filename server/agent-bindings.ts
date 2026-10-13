import type {StationAgentBinding} from '../shared/types.ts';
import {ControlError} from './errors.ts';
import {factorySecrets} from './mcp-security.ts';

function invalid(message: string): never {
  throw new ControlError(422, 'invalid_agent_binding', message);
}

/** Validate the persisted and manifest boundary without loading a vendor SDK. */
export function parseAgentBinding(value: unknown): StationAgentBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('Agent 配置必须是对象');
  }
  const input = value as Record<string, unknown>;
  const adapter = input.adapter;
  if (!['pi', 'claude-code', 'launcher'].includes(String(adapter))) {
    return invalid('请选择 Pi、Claude Code 或自定义 launcher');
  }
  const allowed = adapter === 'pi' ? ['adapter', 'provider', 'model'] :
    ['adapter', 'command', 'model', 'requestTimeoutMs'];
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    return invalid('Agent 配置含未支持字段；凭据、工作目录和工具作用域由宿主管理');
  }
  const name = (key: 'provider' | 'model', required: boolean) => {
    const raw = input[key];
    if (raw === undefined && !required) return undefined;
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 200 || /[\r\n\0]/.test(raw)) {
      return invalid(`${key} 必须是非空单行文本，不超过 200 字符`);
    }
    return raw.trim();
  };
  if (factorySecrets().some(secret => JSON.stringify(input).includes(secret))) {
    return invalid('不能将工厂控制凭据写入 Agent 配置');
  }
  if (adapter === 'pi') {
    const provider = name('provider', false);
    const model = name('model', false);
    return {adapter, ...(provider ? {provider} : {}), ...(model ? {model} : {})};
  }
  if (!Array.isArray(input.command) || input.command.length < 1 || input.command.length > 32 ||
      input.command.some(arg => typeof arg !== 'string' || !arg.trim() || arg.length > 4000 || /[\r\n\0]/.test(arg))) {
    return invalid('启动命令必须是 1–32 个非空字符串组成的 argv 数组');
  }
  const requestTimeoutMs = input.requestTimeoutMs;
  if (requestTimeoutMs !== undefined &&
      (typeof requestTimeoutMs !== 'number' || !Number.isSafeInteger(requestTimeoutMs) ||
        requestTimeoutMs < 1 || requestTimeoutMs > 900000)) {
    return invalid('Agent 请求超时必须是 1–900000 毫秒的整数');
  }
  return {
    adapter: adapter as 'claude-code' | 'launcher', command: [...input.command] as string[],
    model: name('model', true)!, ...(requestTimeoutMs !== undefined ? {requestTimeoutMs} : {}),
  };
}

export function agentCapabilities(binding: StationAgentBinding) {
  return {
    stream: binding.adapter === 'pi', cancel: true,
    resume: binding.adapter !== 'launcher', usage: binding.adapter === 'launcher' ? 'unknown' as const : 'reported' as const,
  };
}
