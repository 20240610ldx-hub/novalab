import { createAnthropic } from '@ai-sdk/anthropic';
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from 'ai';
import { bridge } from '../bridge/client';
import { createOpenAICompat } from './openaiCompat';
import {
  DEV_ENV_PROVIDER_ID,
  isProviderStorageRemote,
  LLM_PROXY_ORIGIN,
  requestTargetFor,
  TOKENPLAN_MODELS,
  type ProviderConfig,
  type ProviderState,
} from './providers';
import { llmFetch } from './retryFetch';

/**
 * 模型构造（从 providers.ts 拆出）：这里是 AI SDK（ai / @ai-sdk/* / zod）进入前端的唯一入口。
 * providers.ts 只管配置与存储，启动路径（store/agent、StatusBar）只依赖它；
 * 本模块只被 Agent 面板与设置面板引用，二者按需懒加载，SDK 不进首屏主包。
 */

/**
 * F7：未知模型 id 的输出预算。@ai-sdk/anthropic 对它不认识的模型（tokenplan 的 qwen/glm/deepseek）
 * 把上限压到 4096；openai-compat 不传 max_tokens 时由服务端默认（DeepSeek 为 4096）。
 * 长代码提议会被截断，所以显式给 8192：主流兼容服务的输出上限都 ≥ 8K。
 */
export const UNKNOWN_MODEL_MAX_OUTPUT_TOKENS = 8192;

/** 已知 Claude 模型交给 SDK 按型号取上限；其余显式设预算。 */
export function outputTokenBudget(config: Pick<ProviderConfig, 'kind' | 'model'>): number | undefined {
  if (config.kind === 'anthropic-compat' && /^claude-/.test(config.model)) return undefined;
  return UNKNOWN_MODEL_MAX_OUTPUT_TOKENS;
}

export function createLanguageModel(config: ProviderConfig): LanguageModel {
  const model = createBaseModel(config);
  const budget = outputTokenBudget(config);
  // 调用方显式传 maxOutputTokens 时仍以调用方为准（defaultSettingsMiddleware 只补缺省）
  return budget === undefined
    ? model
    : wrapLanguageModel({ model, middleware: defaultSettingsMiddleware({ settings: { maxOutputTokens: budget } }) });
}

type WrappableModel = Parameters<typeof wrapLanguageModel>[0]['model'];

function createBaseModel(config: ProviderConfig): WrappableModel {
  const remote = isProviderStorageRemote();
  const { baseURL, apiKey } = requestTargetFor(config, remote, bridge.getLlmProxyOrigin?.() ?? LLM_PROXY_ORIGIN);
  const proxyHeaders = remote ? bridge.getLlmProxyHeaders?.() : undefined;
  // 网络波动防御：代理与直连两条路径共用同一重试层（见 retryFetch.ts）
  const settings = { baseURL, apiKey, fetch: llmFetch, ...(proxyHeaders ? { headers: proxyHeaders } : {}) };
  switch (config.kind) {
    case 'anthropic-compat':
      return createAnthropic(settings)(config.model);
    case 'openai-compat':
      // deepseek / ollama / vLLM 等走 OpenAI 兼容协议（本地最小 provider，见 openaiCompat.ts）
      return createOpenAICompat(settings)(config.model) as WrappableModel;
  }
}

/**
 * dev .env.local 兜底模型。与用户 provider 走同一构造路径（重试层 + 输出预算）：
 * bridge 就绪 → 代理 id='dev-env'（已播种进加密存储，key 不驻留浏览器请求）；
 * 未就绪 → DEV（vite）同源代理 /llm/v1（vite.config.ts 转发 envBaseURL），生产直连（端点缺 CORS 头会失败）。
 */
export function getDevLanguageModel(): LanguageModel | null {
  const envBaseURL = import.meta.env.VITE_NOVALAB_LLM_BASE_URL as string | undefined;
  const apiKey = import.meta.env.VITE_NOVALAB_LLM_API_KEY as string | undefined;
  if (!envBaseURL || !apiKey) return null;
  const model = (import.meta.env.VITE_NOVALAB_LLM_MODEL as string | undefined) ?? TOKENPLAN_MODELS[0];
  return createLanguageModel({
    id: DEV_ENV_PROVIDER_ID,
    kind: 'anthropic-compat',
    name: 'dev .env.local',
    baseURL: import.meta.env.DEV ? '/llm/v1' : envBaseURL,
    apiKey,
    model,
  });
}

/** 当前生效模型：用户选中的 provider 优先，否则 dev .env.local 兜底，都没有 → null。 */
export function resolveActiveModel(state: ProviderState): {
  model: LanguageModel | null;
  source: 'user' | 'dev-env' | null;
  label: string;
} {
  const active =
    state.activeProviderId != null
      ? state.providers.find((p) => p.id === state.activeProviderId)
      : undefined;
  if (active) {
    return { model: createLanguageModel(active), source: 'user', label: `${active.name} · ${active.model}` };
  }
  const dev = getDevLanguageModel();
  if (dev) {
    const model = (import.meta.env.VITE_NOVALAB_LLM_MODEL as string | undefined) ?? TOKENPLAN_MODELS[0];
    return { model: dev, source: 'dev-env', label: `dev .env.local · ${model}` };
  }
  return { model: null, source: null, label: '未配置' };
}
