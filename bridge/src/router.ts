/**
 * RpcRouter —— 前端 WS JSON-RPC 方法路由（spec §6.1，plan P1.3）。
 *
 * 职责：notebook 状态缓存、内核请求编排、diff 暂存队列（内存）、
 * session 事件落盘、内核通知转发（broadcast 注入，main.ts 发给所有 ws 客户端）。
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
  type NotebookState,
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
import { KernelError, KernelSupervisor } from './supervisor';
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

export interface RouterDeps {
  supervisor: KernelSupervisor;
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
  private cache?: NotebookState;
  private notebookPath?: string;
  /** 当前内核生命周期的会话句柄（P2.8：事件按 sessionId 落 .novalab/sessions/）。 */
  private session?: ActiveSession;
  private diffs: StagedDiff[] = [];
  private diffSeq = 0;
  /** 每 cell 最近一次 run 的输出缓存（agent.cellOutput / get_cell_output 用）。 */
  private outputs = new Map<string, OutputBuffer>();
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
    if (deps.watcherFactory) {
      const factory = deps.watcherFactory;
      this.watcher = new NotebookWatcher({
        sourceFactory: factory,
        onExternalChange: (filePath) => this.externalReload(filePath),
        ...(deps.watcherDebounceMs !== undefined ? { debounceMs: deps.watcherDebounceMs } : {}),
        ...(deps.watcherSuppressMs !== undefined ? { suppressMs: deps.watcherSuppressMs } : {}),
      });
    }
    deps.supervisor.on('status', (params) => deps.broadcast('kernel.status', params));
    deps.supervisor.on('notification', (n: { method: string; params?: unknown }) => {
      this.onKernelNotification(n.method, n.params);
      deps.broadcast(n.method, n.params);
    });
    // P2.8：内核进程死亡 = 当前会话 ended（新会话在 restart 成功后开启）
    deps.supervisor.on('crash', () => this.endSession('crash'));
  }

  /** 进程退场：会话快照落盘、停 watcher、ui.json 落盘（main.ts SIGINT/SIGTERM 调）。 */
  dispose(): void {
    this.endSession('shutdown');
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

  // ---------- notebook ----------

  private async notebookOpen(params: Record<string, unknown>): Promise<NotebookState> {
    const p = params['path'];
    if (typeof p !== 'string' || p.length === 0) {
      throw new RpcFault(ERR_INVALID_PARAMS, 'notebook.open 需要 {path: string}');
    }
    const state = await this.deps.supervisor.start(p);
    // P2.8：换 notebook = 旧会话 ended（旧 cache/outputs 仍在 → 快照完整），再开新会话
    this.endSession('switch');
    this.cache = normalizeState(state);
    this.notebookPath = p;
    // 默认工作区 root = 最近一次 notebook.open 的 dirname（fs.setRoot 可改）
    this.fs.setRootDefault(path.dirname(p));
    this.diffs = [];
    this.diffSeq = 0;
    this.outputs.clear();
    // P1.8 热重载：watch 新路径（内部先 unwatch 旧路径）
    this.watcher?.watch(p);
    this.beginSession(p);
    return this.snapshot();
  }

  /**
   * 外部改动 .py → 内核 load_file → 广播全量 notebook.state（前端 applyNotebookState）
   * + session 留痕 external_reload。失败只记 stderr，保留旧缓存（文件可能处于半保存态）。
   */
  private async externalReload(filePath: string): Promise<void> {
    if (!this.cache || !this.notebookPath) return;
    if (path.resolve(filePath) !== path.resolve(this.notebookPath)) return;
    try {
      const state = (await this.deps.supervisor.request('load_file', {
        path: this.notebookPath,
      })) as NotebookState;
      this.cache = normalizeState(state);
      this.deps.broadcast('notebook.state', this.snapshot());
      this.log('external_reload', undefined, filePath);
    } catch (err) {
      process.stderr.write(
        `[bridge] 外部变更重载失败（${filePath}）: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  private requireCache(): NotebookState {
    if (!this.cache || !this.notebookPath) {
      throw new RpcFault(ERR_NO_NOTEBOOK, '尚未打开 notebook（先调 notebook.open）');
    }
    return this.cache;
  }

  private snapshot(): NotebookState {
    const c = this.requireCache();
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
    const cache = this.requireCache();
    const cellId = strParam(params, 'cellId');
    const code = strParam(params, 'code');
    const cell = cache.cells.find((c) => c.id === cellId);
    if (!cell) throw new RpcFault(ERR_INVALID_PARAMS, `unknown cellId: ${cellId}`);
    cell.code = code;
    const res = await this.applyCellsToKernel();
    this.log('save', cellId, `chars:${code.length}`);
    return {
      dagEdges: res.dagEdges,
      staleSet: res.staleSet,
      ...(res.compileError ? { compileError: res.compileError } : {}),
    };
  }

  private async cellRun(params: Record<string, unknown>): Promise<RunReport> {
    const cache = this.requireCache();
    const cellId = strParam(params, 'cellId');
    const cascade = params['cascade'] === true;
    if (!cache.cells.some((c) => c.id === cellId)) {
      throw new RpcFault(ERR_INVALID_PARAMS, `unknown cellId: ${cellId}`);
    }
    const report = (await this.deps.supervisor.request('exec_cell', {
      cellId,
      cascade,
    })) as RunReport;
    this.settleRun(cache, report);
    return report;
  }

  /** run 完成后：出 staleSet、落 session 事件（run | error）。 */
  private settleRun(cache: NotebookState, report: RunReport): void {
    const executed = new Set([report.cellId, ...report.cascaded]);
    cache.staleSet = cache.staleSet.filter((id) => !executed.has(id));
    const execRef = `exec:${cache.execCounts[report.cellId] ?? 0}`;
    if (report.ok) {
      this.log('run', report.cellId, execRef);
    } else {
      this.log('error', report.cellId, execRef);
    }
  }

  /** 全量 cells 推给内核 set_cells，并用返回值刷新缓存；随后落盘 .py（P1.8）。 */
  private async applyCellsToKernel(): Promise<SetCellsResult> {
    const cache = this.requireCache();
    const res = (await this.deps.supervisor.request('set_cells', {
      cells: cache.cells.map((c) => ({ id: c.id, code: c.code })),
    })) as SetCellsResult;
    if (res.cells) cache.cells = normalizeCells(res.cells);
    cache.dagEdges = res.dagEdges ?? [];
    cache.staleSet = res.staleSet ?? [];
    await this.persistToDisk();
    return res;
  }

  /**
   * cell.save / diff.accept 后把全量 cells 写回 .py（内核 save_file）。
   * 写盘前后各续一次自写跳过窗口：watcher 忽略写后 suppressMs 内的 fs 事件，
   * 防自己的保存触发热重载回环。
   */
  private async persistToDisk(): Promise<void> {
    const cache = this.cache;
    const p = this.notebookPath;
    if (!cache || !p) return;
    this.watcher?.markSelfWrite(p);
    try {
      await this.deps.supervisor.request('save_file', {
        path: p,
        cells: cache.cells.map((c) => ({ id: c.id, code: c.code })),
      });
    } finally {
      this.watcher?.markSelfWrite(p);
    }
  }

  // ---------- kernel ----------

  private async kernelVars(): Promise<{ schemas: VarSchema[] }> {
    this.requireCache();
    const schemas = await this.introspectAndBroadcast();
    return { schemas };
  }

  /**
   * introspect → 刷新缓存 schemas → 广播 kernel.schemas（L-3）→ 返回新值。
   * 调用点：kernel.vars 显式请求（错误照常抛给 RPC 调用方）；run.done 通知后
   * 自动触发（调用侧 catch 落 stderr——刷新失败不打断执行主流程）。
   */
  private async introspectAndBroadcast(): Promise<VarSchema[]> {
    const res = (await this.deps.supervisor.request('introspect', {})) as {
      schemas?: VarSchema[];
    };
    const schemas = res.schemas ?? [];
    if (this.cache) this.cache.schemas = schemas;
    this.deps.broadcast('kernel.schemas', { schemas: structuredClone(schemas) });
    return schemas;
  }

  private async kernelRepl(params: Record<string, unknown>): Promise<RunReport> {
    this.requireCache();
    const code = strParam(params, 'code');
    const report = (await this.deps.supervisor.request('exec_repl', { code })) as RunReport;
    this.log('repl', 'repl', `ok:${report.ok}`);
    return report;
  }

  private async kernelRestart(): Promise<NotebookState> {
    this.requireCache();
    // P2.8：restart = 当前会话 ended（写快照）+ 新内核生命周期开新会话
    this.endSession('restart');
    const state = await this.deps.supervisor.restart();
    this.cache = normalizeState(state);
    if (this.notebookPath) this.beginSession(this.notebookPath);
    return this.snapshot();
  }

  // ---------- diff（内存暂存队列，UI 在 P2） ----------

  /**
   * diff.stage：入队前做编译预检（spec §7 Reactive Rulebook 的机器侧保险）。
   * 把"应用该 diff 后的全量 cells"发给内核 set_cells 试探（纯静态分析，不执行）：
   * - compileError → 不入队，返回 {rejected:true, reason}，让模型自纠；
   * - 试探后无论成败都再 set_cells 回滚为原 cells。两次额外往返的成本可接受：
   *   set_cells 无执行开销，而拦下一个多重定义/环能让前端少弹一次无效审阅。
   * 预检不触碰 this.cache / 不落盘（直接 supervisor.request，绕开 applyCellsToKernel）。
   */
  private async diffStage(params: Record<string, unknown>): Promise<StageResult> {
    const cache = this.requireCache();
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
    const probe = (await this.deps.supervisor.request('set_cells', {
      cells: candidate,
    })) as SetCellsResult;
    await this.deps.supervisor.request('set_cells', { cells: original });
    if (probe.compileError) {
      return { rejected: true, reason: probe.compileError };
    }

    const rationale = typeof params['rationale'] === 'string' ? params['rationale'] : undefined;
    const diff: StagedDiff = {
      diffId: `diff-${++this.diffSeq}`,
      targetCellId,
      action: action as DiffAction,
      newCode,
      ...(rationale !== undefined ? { rationale } : {}),
      status: 'proposed',
      createdAt: this.clock().toISOString(),
    };
    this.diffs.push(diff);
    this.emitDiffs();
    this.log('diff_proposed', targetCellId, diff.diffId);
    return { diffId: diff.diffId };
  }

  private async diffAccept(
    params: Record<string, unknown>,
  ): Promise<{ diffId: string; dagEdges: NotebookState['dagEdges']; staleSet: string[]; compileError?: CompileError; run?: RunReport }> {
    const cache = this.requireCache();
    const diff = this.requireDiff(strParam(params, 'diffId'));
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

    const saved = await this.applyCellsToKernel();
    diff.status = 'accepted';
    this.emitDiffs();
    this.log('diff_accepted', runCellId, diff.diffId);

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
    const report = (await this.deps.supervisor.request('exec_cell', {
      cellId: runCellId,
      cascade: false,
    })) as RunReport;
    this.settleRun(cache, report);
    out.run = report;
    return out;
  }

  private diffReject(params: Record<string, unknown>): { diffId: string; status: 'rejected' } {
    this.requireCache();
    const diff = this.requireDiff(strParam(params, 'diffId'));
    diff.status = 'rejected';
    this.emitDiffs();
    this.log('diff_rejected', diff.targetCellId, diff.diffId);
    return { diffId: diff.diffId, status: 'rejected' };
  }

  private requireDiff(diffId: string): StagedDiff {
    const diff = this.diffs.find((d) => d.diffId === diffId);
    if (!diff || diff.status !== 'proposed') {
      throw new RpcFault(ERR_INVALID_PARAMS, `unknown or already-resolved diffId: ${diffId}`);
    }
    return diff;
  }

  private emitDiffs(): void {
    this.deps.broadcast('diff.updated', { diffs: structuredClone(this.diffs) });
  }

  // ---------- agent.*（P2.6/P2.7：前端 in-process 工具与 MCP server 共用，spec §7） ----------

  /** get_notebook_context：DAG 边 + schemas（过 preview 截断出口，spec §8）+ staleSet；无原始数据。 */
  private agentContext(): AgentContext {
    const c = this.requireCache();
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
    const c = this.requireCache();
    const stale = new Set(c.staleSet);
    return c.cells.map((cell) => {
      const firstLine = (cell.code.split('\n')[0] ?? '').trim();
      return {
        id: cell.id,
        execCount: cell.execCount,
        status: this.cellStatus(cell.id, cell.execCount, stale.has(cell.id)),
        firstLine: firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine,
        defs: [...cell.defs],
        refs: [...cell.refs],
      };
    });
  }

  private cellStatus(id: string, execCount: number, isStale: boolean): AgentCellSummary['status'] {
    if (isStale) return 'stale';
    if (this.outputs.get(id)?.traceback !== undefined) return 'error';
    if (execCount > 0) return 'ok';
    return 'idle';
  }

  /** get_cell_code：源码原文（spec §7 白名单"代码文本"，不截断）。 */
  private agentCellCode(params: Record<string, unknown>): { cellId: string; code: string } {
    const cache = this.requireCache();
    const cellId = strParam(params, 'cellId');
    const cell = cache.cells.find((c) => c.id === cellId);
    if (!cell) throw new RpcFault(ERR_INVALID_PARAMS, `unknown cellId: ${cellId}`);
    return { cellId, code: cell.code };
  }

  /** get_cell_output：最近一次 run 的 stdout/stderr/traceback/mimeKeys/writes，字符字段截断 8KB、路径列表限 50 条。 */
  private agentCellOutput(params: Record<string, unknown>): CellOutputSnapshot {
    const cache = this.requireCache();
    const cellId = strParam(params, 'cellId');
    if (cellId !== 'repl' && !cache.cells.some((c) => c.id === cellId)) {
      throw new RpcFault(ERR_INVALID_PARAMS, `unknown cellId: ${cellId}`);
    }
    const buf = this.outputs.get(cellId);
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

  // ---------- 通知侧效应 ----------

  private onKernelNotification(method: string, params: unknown): void {
    this.accumulateOutput(method, params);
    if (!this.cache) return;
    if (method === 'run.done') {
      const p = params as RunDoneParams;
      this.cache.execCounts[p.cellId] = p.execCount;
      const cell = this.cache.cells.find((c) => c.id === p.cellId);
      if (cell) cell.execCount = p.execCount;
      // L-3：run 完成后自动 introspect 并广播 kernel.schemas——前端 store.schemas
      // 随每次执行刷新（FixCard 的"traceback + N schemas"附着不再恒 0）。
      // fire-and-forget：失败（内核重启中/已死）只落 stderr，不打断执行主流程。
      this.introspectAndBroadcast().catch((err: unknown) => {
        process.stderr.write(
          `[bridge] run.done 后自动 introspect 失败: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
    }
  }

  /**
   * 从内核 run.* 通知流累积每 cell 的"最近一次输出"（agent.cellOutput 数据源）。
   * run.started 重置缓冲；stdout/stderr/mime/error 增量写入；累积时即按 8KB 截断（bound RSS）。
   * 不依赖 this.cache —— repl（cellId="repl"）的输出也要能读。
   */
  private accumulateOutput(method: string, params: unknown): void {
    const p = params as Record<string, unknown>;
    const cellId = typeof p['cellId'] === 'string' ? p['cellId'] : undefined;
    if (!cellId) return;
    switch (method) {
      case 'run.started':
        this.outputs.set(cellId, {
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
        const buf = this.ensureOutputBuffer(cellId);
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
        const buf = this.ensureOutputBuffer(cellId);
        const mime = typeof p['mime'] === 'string' ? p['mime'] : undefined;
        if (mime && !buf.mimeKeys.includes(mime)) buf.mimeKeys.push(mime);
        return;
      }
      case 'run.error': {
        const buf = this.ensureOutputBuffer(cellId);
        const tb = typeof p['traceback'] === 'string' ? p['traceback'] : String(p['traceback'] ?? '');
        buf.traceback = tb.length > OUTPUT_CHAR_LIMIT ? tb.slice(0, OUTPUT_CHAR_LIMIT) + TRUNCATION_SUFFIX : tb;
        return;
      }
      case 'run.notify': {
        // P2.9 写事件：kind='file-write' 的 path 进缓存（agent.cellOutput.writes）。
        // 透传前端由构造函数里的 broadcast 统一完成，这里只做累积。
        if (p['kind'] !== 'file-write') return;
        const path = p['path'];
        if (typeof path !== 'string' || path === '') return;
        const buf = this.ensureOutputBuffer(cellId);
        if (buf.writes.length >= WRITES_PATH_LIMIT || buf.writes.includes(path)) return;
        buf.writes.push(path);
        return;
      }
      default:
        return; // run.done 等：缓冲保留为"最近一次"，无需动作
    }
  }

  private ensureOutputBuffer(cellId: string): OutputBuffer {
    let buf = this.outputs.get(cellId);
    if (!buf) {
      buf = { stdout: '', stderr: '', stdoutTrunc: false, stderrTrunc: false, mimeKeys: [], writes: [] };
      this.outputs.set(cellId, buf);
    }
    return buf;
  }

  private log(kind: SessionEventKind, cellId?: string, payloadRef?: string): void {
    this.session?.append({
      kind,
      actor: 'user',
      ...(cellId !== undefined ? { cellId } : {}),
      ...(payloadRef !== undefined ? { payloadRef } : {}),
    });
  }

  // ---------- 会话生命周期（P2.8，intent M9） ----------

  /** 开新会话（内核生命周期起点）：index 追加 live 条目 + 广播 session.started。 */
  private beginSession(notebookPath: string): void {
    const session = this.sessions.begin({
      notebookDir: path.dirname(notebookPath),
      notebookPath,
      cellCount: this.cache?.cells.length ?? 0,
    });
    this.session = session;
    this.deps.broadcast('session.started', {
      sessionId: session.id,
      startedAt: session.startedAt,
      notebookPath,
    });
  }

  /**
   * 结束当前会话：snapshot.json（cells 全量 + 输出缓冲摘要）+ index.endedAt
   * + 广播 session.ended。无活跃会话时 no-op。落盘失败只记 stderr（审计降级不崩主流程）。
   */
  private endSession(reason: SessionEndReason): void {
    const session = this.session;
    if (!session) return;
    this.session = undefined;
    try {
      const meta = this.sessions.end(session, this.snapshotCells(), reason);
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

  /** 当前 cache 的快照 cells（输出摘要取自 outputs 缓存，字段已在累积期 8KB 截断）。 */
  private snapshotCells(): SessionSnapshotCell[] {
    return (this.cache?.cells ?? []).map((c) => {
      const buf = this.outputs.get(c.id);
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

  /** session.list：index.json 全量；live 条目的 cellCount 以当前缓存为准。 */
  private sessionList(params: Record<string, unknown>): SessionMeta[] {
    const nb =
      typeof params['notebookPath'] === 'string' && params['notebookPath'] !== ''
        ? params['notebookPath']
        : this.notebookPath;
    if (!nb) {
      throw new RpcFault(ERR_INVALID_PARAMS, 'session.list 需要 {notebookPath}（当前无已打开 notebook）');
    }
    const metas = this.sessions.list(path.dirname(nb));
    const liveId = this.session?.id;
    if (liveId && this.cache) {
      const live = metas.find((m) => m.id === liveId);
      if (live) live.cellCount = this.cache.cells.length;
    }
    return metas;
  }

  /** session.open：历史会话 = snapshot 只读投影；live id = 内存缓存现做投影（endedAt:null）。 */
  private sessionOpen(params: Record<string, unknown>): SessionOpenResult {
    const sessionId = strParam(params, 'sessionId');
    const nb =
      typeof params['notebookPath'] === 'string' && params['notebookPath'] !== ''
        ? params['notebookPath']
        : this.notebookPath;
    if (!nb) {
      throw new RpcFault(ERR_INVALID_PARAMS, 'session.open 需要 {notebookPath}（当前无已打开 notebook）');
    }
    if (this.session && this.session.id === sessionId) {
      return {
        sessionId,
        startedAt: this.session.startedAt,
        endedAt: null,
        cells: this.snapshotCells(),
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
