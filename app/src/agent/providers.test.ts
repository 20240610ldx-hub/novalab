import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P4 provider rpc 适配器单测：mock bridge client（内存版 providers.* 语义，
 * 与 bridge/src/providers-store.ts 对齐）——
 * - loadProviderState/saveProviderState 的 wire 映射（hasKey 掩码、dev-env 过滤、全量同步）；
 * - initProviderState：旧 localStorage 明文一次性迁移（读 → rpc set → removeItem）+
 *   dev-env 播种 + bridge 不可达/旧 bridge（-32601）降级；
 * - 代理路由纯函数（proxyBaseURL / requestTargetFor）与保留行为（预设/构造/legacy 解析）。
 */

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock('../bridge/client', () => ({
  bridge: { rpc: rpcMock },
}));

import { PROVIDERS_STORAGE_KEY, TOKENPLAN_MODELS, type ProviderConfig } from './providers';

interface FakeEntry {
  id: string;
  kind: string;
  name: string;
  baseURL: string;
  model: string;
  apiKey?: string;
  maxOutputTokens?: number;
}

interface FakeBridge {
  entries: Map<string, FakeEntry>;
  getActive: () => string | null;
}

/** 内存版 providers.*（掩码/保留密文/未知 setActive 抛错等语义对齐 bridge 实现）。 */
function installFakeBridge(opts: { fail?: boolean; methodNotFound?: boolean } = {}): FakeBridge {
  const entries = new Map<string, FakeEntry>();
  let active: string | null = null;
  let idSeq = 0;
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
    if (opts.fail) throw new Error('bridge 未连接');
    if (opts.methodNotFound) throw new Error(`method not found: ${method}`);
    switch (method) {
      case 'providers.list':
        return {
          providers: [...entries.values()].map((e) => ({
            id: e.id,
            kind: e.kind,
            name: e.name,
            baseURL: e.baseURL,
            model: e.model,
            hasKey: e.apiKey !== undefined && e.apiKey !== '',
            ...(e.maxOutputTokens !== undefined ? { maxOutputTokens: e.maxOutputTokens } : {}),
          })),
          activeProviderId: active,
        };
      case 'providers.set': {
        const p = params ?? {};
        const id = typeof p['id'] === 'string' && p['id'] !== '' ? p['id'] : `gen-${++idSeq}`;
        const prev = entries.get(id);
        const incoming = p['apiKey'];
        const apiKey =
          typeof incoming === 'string' && incoming !== '' ? incoming : prev?.apiKey;
        const next: FakeEntry = {
          id,
          kind: String(p['kind']),
          name: String(p['name']),
          baseURL: String(p['baseURL']),
          model: String(p['model']),
          ...(apiKey !== undefined ? { apiKey } : {}),
          ...(typeof p['maxOutputTokens'] === 'number' ? { maxOutputTokens: p['maxOutputTokens'] } : {}),
        };
        entries.set(id, next);
        return { id, kind: next.kind, name: next.name, baseURL: next.baseURL, model: next.model, hasKey: next.apiKey !== undefined };
      }
      case 'providers.delete': {
        const id = String(params?.['id']);
        const deleted = entries.delete(id);
        if (active === id) active = null;
        return { deleted };
      }
      case 'providers.setActive': {
        const id = (params?.['id'] ?? null) as string | null;
        if (id !== null && !entries.has(id)) throw new Error(`unknown provider id: ${id}`);
        active = id;
        return { activeProviderId: active };
      }
      default:
        throw new Error(`method not found: ${method}`);
    }
  });
  return { entries, getActive: () => active };
}

let lsStore: Map<string, string>;
function installMockStorage(): Map<string, string> {
  const map = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  return map;
}

/** bridgeReady 是模块级状态：每个用例重取模块（vi.resetModules + 动态 import）。 */
/** 配置/存储（providers.ts）与模型构造（models.ts，F7 拆分以便懒加载）合并成一个视图。 */
async function freshProviders(): Promise<typeof import('./providers') & typeof import('./models')> {
  vi.resetModules();
  return { ...(await import('./providers')), ...(await import('./models')) };
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

beforeEach(() => {
  lsStore = installMockStorage();
  // 显式清空 dev env（真实 app/.env.local 会被 vitest 载入，避免测试受其影响）
  vi.stubEnv('VITE_NOVALAB_LLM_BASE_URL', '');
  vi.stubEnv('VITE_NOVALAB_LLM_API_KEY', '');
  vi.stubEnv('VITE_NOVALAB_LLM_MODEL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('rpc 适配器 · loadProviderState', () => {
  it('wire → 前端状态：hasKey 掩码、apiKey 恒空、dev-env 过滤、active 透传', async () => {
    const fake = installFakeBridge();
    fake.entries.set('p1', { id: 'p1', kind: 'anthropic-compat', name: 'tokenplan', baseURL: 'https://t/v1', model: 'm1', apiKey: 'sk-stored' });
    fake.entries.set('dev-env', { id: 'dev-env', kind: 'anthropic-compat', name: 'dev', baseURL: 'https://d/v1', model: 'm', apiKey: 'sk-dev' });
    const mod = await freshProviders();
    const state = await mod.loadProviderState();
    expect(state.providers).toEqual([
      { id: 'p1', kind: 'anthropic-compat', name: 'tokenplan', baseURL: 'https://t/v1', model: 'm1', apiKey: '', hasKey: true },
    ]);
    expect(JSON.stringify(state)).not.toContain('sk-stored'); // key 永不回前端
    // dev-env 不在 active 候选里（被过滤）→ 悬空归 null
    expect(state.activeProviderId).toBeNull();
  });

  it('垃圾 wire → 默认空态（宽容降级，不抛）', async () => {
    installFakeBridge();
    rpcMock.mockResolvedValue('garbage');
    const mod = await freshProviders();
    expect(await mod.loadProviderState()).toEqual({ providers: [], activeProviderId: null });
  });
});

describe('rpc 适配器 · saveProviderState（全量同步）', () => {
  it('upsert 本地列表 + 删除 bridge 多余条目（dev-env 恒保留）+ setActive', async () => {
    const fake = installFakeBridge();
    fake.entries.set('old1', { id: 'old1', kind: 'openai-compat', name: 'old', baseURL: 'https://o/v1', model: 'm' });
    fake.entries.set('dev-env', { id: 'dev-env', kind: 'anthropic-compat', name: 'dev', baseURL: 'https://d/v1', model: 'm', apiKey: 'sk-dev' });
    const mod = await freshProviders();
    await mod.saveProviderState({
      providers: [makeConfig({ apiKey: 'sk-new' }), makeConfig({ id: 'p2', kind: 'openai-compat', apiKey: '' })],
      activeProviderId: 'p1',
    });
    expect([...fake.entries.keys()].sort()).toEqual(['dev-env', 'p1', 'p2']);
    expect(fake.entries.get('p1')!.apiKey).toBe('sk-new');
    expect(fake.getActive()).toBe('p1');
    expect(rpcMock).toHaveBeenCalledWith('providers.delete', { id: 'old1' });
  });

  it('apiKey 空的条目上行不带 apiKey 字段（= bridge 保留既有密文）', async () => {
    const fake = installFakeBridge();
    fake.entries.set('p1', { id: 'p1', kind: 'anthropic-compat', name: 'n', baseURL: 'https://t/v1', model: 'm', apiKey: 'sk-stored' });
    const mod = await freshProviders();
    await mod.saveProviderState({ providers: [makeConfig({ apiKey: '' })], activeProviderId: null });
    const setCall = rpcMock.mock.calls.find((c) => c[0] === 'providers.set');
    expect(setCall?.[1]).not.toHaveProperty('apiKey');
    expect(fake.entries.get('p1')!.apiKey).toBe('sk-stored');
  });

  it('maxOutputTokens：上行透传；未设置时显式发 null（= bridge 清除旧值）；list 回灌', async () => {
    const fake = installFakeBridge();
    const mod = await freshProviders();
    await mod.saveProviderState({
      providers: [makeConfig({ maxOutputTokens: 32000 }), makeConfig({ id: 'p2' })],
      activeProviderId: null,
    });
    const sets = rpcMock.mock.calls.filter((c) => c[0] === 'providers.set').map((c) => c[1] as Record<string, unknown>);
    expect(sets.map((s) => s['maxOutputTokens'])).toEqual([32000, null]);
    expect(fake.entries.get('p1')!.maxOutputTokens).toBe(32000);
    const state = await mod.loadProviderState();
    expect(state.providers.find((p) => p.id === 'p1')!.maxOutputTokens).toBe(32000);
    expect(state.providers.find((p) => p.id === 'p2')).not.toHaveProperty('maxOutputTokens');
  });
});

describe('输出预算输入（设置面板）', () => {
  it('parseMaxOutputTokensInput：空 = 自动；范围内整数；非法 → error', async () => {
    const mod = await freshProviders();
    expect(mod.parseMaxOutputTokensInput('')).toEqual({ ok: true, value: undefined });
    expect(mod.parseMaxOutputTokensInput('  16384 ')).toEqual({ ok: true, value: 16384 });
    expect(mod.parseMaxOutputTokensInput('16,384')).toEqual({ ok: true, value: 16384 });
    for (const bad of ['abc', '1.5', '100', '999999', '-1']) {
      expect(mod.parseMaxOutputTokensInput(bad).ok).toBe(false);
    }
  });
});

describe('代理路由（P4 L-1 终态）', () => {
  it('proxyBaseURL = http://127.0.0.1:7789/llm/<id>/v1（id 转义）', async () => {
    const mod = await freshProviders();
    expect(mod.proxyBaseURL('p1')).toBe('http://127.0.0.1:7789/llm/p1/v1');
    expect(mod.proxyBaseURL('a b/c')).toBe('http://127.0.0.1:7789/llm/a%20b%2Fc/v1');
  });

  it('requestTargetFor：remote → 代理 + proxy 占位；本地回退 → 直连草稿凭据', async () => {
    const mod = await freshProviders();
    const cfg = makeConfig();
    expect(mod.requestTargetFor(cfg, true)).toEqual({ baseURL: mod.proxyBaseURL('p1'), apiKey: 'proxy' });
    expect(mod.requestTargetFor(cfg, false)).toEqual({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  });

  it('isProviderStorageRemote：初始 false；initProviderState 成功后 true', async () => {
    installFakeBridge();
    const mod = await freshProviders();
    expect(mod.isProviderStorageRemote()).toBe(false);
    await mod.initProviderState();
    expect(mod.isProviderStorageRemote()).toBe(true);
  });
});

describe('initProviderState · 旧 localStorage 一次性迁移', () => {
  it('读 → rpc set（携明文 apiKey）→ setActive → removeItem；返回掩码态', async () => {
    const fake = installFakeBridge();
    lsStore.set(
      PROVIDERS_STORAGE_KEY,
      JSON.stringify({ providers: [makeConfig({ apiKey: 'sk-legacy' })], activeProviderId: 'p1' }),
    );
    const mod = await freshProviders();
    const state = await mod.initProviderState();

    expect(fake.entries.get('p1')?.apiKey).toBe('sk-legacy'); // 明文经 rpc 上行一次
    expect(fake.getActive()).toBe('p1');
    expect(lsStore.has(PROVIDERS_STORAGE_KEY)).toBe(false); // 迁移后即清除
    expect(state).toEqual({
      providers: [{ id: 'p1', kind: 'anthropic-compat', name: 'tokenplan', baseURL: 'https://tokenplan.local/v1', model: TOKENPLAN_MODELS[0], apiKey: '', hasKey: true }],
      activeProviderId: 'p1',
    });
  });

  it('migrateLegacyProviders：无旧键 → 0 次 set；有旧键 → 返回条数', async () => {
    installFakeBridge();
    const mod = await freshProviders();
    expect(await mod.migrateLegacyProviders()).toBe(0);
    lsStore.set(PROVIDERS_STORAGE_KEY, JSON.stringify({ providers: [makeConfig(), makeConfig({ id: 'p2', kind: 'openai-compat' })], activeProviderId: null }));
    expect(await mod.migrateLegacyProviders()).toBe(2);
    expect(lsStore.has(PROVIDERS_STORAGE_KEY)).toBe(false);
  });

  it('bridge 不可达 → 返回 legacy 内存态、不清 localStorage、存储不置 remote', async () => {
    installFakeBridge({ fail: true });
    lsStore.set(PROVIDERS_STORAGE_KEY, JSON.stringify({ providers: [makeConfig()], activeProviderId: 'p1' }));
    const mod = await freshProviders();
    const state = await mod.initProviderState();
    expect(state.providers).toEqual([makeConfig()]); // 原样（含明文 key，仅内存）
    expect(lsStore.has(PROVIDERS_STORAGE_KEY)).toBe(true);
    expect(mod.isProviderStorageRemote()).toBe(false);
  });

  it('旧 bridge（providers.* = -32601 method not found）→ 同样降级不清除', async () => {
    installFakeBridge({ methodNotFound: true });
    lsStore.set(PROVIDERS_STORAGE_KEY, JSON.stringify({ providers: [makeConfig()], activeProviderId: null }));
    const mod = await freshProviders();
    const state = await mod.initProviderState();
    expect(state.providers).toHaveLength(1);
    expect(lsStore.has(PROVIDERS_STORAGE_KEY)).toBe(true);
    expect(mod.isProviderStorageRemote()).toBe(false);
  });
});

describe('initProviderState · dev-env 播种（.env.local → 加密存储）', () => {
  it('hasDevEnvModel 时播种 id=dev-env（携 env key）；回灌列表过滤 dev-env', async () => {
    vi.stubEnv('VITE_NOVALAB_LLM_BASE_URL', 'https://dev.tokenplan.local/v1');
    vi.stubEnv('VITE_NOVALAB_LLM_API_KEY', 'sk-dev-env');
    vi.stubEnv('VITE_NOVALAB_LLM_MODEL', 'qwen3.8-flash');
    const fake = installFakeBridge();
    const mod = await freshProviders();
    expect(mod.hasDevEnvModel()).toBe(true);
    const state = await mod.initProviderState();
    const seeded = fake.entries.get('dev-env');
    expect(seeded).toEqual({
      id: 'dev-env',
      kind: 'anthropic-compat',
      name: 'dev 兜底（.env.local）',
      baseURL: 'https://dev.tokenplan.local/v1',
      model: 'qwen3.8-flash',
      apiKey: 'sk-dev-env',
    });
    expect(state.providers).toEqual([]); // dev-env 不进用户列表
    const model = mod.getDevLanguageModel() as unknown as { provider: string; modelId: string };
    expect(model.provider).toContain('anthropic');
    expect(model.modelId).toBe('qwen3.8-flash');
  });

  it('无 dev env → 不播种', async () => {
    const fake = installFakeBridge();
    const mod = await freshProviders();
    expect(mod.hasDevEnvModel()).toBe(false);
    await mod.initProviderState();
    expect(fake.entries.has('dev-env')).toBe(false);
    expect(mod.getDevLanguageModel()).toBeNull();
  });
});

describe('保留行为（P2.1 契约不变）', () => {
  it('STORAGE_WARNING 改为加密存储陈述（含 spec 指定短语，旧明文警告措辞移除）', async () => {
    const mod = await freshProviders();
    expect(mod.STORAGE_WARNING).toContain('keys encrypted at rest in .novalab/providers.json (0600)');
    expect(mod.STORAGE_WARNING).not.toContain('明文仅存');
    expect(mod.STORAGE_WARNING).not.toContain('localStorage');
  });

  it('modelSuggestionsFor：tokenplan 预设 / 其余自由输入', async () => {
    const mod = await freshProviders();
    expect(mod.modelSuggestionsFor({ kind: 'anthropic-compat', baseURL: 'https://TokenPlan.example/v1' })).toEqual([...TOKENPLAN_MODELS]);
    expect(mod.modelSuggestionsFor({ kind: 'openai-compat', baseURL: 'https://tokenplan.example/v1' })).toEqual([]);
    expect(mod.modelSuggestionsFor({ kind: 'anthropic-compat', baseURL: 'https://api.anthropic.com/v1' })).toEqual([]);
  });

  it('createLanguageModel：anthropic-compat / openai-compat 实例形状', async () => {
    const mod = await freshProviders();
    const m = mod.createLanguageModel(makeConfig()) as unknown as { provider: string; modelId: string };
    expect(m.provider).toContain('anthropic');
    expect(m.modelId).toBe(TOKENPLAN_MODELS[0]);
    const o = mod.createLanguageModel(
      makeConfig({ id: 'p2', kind: 'openai-compat', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen3' }),
    ) as unknown as { specificationVersion: string; provider: string; modelId: string };
    // F7：外层是 defaultSettingsMiddleware 包装（v4），provider / modelId 透传
    expect(o.specificationVersion).toBe('v4');
    expect(o.provider).toBe('openai-compat');
    expect(o.modelId).toBe('qwen3');
  });

  it('createLanguageModel 的请求走重试 fetch：一次网络错误后自动重放并成功', async () => {
    const payload = { id: 'c', model: 'qwen3', choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed: ECONNRESET'))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mod = await freshProviders();
      const model = mod.createLanguageModel(
        makeConfig({ id: 'p2', kind: 'openai-compat', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen3' }),
      ) as unknown as { doGenerate: (o: unknown) => Promise<{ content: Array<{ text?: string }> }> };
      const res = await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] });
      expect(res.content[0]?.text).toBe('pong');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0]);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it('F7：未知模型显式带输出预算（anthropic-compat 不再回落 4096、openai-compat 不再交给服务端默认）；已知 Claude 模型沿用 SDK 上限', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('{}', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prompt = [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }];
    const call = async (config: ProviderConfig) => {
      const mod = await freshProviders();
      const model = mod.createLanguageModel(config) as unknown as { doGenerate: (o: unknown) => Promise<unknown> };
      // 500 → 重试层重放；这里只看首个请求体，用 abort 截断重试等待
      const ac = new AbortController();
      const p = model.doGenerate({ prompt, abortSignal: ac.signal }).catch(() => undefined);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      ac.abort();
      await p;
      fetchMock.mockClear();
      return bodies.at(-1)!;
    };
    try {
      const mod = await freshProviders();
      expect((await call(makeConfig())).max_tokens).toBe(mod.UNKNOWN_MODEL_MAX_OUTPUT_TOKENS);
      expect(
        (await call(makeConfig({ id: 'p2', kind: 'openai-compat', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen3' }))).max_tokens,
      ).toBe(mod.UNKNOWN_MODEL_MAX_OUTPUT_TOKENS);
      const claude = await call(makeConfig({ model: 'claude-sonnet-4-5' }));
      expect(claude.max_tokens).toBeGreaterThan(mod.UNKNOWN_MODEL_MAX_OUTPUT_TOKENS);
      // 设置里的覆盖值优先于自动默认（Claude / 未知模型都一样）
      expect((await call(makeConfig({ maxOutputTokens: 32000 }))).max_tokens).toBe(32000);
      expect((await call(makeConfig({ model: 'claude-sonnet-4-5', maxOutputTokens: 2048 }))).max_tokens).toBe(2048);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it('streamText 不叠加 SDK 自带重试（统一由 fetch 层处理）', async () => {
    const { AGENT_SDK_MAX_RETRIES } = await import('./useAgentChat');
    expect(AGENT_SDK_MAX_RETRIES).toBe(0);
  });

  it('resolveActiveModel：用户选中优先 → dev 兜底 → 未配置（形状不变）', async () => {
    vi.stubEnv('VITE_NOVALAB_LLM_BASE_URL', 'https://dev.local/v1');
    vi.stubEnv('VITE_NOVALAB_LLM_API_KEY', 'sk-dev');
    const mod = await freshProviders();
    const user = mod.resolveActiveModel({ providers: [makeConfig()], activeProviderId: 'p1' });
    expect(user.source).toBe('user');
    expect(user.label).toBe(`tokenplan · ${TOKENPLAN_MODELS[0]}`);
    expect(user.model).not.toBeNull();
    const dev = mod.resolveActiveModel({ providers: [], activeProviderId: null });
    expect(dev.source).toBe('dev-env');
    expect(dev.model).not.toBeNull();
    vi.stubEnv('VITE_NOVALAB_LLM_API_KEY', '');
    const none = mod.resolveActiveModel({ providers: [], activeProviderId: null });
    expect(none).toEqual({ model: null, source: null, label: '未配置' });
  });

  it('loadLegacyProviderState：损坏 JSON → 默认态；过滤非法条目；悬空 active 归 null', async () => {
    const mod = await freshProviders();
    lsStore.set(PROVIDERS_STORAGE_KEY, '{oops');
    expect(mod.loadLegacyProviderState()).toEqual({ providers: [], activeProviderId: null });
    lsStore.set(
      PROVIDERS_STORAGE_KEY,
      JSON.stringify({
        providers: [makeConfig(), { id: 'bad' }, null, makeConfig({ id: 'p2', kind: 'openai-compat' })],
        activeProviderId: 'ghost',
      }),
    );
    const s = mod.loadLegacyProviderState();
    expect(s.providers.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(s.activeProviderId).toBeNull();
  });
});
