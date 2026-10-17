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
  type KernelCompileError,
  type DagEdge,
  type DiffAction,
  type FsEntry,
  type FsRootResult,
  type NotebookCloseResult,
  type NotebookOpenResult,
  type NotebookReloadResult,
  type NotebookRestartResult,
  type NotebookState,
  type NotebookSummary,
  type NotebookSwitchResult,
  type ProviderKind,
  type ProviderSummary,
  type ProvidersDeleteResult,
  type ProvidersListResult,
  type ProvidersSetActiveResult,
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
  type DiffVerification,
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
import { ProvidersStore, ProvidersStoreError } from './providers-store';
import { SessionStore, notebookPathsMatch, type ActiveSession } from './session-store';
import { NotebookWatcher, type FsEventSource } from './watch';
import { UiStore, type NotebookUiState, type UiPatch } from './ui-store';
import { serializePreview, TRUNCATION_SUFFIX } from './preview';
import { exportIpynb, IpynbError, parseTracebackTail, type ExportCell, type ExportRunSummary } from './exporter';
import { RunLog, readRunLog, runLogFileFor, type RunActor, type RunLogRecord, type RunTrigger } from './run-log';
import { ImportError, importIpynb } from './importer';
import type { CellSrc, ShadowRunner } from './shadow/manager';
import { buildRunReport, CONTRACT_KINDS, contractResults, type ContractResult, type ShadowBudgetView, type ShadowRunReport } from './shadow/report';
import {
  applyEdits,
  classify,
  evaluate,
  prefixRevisions,
  revisionOf,
  type RunRecord,
  type ShadowEdit,
  type VerificationRecord,
} from './shadow/verification';

/** .ipynb 导出用：单条 mime 数据存储上限（超大图弃数据仅留键，防内存膨胀）。 */
const MIME_DATA_LIMIT = 2_000_000;

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
  /** mime 数据（文本/base64），.ipynb 导出用；超 MIME_DATA_LIMIT 的条目弃数据仅留键。 */
  mime: Record<string, string | string[]>;
  /** run.notify kind='file-write' 的路径（写入顺序，去重，≤WRITES_PATH_LIMIT）。 */
  writes: string[];
}

/** agent.cellOutput / get_cell_output 的出进程安全结果（spec §8）。 */
export interface CellOutputSnapshot {
  traceback: string | null;
  mimeKeys: string[];
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

/**
 * diff.stage 结果：正常入队 {diffId, dependsOn?}，或编译预检拒绝 {rejected, reason, hint?, conflictsWith?}。
 * dependsOn = 本条只有叠加这些待审 diff 才合法（须先采纳它们）；
 * conflictsWith = 本条单独合法，但与这些待审 diff 同时采纳会编译失败。
 */
export type StageResult =
  | { diffId: string; dependsOn?: string[]; verification?: DiffVerification }
  | { rejected: true; reason: CompileError; hint?: string; conflictsWith?: string[] };

/** diff.stage 静态编译预检用的临时 cell id（不进运行态或缓存）。 */
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
  /** 保存/接受diff/关闭共享FIFO；失败只拒绝本操作，不阻塞之后的重试。 */
  writeTail: Promise<void>;
  /** bridge已收到但尚未成功落盘的源码（不包含客户端未发送的编辑）。 */
  needsPersist: boolean;
  /** 生命周期重启已入队/在途；阻止重复重启请求。 */
  restartInFlight: boolean;
  /** ADR-013：影子运行与核验记录（核验绑定用；不出进程）。 */
  shadow: ShadowLedger;
  /** ADR-014：当前会话的追加式运行日志（会话开始时创建、结束时释放）。 */
  runLog?: RunLog;
  /** ADR-014：正在进行的执行请求（谁触发、根 cell），供 run.started 归因。 */
  runIntent?: RunIntent;
}

interface RunIntent {
  rootCellId: string;
  actor: RunActor;
  trigger: RunTrigger;
  replCode?: string;
}

/** 每个 notebook 的影子运行账本：runId → 运行要点，verificationId → 契约结果，diffId → 核验绑定。 */
interface ShadowLedger {
  runs: Map<string, RunRecord>;
  verifications: Map<string, VerificationRecord>;
  /** 影子进程里保留着命名空间的那次运行（shadow.verify 只能针对它）。 */
  latestRunId?: string;
  diffBindings: Map<string, { level: DiffVerification['level']; verificationId?: string }>;
}

/** 账本条目上限（按插入序淘汰最旧；被淘汰的绑定退回 unverified）。 */
const SHADOW_LEDGER_LIMIT = 64;

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
  /** provider 凭据加密存储（默认新建 ProvidersStore → <repoRoot>/.novalab；单测注入临时目录）。 */
  providersStore?: ProvidersStore;
  /** bridge.mcpLaunch：外部 Agent 以 MCP 模式启动本 bridge 的命令行（Welcome 页"Connect…"展示）。 */
  mcpLaunch?: string[];
  /**
   * 能回应 agent.confirmRequest 的前端数（main.ts = 已鉴权 WS 客户端数）。
   * 不传 / 0 = 没人能确认（MCP 模式）→ agent.executeCell 一律拒绝。
   */
  confirmers?: () => number;
  /** 等待用户确认的上限（默认 120s；单测缩短）。 */
  confirmTimeoutMs?: number;
  /** ADR-013 影子执行器（main.ts 注入真实 ShadowManager；不传 = shadow.run 返回 unavailable）。 */
  shadow?: ShadowRunner;
  /** ADR-013 §5.3 bridge 预算（默认：每轮 8 次、单次 60s、每轮 5min、核验 30s）。 */
  shadowBudget?: Partial<ShadowBudget>;
}

export interface ShadowBudget {
  runsPerTurn: number;
  runMs: number;
  turnMs: number;
  verifyMs: number;
}

const DEFAULT_SHADOW_BUDGET: ShadowBudget = { runsPerTurn: 8, runMs: 60_000, turnMs: 300_000, verifyMs: 30_000 };

type ConfirmOutcome = 'allowed' | 'user-declined' | 'timeout';

/** agent.turnBegin 划出的一轮（O1 = b：每轮首次影子运行问一次）。 */
interface ShadowTurn {
  /** null = 没有 turnBegin（漏接线）：每次都问，预算仍累计。 */
  readonly turnId: string | null;
  runsUsed: number;
  msUsed: number;
  /** notebookId → 本轮的确认结论（只记 allowed / declined；超时不记，下次再问）。 */
  consent: Map<string, 'allowed' | 'declined'>;
  /** notebookId → 在途确认（同轮并发的 shadow_run 共享同一次询问）。 */
  pending: Map<string, { requestId: string; outcome: Promise<ConfirmOutcome> }>;
}

function newTurn(turnId: string | null): ShadowTurn {
  return { turnId, runsUsed: 0, msUsed: 0, consent: new Map(), pending: new Map() };
}

/** shadow_run 被拒（每个都意味着「没有运行」）。 */
export interface ShadowDenied {
  denied: true;
  reason: 'no-confirmer' | 'user-declined' | 'timeout' | 'focus-changed';
  message: string;
}

const SHADOW_DENY_MESSAGES: Record<ShadowDenied['reason'], string> = {
  'no-confirmer': 'No NovaLab window is open to approve shadow runs, so nothing was run.',
  'user-declined':
    'The user declined shadow runs for this turn, so nothing was run. Do not retry in this turn; propose the change without a shadow run or ask the user.',
  timeout: 'The user did not answer the shadow-run confirmation in time, so nothing was run.',
  'focus-changed': 'The user switched notebooks before approving, so nothing was run.',
};

/** shadow.verify 结果（只出状态与计数）。 */
export interface ShadowVerifyResult {
  runId: string;
  verificationId?: string;
  status: 'pass' | 'fail' | 'error' | 'not-retained' | 'timeout' | 'crashed' | 'cancelled' | 'unavailable';
  contracts: ContractResult[];
}

/** agent.executeCell 被拒的原因（每个都意味着「没有执行」）。 */
export type ExecuteDenyReason = 'no-confirmer' | 'user-declined' | 'timeout' | 'focus-changed' | 'code-changed';

export interface ExecuteDenied {
  denied: true;
  reason: ExecuteDenyReason;
  message: string;
}

const CONFIRM_TIMEOUT_MS = 120_000;

const DENY_MESSAGES: Record<ExecuteDenyReason, string> = {
  'no-confirmer': 'No NovaLab window is open to approve running code, so nothing was executed.',
  'user-declined': 'The user declined to run this cell, so nothing was executed.',
  timeout: 'The user did not answer the run confirmation in time, so nothing was executed.',
  'focus-changed': 'The user switched notebooks before approving, so nothing was executed.',
  'code-changed': 'The cell changed after the run was requested, so the approval no longer applies and nothing was executed.',
};

const DIFF_ACTIONS = new Set<DiffAction>(['update', 'insert_below']);

const PROVIDER_KINDS: ReadonlySet<string> = new Set<ProviderKind>([
  'anthropic-compat',
  'openai-compat',
]);

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
  private readonly providers: ProvidersStore;
  private readonly watcher?: NotebookWatcher;
  /** 在途的 agent.executeCell 确认（requestId → 结算函数）；先到的回复结算并移除。 */
  private readonly confirms = new Map<string, (outcome: ConfirmOutcome) => void>();
  private confirmSeq = 0;
  private readonly shadowBudget: ShadowBudget;
  private shadowTurn: ShadowTurn = newTurn(null);
  private shadowSeq = 0;

  constructor(private readonly deps: RouterDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.ui = deps.uiStore ?? new UiStore();
    this.fs = deps.fs ?? new FsManager();
    this.sessions = deps.sessionStore ?? new SessionStore(this.clock);
    this.providers = deps.providersStore ?? new ProvidersStore();
    this.multiMode = deps.multi !== undefined;
    this.shadowBudget = { ...DEFAULT_SHADOW_BUDGET, ...deps.shadowBudget };
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
    for (const settle of [...this.confirms.values()]) settle('timeout');
    this.deps.shadow?.dispose();
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
      case 'notebook.reload':
        return this.notebookReload(params);
      case 'cell.save':
        return this.cellSave(params);
      case 'cell.run':
        return this.cellRun(params);
      case 'control.set':
        return this.controlSet(params);
      case 'kernel.vars':
        return this.kernelVars();
      case 'kernel.repl':
        return this.kernelRepl(params);
      case 'kernel.restart':
        return this.kernelRestart(params);
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
      case 'agent.executeCell':
        return this.agentExecuteCell(params);
      case 'agent.confirmResponse':
        return this.agentConfirmResponse(params);
      case 'agent.turnBegin':
        return this.agentTurnBegin(params);
      case 'shadow.run':
        return this.shadowRun(params);
      case 'shadow.verify':
        return this.shadowVerify(params);
      case 'shadow.cancel':
        return this.shadowCancel();
      case 'bridge.mcpLaunch':
        return { mcpLaunch: this.deps.mcpLaunch ?? null };
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
      case 'session.runs':
        return this.sessionRuns(params);
      case 'export.ipynb':
        return this.exportIpynb(params);
      case 'import.ipynb':
        return this.importIpynb(params);
      case 'providers.list':
        return this.providersList();
      case 'providers.set':
        return this.providersSet(params);
      case 'providers.delete':
        return this.providersDelete(params);
      case 'providers.setActive':
        return this.providersSetActive(params);
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
      writeTail: Promise.resolve(),
      needsPersist: false,
      restartInFlight: false,
      shadow: { runs: new Map(), verifications: new Map(), diffBindings: new Map() },
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
   * notebook.close先排在已收到的保存之后；live写盘失败保留tab/内核/会话。
   * dead/ended仅在无bridge未落盘源码时可关闭；客户端未发送的编辑需先cell.save。
   */
  private async notebookClose(params: Record<string, unknown>): Promise<NotebookCloseResult> {
    const id = strParam(params, 'notebookId');
    const ctx = this.contexts.get(id);
    if (!ctx) throw new RpcFault(ERR_INVALID_PARAMS, `unknown notebookId: ${id}`);
    if (ctx.restartInFlight) throw new RpcFault(ERR_KERNEL, 'notebook.close unavailable while kernel.restart is in progress');
    return this.serializeNotebook(ctx, async () => {
      if (ctx.ended || ctx.supervisor.state === 'dead') {
        if (ctx.needsPersist) {
          throw new RpcFault(ERR_KERNEL, 'cannot close notebook: unsaved changes remain and kernel is unavailable');
        }
      } else if (ctx.cache) {
        await this.persistToDisk(ctx);
      }
      this.endSession(ctx, 'shutdown');
      this.deps.shadow?.release(ctx.notebookId);
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
    });
  }

  /** 设焦点：更新 focusId + watcher 跟随焦点（后台 notebook 不热重载，见文件头遗留说明）。 */
  private setFocus(notebookId: string): void {
    this.focusId = notebookId;
    const ctx = this.contexts.get(notebookId);
    if (ctx) this.watcher?.watch(ctx.path);
  }

  /** 外部事件只提示所属notebook；客户端可能还有bridge未知的未发送编辑。 */
  private externalReload(filePath: string): void {
    const ctx = this.ctxByPath(filePath);
    if (!ctx || !ctx.cache) return;
    this.deps.broadcast('notebook.externalChange', {
      notebookId: ctx.notebookId,
      notebookPath: ctx.path,
    });
  }

  /** 显式reload与保存/关闭串行；备份失败或cold load失败均不提交router状态。 */
  private async notebookReload(params: Record<string, unknown>): Promise<NotebookReloadResult> {
    const id = strParam(params, 'notebookId');
    const ctx = this.contexts.get(id);
    if (!ctx?.cache) throw new RpcFault(ERR_INVALID_PARAMS, `unknown notebookId: ${id}`);
    if (ctx.restartInFlight) throw new RpcFault(ERR_KERNEL, 'notebook.reload unavailable while kernel.restart is in progress');
    let supplied: { id: string; code: string }[] | undefined;
    if ('cells' in params) {
      const cells = params['cells'];
      if (!Array.isArray(cells) || cells.some((cell) =>
        !cell || typeof cell !== 'object' || Array.isArray(cell) ||
        typeof cell.id !== 'string' || typeof cell.code !== 'string'
      )) {
        throw new RpcFault(ERR_INVALID_PARAMS, 'notebook.reload cells must be [{id:string, code:string}]');
      }
      supplied = cells.map((cell) => ({ id: cell.id as string, code: cell.code as string }));
      if (new Set(supplied.map((cell) => cell.id)).size !== supplied.length) {
        throw new RpcFault(ERR_INVALID_PARAMS, 'notebook.reload: duplicate cell ids');
      }
    }
    return this.serializeNotebook(ctx, async () => {
      const cells = supplied ?? ctx.cache!.cells.map((cell) => ({ id: cell.id, code: cell.code }));
      const backup = (await ctx.supervisor.request('backup_file', { path: ctx.path, cells })) as { recoveryPath?: unknown };
      if (typeof backup.recoveryPath !== 'string' || !backup.recoveryPath) {
        throw new RpcFault(ERR_KERNEL, 'notebook.reload: backup did not return a recoveryPath');
      }
      const loaded = (await ctx.supervisor.request('load_file', { path: ctx.path })) as NotebookState;
      const fresh = normalizeState(loaded);
      this.endSession(ctx, 'restart');
      ctx.cache = fresh;
      ctx.outputs.clear();
      ctx.diffs = [];
      ctx.needsPersist = false;
      ctx.ended = false;
      this.beginSession(ctx);
      return { notebookId: id, state: this.snapshot(ctx), recoveryPath: backup.recoveryPath };
    });
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

  /** 同一notebook的完整写入链串行；其他notebook和焦点切换不等待此队列。 */
  private serializeNotebook<T>(ctx: NotebookContext, operation: () => Promise<T>): Promise<T> {
    const pending = ctx.writeTail.then(() => {
      if (this.contexts.get(ctx.notebookId) !== ctx) {
        throw new RpcFault(ERR_INVALID_PARAMS, `unknown notebookId: ${ctx.notebookId}`);
      }
      return operation();
    });
    ctx.writeTail = pending.then(() => undefined, () => undefined);
    return pending;
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
      ...(c.baselineSha256 ? { baselineSha256: c.baselineSha256 } : {}),
    });
  }

  // ---------- cell ----------

  private async cellSave(params: Record<string, unknown>): Promise<SaveResult> {
    let ctx: NotebookContext;
    if ('notebookId' in params) {
      const id = strParam(params, 'notebookId');
      const found = this.contexts.get(id);
      if (!found?.cache) throw new RpcFault(ERR_INVALID_PARAMS, `unknown notebookId: ${id}`);
      ctx = found;
    } else {
      ctx = this.focusCtx();
    }
    const cellId = strParam(params, 'cellId');
    const code = strParam(params, 'code');
    if (ctx.restartInFlight) throw new RpcFault(ERR_KERNEL, 'cell.save unavailable while kernel.restart is in progress');
    return this.serializeNotebook(ctx, async () => {
      const cell = ctx.cache!.cells.find((c) => c.id === cellId);
      if (!cell) throw new RpcFault(ERR_INVALID_PARAMS, `unknown cellId: ${cellId}`);
      cell.code = code;
      ctx.needsPersist = true;
      const res = await this.applyCellsToKernel(ctx);
      this.log(ctx, 'save', cellId, `chars:${code.length}`);
      return {
        dagEdges: res.dagEdges,
        staleSet: res.staleSet,
        ...(res.compileError ? { compileError: res.compileError } : {}),
        ...(ctx.cache?.baselineSha256 ? { baselineSha256: ctx.cache.baselineSha256 } : {}),
      };
    });
  }

  private async cellRun(params: Record<string, unknown>, actor: RunActor = 'user'): Promise<RunReport> {
    const ctx = this.focusCtx();
    const cache = ctx.cache!;
    const cellId = strParam(params, 'cellId');
    const cascade = params['cascade'] === true;
    if (!cache.cells.some((c) => c.id === cellId)) {
      throw new RpcFault(ERR_INVALID_PARAMS, `unknown cellId: ${cellId}`);
    }
    const report = await this.execTracked(ctx, 'exec_cell', { cellId, cascade }, { rootCellId: cellId, actor, trigger: 'direct' });
    this.settleRun(ctx, report);
    return report;
  }

  /** 发起一次内核执行并登记归因（ADR-014）；请求结束即清除，迟到的通知按无归因处理。 */
  private async execTracked(
    ctx: NotebookContext,
    method: 'exec_cell' | 'exec_repl',
    params: Record<string, unknown>,
    intent: RunIntent,
  ): Promise<RunReport> {
    ctx.runIntent = intent;
    try {
      return (await ctx.supervisor.request(method, params)) as RunReport;
    } finally {
      if (ctx.runIntent === intent) ctx.runIntent = undefined;
    }
  }

  /**
   * Agent 的 execute_cell（ADR-013 影子执行落地前的过渡闸）：每次都在用户 kernel 上执行，
   * 所以每次都要用户在界面上点「允许」。批准绑定在「请求时的 notebook + cell 源码」上：
   * 等待期间切 tab 或源码被改，批准作废。拒绝返回 {denied}（不是 RPC 错误），让模型停下来问用户。
   */
  private async agentExecuteCell(params: Record<string, unknown>): Promise<RunReport | ExecuteDenied> {
    const ctx = this.focusCtx();
    const cellId = strParam(params, 'cellId');
    const cascade = params['cascade'] === true;
    const cell = ctx.cache!.cells.find((c) => c.id === cellId);
    if (!cell) throw new RpcFault(ERR_INVALID_PARAMS, `unknown cellId: ${cellId}`);
    const denied = (reason: ExecuteDenyReason): ExecuteDenied => ({ denied: true, reason, message: DENY_MESSAGES[reason] });
    if ((this.deps.confirmers?.() ?? 0) <= 0) return denied('no-confirmer');

    const code = cell.code;
    const outcome = await this.askConfirm({ kind: 'execute_cell', notebookId: ctx.notebookId, cellId, code, cascade }).outcome;
    if (outcome !== 'allowed') return denied(outcome);
    if (this.focusId !== ctx.notebookId || this.contexts.get(ctx.notebookId) !== ctx || !ctx.cache) {
      return denied('focus-changed');
    }
    if (ctx.cache.cells.find((c) => c.id === cellId)?.code !== code) return denied('code-changed');
    return this.cellRun({ cellId, cascade }, 'agent');
  }

  /**
   * 用户确认握手（agent.confirmRequest → agent.confirmResponse / 超时 → agent.confirmResolved）。
   * execute_cell 与 shadow_run 共用；先到的结算生效，其余忽略。
   */
  private askConfirm(payload: Record<string, unknown>): { requestId: string; outcome: Promise<ConfirmOutcome> } {
    const requestId = `confirm-${++this.confirmSeq}`;
    const timeoutMs = this.deps.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
    const outcome = new Promise<ConfirmOutcome>((resolve) => {
      const timer = setTimeout(() => settle('timeout'), timeoutMs);
      const settle = (o: ConfirmOutcome): void => {
        if (!this.confirms.delete(requestId)) return;
        clearTimeout(timer);
        this.deps.broadcast('agent.confirmResolved', { requestId, outcome: o });
        resolve(o);
      };
      this.confirms.set(requestId, settle);
      this.deps.broadcast('agent.confirmRequest', { requestId, ...payload, timeoutMs });
    });
    return { requestId, outcome };
  }

  private agentConfirmResponse(params: Record<string, unknown>): { requestId: string; outcome: 'allowed' | 'user-declined' } {
    const requestId = strParam(params, 'requestId');
    const settle = this.confirms.get(requestId);
    if (!settle) throw new RpcFault(ERR_INVALID_PARAMS, `unknown or already-resolved confirm request: ${requestId}`);
    const outcome = params['allow'] === true ? 'allowed' : 'user-declined';
    settle(outcome);
    return { requestId, outcome };
  }

  // ---------- shadow.*（ADR-013 影子执行与核验） ----------

  /**
   * agent.turnBegin {turnId}：前端每次发起 Agent 请求时调用，划出一轮（O1 = b）。
   * 上一轮还在等的影子确认按「拒绝」结算（用户已经发了新请求），确认结论与预算清零。
   */
  private agentTurnBegin(params: Record<string, unknown>): { turnId: string } {
    const turnId = strParam(params, 'turnId');
    const prev = this.shadowTurn;
    this.shadowTurn = newTurn(turnId);
    for (const { requestId } of prev.pending.values()) this.confirms.get(requestId)?.('user-declined');
    return { turnId };
  }

  /**
   * shadow.run {changes, seed?, k?}：在独立的影子进程里按源码重放上游闭包，再运行改后闭包。
   * 用户内核、变量、文件一概不碰；结果过第一道 M5 闸（buildRunReport 按类型重建）后才出 router。
   */
  private async shadowRun(params: Record<string, unknown>): Promise<ShadowRunReport | ShadowDenied> {
    const ctx = this.focusCtx();
    const edits = parseShadowEdits(params['changes']);
    tryApplyEdits(shadowCells(ctx), edits);
    const turn = this.shadowTurn;
    const runner = this.deps.shadow;
    if (!runner) {
      return { runId: null, status: 'unavailable', message: SHADOW_STATUS_MESSAGES.unavailable, budget: this.budgetView(turn) };
    }
    if (this.budgetSpent(turn)) return this.budgetExceeded(turn);

    const consent = await this.shadowConsent(ctx, turn, edits, runner);
    if (consent !== 'allowed') {
      this.log(ctx, 'shadow_confirm', edits[0]!.targetCellId, consent, 'agent');
      return { denied: true, reason: consent, message: SHADOW_DENY_MESSAGES[consent] };
    }
    if (!this.isFocus(ctx) || this.contexts.get(ctx.notebookId) !== ctx || !ctx.cache) {
      return { denied: true, reason: 'focus-changed', message: SHADOW_DENY_MESSAGES['focus-changed'] };
    }
    if (this.budgetSpent(turn)) return this.budgetExceeded(turn);

    // 等确认期间源码可能变了：base 以运行时刻为准
    const base = shadowCells(ctx);
    const candidate = tryApplyEdits(base, edits);
    const runId = `shadow-${++this.shadowSeq}`;
    turn.runsUsed++;
    // 新运行会替换影子进程，上一次运行的命名空间不再可 verify
    ctx.shadow.latestRunId = undefined;
    const timeoutMs = Math.max(1, Math.min(this.shadowBudget.runMs, this.shadowBudget.turnMs - turn.msUsed));
    const seed = typeof params['seed'] === 'number' && Number.isInteger(params['seed']) ? params['seed'] : undefined;
    const k = typeof params['k'] === 'number' && Number.isInteger(params['k']) && params['k'] >= 2 ? params['k'] : undefined;
    const t0 = Date.now();
    let outcome: Awaited<ReturnType<ShadowRunner['run']>>;
    try {
      outcome = await runner.run({
        key: ctx.notebookId,
        notebookDir: path.dirname(ctx.path),
        base,
        candidates: [{ name: 'after', cells: candidate }],
        ...(seed !== undefined ? { seed } : {}),
        ...(k !== undefined ? { k } : {}),
        timeoutMs,
      });
    } finally {
      turn.msUsed += Date.now() - t0;
    }
    const budget = this.budgetView(turn);
    if (outcome.status !== 'ok') {
      this.log(ctx, 'shadow_run', edits[0]!.targetCellId, `${runId}:${outcome.status}`, 'agent');
      return { runId, status: outcome.status, message: SHADOW_STATUS_MESSAGES[outcome.status], budget };
    }
    const { report, facts } = buildRunReport(runId, outcome.result, budget);
    const verificationId = `ver-${++this.shadowSeq}`;
    remember(ctx.shadow.runs, runId, { runId, edits, revisions: prefixRevisions(base, edits), facts });
    remember(ctx.shadow.verifications, verificationId, { verificationId, runId, contracts: [] });
    ctx.shadow.latestRunId = runId;
    report.verificationId = verificationId;
    this.log(ctx, 'shadow_run', edits[0]!.targetCellId, `${runId}:${report.status}`, 'agent');
    return report;
  }

  /** 本轮对该 notebook 的影子运行许可：已有结论直接用；否则问一次（并发调用共享这次询问）。 */
  private async shadowConsent(
    ctx: NotebookContext,
    turn: ShadowTurn,
    edits: ShadowEdit[],
    runner: ShadowRunner,
  ): Promise<'allowed' | ShadowDenied['reason']> {
    if ((this.deps.confirmers?.() ?? 0) <= 0) return 'no-confirmer';
    const prior = turn.consent.get(ctx.notebookId);
    if (prior === 'allowed') return 'allowed';
    if (prior === 'declined') return 'user-declined';
    let pending = turn.pending.get(ctx.notebookId);
    if (!pending) {
      const ask = this.askConfirm({
        kind: 'shadow_run',
        notebookId: ctx.notebookId,
        turnId: turn.turnId,
        summary: {
          changes: edits.map((e) => ({ cellId: e.targetCellId, action: e.action, firstLine: firstLineOf(e.newCode) })),
          memLimitBytes: runner.memLimitBytes,
          runMs: this.shadowBudget.runMs,
          runsLeft: this.shadowBudget.runsPerTurn - turn.runsUsed,
          rememberForTurn: turn.turnId !== null,
        },
      });
      const outcome = ask.outcome.then((o) => {
        turn.pending.delete(ctx.notebookId);
        // 只有划了轮次才记住结论；超时不记（下次再问）
        if (turn.turnId !== null && o !== 'timeout') turn.consent.set(ctx.notebookId, o === 'allowed' ? 'allowed' : 'declined');
        this.log(ctx, 'shadow_confirm', undefined, o, 'user');
        return o;
      });
      pending = { requestId: ask.requestId, outcome };
      turn.pending.set(ctx.notebookId, pending);
    }
    return pending.outcome;
  }

  /**
   * shadow.verify {runId, contracts}：在最近一次运行保留的影子命名空间上评估声明式契约。
   * 只出状态与计数；每次 verify 产生新的 verificationId（diff.stage 用它绑定核验）。
   */
  private async shadowVerify(params: Record<string, unknown>): Promise<ShadowVerifyResult> {
    const ctx = this.focusCtx();
    const runId = strParam(params, 'runId');
    const contracts = parseContracts(params['contracts']);
    const runner = this.deps.shadow;
    if (!runner) return { runId, status: 'unavailable', contracts: [] };
    if (ctx.shadow.latestRunId !== runId || !ctx.shadow.runs.has(runId)) return { runId, status: 'not-retained', contracts: [] };
    const out = await runner.verify(ctx.notebookId, 'after', contracts, this.shadowBudget.verifyMs);
    if (out.status !== 'ok') {
      if (out.status !== 'timeout') ctx.shadow.latestRunId = undefined;
      this.log(ctx, 'shadow_verify', undefined, `${runId}:${out.status}`, 'agent');
      return { runId, status: out.status, contracts: [] };
    }
    const results = contractResults(asRecord(out.result)['contracts'], CONTRACT_KINDS);
    const byId = new Map(contracts.map((c) => [c['id'] as string, c]));
    const stored = results.map((r) => {
      const targets = contractTargets(byId.get(r.id));
      return targets.length > 0 ? { ...r, targets } : r;
    });
    const verificationId = `ver-${++this.shadowSeq}`;
    remember(ctx.shadow.verifications, verificationId, { verificationId, runId, contracts: stored });
    const status = results.some((r) => r.status === 'fail') ? 'fail' : results.some((r) => r.status === 'error') ? 'error' : 'pass';
    this.log(ctx, 'shadow_verify', undefined, `${verificationId}:${status}`, 'agent');
    return { runId, verificationId, status, contracts: results };
  }

  /** shadow.cancel：Stop 按钮 / harness abortSignal。终止在途影子运行；在等的确认按拒绝结算。 */
  private shadowCancel(): { cancelled: boolean } {
    const ctx = this.focusCtxOptional();
    if (!ctx) return { cancelled: false };
    const pending = this.shadowTurn.pending.get(ctx.notebookId);
    if (pending) this.confirms.get(pending.requestId)?.('user-declined');
    const cancelled = this.deps.shadow?.cancel(ctx.notebookId) ?? false;
    if (cancelled) ctx.shadow.latestRunId = undefined;
    return { cancelled: cancelled || pending !== undefined };
  }

  private budgetView(turn: ShadowTurn): ShadowBudgetView {
    return {
      runsUsed: turn.runsUsed,
      runsLimit: this.shadowBudget.runsPerTurn,
      msUsed: turn.msUsed,
      msLimit: this.shadowBudget.turnMs,
    };
  }

  private budgetSpent(turn: ShadowTurn): boolean {
    return turn.runsUsed >= this.shadowBudget.runsPerTurn || turn.msUsed >= this.shadowBudget.turnMs;
  }

  private budgetExceeded(turn: ShadowTurn): ShadowRunReport {
    return { runId: null, status: 'budget-exceeded', message: SHADOW_STATUS_MESSAGES['budget-exceeded'], budget: this.budgetView(turn) };
  }

  /** diff.stage 时确定核验级别并记下绑定（状态由 refreshVerification 统一计算）。 */
  private bindVerification(
    ctx: NotebookContext,
    edit: ShadowEdit,
    verificationId: string | undefined,
    intent: string | undefined,
  ): { level: DiffVerification['level']; verificationId?: string } {
    const ver = verificationId ? ctx.shadow.verifications.get(verificationId) : undefined;
    const run = ver ? ctx.shadow.runs.get(ver.runId) : undefined;
    const oldCode = edit.action === 'update' ? ctx.cache!.cells.find((c) => c.id === edit.targetCellId)?.code : undefined;
    const level = classify({ edit, oldCode, intent, dataful: (run?.facts.dataVars.length ?? 0) > 0 });
    return verificationId ? { level, verificationId } : { level };
  }

  /** 按当前源码修订重算所有待审 diff 的核验状态；有变化返回 true（调用方决定是否广播）。 */
  private refreshVerification(ctx: NotebookContext): boolean {
    if (!ctx.cache) return false;
    const currentRevision = revisionOf(ctx.cache.cells);
    let changed = false;
    for (const d of ctx.diffs) {
      if (d.status !== 'proposed') continue;
      const binding = ctx.shadow.diffBindings.get(d.diffId);
      if (!binding) continue;
      const verification = binding.verificationId ? ctx.shadow.verifications.get(binding.verificationId) : undefined;
      const run = verification ? ctx.shadow.runs.get(verification.runId) : undefined;
      const next = evaluate({
        level: binding.level,
        edit: { targetCellId: d.targetCellId, action: d.action, newCode: d.newCode },
        currentRevision,
        ...(run ? { run } : {}),
        ...(verification ? { verification } : {}),
      });
      if (JSON.stringify(next) !== JSON.stringify(d.verification)) {
        d.verification = next;
        changed = true;
      }
    }
    return changed;
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
    // ADR-013：源码修订变了 → 已入队 diff 的核验状态重算（如 verified → expired）
    if (this.refreshVerification(ctx)) this.emitDiffs(ctx);
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
    ctx.needsPersist = true;
    this.watcher?.markSelfWrite(ctx.path);
    try {
      const saved = (await ctx.supervisor.request('save_file', {
        path: ctx.path,
        cells: cache.cells.map((c) => ({ id: c.id, code: c.code })),
      })) as { baselineSha256?: unknown } | null;
      // D4：成功落盘推进基线指纹；失败（含 -32002）抛出，指纹保持旧值。
      if (typeof saved?.baselineSha256 === 'string') cache.baselineSha256 = saved.baselineSha256;
      ctx.needsPersist = false;
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
    const report = await this.execTracked(ctx, 'exec_repl', { code }, { rootCellId: 'repl', actor: 'user', trigger: 'repl', replCode: code });
    this.log(ctx, 'repl', 'repl', `ok:${report.ok}`);
    return report;
  }

  private async kernelRestart(params: Record<string, unknown>): Promise<NotebookRestartResult> {
    const id = strParam(params, 'notebookId');
    const ctx = this.contexts.get(id);
    if (!ctx?.cache) throw new RpcFault(ERR_INVALID_PARAMS, `unknown notebookId: ${id}`);
    if (ctx.restartInFlight) {
      throw new RpcFault(ERR_KERNEL, 'kernel.restart already in progress for this notebook');
    }
    // Mark before entering the FIFO: a second request must not queue behind the first
    // and later observe the newly-live kernel as if it were a separate restart.
    ctx.restartInFlight = true;
    try {
      return await this.serializeNotebook(ctx, async () => {
        // The UI exposes this lifecycle action only for dead/ended tabs, while
        // the bridge keeps the historical direct-call form usable for clean
        // live owners. Both paths share the same cold-load and queue boundary.
        if (ctx.needsPersist) {
          throw new RpcFault(ERR_KERNEL, 'cannot restart notebook: unsaved changes remain and kernel is unavailable');
        }
        const hadLiveSession = ctx.session !== undefined;
        let state: NotebookState;
        try {
          state = await ctx.supervisor.restart();
        } catch (err) {
          // A live direct restart has already killed the old transport before
          // load_file can fail. Close that session exactly once; a crashed
          // owner has no session here because onKernelCrash ended it already.
          if (hadLiveSession && ctx.session) this.endSession(ctx, 'crash');
          throw err;
        }
        const fresh = normalizeState(state);
        if (ctx.session) this.endSession(ctx, 'restart');
        ctx.cache = fresh;
        ctx.outputs.clear();
        ctx.diffs = [];
        ctx.needsPersist = false;
        ctx.ended = false;
        this.beginSession(ctx);
        this.emitDiffs(ctx);
        return { notebookId: id, notebookPath: ctx.path, state: this.snapshot(ctx) };
      });
    } finally {
      // The context may have been removed only after a queued close; guard the
      // identity so a stale restart continuation cannot mutate a replacement.
      if (this.contexts.get(id) === ctx) ctx.restartInFlight = false;
    }
  }

  // ---------- diff（内存暂存队列，UI 在 P2） ----------

  /**
   * diff.stage：入队前用 validate_cells 静态分析候选全量 cells。
   * compileError → 不入队，返回 {rejected:true, reason}，让模型自纠。
   * 验证不触碰运行态 / cache、不落盘、不执行；接受 diff 才提交变更。
   */
  private diffStage(params: Record<string, unknown>): Promise<StageResult> {
    const ctx = this.focusCtx();
    if (ctx.restartInFlight) throw new RpcFault(ERR_KERNEL, 'diff.stage unavailable while kernel.restart is in progress');
    // F3：AI SDK 会并发执行同一条消息里的多个工具调用；stage 读「待审队列 + cells」，
    // 必须与其它 stage / accept / save 串行，后到的一条才能叠加先到的一条。
    return this.serializeNotebook(ctx, () => this.stageQueued(ctx, params));
  }

  private async stageQueued(ctx: NotebookContext, params: Record<string, unknown>): Promise<StageResult> {
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

    const proposal: DiffEdit = { targetCellId, action: action as DiffAction, newCode };
    const validate = async (stack: StagedDiff[]): Promise<CompileError | undefined> => {
      const res = (await ctx.supervisor.request('validate_cells', {
        cells: buildCandidateCells(cache.cells, stack, proposal),
      })) as { compileError?: unknown };
      return asCompileError(res.compileError);
    };

    // F2：单独验证（相对当前 notebook）+ 叠加全部待审 diff 验证（相对「全部采纳后」）
    const pending = ctx.diffs.filter((d) => d.status === 'proposed');
    const solo = await validate([]);
    let dependsOn: string[] | undefined;
    if (pending.length > 0) {
      const stacked = await validate(pending);
      if (stacked) {
        if (solo) return { rejected: true, reason: stacked, ...stageHint(stacked, proposal, pending) };
        // 单独合法、只与待审 diff 冲突：不是「先 update 谁」的问题，而是两条不能同时采纳
        const ids = implicatedDiffs(stacked, pending);
        const conflictsWith = ids.length > 0 ? ids : pending.map((d) => d.diffId);
        return {
          rejected: true,
          reason: stacked,
          hint:
            `This change is valid against the current notebook but conflicts with pending ${conflictsWith.join(', ')}; ` +
            'they cannot both be accepted. Ask the user to accept or reject those first, or propose a version that does not clash.',
          conflictsWith,
        };
      }
      if (solo) {
        // 只依赖真正相关的待审 diff；收窄后的集合须单独复核，否则退回依赖全部待审
        const narrowed = pending.filter((d) => implicatedDiffs(solo, [d]).length > 0);
        dependsOn = (narrowed.length > 0 && narrowed.length < pending.length && !(await validate(narrowed))
          ? narrowed
          : pending
        ).map((d) => d.diffId);
      }
    } else if (solo) {
      return { rejected: true, reason: solo, ...stageHint(solo, proposal, []) };
    }

    const rationale = typeof params['rationale'] === 'string' ? params['rationale'] : undefined;
    const verificationId = typeof params['verificationId'] === 'string' ? params['verificationId'] : undefined;
    const intent = typeof params['intent'] === 'string' ? params['intent'] : undefined;
    const binding = this.bindVerification(ctx, proposal, verificationId, intent);
    const diff: StagedDiff = {
      diffId: `diff-${++ctx.diffSeq}`,
      targetCellId,
      action: action as DiffAction,
      newCode,
      ...(rationale !== undefined ? { rationale } : {}),
      ...(dependsOn ? { dependsOn } : {}),
      status: 'proposed',
      createdAt: this.clock().toISOString(),
    };
    ctx.diffs.push(diff);
    ctx.shadow.diffBindings.set(diff.diffId, binding);
    this.refreshVerification(ctx);
    this.emitDiffs(ctx);
    this.log(ctx, 'diff_proposed', targetCellId, diff.diffId);
    const verification = structuredClone(diff.verification!);
    return dependsOn ? { diffId: diff.diffId, dependsOn, verification } : { diffId: diff.diffId, verification };
  }

  private async diffAccept(
    params: Record<string, unknown>,
  ): Promise<{ diffId: string; dagEdges: NotebookState['dagEdges']; staleSet: string[]; compileError?: KernelCompileError; run?: RunReport }> {
    const ctx = this.focusCtx();
    if (ctx.restartInFlight) throw new RpcFault(ERR_KERNEL, 'diff.accept unavailable while kernel.restart is in progress');
    return this.serializeNotebook(ctx, async () => {
      const cache = ctx.cache!;
      const diff = this.requireDiff(ctx, strParam(params, 'diffId'));
      // F2：依赖须先采纳；在改动 cache 之前拒绝，notebook 保持原样
      for (const depId of diff.dependsOn ?? []) {
        const dep = ctx.diffs.find((d) => d.diffId === depId);
        if (dep?.status === 'accepted') continue;
        throw new RpcFault(
          ERR_INVALID_PARAMS,
          dep?.status === 'proposed'
            ? `${diff.diffId} depends on ${depId}; accept ${depId} first`
            : `${diff.diffId} depends on ${depId}, which was rejected; reject ${diff.diffId} and re-propose it against the current notebook`,
        );
      }
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

      ctx.needsPersist = true;
      const saved = await this.applyCellsToKernel(ctx);
      diff.status = 'accepted';
      this.emitDiffs(ctx);
      this.log(ctx, 'diff_accepted', runCellId, diff.diffId);

      const out: { diffId: string; dagEdges: NotebookState['dagEdges']; staleSet: string[]; compileError?: KernelCompileError; run?: RunReport; baselineSha256?: string } = {
        diffId: diff.diffId,
        dagEdges: saved.dagEdges,
        staleSet: saved.staleSet,
        ...(ctx.cache?.baselineSha256 ? { baselineSha256: ctx.cache.baselineSha256 } : {}),
      };
      if (saved.compileError) {
        out.compileError = saved.compileError;
        return out; // 编译错不进运行队列（spec §12）
      }
      // accept = cell.save + cell.run cascade=false（Owner 裁决 mark-only）
      const report = await this.execTracked(ctx, 'exec_cell', { cellId: runCellId, cascade: false }, {
        rootCellId: runCellId,
        actor: 'user',
        trigger: 'accept',
      });
      this.settleRun(ctx, report);
      out.run = report;
      return out;
    });
  }

  private diffReject(params: Record<string, unknown>): { diffId: string; status: 'rejected' } {
    const ctx = this.focusCtx();
    if (ctx.restartInFlight) throw new RpcFault(ERR_KERNEL, 'diff.reject unavailable while kernel.restart is in progress');
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

  /**
   * get_cell_output：仅返回隐私白名单字段。
   * stdout/stderr 和写入路径保留给本地 UI/session，不穿过 agent/MCP 出口。
   */
  private agentCellOutput(params: Record<string, unknown>): CellOutputSnapshot {
    const ctx = this.focusCtx();
    const cache = ctx.cache!;
    const cellId = strParam(params, 'cellId');
    if (cellId !== 'repl' && !cache.cells.some((c) => c.id === cellId)) {
      throw new RpcFault(ERR_INVALID_PARAMS, `unknown cellId: ${cellId}`);
    }
    const buf = ctx.outputs.get(cellId);
    return {
      traceback: buf?.traceback !== undefined ? capOutput(buf.traceback, false) : null,
      mimeKeys: buf ? [...buf.mimeKeys] : [],
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
    // A restart's supervisor emits restarting→idle before the router commits the
    // owner cache/session. Keep the dead tab ended/read-only until that commit;
    // otherwise a stale status can briefly re-enable ordinary writes.
    if (params.state === 'dead') ctx.ended = true;
    else if (!ctx.restartInFlight) ctx.ended = false;
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
    this.recordRun(ctx, method, params);
    if (ctx.cache && method === 'run.error') {
      // 失败的运行也计数（novakernel ≥ 本版随 run.error 下发 execCount；旧内核缺省 → 不动）
      const rp = params as { cellId?: unknown; execCount?: unknown };
      if (typeof rp.cellId === 'string' && typeof rp.execCount === 'number') {
        ctx.cache.execCounts[rp.cellId] = rp.execCount;
        const cell = ctx.cache.cells.find((c) => c.id === rp.cellId);
        if (cell) cell.execCount = rp.execCount;
      }
    }
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
          mime: {},
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
        if (mime) {
          const raw = p['data'];
          const data = typeof raw === 'string' || Array.isArray(raw) ? raw : undefined;
          const size = typeof data === 'string' ? data.length : Array.isArray(data) ? data.join('').length : 0;
          if (data !== undefined && size <= MIME_DATA_LIMIT) buf.mime[mime] = data;
        }
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

  /** ADR-014：run.started 登记、run.done / run.error 落一行（在 accumulateOutput 之后调用，输出摘要已就绪）。 */
  private recordRun(ctx: NotebookContext, method: string, params: unknown): void {
    const log = ctx.runLog;
    if (!log) return;
    const p = params as Record<string, unknown>;
    const cellId = typeof p['cellId'] === 'string' ? p['cellId'] : undefined;
    if (!cellId) return;
    const intent = ctx.runIntent;
    if (method === 'run.started') {
      const isRoot = intent?.rootCellId === cellId;
      const code = cellId === 'repl' ? (intent?.replCode ?? '') : (ctx.cache?.cells.find((c) => c.id === cellId)?.code ?? '');
      log.started(cellId, {
        code,
        actor: intent?.actor ?? 'user',
        trigger: intent ? (isRoot ? intent.trigger : 'cascade') : 'direct',
        ...(intent && !isRoot ? { rootCellId: intent.rootCellId } : {}),
      });
      return;
    }
    if (method !== 'run.done' && method !== 'run.error') return;
    const buf = ctx.outputs.get(cellId);
    const execCount = typeof p['execCount'] === 'number' ? p['execCount'] : (ctx.cache?.execCounts[cellId] ?? 0);
    let error: { name: string; line?: number } | undefined;
    if (method === 'run.error') {
      const tb = typeof p['traceback'] === 'string' ? p['traceback'] : '';
      const frames = Array.isArray(p['frames']) ? (p['frames'] as { file?: unknown; line?: unknown }[]) : [];
      const own = frames.filter((f) => f?.file === `<cell ${cellId}>` && typeof f.line === 'number').at(-1);
      error = { name: parseTracebackTail(tb).ename, ...(own ? { line: own.line as number } : {}) };
    }
    log.finished(cellId, {
      ok: method === 'run.done',
      attempt: execCount,
      ...(typeof p['durationMs'] === 'number' ? { durationMs: p['durationMs'] } : {}),
      ...(error ? { error } : {}),
      out: {
        stdoutBytes: Buffer.byteLength(buf?.stdout ?? '', 'utf8'),
        stderrBytes: Buffer.byteLength(buf?.stderr ?? '', 'utf8'),
        mime: buf ? [...buf.mimeKeys] : [],
        writes: buf ? [...buf.writes] : [],
      },
    });
  }

  private ensureOutputBuffer(ctx: NotebookContext, cellId: string): OutputBuffer {
    let buf = ctx.outputs.get(cellId);
    if (!buf) {
      buf = { stdout: '', stderr: '', stdoutTrunc: false, stderrTrunc: false, mimeKeys: [], mime: {}, writes: [] };
      ctx.outputs.set(cellId, buf);
    }
    return buf;
  }

  private log(
    ctx: NotebookContext,
    kind: SessionEventKind,
    cellId?: string,
    payloadRef?: string,
    actor: 'user' | 'agent' = 'user',
  ): void {
    ctx.session?.append({
      kind,
      actor,
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
    ctx.runLog = new RunLog(runLogFileFor(session.jsonlFile), { clock: this.clock });
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
    ctx.runLog = undefined;
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

  /** session.list：按 notebook 归属列历史；live 条目的 cellCount 来自该 notebook 缓存。 */
  private sessionList(params: Record<string, unknown>): SessionMeta[] {
    const focus = this.focusCtxOptional();
    const nb =
      typeof params['notebookPath'] === 'string' && params['notebookPath'] !== ''
        ? params['notebookPath']
        : focus?.path;
    if (!nb) {
      throw new RpcFault(ERR_INVALID_PARAMS, 'session.list 需要 {notebookPath}（当前无已打开 notebook）');
    }
    const metas = this.sessions.list(path.dirname(nb), nb);
    const ctx = this.ctxByPath(nb);
    const liveId = ctx?.session?.id;
    if (liveId && ctx?.cache) {
      const live = metas.find((m) => m.id === liveId);
      if (live) live.cellCount = ctx.cache.cells.length;
    }
    return metas;
  }

  /**
   * session.runs {notebookPath?, sessionId?, cellId?} → 运行日志（ADR-014）。缺省 = 当前 notebook 的
   * 当前会话。sessionId 必须是该 notebook 会话索引里的 id（不拼接任意路径）。只供本机前端，不进 Agent 工具。
   */
  private sessionRuns(params: Record<string, unknown>): { sessionId: string | null; records: RunLogRecord[]; truncated: boolean } {
    const nb =
      typeof params['notebookPath'] === 'string' && params['notebookPath'] !== ''
        ? params['notebookPath']
        : this.focusCtxOptional()?.path;
    if (!nb) throw new RpcFault(ERR_INVALID_PARAMS, 'session.runs 需要 {notebookPath}（当前无已打开 notebook）');
    const cellId = typeof params['cellId'] === 'string' ? params['cellId'] : undefined;
    const ctx = this.ctxByPath(nb);
    const requested = typeof params['sessionId'] === 'string' && params['sessionId'] !== '' ? params['sessionId'] : undefined;
    if (!requested || requested === ctx?.session?.id) {
      if (!ctx?.runLog || !ctx.session) return { sessionId: null, records: [], truncated: false };
      return { sessionId: ctx.session.id, ...readRunLog(ctx.runLog.file, { cellId }) };
    }
    if (!this.sessions.list(path.dirname(nb), nb).some((m) => m.id === requested)) {
      throw new RpcFault(ERR_INVALID_PARAMS, `unknown sessionId: ${requested}`);
    }
    const file = runLogFileFor(path.join(SessionStore.dirFor(path.dirname(nb)), `${requested}.jsonl`));
    return { sessionId: requested, ...readRunLog(file, { cellId }) };
  }

  /** session.open：按所属 notebook 查询；live 用该内核缓存投影，历史读磁盘快照。 */
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
    const ctx = this.ctxByPath(nb);
    if (ctx?.session?.id === sessionId) {
      return {
        sessionId,
        startedAt: ctx.session.startedAt,
        endedAt: null,
        cells: this.snapshotCells(ctx),
        readOnly: true,
      };
    }
    const found = this.sessions.open(path.dirname(nb), sessionId);
    if (!found || (found.snapshot.notebookPath && !notebookPathsMatch(found.snapshot.notebookPath, nb))) {
      throw new RpcFault(ERR_INVALID_PARAMS, `unknown sessionId: ${sessionId}`);
    }
    return {
      sessionId,
      startedAt: found.snapshot.startedAt,
      endedAt: found.snapshot.endedAt,
      cells: found.snapshot.cells,
      readOnly: true,
    };
  }

  // ---------- .ipynb 导出/导入（P3.4 接线；exporter/importer 为纯模块，N6 线交付） ----------

  /**
   * control.set 透传（P3.3 接线）：焦点内核同名方法，响应 {ok,cascaded,staleSideEffect}
   * 原样返回；级联重跑的 run.* 通知由内核自发、走既有焦点广播，广播侧零改动。
   */
  private async controlSet(params: Record<string, unknown>): Promise<unknown> {
    const ctx = this.focusCtx();
    const controlId = strParam(params, 'controlId');
    return ctx.supervisor.request('control.set', { controlId, value: params['value'] });
  }

  /**
   * export.ipynb {path?, sessionId?, target?}：
   * live 会话（缺省 sessionId 或等于焦点当前会话）走富缓存（含 mime 数据）；
   * 历史会话走 snapshot（文本形态输出，mime 仅键名故不含图像数据）。
   */
  private exportIpynb(params: Record<string, unknown>): { path: string; nbCells: number; nbOutputs: number } {
    const nb =
      typeof params['path'] === 'string' && params['path'] !== ''
        ? params['path']
        : this.focusCtxOptional()?.path;
    if (!nb) throw new RpcFault(ERR_NO_NOTEBOOK, 'export.ipynb 需要 {path}（当前无已打开 notebook）');
    const ctx = this.ctxByPath(nb);
    const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : ctx?.session?.id;
    let cells: ExportCell[];
    if (ctx && (!sessionId || sessionId === ctx.session?.id)) {
      cells = (ctx.cache?.cells ?? []).map((c) => {
        const buf = ctx.outputs.get(c.id);
        return {
          id: c.id,
          code: c.code,
          execCount: c.execCount,
          output: buf
            ? {
                stdout: buf.stdout,
                stderr: buf.stderr,
                traceback: buf.traceback ?? null,
                mime: buf.mime,
                writes: buf.writes,
              }
            : null,
        };
      });
    } else if (sessionId) {
      const found = this.sessions.open(path.dirname(nb), sessionId);
      if (!found) throw new RpcFault(ERR_INVALID_PARAMS, `unknown sessionId: ${sessionId}`);
      cells = found.snapshot.cells.map((c) => ({
        id: c.id,
        code: c.code,
        execCount: c.execCount,
        output: {
          stdout: c.output?.stdout,
          stderr: c.output?.stderr,
          traceback: c.output?.traceback ?? null,
          writes: c.output?.writes,
        },
      }));
    } else {
      throw new RpcFault(ERR_INVALID_PARAMS, 'export.ipynb：无法定位会话（无 live notebook 且未传 sessionId）');
    }
    const runsFile =
      ctx?.runLog && (!sessionId || sessionId === ctx.session?.id)
        ? ctx.runLog.file
        : sessionId
          ? runLogFileFor(path.join(SessionStore.dirFor(path.dirname(nb)), `${sessionId}.jsonl`))
          : undefined;
    if (runsFile) {
      const byCell = new Map<string, ExportRunSummary[]>();
      for (const r of readRunLog(runsFile).records) {
        const list = byCell.get(r.cellId) ?? [];
        list.push({
          attempt: r.attempt, ts: r.ts, durationMs: r.durationMs, ok: r.ok,
          ...(r.error ? { error: r.error } : {}),
          actor: r.actor, trigger: r.trigger, codeSha256: r.codeSha256,
        });
        byCell.set(r.cellId, list);
      }
      cells = cells.map((c) => (c.id && byCell.has(c.id) ? { ...c, runs: byCell.get(c.id)! } : c));
    }
    const target =
      typeof params['target'] === 'string' && params['target'] !== ''
        ? params['target']
        : path.join(path.dirname(nb), '.novalab', 'sessions', `${sessionId ?? 'live'}.ipynb`);
    try {
      return exportIpynb({ cells, targetPath: target }, { notebookPath: nb, sessionId });
    } catch (e) {
      if (e instanceof IpynbError) throw new RpcFault(e.code, e.message);
      throw e;
    }
  }

  /** import.ipynb {path, targetPath?}：.ipynb → NovaLab .py 一次性转换（wx 排他不覆盖）。 */
  private importIpynb(params: Record<string, unknown>): unknown {
    const src = strParam(params, 'path');
    const target =
      typeof params['targetPath'] === 'string' && params['targetPath'] !== ''
        ? params['targetPath']
        : undefined;
    try {
      return importIpynb(src, target);
    } catch (e) {
      if (e instanceof ImportError) throw new RpcFault(e.code, e.message);
      throw e;
    }
  }

  // ---------- providers.*（P4 凭据加密存储，protocol.ts 冻结注释；apiKey 永不出桥） ----------

  /** providers.list → 全量掩码摘要（hasKey 代替 apiKey）+ activeProviderId。 */
  private providersList(): ProvidersListResult {
    return this.providers.list();
  }

  /**
   * providers.set {id?,kind,name,baseURL,model,apiKey?,maxOutputTokens?} → ProviderSummary（upsert）。
   * apiKey 明文入 → 加密落盘；省略/空串 = 保留既有密文（前端编辑不回传 key）。
   * maxOutputTokens 省略/null = 清除；非法值由 store 校验 → ERR_INVALID_PARAMS。
   */
  private providersSet(params: Record<string, unknown>): ProviderSummary {
    const kind = params['kind'];
    if (typeof kind !== 'string' || !PROVIDER_KINDS.has(kind)) {
      throw new RpcFault(
        ERR_INVALID_PARAMS,
        `providers.set：kind 必须是 anthropic-compat|openai-compat，收到: ${String(kind)}`,
      );
    }
    const id = params['id'];
    if (id !== undefined && typeof id !== 'string') {
      throw new RpcFault(ERR_INVALID_PARAMS, 'providers.set：id 必须是 string（或省略由 bridge 生成）');
    }
    const name = params['name'];
    const baseURL = params['baseURL'];
    const model = params['model'];
    for (const [field, v] of [
      ['name', name],
      ['baseURL', baseURL],
      ['model', model],
    ] as const) {
      if (typeof v !== 'string' || v.trim() === '') {
        throw new RpcFault(ERR_INVALID_PARAMS, `providers.set：${field} 必须是非空 string`);
      }
    }
    try {
      new URL(baseURL as string);
    } catch {
      throw new RpcFault(ERR_INVALID_PARAMS, `providers.set：baseURL 不是合法 URL: ${String(baseURL)}`);
    }
    const apiKey = params['apiKey'];
    if (apiKey !== undefined && typeof apiKey !== 'string') {
      throw new RpcFault(ERR_INVALID_PARAMS, 'providers.set：apiKey 必须是 string（或省略保留既有）');
    }
    try {
      return this.providers.set({
        ...(typeof id === 'string' && id !== '' ? { id } : {}),
        kind: kind as ProviderKind,
        name: (name as string).trim(),
        baseURL: (baseURL as string).trim(),
        model: (model as string).trim(),
        ...(typeof apiKey === 'string' ? { apiKey } : {}),
        maxOutputTokens: params['maxOutputTokens'] as number | null | undefined,
      });
    } catch (e) {
      if (e instanceof ProvidersStoreError) throw new RpcFault(ERR_INVALID_PARAMS, e.message);
      throw e;
    }
  }

  /** providers.delete {id} → {deleted}（幂等；删 active 时 activeProviderId 归 null）。 */
  private providersDelete(params: Record<string, unknown>): ProvidersDeleteResult {
    return this.providers.remove(strParam(params, 'id'));
  }

  /** providers.setActive {id: string|null} → {activeProviderId}；未知 id → -32602。 */
  private providersSetActive(params: Record<string, unknown>): ProvidersSetActiveResult {
    const id = params['id'];
    if (id !== null && typeof id !== 'string') {
      throw new RpcFault(ERR_INVALID_PARAMS, 'providers.setActive：id 必须是 string|null');
    }
    try {
      return { activeProviderId: this.providers.setActive(id) };
    } catch (e) {
      if (e instanceof ProvidersStoreError) throw new RpcFault(ERR_INVALID_PARAMS, e.message);
      throw e;
    }
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

type DiffEdit = Pick<StagedDiff, 'targetCellId' | 'action' | 'newCode'>;

/** 待审 insert_below 在叠加预检里的临时 cell id（采纳时才分配真实 id）。 */
const STAGED_CELL_PREFIX = 'staged-';

/**
 * diff.stage 编译预检：构造「按序应用 stack 里的待审 diff、再应用本条」后的全量 cells。
 * 与 diff.accept 的落地顺序一致：insert_below 插在目标 cell 正下方（后插入者更靠近目标）。
 */
function buildCandidateCells(
  cells: NotebookState['cells'],
  stack: StagedDiff[],
  proposal: DiffEdit,
): { id: string; code: string }[] {
  const out = cells.map((c) => ({ id: c.id, code: c.code }));
  const apply = (edit: DiffEdit, insertId: string): void => {
    const idx = out.findIndex((c) => c.id === edit.targetCellId);
    if (idx < 0) return; // 目标在暂存后被删：真实采纳时会报 unknown targetCellId
    if (edit.action === 'update') out[idx] = { id: out[idx]!.id, code: edit.newCode };
    else out.splice(idx + 1, 0, { id: insertId, code: edit.newCode });
  };
  for (const d of stack) apply(d, STAGED_CELL_PREFIX + d.diffId);
  apply(proposal, PRECHECK_CELL_ID);
  return out;
}

/** 编译错误涉及的待审 diff：其插入的临时 cell 或其 update 的目标 cell 出现在 cellIds 里。 */
function implicatedDiffs(err: CompileError, pending: StagedDiff[]): string[] {
  const ids = new Set(err.cellIds);
  return pending
    .filter((d) => ids.has(d.action === 'insert_below' ? STAGED_CELL_PREFIX + d.diffId : d.targetCellId))
    .map((d) => d.diffId);
}

const DUPLICATE_DEF_RE = /multiple definitions of '([^']+)' \(cells ([^)]+)\)/g;
const CYCLE_RE = /circular dependency: (.+)/g;

/**
 * 真实内核（dag.py）的 compileError 是换行拼接的纯字符串；agent 侧契约（StageResult、
 * M5 输出白名单）要求 {message, cellIds}。在 diff.stage 边界归一，cellIds 从消息里解析。
 */
function asCompileError(raw: unknown): CompileError | undefined {
  if (raw == null || raw === '') return undefined;
  if (typeof raw === 'object' && typeof (raw as CompileError).message === 'string') {
    const cellIds = (raw as CompileError).cellIds;
    return { message: (raw as CompileError).message, cellIds: Array.isArray(cellIds) ? cellIds.map(String) : [] };
  }
  const message = String(raw);
  const ids = new Set<string>();
  for (const [, , list] of message.matchAll(DUPLICATE_DEF_RE)) for (const id of list!.split(', ')) ids.add(id);
  for (const [, chain] of message.matchAll(CYCLE_RE)) for (const id of chain!.split(' -> ')) ids.add(id.trim());
  return { message, cellIds: [...ids] };
}

/**
 * 单赋值冲突的自纠提示：名字已被别的 cell 定义时，告诉模型「先 update 那个 cell 去掉定义，
 * 再提交本条」——第二条会带 dependsOn 入队（F2：搬移定义需要两条 diff）。
 */
function stageHint(err: CompileError, proposal: DiffEdit, pending: StagedDiff[]): { hint?: string } {
  const self = proposal.action === 'insert_below' ? PRECHECK_CELL_ID : proposal.targetCellId;
  const lines: string[] = [];
  for (const [, name, list] of err.message.matchAll(DUPLICATE_DEF_RE)) {
    const owners = list!.split(', ');
    if (!owners.includes(self)) continue;
    const others = owners
      .filter((id) => id !== self)
      .map((id) =>
        id.startsWith(STAGED_CELL_PREFIX)
          ? `the cell inserted by pending ${id.slice(STAGED_CELL_PREFIX.length)}`
          : `cell '${id}'`,
      );
    if (others.length === 0) continue;
    lines.push(
      `'${name}' is already defined in ${others.join(' and ')}. Each name may be defined in only one cell: ` +
        `to move it, first propose an update to ${others.join(' / ')} that removes the definition, ` +
        `then propose this change again (it will be queued with dependsOn).`,
    );
  }
  if (lines.length === 0) return {};
  if (pending.length > 0) lines.push(`Pending diffs considered: ${pending.map((d) => d.diffId).join(', ')}.`);
  return { hint: lines.join('\n') };
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
    ...(typeof state.baselineSha256 === 'string' ? { baselineSha256: state.baselineSha256 } : {}),
  };
}

export function toRpcError(err: unknown): { code: number; message: string; data?: unknown } {
  if (err instanceof RpcFault) return { code: err.code, message: err.message };
  if (err instanceof FsError) return { code: err.code, message: err.message };
  if (err instanceof KernelError) return {
    code: err.code || ERR_KERNEL,
    message: err.message,
    ...(err.data !== undefined ? { data: err.data } : {}),
  };
  const message = err instanceof Error ? err.message : String(err);
  return { code: ERR_INTERNAL, message };
}

// ---------- ADR-013 影子执行辅助 ----------

const SHADOW_STATUS_MESSAGES: Record<'unavailable' | 'budget-exceeded' | 'timeout' | 'cancelled' | 'crashed' | 'limit-unavailable', string> = {
  unavailable: 'Shadow execution is not available in this NovaLab build, so nothing was run.',
  'budget-exceeded': 'The shadow-run budget for this turn is used up, so nothing was run. Propose the change with what you have, or ask the user.',
  timeout: "The shadow run hit its time limit and was stopped. The user's kernel and files were not touched.",
  cancelled: "The shadow run was cancelled. The user's kernel and files were not touched.",
  crashed: "The shadow process exited unexpectedly (for example it ran out of memory). The user's kernel and files were not touched.",
  'limit-unavailable': 'Shadow execution needs an enforceable memory limit, which this system could not apply, so nothing was run.',
};

const MAX_SHADOW_EDITS = 20;
const MAX_CONTRACTS = 64;
const CONTRACT_KIND_SET: ReadonlySet<string> = new Set(CONTRACT_KINDS);

function parseShadowEdits(v: unknown): ShadowEdit[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_SHADOW_EDITS) {
    throw new RpcFault(ERR_INVALID_PARAMS, `shadow.run 需要 changes: 1..${MAX_SHADOW_EDITS} 条改动`);
  }
  return v.map((e, i) => {
    const r = asRecord(e);
    const { targetCellId, action, newCode } = r;
    if (typeof targetCellId !== 'string' || typeof newCode !== 'string' || (action !== 'update' && action !== 'insert_below')) {
      throw new RpcFault(ERR_INVALID_PARAMS, `changes[${i}] 需要 {targetCellId, action: update|insert_below, newCode}`);
    }
    return { targetCellId, action, newCode };
  });
}

function parseContracts(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v) || v.length > MAX_CONTRACTS) {
    throw new RpcFault(ERR_INVALID_PARAMS, `shadow.verify 需要 contracts: 0..${MAX_CONTRACTS} 条契约`);
  }
  return v.map((c, i) => {
    const r = asRecord(c);
    if (typeof r['kind'] !== 'string' || !CONTRACT_KIND_SET.has(r['kind'])) {
      throw new RpcFault(ERR_INVALID_PARAMS, `contracts[${i}].kind 不在已知契约种类里`);
    }
    // id 由 bridge 统一分配（结果按 id 回配 Agent 声明的 targets）
    return { ...r, id: `c${i + 1}` };
  });
}

function contractTargets(c: Record<string, unknown> | undefined): string[] {
  if (!c) return [];
  const targets = Array.isArray(c['targets']) ? c['targets'] : typeof c['target'] === 'string' ? [c['target']] : [];
  return targets.filter((t): t is string => typeof t === 'string');
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function shadowCells(ctx: { cache?: NotebookState }): CellSrc[] {
  return (ctx.cache?.cells ?? []).map((c) => ({ id: c.id, code: c.code }));
}

function tryApplyEdits(base: CellSrc[], edits: ShadowEdit[]): CellSrc[] {
  try {
    return applyEdits(base, edits);
  } catch (err) {
    throw new RpcFault(ERR_INVALID_PARAMS, err instanceof Error ? err.message : String(err));
  }
}

function firstLineOf(code: string): string {
  const line = (code.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.set(key, value);
  while (map.size > SHADOW_LEDGER_LIMIT) map.delete(map.keys().next().value as string);
}
