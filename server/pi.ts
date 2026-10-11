// The user's Pi profile is the source of model selection and credentials.
// Secrets stay here; the dashboard and agent bootstrap receive metadata only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, createProvider, envApiKeyAuth, type Model, type Api, type CredentialStore } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { withOpenCodeSessionHeader } from "@earendil-works/pi-ai/providers/opencode-headers";
import { EnvHttpProxyAgent, fetch as proxyFetch } from "undici";
import type { StreamFn } from "@earendil-works/pi-agent-core";

let transport: EnvHttpProxyAgent | undefined;
const modelFetch: typeof globalThis.fetch = (input, init) => {
  transport ??= new EnvHttpProxyAgent({ noProxy: ["localhost", "127.0.0.1", "::1", process.env.NO_PROXY ?? process.env.no_proxy ?? ""].join(",") });
  return proxyFetch(input as Parameters<typeof proxyFetch>[0], { ...init, dispatcher: transport } as Parameters<typeof proxyFetch>[1]) as unknown as Promise<Response>;
};
export async function closeModelTransport() { const current = transport; transport = undefined; await current?.destroy(); }

export const piDirectory = () => process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const json = (file: string): any => { try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return {}; } };

export function piSelection() {
  const settings = json(path.join(piDirectory(), "settings.json"));
  return {
    provider: process.env.FACTORY_PROVIDER ?? settings.defaultProvider ?? "opencode-go",
    id: process.env.FACTORY_MODEL ?? settings.defaultModel ?? "deepseek-v4.1-flash",
    source: process.env.FACTORY_MODEL || process.env.FACTORY_PROVIDER ? "environment" : settings.defaultModel ? "pi" : "fallback",
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

export function models() {
  const selection = piSelection();
  const m = createModels({ credentials });
  const builtin = opencodeGoProvider();
  m.setProvider(builtin);
  const custom = json(path.join(piDirectory(), "models.json")).providers?.[selection.provider];
  if (custom) {
    const inherited = m.getModels(selection.provider);
    const catalog = new Map(inherited.map((model) => [model.id, model]));
    for (const entry of custom.models ?? []) {
      const previous = catalog.get(entry.id);
      catalog.set(entry.id, {
        ...previous, ...entry, provider: selection.provider, name: entry.name ?? previous?.name ?? entry.id,
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
    const api = selection.provider === "opencode-go" ? Object.fromEntries(Object.entries(apis).map(([key, value]) => [key, withOpenCodeSessionHeader(value)])) : apis;
    m.setProvider(createProvider({
      id: selection.provider, baseUrl: custom.baseUrl, headers: custom.headers,
      auth: { apiKey: envApiKeyAuth("Pi API key", selection.provider === "opencode-go" ? ["OPENCODE_API_KEY"] : []) },
      models: [...catalog.values()],
      api,
    }));
  }
  const model = m.getModel(selection.provider, selection.id);
  if (!model) throw new Error(`Pi 模型未配置：${selection.provider}/${selection.id}；请检查 Pi settings.json / models.json。`);
  const stream: StreamFn = (model, context, options) => m.streamSimple(model, context, { ...options, fetch: modelFetch });
  return { models: m, model: model as Model<Api>, stream };
}

export function piStatus() {
  const selection = piSelection();
  try {
    const { model } = models();
    return { ...selection, name: model.name, ready: Boolean(credential(selection.provider)?.key), error: null };
  } catch (error) {
    return { ...selection, name: selection.id, ready: false, error: (error as Error).message };
  }
}

export const apiKeyPresent = () => piStatus().ready;
export const MODEL_ID = piSelection().id;
