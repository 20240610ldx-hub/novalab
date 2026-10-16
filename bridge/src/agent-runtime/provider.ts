/**
 * 兼容端点 → pi-ai Provider（ADR-012 spike）。
 *
 * 覆盖 M6 的两种 kind，与 app/src/agent/providers.ts 的 ProviderId 对齐：
 *  - openai-compat：Ollama / vLLM / LM Studio 等 `/v1/chat/completions`；
 *  - anthropic-compat：Anthropic Messages 协议（ADR-008 的 tokenplan 自测代理即此类）。
 * 凭据由调用方显式传入（ADR-008：本模块不读任何凭据存储、不读环境变量）；
 * keyless 的本地服务省略 apiKey 即可。
 *
 * baseUrl 约定与 app 一致（含 `/v1`，如 http://127.0.0.1:11434/v1）。pi 的 Anthropic 实现
 * 自己拼 `/v1/messages`，这里去掉尾部 `/v1`，两条路径打到同一个上游 URL（单测钉住）。
 */

import { createModels, createProvider, type Model, type Models } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export type CompatKind = 'openai-compat' | 'anthropic-compat';

export interface CompatConfig {
  kind?: CompatKind;
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  providerId?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface CompatHandle {
  models: Models;
  model: Model<'openai-completions'> | Model<'anthropic-messages'>;
}

const COMMON = {
  reasoning: false,
  input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function createCompatModel(cfg: CompatConfig): CompatHandle {
  const kind = cfg.kind ?? 'openai-compat';
  const providerId = cfg.providerId ?? `novalab-${kind}`;
  const apiKey = cfg.apiKey;
  const auth = {
    apiKey: {
      name: 'NovaLab endpoint key',
      resolve: async () => ({ auth: apiKey ? { apiKey } : {} }),
    },
  };
  const base = {
    id: cfg.modelId,
    name: cfg.modelId,
    provider: providerId,
    ...COMMON,
    contextWindow: cfg.contextWindow ?? 128_000,
    maxTokens: cfg.maxTokens ?? 8_192,
  };
  const models = createModels();
  if (kind === 'anthropic-compat') {
    const baseUrl = cfg.baseUrl.replace(/\/v1\/?$/, '');
    const model: Model<'anthropic-messages'> = { ...base, api: 'anthropic-messages', baseUrl };
    models.setProvider(
      createProvider({ id: providerId, name: 'NovaLab Anthropic-compatible', baseUrl, auth, models: [model], api: anthropicMessagesApi() }),
    );
    return { models, model };
  }
  const model: Model<'openai-completions'> = {
    ...base,
    api: 'openai-completions',
    baseUrl: cfg.baseUrl,
    // 未知自建端点：保守关掉 developer role / reasoning_effort / store（README: Ollama/vLLM 常见）
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false },
  };
  models.setProvider(
    createProvider({ id: providerId, name: 'NovaLab OpenAI-compatible', baseUrl: cfg.baseUrl, auth, models: [model], api: openAICompletionsApi() }),
  );
  return { models, model };
}

/** openai-compat 的便捷入口。 */
export function createOpenAICompat(cfg: Omit<CompatConfig, 'kind'>): CompatHandle {
  return createCompatModel({ ...cfg, kind: 'openai-compat' });
}
