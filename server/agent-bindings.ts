import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
export function closedModelDependency(binding: {
  adapter: Exclude<StationAgentBinding, {adapter: 'pi'}>['adapter'];
  command?: string[];
  model?: string;
  provider?: string;
  requestTimeoutMs?: number;
}): ModelDependency {
  const command = binding.command ?? (binding.adapter === 'launcher' ? undefined : [nativeExecutable(binding.adapter)]);
  if (!['claude-code', 'launcher', 'opencode', 'codex'].includes(binding.adapter) || !Array.isArray(command) ||
      !command.length || command.some(value => typeof value !== 'string' || !value.trim())) {
    throw new ControlError(422, 'invalid_model_dependency', '闭源模型依赖需要已解析的 adapter 和 argv');
  }
  const model = binding.model === undefined && binding.adapter !== 'launcher' ? 'native-default' : dependencyLabel(binding.model, 'model');
  const provider = 'provider' in binding && binding.provider !== undefined ? dependencyLabel(binding.provider, 'provider') : undefined;
  return Object.freeze({
    key: `${binding.adapter}:${identityDigest(['model-dependency/v1', binding.adapter, identityDigest(command), model, ...(provider ? [provider] : [])])}`,
    adapter: binding.adapter, model, ...(provider ? {provider} : {}),
  });
}

function nativeExecutable(adapter: string) {
  return adapter === 'claude-code' ? 'claude' : adapter;
}

/** Resolve files only. Probing a CLI by spawning it can authenticate or spend. */
export function resolveNativeCommand(adapter: 'claude-code' | 'opencode' | 'codex'): string[] {
  const executable = nativeExecutable(adapter);
  const locations = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const packageEntry = adapter === 'codex' ? ['@openai', 'codex', 'bin', 'codex.js']
    : adapter === 'claude-code' ? ['@anthropic-ai', 'claude-code', 'cli.js'] : ['opencode-ai', 'bin', 'opencode'];
  const exists = (file: string) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  };
  for (const directory of locations) {
    const file = path.join(directory.replace(/^"|"$/g, ''), executable + (process.platform === 'win32' ? '.exe' : ''));
    if (exists(file)) return [file];
    // Windows npm command shims cannot run with shell:false. Use the known
    // vendor entrypoint next to the shim, without evaluating shell contents.
    if (process.platform === 'win32' && exists(path.join(directory, `${executable}.cmd`))) {
      const script = path.join(directory, 'node_modules', ...packageEntry);
      if (exists(script)) return [process.execPath, script];
    }
  }
  throw new ControlError(422, 'native_agent_unavailable', `未找到本机 ${executable} CLI；请安装 CLI 或配置启动 argv。桌面应用不等于可调用的 CLI。`);
}

/** Validate the persisted and manifest boundary without loading a vendor SDK. */
export function parseAgentBinding(value: unknown): StationAgentBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('Agent 配置必须是对象');
  }
  const input = value as Record<string, unknown>;
  const adapter = input.adapter;
  if (!['pi', 'claude-code', 'launcher', 'opencode', 'codex'].includes(String(adapter))) {
    return invalid('请选择 Pi、OpenCode、Codex、Claude Code 或自定义 launcher');
  }
  const allowed = adapter === 'pi' ? ['adapter', 'provider', 'model'] :
    ['adapter', 'command', 'model', 'requestTimeoutMs', ...(['opencode', 'codex'].includes(String(adapter)) ? ['provider'] : [])];
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
  if ((input.command !== undefined || adapter === 'launcher') && (!Array.isArray(input.command) || input.command.length < 1 || input.command.length > 32 ||
      input.command.some(arg => typeof arg !== 'string' || !arg.trim() || arg.length > 4000 || /[\r\n\0]/.test(arg)))) {
    return invalid('启动命令必须是 1–32 个非空字符串组成的 argv 数组');
  }
  const requestTimeoutMs = input.requestTimeoutMs;
  if (requestTimeoutMs !== undefined &&
      (typeof requestTimeoutMs !== 'number' || !Number.isSafeInteger(requestTimeoutMs) ||
        requestTimeoutMs < 1 || requestTimeoutMs > 900000)) {
    return invalid('Agent 请求超时必须是 1–900000 毫秒的整数');
  }
  const model = name('model', adapter === 'launcher');
  const provider = ['opencode', 'codex'].includes(String(adapter)) ? name('provider', false) : undefined;
  if (adapter === 'opencode' && model && !provider && !model.includes('/')) {
    return invalid('OpenCode 模型覆盖需要 provider/model 或同时指定 provider；留空沿用原生默认');
  }
  return {adapter: adapter as 'claude-code' | 'opencode' | 'codex' | 'launcher',
    ...(input.command !== undefined ? {command: [...input.command as string[]]} : {}),
    ...(model ? {model} : {}), ...(provider ? {provider} : {}),
    ...(requestTimeoutMs !== undefined ? {requestTimeoutMs} : {})} as StationAgentBinding;
}

export function agentCapabilities(binding: StationAgentBinding) {
  return {
    stream: binding.adapter === 'pi', cancel: true,
    resume: binding.adapter !== 'launcher', usage: binding.adapter === 'launcher' ? 'unknown' as const
      : binding.adapter === 'codex' ? 'tokens-only' as const : 'reported' as const,
  };
}
