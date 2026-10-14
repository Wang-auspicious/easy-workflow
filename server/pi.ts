// The user's Pi profile is the source of model selection and credentials.
// Secrets stay here; the dashboard and agent bootstrap receive metadata only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, createProvider, envApiKeyAuth, normalizeContext, type Model, type Api, type CredentialStore } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { withOpenCodeSessionHeader } from "@earendil-works/pi-ai/providers/opencode-headers";
import { EnvHttpProxyAgent, fetch as proxyFetch } from "undici";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { classifyFailure } from "../shared/failures.ts";
import { redactText } from "./mcp-security.ts";
import {ModelRequests, acquireModelRequest, reportModelResponse} from './model-requests.ts';
import {piModelDependency} from './agent-bindings.ts';

export const MODEL_REQUEST_DEADLINE = Symbol('model-request-deadline');
const requests = new ModelRequests(Math.max(1, Math.min(8, Number(process.env.FACTORY_MODEL_REQUESTS) || 2)));

let transport: EnvHttpProxyAgent | undefined;
const modelFetch: typeof globalThis.fetch = (input, init) => {
  transport ??= new EnvHttpProxyAgent({ noProxy: ["localhost", "127.0.0.1", "::1", process.env.NO_PROXY ?? process.env.no_proxy ?? ""].join(",") });
  return proxyFetch(input as Parameters<typeof proxyFetch>[0], { ...init, dispatcher: transport } as Parameters<typeof proxyFetch>[1]) as unknown as Promise<Response>;
};
export async function closeModelTransport() { const current = transport; transport = undefined; await current?.destroy(); }

export const piDirectory = () => process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const json = (file: string): any => { try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return {}; } };

export interface PiModelSelection { provider?: string; model?: string }

export interface PiModelOption {
  readonly provider: string;
  readonly model: string;
  readonly name: string;
  readonly input: readonly string[];
}

export function piSelection(selection?: PiModelSelection) {
  const settings = json(path.join(piDirectory(), "settings.json"));
  return {
    provider: selection?.provider ?? process.env.FACTORY_PROVIDER ?? settings.defaultProvider ?? "opencode-go",
    id: selection?.model ?? process.env.FACTORY_MODEL ?? settings.defaultModel ?? "deepseek-v4.1-flash",
    source: selection ? 'explicit' : process.env.FACTORY_MODEL || process.env.FACTORY_PROVIDER ? "environment" : settings.defaultModel ? "pi" : "fallback",
  };
}

function configuredKey(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  // Pi's shell-command credentials require its CLI auth lifecycle; never execute
  // an arbitrary configuration string inside the factory service.
  if (value.startsWith("!")) throw new Error("Pi 的命令式凭据暂不支持；请为 Easy Workflow 提供对应 API key 环境变量。");
  return process.env[value] ?? value;
}

function credential(provider: string) {
  if (provider === "opencode-go" && process.env.OPENCODE_API_KEY) return { type: "api_key" as const, key: process.env.OPENCODE_API_KEY };
  const entry = json(path.join(piDirectory(), "auth.json"))[provider];
  if (entry?.type === "api_key" && entry.key) return { type: "api_key" as const, key: configuredKey(entry.key) };
  if (entry?.type === "oauth") throw new Error(`Pi 的 ${provider} 使用 OAuth；当前 Easy Workflow 仅支持 API key 凭据。`);
  const custom = json(path.join(piDirectory(), "models.json")).providers?.[provider];
  if (custom?.apiKey) return { type: "api_key" as const, key: configuredKey(custom.apiKey) };
  if (provider === "opencode-go") {
    const old = json(path.join(os.homedir(), ".local/share/opencode/auth.json"))[provider];
    if (old?.key) return { type: "api_key" as const, key: old.key };
  }
  return undefined;
}

// Read Pi credentials without ever modifying its auth.json or refreshing OAuth.
const credentials: CredentialStore = {
  read: async (id) => credential(id),
  list: async () => Object.keys(json(path.join(piDirectory(), "auth.json"))).map((providerId) => ({ providerId, type: "api_key" as const })),
  modify: async () => { throw new Error("Easy Workflow does not write Pi credentials"); },
  delete: async () => { throw new Error("Easy Workflow does not write Pi credentials"); },
};

function configuredModels(provider: string) {
  const m = createModels({ credentials });
  const builtin = opencodeGoProvider();
  m.setProvider(builtin);
  const custom = json(path.join(piDirectory(), "models.json")).providers?.[provider];
  if (custom) {
    const inherited = m.getModels(provider);
    const catalog = new Map(inherited.map((model) => [model.id, model]));
    for (const entry of custom.models ?? []) {
      const previous = catalog.get(entry.id);
      catalog.set(entry.id, {
        ...previous, ...entry, provider, name: entry.name ?? previous?.name ?? entry.id,
        api: entry.api ?? custom.api ?? previous?.api ?? "openai-completions",
        baseUrl: entry.baseUrl ?? custom.baseUrl ?? previous?.baseUrl,
        input: entry.input ?? previous?.input ?? ["text"], reasoning: entry.reasoning ?? previous?.reasoning ?? false,
        cost: entry.cost ?? previous?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: entry.contextWindow ?? previous?.contextWindow ?? 32768,
        maxTokens: entry.maxTokens ?? previous?.maxTokens ?? 4096,
      });
    }
    const apis = { "openai-completions": openAICompletionsApi(), "openai-responses": openAIResponsesApi(), "anthropic-messages": anthropicMessagesApi() };
    // Preserve OpenCode Go's required sticky-session header even when Pi adds
    // custom models to its catalog. Generic API adapters alone omit this header.
    const api = provider === "opencode-go" ? Object.fromEntries(Object.entries(apis).map(([key, value]) => [key, withOpenCodeSessionHeader(value)])) : apis;
    m.setProvider(createProvider({
      id: provider, baseUrl: custom.baseUrl, headers: custom.headers,
      auth: { apiKey: envApiKeyAuth("Pi API key", provider === "opencode-go" ? ["OPENCODE_API_KEY"] : []) },
      models: [...catalog.values()],
      api,
    }));
  }
  return m;
}

/** Local, authenticated catalog metadata only. Never probes a provider or CLI. */
export function piModelCatalog(): PiModelOption[] {
  const providers = new Set(['opencode-go',
    ...Object.keys(json(path.join(piDirectory(), 'auth.json'))),
    ...Object.keys(json(path.join(piDirectory(), 'models.json')).providers ?? {}),
  ]);
  const options: PiModelOption[] = [];
  for (const provider of providers) {
    try {
      if (!credential(provider)?.key) continue;
      for (const model of configuredModels(provider).getModels(provider)) {
        // Validate identities without disclosing endpoint, headers, or credentials.
        piModelDependency({provider, model: model.id, endpoint: model.baseUrl});
        options.push({provider, model: model.id, name: model.name,
          input: [...model.input]});
      }
    } catch {
      // An unconfigured provider cannot become a station's self-selected model.
    }
  }
  return options;
}

export function models(requested?: PiModelSelection) {
  const selection = piSelection(requested);
  const m = configuredModels(selection.provider);
  const model = m.getModel(selection.provider, selection.id);
  if (!model) throw new Error(`Pi 模型未配置：${selection.provider}/${selection.id}；请检查 Pi settings.json / models.json。`);
  const dependency = piModelDependency({provider: model.provider, model: model.id, endpoint: model.baseUrl});
  const stream: StreamFn = async (model, context, options) => {
    // Capture the actual request model before it waits for shared capacity.
    const requestModel = {...model};
    const selected = {provider: requestModel.provider, model: requestModel.id};
    const requestDependency = piModelDependency({...selected, endpoint: requestModel.baseUrl});
    const release = await acquireModelRequest(requestDependency, options?.signal, () => requests.acquire(options?.signal));
    const deadline = (options as typeof options & { [MODEL_REQUEST_DEADLINE]?: { ms: number; expired: () => void } })?.[MODEL_REQUEST_DEADLINE];
    const timeout = deadline ? AbortSignal.timeout(deadline.ms) : undefined;
    if (timeout) timeout.addEventListener('abort', deadline!.expired, { once: true });
    const cleanup = () => { if (timeout) timeout.removeEventListener('abort', deadline!.expired); release(); };
    try {
      const signal = timeout ? AbortSignal.any([timeout, ...(options?.signal ? [options.signal] : [])]) : options?.signal;
      // Recovery belongs to the station transcript/circuit, not three nested SDK
      // attempts multiplied by station continuation and per-site batch retries.
      let transportDetail = '';
      const observedFetch: typeof fetch = async (input, init) => {
        try { return await modelFetch(input, init); }
        catch (error) {
          const e = error as {message?:string;code?:string;cause?:{code?:string;message?:string}};
          let endpoint = requestModel.provider;
          try { endpoint = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url).host; } catch {}
          transportDetail = redactModelError([endpoint,e.cause?.code??e.code,e.cause?.message??e.message].filter(Boolean).join(' · '), selected).slice(0,400);
          throw error;
        }
      };
      const response = m.streamSimple(requestModel, context, { ...options, signal, maxRetries: 0, fetch: observedFetch });
      void response.result().then(result => {
        try {
          if (!['error', 'aborted'].includes(result.stopReason)) {
            reportModelResponse({dependency: requestDependency, model: result.model, provider: result.provider,
              modelCalls: 1, usageReported: Boolean(result.usage), usage: result.usage ? {
                input: result.usage.input, output: result.usage.output, cost: result.usage.cost.total,
                cacheRead: result.usage.cacheRead, cacheWrite: result.usage.cacheWrite,
              } : undefined});
          }
          if (result.stopReason === 'error') {
            const message = redactModelError(result.errorMessage ?? '模型连接失败', selected);
            result.errorMessage = transportDetail ? `${message}（模型出口：${transportDetail}）` : message;
          }
        } finally {
          cleanup();
        }
      }, cleanup);
      return response;
    } catch (error) { cleanup(); throw error; }
  };
  return { models: m, model: model as Model<Api>, stream, dependency };
}

export function piStatus(requested?: PiModelSelection) {
  const selection = piSelection(requested);
  const selected = { provider: selection.provider, model: selection.id };
  try {
    const { model } = models(selected);
    return { ...selection, name: model.name, ready: Boolean(credential(selection.provider)?.key), error: null };
  } catch (error) {
    return { ...selection, name: selection.id, ready: false, error: redactModelError((error as Error).message, selected) };
  }
}

/** Provider errors may echo credentials; never forward them to conversation/SSE. */
export function redactModelError(message: string, selection?: PiModelSelection): string {
  let secret: string | undefined;
  try { secret = credential(piSelection(selection).provider)?.key; } catch { /* Invalid credential configuration is itself reportable. */ }
  return redactText(message, [secret, process.env.FACTORY_TOKEN]).replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [redacted]");
}

/** A bounded authenticated request: a reachable provider homepage proves no model capability. */
export async function probeModelConnection(timeoutMs = 20000, requested?: PiModelSelection, ownerSignal?: AbortSignal): Promise<{ ok: boolean; detail: string; fix?: string }> {
  ownerSignal?.throwIfAborted();
  const status = piStatus(requested);
  const label = `${status.provider}/${status.id}`;
  if (!status.ready) return { ok: false, detail: status.error ?? `${label} 没有可用凭据`, fix: "在 Pi 配置里补上 API key，或设置对应环境变量" };
  const secret = credential(status.provider)?.key;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = ownerSignal ? AbortSignal.any([ownerSignal, timeout]) : timeout;
  const redact = (text: string) => redactText(text, [secret]).replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [redacted]").slice(0, 400);
  try {
    const selection = models({ provider: status.provider, model: status.id });
    const request = await selection.stream(selection.model, normalizeContext({ messages: [{ role: "user", content: "Reply with exactly OK. No explanation.", timestamp: Date.now() }] }), { signal, maxTokens: 1024, reasoning: 'minimal', sessionId: `easy-workflow-preflight-${Date.now()}` });
    const result = await request.result();
    if (signal.aborted) throw new Error(`模型请求超时（${timeoutMs}ms）`);
    if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage || "模型请求失败");
    const answer = result.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
    if (result.stopReason === 'length' || !/^OK[.!。！]?$/i.test(answer)) throw new Error('模型未完成体检回答（空答、截断或未遵循指令）；不能据此恢复批量任务');
    return { ok: true, detail: `${label} · 已收到完整体检回答；批量恢复仍需真实工位验证` };
  } catch (error) {
    if (ownerSignal?.aborted) throw ownerSignal.reason;
    const message = signal.aborted ? `模型请求超时（${timeoutMs}ms）` : redact(String((error as Error)?.message ?? error));
    const failure = classifyFailure(new Error(message), { stage: "model" });
    return { ok: false, detail: `${label} · ${message}`, fix: failure.nextAction };
  }
}

export const apiKeyPresent = (selection?: PiModelSelection) => piStatus(selection).ready;
export const MODEL_ID = piSelection().id;
