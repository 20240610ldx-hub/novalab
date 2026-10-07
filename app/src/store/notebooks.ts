/**
 * 多 tab notebook 注册表（P3.1，intent S1 / A-2 #18）。
 *
 * 职责（「焦点视图」notebook.ts 的上层账本）：
 * - tabs：已打开 notebook 列表（bridge notebook.list 投影 + 前端本地 dirty 标记）；
 * - activeId：焦点 tab（notebookId）；
 * - caches：每 notebook 的 cells/DAG/输出等切片缓存——tab 切换时「捕获→恢复」，
 *   令切走再切回状态即在（内核进程在 bridge 侧保活，前端缓存负责即时恢复视图）；
 * - open/switch/close 的 RPC 包装 + 焦点/ended 状态同步。
 *
 * 依赖单向：本文件只 import bridge 客户端与 kernel/types（不 import notebook.ts /
 * session.ts，避免与它们的既有 import 形成环）。焦点捕获/恢复的编排放在 notebook.ts
 * （它 import 本 store），本 store 只提供数据与纯函数。
 */

import { create } from 'zustand';
import { bridge } from '../bridge/client';
import type { Cell, DagEdge, StagedDiff, VarSchema } from '../kernel/types';

/* ------------------------------------------------------------------ */
/* 类型（bridge 协议投影；字段名与 bridge/src/protocol.ts 一致）          */
/* ------------------------------------------------------------------ */

/** bridge 侧内核状态（notebook.list / kernel.status 的原始取值）。 */
export type BridgeKernelState = 'idle' | 'busy' | 'restarting' | 'dead';

/** notebook.list 条目 → 前端 tab（额外带本地 dirty 标记，close 确认用）。 */
export interface NotebookTab {
  notebookId: string;
  path: string;
  kernelState: BridgeKernelState;
  cellCount: number;
  /** 内核 dead / 会话结束 → view-only（TabBar 灰化 + 写路径护栏）。 */
  ended: boolean;
  /** 内核 RSS（MB）水位；不可采样为 null。 */
  rssMB: number | null;
  /** 前端本地：有未保存改动（编辑过 cell 但未落盘）。 */
  dirty: boolean;
}

/** 一个 notebook 的焦点视图切片缓存（切换时捕获/恢复）。 */
export interface NotebookCache {
  cells: Cell[];
  dagEdges: DagEdge[];
  staleSet: string[];
  schemas: VarSchema[];
  compileErrors: Record<string, string>;
  diffs: StagedDiff[];
  /** 与 notebook.ts DiffMarks 结构兼容（本地 origin/edited-staged 标记）。 */
  diffMarks: Record<string, { origin?: 'agent' | 'user'; state?: 'edited-staged' }>;
  activeCellId: string | null;
  uiCollapsed: Record<string, boolean>;
  lastRunMs: Record<string, number>;
}

/** notebook.open / notebook.switch 响应（bridge 冻结契约）。 */
export interface NotebookStateResult {
  notebookId: string;
  state: {
    cells?: Partial<Cell>[];
    dagEdges?: DagEdge[];
    schemas?: VarSchema[];
    staleSet?: string[];
    execCounts?: Record<string, number | null>;
  };
}

/* ------------------------------------------------------------------ */
/* 纯函数（导出供 vitest；无 DOM/网络依赖）                               */
/* ------------------------------------------------------------------ */

export function emptyCache(): NotebookCache {
  return {
    cells: [],
    dagEdges: [],
    staleSet: [],
    schemas: [],
    compileErrors: {},
    diffs: [],
    diffMarks: {},
    activeCellId: null,
    uiCollapsed: {},
    lastRunMs: {},
  };
}

/** tab 显示名 = 路径末段文件名。 */
export function tabLabel(p: string): string {
  const name = p.split(/[\\/]/).pop();
  return name && name.length > 0 ? name : p;
}

/**
 * close 确认 predicate：有未保存改动且非 view-only（ended tab 已是只读快照，
 * 无"未保存"可言）→ 关闭前需确认。纯函数，供 TabBar 与单测消费。
 */
export function hasUnsavedChanges(tab: Pick<NotebookTab, 'dirty' | 'ended'>): boolean {
  return tab.dirty && !tab.ended;
}

/**
 * notebook.list 载荷宽容归一化 → tabs。preserveDirty：沿用同 id 旧 tab 的本地 dirty
 * （dirty 是前端态，bridge 不上报）。坏条目丢弃。
 */
export function normalizeTabs(payload: unknown, prev: readonly NotebookTab[]): NotebookTab[] {
  if (!Array.isArray(payload)) return [];
  const dirtyById = new Map(prev.map((t) => [t.notebookId, t.dirty]));
  const out: NotebookTab[] = [];
  for (const e of payload) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (typeof r.notebookId !== 'string' || typeof r.path !== 'string') continue;
    const ks = r.kernelState;
    const kernelState: BridgeKernelState =
      ks === 'idle' || ks === 'busy' || ks === 'restarting' || ks === 'dead' ? ks : 'idle';
    out.push({
      notebookId: r.notebookId,
      path: r.path,
      kernelState,
      cellCount: typeof r.cellCount === 'number' ? r.cellCount : 0,
      ended: r.ended === true || kernelState === 'dead',
      rssMB: typeof r.rssMB === 'number' ? r.rssMB : null,
      dirty: dirtyById.get(r.notebookId) ?? false,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

interface NotebooksStore {
  tabs: NotebookTab[];
  activeId: string | null;
  caches: Record<string, NotebookCache>;

  /** notebook.list 拉取并归一化（保留本地 dirty）；activeId 失效时回退首个 tab。 */
  refreshList: () => Promise<void>;
  setTabs: (tabs: NotebookTab[]) => void;
  setActive: (id: string | null) => void;
  saveCache: (id: string, cache: NotebookCache) => void;
  readCache: (id: string) => NotebookCache | undefined;
  markDirty: (id: string, dirty: boolean) => void;
  /** 焦点 tab 的内核状态更新（kernel.status 通知驱动 TabBar 点色）。 */
  setKernelState: (id: string, state: BridgeKernelState) => void;
  activeTab: () => NotebookTab | undefined;

  /* RPC 包装（编排焦点捕获/恢复在 notebook.ts；这里只管账本 + 网络） */
  openRpc: (path: string) => Promise<NotebookStateResult>;
  switchRpc: (id: string) => Promise<NotebookStateResult | null>;
  closeRpc: (id: string) => Promise<{ closedId: string; nextActiveId: string | null }>;
}

export const useNotebooks = create<NotebooksStore>((set, get) => ({
  tabs: [],
  activeId: null,
  caches: {},

  refreshList: async () => {
    try {
      const res = await bridge.rpc<unknown>('notebook.list');
      const tabs = normalizeTabs(res, get().tabs);
      const ids = new Set(tabs.map((t) => t.notebookId));
      const activeId = get().activeId;
      set({
        tabs,
        // 焦点 tab 已被关闭（外部）→ 回退首个
        activeId: activeId && ids.has(activeId) ? activeId : (tabs[0]?.notebookId ?? null),
      });
    } catch (err) {
      console.error('notebook.list 失败:', err);
    }
  },

  setTabs: (tabs) => set({ tabs }),

  setActive: (id) => set({ activeId: id }),

  saveCache: (id, cache) => set({ caches: { ...get().caches, [id]: cache } }),

  readCache: (id) => get().caches[id],

  markDirty: (id, dirty) =>
    set({ tabs: get().tabs.map((t) => (t.notebookId === id ? { ...t, dirty } : t)) }),

  setKernelState: (id, state) =>
    set({
      tabs: get().tabs.map((t) =>
        t.notebookId === id
          ? { ...t, kernelState: state, ended: state === 'dead' ? true : t.ended }
          : t,
      ),
    }),

  activeTab: () => {
    const id = get().activeId;
    return id ? get().tabs.find((t) => t.notebookId === id) : undefined;
  },

  openRpc: async (path) => {
    const res = await bridge.rpc<NotebookStateResult>('notebook.open', { path });
    // 打开后同步 tab 列表（含新 notebookId），并置为焦点
    await get().refreshList();
    if (res && typeof res.notebookId === 'string') set({ activeId: res.notebookId });
    return res;
  },

  switchRpc: async (id) => {
    try {
      const res = await bridge.rpc<NotebookStateResult>('notebook.switch', { notebookId: id });
      set({ activeId: id });
      return res;
    } catch (err) {
      console.error('notebook.switch 失败:', err);
      set({ activeId: id }); // 本地仍切焦点（缓存恢复视图），bridge 焦点下次操作再校准
      return null;
    }
  },

  closeRpc: async (id) => {
    try {
      await bridge.rpc('notebook.close', { notebookId: id });
    } catch (err) {
      console.error('notebook.close 失败:', err);
    }
    // 摘除该 tab 的缓存；焦点转移由 bridge 决定，拉 list 校准（activeId 失效则回退首个）
    const caches = { ...get().caches };
    delete caches[id];
    set({ caches });
    await get().refreshList();
    return { closedId: id, nextActiveId: get().activeId };
  },
}));
