import { create } from 'zustand';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { bridge, BridgeDisconnectedError, type BridgeStatus, type BridgeStatusEvent } from '../bridge/client';
import { decideStalePolicy, type StaleContext, type StaleDecision } from '../kernel/stalePolicy';
import {
  emptyCache,
  type DraftRecoveryOffer,
  useNotebooks,
  type NotebookCache,
  type NotebookStateResult,
  type NotebookRestartResult,
  type FileConflict,
  canRestartTab,
} from './notebooks';
import {
  CONTROL_MIME,
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
        const text = asText(p.data);
        if (p.mime === CONTROL_MIME) {
          // 同 cell 多控件逐控件发同一 mime key：按数组累积（去重），不按 key 覆盖
          return patchCell(cells, cellId, (c) =>
            withOutput(c, (o) => {
              const prev = o.mime[CONTROL_MIME];
              const arr = Array.isArray(prev) ? [...prev] : prev == null ? [] : [prev];
              if (!arr.includes(text)) arr.push(text);
              return { ...o, mime: { ...o.mime, [CONTROL_MIME]: arr } };
            }),
          );
        }
        bundle[p.mime] = text;
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
        // 失败的运行也计数（旧内核不带 → 保持原值）
        execCount: typeof p.execCount === 'number' ? p.execCount : c.execCount,
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
const VERIFICATION_STATUSES = new Set(['verified', 'unverified', 'failed', 'expired', 'not-required']);
const VERIFICATION_LEVELS = new Set(['V0', 'V1', 'V2', 'V3']);

function verificationOf(v: unknown): { verification?: NonNullable<StagedDiff['verification']> } {
  const r = asRecord(v);
  if (typeof r.status !== 'string' || !VERIFICATION_STATUSES.has(r.status)) return {};
  if (typeof r.level !== 'string' || !VERIFICATION_LEVELS.has(r.level)) return {};
  const missing = Array.isArray(r.missing) ? r.missing.filter((m): m is string => typeof m === 'string') : [];
  return {
    verification: {
      status: r.status as NonNullable<StagedDiff['verification']>['status'],
      level: r.level as NonNullable<StagedDiff['verification']>['level'],
      missing,
    },
  };
}

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
      ...(Array.isArray(r.dependsOn) && r.dependsOn.length > 0 ? { dependsOn: r.dependsOn.map(String) } : {}),
      ...verificationOf(r.verification),
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
  /** D4：接受后落盘的基线指纹。 */
  baselineSha256?: string;
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
  /** Session history is a UI projection; live drafts remain in the notebook cache. */
  historyView: boolean;
  /** bridge WS 是否已连接；false → App 显示降级横幅。 */
  bridgeConnected: boolean;
  /** 连接状态机投影：reconnecting / down 期间运行与保存暂停，编辑只留本地草稿。 */
  bridgeStatus: BridgeStatus;
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
  /** Agent 请求执行 cell、等待用户批准的队列（bridge agent.confirmRequest；先到先显示）。 */
  runConfirms: RunConfirmRequest[];

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
  /** Flush this notebook's latest drafts and wait for its FIFO save queue. */
  flushSaves: (notebookId: string) => Promise<void>;
  /** Explicit conflict resolution: back up all local source, then cold-load disk. */
  reloadFromDisk: (notebookId: string) => Promise<void>;
  runCell: (cellId: string) => Promise<void>;
  runRepl: (code: string) => Promise<void>;
  restartKernel: (options?: { allowLive?: boolean }) => Promise<void>;
  /** 新一代 bridge 后由用户点击：clean tab 冷重开（只 notebook.open，不执行、不重放）。 */
  reopenLostTab: (notebookId: string) => Promise<void>;
  /** 第 7 轮：指纹一致时把恢复日志放回本地草稿（不写盘）。 */
  restoreDraft: (notebookId: string) => void;
  /** 第 7 轮：把恢复日志保存为同目录本地副本（第 4 轮 backup_file），不改 notebook。 */
  preserveDraft: (notebookId: string) => Promise<void>;
  /** 第 7 轮：丢弃恢复日志。 */
  discardDraft: (notebookId: string) => Promise<void>;
  /** down 后「重试连接」：Tauri 内先重置监督额度并拉起 bridge，再重新进入重连循环。 */
  retryBridge: () => Promise<void>;

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
  /** Agent 执行确认裁决 → bridge agent.confirmResponse（别的窗口先答了也无妨）。 */
  answerRunConfirm: (requestId: string, allow: boolean) => Promise<void>;
}

/** bridge agent.confirmRequest 载荷：execute_cell（每次）或 shadow_run（ADR-013，每轮首次）。 */
export type RunConfirmRequest = ExecuteConfirmRequest | ShadowConfirmRequest;

export interface ExecuteConfirmRequest {
  kind: 'execute_cell';
  requestId: string;
  notebookId: string;
  cellId: string;
  code: string;
  cascade: boolean;
}

export interface ShadowConfirmChange {
  cellId: string;
  action: 'update' | 'insert_below';
  firstLine: string;
}

export interface ShadowConfirmRequest {
  kind: 'shadow_run';
  requestId: string;
  notebookId: string;
  /** null = 没有轮次（旧前端 / 漏接线）：允许只对这一次有效。 */
  turnId: string | null;
  changes: ShadowConfirmChange[];
  memLimitBytes: number;
  runMs: number;
  runsLeft: number;
  rememberForTurn: boolean;
}

function shadowConfirmFrom(requestId: string, p: Record<string, unknown>): ShadowConfirmRequest {
  const summary = asRecord(p.summary);
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const changes = (Array.isArray(summary.changes) ? summary.changes : []).flatMap((c): ShadowConfirmChange[] => {
    const r = asRecord(c);
    if (typeof r.cellId !== 'string' || typeof r.firstLine !== 'string') return [];
    if (r.action !== 'update' && r.action !== 'insert_below') return [];
    return [{ cellId: r.cellId, action: r.action, firstLine: r.firstLine }];
  });
  return {
    kind: 'shadow_run',
    requestId,
    notebookId: String(p.notebookId ?? ''),
    turnId: typeof p.turnId === 'string' ? p.turnId : null,
    changes,
    memLimitBytes: num(summary.memLimitBytes),
    runMs: num(summary.runMs),
    runsLeft: num(summary.runsLeft),
    rememberForTurn: summary.rememberForTurn === true,
  };
}

/** agent.confirmRequest / agent.confirmResolved → 待批准队列（纯函数，供单测）。 */
export function applyRunConfirmEvent(
  list: readonly RunConfirmRequest[],
  method: string,
  params: unknown,
): RunConfirmRequest[] {
  const p = asRecord(params);
  const requestId = typeof p.requestId === 'string' ? p.requestId : '';
  if (!requestId) return [...list];
  if (method === 'agent.confirmResolved') return list.filter((r) => r.requestId !== requestId);
  if (method !== 'agent.confirmRequest' || list.some((r) => r.requestId === requestId)) return [...list];
  if (p.kind === 'shadow_run') return [...list, shadowConfirmFrom(requestId, p)];
  if (p.kind !== 'execute_cell') return [...list];
  return [
    ...list,
    {
      kind: 'execute_cell',
      requestId,
      notebookId: String(p.notebookId ?? ''),
      cellId: String(p.cellId ?? ''),
      code: String(p.code ?? ''),
      cascade: p.cascade === true,
    },
  ];
}

/** 连接 promise 记忆化：StrictMode 双挂载/多处调用只建一条 WS、只订阅一次通知。 */
let connectPromise: Promise<void> | null = null;

function interruptRunning(cells: Cell[]): Cell[] {
  return cells.some((c) => c.status === 'running')
    ? cells.map((c) => (c.status === 'running' ? { ...c, status: 'stale' as const } : c))
    : cells;
}

/** 冷重开在途的旧代 notebookId（重复点击只发一次 notebook.open）。 */
const reopenInFlight = new Set<string>();

/**
 * 连接状态机 → store：
 * - reconnecting/down：横幅 + 暂停保存定时器（草稿保留）；在途运行由 rpc 拒绝结算为 stale；
 * - connected 且换了实例：全部 tab 标记 bridgeLost，等待用户逐个点击冷重开（D1），不自动 open；
 * - connected 且同一实例：tab 仍有效，补发断线期间累积的草稿。
 */
function handleBridgeStatus(event: BridgeStatusEvent): void {
  const store = useNotebook.getState();
  if (event.status === 'reconnecting' || event.status === 'down') {
    const nb = useNotebooks.getState();
    for (const tab of nb.tabs) {
      cancelSaveTimer(tab.notebookId);
      // 断线期间收不到 run.done：所有"运行中"的结果未知，标 stale，不伪装为完成或内核错误。
      const cache = nb.readCache(tab.notebookId);
      if (cache && tab.notebookId !== nb.activeId) nb.saveCache(tab.notebookId, { ...cache, cells: interruptRunning(cache.cells) });
    }
    // 断线：在途的执行确认已无法送达（bridge 侧超时按「未执行」结算），撤掉弹窗
    useNotebook.setState({ bridgeConnected: false, bridgeStatus: event.status, cells: interruptRunning(store.cells), runConfirms: [] });
    return;
  }
  if (event.status !== 'connected') return;
  const nb = useNotebooks.getState();
  if (event.newInstance) {
    if (nb.activeId && !store.historyView) nb.saveCache(nb.activeId, captureCache());
    nb.markBridgeLost();
    useNotebook.setState({
      bridgeConnected: true,
      bridgeStatus: 'connected',
      kernelState: nb.activeId ? 'dead' : store.kernelState,
    });
    void useNotebooks.getState().refreshList();
    return;
  }
  useNotebook.setState({ bridgeConnected: true, bridgeStatus: 'connected' });
  void useNotebooks.getState().refreshList();
  for (const tab of useNotebooks.getState().tabs) {
    if (tab.bridgeLost) continue;
    const drafts = owningCache(tab.notebookId)?.drafts ?? {};
    for (const cellId of Object.keys(drafts)) scheduleCellSave(tab.notebookId, cellId);
  }
}

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
  acceptError?: string,
): StagedDiff[] {
  return diffs.map((d) => {
    if (d.id !== diffId) return d;
    const { acceptError: _stale, ...rest } = d;
    return acceptError ? { ...rest, state: back, acceptError } : { ...rest, state: back };
  });
}

/** diff.accept 被拒（依赖未采纳 / 已被拒绝 / 内核错误）→ diff 卡片上的提示文本。 */
function acceptErrorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  const nb = useNotebooks.getState();
  const cache = nb.activeId ? nb.readCache(nb.activeId) : undefined;
  if (s.historyView) return cache ?? emptyCache();
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
    drafts: cache?.drafts ?? {},
    draftRevision: cache?.draftRevision ?? 0,
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
    historyView: false,
  });
}

/** Ended tabs and tabs being closed cannot receive new edits/runs/diffs. */
function activeWriteBlocked(): boolean {
  const tab = useNotebooks.getState().activeTab();
  return tab?.ended === true || tab?.closing === true || tab?.reloading === true || tab?.restarting === true;
}

/** bridge 断线（重连中或已放弃）：不发任何需要 bridge 的写/运行请求。 */
function bridgeOffline(): boolean {
  const status = useNotebook.getState().bridgeStatus;
  return status === 'reconnecting' || status === 'down';
}

function tabBridgeLost(notebookId: string | null | undefined): boolean {
  return !!notebookId && useNotebooks.getState().tabs.find((t) => t.notebookId === notebookId)?.bridgeLost === true;
}

/** 运行/Diff/REPL 需要活的 bridge 与本代内核；编辑（草稿）不受此限（D3）。 */
function activeRuntimeBlocked(): boolean {
  return activeWriteBlocked() || bridgeOffline() || tabBridgeLost(useNotebooks.getState().activeId);
}

/** 断线打断的运行：结果未知，标 stale 而不是伪装成内核错误。 */
function runFailureStatus(err: unknown): Cell['status'] {
  // 按 name 判断：测试替身可能不导出该类。
  return err instanceof Error && err.name === 'BridgeDisconnectedError' ? 'stale' : 'error';
}

export const CELL_SAVE_DEBOUNCE_MS = 300;
/** 第 7 轮：草稿在此时长后仍未保存才写恢复日志（正常自动保存 300 ms 内已完成）。 */
export const DRAFT_JOURNAL_DEBOUNCE_MS = 1_500;

const journalTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelDraftJournal(notebookId: string): void {
  const timer = journalTimers.get(notebookId);
  if (timer) clearTimeout(timer);
  journalTimers.delete(notebookId);
}

function scheduleDraftJournal(notebookId: string): void {
  cancelDraftJournal(notebookId);
  // 断线/bridge-lost：桌面版改由 Tauri 写；浏览器 dev 无写盘通道，草稿只在内存（O4）。
  if ((bridgeOffline() || tabBridgeLost(notebookId)) && !isTauri()) return;
  journalTimers.set(notebookId, setTimeout(() => {
    journalTimers.delete(notebookId);
    void writeDraftJournal(notebookId);
  }, DRAFT_JOURNAL_DEBOUNCE_MS));
}

/**
 * 去抖后仍未保存的草稿才写日志：只发持久 cell 的 id/code，不含输出、计数或 REPL。
 * 在线由 bridge 写（指纹取 bridge 记录，O6）；断线或 bridge-lost 时由 Tauri 命令
 * write_draft_journal 写同格式文件，指纹取本 tab 最后确认的 baselineSha256（O3）。
 */
async function writeDraftJournal(notebookId: string): Promise<void> {
  const offline = bridgeOffline() || tabBridgeLost(notebookId);
  if (offline && !isTauri()) return;
  const cache = owningCache(notebookId);
  if (!cache || Object.keys(cache.drafts).length === 0) return;
  const cells = cache.cells
    .filter((c) => c.kind !== 'repl' && c.id !== REPL_CELL_ID)
    .map((c) => ({ id: c.id, code: cache.drafts[c.id]?.code ?? c.code }));
  const dirtyCellIds = Object.keys(cache.drafts).filter((id) => cells.some((c) => c.id === id));
  if (dirtyCellIds.length === 0) return;
  try {
    if (offline) {
      const tab = useNotebooks.getState().tabs.find((t) => t.notebookId === notebookId);
      if (!tab) return;
      await invoke('write_draft_journal', {
        notebookPath: tab.path, baselineSha256: tab.baselineSha256 ?? null, cells, dirtyCellIds,
      });
    } else {
      await bridge.rpc('draft.write', { notebookId, cells, dirtyCellIds });
    }
    useNotebooks.getState().setDraftJournaled(notebookId, true);
    useNotebooks.getState().setDraftJournalError(notebookId);
  } catch (err) {
    // Tauri 命令以字符串报错；bridge 以 -32602 报超限。
    const message = typeof err === 'string' ? err : String(asRecord(err).message ?? '');
    const tooLarge = /limit/.test(message) && (offline || asRecord(err).code === -32602);
    if (tooLarge) useNotebooks.getState().setDraftJournalError(notebookId, '草稿超过 2 MB，未写入恢复日志（仍保留在本页）');
    else console.error(offline ? 'write_draft_journal 失败:' : 'draft.write 失败:', err);
  }
}

/** 成功写盘后：待决提示降级为"磁盘已变"；写过日志且已无草稿 → 清日志（Owner：保存成功即删除）。 */
function afterSuccessfulSave(notebookId: string, draftsLeft: number): void {
  const nb = useNotebooks.getState();
  const offer = nb.tabs.find((t) => t.notebookId === notebookId)?.draftRecovery;
  if (offer) {
    if (offer.baselineMatches) nb.setDraftRecovery(notebookId, { ...offer, baselineMatches: false });
    return;
  }
  if (draftsLeft > 0 || !nb.tabs.find((t) => t.notebookId === notebookId)?.draftJournaled) return;
  nb.setDraftJournaled(notebookId, false);
  cancelDraftJournal(notebookId);
  void bridge.rpc('draft.clear', { notebookId }).catch((err: unknown) => console.error('draft.clear 失败:', err));
}

function sanitizeOffer(raw: unknown): DraftRecoveryOffer | undefined {
  const r = asRecord(raw);
  if (typeof r.draftId !== 'string' || !Array.isArray(r.cells) || !Array.isArray(r.dirtyCellIds)) return undefined;
  const cells = (r.cells as unknown[]).map(asRecord)
    .filter((c) => typeof c.id === 'string' && typeof c.code === 'string')
    .map((c) => ({ id: c.id as string, code: c.code as string }));
  return {
    draftId: r.draftId,
    savedAt: typeof r.savedAt === 'string' ? r.savedAt : '',
    baselineMatches: r.baselineMatches === true,
    dirtyCellIds: (r.dirtyCellIds as unknown[]).filter((id): id is string => typeof id === 'string'),
    cells,
  };
}
const saveTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();
const saveQueues = new Map<string, Promise<void>>();
const pendingSaves = new Map<string, Map<string, { revision: number | undefined; code: string; promise: Promise<void> }>>();

function cancelSaveTimer(notebookId: string, cellId?: string): void {
  const timers = saveTimers.get(notebookId);
  if (!timers) return;
  if (cellId !== undefined) {
    const timer = timers.get(cellId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(cellId);
  } else {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }
  if (timers.size === 0) saveTimers.delete(notebookId);
}

/** Always capture from the focus only when it belongs to this request's notebook. */
function owningCache(notebookId: string): NotebookCache | undefined {
  const nb = useNotebooks.getState();
  if (!nb.tabs.some((t) => t.notebookId === notebookId)) return undefined;
  return nb.activeId === notebookId ? captureCache() : nb.readCache(notebookId);
}

function writeCache(notebookId: string, cache: NotebookCache): void {
  const nb = useNotebooks.getState();
  if (!nb.tabs.some((t) => t.notebookId === notebookId)) return;
  nb.saveCache(notebookId, cache);
  nb.markDirty(notebookId, Object.keys(cache.drafts).length > 0);
  if (nb.activeId === notebookId && !useNotebook.getState().historyView) hydrateCache(cache);
}

function errorFileConflict(err: unknown, notebookPath: string): FileConflict | undefined {
  const error = asRecord(err);
  const data = asRecord(error.data);
  if (error.code !== -32002 || data.kind !== 'external-modification' || data.notebookPath !== notebookPath) return;
  return {
    notebookPath,
    recoveryPath: typeof data.recoveryPath === 'string' ? data.recoveryPath : null,
    ...(typeof data.recoveryError === 'string' ? { recoveryError: data.recoveryError } : {}),
  };
}

function pauseForConflict(notebookId: string, conflict: FileConflict): void {
  const nb = useNotebooks.getState();
  const tab = nb.tabs.find((t) => t.notebookId === notebookId);
  if (!tab || tab.path !== conflict.notebookPath) return;
  cancelSaveTimer(notebookId);
  const cache = owningCache(notebookId);
  if (cache) nb.saveCache(notebookId, cache);
  nb.setConflict(notebookId, { ...tab.conflict, ...conflict });
}

function saveError(notebookId: string, err: unknown): void {
  const nb = useNotebooks.getState();
  const tab = nb.tabs.find((t) => t.notebookId === notebookId);
  if (!tab) return;
  const conflict = errorFileConflict(err, tab.path);
  if (conflict) pauseForConflict(notebookId, conflict);
  else if (!tab.conflict) nb.setError(notebookId, { operation: 'save', message: err instanceof Error ? err.message : String(err) });
}

/** Request identity and sent draft revision are captured before the first await. */
function enqueueSave(notebookId: string, cellId: string, code: string): Promise<void> {
  if (useNotebooks.getState().tabs.find((t) => t.notebookId === notebookId)?.conflict) {
    return Promise.reject(new Error('文件有外部版本，请先保留本地副本并加载磁盘版本'));
  }
  // 断线或旧代 tab：草稿只留本地，不排队（新实例上的旧 notebookId 已失效，也没有基线）。
  if (bridgeOffline() || tabBridgeLost(notebookId)) {
    return Promise.reject(new BridgeDisconnectedError('bridge 未连接：草稿保留在本地，未保存'));
  }
  const cache = owningCache(notebookId);
  if (!cache || !cache.cells.some((c) => c.id === cellId)) return Promise.resolve();
  const draft = cache.drafts[cellId];
  const revision = draft?.code === code ? draft.revision : undefined;
  const analysisRevision = cache.draftRevision;
  const pending = pendingSaves.get(notebookId) ?? new Map();
  const existing = pending.get(cellId);
  if (existing?.revision === revision && existing?.code === code) return existing.promise;
  useNotebooks.getState().saveCache(notebookId, cache);

  const task = (saveQueues.get(notebookId) ?? Promise.resolve()).then(async () => {
    // A closed notebook must never be recreated by a leftover timer or ACK.
    if (!owningCache(notebookId)) return;
    if (useNotebooks.getState().tabs.find((t) => t.notebookId === notebookId)?.conflict) {
      throw new Error('文件有外部版本，请先保留本地副本并加载磁盘版本');
    }
    const res = await bridge.rpc<CellSaveResult>('cell.save', { notebookId, cellId, code });
    // D4：成功落盘即推进该 owner 的基线指纹（与草稿是否仍最新无关）。
    useNotebooks.getState().setBaseline(notebookId, res?.baselineSha256);
    const current = owningCache(notebookId);
    if (!current) return;
    let draftsLeft = -1;
    // A successful old save does not resolve an external conflict or confirm its draft.
    if (useNotebooks.getState().tabs.find((t) => t.notebookId === notebookId)?.conflict) return;
    const drafts = { ...current.drafts };
    if (revision !== undefined && drafts[cellId]?.revision === revision && drafts[cellId]?.code === code) {
      delete drafts[cellId];
    }
    const compileErrors = { ...current.compileErrors };
    const cellConfirmed = current.cells.find((c) => c.id === cellId)?.code === code &&
      (!current.drafts[cellId] || current.drafts[cellId].revision === revision);
    if (cellConfirmed) {
      if (res?.compileError) compileErrors[cellId] = res.compileError;
      else delete compileErrors[cellId];
    }
    let next: NotebookCache = { ...current, drafts, compileErrors };
    // DAG/stale describe the sent notebook code, never any unsaved local draft.
    if (Object.keys(drafts).length === 0 && current.draftRevision === analysisRevision && cellConfirmed) {
      const staleSet = res?.staleSet ?? current.staleSet;
      next = { ...next, dagEdges: res?.dagEdges ?? current.dagEdges, staleSet,
        cells: applyStaleSet(current.cells, staleSet) };
    }
    writeCache(notebookId, next);
    if (Object.keys(drafts).length === 0) useNotebooks.getState().setError(notebookId);
    draftsLeft = Object.keys(drafts).length;
    afterSuccessfulSave(notebookId, draftsLeft);
  }).catch((err: unknown) => {
    saveError(notebookId, err);
    throw err;
  });
  // A rejected save does not poison the FIFO; the caller still sees this failure.
  const tail = task.then(() => {}, () => {});
  saveQueues.set(notebookId, tail);
  pending.set(cellId, { revision, code, promise: task });
  pendingSaves.set(notebookId, pending);
  void tail.then(() => {
    if (saveQueues.get(notebookId) === tail) saveQueues.delete(notebookId);
    if (pending.get(cellId)?.promise === task) pending.delete(cellId);
    if (pending.size === 0) pendingSaves.delete(notebookId);
  });
  return task;
}

function scheduleCellSave(notebookId: string, cellId: string): void {
  cancelSaveTimer(notebookId, cellId);
  if (useNotebooks.getState().tabs.find((t) => t.notebookId === notebookId)?.conflict) return;
  if (bridgeOffline() || tabBridgeLost(notebookId)) return; // 草稿留本地；同实例重连后补发
  const timers = saveTimers.get(notebookId) ?? new Map();
  timers.set(cellId, setTimeout(() => {
    cancelSaveTimer(notebookId, cellId);
    const draft = owningCache(notebookId)?.drafts[cellId];
    if (draft) void enqueueSave(notebookId, cellId, draft.code).catch(() => {}); // error is visible on the owning tab
  }, CELL_SAVE_DEBOUNCE_MS));
  saveTimers.set(notebookId, timers);
}

async function flushNotebookSaves(notebookId: string): Promise<void> {
  cancelSaveTimer(notebookId);
  while (true) {
    const cache = owningCache(notebookId);
    if (!cache) return;
    if (useNotebooks.getState().tabs.find((t) => t.notebookId === notebookId)?.conflict) {
      throw new Error('文件有外部版本，请先保留本地副本并加载磁盘版本');
    }
    const drafts = Object.entries(cache.drafts);
    if (drafts.length === 0) {
      await saveQueues.get(notebookId);
      if (Object.keys(owningCache(notebookId)?.drafts ?? {}).length === 0) return;
    } else {
      const results = await Promise.allSettled(drafts.map(([cellId, draft]) => enqueueSave(notebookId, cellId, draft.code)));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
    // Retry button may flush while editing remains enabled; drain those new revisions too.
    cancelSaveTimer(notebookId);
  }
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
  historyView: false,
  bridgeConnected: false,
  bridgeStatus: 'idle',
  compileErrors: {},
  uiCollapsed: {},
  diffMarks: {},
  cascadeOverride: 'policy',
  lastRunMs: {},
  cascadeAsk: null,
  runConfirms: [],

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
          case 'notebook.externalChange': {
            const p = asRecord(params);
            if (typeof p.notebookId === 'string' && typeof p.notebookPath === 'string') {
              pauseForConflict(p.notebookId, { notebookPath: p.notebookPath, recoveryPath:
                useNotebooks.getState().tabs.find((t) => t.notebookId === p.notebookId)?.conflict?.recoveryPath ?? null });
            }
            break;
          }
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
            // 旧代 tab 的内核已随上一代 bridge 消失；新代的状态通知不属于它。
            if (tabBridgeLost(useNotebooks.getState().activeId)) break;
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
            set({ notebookPath: tab?.path ?? null, historyView: false });
            // Uncached focus must stop displaying the previous owner's runtime immediately.
            const cached = nb.readCache(id);
            hydrateCache(cached ?? emptyCache());
            set({ cascadeAsk: null });
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
          case 'agent.confirmRequest':
          case 'agent.confirmResolved':
            set({ runConfirms: applyRunConfirmEvent(get().runConfirms, method, params) });
            break;
          case 'diff.updated': {
            // P2.3 数据源：bridge 通知为收敛真源；本地 marks 只提升 proposed→edited-staged
            const merged = mergeDiffMarks(normalizeDiffs(params), get().diffMarks);
            set({ diffs: merged.diffs, diffMarks: merged.marks });
            break;
          }
        }
      });
      bridge.onStatus?.(handleBridgeStatus);
      set({ bridgeConnected: true, bridgeStatus: 'connected' });
    })();
    return connectPromise;
  },

  restoreDraft: (notebookId) => {
    const nb = useNotebooks.getState();
    const offer = nb.tabs.find((t) => t.notebookId === notebookId)?.draftRecovery;
    // 指纹不一致（或未知）时绝不叠加到磁盘版本上：只能保存为本地副本或丢弃。
    if (!offer?.baselineMatches) return;
    if (nb.activeId === notebookId && !get().historyView) nb.saveCache(notebookId, captureCache());
    const cache = owningCache(notebookId);
    if (!cache) return;
    const journal = new Map(offer.cells.map((c) => [c.id, c.code]));
    let revision = cache.draftRevision;
    const drafts = { ...cache.drafts };
    let cells = cache.cells;
    for (const cellId of offer.dirtyCellIds) {
      const code = journal.get(cellId);
      if (code === undefined || !cells.some((c) => c.id === cellId)) continue;
      revision += 1;
      drafts[cellId] = { code, revision };
      cells = patchCell(cells, cellId, (c) => ({ ...c, code }));
    }
    // 只回到本地草稿：不发 cell.save、不写磁盘；日志保留到下一次保存成功。
    writeCache(notebookId, { ...cache, cells, drafts, draftRevision: revision });
    nb.setDraftJournaled(notebookId, true);
    nb.setDraftRecovery(notebookId);
  },

  preserveDraft: async (notebookId) => {
    const nb = useNotebooks.getState();
    const offer = nb.tabs.find((t) => t.notebookId === notebookId)?.draftRecovery;
    if (!offer) return;
    try {
      const res = await bridge.rpc<{ recoveryPath?: unknown }>('draft.preserve', { notebookId, draftId: offer.draftId });
      if (typeof res?.recoveryPath !== 'string' || !res.recoveryPath) throw new Error('未返回本地副本路径');
      useNotebooks.getState().setRecoveryPath(notebookId, res.recoveryPath);
      useNotebooks.getState().setDraftRecovery(notebookId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(asRecord(err).message ?? err);
      useNotebooks.getState().setDraftRecovery(notebookId, { ...offer, error: `保存本地副本失败：${message}` });
    }
  },

  discardDraft: async (notebookId) => {
    const offer = useNotebooks.getState().tabs.find((t) => t.notebookId === notebookId)?.draftRecovery;
    if (!offer) return;
    try {
      await bridge.rpc('draft.clear', { notebookId });
      useNotebooks.getState().setDraftJournaled(notebookId, false);
      useNotebooks.getState().setDraftRecovery(notebookId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(asRecord(err).message ?? err);
      useNotebooks.getState().setDraftRecovery(notebookId, { ...offer, error: `丢弃失败：${message}` });
    }
  },

  reopenLostTab: async (notebookId) => {
    const nb = useNotebooks.getState();
    const tab = nb.tabs.find((t) => t.notebookId === notebookId);
    if (!tab?.bridgeLost || reopenInFlight.has(notebookId)) return;
    if (bridgeOffline()) {
      nb.setError(notebookId, { operation: 'reopen', message: 'bridge 未连接，稍后重试' });
      return;
    }
    // 重开会把焦点切到这个 tab：先保存当前焦点视图。
    if (nb.activeId && !get().historyView) nb.saveCache(nb.activeId, captureCache());
    reopenInFlight.add(notebookId);
    nb.setError(notebookId);
    try {
      const res = await bridge.rpc<NotebookStateResult>('notebook.open', { path: tab.path });
      const newId = typeof res?.notebookId === 'string' ? res.notebookId : null;
      if (!newId) throw new Error('notebook.open 未返回 notebookId');
      // owner 校验：等待期间 tab 被关闭/改键/重新编辑都不得被这次响应覆盖。
      const current = useNotebooks.getState().tabs.find((t) => t.notebookId === notebookId);
      if (!current?.bridgeLost || current.path !== tab.path) return;
      const latest = useNotebooks.getState().readCache(notebookId);
      const dirty = current.dirty || Object.keys(latest?.drafts ?? {}).length > 0;
      const state = res.state;
      const freshBaseline = typeof state?.baselineSha256 === 'string' ? state.baselineSha256 : undefined;
      if (dirty && latest) {
        // D4：草稿只能叠加在旧代最后确认的那份磁盘上；指纹不同或未知 = 断线期间磁盘可能被改过。
        const unchanged = !!current.baselineSha256 && current.baselineSha256 === freshBaseline;
        const local: NotebookCache = {
          ...latest,
          cells: latest.cells
            .filter((c) => c.kind !== 'repl')
            .map((c) => ({ ...c, execCount: null, output: null, status: 'idle' as const })),
          dagEdges: state?.dagEdges ?? [],
          staleSet: [],
          schemas: [],
          compileErrors: {},
          diffs: [],
          diffMarks: {},
          lastRunMs: {},
        };
        useNotebooks.getState().rekeyTab(notebookId, newId, local, freshBaseline ? { baselineSha256: freshBaseline } : {});
        // 内存草稿优先于磁盘上的旧日志；日志归新 id，保存成功后清除。
        useNotebooks.getState().setDraftJournaled(newId, true);
        useNotebooks.getState().setActive(newId);
        set({ notebookPath: tab.path, historyView: false, cascadeAsk: null, kernelState: 'live' });
        hydrateCache(local);
        await useNotebooks.getState().refreshList();
        if (unchanged) {
          for (const cellId of Object.keys(local.drafts)) scheduleCellSave(newId, cellId);
        } else {
          pauseForConflict(newId, { notebookPath: tab.path, recoveryPath: null });
        }
        return;
      }
      // 冷加载：只采用磁盘源码；旧输出/计数/Diff/REPL 随上一代内核一起作废。
      const cells = applyStaleSet(
        normalizeCells(state?.cells ?? []).map((c) => ({ ...c, execCount: null })),
        state?.staleSet ?? [],
      );
      const cold: NotebookCache = {
        ...emptyCache(),
        cells,
        dagEdges: state?.dagEdges ?? [],
        staleSet: state?.staleSet ?? [],
        schemas: state?.schemas ?? [],
        uiCollapsed: latest?.uiCollapsed ?? {},
        activeCellId: cells.some((c) => c.id === latest?.activeCellId) ? latest!.activeCellId : (cells[0]?.id ?? null),
      };
      const offer = sanitizeOffer((res as { draftRecovery?: unknown }).draftRecovery);
      useNotebooks.getState().rekeyTab(notebookId, newId, cold, {
        ...(freshBaseline ? { baselineSha256: freshBaseline } : {}),
        ...(offer ? { draftRecovery: offer } : {}),
      });
      // bridge 侧 notebook.open 已把焦点切到新 id：前端同步聚焦这个 tab。
      useNotebooks.getState().setActive(newId);
      set({ notebookPath: tab.path, historyView: false, cascadeAsk: null, kernelState: 'live' });
      hydrateCache(cold);
      await useNotebooks.getState().refreshList();
    } catch (err) {
      if (useNotebooks.getState().tabs.some((t) => t.notebookId === notebookId)) {
        useNotebooks.getState().setError(notebookId, {
          operation: 'reopen',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      reopenInFlight.delete(notebookId);
    }
  },

  retryBridge: async () => {
    if (isTauri()) {
      try {
        await invoke('restart_bridge');
      } catch (err) {
        console.warn('restart_bridge 失败（继续重连现有 bridge）:', err);
      }
    }
    await bridge.retry();
  },

  openNotebook: async (path) => {
    const nb = useNotebooks.getState();
    if (nb.activeId) nb.saveCache(nb.activeId, captureCache());
    // Only caches present before this open are real existing owners. Early focus
    // notifications may create an empty transition cache before the response arrives.
    const existingIds = new Set(Object.keys(useNotebooks.getState().caches));
    try {
      const res = await useNotebooks.getState().openRpc(path);
      const id = typeof res?.notebookId === 'string' ? res.notebookId : null;
      if (id) useNotebooks.getState().setBaseline(id, res?.state?.baselineSha256);
      const cached = id && existingIds.has(id) ? useNotebooks.getState().readCache(id) : undefined;
      const offer = sanitizeOffer(res?.draftRecovery);
      if (id && !cached && offer) useNotebooks.getState().setDraftRecovery(id, offer);
      const state = res?.state;
      const cells = applyStaleSet(normalizeCells(state?.cells ?? [], state?.execCounts), state?.staleSet ?? []);
      const ownerCache = cached ?? { ...emptyCache(), cells, dagEdges: state?.dagEdges ?? [],
        staleSet: state?.staleSet ?? [], schemas: state?.schemas ?? [], activeCellId: cells[0]?.id ?? null };
      set({ notebookPath: path, historyView: false, cascadeAsk: null });
      hydrateCache(ownerCache);
      if (id) useNotebooks.getState().saveCache(id, ownerCache);
      const tab = useNotebooks.getState().activeTab();
      set({ kernelState: tab ? mapKernelState(tab.kernelState) : 'connecting' });
      // Existing owner cache includes live UI preferences; a new owner hydrates its sidecar.
      if (!cached) {
        try {
          const ui = await bridge.rpc('ui.get', { path });
          if (useNotebooks.getState().activeId === id && get().notebookPath === path && !get().historyView) {
            get().hydrateUi(ui);
            if (id) useNotebooks.getState().saveCache(id, captureCache());
          }
        } catch (err) {
          console.error('ui.get 失败:', err);
        }
      }
    } catch (err) {
      console.error('notebook.open 失败:', err);
      set({ bridgeConnected: false });
    }
  },

  applyNotebookState: (payload) => {
    if (useNotebooks.getState().activeTab()?.conflict || useNotebooks.getState().activeTab()?.reloading) return;
    const p = asRecord(payload) as unknown as NotebookStatePayload;
    const incoming = applyStaleSet(normalizeCells(p.cells ?? [], p.execCounts), p.staleSet ?? []);
    const drafts = useNotebooks.getState().readCache(useNotebooks.getState().activeId ?? '')?.drafts ?? {};
    const cells = incoming.map((c) => {
      const draft = drafts[c.id];
      if (!draft) return c;
      return { ...(get().cells.find((old) => old.id === c.id) ?? c), code: draft.code };
    });
    // A stale full-state response may omit a locally edited cell as well as its code.
    for (const old of get().cells) {
      if (drafts[old.id] && !cells.some((c) => c.id === old.id)) cells.push(old);
    }
    const hasDrafts = Object.keys(drafts).length > 0;
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
      dagEdges: hasDrafts ? get().dagEdges : p.dagEdges ?? [],
      staleSet: hasDrafts ? get().staleSet : p.staleSet ?? [],
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
    if (activeWriteBlocked()) return;
    const cell = get().cells.find((c) => c.id === cellId);
    if (!cell || cell.code === code) return;
    set({ cells: patchCell(get().cells, cellId, (c) => ({ ...c, code })) });
    const id = useNotebooks.getState().activeId;
    if (!id) return;
    const cache = captureCache();
    const revision = cache.draftRevision + 1;
    writeCache(id, { ...cache, draftRevision: revision,
      drafts: { ...cache.drafts, [cellId]: { code, revision } } });
    scheduleCellSave(id, cellId);
    scheduleDraftJournal(id);
  },

  /** Immediate save keeps the public API; store-owned autosave uses the same FIFO. */
  saveCell: async (cellId, code) => {
    if (activeRuntimeBlocked() || useNotebooks.getState().activeTab()?.conflict) return;
    const id = useNotebooks.getState().activeId;
    if (!id) return;
    cancelSaveTimer(id, cellId);
    try {
      await enqueueSave(id, cellId, code);
    } catch (err) {
      console.error('cell.save 失败:', err); // owning tab already holds the visible, retryable error
    }
  },

  flushSaves: (notebookId) => flushNotebookSaves(notebookId),

  reloadFromDisk: async (notebookId) => {
    const nb = useNotebooks.getState();
    const tab = nb.tabs.find((t) => t.notebookId === notebookId);
    // History projections never initiate writes; background live tabs may recover explicitly.
    if (get().historyView || !tab?.conflict || tab.closing || tab.reloading) return;
    const local = owningCache(notebookId);
    if (!local) return;
    nb.saveCache(notebookId, local);
    nb.setReloading(notebookId, true);
    cancelSaveTimer(notebookId);
    try {
      // Existing saves settle, including failures, before the captured local source is backed up.
      await saveQueues.get(notebookId);
      const res = await bridge.rpc<NotebookStateResult & { recoveryPath: string }>('notebook.reload', {
        notebookId, cells: local.cells.filter((c) => c.kind !== 'repl').map((c) => ({ id: c.id, code: c.code })),
      });
      if (res?.notebookId !== notebookId || !res.state || typeof res.recoveryPath !== 'string') {
        throw new Error('加载外部版本的响应不完整，本地编辑仍保留');
      }
      const cells = normalizeCells(res.state.cells ?? []).map((c) => ({ ...c, execCount: null, output: null, status: 'idle' as const }));
      const fresh: NotebookCache = { ...emptyCache(), cells, dagEdges: res.state.dagEdges ?? [],
        activeCellId: cells.some((c) => c.id === local.activeCellId) ? local.activeCellId : cells[0]?.id ?? null,
        uiCollapsed: local.uiCollapsed };
      writeCache(notebookId, fresh);
      nb.setBaseline(notebookId, res.state.baselineSha256);
      nb.setConflict(notebookId);
      nb.setRecoveryPath(notebookId, res.recoveryPath);
      nb.setTabs(useNotebooks.getState().tabs.map((t) => t.notebookId === notebookId
        ? { ...t, kernelState: 'idle', ended: false, cellCount: cells.length } : t));
      if (useNotebooks.getState().activeId === notebookId && !get().historyView) set({ kernelState: 'live', cascadeAsk: null });
    } catch (err) {
      const current = useNotebooks.getState().tabs.find((t) => t.notebookId === notebookId)?.conflict ?? tab.conflict;
      const detail = errorFileConflict(err, tab.path);
      nb.setConflict(notebookId, { ...current!, ...detail,
        message: err instanceof Error ? err.message : String(err) });
    } finally {
      cancelSaveTimer(notebookId);
      nb.setReloading(notebookId, false);
    }
  },

  /**
   * 运行 cell（P2.4 级联接线）：cascade 参数 = cascadeOverride ?? decideStalePolicy。
   * 'ask' 档先弹 CascadeAskDialog（下游清单 + 侧效应徽章）等裁决；无下游时
   * 恒 cascade:false（决策没有意义，也不弹窗）。
   */
  runCell: async (cellId) => {
    if (activeRuntimeBlocked()) return; // view-only（ended tab）/ bridge 断线或旧代 tab 护栏
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
      set({ cells: patchCell(get().cells, cellId, (c) => ({ ...c, status: runFailureStatus(err) })) });
    }
  },

  /**
   * REPL：输出回灌为单一持久 [repl] cell（id='repl'，bridge 冻结契约）。
   * 首跑创建、后续运行清空其输出缓冲重新累积（run.started 亦带清空语义）。
   * 该 cell kind='repl' → CellHeader 显示 [repl] 徽章、不参与 DAG/stale。
   */
  runRepl: async (code) => {
    if (activeRuntimeBlocked()) return; // view-only（ended tab）/ bridge 断线或旧代 tab 护栏
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
      set({ cells: patchCell(get().cells, cellId, (c) => ({ ...c, status: runFailureStatus(err) })) });
    }
  },

  restartKernel: async (options) => {
    const nb = useNotebooks.getState();
    const ownerId = nb.activeId;
    const owner = ownerId ? nb.tabs.find((t) => t.notebookId === ownerId) : undefined;
    if (!ownerId || !owner || get().historyView) return;
    // 旧代 tab 的 notebookId 在新 bridge 上不存在：只能走冷重开（reopenLostTab）。
    if (owner.bridgeLost || bridgeOffline()) return;
    if (options?.allowLive && (owner.closing || owner.reloading || owner.conflict || owner.restarting || owner.ended || owner.kernelState === 'dead')) return;
    if (!options?.allowLive && (owner.closing || owner.reloading || owner.conflict || owner.restarting || (!owner.ended && owner.kernelState !== 'dead'))) return;
    const ownerCache = owningCache(ownerId);
    if (!ownerCache) return;
    if (!options?.allowLive && (owner.dirty || Object.keys(ownerCache.drafts).length > 0)) {
      nb.setError(ownerId, { operation: 'restart', message: '存在未保存改动，内核重启已阻止' });
      return;
    }
    if (!options?.allowLive && !canRestartTab(owner)) return;

    cancelSaveTimer(ownerId);
    nb.setRestarting(ownerId, true);
    nb.setError(ownerId);
    set({ kernelState: 'restarting' });
    try {
      await flushNotebookSaves(ownerId);
      const latest = owningCache(ownerId);
      const latestTab = useNotebooks.getState().tabs.find((t) => t.notebookId === ownerId);
      if (!latest || latestTab?.dirty || Object.keys(latest.drafts).length > 0) {
        throw new Error('存在未保存改动，内核重启已阻止');
      }
      const res = await bridge.rpc<NotebookRestartResult>('kernel.restart', { notebookId: ownerId });
      if (res?.notebookId !== ownerId || res.notebookPath !== owner.path || !res.state) {
        throw new Error('kernel.restart 响应的 notebook owner 不匹配');
      }
      const loaded = res.state;
      const cells = normalizeCells(loaded.cells ?? [], loaded.execCounts)
        .filter((cell) => cell.kind !== 'repl')
        .map((cell) => ({ ...cell, execCount: null, status: 'idle' as const, output: null }));
      const fresh: NotebookCache = {
        ...emptyCache(),
        cells,
        dagEdges: loaded.dagEdges ?? [],
        staleSet: loaded.staleSet ?? [],
        schemas: [],
        activeCellId: cells.some((c) => c.id === latest.activeCellId) ? latest.activeCellId : cells[0]?.id ?? null,
        uiCollapsed: latest.uiCollapsed,
      };
      writeCache(ownerId, fresh);
      useNotebooks.getState().setBaseline(ownerId, loaded.baselineSha256);
      useNotebooks.setState({ tabs: useNotebooks.getState().tabs.map((tab) => tab.notebookId === ownerId
        ? { ...tab, kernelState: 'idle', ended: false, dirty: false, error: undefined, restarting: false, cellCount: cells.length }
        : tab) });
      if (useNotebooks.getState().activeId === ownerId && !get().historyView) {
        set({ ...fresh, kernelState: 'live', notebookPath: owner.path, historyView: false, cascadeAsk: null });
      }
    } catch (err) {
      console.error('kernel.restart 失败:', err);
      const current = useNotebooks.getState().tabs.find((tab) => tab.notebookId === ownerId);
      useNotebooks.getState().setRestarting(ownerId, false);
      useNotebooks.getState().setError(ownerId, { operation: 'restart', message: err instanceof Error ? err.message : String(err) });
      if (current?.ended || current?.kernelState === 'dead' || !options?.allowLive) {
        useNotebooks.getState().setKernelState(ownerId, 'dead');
        if (useNotebooks.getState().activeId === ownerId) set({ kernelState: 'dead' });
      }
    } finally {
      useNotebooks.getState().setRestarting(ownerId, false);
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
    // 旧代 tab / 断线期间：bridge 不认识（或收不到）这个 id，只在本地切换焦点。
    let res: NotebookStateResult | null = null;
    if (tabBridgeLost(notebookId) || bridgeOffline()) nb.setActive(notebookId);
    else res = await nb.switchRpc(notebookId);
    if (res?.state) useNotebooks.getState().setBaseline(notebookId, res.state.baselineSha256);
    const tab = useNotebooks.getState().tabs.find((t) => t.notebookId === notebookId);
    if (tab) set({ notebookPath: tab.path, historyView: false });
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
    const tab = nb.tabs.find((t) => t.notebookId === notebookId);
    if (!tab || tab.closing || tab.reloading || tab.conflict) return;
    const cache = owningCache(notebookId);
    if (cache) nb.saveCache(notebookId, cache);
    if (tab.bridgeLost) {
      // 旧代 tab 在新 bridge 上没有 owner：clean 直接本地移除；有草稿则拒绝，绝不静默丢弃。
      if (tab.dirty || Object.keys(cache?.drafts ?? {}).length > 0) {
        nb.setError(notebookId, { operation: 'close', message: 'bridge 已重启：草稿未保存，未关闭' });
        return;
      }
      cancelSaveTimer(notebookId);
      const caches = { ...useNotebooks.getState().caches };
      delete caches[notebookId];
      const tabs = useNotebooks.getState().tabs.filter((t) => t.notebookId !== notebookId);
      const wasActive = useNotebooks.getState().activeId === notebookId;
      const nextActiveId = wasActive ? (tabs[0]?.notebookId ?? null) : useNotebooks.getState().activeId;
      useNotebooks.setState({ caches, tabs, activeId: nextActiveId });
      if (!wasActive) return;
      const nextTab = tabs.find((t) => t.notebookId === nextActiveId);
      if (nextTab) {
        set({ notebookPath: nextTab.path, historyView: false });
        hydrateCache(useNotebooks.getState().readCache(nextTab.notebookId) ?? emptyCache());
        set({ kernelState: mapKernelState(nextTab.kernelState) });
      } else {
        set({ notebookPath: null, historyView: false, ...emptyCache(), kernelState: 'connecting' });
      }
      return;
    }
    nb.setClosing(notebookId, true);
    nb.setError(notebookId);
    try {
      // Freeze this tab before awaiting: no accepted edit can be discarded during close.
      await flushNotebookSaves(notebookId);
      const { nextActiveId } = await nb.closeRpc(notebookId);
      cancelSaveTimer(notebookId);
      // Switching/opening during the close RPC must not replace the new focus view.
      if (get().notebookPath !== tab.path) return;
      if (nextActiveId) {
        const nextTab = useNotebooks.getState().tabs.find((t) => t.notebookId === nextActiveId);
        set({ notebookPath: nextTab?.path ?? null, historyView: false });
        const cached = useNotebooks.getState().readCache(nextActiveId);
        if (cached) hydrateCache(cached);
        set({ kernelState: nextTab ? mapKernelState(nextTab.kernelState) : 'connecting' });
      } else {
        set({ notebookPath: null, historyView: false, ...emptyCache(), kernelState: 'connecting' });
      }
    } catch (err) {
      cancelSaveTimer(notebookId);
      const conflict = errorFileConflict(err, tab.path);
      if (conflict) pauseForConflict(notebookId, conflict);
      else if (!useNotebooks.getState().tabs.find((t) => t.notebookId === notebookId)?.conflict) {
        nb.setError(notebookId, { operation: 'close', message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      nb.setClosing(notebookId, false);
    }
  },

  /* ---------------- P2.3 diff 审阅切片（spec §9 状态机） ---------------- */

  setCascadeOverride: (v) => set({ cascadeOverride: v }),
  resolveCascadeAsk: (run) => {
    const ask = get().cascadeAsk;
    set({ cascadeAsk: null });
    ask?.resolve(run);
  },
  answerRunConfirm: async (requestId, allow) => {
    set({ runConfirms: get().runConfirms.filter((r) => r.requestId !== requestId) });
    try {
      await bridge.rpc('agent.confirmResponse', { requestId, allow });
    } catch (err) {
      // 已超时 / 别的窗口先答 / 断线：bridge 侧已按「未执行」结算，这里只留日志
      console.warn('agent.confirmResponse 未生效:', err);
    }
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
    if (activeRuntimeBlocked() || useNotebooks.getState().activeTab()?.conflict) return; // view-only / 断线护栏
    const notebookId = useNotebooks.getState().activeId;
    const prev = get().diffs.find((d) => d.id === diffId);
    if (!prev || (prev.state !== 'proposed' && prev.state !== 'edited-staged')) return;
    set({ diffs: revertDiffState(get().diffs, diffId, 'accepted') });
    try {
      const res = await bridge.rpc<DiffAcceptResult>('diff.accept', { diffId });
      if (notebookId) useNotebooks.getState().setBaseline(notebookId, res?.baselineSha256);
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
      if (notebookId) {
        const tab = useNotebooks.getState().tabs.find((t) => t.notebookId === notebookId);
        const conflict = tab && errorFileConflict(err, tab.path);
        if (conflict) pauseForConflict(notebookId, conflict);
        const cache = owningCache(notebookId);
        if (cache) writeCache(notebookId, { ...cache, diffs: revertDiffState(cache.diffs, diffId, prev.state, acceptErrorText(err)) });
      } else set({ diffs: revertDiffState(get().diffs, diffId, prev.state, acceptErrorText(err)) });
    }
  },

  /** Reject（proposed/edited-staged → rejected）：乐观出队 + bridge diff.reject。 */
  rejectDiff: async (diffId) => {
    if (activeRuntimeBlocked()) return; // view-only（ended tab）/ bridge 断线或旧代 tab 护栏
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
    if (activeRuntimeBlocked()) return; // view-only（ended tab）/ bridge 断线或旧代 tab 护栏
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
    if (activeRuntimeBlocked()) return; // view-only（ended tab）/ bridge 断线或旧代 tab 护栏
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
