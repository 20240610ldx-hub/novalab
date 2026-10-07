import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import { bridge } from '../bridge/client';
import { createOpenAICompat } from './openaiCompat';

/**
 * M6 模型解耦：provider 注册表（P2.1；P4 迁移加密存储 + LLM 代理，ADR-008 落地）。
 *
 * 层级：
 *  1. 用户配置（SettingsPanel 增删改）→ rpc providers.* → bridge 加密落盘
 *     `.novalab/providers.json`（0600，AES-256-GCM，bridge/src/secret.ts）。
 *     **apiKey 永不出桥**：list 只回 hasKey:boolean 掩码；前端配置对象里的
 *     apiKey 仅作 providers.set 的明文入口（编辑时留空 = 保留既有 key）。
 *  2. dev 兜底：.env.local（gitignored）的 VITE_NOVALAB_LLM_*（ADR-008 凭据纪律：
 *     永不自动读取凭据存储，Owner 手动填写）。bridge 连接后一次性播种为加密存储里
 *     id='dev-env' 的 provider（seedDevEnvProvider），请求同样走代理。
 *
 * LLM 请求路径（L-1 终态）：SDK baseURL 统一指向 bridge LLM 代理
 * `http://127.0.0.1:7789/llm/<id>/v1`（apiKey 传 'proxy' 占位，真 key 由代理
 * 按 kind 注入上游请求头，SSE 流式透传，见 bridge/src/llm-proxy.ts）。
 * bridge 未连接时自动回退 P4 前行为（用户 provider 直连 baseURL；dev 兜底走
 * vite 同源代理 /llm/v1，vite.config.ts 保留该兜底）。
 *
 * 生命周期（store/agent.ts 编排）：模块加载 = loadLegacyProviderState() 同步快照
 * 供 UI 先行展示；bridgeConnected → initProviderState()（探测 providers.* →
 * 一次性迁移旧 localStorage 明文 → 播种 dev-env → 全量回灌 store）。
 */

export type ProviderId = 'anthropic-compat' | 'openai-compat';

export interface ProviderConfig {
  /** 用户配置唯一 id（crypto.randomUUID 或时间戳；bridge set 时可省略由 bridge 生成）。 */
  id: string;
  kind: ProviderId;
  /** 显示名（如 "tokenplan"、"deepseek"、"ollama-local"）。 */
  name: string;
  baseURL: string;
  /**
   * 明文入口（仅 providers.set 上行）：bridge 加载回来的配置恒为 ''，
   * 编辑时留空 = 保留 bridge 侧既有密文。
   */
  apiKey: string;
  model: string;
  /** bridge 掩码：加密存储里已有 key（P4；apiKey 本体永不回前端）。 */
  hasKey?: boolean;
}

export interface ProviderState {
  providers: ProviderConfig[];
  /** null = 无用户选择 → 走 dev .env.local 兜底。 */
  activeProviderId: string | null;
}

/** 旧版明文 localStorage 键（一次性迁移：读 → rpc set → removeItem）。 */
export const PROVIDERS_STORAGE_KEY = 'novalab.providers';

/** bridge LLM 代理（llm-proxy.ts；端口占用 bridge 侧 +1，前端约定默认口）。 */
export const LLM_PROXY_ORIGIN = 'http://127.0.0.1:7789';

/** dev .env.local 兜底在加密存储里的固定 id（前端启动时播种；list 回灌时过滤）。 */
export const DEV_ENV_PROVIDER_ID = 'dev-env';

/** 代理路径上 SDK 的 apiKey 占位（真 key 由代理注入，浏览器不接触）。 */
const PROXY_KEY_PLACEHOLDER = 'proxy';

/** SettingsPanel 必须原文展示的存储说明（P4：明文警告 → 加密存储陈述）。 */
export const STORAGE_WARNING =
  '🔒 API Key 经本机 bridge（ws://127.0.0.1:7788）以 AES-256-GCM 加密落盘 —— keys encrypted at rest in .novalab/providers.json (0600)，永不回传前端（列表仅暴露 hasKey 掩码）；LLM 请求统一经 bridge 代理 http://127.0.0.1:7789/llm/<id>/v1，浏览器进程不持有明文 key。威胁模型：防 casual 披露（误共享/截图/备份泄露），不防同机决意攻击者（机器派生密钥可复算，见 bridge/src/secret.ts 注释）。';

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

/* ---------------- bridge rpc 适配（wire 形状 = bridge/src/protocol.ts providers.*） ---------------- */

interface ProviderSummaryWire {
  id: string;
  kind: ProviderId;
  name: string;
  baseURL: string;
  model: string;
  hasKey: boolean;
}

interface ProvidersListWire {
  providers: ProviderSummaryWire[];
  activeProviderId: string | null;
}

/** bridge 加密存储就绪（initProviderState 探测成功）→ 请求走代理；否则回退直连。 */
let bridgeReady = false;

/** SettingsPanel 用：当前 provider 存储/请求是否走 bridge（否则为无桥回退态）。 */
export function isProviderStorageRemote(): boolean {
  return bridgeReady;
}

/** 前端 SDK 的统一 baseURL：`http://127.0.0.1:7789/llm/<id>/v1`。 */
export function proxyBaseURL(providerId: string): string {
  return `${LLM_PROXY_ORIGIN}/llm/${encodeURIComponent(providerId)}/v1`;
}

/**
 * SDK 连接参数：bridge 就绪 → 代理 baseURL + 'proxy' 占位 key（真 key 代理侧注入）；
 * 未就绪（bridge 未连 / 旧 bridge 无 providers.*）→ 回退 P4 前直连（CORS 风险见头注）。
 */
export function requestTargetFor(
  config: Pick<ProviderConfig, 'id' | 'baseURL' | 'apiKey'>,
  remote: boolean,
): { baseURL: string; apiKey: string } {
  return remote
    ? { baseURL: proxyBaseURL(config.id), apiKey: PROXY_KEY_PLACEHOLDER }
    : { baseURL: config.baseURL, apiKey: config.apiKey };
}

export function createLanguageModel(config: ProviderConfig): LanguageModel {
  const { baseURL, apiKey } = requestTargetFor(config, bridgeReady);
  switch (config.kind) {
    case 'anthropic-compat':
      return createAnthropic({ baseURL, apiKey })(config.model);
    case 'openai-compat':
      // deepseek / ollama / vLLM 等走 OpenAI 兼容协议（本地最小 provider，见 openaiCompat.ts）
      return createOpenAICompat({ baseURL, apiKey })(config.model);
  }
}

function isProviderSummaryWire(v: unknown): v is ProviderSummaryWire {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    (r.kind === 'anthropic-compat' || r.kind === 'openai-compat') &&
    typeof r.name === 'string' &&
    typeof r.baseURL === 'string' &&
    typeof r.model === 'string' &&
    typeof r.hasKey === 'boolean'
  );
}

function summaryToConfig(s: ProviderSummaryWire): ProviderConfig {
  return { id: s.id, kind: s.kind, name: s.name, baseURL: s.baseURL, model: s.model, apiKey: '', hasKey: s.hasKey };
}

/** providers.list → 前端状态（过滤 dev-env：它在 UI 上由 hasDevEnvModel() 兜底行呈现）。 */
export async function loadProviderState(): Promise<ProviderState> {
  const res = await bridge.rpc<unknown>('providers.list');
  return normalizeListWire(res);
}

/** wire 宽容归一化：形状不对 → 默认空态（损坏降级纪律与 bridge 侧一致）。 */
export function normalizeListWire(res: unknown): ProviderState {
  if (!res || typeof res !== 'object') return { ...DEFAULT_PROVIDER_STATE };
  const wire = res as Partial<ProvidersListWire>;
  const providers = Array.isArray(wire.providers)
    ? wire.providers.filter(isProviderSummaryWire).filter((p) => p.id !== DEV_ENV_PROVIDER_ID).map(summaryToConfig)
    : [];
  const active = wire.activeProviderId;
  return {
    providers,
    activeProviderId: typeof active === 'string' && providers.some((p) => p.id === active) ? active : null,
  };
}

/**
 * 全量同步（store persist 通道）：upsert 本地列表（apiKey 空 = 保留 bridge 密文）
 * → 删除 bridge 上多余条目（**dev-env 恒保留**，它不在前端列表里）→ setActive。
 * bridge 不可达时抛错，由调用方（store/agent.ts）捕获降级为内存态。
 */
export async function saveProviderState(state: ProviderState): Promise<void> {
  const wire = await bridge.rpc<unknown>('providers.list');
  const remoteAll: unknown[] =
    wire && typeof wire === 'object' && Array.isArray((wire as ProvidersListWire).providers)
      ? (wire as ProvidersListWire).providers
      : [];
  for (const p of state.providers) {
    await bridge.rpc('providers.set', {
      id: p.id,
      kind: p.kind,
      name: p.name,
      baseURL: p.baseURL,
      model: p.model,
      ...(p.apiKey !== '' ? { apiKey: p.apiKey } : {}),
    });
  }
  for (const r of remoteAll) {
    if (!isProviderSummaryWire(r) || r.id === DEV_ENV_PROVIDER_ID) continue; // dev-env 恒保留
    if (!state.providers.some((p) => p.id === r.id)) {
      await bridge.rpc('providers.delete', { id: r.id });
    }
  }
  await bridge.rpc('providers.setActive', { id: state.activeProviderId });
}

/* ---------------- 旧 localStorage 明文：一次性迁移（读 → rpc set → removeItem） ---------------- */

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

/** 同步读旧版明文 localStorage（P4 前形状）：启动快照展示 + 迁移数据源。 */
export function loadLegacyProviderState(): ProviderState {
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

/** 迁移完成后清除旧明文键。 */
export function clearLegacyProviderStorage(): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(PROVIDERS_STORAGE_KEY);
  } catch {
    /* 隐私模式等：忽略 */
  }
}

/** 一次性迁移：旧明文逐条 providers.set（携带 apiKey）→ setActive → removeItem。返回迁移条数。 */
export async function migrateLegacyProviders(): Promise<number> {
  const s = storage();
  let hadLegacyKey = false;
  try {
    hadLegacyKey = s !== null && s.getItem(PROVIDERS_STORAGE_KEY) !== null;
  } catch {
    hadLegacyKey = false;
  }
  if (!hadLegacyKey) return 0;
  const legacy = loadLegacyProviderState();
  for (const p of legacy.providers) {
    await bridge.rpc('providers.set', {
      id: p.id,
      kind: p.kind,
      name: p.name,
      baseURL: p.baseURL,
      model: p.model,
      ...(p.apiKey !== '' ? { apiKey: p.apiKey } : {}),
    });
  }
  if (legacy.activeProviderId !== null) {
    await bridge.rpc('providers.setActive', { id: legacy.activeProviderId });
  }
  clearLegacyProviderStorage(); // 迁移成功才清除（中途抛错则保留，下次启动重试）
  return legacy.providers.length;
}

/* ---------------- dev 兜底（.env.local → 播种 dev-env provider） ---------------- */

/**
 * 启动时把 .env.local 凭据播种为加密存储里的 dev-env provider（每次启动 upsert
 * 一次，幂等；.env.local 改动随下次启动生效）。bridge 自己不读任何凭据文件
 * （ADR-008 纪律），值由前端从 import.meta.env 推送。
 */
export async function seedDevEnvProvider(): Promise<boolean> {
  if (!hasDevEnvModel()) return false;
  const baseURL = import.meta.env.VITE_NOVALAB_LLM_BASE_URL as string;
  const apiKey = import.meta.env.VITE_NOVALAB_LLM_API_KEY as string;
  const model =
    (import.meta.env.VITE_NOVALAB_LLM_MODEL as string | undefined) ?? TOKENPLAN_MODELS[0];
  await bridge.rpc('providers.set', {
    id: DEV_ENV_PROVIDER_ID,
    kind: 'anthropic-compat',
    name: 'dev 兜底（.env.local）',
    baseURL,
    model,
    apiKey,
  });
  return true;
}

/**
 * bridge 连接后的一次性初始化（store/agent.ts 在 bridgeConnected 时调用）：
 * 探测 providers.* → 迁移旧 localStorage → 播种 dev-env → 回灌全量状态。
 * bridge 未连 / 旧 bridge（-32601）→ 保持 P4 前行为：返回 legacy 内存态，
 * 不清 localStorage、不走代理（bridgeReady 维持 false）。
 */
export async function initProviderState(): Promise<ProviderState> {
  try {
    await bridge.rpc('providers.list');
  } catch {
    return loadLegacyProviderState(); // bridge 不可达 / 无 providers.*：回退直连态
  }
  bridgeReady = true;
  try {
    await migrateLegacyProviders();
    await seedDevEnvProvider();
    return await loadProviderState();
  } catch (err) {
    // 迁移/播种中途失败：保留 legacy 展示（localStorage 未被清除，下次启动重试）
    console.error('provider 初始化失败（保持内存态）:', err);
    return loadLegacyProviderState();
  }
}

export function getDevLanguageModel(): LanguageModel | null {
  const envBaseURL = import.meta.env.VITE_NOVALAB_LLM_BASE_URL as string | undefined;
  const apiKey = import.meta.env.VITE_NOVALAB_LLM_API_KEY as string | undefined;
  if (!envBaseURL || !apiKey) return null;
  const model =
    (import.meta.env.VITE_NOVALAB_LLM_MODEL as string | undefined) ?? TOKENPLAN_MODELS[0];
  if (bridgeReady) {
    // P4 主路径：dev-env 已播种进 bridge 加密存储 → 走 LLM 代理（key 不再驻留浏览器请求）
    return createAnthropic({
      baseURL: proxyBaseURL(DEV_ENV_PROVIDER_ID),
      apiKey: PROXY_KEY_PLACEHOLDER,
    })(model);
  }
  // 无 bridge 兜底（降级，原 L-1 主路径）：DEV（vite）走同源代理 /llm/v1 →
  // vite.config.ts server.proxy 转发 envBaseURL；生产直连（端点缺 CORS 头会失败）。
  const baseURL = import.meta.env.DEV ? '/llm/v1' : envBaseURL;
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
