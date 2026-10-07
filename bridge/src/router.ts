/**
 * RpcRouter —— 前端 WS JSON-RPC 方法路由（spec §6.1，plan P1.3；P3.1 多 tab 多内核）。
 *
 * 职责：notebook 状态缓存、内核请求编排、diff 暂存队列（内存）、
 * session 事件落盘、内核通知转发（broadcast 注入，main.ts 发给所有 ws 客户端）。
 *
 * P3.1（intent S1 / A-2 #18）：从单 notebook 升级为多 notebook 并存——
 * - 每个已打开的 .py = 一个 NotebookContext（独立 supervisor/cache/session/diffs/outputs）；
 * - router 维护「焦点」notebook（focusId）；既有 cell.* / kernel.* / diff.* / agent.*
 *   一律作用于焦点上下文（语义不变）；
 * - 新增 notebook.list / notebook.switch / notebook.close（见 protocol.ts 冻结注释）；
 * - supervisor 经 SupervisorRegistry 管理：生产 MultiSupervisor（每 path 一进程保活），
 *   既有单测 SingleSupervisorRegistry（包装注入的单个 KernelSupervisor，替换语义）。
 * - 只有**焦点** notebook 的内核事件被广播（保持既有广播形状逐字兼容）；后台 notebook
 *   的内核事件仍刷新其 bridge 侧缓存，在 notebook.switch 响应里随全量 state 回灌前端。
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  ERR_INVALID_PARAMS,
  ERR_INVALID_REQUEST,
  ERR_INTERNAL,
  ERR_KERNEL,
  ERR_METHOD_NOT_FOUND,
  ERR_NO_NOTEBOOK,
  type CompileError,
  type DagEdge,
  type DiffAction,
  type FsEntry,
  type FsRootResult,
  type NotebookCloseResult,
  type NotebookOpenResult,
  type NotebookState,
  type NotebookSummary,
  type NotebookSwitchResult,
  type RpcRequest,
  type RpcResponse,
  type RunDoneParams,
  type RunReport,
  type SaveResult,
  type SessionEndReason,
  type SessionMeta,
  type SessionOpenResult,
  type SessionSnapshotCell,
  type SetCellsResult,
  type StagedDiff,
  type VarSchema,
} from './protocol';
import {
  KernelError,
  KernelSupervisor,
  MultiSupervisor,
  SingleSupervisorRegistry,
  type KernelCrashEvent,
  type KernelNotificationEvent,
  type KernelStatusEvent,
  type SupervisorRegistry,
} from './supervisor';
import type { SessionEventKind } from './session-log';
import { FsError, FsManager } from './fs';
import { SessionStore, type ActiveSession } from './session-store';
import { NotebookWatcher, type FsEventSource } from './watch';
import { UiStore, type NotebookUiState, type UiPatch } from './ui-store';
import { serializePreview, TRUNCATION_SUFFIX } from './preview';

/**
 * agent.cellOutput 每字段的截断上限（spec §7：8KB）。
 * 累积时即截（bound RSS），读取时对截断过的字段追加 TRUNCATION_SUFFIX。
 */
export const OUTPUT_CHAR_LIMIT = 8192;

/**
 * agent.cellOutput 缓存的 file-write 路径条数上限（P2.9）。
 * 内核侧同路径已去重、单次 exec 也限 50 条；bridge 侧再兜底一层，
 * 8KB 字符截断对路径列表不适用，改用条数封顶（bound RSS）。
 */
export const WRITES_PATH_LIMIT = 50;

/** 每 cell 最近一次 run 的输出缓冲（从内核 run.* 通知流累积）。 */
interface OutputBuffer {
  stdout: string;
  stderr: string;
  stdoutTrunc: boolean;
  stderrTrunc: boolean;
  traceback?: string;
  mimeKeys: string[];
  /** run.notify kind='file-write' 的路径（写入顺序，去重，≤WRITES_PATH_LIMIT）。 */
  writes: string[];
}

/** agent.cellOutput / get_cell_output 结果形状（spec §7）。 */
export interface CellOutputSnapshot {
  stdout: string;
  stderr: string;
  traceback: string | null;
  mimeKeys: string[];
  writes: string[];
}

/** agent.listCells 条目（spec §7 list_cells）。 */
export interface AgentCellSummary {
  id: string;
  execCount: number;
  status: 'stale' | 'error' | 'ok' | 'idle';
  firstLine: string;
  defs: string[];
  refs: string[];
}

/** agent.context 结果（spec §7 get_notebook_context；schemas 过 preview 截断出口）。 */
export interface AgentContext {
  dagEdges: DagEdge[];
  schemas: VarSchema[];
  focusCellId: string | null;
  staleSet: string[];
}

/** diff.stage 结果：正常入队 {diffId}，或编译预检拒绝 {rejected, reason}。 */
export type StageResult = { diffId: string } | { rejected: true; reason: CompileError };

/** diff.stage 编译预检用的临时 cell id（试探后随即回滚，不进缓存）。 */
const PRECHECK_CELL_ID = '__diff_precheck__';

/** 带 JSON-RPC 错误码的路由级异常。 */
export class RpcFault extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'RpcFault';
  }
}

/**
 * 一个已打开 notebook 的全部 router 侧状态（P3.1）。
 * 内核进程按「1 文件 = 1 进程」由 registry 保活；context 只持有其 supervisor 引用。
 */
interface NotebookContext {
  readonly notebookId: string;
  readonly path: string;
  readonly supervisor: KernelSupervisor;
  cache?: NotebookState;
  /** 当前内核生命周期的会话句柄（P2.8：事件按 sessionId 落 .novalab/sessions/）。 */
  session?: ActiveSession;
  diffs: StagedDiff[];
  diffSeq: number;
  /** 每 cell 最近一次 run 的输出缓存（agent.cellOutput / get_cell_output 用）。 */
  outputs: Map<string, OutputBuffer>;
  /** 内核已死 / 会话结束 → view-only（notebook.list 上报，前端灰化 tab）。 */
  ended: boolean;
}

export interface RouterDeps {
  /**
   * 单 supervisor（既有路由单测的注入点）：包装成 SingleSupervisorRegistry，
   * 所有 path 复用同一实例（单 notebook 替换语义）。与 multi 二选一。
   */
  supervisor?: KernelSupervisor;
  /**
   * 多内核注册表（生产 / 多 tab 测试）：每 path 惰性新建并保活一个 supervisor。
   * 传入即启用多 tab「追加」语义（notebook.open 同一路径 = 聚焦既有 tab）。
   */
  multi?: MultiSupervisor;
  /** 通知广播（bridge → 所有 ws 客户端）。 */
  broadcast: (method: string, params: unknown) => void;
  clock?: () => Date;
  /**
   * 文件事件源工厂（P1.8 热重载）。生产传 createChokidarEventSource；
   * 单测注入假事件源；**不传 = 不启用 watcher**（既有路由单测保持无 fs 监听）。
   */
  watcherFactory?: () => FsEventSource;
  /** watcher debounce（默认 300ms）/ 自写跳过窗口（默认 500ms），单测缩短用。 */
  watcherDebounceMs?: number;
  watcherSuppressMs?: number;
  /** UI sidecar 存储（默认新建 UiStore；单测注入以控制 debounce/flush）。 */
  uiStore?: UiStore;
  /** 工作区文件系统（默认新建 FsManager；单测注入）。 */
  fs?: FsManager;
  /** 会话存储（默认新建 SessionStore；单测注入以控制时钟）。 */
  sessionStore?: SessionStore;
}

const DIFF_ACTIONS = new Set<DiffAction>(['update', 'insert_below']);

export class RpcRouter {
  /** notebookId → 上下文（插入序 = 打开序，notebook.list 依此排列 tab）。 */
  private readonly contexts = new Map<string, NotebookContext>();
  /** resolved path → notebookId（同一路径重复 open 去重）。 */
  private readonly byPath = new Map<string, string>();
  /** 焦点 notebook（cell.* / kernel.* / diff.* / agent.* 的作用对象）。 */
  private focusId?: string;
  private readonly registry: SupervisorRegistry;
  /** 多 tab 追加语义（deps.multi 存在）；false = 单 notebook 替换语义（兼容既有单测）。 */
  private readonly multiMode: boolean;
  private readonly clock: () => Date;
  private readonly ui: UiStore;
  private readonly fs: FsManager;
  private readonly sessions: SessionStore;
  private readonly watcher?: NotebookWatcher;

  constructor(private readonly deps: RouterDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.ui = deps.uiStore ?? new UiStore();
    this.fs = deps.fs ?? new FsManager();
    this.sessions = deps.sessionStore ?? new SessionStore(this.clock);
    this.multiMode = deps.multi !== undefined;
    if (deps.multi) {
      this.registry = deps.multi;
    } else if (deps.supervisor) {
      this.registry = new SingleSupervisorRegistry(deps.supervisor);
    } else {
      throw new Error('RpcRouter 需要 deps.multi 或 deps.supervisor 之一');
    }
    if (deps.watcherFactory) {
      const factory = deps.watcherFactory;
      this.watcher = new NotebookWatcher({
        sourceFactory: factory,
        onExternalChange: (filePath) => this.externalReload(filePath),
        ...(deps.watcherDebounceMs !== undefined ? { debounceMs: deps.watcherDebounceMs } : {}),
        ...(deps.watcherSuppressMs !== undefined ? { suppressMs: deps.watcherSuppressMs } : {}),
      });
    }
    // 内核事件按 path 打标到达 → 路由到对应上下文；仅焦点上下文的 event 广播给前端。
    this.registry.on('kernel-status', (e: KernelStatusEvent) => this.onKernelStatus(e.path, e.params));
    this.registry.on('kernel-notification', (e: KernelNotificationEvent) =>
      this.onKernelEvent(e.path, e.method, e.params),
    );
    // P2.8：内核进程死亡 = 该 notebook 会话 ended（新会话在 restart 成功后开启）
    this.registry.on('kernel-crash', (e: KernelCrashEvent) => this.onKernelCrash(e.path));
  }

  /** 进程退场：全部会话快照落盘、停 watcher、ui.json 落盘（main.ts SIGINT/SIGTERM 调）。 */
  dispose(): void {
    for (const ctx of this.contexts.values()) this.endSession(ctx, 'shutdown');
    this.contexts.clear();
    this.byPath.clear();
    this.focusId = undefined;
    this.watcher?.close();
    this.ui.flush();
  }

  async handle(req: RpcRequest): Promise<RpcResponse> {
    try {
      const result = await this.dispatch(req.method, req.params);
      return { jsonrpc: '2.0', id: req.id, result };
    } catch (err) {
      return { jsonrpc: '2.0', id: req.id, error: toRpcError(err) };
    }
  }

  /**
   * in-process 方法入口（P2.6）：与 WS dispatch 同一路由，
   * 供 bridge/src/mcp/tools.ts 的 execute 实现调用（错误直接抛 RpcFault，不包 JSON-RPC 信封）。
   */
  invoke(method: string, params?: unknown): Promise<unknown> {
    return this.dispatch(method, params);
  }

  // ---------- dispatch ----------

  private async dispatch(method: string, rawParams: unknown): Promise<unknown> {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'ping':
        return { pong: Date.now() };
      case 'notebook.open':
        return this.notebookOpen(params);
      case 'notebook.list':
        return this.notebookList();
      case 'notebook.switch':
        return this.notebookSwitch(params);
      case 'notebook.close':
        return this.notebookClose(params);
      case 'cell.save':
        return this.cellSave(params);
      case 'cell.run':
        return this.cellRun(params);
      case 'kernel.vars':
        return this.kernelVars();
      case 'kernel.repl':
        return this.kernelRepl(params);
      case 'kernel.restart':
        return this.kernelRestart();
      case 'diff.stage':
        return this.diffStage(params);
      case 'diff.accept':
        return this.diffAccept(params);
      case 'diff.reject':
        return this.diffReject(params);
      case 'agent.context':
        return this.agentContext();
      case 'agent.listCells':
        return this.agentListCells();
      case 'agent.cellCode':
        return this.agentCellCode(params);
      case 'agent.cellOutput':
        return this.agentCellOutput(params);
      case 'ui.get':
        return this.uiGet(params);
      case 'ui.set':
        return this.uiSet(params);
      case 'fs.setRoot':
        return this.fsSetRoot(params);
      case 'fs.root':
        return this.fsRoot();
      case 'fs.list':
        return this.fsList(params);
      case 'fs.mkdir':
        return this.fsMkdir(params);
      case 'fs.rename':
        return this.fsRename(params);
      case 'fs.remove':
        return this.fsRemove(params);
      case 'fs.writeFile':
        return this.fsWriteFile(params);
      case 'session.list':
        return this.sessionList(params);
      case 'session.open':
        return this.sessionOpen(params);
      case 'export.ipynb':
        throw new RpcFault(ERR_INVALID_REQUEST, 'P3 feature');
      default:
        throw new RpcFault(ERR_METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  // ---------- notebook（P3.1 多 tab） ----------

  /**
   * notebook.open {path} → {notebookId, state}。
   * - 多 tab 模式：同一路径已打开 = 聚焦既有 tab（不重启内核，进程保活）；否则新建 context。
   * - 单 supervisor 兼容模式：替换语义——旧 notebook 会话 ended('switch') 后开新的（既有行为）。
   */
  private async notebookOpen(params: Record<string, unknown>): Promise<NotebookOpenResult> {
    const p = params['path'];
    if (typeof p !== 'string' || p.length === 0) {
      throw new RpcFault(ERR_INVALID_PARAMS, 'notebook.open 需要 {path: string}');
    }

    // 多 tab：已打开则直接聚焦返回（切回状态即在，不杀内核）
    const existing = this.ctxByPath(p);
    if (existing && this.multiMode) {
      this.setFocus(existing.notebookId);
      this.deps.broadcast('focus.changed', { notebookId: existing.notebookId });
      return { notebookId: existing.notebookId, state: this.snapshot(existing) };
    }

    // 单 supervisor 兼容：替换旧 notebook（会话 ended 'switch'）
    if (!this.multiMode) {
      for (const ctx of [...this.contexts.values()]) {
        this.endSession(ctx, 'switch');
        this.contexts.delete(ctx.notebookId);
        this.byPath.delete(path.resolve(ctx.path));
      }
    }

    const ctx = await this.spawnContext(p);
    // 默认工作区 root = 最近一次 notebook.open 的 dirname（fs.setRoot 可改）
    this.fs.setRootDefault(path.dirname(p));
    this.setFocus(ctx.notebookId);
    this.beginSession(ctx);
    if (this.multiMode) this.deps.broadcast('focus.changed', { notebookId: ctx.notebookId });
    return { notebookId: ctx.notebookId, state: this.snapshot(ctx) };
  }

  /** 建 context + 从 registry 取/建 supervisor + start（load_file）。失败回滚登记。 */
  private async spawnContext(p: string): Promise<NotebookContext> {
    const notebookId = `nb-${randomBytes(4).toString('hex')}`;
    const supervisor = this.registry.ensure(p);
    const ctx: NotebookContext = {
      notebookId,
      path: p,
      supervisor,
      diffs: [],
      diffSeq: 0,
      outputs: new Map(),
      ended: false,
    };
    this.contexts.set(notebookId, ctx);
    this.byPath.set(path.resolve(p), notebookId);
    // 先设焦点再 start：内核 start 期间的 kernel.status（restarting→idle）才能作为
    // 焦点事件广播给前端（与既有单 notebook 行为一致，状态 pill 不卡在 connecting）。
    this.setFocus(notebookId);
    try {
      const state = await supervisor.start(p);
      ctx.cache = normalizeState(state);
    } catch (err) {
      this.contexts.delete(notebookId);
      this.byPath.delete(path.resolve(p));
      // 回滚焦点到剩余上下文（多 tab）或清空（无可回退）
      this.focusId = this.contexts.keys().next().value as string | undefined;
      throw err;
    }
    return ctx;
  }

  /** notebook.list → 全部已打开 notebook 摘要（TabBar 数据源；含每内核 rssMB 水位）。 */
  private notebookList(): NotebookSummary[] {
    return [...this.contexts.values()].map((ctx) => {
      const state = ctx.supervisor.state;
      const ended = ctx.ended || state === 'dead';
      return {
        notebookId: ctx.notebookId,
        path: ctx.path,
        kernelState: state,
        cellCount: ctx.cache?.cells.length ?? 0,
        ...(ended ? { ended: true } : {}),
        rssMB: this.registry.rssMB(ctx.path),
      };
    });
  }

  /** notebook.switch {notebookId} → 切焦点 + 广播 focus.changed + 返回新焦点全量 state。 */
  private notebookSwitch(params: Record<string, unknown>): NotebookSwitchResult {
    const id = strParam(params, 'notebookId');
    const ctx = this.contexts.get(id);
    if (!ctx || !ctx.cache) {
      throw new RpcFault(ERR_INVALID_PARAMS, `unknown notebookId: ${id}`);
    }
    this.setFocus(id);
    this.deps.broadcast('focus.changed', { notebookId: id });
    return { notebookId: id, state: this.snapshot(ctx) };
  }

  /**
   * notebook.close {notebookId} → 未保存改动先 save_file → 会话 ended('shutdown') →
   * 内核 shutdown（进程退场）→ 摘除 tab。关焦点 tab 时把焦点转给下一个并广播 focus.changed。
   */
  private async notebookClose(params: Record<string, unknown>): Promise<NotebookCloseResult> {
    const id = strParam(params, 'notebookId');
    const ctx = this.contexts.get(id);
    if (!ctx) throw new RpcFault(ERR_INVALID_PARAMS, `unknown notebookId: ${id}`);

    // 未保存改动先 save_file（内核可能已死 → 忽略失败，仍继续关闭）
    if (ctx.cache) {
      try {
        await this.persistToDisk(ctx);
      } catch {
        /* 内核死 / 写盘失败：关闭流程不因此中断（会话快照仍落盘） */
      }
    }
    this.endSession(ctx, 'shutdown');
    try {
      ctx.supervisor.stop();
    } catch {
      /* 已停 */
    }
    this.registry.release(ctx.path);
    this.contexts.delete(id);
    this.byPath.delete(path.resolve(ctx.path));

    if (this.focusId === id) {
      const next = this.contexts.values().next().value as NotebookContext | undefined;
      this.focusId = next?.notebookId;
      if (next) {
        this.watcher?.watch(next.path);
        this.deps.broadcast('focus.changed', { notebookId: next.notebookId });
      } else {
        this.watcher?.unwatch();
      }
    }
    return { notebookId: id, closed: true };
  }

  /** 设焦点：更新 focusId + watcher 跟随焦点（后台 notebook 不热重载，见文件头遗留说明）。 */
  private setFocus(notebookId: string): void {
    this.focusId = notebookId;
    const ctx = this.contexts.get(notebookId);
    if (ctx) this.watcher?.watch(ctx.path);
  }

  /**
   * 外部改动 .py → 该 notebook 内核 load_file → 若为焦点则广播全量 notebook.state
   * （前端 applyNotebookState）+ session 留痕 external_reload。失败只记 stderr，保留旧缓存。
   */
  private async externalReload(filePath: string): Promise<void> {
    const ctx = this.ctxByPath(filePath);
    if (!ctx || !ctx.cache) return;
    try {
      const state = (await ctx.supervisor.request('load_file', { path: ctx.path })) as NotebookState;
      ctx.cache = normalizeState(state);
      if (this.isFocus(ctx)) this.deps.broadcast('notebook.state', this.snapshot(ctx));
      this.log(ctx, 'external_reload', undefined, path.resolve(filePath));
    } catch (err) {
      process.stderr.write(
        `[bridge] 外部变更重载失败（${filePath}）: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // ---------- 上下文定位 ----------

  private ctxByPath(p: string): NotebookContext | undefined {
    const id = this.byPath.get(path.resolve(p));
    return id ? this.contexts.get(id) : undefined;
  }

  private focusCtxOptional(): NotebookContext | undefined {
    return this.focusId ? this.contexts.get(this.focusId) : undefined;
  }

  private focusCtx(): NotebookContext {
    const ctx = this.focusCtxOptional();
    if (!ctx || !ctx.cache) {
      throw new RpcFault(ERR_NO_NOTEBOOK, '尚未打开 notebook（先调 notebook.open）');
    }
    return ctx;
  }

  private isFocus(ctx: NotebookContext): boolean {
    return this.focusId === ctx.notebookId;
  }

  private snapshot(ctx: NotebookContext): NotebookState {
    const c = ctx.cache;
    if (!c) throw new RpcFault(ERR_NO_NOTEBOOK, '尚未打开 notebook（先调 notebook.open）');
    return structuredClone({
      cells: c.cells,
      dagEdges: c.dagEdges,
      schemas: c.schemas,
      staleSet: c.staleSet,
      execCounts: c.execCounts,
    });
  }

  // ---------- cell ----------

  private async cellSave(params: Record<string, unknown>): Promise<SaveResult> {
    const ctx = this.focusCtx();
    const cache = ctx.cache!;
    const cellId = strParam(params, 'cellId');
    const code = strParam(params, 'code');
    const cell = cache.cells.find((c) => c.id === cellId);
    if (!cell) throw new RpcFault(ERR_INVALID_PARAMS, `unknown cellId: ${cellId}`);
    cell.code = code;
    const res = await this.applyCellsToKernel(ctx);
    this.log(ctx, 'save', cellId, `chars:${code.length}`);
    return {
      dagEdges: res.dagEdges,
      staleSet: res.staleSet,
      ...(res.compileError ? { compileError: res.compileError } : {}),
    };
  }

  private async cellRun(params: Record<string, unknown>): Promise<RunReport> {
    const ctx = this.focusCtx();
    const cache = ctx.cache!;
    const cellId = strParam(params, 'cellId');
    const cascade = params['cascade'] === true;
    if (!cache.cells.some((c) => c.id === cellId)) {
      throw new RpcFault(ERR_INVALID_PARAMS, `unknown cellId: ${cellId}`);
    }
    const report = (await ctx.supervisor.request('exec_cell', {
      cellId,
      cascade,
    })) as RunReport;
    this.settleRun(ctx, report);
    return report;
  }

  /** run 完成后：出 staleSet、落 session 事件（run | error）。 */
  private settleRun(ctx: NotebookContext, report: RunReport): void {
    const cache = ctx.cache!;
    const executed = new Set([report.cellId, ...report.cascaded]);
    cache.staleSet = cache.staleSet.filter((id) => !executed.has(id));
    const execRef = `exec:${cache.execCounts[report.cellId] ?? 0}`;
    if (report.ok) {
      this.log(ctx, 'run', report.cellId, execRef);
    } else {
      this.log(ctx, 'error', report.cellId, execRef);
    }
  }

  /** 全量 cells 推给内核 set_cells，并用返回值刷新缓存；随后落盘 .py（P1.8）。 */
  private async applyCellsToKernel(ctx: NotebookContext): Promise<SetCellsResult> {
    const cache = ctx.cache!;
    const res = (await ctx.supervisor.request('set_cells', {
      cells: cache.cells.map((c) => ({ id: c.id, code: c.code })),
    })) as SetCellsResult;
    if (res.cells) cache.cells = normalizeCells(res.cells);
    cache.dagEdges = res.dagEdges ?? [];
    cache.staleSet = res.staleSet ?? [];
    await this.persistToDisk(ctx);
    return res;
  }

  /**
   * cell.save / diff.accept / notebook.close 后把全量 cells 写回 .py（内核 save_file）。
   * 写盘前后各续一次自写跳过窗口：watcher 忽略写后 suppressMs 内的 fs 事件，
   * 防自己的保存触发热重载回环。
   */
  private async persistToDisk(ctx: NotebookContext): Promise<void> {
    const cache = ctx.cache;
    if (!cache) return;
    this.watcher?.markSelfWrite(ctx.path);
    try {
      await ctx.supervisor.request('save_file', {
        path: ctx.path,
        cells: cache.cells.map((c) => ({ id: c.id, code: c.code })),
      });
    } finally {
      this.watcher?.markSelfWrite(ctx.path);
    }
  }

  // ---------- kernel ----------

  private async kernelVars(): Promise<{ schemas: VarSchema[] }> {
    const ctx = this.focusCtx();
    const schemas = await this.introspectAndBroadcast(ctx);
    return { schemas };
  }

  /**
   * introspect → 刷新缓存 schemas → 若为焦点则广播 kernel.schemas（L-3）→ 返回新值。
   * 调用点：kernel.vars 显式请求（焦点，错误照常抛给 RPC 调用方）；run.done 通知后
   * 自动触发（调用侧 catch 落 stderr——刷新失败不打断执行主流程；后台 notebook 只更新缓存不广播）。
   */
  private async introspectAndBroadcast(ctx: NotebookContext): Promise<VarSchema[]> {
    const res = (await ctx.supervisor.request('introspect', {})) as {
      schemas?: VarSchema[];
    };
    const schemas = res.schemas ?? [];
    if (ctx.cache) ctx.cache.schemas = schemas;
    if (this.isFocus(ctx)) {
      this.deps.broadcast('kernel.schemas', { schemas: structuredClone(schemas) });
    }
    return schemas;
  }

  private async kernelRepl(params: Record<string, unknown>): Promise<RunReport> {
    const ctx = this.focusCtx();
    const code = strParam(params, 'code');
    const report = (await ctx.supervisor.request('exec_repl', { code })) as RunReport;
    this.log(ctx, 'repl', 'repl', `ok:${report.ok}`);
    return report;
  }

  private async kernelRestart(): Promise<NotebookState> {
    const ctx = this.focusCtx();
    // P2.8：restart = 当前会话 ended（写快照）+ 新内核生命周期开新会话
    this.endSession(ctx, 'restart');
    const state = await ctx.supervisor.restart();
    ctx.cache = normalizeState(state);
    ctx.ended = false;
    this.beginSession(ctx);
    return this.snapshot(ctx);
  }

  // ---------- diff（内存暂存队列，UI 在 P2） ----------

  /**
   * diff.stage：入队前做编译预检（spec §7 Reactive Rulebook 的机器侧保险）。
   * 把"应用该 diff 后的全量 cells"发给内核 set_cells 试探（纯静态分析，不执行）：
   * - compileError → 不入队，返回 {rejected:true, reason}，让模型自纠；
   * - 试探后无论成败都再 set_cells 回滚为原 cells。两次额外往返的成本可接受：
   *   set_cells 无执行开销，而拦下一个多重定义/环能让前端少弹一次无效审阅。
   * 预检不触碰 cache / 不落盘（直接 supervisor.request，绕开 applyCellsToKernel）。
   */
  private async diffStage(params: Record<string, unknown>): Promise<StageResult> {
    const ctx = this.focusCtx();
    const cache = ctx.cache!;
    const targetCellId = strParam(params, 'targetCellId');
    const action = params['action'];
    const newCode = strParam(params, 'newCode');
    if (typeof action !== 'string' || !DIFF_ACTIONS.has(action as DiffAction)) {
      throw new RpcFault(ERR_INVALID_PARAMS, `action 必须是 update|insert_below，收到: ${String(action)}`);
    }
    if (!cache.cells.some((c) => c.id === targetCellId)) {
      throw new RpcFault(ERR_INVALID_PARAMS, `unknown targetCellId: ${targetCellId}`);
    }

    // —— 编译预检：候选 cells 试探 + 无条件回滚 ——
    const original = cache.cells.map((c) => ({ id: c.id, code: c.code }));
    const candidate = buildCandidateCells(cache.cells, targetCellId, action as DiffAction, newCode);
    const probe = (await ctx.supervisor.request('set_cells', {
      cells: candidate,
    })) as SetCellsResult;
    await ctx.supervisor.request('set_cells', { cells: original });
    if (probe.compileError) {
      return { rejected: true, reason: probe.compileError };
    }

    const rationale = typeof params['rationale'] === 'string' ? params['rationale'] : undefined;
    const diff: StagedDiff = {
      diffId: `diff-${++ctx.diffSeq}`,
      targetCellId,
      action: action as DiffAction,
      newCode,
      ...(rationale !== undefined ? { rationale } : {}),
      status: 'proposed',
      createdAt: this.clock().toISOString(),
    };
    ctx.diffs.push(diff);
    this.emitDiffs(ctx);
    this.log(ctx, 'diff_proposed', targetCellId, diff.diffId);
    return { diffId: diff.diffId };
  }

  private async diffAccept(
    params: Record<string, unknown>,
  ): Promise<{ diffId: string; dagEdges: NotebookState['dagEdges']; staleSet: string[]; compileError?: CompileError; run?: RunReport }> {
    const ctx = this.focusCtx();
    const cache = ctx.cache!;
    const diff = this.requireDiff(ctx, strParam(params, 'diffId'));
    let runCellId = diff.targetCellId;
    if (diff.action === 'insert_below') {
      const idx = cache.cells.findIndex((c) => c.id === diff.targetCellId);
      if (idx < 0) throw new RpcFault(ERR_INVALID_PARAMS, `unknown targetCellId: ${diff.targetCellId}`);
      runCellId = randomBytes(4).toString('hex');
      cache.cells.splice(idx + 1, 0, {
        id: runCellId,
        code: diff.newCode,
        execCount: 0,
        defs: [],
        refs: [],
      });
      cache.execCounts[runCellId] = 0;
    } else {
      const cell = cache.cells.find((c) => c.id === diff.targetCellId);
      if (!cell) throw new RpcFault(ERR_INVALID_PARAMS, `unknown targetCellId: ${diff.targetCellId}`);
      cell.code = diff.newCode;
    }

    const saved = await this.applyCellsToKernel(ctx);
    diff.status = 'accepted';
    this.emitDiffs(ctx);
    this.log(ctx, 'diff_accepted', runCellId, diff.diffId);

    const out: { diffId: string; dagEdges: NotebookState['dagEdges']; staleSet: string[]; compileError?: CompileError; run?: RunReport } = {
      diffId: diff.diffId,
      dagEdges: saved.dagEdges,
      staleSet: saved.staleSet,
    };
    if (saved.compileError) {
      out.compileError = saved.compileError;
      return out; // 编译错不进运行队列（spec §12）
    }
    // accept = cell.save + cell.run cascade=false（Owner 裁决 mark-only）
    const report = (await ctx.supervisor.request('exec_cell', {
      cellId: runCellId,
      cascade: false,
    })) as RunReport;
    this.settleRun(ctx, report);
    out.run = report;
    return out;
  }

  private diffReject(params: Record<string, unknown>): { diffId: string; status: 'rejected' } {
    const ctx = this.focusCtx();
    const diff = this.requireDiff(ctx, strParam(params, 'diffId'));
    diff.status = 'rejected';
    this.emitDiffs(ctx);
    this.log(ctx, 'diff_rejected', diff.targetCellId, diff.diffId);
    return { diffId: diff.diffId, status: 'rejected' };
  }

  private requireDiff(ctx: NotebookContext, diffId: string): StagedDiff {
    const diff = ctx.diffs.find((d) => d.diffId === diffId);
    if (!diff || diff.status !== 'proposed') {
      throw new RpcFault(ERR_INVALID_PARAMS, `unknown or already-resolved diffId: ${diffId}`);
    }
    return diff;
  }

  private emitDiffs(ctx: NotebookContext): void {
    // diff 队列是焦点视图的一部分；仅焦点上下文的变更广播（后台 tab 的 diff 在切换时随 state 回灌）
    if (this.isFocus(ctx)) {
      this.deps.broadcast('diff.updated', { diffs: structuredClone(ctx.diffs) });
    }
  }

  // ---------- agent.*（P2.6/P2.7：前端 in-process 工具与 MCP server 共用，spec §7） ----------

  /** get_notebook_context：DAG 边 + schemas（过 preview 截断出口，spec §8）+ staleSet；无原始数据。 */
  private agentContext(): AgentContext {
    const ctx = this.focusCtx();
    const c = ctx.cache!;
    return {
      dagEdges: structuredClone(c.dagEdges),
      // 隐私边界（spec §8）：schemas 出进程前必过 PreviewSerializer 4KB 硬截断
      schemas: serializePreview(c.schemas) as VarSchema[],
      focusCellId: null,
      staleSet: [...c.staleSet],
    };
  }

  /** list_cells：全部 cell 的摘要（不含源码正文，只有首行）。 */
  private agentListCells(): AgentCellSummary[] {
    const ctx = this.focusCtx();
    const c = ctx.cache!;
    const stale = new Set(c.staleSet);
    return c.cells.map((cell) => {
      const firstLine = (cell.code.split('\n')[0] ?? '').trim();
      return {
        id: cell.id,
        execCount: cell.execCount,
        status: this.cellStatus(ctx, cell.id, cell.execCount, stale.has(cell.id)),
        firstLine: firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine,
        defs: [...cell.defs],
        refs: [...cell.refs],
      };
    });
  }

  private cellStatus(ctx: NotebookContext, id: string, execCount: number, isStale: boolean): AgentCellSummary['status'] {
    if (isStale) return 'stale';
    if (ctx.outputs.get(id)?.traceback !== undefined) return 'error';
    if (execCount > 0) return 'ok';
    return 'idle';
  }

  /** get_cell_code：源码原文（spec §7 白名单"代码文本"，不截断）。 */
  private agentCellCode(params: Record<string, unknown>): { cellId: string; code: string } {
    const ctx = this.focusCtx();
    const cache = ctx.cache!;
    const cellId = strParam(params, 'cellId');
    const cell = cache.cells.find((c) => c.id === cellId);
    if (!cell) throw new RpcFault(ERR_INVALID_PARAMS, `unknown cellId: ${cellId}`);
    return { cellId, code: cell.code };
  }

  /** get_cell_output：最近一次 run 的 stdout/stderr/traceback/mimeKeys/writes，字符字段截断 8KB、路径列表限 50 条。 */
  private agentCellOutput(params: Record<string, unknown>): CellOutputSnapshot {
    const ctx = this.focusCtx();
    const cache = ctx.cache!;
    const cellId = strParam(params, 'cellId');
    if (cellId !== 'repl' && !cache.cells.some((c) => c.id === cellId)) {
      throw new RpcFault(ERR_INVALID_PARAMS, `unknown cellId: ${cellId}`);
    }
    const buf = ctx.outputs.get(cellId);
    return {
      stdout: capOutput(buf?.stdout ?? '', buf?.stdoutTrunc ?? false),
      stderr: capOutput(buf?.stderr ?? '', buf?.stderrTrunc ?? false),
      traceback: buf?.traceback !== undefined ? capOutput(buf.traceback, false) : null,
      mimeKeys: buf ? [...buf.mimeKeys] : [],
      writes: buf ? [...buf.writes] : [],
    };
  }

  // ---------- ui sidecar（.novalab/ui.json，P1.8） ----------

  private uiGet(params: Record<string, unknown>): NotebookUiState {
    return this.ui.get(strParam(params, 'path'));
  }

  private uiSet(params: Record<string, unknown>): NotebookUiState {
    const notebookPath = strParam(params, 'path');
    const patch = params['patch'];
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new RpcFault(ERR_INVALID_PARAMS, 'ui.set 需要 {path: string, patch: object}');
    }
    return this.ui.set(notebookPath, patch as UiPatch);
  }

  // ---------- 内核事件侧效应（按 path 路由到上下文） ----------

  private onKernelStatus(p: string, params: { state: string; queueDepth: number }): void {
    const ctx = this.ctxByPath(p);
    if (!ctx) return;
    ctx.ended = params.state === 'dead' ? true : false;
    if (this.isFocus(ctx)) this.deps.broadcast('kernel.status', params);
  }

  private onKernelCrash(p: string): void {
    const ctx = this.ctxByPath(p);
    if (!ctx) return;
    ctx.ended = true;
    this.endSession(ctx, 'crash');
  }

  private onKernelEvent(p: string, method: string, params: unknown): void {
    const ctx = this.ctxByPath(p);
    if (!ctx) return;
    this.accumulateOutput(ctx, method, params);
    if (ctx.cache && method === 'run.done') {
      const rp = params as RunDoneParams;
      ctx.cache.execCounts[rp.cellId] = rp.execCount;
      const cell = ctx.cache.cells.find((c) => c.id === rp.cellId);
      if (cell) cell.execCount = rp.execCount;
      // L-3：run 完成后自动 introspect 并（焦点时）广播 kernel.schemas——前端 store.schemas
      // 随每次执行刷新。fire-and-forget：失败只落 stderr，不打断执行主流程。
      this.introspectAndBroadcast(ctx).catch((err: unknown) => {
        process.stderr.write(
          `[bridge] run.done 后自动 introspect 失败: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
    }
    // 仅焦点 notebook 的内核通知广播给前端（保持既有广播形状；后台在 switch 时随 state 回灌）
    if (this.isFocus(ctx)) this.deps.broadcast(method, params);
  }

  /**
   * 从内核 run.* 通知流累积每 cell 的"最近一次输出"（agent.cellOutput 数据源）。
   * run.started 重置缓冲；stdout/stderr/mime/error 增量写入；累积时即按 8KB 截断（bound RSS）。
   * 不依赖 cache —— repl（cellId="repl"）的输出也要能读。
   */
  private accumulateOutput(ctx: NotebookContext, method: string, params: unknown): void {
    const p = params as Record<string, unknown>;
    const cellId = typeof p['cellId'] === 'string' ? p['cellId'] : undefined;
    if (!cellId) return;
    switch (method) {
      case 'run.started':
        ctx.outputs.set(cellId, {
          stdout: '',
          stderr: '',
          stdoutTrunc: false,
          stderrTrunc: false,
          mimeKeys: [],
          writes: [],
        });
        return;
      case 'run.stdout':
      case 'run.stderr': {
        const buf = this.ensureOutputBuffer(ctx, cellId);
        const text = typeof p['text'] === 'string' ? p['text'] : '';
        if (method === 'run.stdout') {
          const r = appendCapped(buf.stdout, text);
          buf.stdout = r.value;
          buf.stdoutTrunc = buf.stdoutTrunc || r.truncated;
        } else {
          const r = appendCapped(buf.stderr, text);
          buf.stderr = r.value;
          buf.stderrTrunc = buf.stderrTrunc || r.truncated;
        }
        return;
      }
      case 'run.mime': {
        const buf = this.ensureOutputBuffer(ctx, cellId);
        const mime = typeof p['mime'] === 'string' ? p['mime'] : undefined;
        if (mime && !buf.mimeKeys.includes(mime)) buf.mimeKeys.push(mime);
        return;
      }
      case 'run.error': {
        const buf = this.ensureOutputBuffer(ctx, cellId);
        const tb = typeof p['traceback'] === 'string' ? p['traceback'] : String(p['traceback'] ?? '');
        buf.traceback = tb.length > OUTPUT_CHAR_LIMIT ? tb.slice(0, OUTPUT_CHAR_LIMIT) + TRUNCATION_SUFFIX : tb;
        return;
      }
      case 'run.notify': {
        // P2.9 写事件：kind='file-write' 的 path 进缓存（agent.cellOutput.writes）。
        // 透传前端由 onKernelEvent 的焦点广播统一完成，这里只做累积。
        if (p['kind'] !== 'file-write') return;
        const wpath = p['path'];
        if (typeof wpath !== 'string' || wpath === '') return;
        const buf = this.ensureOutputBuffer(ctx, cellId);
        if (buf.writes.length >= WRITES_PATH_LIMIT || buf.writes.includes(wpath)) return;
        buf.writes.push(wpath);
        return;
      }
      default:
        return; // run.done 等：缓冲保留为"最近一次"，无需动作
    }
  }

  private ensureOutputBuffer(ctx: NotebookContext, cellId: string): OutputBuffer {
    let buf = ctx.outputs.get(cellId);
    if (!buf) {
      buf = { stdout: '', stderr: '', stdoutTrunc: false, stderrTrunc: false, mimeKeys: [], writes: [] };
      ctx.outputs.set(cellId, buf);
    }
    return buf;
  }

  private log(ctx: NotebookContext, kind: SessionEventKind, cellId?: string, payloadRef?: string): void {
    ctx.session?.append({
      kind,
      actor: 'user',
      ...(cellId !== undefined ? { cellId } : {}),
      ...(payloadRef !== undefined ? { payloadRef } : {}),
    });
  }

  // ---------- 会话生命周期（P2.8，intent M9） ----------

  /** 开新会话（内核生命周期起点）：index 追加 live 条目 + 广播 session.started。 */
  private beginSession(ctx: NotebookContext): void {
    const session = this.sessions.begin({
      notebookDir: path.dirname(ctx.path),
      notebookPath: ctx.path,
      cellCount: ctx.cache?.cells.length ?? 0,
    });
    ctx.session = session;
    this.deps.broadcast('session.started', {
      sessionId: session.id,
      startedAt: session.startedAt,
      notebookPath: ctx.path,
    });
  }

  /**
   * 结束一个 notebook 的当前会话：snapshot.json（cells 全量 + 输出缓冲摘要）+ index.endedAt
   * + 广播 session.ended。无活跃会话时 no-op。落盘失败只记 stderr（审计降级不崩主流程）。
   */
  private endSession(ctx: NotebookContext, reason: SessionEndReason): void {
    const session = ctx.session;
    if (!session) return;
    ctx.session = undefined;
    try {
      const meta = this.sessions.end(session, this.snapshotCells(ctx), reason);
      this.deps.broadcast('session.ended', {
        sessionId: session.id,
        endedAt: meta.endedAt ?? this.clock().toISOString(),
        reason,
      });
    } catch (err) {
      process.stderr.write(
        `[bridge] 会话快照落盘失败（${session.id}）: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  /** 一个上下文 cache 的快照 cells（输出摘要取自 outputs 缓存，字段已在累积期 8KB 截断）。 */
  private snapshotCells(ctx: NotebookContext): SessionSnapshotCell[] {
    return (ctx.cache?.cells ?? []).map((c) => {
      const buf = ctx.outputs.get(c.id);
      return {
        id: c.id,
        code: c.code,
        execCount: c.execCount ?? 0,
        defs: [...c.defs],
        refs: [...c.refs],
        output: {
          stdout: capOutput(buf?.stdout ?? '', buf?.stdoutTrunc ?? false),
          stderr: capOutput(buf?.stderr ?? '', buf?.stderrTrunc ?? false),
          traceback: buf?.traceback ?? null,
          mimeKeys: buf ? [...buf.mimeKeys] : [],
          writes: buf ? [...buf.writes] : [],
        },
      };
    });
  }

  // ---------- fs.*（P2.8，工作区 root 监狱在 FsManager） ----------

  private fsSetRoot(params: Record<string, unknown>): FsRootResult {
    return { root: this.fs.setRoot(strParam(params, 'dir')) };
  }

  private fsRoot(): FsRootResult {
    return { root: this.fs.getRoot() };
  }

  private fsList(params: Record<string, unknown>): FsEntry[] {
    const dir = typeof params['dir'] === 'string' ? params['dir'] : '';
    return this.fs.list(dir);
  }

  private fsMkdir(params: Record<string, unknown>): { path: string } {
    return this.fs.mkdir(strParam(params, 'dir'));
  }

  private fsRename(params: Record<string, unknown>): { path: string } {
    return this.fs.rename(strParam(params, 'from'), strParam(params, 'to'));
  }

  private fsRemove(params: Record<string, unknown>): { removed: string } {
    return this.fs.remove(strParam(params, 'path'));
  }

  private fsWriteFile(params: Record<string, unknown>): { path: string } {
    return this.fs.writeFile(strParam(params, 'path'), strParam(params, 'content'));
  }

  // ---------- session.*（P2.8） ----------

  /** session.list：index.json 全量；live 条目的 cellCount 以焦点缓存为准。 */
  private sessionList(params: Record<string, unknown>): SessionMeta[] {
    const focus = this.focusCtxOptional();
    const nb =
      typeof params['notebookPath'] === 'string' && params['notebookPath'] !== ''
        ? params['notebookPath']
        : focus?.path;
    if (!nb) {
      throw new RpcFault(ERR_INVALID_PARAMS, 'session.list 需要 {notebookPath}（当前无已打开 notebook）');
    }
    const metas = this.sessions.list(path.dirname(nb));
    const liveId = focus?.session?.id;
    if (liveId && focus?.cache) {
      const live = metas.find((m) => m.id === liveId);
      if (live) live.cellCount = focus.cache.cells.length;
    }
    return metas;
  }

  /** session.open：历史会话 = snapshot 只读投影；live id = 焦点内存缓存现做投影（endedAt:null）。 */
  private sessionOpen(params: Record<string, unknown>): SessionOpenResult {
    const sessionId = strParam(params, 'sessionId');
    const focus = this.focusCtxOptional();
    const nb =
      typeof params['notebookPath'] === 'string' && params['notebookPath'] !== ''
        ? params['notebookPath']
        : focus?.path;
    if (!nb) {
      throw new RpcFault(ERR_INVALID_PARAMS, 'session.open 需要 {notebookPath}（当前无已打开 notebook）');
    }
    if (focus?.session && focus.session.id === sessionId) {
      return {
        sessionId,
        startedAt: focus.session.startedAt,
        endedAt: null,
        cells: this.snapshotCells(focus),
        readOnly: true,
      };
    }
    const found = this.sessions.open(path.dirname(nb), sessionId);
    if (!found) throw new RpcFault(ERR_INVALID_PARAMS, `unknown sessionId: ${sessionId}`);
    return {
      sessionId,
      startedAt: found.snapshot.startedAt,
      endedAt: found.snapshot.endedAt,
      cells: found.snapshot.cells,
      readOnly: true,
    };
  }
}

// ---------- helpers ----------

/** 8KB 截断读取：截过则追加 TRUNCATION_SUFFIX（spec §7 get_cell_output）。 */
function capOutput(s: string, truncated: boolean): string {
  return truncated ? s + TRUNCATION_SUFFIX : s;
}

/** 累积写入并按 OUTPUT_CHAR_LIMIT 封顶，返回是否发生截断。 */
function appendCapped(current: string, text: string): { value: string; truncated: boolean } {
  const next = current + text;
  if (next.length > OUTPUT_CHAR_LIMIT) {
    return { value: next.slice(0, OUTPUT_CHAR_LIMIT), truncated: true };
  }
  return { value: next, truncated: false };
}

/** diff.stage 编译预检：构造"应用该 diff 后的全量 cells"（insert_below 用临时 id）。 */
function buildCandidateCells(
  cells: NotebookState['cells'],
  targetCellId: string,
  action: DiffAction,
  newCode: string,
): { id: string; code: string }[] {
  const out: { id: string; code: string }[] = [];
  for (const c of cells) {
    if (action === 'update' && c.id === targetCellId) {
      out.push({ id: c.id, code: newCode });
    } else {
      out.push({ id: c.id, code: c.code });
    }
    if (action === 'insert_below' && c.id === targetCellId) {
      out.push({ id: PRECHECK_CELL_ID, code: newCode });
    }
  }
  return out;
}

function strParam(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== 'string') {
    throw new RpcFault(ERR_INVALID_PARAMS, `参数 ${key} 必须是 string`);
  }
  return v;
}

function normalizeCells(cells: NotebookState['cells']): NotebookState['cells'] {
  return cells.map((c) => ({
    id: c.id,
    code: c.code ?? '',
    execCount: c.execCount ?? 0,
    defs: c.defs ?? [],
    refs: c.refs ?? [],
    // L-2：内核 load_file/set_cells 回传的 sideEffect（spec §6.2 契约字段）必须保留，
    // 否则前端 CellHeader/CascadeAskDialog 的 ⚡ 徽章恒不显示。缺省视为 false。
    sideEffect: c.sideEffect === true,
  }));
}

function normalizeState(state: NotebookState): NotebookState {
  const cells = normalizeCells(state.cells ?? []);
  const execCounts: Record<string, number> = { ...(state.execCounts ?? {}) };
  for (const c of cells) {
    if (execCounts[c.id] === undefined) execCounts[c.id] = c.execCount;
  }
  return {
    cells,
    dagEdges: state.dagEdges ?? [],
    schemas: state.schemas ?? [],
    staleSet: state.staleSet ?? [],
    execCounts,
  };
}

export function toRpcError(err: unknown): { code: number; message: string } {
  if (err instanceof RpcFault) return { code: err.code, message: err.message };
  if (err instanceof FsError) return { code: err.code, message: err.message };
  if (err instanceof KernelError) return { code: err.code || ERR_KERNEL, message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  return { code: ERR_INTERNAL, message };
}
