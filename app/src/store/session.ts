/**
 * 会话 store（P2.8，intent M9 / spec 附录 A-2 #12-14/16）。
 *
 * 职责：
 * - 当前 live 会话 + 历史会话列表（bridge session.list / session.started|ended 通知驱动）；
 * - 只读历史视图：openHistory → session.open 快照替换主列表 cells + readOnly=true；
 *   backToLive → 还原 live 切片；
 * - 只读禁用矩阵：capabilityMatrix（纯函数，供 UI 消费）+ 对 notebook store
 *   写路径 action 的运行期护栏（readOnly 时 run/save/repl/diff/热重载全部 no-op，
 *   防 Ctrl+Enter、外部 .py 热重载广播等旁路改写历史视图或触碰已死内核）；
 * - 工作区 root 镜像（fs.root / fs.setRoot，sidebar 消费）。
 */

import { create } from 'zustand';
import { bridge } from '../bridge/client';
import { useNotebook } from './notebook';
import type { Cell } from '../kernel/types';

/* ------------------------------------------------------------------ */
/* bridge 协议投影（字段名与 bridge/src/protocol.ts 一致）                */
/* ------------------------------------------------------------------ */

export interface SessionMeta {
  id: string;
  startedAt: string;
  /** live 会话无 endedAt。 */
  endedAt?: string;
  cellCount: number;
  source: 'local' | 'agent';
}

/** session.open 快照 cell（输出为摘要：stdout/stderr 已截断、mime 仅键名、writes 为 P2.9 文件写入路径）。 */
export interface SessionSnapshotCell {
  id: string;
  code: string;
  execCount: number;
  defs: string[];
  refs: string[];
  output: {
    stdout: string;
    stderr: string;
    traceback: string | null;
    mimeKeys: string[];
    writes?: string[];
  };
}

export interface SessionOpenPayload {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  cells: SessionSnapshotCell[];
  readOnly: boolean;
}

/* ------------------------------------------------------------------ */
/* 纯函数（导出供 vitest；无 DOM/网络依赖）                               */
/* ------------------------------------------------------------------ */

/** 历史视图截断阈值（A-2 #14：First 500 cells shown…）。 */
export const SESSION_CELL_LIMIT = 500;

/** 只读模式禁用矩阵：readOnly=true 时全部写路径关闭（A-2 #12）。 */
export interface SessionCapabilities {
  editorReadOnly: boolean;
  runDisabled: boolean;
  replDisabled: boolean;
  diffDisabled: boolean;
  restartDisabled: boolean;
  viewOnly: boolean;
}

export function capabilityMatrix(readOnly: boolean): SessionCapabilities {
  return {
    editorReadOnly: readOnly,
    runDisabled: readOnly,
    replDisabled: readOnly,
    diffDisabled: readOnly,
    restartDisabled: readOnly,
    viewOnly: readOnly,
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 历史会话显示名 = startedAt（本地时区 `YYYY-MM-DD HH:MM`）。 */
export function sessionName(startedAt: Date): string {
  return `${startedAt.getFullYear()}-${pad2(startedAt.getMonth() + 1)}-${pad2(startedAt.getDate())} ${pad2(startedAt.getHours())}:${pad2(startedAt.getMinutes())}`;
}

/** 右侧 pill：`Ended HH:MM`（本地时区）。 */
export function endedLabel(endedAt: Date): string {
  return `Ended ${pad2(endedAt.getHours())}:${pad2(endedAt.getMinutes())}`;
}

/** 只读视图 footer 文案（A-2 #12 原文）。 */
export function viewOnlyFooter(endedAt: Date): string {
  return `Python · ended ${pad2(endedAt.getHours())}:${pad2(endedAt.getMinutes())} — view only; this kernel's namespace no longer exists`;
}

/** 截断横幅（A-2 #14 原文）；total ≤ 阈值 → null。 */
export function truncationBanner(total: number): string | null {
  if (total <= SESSION_CELL_LIMIT) return null;
  return `First ${SESSION_CELL_LIMIT} cells shown — full log in the session notebook's .ipynb download`;
}

/** 历史 cells 截断：shown 至多 SESSION_CELL_LIMIT，total 为截断前总数。 */
export function truncateHistory<T>(cells: readonly T[]): { shown: T[]; truncated: boolean; total: number } {
  return {
    shown: cells.slice(0, SESSION_CELL_LIMIT),
    truncated: cells.length > SESSION_CELL_LIMIT,
    total: cells.length,
  };
}

/** 快照 cell → 前端 Cell（traceback 视为 error 态；mime 摘要只有键名，不渲染数据）。 */
export function snapshotToCells(cells: readonly SessionSnapshotCell[]): Cell[] {
  return cells.map((c) => {
    const out = c.output;
    const hasOutput =
      !!out &&
      (out.stdout !== '' || out.stderr !== '' || out.traceback != null || (out.writes?.length ?? 0) > 0);
    return {
      id: c.id,
      code: c.code ?? '',
      execCount: c.execCount > 0 ? c.execCount : null,
      status: out?.traceback ? 'error' : 'idle',
      defs: c.defs ?? [],
      refs: c.refs ?? [],
      sideEffect: false,
      kind: 'code',
      output: hasOutput
        ? {
            stdout: out.stdout ?? '',
            stderr: out.stderr ?? '',
            mime: {},
            traceback: out.traceback ? { text: out.traceback, frames: [] } : null,
            writes: out.writes ?? [],
          }
        : null,
    };
  });
}

/** session.list 载荷宽容归一化（坏条目丢弃）。 */
export function normalizeSessionMetas(payload: unknown): SessionMeta[] {
  if (!Array.isArray(payload)) return [];
  const out: SessionMeta[] = [];
  for (const e of payload) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.startedAt !== 'string') continue;
    out.push({
      id: r.id,
      startedAt: r.startedAt,
      ...(typeof r.endedAt === 'string' ? { endedAt: r.endedAt } : {}),
      cellCount: typeof r.cellCount === 'number' ? r.cellCount : 0,
      source: r.source === 'agent' ? 'agent' : 'local',
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* P3.4 SessionModal：segments selector + export/import 降级             */
/* ------------------------------------------------------------------ */

/** 会话内子段切分阈值：>30min 间隔（spec §11 segments 定义）。 */
export const SEGMENT_GAP_MS = 30 * 60 * 1000;

/**
 * segment = 会话（SessionModal 分组单位）。若提供会话内时间戳序列
 * （timestampsBySession：事件级 ts，如未来 session.tail 接线），相邻间隔
 * >gapMs 时在会话内再切子段（parts>1，partStarts 携带各子段起点）；
 * 无时间戳 → 恒 parts=1（快照 cells 不带 ts，宽容退化）。
 */
export interface SessionSegment {
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  cellCount: number;
  source: 'local' | 'agent';
  /** live = 无 endedAt。 */
  live: boolean;
  parts: number;
  /** 各子段起点 ISO 时间（长度 = parts；首元素 = 会话内首个有效 ts 或 startedAt）。 */
  partStarts: string[];
}

/** 纯函数 selector：sessions（+ 可选会话内 ts）→ 段落列表（最新在前，与 SessionMenu 同序）。 */
export function buildSegments(
  sessions: readonly SessionMeta[],
  timestampsBySession?: Readonly<Record<string, readonly string[]>>,
  gapMs: number = SEGMENT_GAP_MS,
): SessionSegment[] {
  const ordered = [...sessions].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return ordered.map((m) => {
    const live = m.endedAt === undefined;
    const ts = (timestampsBySession?.[m.id] ?? [])
      .map((t) => ({ iso: t, ms: Date.parse(t) }))
      .filter((t) => Number.isFinite(t.ms))
      .sort((a, b) => a.ms - b.ms);
    const partStarts: string[] = [];
    if (ts.length > 0) {
      partStarts.push(ts[0]!.iso);
      for (let i = 1; i < ts.length; i++) {
        if (ts[i]!.ms - ts[i - 1]!.ms > gapMs) partStarts.push(ts[i]!.iso);
      }
    }
    return {
      sessionId: m.id,
      startedAt: m.startedAt,
      ...(m.endedAt !== undefined ? { endedAt: m.endedAt } : {}),
      cellCount: m.cellCount,
      source: m.source,
      live,
      parts: Math.max(1, partStarts.length),
      partStarts: partStarts.length > 0 ? partStarts : [m.startedAt],
    };
  });
}

/** modal 头部计数：`N sessions · M cells` 的数据源。 */
export function modalSummary(sessions: readonly SessionMeta[]): { sessionCount: number; cellCount: number } {
  return {
    sessionCount: sessions.length,
    cellCount: sessions.reduce((n, s) => n + (Number.isFinite(s.cellCount) ? s.cellCount : 0), 0),
  };
}

/**
 * rpc 失败是否为「接线 pending」（P3.1 合入前 export.ipynb 回 -32600 "P3 feature"，
 * import.ipynb 未注册回 -32601 "method not found: …"）。BridgeClient 把服务端
 * error.message 包成 Error（code 丢失），故按 message 特征识别；接线后自然消失。
 */
export function isWiringPending(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /P3 feature/i.test(msg) || /method not found/i.test(msg) || /-32600|-32601/.test(msg);
}

/** export/import 按钮的状态机（降级不 throw，全部落 store 供 UI 渲染）。 */
export type TransferStatus = 'idle' | 'working' | 'ok' | 'pending-wiring' | 'error';

export interface TransferState {
  status: TransferStatus;
  message: string | null;
  /** 成功产物路径（export → .ipynb；import → .py）。 */
  path: string | null;
  /** import 降级警告（magic/outputs/markdown）。 */
  warnings: string[];
}

export const idleTransfer: TransferState = { status: 'idle', message: null, path: null, warnings: [] };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? '');
}

/** rpc 失败 → TransferState 的统一降级（wiring pending / 其他 error）。 */
export function degradeTransfer(err: unknown): TransferState {
  if (isWiringPending(err)) {
    return { status: 'pending-wiring', message: '接线 pending —— bridge router 尚未接通（P3.1 合入后生效）', path: null, warnings: [] };
  }
  return { status: 'error', message: errText(err), path: null, warnings: [] };
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

/** live 视图备份（openHistory 前捕获，backToLive 还原；模块级，不进响应式状态）。 */
type LiveBackup = Pick<
  ReturnType<typeof useNotebook.getState>,
  'cells' | 'dagEdges' | 'staleSet' | 'schemas' | 'compileErrors' | 'diffs' | 'diffMarks' | 'activeCellId' | 'cascadeAsk'
>;
let liveBackup: LiveBackup | null = null;

interface SessionStore {
  /** 工作区 root（bridge fs.getRoot 镜像；null = bridge 未设置）。 */
  root: string | null;
  sessions: SessionMeta[];
  /** 当前 live 会话（session.started 通知 / session.list 驱动）。 */
  currentId: string | null;
  currentStartedAt: string | null;
  /** live 会话已 ended（crash/shutdown）且尚未开新会话 → 右 pill `Ended HH:MM`。 */
  currentEndedAt: string | null;
  /** 只读历史视图态。 */
  readOnly: boolean;
  viewingId: string | null;
  viewingEndedAt: string | null;
  /** 历史快照截断前 cell 总数（横幅阈值判断）。 */
  historyTotal: number;

  /* ---- P3.4 SessionModal ---- */
  modalOpen: boolean;
  /** 展开会话的快照缓存（session.open → 截断后 cells + 截断前 total）。 */
  snapshotLoading: Record<string, boolean>;
  snapshotCells: Record<string, SessionSnapshotCell[]>;
  snapshotTotals: Record<string, number>;
  /** export.ipynb / import.ipynb 按钮状态（含接线 pending 降级）。 */
  exportState: TransferState;
  importState: TransferState;

  syncRoot: () => Promise<void>;
  setRootDir: (dir: string) => Promise<void>;
  refreshSessions: (notebookPath?: string) => Promise<void>;
  /** 选历史会话 → 只读模式（cells 替换 + readOnly=true + 写路径护栏生效）。 */
  openHistory: (sessionId: string) => Promise<void>;
  /** 回到 live 会话（还原备份切片，readOnly=false）。 */
  backToLive: () => Promise<void>;
  onStarted: (p: { sessionId?: string; startedAt?: string; notebookPath?: string }) => void;
  onEnded: (p: { sessionId?: string; endedAt?: string }) => void;

  /* ---- P3.4 SessionModal actions ---- */
  openModal: () => void;
  closeModal: () => void;
  /** 展开会话时惰性拉快照（已缓存则跳过；live 会话由 router 内存投影兜底）。 */
  loadSnapshot: (sessionId: string) => Promise<void>;
  /** 导出会话 .ipynb（export.ipynb rpc；-32600/-32601 → pending-wiring 降级）。 */
  exportIpynb: (sessionId?: string | null) => Promise<void>;
  /** 导入 .ipynb → 成功后 openNotebook 新 .py（import.ipynb rpc；同样降级）。 */
  importNotebook: (sourcePath: string, targetPath?: string) => Promise<boolean>;
}

/** 最近一次已知 notebook 路径（session.* 通知不带路径时的 fallback）。 */
let lastNotebookPath: string | null = null;

export const useSession = create<SessionStore>((set, get) => ({
  root: null,
  sessions: [],
  currentId: null,
  currentStartedAt: null,
  currentEndedAt: null,
  readOnly: false,
  viewingId: null,
  viewingEndedAt: null,
  historyTotal: 0,
  modalOpen: false,
  snapshotLoading: {},
  snapshotCells: {},
  snapshotTotals: {},
  exportState: idleTransfer,
  importState: idleTransfer,

  syncRoot: async () => {
    try {
      const res = await bridge.rpc<{ root: string | null }>('fs.root');
      set({ root: res?.root ?? null });
    } catch {
      /* bridge 未连接：保持 null，sidebar 显示空态 */
    }
  },

  setRootDir: async (dir) => {
    try {
      const res = await bridge.rpc<{ root: string | null }>('fs.setRoot', { dir });
      set({ root: res?.root ?? null });
    } catch (err) {
      console.error('fs.setRoot 失败:', err);
    }
  },

  refreshSessions: async (notebookPath) => {
    const nb = notebookPath ?? useNotebook.getState().notebookPath;
    if (!nb) return;
    lastNotebookPath = nb;
    try {
      const metas = await bridge.rpc<unknown>('session.list', { notebookPath: nb });
      const sessions = normalizeSessionMetas(metas);
      // live 条目（无 endedAt）= 当前会话；与通知驱动字段互相校准
      const live = sessions.find((m) => m.endedAt === undefined);
      set({
        sessions,
        ...(live ? { currentId: live.id, currentStartedAt: live.startedAt, currentEndedAt: null } : {}),
      });
    } catch (err) {
      console.error('session.list 失败:', err);
    }
  },

  openHistory: async (sessionId) => {
    const nb = useNotebook.getState().notebookPath ?? lastNotebookPath;
    if (!nb) return;
    let res: SessionOpenPayload;
    try {
      res = await bridge.rpc<SessionOpenPayload>('session.open', { sessionId, notebookPath: nb });
    } catch (err) {
      console.error('session.open 失败:', err);
      return;
    }
    if (!liveBackup) liveBackup = captureLive();
    const cells = snapshotToCells(res.cells ?? []);
    const { shown, total } = truncateHistory(cells);
    // 历史视图 = 只读投影：DAG/stale/编译错/diff 队列全部清空（backToLive 还原）
    useNotebook.setState({
      cells: shown,
      dagEdges: [],
      staleSet: [],
      compileErrors: {},
      diffs: [],
      diffMarks: {},
      cascadeAsk: null,
      activeCellId: shown[0]?.id ?? null,
    });
    set({
      readOnly: true,
      viewingId: sessionId,
      viewingEndedAt: res.endedAt,
      historyTotal: total,
    });
  },

  backToLive: async () => {
    const backup = liveBackup;
    liveBackup = null;
    if (backup) useNotebook.setState(backup);
    set({
      readOnly: false,
      viewingId: null,
      viewingEndedAt: null,
      historyTotal: 0,
    });
  },

  /* ---- P3.4 SessionModal ---- */

  openModal: () => {
    set({ modalOpen: true, exportState: idleTransfer, importState: idleTransfer });
    void get().refreshSessions();
  },

  closeModal: () => set({ modalOpen: false }),

  loadSnapshot: async (sessionId) => {
    const s = get();
    if (s.snapshotCells[sessionId] || s.snapshotLoading[sessionId]) return; // 已缓存/在途
    const nb = useNotebook.getState().notebookPath ?? lastNotebookPath;
    if (!nb) return;
    set({ snapshotLoading: { ...get().snapshotLoading, [sessionId]: true } });
    try {
      const res = await bridge.rpc<SessionOpenPayload>('session.open', { sessionId, notebookPath: nb });
      const cells = res?.cells ?? [];
      const { shown, total } = truncateHistory(cells);
      set({
        snapshotLoading: { ...get().snapshotLoading, [sessionId]: false },
        snapshotCells: { ...get().snapshotCells, [sessionId]: shown },
        snapshotTotals: { ...get().snapshotTotals, [sessionId]: total },
      });
    } catch (err) {
      console.error('session.open（SessionModal 快照）失败:', err);
      set({
        snapshotLoading: { ...get().snapshotLoading, [sessionId]: false },
        snapshotCells: { ...get().snapshotCells, [sessionId]: [] },
        snapshotTotals: { ...get().snapshotTotals, [sessionId]: 0 },
      });
    }
  },

  exportIpynb: async (sessionId) => {
    const st = get();
    const nb = useNotebook.getState().notebookPath ?? lastNotebookPath;
    const sid = sessionId ?? st.viewingId ?? st.currentId;
    if (!nb || !sid) {
      set({ exportState: { ...idleTransfer, status: 'error', message: '无可导出会话（尚未打开 notebook 或无 live 会话）' } });
      return;
    }
    set({ exportState: { ...idleTransfer, status: 'working' } });
    try {
      // 接线契约（P3.1 后 orchestrator 接）：{path, sessionId} → exporter.exportIpynb
      const res = await bridge.rpc<{ path?: string; nbCells?: number; nbOutputs?: number }>('export.ipynb', {
        path: nb,
        sessionId: sid,
      });
      const p = typeof res?.path === 'string' ? res.path : null;
      set({
        exportState: {
          status: 'ok',
          message: `已导出 ${p ?? '.ipynb'}（${res?.nbCells ?? '?'} cells · ${res?.nbOutputs ?? '?'} outputs）`,
          path: p,
          warnings: [],
        },
      });
    } catch (err) {
      set({ exportState: degradeTransfer(err) }); // -32600/-32601 → pending-wiring（tooltip「接线 pending」）
    }
  },

  importNotebook: async (sourcePath, targetPath) => {
    if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
      set({ importState: { ...idleTransfer, status: 'error', message: '输入 .ipynb 路径后再导入' } });
      return false;
    }
    set({ importState: { ...idleTransfer, status: 'working' } });
    try {
      // 接线契约（P3.1 后 orchestrator 接）：{path, targetPath?} → importer.importIpynb
      const res = await bridge.rpc<{ path?: string; cells?: unknown[]; warnings?: string[] }>('import.ipynb', {
        path: sourcePath.trim(),
        ...(targetPath ? { targetPath } : {}),
      });
      const p = res?.path;
      if (typeof p !== 'string' || p === '') throw new Error('import.ipynb 响应缺少 path');
      const warnings = Array.isArray(res?.warnings) ? res.warnings.filter((w): w is string => typeof w === 'string') : [];
      await useNotebook.getState().openNotebook(p); // 成功 → 打开新 .py（只读视图自动退出）
      set({
        importState: {
          status: 'ok',
          message: `已导入 ${p}（${warnings.length} 条降级警告）`,
          path: p,
          warnings,
        },
      });
      return true;
    } catch (err) {
      set({ importState: degradeTransfer(err) });
      return false;
    }
  },

  onStarted: (p) => {
    if (typeof p.sessionId !== 'string') return;
    if (typeof p.notebookPath === 'string') lastNotebookPath = p.notebookPath;
    set({
      currentId: p.sessionId,
      currentStartedAt: typeof p.startedAt === 'string' ? p.startedAt : new Date().toISOString(),
      currentEndedAt: null,
    });
    void get().refreshSessions(lastNotebookPath ?? undefined);
  },

  onEnded: (p) => {
    if (typeof p.sessionId !== 'string') return;
    const endedAt = typeof p.endedAt === 'string' ? p.endedAt : new Date().toISOString();
    // 只有当前 live 会话结束才影响右 pill；历史视图不受干扰
    if (p.sessionId === get().currentId) set({ currentEndedAt: endedAt });
    void get().refreshSessions(lastNotebookPath ?? undefined);
  },
}));

function captureLive(): LiveBackup {
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
    cascadeAsk: s.cascadeAsk,
  };
}

/* ------------------------------------------------------------------ */
/* 只读护栏：包装 notebook store 的全部写路径 action                      */
/*                                                                     */
/* UI 层（CellEditor/运行钮/REPL）按 capabilityMatrix 禁用；这里再兜一层   */
/* 运行期护栏，覆盖绕过 UI 的入口：App 的 Ctrl+Enter 全局快捷键、外部 .py   */
/* 热重载的 notebook.state 广播、ui.get 水合、残留的 save debounce 定时器。 */
/* ------------------------------------------------------------------ */

function blocked(): boolean {
  return useSession.getState().readOnly;
}

function installReadOnlyGuards(): void {
  const orig = useNotebook.getState();
  useNotebook.setState({
    setCellCode: (cellId, code) => {
      if (!blocked()) orig.setCellCode(cellId, code);
    },
    saveCell: async (cellId, code) => {
      if (!blocked()) return orig.saveCell(cellId, code);
    },
    runCell: async (cellId) => {
      if (!blocked()) return orig.runCell(cellId);
    },
    runRepl: async (code) => {
      if (!blocked()) return orig.runRepl(code);
    },
    restartKernel: async () => {
      if (!blocked()) return orig.restartKernel();
    },
    acceptDiff: async (diffId) => {
      if (!blocked()) return orig.acceptDiff(diffId);
    },
    rejectDiff: async (diffId) => {
      if (!blocked()) return orig.rejectDiff(diffId);
    },
    rejectAllPending: async () => {
      if (!blocked()) return orig.rejectAllPending();
    },
    reStageDiff: async (diffId, newCode) => {
      if (!blocked()) return orig.reStageDiff(diffId, newCode);
    },
    // 历史视图期间外部 .py 变更 / ui sidecar 不得冲掉只读投影
    applyNotebookState: (payload) => {
      if (!blocked()) orig.applyNotebookState(payload);
    },
    hydrateUi: (payload) => {
      if (!blocked()) orig.hydrateUi(payload);
    },
    // 打开新 notebook 前自动退出历史视图（备份直接丢弃——即将整体替换）
    openNotebook: async (p) => {
      if (useSession.getState().readOnly) {
        liveBackup = null;
        await useSession.getState().backToLive();
      }
      return orig.openNotebook(p);
    },
  });
}

installReadOnlyGuards();

/** bridge 通知接线：session.started / session.ended → store（连接前后均可注册）。 */
bridge.onNotification((method, params) => {
  const p = (params ?? {}) as Record<string, unknown>;
  if (method === 'session.started') {
    useSession.getState().onStarted({
      sessionId: p.sessionId as string | undefined,
      startedAt: p.startedAt as string | undefined,
      notebookPath: p.notebookPath as string | undefined,
    });
  } else if (method === 'session.ended') {
    useSession.getState().onEnded({
      sessionId: p.sessionId as string | undefined,
      endedAt: p.endedAt as string | undefined,
    });
  }
});
