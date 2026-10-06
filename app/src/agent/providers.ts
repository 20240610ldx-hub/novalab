import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import { createOpenAICompat } from './openaiCompat';

/**
 * M6 模型解耦：provider 注册表（P2.1）。
 *
 * 层级：
 *  1. 用户配置（SettingsPanel 增删改）→ localStorage 键 `novalab.providers`。
 *     ⚠️ 明文存储 —— P4 迁移 keychain/加密配置（ADR-008），当前仅本机 localStorage，
 *     界面（SettingsPanel）常驻显著警告。
 *  2. dev 兜底：.env.local（gitignored）的 VITE_NOVALAB_LLM_*（ADR-008 凭据纪律：
 *     永不自动读取凭据存储，Owner 手动填写）。getDevLanguageModel 保留为兜底。
 */

export type ProviderId = 'anthropic-compat' | 'openai-compat';

export interface ProviderConfig {
  /** 用户配置唯一 id（crypto.randomUUID 或时间戳）。 */
  id: string;
  kind: ProviderId;
  /** 显示名（如 "tokenplan"、"deepseek"、"ollama-local"）。 */
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface ProviderState {
  providers: ProviderConfig[];
  /** null = 无用户选择 → 走 dev .env.local 兜底。 */
  activeProviderId: string | null;
}

export const PROVIDERS_STORAGE_KEY = 'novalab.providers';

/** SettingsPanel 必须原文展示的存储警告（spec：P4 迁移 keychain）。 */
export const STORAGE_WARNING =
  '⚠️ API Key 当前以明文仅存于本机浏览器 localStorage（键 novalab.providers），不上传、不同步；P4 将迁移 keychain/加密存储。请勿在此填入生产环境密钥。';

/** tokenplan 端点支持的模型（2026-10-06 冒烟验证）。 */
export const TOKENPLAN_MODELS = [
  'qwen3.8-max',
  'qwen3.8-flash',
  'deepseek-v4.1-flash',
  'glm-5.3',
] as const;

/** anthropic-compat + tokenplan baseURL → 预设模型下拉；其余返回空（自由输入）。 */
export function modelSuggestionsFor(config: Pick<ProviderConfig, 'kind' | 'baseURL'>): string[] {
  if (config.kind === 'anthropic-compat' && /tokenplan/i.test(config.baseURL)) {
    return [...TOKENPLAN_MODELS];
  }
  return [];
}

export function createLanguageModel(config: ProviderConfig): LanguageModel {
  switch (config.kind) {
    case 'anthropic-compat':
      return createAnthropic({ baseURL: config.baseURL, apiKey: config.apiKey })(config.model);
    case 'openai-compat':
      // deepseek / ollama / vLLM 等走 OpenAI 兼容协议（本地最小 provider，见 openaiCompat.ts）
      return createOpenAICompat({ baseURL: config.baseURL, apiKey: config.apiKey })(config.model);
  }
}

/* ---------------- localStorage 持久化（明文；node/测试环境无 localStorage 时安全退化） ---------------- */

export const DEFAULT_PROVIDER_STATE: ProviderState = { providers: [], activeProviderId: null };

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function isProviderConfig(v: unknown): v is ProviderConfig {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    (r.kind === 'anthropic-compat' || r.kind === 'openai-compat') &&
    typeof r.name === 'string' &&
    typeof r.baseURL === 'string' &&
    typeof r.apiKey === 'string' &&
    typeof r.model === 'string'
  );
}

export function loadProviderState(): ProviderState {
  const s = storage();
  if (!s) return { ...DEFAULT_PROVIDER_STATE };
  let raw: string | null = null;
  try {
    raw = s.getItem(PROVIDERS_STORAGE_KEY);
  } catch {
    return { ...DEFAULT_PROVIDER_STATE };
  }
  if (!raw) return { ...DEFAULT_PROVIDER_STATE };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const providers = Array.isArray(parsed.providers)
      ? parsed.providers.filter(isProviderConfig)
      : [];
    const activeProviderId =
      typeof parsed.activeProviderId === 'string' && providers.some((p) => p.id === parsed.activeProviderId)
        ? parsed.activeProviderId
        : null;
    return { providers, activeProviderId };
  } catch {
    return { ...DEFAULT_PROVIDER_STATE }; // 损坏载荷 → 回退默认，不抛
  }
}

export function saveProviderState(state: ProviderState): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储满/隐私模式：静默失败（内存态仍然生效）
  }
}

/* ---------------- dev 兜底（.env.local） ---------------- */

export function getDevLanguageModel(): LanguageModel | null {
  const baseURL = import.meta.env.VITE_NOVALAB_LLM_BASE_URL as string | undefined;
  const apiKey = import.meta.env.VITE_NOVALAB_LLM_API_KEY as string | undefined;
  if (!baseURL || !apiKey) return null;
  const model =
    (import.meta.env.VITE_NOVALAB_LLM_MODEL as string | undefined) ?? TOKENPLAN_MODELS[0];
  return createAnthropic({ baseURL, apiKey })(model);
}

export function hasDevEnvModel(): boolean {
  return Boolean(
    import.meta.env.VITE_NOVALAB_LLM_BASE_URL && import.meta.env.VITE_NOVALAB_LLM_API_KEY,
  );
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
