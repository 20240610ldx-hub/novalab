import { create } from 'zustand';
import { useNotebook } from './notebook';
import {
  loadProviderState,
  saveProviderState,
  type ProviderConfig,
} from '../agent/providers';
import type { AssembledPayload } from '../agent/payload';
import type { TracebackFrame } from '../kernel/types';

/**
 * Agent 侧全局状态（P2.1/P2.5）。
 * 与 notebook store（H 线所有）的关系：只读订阅（watchNotebookErrors），绝不写入。
 * provider 配置持久化到 localStorage（明文，见 providers.STORAGE_WARNING）。
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
  upsertProvider: (config: ProviderConfig) => void;
  removeProvider: (id: string) => void;
  setActiveProvider: (id: string | null) => void;
  setLastPayload: (payload: AssembledPayload | null) => void;
  setLastError: (err: LastRunError | null) => void;
}

function persist(next: Pick<AgentStore, 'providers' | 'activeProviderId'>): void {
  saveProviderState({ providers: next.providers, activeProviderId: next.activeProviderId });
}

const initial = loadProviderState();

export const useAgentStore = create<AgentStore>((set, get) => ({
  settingsOpen: false,
  providers: initial.providers,
  activeProviderId: initial.activeProviderId,
  lastPayload: null,
  lastError: null,

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  upsertProvider: (config) => {
    const providers = get().providers;
    const exists = providers.some((p) => p.id === config.id);
    const next = exists ? providers.map((p) => (p.id === config.id ? config : p)) : [...providers, config];
    set({ providers: next });
    persist({ providers: next, activeProviderId: get().activeProviderId });
  },

  removeProvider: (id) => {
    const next = get().providers.filter((p) => p.id !== id);
    const activeProviderId = get().activeProviderId === id ? null : get().activeProviderId;
    set({ providers: next, activeProviderId });
    persist({ providers: next, activeProviderId });
  },

  setActiveProvider: (id) => {
    set({ activeProviderId: id });
    persist({ providers: get().providers, activeProviderId: id });
  },

  setLastPayload: (payload) => set({ lastPayload: payload }),
  setLastError: (err) => set({ lastError: err }),
}));

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
