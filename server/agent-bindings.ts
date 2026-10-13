import crypto from 'node:crypto';
import type {ModelDependency, StationAgentBinding} from '../shared/types.ts';
import {ControlError} from './errors.ts';
import {factorySecrets} from './mcp-security.ts';

function invalid(message: string): never {
  throw new ControlError(422, 'invalid_agent_binding', message);
}

function identityDigest(value: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function dependencyLabel(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\r\n\0]/.test(value) ||
      factorySecrets().some(secret => value.includes(secret))) {
    throw new ControlError(422, 'invalid_model_dependency', `${field} 不是可展示的模型依赖标识`);
  }
  return value;
}

/** Models at the same provider endpoint share a fault domain, not a model name. */
export function piModelDependency(selection: {provider: string; model: string; endpoint: string}): ModelDependency {
  const provider = dependencyLabel(selection.provider, 'provider');
  const model = dependencyLabel(selection.model, 'model');
  let endpoint: URL;
  try {
    endpoint = new URL(selection.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('unsupported endpoint');
  } catch {
    // URL parsing errors can include authentication or query parameters.
    throw new ControlError(422, 'invalid_model_dependency', '模型依赖需要完整 HTTP(S) 端点');
  }
  const address = endpoint.origin + endpoint.pathname.replace(/\/+$/, '');
  return Object.freeze({
    key: `pi:${identityDigest(['model-dependency/v1', provider, address])}`,
    adapter: 'pi', provider, model,
  });
}

/** Closed clients disclose an executor identity, never an inferred provider or argv. */
export function closedModelDependency(binding: Exclude<StationAgentBinding, {adapter: 'pi'}>): ModelDependency {
  if (!['claude-code', 'launcher'].includes(binding.adapter) || !Array.isArray(binding.command) ||
      !binding.command.length || binding.command.some(value => typeof value !== 'string' || !value.trim())) {
    throw new ControlError(422, 'invalid_model_dependency', '闭源模型依赖需要已解析的 adapter 和 argv');
  }
  const model = dependencyLabel(binding.model, 'model');
  return Object.freeze({
    key: `${binding.adapter}:${identityDigest(['model-dependency/v1', binding.adapter, identityDigest(binding.command), model])}`,
    adapter: binding.adapter, model,
  });
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
