import { create } from 'zustand';
import { bridge } from '../bridge/client';
import { decideStalePolicy, type StaleContext, type StaleDecision } from '../kernel/stalePolicy';
import {
  emptyCache,
  useNotebooks,
  type NotebookCache,
  type NotebookStateResult,
} from './notebooks';
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

    case 'run.notify': {
      // P2.9（K 线）：文件写事件 {cellId, kind:'file-write', path} → output.writes 追加（去重、封顶 50）
      if (p.kind !== 'file-write' || typeof p.path !== 'string') return cells as Cell[];
      const path = p.path;
      return patchCell(cells, cellId, (c) =>
        withOutput(c, (o) =>
          o.writes.includes(path) || o.writes.length >= 50
            ? o
            : { ...o, writes: [...o.writes, path] },
        ),
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
 * bridge 冻结契约：每个 diff 的 id 字段名是 `diffId`（protocol.ts StagedDiff），
 * 状态字段是 `status`（proposed|accepted|rejected），映射到前端的 `state`；
 * 'edited-staged' 为纯前端态，bridge 不会产生。兼容 `id` 别名以防契约演进。
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
      id: String(r.diffId ?? r.id ?? ''),
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
/* P2.3 Diff 审阅 UX + 级联策略（spec §9；纯函数导出供单测）            */
/* ------------------------------------------------------------------ */

/**
 * 本地 diff 标记：bridge 的 diff.stage 不收 origin 字段（冻结契约），
 * 'user' origin 与 'edited-staged'（spec §9：用户手改后重新进入 proposed，
 * 标注 user-edited）只能前端本地记录，key = bridge 分配的 diffId。
 */
export interface DiffMark {
  origin?: 'agent' | 'user';
  state?: 'edited-staged';
}
export type DiffMarks = Record<string, DiffMark>;

/** pending 审阅队列：proposed / edited-staged（后者语义仍是待审，只是标注 user-edited）。 */
export function pendingDiffs(diffs: readonly StagedDiff[]): StagedDiff[] {
  return diffs.filter((d) => d.state === 'proposed' || d.state === 'edited-staged');
}

/**
 * diff.updated 载荷与本地 marks 合并：
 * - bridge 通知是收敛真源——status='accepted'/'rejected' 无条件覆盖本地乐观态与 marks；
 * - marks 只把 proposed 提升为 edited-staged 并标注 origin='user'；
 * - 不在载荷中的 id 的 mark 被剪除（diff 已终结），防止映射无限增长。
 */
export function mergeDiffMarks(
  incoming: readonly StagedDiff[],
  marks: DiffMarks,
): { diffs: StagedDiff[]; marks: DiffMarks } {
  const nextMarks: DiffMarks = {};
  const diffs = incoming.map((d) => {
    const m = marks[d.id];
    if (!m || (d.state !== 'proposed' && d.state !== 'edited-staged')) return d;
    nextMarks[d.id] = m;
    return {
      ...d,
      origin: m.origin ?? d.origin,
      state: m.state === 'edited-staged' ? ('edited-staged' as const) : d.state,
    };
  });
  return { diffs, marks: nextMarks };
}

/**
 * cellId 在 DAG 上的全部传递下游（不含自身），按 cells 文档序返回——
 * .py 文件的 cell 顺序即拓扑序，故文档序可直接作为级联重跑顺序。
 */
export function downstreamCells(
  cellId: string,
  edges: readonly DagEdge[],
  cells: readonly Cell[],
): Cell[] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.from);
    if (list) list.push(e.to);
    else adj.set(e.from, [e.to]);
  }
  const seen = new Set<string>([cellId]);
  const queue = [cellId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nxt of adj.get(cur) ?? []) {
      if (!seen.has(nxt)) {
        seen.add(nxt);
        queue.push(nxt);
      }
    }
  }
  seen.delete(cellId);
  return cells.filter((c) => seen.has(c.id));
}

/** KernelStatusBar 的级联策略开关取值；'policy' = 交给 decideStalePolicy（Owner 裁决）。 */
export type CascadeOverride = 'policy' | 'auto' | 'mark-only' | 'ask';

/**
 * 生效级联决策 = override ?? decideStalePolicy(ctx)。
 * 'policy'（默认）不是覆盖，退化为 stalePolicy.ts 的裁决（当前恒 mark-only，
 * 该文件冻结、只读调用）；其余三档直通映射。
 */
export function resolveCascadeDecision(
  override: CascadeOverride,
  ctx: StaleContext,
): StaleDecision {
  switch (override) {
    case 'auto':
      return 'auto-cascade';
    case 'mark-only':
      return 'mark-only';
    case 'ask':
      return 'ask';
    case 'policy':
    default:
      return decideStalePolicy(ctx);
  }
}

/** 托盘快捷键动作。 */
export type TrayKeyAction = 'accept-head' | 'reject-head' | 'reject-all' | null;

/** Esc Esc 双击判定窗口（ms，spec §9：Esc Esc 全拒）。 */
export const TRAY_ESC_DOUBLE_MS = 300;

/**
 * 托盘键盘纯逻辑（spec §9 多 diff 队列）：
 *   Tab = 采纳队首；Esc = 拒绝队首；300ms 内第二次 Esc = 全拒。
 * 返回动作与更新后的 lastEscAt（调用方存 ref）。其他键不动作、不重置双击窗口
 * （窗口只由时间流逝失效，避免中间按键吞掉合法的 Esc Esc）。
 */
export function trayKeyAction(
  key: string,
  opts: { now: number; lastEscAt: number | null; doubleMs?: number },
): { action: TrayKeyAction; nextEscAt: number | null } {
  const doubleMs = opts.doubleMs ?? TRAY_ESC_DOUBLE_MS;
  if (key === 'Tab') return { action: 'accept-head', nextEscAt: opts.lastEscAt };
  if (key === 'Escape') {
    const isDouble = opts.lastEscAt !== null && opts.now - opts.lastEscAt <= doubleMs;
    return isDouble
      ? { action: 'reject-all', nextEscAt: null }
      : { action: 'reject-head', nextEscAt: opts.now };
  }
  return { action: null, nextEscAt: opts.lastEscAt };
}

/** @codemirror/merge 的 Chunk 位置四元组（结构子集，方便单测）。 */
export interface ChunkPos {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

/**
 * hunk 级 ×（回退该 hunk）：把 B 文档（新码）中 chunk 覆盖的区间替换回
 * A 文档（原码）的对应文本，返回 CM6 change spec。toA 可能越过 A 文档末尾
 * （merge 契约：末行 chunk），钳制到文档长度。
 */
export function chunkRevertChange(
  original: string,
  chunk: ChunkPos,
): { from: number; to: number; insert: string } {
  const toA = Math.min(chunk.toA, original.length);
  const fromA = Math.min(chunk.fromA, toA);
  return { from: chunk.fromB, to: chunk.toB, insert: original.slice(fromA, toA) };
}

/** diff.accept 响应（bridge router.ts diffAccept 返回体；compileError 为 {message, cellIds}）。 */
export interface DiffAcceptResult {
  diffId: string;
  dagEdges?: DagEdge[];
  staleSet?: string[];
  compileError?: { message?: string; cellIds?: string[] } | string;
  run?: { cellId?: string; ok?: boolean; durationMs?: number };
}

/** 'ask' 档的确认弹窗请求（CascadeAskDialog 渲染；resolve 由弹窗按钮触发）。 */
export interface CascadeAskRequest {
  triggeredBy: 'user-run' | 'diff-accepted';
  sourceCellId: string;
  /** 将被级联重跑的下游 cells 快照（含 sideEffect 徽章数据）。 */
  downstream: Cell[];
  resolve: (run: boolean) => void;
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
  /** P2.3 diff 切片：本地 origin/edited-staged 标记（bridge 契约无这些字段）。 */
  diffMarks: DiffMarks;
  /** P2.4 级联策略开关（KernelStatusBar select；默认 'policy' = decideStalePolicy 裁决）。 */
  cascadeOverride: CascadeOverride;
  /** cellId → 最近一次 run.done 的 durationMs（decideStalePolicy 的 lastRunMs 输入）。 */
  lastRunMs: Record<string, number>;
  /** 'ask' 档待确认的级联请求；null = 无弹窗。 */
  cascadeAsk: CascadeAskRequest | null;

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

  /** P3.1：切换焦点 tab（捕获旧 tab 切片 → 恢复目标 tab；内核进程保活）。 */
  switchTab: (notebookId: string) => Promise<void>;
  /** P3.1：关闭 tab（bridge notebook.close → 会话 ended；焦点转移并恢复新焦点缓存）。 */
  closeTab: (notebookId: string) => Promise<void>;

  setCascadeOverride: (v: CascadeOverride) => void;
  /** Accept → bridge diff.accept（bridge 会 save+run cascade:false 并回 diff.updated）。 */
  acceptDiff: (diffId: string) => Promise<void>;
  /** Reject → bridge diff.reject。 */
  rejectDiff: (diffId: string) => Promise<void>;
  /** Esc Esc 全拒：pending 队列整批 diff.reject。 */
  rejectAllPending: () => Promise<void>;
  /** 用户在 diff 视图内编辑 newCode → 重新 diff.stage（origin 'user' + edited-staged 本地标记）。 */
  reStageDiff: (diffId: string, newCode: string) => Promise<void>;
  /** 'ask' 弹窗裁决：run=true → 级联重跑下游。 */
  resolveCascadeAsk: (run: boolean) => void;
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

/* ---- P2.3/P2.4 内部助手（非 store action，参数化 set 以便纯逻辑测试） ---- */

type StoreSet = (partial: Partial<NotebookStore>) => void;

/** 'ask' 档：打开 CascadeAskDialog，等用户裁决；resolve(true)=级联重跑。 */
function askCascade(
  set: StoreSet,
  req: Omit<CascadeAskRequest, 'resolve'>,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => set({ cascadeAsk: { ...req, resolve } }));
}

/**
 * 级联重跑下游（前端驱动）：bridge 的 cell.run/diff.accept 冻结为 cascade:false
 * （Owner 裁决 mark-only），'auto'/'ask→run' 档由前端按拓扑序逐格 cell.run。
 * 某一格失败即中止后续——避免在错误状态上继续连锁执行。
 */
async function cascadeRun(cellIds: readonly string[]): Promise<void> {
  for (const id of cellIds) {
    try {
      await bridge.rpc('cell.run', { cellId: id, cascade: false });
    } catch (err) {
      console.error('cascade cell.run 失败（中止后续下游）:', id, err);
      break;
    }
  }
}

/** 乐观状态回滚：rpc 失败时把 accepted/rejected 还原，让队列可重试。 */
function revertDiffState(
  diffs: readonly StagedDiff[],
  diffId: string,
  back: StagedDiff['state'],
): StagedDiff[] {
  return diffs.map((d) => (d.id === diffId ? { ...d, state: back } : d));
}

/** bridge CompileError（{message, cellIds}）/字符串两种形态 → 行内提示文本。 */
function compileErrorText(e: DiffAcceptResult['compileError']): string {
  if (typeof e === 'string') return e;
  return String(e?.message ?? 'compile error');
}
function compileErrorCellIds(
  e: DiffAcceptResult['compileError'],
  fallback: string,
): string[] {
  if (typeof e === 'string' || !e) return [fallback];
  return e.cellIds && e.cellIds.length > 0 ? e.cellIds : [fallback];
}

/* ---- P3.1 多 tab：焦点视图 ⇄ notebooks 缓存 的捕获/恢复 + ended 护栏 ---- */

/** 捕获当前焦点视图切片 → notebooks 缓存（tab 切走时调用）。 */
function captureCache(): NotebookCache {
  const s = useNotebook.getState();
  return {
    cells: s.cells,
    dagEdges: s.dagEdges,
    staleSet: s.staleSet,
    schemas: s.schemas,
    compileErrors: s.compileErrors,
    diffs: s.diffs,
    diffMarks: s.diffMarks,
    activeCellId: s.activeCellId,
    uiCollapsed: s.uiCollapsed,
    lastRunMs: s.lastRunMs,
  };
}

/** 从 notebooks 缓存恢复焦点视图（tab 切回时调用）。 */
function hydrateCache(c: NotebookCache): void {
  useNotebook.setState({
    cells: c.cells,
    dagEdges: c.dagEdges,
    staleSet: c.staleSet,
    schemas: c.schemas,
    compileErrors: c.compileErrors,
    diffs: c.diffs,
    diffMarks: c.diffMarks,
    activeCellId: c.activeCellId,
    uiCollapsed: c.uiCollapsed,
    lastRunMs: c.lastRunMs,
  });
}

/**
 * 焦点 tab 是否已 ended（内核 dead / 会话结束）→ view-only。
 * 复用 session readOnly 护栏语义：写路径 action 全部 no-op（防 Ctrl+Enter、
 * 残留 debounce、外部热重载广播等旁路触碰已死内核）。无 tab 时 false（放行）。
 */
function activeEnded(): boolean {
  return useNotebooks.getState().activeTab()?.ended === true;
}

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
  diffMarks: {},
  cascadeOverride: 'policy',
  lastRunMs: {},
  cascadeAsk: null,

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
          case 'run.error':
          case 'run.notify':
            set({ cells: applyRunEvent(s.cells, method, params) });
            break;
          case 'run.done': {
            // 除 cells reducer 外，记录 durationMs（级联决策的 lastRunMs 输入，P2.4）
            const p = asRecord(params);
            const ms = Number(p.durationMs);
            set({
              cells: applyRunEvent(s.cells, method, params),
              ...(typeof p.cellId === 'string' && p.cellId !== '' && Number.isFinite(ms)
                ? { lastRunMs: { ...get().lastRunMs, [p.cellId]: ms } }
                : {}),
            });
            break;
          }
          case 'kernel.status': {
            const raw = String(asRecord(params).state ?? '');
            set({ kernelState: mapKernelState(raw) });
            // P3.1：焦点 tab 的内核状态同步到注册表（TabBar 点色 + ended 判定）
            const aid = useNotebooks.getState().activeId;
            if (
              aid &&
              (raw === 'idle' || raw === 'busy' || raw === 'restarting' || raw === 'dead')
            ) {
              useNotebooks.getState().setKernelState(aid, raw);
            }
            break;
          }
          case 'focus.changed': {
            // P3.1：焦点切换（本端 switchTab 的回声 id===activeId 时跳过，防环）。
            // 纯本地恢复：不再回调 bridge（避免二次 switch）。
            const id = String(asRecord(params).notebookId ?? '');
            const nb = useNotebooks.getState();
            if (!id || id === nb.activeId) break;
            if (nb.activeId) nb.saveCache(nb.activeId, captureCache());
            nb.setActive(id);
            const tab = nb.tabs.find((t) => t.notebookId === id);
            set({ notebookPath: tab?.path ?? null });
            const cached = nb.readCache(id);
            if (cached) hydrateCache(cached);
            break;
          }
          case 'kernel.schemas': {
            // L-3：bridge 在 run.done 后自动 introspect 并广播（kernelVars 显式调用亦广播）
            // → store.schemas 随每次执行刷新，FixCard"traceback + N schemas"不再恒 0。
            const arr = asRecord(params).schemas;
            if (Array.isArray(arr)) set({ schemas: arr as VarSchema[] });
            break;
          }
          case 'notebook.state':
            s.applyNotebookState(params);
            break;
          case 'diff.updated': {
            // P2.3 数据源：bridge 通知为收敛真源；本地 marks 只提升 proposed→edited-staged
            const merged = mergeDiffMarks(normalizeDiffs(params), get().diffMarks);
            set({ diffs: merged.diffs, diffMarks: merged.marks });
            break;
          }
        }
      });
      set({ bridgeConnected: true });
    })();
    return connectPromise;
  },

  openNotebook: async (path) => {
    try {
      // P3.1：notebook.open 返回 {notebookId, state}；注册表 upsert tab + 置焦点
      const res = await useNotebooks.getState().openRpc(path);
      const id = typeof res?.notebookId === 'string' ? res.notebookId : null;
      set({ notebookPath: path });
      if (res?.state) get().applyNotebookState(res.state as unknown as NotebookStatePayload);
      // 焦点视图切片种入该 tab 缓存（切走再切回可即时恢复）
      if (id) useNotebooks.getState().saveCache(id, captureCache());
      // P1.8：水合 UI sidecar（折叠集合 + activeCellId）；失败不阻塞打开主流程
      try {
        const ui = await bridge.rpc('ui.get', { path });
        get().hydrateUi(ui);
        if (id) useNotebooks.getState().saveCache(id, captureCache());
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
    if (activeEnded()) return; // view-only（ended tab）护栏
    set({ cells: patchCell(get().cells, cellId, (c) => ({ ...c, code })) });
    const id = useNotebooks.getState().activeId;
    if (id) useNotebooks.getState().markDirty(id, true); // 本地未保存标记（close 确认用）
  },

  /** cell.save：bridge 重算 DAG，响应更新 dagEdges/staleSet 并把 stale cell 标灰。 */
  saveCell: async (cellId, code) => {
    if (activeEnded()) return; // view-only（ended tab）护栏
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
      // 落盘成功 → 清除该 tab 的未保存标记（bridge cell.save 即写 .py）
      const id = useNotebooks.getState().activeId;
      if (id) useNotebooks.getState().markDirty(id, false);
    } catch (err) {
      console.error('cell.save 失败:', err);
    }
  },

  /**
   * 运行 cell（P2.4 级联接线）：cascade 参数 = cascadeOverride ?? decideStalePolicy。
   * 'ask' 档先弹 CascadeAskDialog（下游清单 + 侧效应徽章）等裁决；无下游时
   * 恒 cascade:false（决策没有意义，也不弹窗）。
   */
  runCell: async (cellId) => {
    if (activeEnded()) return; // view-only（ended tab）护栏
    const s = get();
    const downstream = downstreamCells(cellId, s.dagEdges, s.cells);
    let cascade = false;
    if (downstream.length > 0) {
      const decision = resolveCascadeDecision(s.cascadeOverride, {
        downstream,
        lastRunMs: s.lastRunMs[cellId] ?? 0,
        triggeredBy: 'user-run',
      });
      if (decision === 'auto-cascade') cascade = true;
      else if (decision === 'ask') cascade = await askCascade(set, {
        triggeredBy: 'user-run',
        sourceCellId: cellId,
        downstream,
      });
      // 'mark-only' → cascade:false：bridge 运行后重算 staleSet，applyStaleSet 标灰下游
    }
    // 乐观置 running；真实流式更新由 run.* 通知驱动
    set({ cells: patchCell(get().cells, cellId, (c) => ({ ...c, status: 'running' })) });
    try {
      await bridge.rpc('cell.run', { cellId, cascade });
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
    if (activeEnded()) return; // view-only（ended tab）护栏
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
    if (activeEnded()) return; // view-only（ended tab）护栏
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

  /* ---------------- P3.1 多 tab：切换 / 关闭（内核进程保活） ---------------- */

  /**
   * 切换焦点 tab：捕获当前焦点切片入旧 tab 缓存 → bridge notebook.switch（切 router
   * 焦点，返回目标全量 state）→ 恢复目标视图（优先新鲜 state，否则本地缓存）。
   * 内核进程在 bridge 侧保活，切走不杀；切回状态即在。
   */
  switchTab: async (notebookId) => {
    const nb = useNotebooks.getState();
    const prev = nb.activeId;
    if (prev === notebookId) return;
    if (prev) nb.saveCache(prev, captureCache());
    const res: NotebookStateResult | null = await nb.switchRpc(notebookId);
    const tab = useNotebooks.getState().tabs.find((t) => t.notebookId === notebookId);
    if (tab) set({ notebookPath: tab.path });
    // 恢复目标视图：优先本地缓存（含输出缓冲/repl/状态，"切回状态即在"）；
    // 无缓存时用 bridge 返回的全量 state 兜底。均走非护栏 set（tab 导航不受只读护栏拦截）。
    const cached = useNotebooks.getState().readCache(notebookId);
    if (cached) {
      hydrateCache(cached);
    } else if (res?.state && (res.state.cells || res.state.dagEdges)) {
      const p = res.state as unknown as NotebookStatePayload;
      const cells = applyStaleSet(normalizeCells(p.cells ?? [], p.execCounts), p.staleSet ?? []);
      set({
        cells,
        dagEdges: p.dagEdges ?? [],
        staleSet: p.staleSet ?? [],
        schemas: p.schemas ?? [],
        activeCellId: cells[0]?.id ?? null,
      });
      useNotebooks.getState().saveCache(notebookId, captureCache());
    }
    set({ kernelState: tab ? mapKernelState(tab.kernelState) : 'connecting' });
  },

  /**
   * 关闭 tab：bridge notebook.close（save_file + 内核 shutdown + 会话 ended）→ 注册表
   * 摘除 → 若关的是焦点 tab，恢复新焦点 tab 的缓存（无剩余则清空焦点视图）。
   */
  closeTab: async (notebookId) => {
    const nb = useNotebooks.getState();
    const wasActive = nb.activeId === notebookId;
    const { nextActiveId } = await nb.closeRpc(notebookId);
    if (!wasActive) return;
    if (nextActiveId) {
      const tab = useNotebooks.getState().tabs.find((t) => t.notebookId === nextActiveId);
      set({ notebookPath: tab?.path ?? null });
      const cached = useNotebooks.getState().readCache(nextActiveId);
      if (cached) hydrateCache(cached);
      set({ kernelState: tab ? mapKernelState(tab.kernelState) : 'connecting' });
    } else {
      // 无剩余 tab：清空焦点视图
      set({
        notebookPath: null,
        ...emptyCache(),
        kernelState: 'connecting',
      });
    }
  },

  /* ---------------- P2.3 diff 审阅切片（spec §9 状态机） ---------------- */

  setCascadeOverride: (v) => set({ cascadeOverride: v }),
  resolveCascadeAsk: (run) => {
    const ask = get().cascadeAsk;
    set({ cascadeAsk: null });
    ask?.resolve(run);
  },

  /**
   * Accept（proposed/edited-staged → accepted）：
   * 1. 乐观置 accepted（立即离开 pending 队列）；
   * 2. bridge diff.accept = cell.save + cell.run cascade:false（冻结契约），
   *    随后广播 diff.updated——通知到达时整体收敛（mergeDiffMarks，bridge 为准）；
   * 3. 响应携带 dagEdges/staleSet/compileError/run：本地同步 DAG 与 stale 标记；
   * 4. P2.4：本 cell 运行后的下游级联由前端按 resolveCascadeDecision 补跑
   *    （bridge 侧恒 cascade:false，不接受 cascade 参数）。
   * rpc 失败 → 回滚乐观态，diff 回到队列可重试。
   */
  acceptDiff: async (diffId) => {
    if (activeEnded()) return; // view-only（ended tab）护栏
    const prev = get().diffs.find((d) => d.id === diffId);
    if (!prev || (prev.state !== 'proposed' && prev.state !== 'edited-staged')) return;
    set({ diffs: revertDiffState(get().diffs, diffId, 'accepted') });
    try {
      const res = await bridge.rpc<DiffAcceptResult>('diff.accept', { diffId });
      const s = get();
      const dagEdges = res?.dagEdges ?? s.dagEdges;
      const staleSet = res?.staleSet ?? s.staleSet;
      const compileErrors = { ...s.compileErrors };
      let cells = s.cells;

      // insert_below：bridge 不推全量 notebook.state，本地插入占位 cell
      //（run.* 通知会流式灌输出；后续任何 notebook.state 全量推送会覆盖校准）
      const newCellId =
        prev.action === 'insert_below' && typeof res?.run?.cellId === 'string'
          ? res.run.cellId
          : null;
      if (newCellId && !cells.some((c) => c.id === newCellId)) {
        const idx = cells.findIndex((c) => c.id === prev.targetCellId);
        const fresh: Cell = {
          id: newCellId,
          code: prev.newCode,
          execCount: null,
          status: 'running',
          defs: [],
          refs: [],
          sideEffect: false,
          kind: 'code',
          output: createEmptyOutput(),
        };
        cells =
          idx >= 0
            ? [...cells.slice(0, idx + 1), fresh, ...cells.slice(idx + 1)]
            : [...cells, fresh];
      } else if (prev.action === 'update') {
        // update：bridge 已 save+run，本地同步 newCode（不等热重载）
        cells = patchCell(cells, prev.targetCellId, (c) => ({ ...c, code: prev.newCode }));
      }

      if (res?.compileError) {
        for (const cid of compileErrorCellIds(res.compileError, prev.targetCellId)) {
          compileErrors[cid] = compileErrorText(res.compileError);
        }
      }
      set({ cells: applyStaleSet(cells, staleSet), dagEdges, staleSet, compileErrors });
      if (res?.compileError) return; // 编译错不进运行队列（spec §12），也不谈级联

      // P2.4 级联决策：下游 = DAG 传递闭包 ∩ 新 staleSet（只重跑真正失效的）
      const runCellId = newCellId ?? prev.targetCellId;
      const downstream = downstreamCells(runCellId, dagEdges, get().cells).filter((c) =>
        staleSet.includes(c.id),
      );
      if (downstream.length === 0) return;
      const s2 = get();
      const decision = resolveCascadeDecision(s2.cascadeOverride, {
        downstream,
        lastRunMs: s2.lastRunMs[runCellId] ?? 0,
        triggeredBy: 'diff-accepted',
      });
      if (decision === 'auto-cascade') {
        await cascadeRun(downstream.map((c) => c.id));
      } else if (decision === 'ask') {
        const run = await askCascade(set, {
          triggeredBy: 'diff-accepted',
          sourceCellId: runCellId,
          downstream,
        });
        if (run) await cascadeRun(downstream.map((c) => c.id));
      }
      // 'mark-only' → 什么都不做：applyStaleSet 已把下游标灰（Owner 裁决默认）
    } catch (err) {
      console.error('diff.accept 失败:', err);
      set({ diffs: revertDiffState(get().diffs, diffId, prev.state) });
    }
  },

  /** Reject（proposed/edited-staged → rejected）：乐观出队 + bridge diff.reject。 */
  rejectDiff: async (diffId) => {
    if (activeEnded()) return; // view-only（ended tab）护栏
    const prev = get().diffs.find((d) => d.id === diffId);
    if (!prev || (prev.state !== 'proposed' && prev.state !== 'edited-staged')) return;
    set({ diffs: revertDiffState(get().diffs, diffId, 'rejected') });
    try {
      await bridge.rpc('diff.reject', { diffId });
    } catch (err) {
      console.error('diff.reject 失败:', err);
      set({ diffs: revertDiffState(get().diffs, diffId, prev.state) });
    }
  },

  /** Esc Esc 全拒：整批乐观出队 + 并发 diff.reject（单个失败只回滚由 bridge 通知收敛）。 */
  rejectAllPending: async () => {
    if (activeEnded()) return; // view-only（ended tab）护栏
    const queue = pendingDiffs(get().diffs);
    if (queue.length === 0) return;
    set({
      diffs: get().diffs.map((d) =>
        d.state === 'proposed' || d.state === 'edited-staged' ? { ...d, state: 'rejected' as const } : d,
      ),
    });
    await Promise.all(
      queue.map((d) =>
        bridge.rpc('diff.reject', { diffId: d.id }).catch((err: unknown) => {
          console.error('diff.reject（全拒）失败:', d.id, err);
        }),
      ),
    );
  },

  /**
   * 用户在 diff 视图内编辑 newCode（含 hunk 级 × 回退）→ 重新 diff.stage：
   * bridge 契约会分配新 diffId 并广播 diff.updated；本地对新 id 打
   * {origin:'user', state:'edited-staged'} 标记，被替换的旧 diff 以 reject 退队。
   * 状态机（spec §9）：edited-staged 重新进入 proposed 队列，标注 user-edited。
   */
  reStageDiff: async (diffId, newCode) => {
    if (activeEnded()) return; // view-only（ended tab）护栏
    const old = get().diffs.find((d) => d.id === diffId);
    if (!old || (old.state !== 'proposed' && old.state !== 'edited-staged')) return;
    if (old.newCode === newCode) return;
    try {
      const res = await bridge.rpc<{ diffId?: string }>('diff.stage', {
        targetCellId: old.targetCellId,
        action: old.action,
        newCode,
        ...(old.rationale !== undefined ? { rationale: old.rationale } : {}),
      });
      const newId = typeof res?.diffId === 'string' ? res.diffId : '';
      if (newId) {
        set({ diffMarks: { ...get().diffMarks, [newId]: { origin: 'user', state: 'edited-staged' } } });
      }
      await bridge.rpc('diff.reject', { diffId }).catch((err: unknown) => {
        console.error('diff.reject（旧 diff 退队）失败:', err);
      });
    } catch (err) {
      console.error('diff.stage（user edit）失败:', err);
    }
  },
}));
