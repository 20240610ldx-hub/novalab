import { createAnthropic } from '@ai-sdk/anthropic';

/**
 * M6 模型解耦的 dev 自测入口（intent Q7 裁决：cc-switch 的 tokenplan 端点）。
 * .env.local（gitignored）提供 VITE_NOVALAB_LLM_BASE_URL / _API_KEY / _MODEL；
 * P2.1 设置面板上线后改由 keychain/加密配置驱动，本文件退化为兜底。
 */

/** tokenplan 端点支持的模型（2026-10-06 冒烟验证）。 */
export const TOKENPLAN_MODELS = [
  'qwen3.8-max',
  'qwen3.8-flash',
  'deepseek-v4.1-flash',
  'glm-5.3',
] as const;

export function getDevLanguageModel() {
  const baseURL = import.meta.env.VITE_NOVALAB_LLM_BASE_URL as string | undefined;
  const apiKey = import.meta.env.VITE_NOVALAB_LLM_API_KEY as string | undefined;
  if (!baseURL || !apiKey) return null;
  const model =
    (import.meta.env.VITE_NOVALAB_LLM_MODEL as string | undefined) ?? TOKENPLAN_MODELS[0];
  return createAnthropic({ baseURL, apiKey })(model);
}
