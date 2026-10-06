import { beforeEach, describe, expect, it } from 'vitest';
import {
  createLanguageModel,
  loadProviderState,
  modelSuggestionsFor,
  PROVIDERS_STORAGE_KEY,
  saveProviderState,
  TOKENPLAN_MODELS,
  type ProviderConfig,
} from './providers';

/**
 * provider 注册表的持久化/预设/构造单测（P2.1）。
 * localStorage 用内存 stub（node 环境无 DOM）；providers.ts 的 storage() 是运行时探测。
 */

function installMockStorage() {
  const map = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  return map;
}

function makeConfig(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'p1',
    kind: 'anthropic-compat',
    name: 'tokenplan',
    baseURL: 'https://tokenplan.local/v1',
    apiKey: 'sk-test',
    model: TOKENPLAN_MODELS[0],
    ...over,
  };
}

let store: Map<string, string>;
beforeEach(() => {
  store = installMockStorage();
});

describe('loadProviderState / saveProviderState', () => {
  it('空存储 → 默认态', () => {
    expect(loadProviderState()).toEqual({ providers: [], activeProviderId: null });
  });

  it('save → load 往返一致（明文存于 novalab.providers 键）', () => {
    const cfg = makeConfig();
    saveProviderState({ providers: [cfg], activeProviderId: 'p1' });
    expect(store.has(PROVIDERS_STORAGE_KEY)).toBe(true);
    expect(loadProviderState()).toEqual({ providers: [cfg], activeProviderId: 'p1' });
  });

  it('损坏 JSON → 回退默认态，不抛', () => {
    store.set(PROVIDERS_STORAGE_KEY, '{oops');
    expect(loadProviderState()).toEqual({ providers: [], activeProviderId: null });
  });

  it('过滤非法条目；悬空 activeProviderId 归 null', () => {
    store.set(
      PROVIDERS_STORAGE_KEY,
      JSON.stringify({
        providers: [makeConfig(), { id: 'bad' }, null, makeConfig({ id: 'p2', kind: 'openai-compat' })],
        activeProviderId: 'ghost',
      }),
    );
    const s = loadProviderState();
    expect(s.providers.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(s.activeProviderId).toBeNull();
  });
});

describe('modelSuggestionsFor（tokenplan 预设）', () => {
  it('anthropic-compat + tokenplan baseURL → TOKENPLAN_MODELS', () => {
    expect(modelSuggestionsFor({ kind: 'anthropic-compat', baseURL: 'https://TokenPlan.example/v1' })).toEqual([
      ...TOKENPLAN_MODELS,
    ]);
  });

  it('openai-compat 或非 tokenplan URL → 空（自由输入）', () => {
    expect(modelSuggestionsFor({ kind: 'openai-compat', baseURL: 'https://tokenplan.example/v1' })).toEqual([]);
    expect(modelSuggestionsFor({ kind: 'anthropic-compat', baseURL: 'https://api.anthropic.com/v1' })).toEqual([]);
  });
});

describe('createLanguageModel', () => {
  it('anthropic-compat → @ai-sdk/anthropic 模型实例', () => {
    const m = createLanguageModel(makeConfig()) as unknown as { provider: string; modelId: string };
    expect(m.provider).toContain('anthropic');
    expect(m.modelId).toBe(TOKENPLAN_MODELS[0]);
  });

  it('openai-compat → 本地 LanguageModelV3 实现（deepseek/ollama 路径）', () => {
    const m = createLanguageModel(
      makeConfig({ id: 'p2', kind: 'openai-compat', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen3' }),
    ) as unknown as { specificationVersion: string; provider: string; modelId: string };
    expect(m.specificationVersion).toBe('v3');
    expect(m.provider).toBe('openai-compat');
    expect(m.modelId).toBe('qwen3');
  });
});
