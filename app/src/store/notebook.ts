import { create } from 'zustand';
import { bridge } from '../bridge/client';
import {
  createEmptyOutput,
  type Cell,
  type CellOutput,
  type CellSaveResult,
  type DagEdge,
  type KernelState,
  type KernelStatusPayload,
  type MimeBundle,
  type NotebookStatePayload,
  type ReplResult,
  type StagedDiff,
  type TracebackFrame,
  type VarSchema,
} from '../kernel/types';

/* ------------------------------------------------------------------ */
/* 纯 reducer（导出供 vitest 单测；不依赖 store/网络，见 notebook.test.ts） */
/* ------------------------------------------------------------------ */

/** 把 notebook.state 载荷归一化为完整 Cell（bridge 可能缺省 kind/output/execCount）。 */
export function normalizeCells(
  cells: readonly Partial<Cell>[],
  execCounts?: Record<string, number | null>,
): Cell[] {
  return cells.map((c, i) => ({
    id: c.id ?? `cell-${i}`,
    code: c.code ?? '',
    execCount: c.execCount ?? execCounts?.[c.id ?? ''] ?? null,
    status: 'idle',
    defs: c.defs ?? [],
    refs: c.refs ?? [],
    sideEffect: c.sideEffect ?? false,
    kind: c.kind ?? 'code',
    output: c.output ?? null,
  }));
}

function patchCell(cells: readonly Cell[], id: string, fn: (c: Cell) => Cell): Cell[] {
  return cells.map((c) => (c.id === id ? fn(c) : c));
}

/**
 * 持久 [repl] cell upsert：不存在则追加到列表尾；已存在则重置为
 * status='running'、清空输出缓冲、更新为最新输入代码（保持列表位置不变）。
 */
export function upsertReplCell(cells: readonly Cell[], id: string, code: string): Cell[] {
  const existing = cells.find((c) => c.id === id);
  if (!existing) {
    return [
      ...cells,
      {
        id,
        code,
        execCount: null,
        status: 'running',
        defs: [],
        refs: [],
        sideEffect: false,
        kind: 'repl',
        output: createEmptyOutput(),
      },
    ];
  }
  return patchCell(cells, id, (c) => ({
    ...c,
    code,
    status: 'running',
    output: createEmptyOutput(),
  }));
}

function withOutput(c: Cell, fn: (o: CellOutput) => CellOutput): Cell {
  return { ...c, output: fn(c.output ?? createEmptyOutput()) };
}

function asRecord(p: unknown): Record<string, unknown> {
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').join('');
  return v == null ? '' : String(v);
}

/**
 * run.* 流式通知的 reducer（spec §6.1）：
 *   run.started {cellId}                       → status='running'，清空输出缓冲
 *   run.stdout  {cellId, text}                 → 追加 stdout
 *   run.stderr  {cellId, text}                 → 追加 stderr
 *   run.mime    {cellId, mime, data | bundle}  → 写入 MIME bundle
 *   run.done    {cellId, execCount, cascaded}  → status='idle'，更新执行计数
 *   run.error   {cellId, traceback, frames}    → status='error'，存结构化 traceback
 */
export function applyRunEvent(cells: readonly Cell[], method: string, params: unknown): Cell[] {
  const p = asRecord(params);
  const cellId = typeof p.cellId === 'string' ? p.cellId : '';
  if (!cellId) return cells as Cell[];

  switch (method) {
    case 'run.started':
      return patchCell(cells, cellId, (c) => ({
        ...c,
        status: 'running',
        output: createEmptyOutput(),
      }));

    case 'run.stdout':
      return patchCell(cells, cellId, (c) =>
        withOutput(c, (o) => ({ ...o, stdout: o.stdout + asText(p.text) })),
      );

    case 'run.stderr':
      return patchCell(cells, cellId, (c) =>
        withOutput(c, (o) => ({ ...o, stderr: o.stderr + asText(p.text) })),
      );

    case 'run.mime': {
      // 两种形态：单条 {mime, data} 或整包 {bundle: {...}}
      const bundle: MimeBundle = asRecord(p.bundle) as MimeBundle;
      if (typeof p.mime === 'string' && p.mime) {
        bundle[p.mime] = asText(p.data);
      }
      if (Object.keys(bundle).length === 0) return cells as Cell[];
      return patchCell(cells, cellId, (c) =>
        withOutput(c, (o) => ({ ...o, mime: { ...o.mime, ...bundle } })),
      );
    }

    case 'run.done':
      return patchCell(cells, cellId, (c) => ({
        ...c,
        status: c.status === 'error' ? 'error' : 'idle',
        execCount: typeof p.execCount === 'number' ? p.execCount : c.execCount,
      }));

    case 'run.error': {
      const frames = Array.isArray(p.frames)
        ? (p.frames as TracebackFrame[]).map((f) => ({
            file: String(f?.file ?? ''),
            line: Number(f?.line ?? 0),
            fn: String(f?.fn ?? ''),
            srcLine: f?.srcLine != null ? String(f.srcLine) : undefined,
          }))
        : [];
      return patchCell(cells, cellId, (c) => ({
        ...c,
        status: 'error',
        output: {
          ...(c.output ?? createEmptyOutput()),
          traceback: { text: asText(p.traceback), frames },
        },
      }));
    }

    default:
      return cells as Cell[];
  }
}

/**
 * stale 徽章派生：staleSet 内的 idle cell 标 'stale'；
 * 不在集合内、但还挂着 stale 状态的恢复 'idle'；running/error 不被覆盖。
 */
export function applyStaleSet(cells: readonly Cell[], staleSet: readonly string[]): Cell[] {
  const stale = new Set(staleSet);
  return cells.map((c) => {
    if (c.status === 'running' || c.status === 'error') return c;
    const should = stale.has(c.id);
    const is = c.status === 'stale';
    if (should === is) return c;
    return { ...c, status: should ? 'stale' : 'idle' };
  });
}

/** kernel.status 的 state → 前端 KernelState（idle 显示为 live）。 */
export function mapKernelState(state: KernelStatusPayload['state'] | string): KernelState {
  switch (state) {
    case 'idle':
      return 'live';
    case 'busy':
      return 'busy';
    case 'restarting':
      return 'restarting';
    case 'dead':
      return 'dead';
    default:
      return 'connecting';
  }
}

/**
 * diff.updated 通知载荷 {diffs:[...]} → 前端 StagedDiff[]。
 * bridge 冻结契约：每个 diff 的字段名是 `status`（proposed|accepted|rejected），
 * 映射到前端的 `state`；'edited-staged' 为纯前端态，bridge 不会产生。
 */
export function normalizeDiffs(payload: unknown): StagedDiff[] {
  const arr = asRecord(payload).diffs;
  if (!Array.isArray(arr)) return [];
  return arr.map((d) => {
    const r = asRecord(d);
    const raw = String(r.status ?? r.state ?? 'proposed');
    const state: StagedDiff['state'] =
      raw === 'accepted' || raw === 'rejected' || raw === 'edited-staged' ? raw : 'proposed';
    return {
      id: String(r.id ?? ''),
      targetCellId: String(r.targetCellId ?? ''),
      action: r.action === 'insert_below' ? 'insert_below' : 'update',
      newCode: String(r.newCode ?? ''),
      rationale: r.rationale != null ? String(r.rationale) : undefined,
      origin: r.origin === 'user' ? 'user' : 'agent',
      state,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

interface NotebookStore {
  cells: Cell[];
  dagEdges: DagEdge[];
  staleSet: string[];
  schemas: VarSchema[];
  kernelState: KernelState;
  diffs: StagedDiff[];
  activeCellId: string | null;
  /** 当前打开的 .py 路径（notebook.open 成功后）。 */
  notebookPath: string | null;
  /** bridge WS 是否已连接；false → App 显示降级横幅。 */
  bridgeConnected: boolean;
  /** cell.save 返回的编译错（cellId → message），P1.5 行内提示的数据源。 */
  compileErrors: Record<string, string>;
  /**
   * output 折叠状态（P1.8，sidecar `.novalab/ui.json` 水合）。
   * 独立于 cells 存放：热重载的全量 notebook.state 不会冲掉它。
   */
  uiCollapsed: Record<string, boolean>;

  setState: (patch: Partial<Omit<NotebookStore, 'setState' | 'setActive'>>) => void;
  setActive: (cellId: string | null) => void;

  connectBridge: () => Promise<void>;
  openNotebook: (path: string) => Promise<void>;
  applyNotebookState: (payload: unknown) => void;
  /** ui.get 响应水合折叠集合与 activeCellId（损坏载荷回退空对象，不抛）。 */
  hydrateUi: (payload: unknown) => void;
  /** OutputDisclosure 折叠切换：写 uiCollapsed + 500ms debounce 持久化 ui.set。 */
  setCellCollapsed: (cellId: string, collapsed: boolean) => void;
  setCellCode: (cellId: string, code: string) => void;
  saveCell: (cellId: string, code: string) => Promise<void>;
  runCell: (cellId: string) => Promise<void>;
  runRepl: (code: string) => Promise<void>;
  restartKernel: () => Promise<void>;
}

/** 连接 promise 记忆化：StrictMode 双挂载/多处调用只建一条 WS、只订阅一次通知。 */
let connectPromise: Promise<void> | null = null;

/** UI 状态持久化（ui.set）的 debounce 窗口：折叠切换/激活 cell 共用一条通道。 */
export const UI_PERSIST_DEBOUNCE_MS = 500;
let uiPersistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 调度一次 ui.set（500ms debounce 合并连发）：把当前 uiCollapsed + activeCellId
 * 整包写给 bridge sidecar。未打开 notebook 时无事发生（纯本地状态变更不持久化）。
 */
function scheduleUiPersist(get: () => NotebookStore): void {
  if (!get().notebookPath) return;
  if (uiPersistTimer) clearTimeout(uiPersistTimer);
  uiPersistTimer = setTimeout(() => {
    uiPersistTimer = null;
    const s = get();
    if (!s.notebookPath) return;
    bridge
      .rpc('ui.set', {
        path: s.notebookPath,
        patch: { collapsed: s.uiCollapsed, activeCellId: s.activeCellId },
      })
      .catch((err: unknown) => console.error('ui.set 失败:', err));
  }, UI_PERSIST_DEBOUNCE_MS);
}

/**
 * 持久 REPL cell 的固定 id（bridge 冻结契约：run.* 通知的 cellId 恒为 "repl"）。
 * 不随每次运行新建匿名 cell——首跑创建、后续清空输出缓冲重新累积。
 */
export const REPL_CELL_ID = 'repl';

/** 全局状态：cell 列表、DAG、stale 集合、diff 队列、内核状态（spec §10）。 */
export const useNotebook = create<NotebookStore>((set, get) => ({
  cells: [],
  dagEdges: [],
  staleSet: [],
  schemas: [],
  kernelState: 'connecting',
  diffs: [],
  activeCellId: null,
  notebookPath: null,
  bridgeConnected: false,
  compileErrors: {},
  uiCollapsed: {},

  setState: (patch) => set(patch),
  setActive: (cellId) => {
    set({ activeCellId: cellId });
    scheduleUiPersist(get); // P1.8：activeCell 走 sidecar 持久化通道（500ms debounce）
  },

  /** 连接 bridge 并订阅通知（run.* / kernel.status / notebook.state）。 */
  connectBridge: () => {
    if (connectPromise) return connectPromise;
    connectPromise = (async () => {
      try {
        await bridge.connect();
      } catch {
        connectPromise = null; // 允许后续重试（如 P1.8 的重连逻辑）
        set({ bridgeConnected: false });
        return;
      }
      bridge.onNotification((method, params) => {
        const s = get();
        switch (method) {
          case 'run.started':
          case 'run.stdout':
          case 'run.stderr':
          case 'run.mime':
          case 'run.done':
          case 'run.error':
            set({ cells: applyRunEvent(s.cells, method, params) });
            break;
          case 'kernel.status':
            set({ kernelState: mapKernelState(String(asRecord(params).state ?? '')) });
            break;
          case 'notebook.state':
            s.applyNotebookState(params);
            break;
          case 'diff.updated':
            // P2 Diff UI 的数据源；P1 仅摄入 store（status→state 映射），不渲染
            set({ diffs: normalizeDiffs(params) });
            break;
        }
      });
      set({ bridgeConnected: true });
    })();
    return connectPromise;
  },

  openNotebook: async (path) => {
    try {
      const res = await bridge.rpc<NotebookStatePayload>('notebook.open', { path });
      set({ notebookPath: path });
      get().applyNotebookState(res);
      // P1.8：水合 UI sidecar（折叠集合 + activeCellId）；失败不阻塞打开主流程
      try {
        const ui = await bridge.rpc('ui.get', { path });
        get().hydrateUi(ui);
      } catch (err) {
        console.error('ui.get 失败:', err);
      }
    } catch (err) {
      console.error('notebook.open 失败:', err);
      set({ bridgeConnected: false });
    }
  },

  applyNotebookState: (payload) => {
    const p = asRecord(payload) as unknown as NotebookStatePayload;
    const cells = applyStaleSet(normalizeCells(p.cells ?? [], p.execCounts), p.staleSet ?? []);
    // 持久 [repl] cell 非文件内容，bridge 的全量 state 不含它——刷新/重启后保留
    const prevRepl = get().cells.find((c) => c.id === REPL_CELL_ID);
    const next =
      prevRepl && !cells.some((c) => c.id === REPL_CELL_ID) ? [...cells, prevRepl] : cells;
    // 热重载/重启的全量 state 不冲掉用户当前激活的 cell（仍存在则保留；
    // uiCollapsed 是独立键，set 天然不触碰）
    const prevActive = get().activeCellId;
    const activeCellId =
      prevActive !== null && next.some((c) => c.id === prevActive)
        ? prevActive
        : (next[0]?.id ?? prevActive);
    set({
      cells: next,
      dagEdges: p.dagEdges ?? [],
      staleSet: p.staleSet ?? [],
      schemas: p.schemas ?? [],
      activeCellId,
    });
  },

  hydrateUi: (payload) => {
    const p = asRecord(payload);
    const rawCollapsed = asRecord(p.collapsed);
    const collapsed: Record<string, boolean> = {};
    for (const [cellId, v] of Object.entries(rawCollapsed)) {
      if (typeof v === 'boolean') collapsed[cellId] = v;
    }
    // activeCellId 仅在 sidecar 存有有效值时覆盖（applyNotebookState 已选了默认）
    const active = typeof p.activeCellId === 'string' ? p.activeCellId : null;
    set({
      uiCollapsed: collapsed,
      ...(active !== null ? { activeCellId: active } : {}),
    });
  },

  setCellCollapsed: (cellId, collapsed) => {
    set({ uiCollapsed: { ...get().uiCollapsed, [cellId]: collapsed } });
    scheduleUiPersist(get);
  },

  setCellCode: (cellId, code) => {
    set({ cells: patchCell(get().cells, cellId, (c) => ({ ...c, code })) });
  },

  /** cell.save：bridge 重算 DAG，响应更新 dagEdges/staleSet 并把 stale cell 标灰。 */
  saveCell: async (cellId, code) => {
    try {
      const res = await bridge.rpc<CellSaveResult>('cell.save', { cellId, code });
      const staleSet = res?.staleSet ?? get().staleSet;
      const compileErrors = { ...get().compileErrors };
      if (res?.compileError) compileErrors[cellId] = res.compileError;
      else delete compileErrors[cellId];
      set({
        dagEdges: res?.dagEdges ?? get().dagEdges,
        staleSet,
        compileErrors,
        cells: applyStaleSet(get().cells, staleSet),
      });
    } catch (err) {
      console.error('cell.save 失败:', err);
    }
  },

  runCell: async (cellId) => {
    // 乐观置 running；真实流式更新由 run.* 通知驱动
    set({ cells: patchCell(get().cells, cellId, (c) => ({ ...c, status: 'running' })) });
    try {
      await bridge.rpc('cell.run', { cellId, cascade: false });
    } catch (err) {
      console.error('cell.run 失败:', err);
      set({ cells: patchCell(get().cells, cellId, (c) => ({ ...c, status: 'error' })) });
    }
  },

  /**
   * REPL：输出回灌为单一持久 [repl] cell（id='repl'，bridge 冻结契约）。
   * 首跑创建、后续运行清空其输出缓冲重新累积（run.started 亦带清空语义）。
   * 该 cell kind='repl' → CellHeader 显示 [repl] 徽章、不参与 DAG/stale。
   */
  runRepl: async (code) => {
    const cellId = REPL_CELL_ID;
    set({
      cells: upsertReplCell(get().cells, cellId, code),
    });
    try {
      const res = await bridge.rpc<ReplResult>('kernel.repl', { code });
      // run.* 通知（cellId 恒为 'repl'）通常已把输出灌进该 cell；
      // 这里兜底合并响应体里直接带回的输出（cellId 仅信息字段，忽略）
      const r = asRecord(res);
      set({
        cells: patchCell(get().cells, cellId, (c) => {
          let output = c.output ?? createEmptyOutput();
          if (typeof r.stdout === 'string' && r.stdout && output.stdout === '') {
            output = { ...output, stdout: r.stdout };
          }
          if (typeof r.stderr === 'string' && r.stderr && output.stderr === '') {
            output = { ...output, stderr: r.stderr };
          }
          if (typeof r.traceback === 'string' && r.traceback && !output.traceback) {
            output = {
              ...output,
              traceback: { text: r.traceback, frames: (r.frames as TracebackFrame[]) ?? [] },
            };
          }
          return { ...c, output, status: output.traceback ? 'error' : 'idle' };
        }),
      });
    } catch (err) {
      console.error('kernel.repl 失败:', err);
      set({ cells: patchCell(get().cells, cellId, (c) => ({ ...c, status: 'error' })) });
    }
  },

  restartKernel: async () => {
    set({ kernelState: 'restarting' });
    try {
      // 冻结契约：kernel.restart 响应 = 新的 notebook.state 全量载荷
      const res = await bridge.rpc<NotebookStatePayload>('kernel.restart');
      if (res && (res.cells || res.dagEdges)) get().applyNotebookState(res);
    } catch (err) {
      console.error('kernel.restart 失败:', err);
      set({ kernelState: 'dead' });
    }
  },
}));
