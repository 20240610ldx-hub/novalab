/**
 * LLM 端点冒烟测试：node scripts/smoke.mjs（在 app/ 下运行）。
 * 读 .env.local → 走真实 AI SDK 路径发一次最小请求 → 打印结果与用量。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const baseURL = env.VITE_NOVALAB_LLM_BASE_URL;
const apiKey = env.VITE_NOVALAB_LLM_API_KEY;
const model = env.VITE_NOVALAB_LLM_MODEL || 'qwen3.8-max';
if (!baseURL || !apiKey) {
  console.error('SMOKE_FAIL: .env.local 缺少 BASE_URL 或 API_KEY');
  process.exit(1);
}

const anthropic = createAnthropic({ baseURL, apiKey });
const { text, usage } = await generateText({
  model: anthropic(model),
  prompt: 'Reply with exactly: NovaLab smoke ok',
});
console.log(`SMOKE_OK model=${model} text=${JSON.stringify(text.slice(0, 120))} usage=${JSON.stringify(usage)}`);
