import { create } from 'zustand';
import { useNotebook } from './notebook';
import {
  initProviderState,
  loadLegacyProviderState,
  saveProviderState,
  type ProviderConfig,
} from '../agent/providers';
import type { AssembledPayload } from '../agent/payload';
import type { TracebackFrame } from '../kernel/types';

/**
 * Agent 侧全局状态（P2.1/P2.5；P4 凭据存储迁移）。
 * 与 notebook store（H 线所有）的关系：只读订阅（watchNotebookErrors + bridgeConnected
 * 水合触发），绝不写入。
 * provider 配置持久化（P4/ADR-008）：rpc providers.* → bridge 加密落盘
 * .novalab/providers.json（0600，apiKey 永不出桥，见 providers.STORAGE_WARNING）。
 * 启动快照 = 旧 localStorage 同步读（水合前展示）；bridgeConnected → initProviderState()
 * （一次性迁移旧明文 + 播种 dev-env + 全量回灌）。bridge 不可达 → 内存态降级不抛。
 */

export interface LastRunError {
  cellId: string;
  tracebackText: string;
  frames: TracebackFrame[];
  at: number;
}

interface AgentStore {
  settingsOpen: boolean;
  providers: ProviderConfig[];
  /** null = 走 dev .env.local 兜底。 */
  activeProviderId: string | null;
  /** ContextChip 审计：最近一次请求实际发送的 payload（逐 section + 体积）。 */
  lastPayload: AssembledPayload | null;
  /** FixCard 数据源：最近一次 run.error（notebook store 只读订阅转存）。 */
  lastError: LastRunError | null;

  setSettingsOpen: (open: boolean) => void;
  upsertProvider: (config: ProviderConfig) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  setActiveProvider: (id: string | null) => Promise<void>;
  setLastPayload: (payload: AssembledPayload | null) => void;
  setLastError: (err: LastRunError | null) => void;
}

/**
 * 全量同步到 bridge 加密存储（upsert + 删多余 + setActive）。
 * bridge 不可达：捕获降级——内存态仍然生效（与 P4 前 localStorage 静默失败同纪律）。
 */
async function persist(next: Pick<AgentStore, 'providers' | 'activeProviderId'>): Promise<void> {
  try {
    await saveProviderState({ providers: next.providers, activeProviderId: next.activeProviderId });
  } catch (err) {
    console.error('provider 持久化失败（bridge 不可达？改动仅内存态）:', err);
  }
}

// 水合前展示快照：旧 localStorage 明文（迁移过的浏览器为空态；bridge 回灌后替换）
const initial = loadLegacyProviderState();

export const useAgentStore = create<AgentStore>((set, get) => ({
  settingsOpen: false,
  providers: initial.providers,
  activeProviderId: initial.activeProviderId,
  lastPayload: null,
  lastError: null,

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  upsertProvider: async (config) => {
    const providers = get().providers;
    const exists = providers.some((p) => p.id === config.id);
    const next = exists ? providers.map((p) => (p.id === config.id ? config : p)) : [...providers, config];
    set({ providers: next });
    await persist({ providers: next, activeProviderId: get().activeProviderId });
  },

  removeProvider: async (id) => {
    const next = get().providers.filter((p) => p.id !== id);
    const activeProviderId = get().activeProviderId === id ? null : get().activeProviderId;
    set({ providers: next, activeProviderId });
    await persist({ providers: next, activeProviderId });
  },

  setActiveProvider: async (id) => {
    set({ activeProviderId: id });
    await persist({ providers: get().providers, activeProviderId: id });
  },

  setLastPayload: (payload) => set({ lastPayload: payload }),
  setLastError: (err) => set({ lastError: err }),
}));

/* ---------------- P4：bridge 连接后一次性水合（迁移 + dev-env 播种 + 回灌） ---------------- */

let providerHydrationStarted = false;

function hydrateProvidersOnce(): void {
  if (providerHydrationStarted) return;
  providerHydrationStarted = true;
  void initProviderState()
    .then((state) => {
      useAgentStore.setState({
        providers: state.providers,
        activeProviderId: state.activeProviderId,
      });
    })
    .catch((err) => {
      console.error('provider 水合失败（保持内存态）:', err);
    });
}

// notebook store 只读订阅：bridgeConnected 翻真 → 水合一次（页面生命周期内幂等）
useNotebook.subscribe((s) => {
  if (s.bridgeConnected) hydrateProvidersOnce();
});
if (useNotebook.getState().bridgeConnected) hydrateProvidersOnce();

/* ---------------- run.error 只读订阅 ---------------- */

/**
 * 订阅 notebook store（只读，不改 H 线代码）：cell 进入 error 且 traceback 变化时
 * 记录为 lastError（FixCard 数据源）。返回退订函数；AgentPanel 挂载时调用一次。
 * 签名去重：同一 cell 同一 traceback 文本不重复弹卡（重跑同错会刷新 at）。
 */
export function watchNotebookErrors(): () => void {
  const seen = new Map<string, string>(); // cellId → traceback text
  return useNotebook.subscribe((s) => {
    const agent = useAgentStore.getState();
    for (const cell of s.cells) {
      const tb = cell.status === 'error' ? cell.output?.traceback : null;
      if (!tb) {
        seen.delete(cell.id);
        continue;
      }
      if (seen.get(cell.id) === tb.text) continue;
      seen.set(cell.id, tb.text);
      agent.setLastError({
        cellId: cell.id,
        tracebackText: tb.text,
        frames: tb.frames,
        at: Date.now(),
      });
    }
  });
}
