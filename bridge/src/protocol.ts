/**
 * NovaLab 协议类型（spec §6.1 前端↔Bridge WS / §6.2 Bridge↔novakernel stdio）。
 *
 * 本文件是两条工作线（bridge TS / py novakernel）共同冻结的契约单一来源：
 * - 前端 WS：JSON-RPC 2.0，请求 RpcRequest / 响应 RpcResponse / 通知 RpcNotification。
 * - 内核 stdio：JSON-lines，请求 KernelRequest {id,method,params}，
 *   stdout 回 KernelResponse {id,result|error} 与无 id 通知（run.* 流式）。
 */

// ---------- JSON-RPC 框架（§6.1） ----------

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: RpcError;
}

export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/** 标准 JSON-RPC 错误码。 */
export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_INTERNAL = -32603;
/** 服务端自定义：内核返回错误 / 内核进程不可用 / 内核已死。 */
export const ERR_KERNEL = -32000;
/** 服务端自定义：尚未 notebook.open。 */
export const ERR_NO_NOTEBOOK = -32001;

// ---------- 领域模型 ----------

export type KernelState = 'idle' | 'busy' | 'restarting' | 'dead';

export interface CellInfo {
  id: string;
  code: string;
  execCount: number;
  defs: string[];
  refs: string[];
  /**
   * 内核启发式副作用检测（spec §6.2：load_file/set_cells 回传 cells 携带；
   * L-2 修复：Bridge 缓存/映射必须保留透传——前端 CellHeader/CascadeAskDialog
   * 的 ⚡ side-effect 徽章数据源）。旧内核/新建 cell 缺省时按 false 处理。
   */
  sideEffect?: boolean;
}

export interface DagEdge {
  from: string;
  to: string;
}

/** introspect 产出的变量 schema（spec §5）。 */
export interface VarSchema {
  name: string;
  type: string;
  shape?: number[];
  columns?: string[];
  dtypes?: Record<string, string>;
  len?: number;
  preview?: unknown;
}

/** notebook.state 响应 = 前端 Zustand store 的初始快照（spec §6.1）。 */
export interface NotebookState {
  cells: CellInfo[];
  dagEdges: DagEdge[];
  schemas: VarSchema[];
  staleSet: string[];
  execCounts: Record<string, number>;
}

// ---------- notebook.* 多 tab 多内核（P3.1，intent S1 / A-2 #18，本任务冻结） ----------
//
// 增量式协议：既有 cell.* / kernel.* / diff.* / agent.* 方法一律作用于「焦点
// notebook」，语义不变；本节新增的方法管理"同时打开的多个 notebook（= 多个并存的
// 内核进程）"，全部为**追加**，不改动任何既有方法的请求/响应形状，唯一例外是
// notebook.open 的响应体（见下），它由裸 NotebookState 升级为 {notebookId, state}
// 以携带新分配的 notebook 句柄。
//
//   notebook.open   {path}         → NotebookOpenResult {notebookId, state}
//                                    同一路径重复 open = 聚焦既有 tab（不重启内核）。
//   notebook.list   {}             → NotebookSummary[]（TabBar 数据源；含每内核 rssMB 水位）
//   notebook.switch {notebookId}   → NotebookSwitchResult {notebookId, state}
//                                    切 router 焦点 + 广播 focus.changed {notebookId}；
//                                    不杀内核（进程保活，切回状态即在）。
//   notebook.close  {notebookId}   → NotebookCloseResult {notebookId, closed:true}
//                                    未保存改动先 save_file → 内核 shutdown → 会话
//                                    ended('shutdown')（进 SessionBar 历史）→ 摘除 tab。
//   focus.changed   {notebookId}   （bridge → 前端通知）焦点切换，前端 setActiveId。
//
// 内核进程按「1 文件 = 1 进程」并存（MultiSupervisor: Map<path, KernelSupervisor>）。
// 只有**焦点** notebook 的内核事件（run.* / kernel.status / kernel.schemas /
// notebook.state）被广播给前端；后台 notebook 的内核事件仍刷新 bridge 侧缓存，
// 在 notebook.switch 时随响应体的全量 state 回灌前端（避免给通知加 notebookId 打标、
// 保持既有广播形状逐字兼容）。ended（内核 dead / 会话结束）的 tab = view-only。

/** notebook.open 响应（P3.1）：新分配（或既有）notebook 句柄 + 初始状态快照。 */
export interface NotebookOpenResult {
  notebookId: string;
  state: NotebookState;
}

/**
 * notebook.list 条目（P3.1，TabBar 数据源）。
 * rssMB = 该内核进程的常驻内存（MB）水位；平台不可采样时为 null——
 * Windows 无 /proc，且 uv run 的 pid 是包装进程而非 python 本体，采样意义有限，
 * 故仅 Linux 走 /proc/<pid>/status 近似，其余留 null（见 supervisor.ts defaultRssSampler）。
 */
export interface NotebookSummary {
  notebookId: string;
  path: string;
  kernelState: KernelState;
  cellCount: number;
  /** 内核已死 / 会话结束 → view-only（前端灰化 tab、禁用写路径）。 */
  ended?: boolean;
  rssMB: number | null;
}

/** notebook.switch 响应：新焦点句柄 + 全量状态（前端 hydrate 焦点视图）。 */
export interface NotebookSwitchResult {
  notebookId: string;
  state: NotebookState;
}

/** notebook.close 响应。 */
export interface NotebookCloseResult {
  notebookId: string;
  closed: true;
}

/** focus.changed 通知载荷（bridge → 前端）：焦点 notebook 已切换。 */
export interface FocusChangedParams {
  notebookId: string;
}

/** DAG 编译错（环 / 多重定义，spec §5/§12）。 */
export interface CompileError {
  message: string;
  cellIds: string[];
}

/** cell.save 响应（发给前端的子集）。 */
export interface SaveResult {
  dagEdges: DagEdge[];
  staleSet: string[];
  compileError?: CompileError;
}

/** 内核 set_cells 的完整结果：额外回传重算后的 cells（defs/refs），供 Bridge 缓存。 */
export interface SetCellsResult extends SaveResult {
  cells?: CellInfo[];
}

/** cell.run / kernel.repl 响应（RunReport）。 */
export interface RunReport {
  cellId: string;
  ok: boolean;
  cascaded: string[];
  durationMs: number;
  traceback?: string;
}

// ---------- 通知 payload（bridge → 前端） ----------

export interface RunStartedParams {
  cellId: string;
  execCount?: number;
}

export interface RunStreamParams {
  cellId: string;
  text: string;
}

export interface RunMimeParams {
  cellId: string;
  mime: string;
  data: unknown;
}

export interface RunErrorParams {
  cellId: string;
  traceback: string;
  frames: { file: string; line: number; fn: string; srcLine: string }[];
}

export interface RunDoneParams {
  cellId: string;
  execCount: number;
  cascaded: string[];
  durationMs: number;
}

/**
 * run.notify：内核结构化副作用通知（P2.9）。目前唯一 kind 是 'file-write'——
 * exec 窗口内以写方式打开的文件（绝对路径，内核已去重、单次 exec ≤50 条）；
 * kind 保持开放字符串以便后续扩展（如 network-request）。
 */
export type RunNotifyKind = 'file-write';

export interface RunNotifyParams {
  cellId: string;
  kind: RunNotifyKind | (string & NonNullable<unknown>);
  /** kind='file-write' 时为写入文件的绝对路径。 */
  path?: string;
}

export interface KernelStatusParams {
  state: KernelState;
  queueDepth: number;
}

/**
 * kernel.schemas 通知（L-3 修复）：run.done 后 Bridge 自动 introspect 并广播
 * 最新变量 schemas——前端 store.schemas 随之刷新（FixCard"traceback + N schemas"
 * 的附着数据源，此前 schemas 仅在 notebook.open 时更新一次）。
 */
export interface KernelSchemasParams {
  schemas: VarSchema[];
}

export type DiffAction = 'update' | 'insert_below';
export type DiffStatus = 'proposed' | 'accepted' | 'rejected';

export interface StagedDiff {
  diffId: string;
  targetCellId: string;
  action: DiffAction;
  newCode: string;
  rationale?: string;
  status: DiffStatus;
  createdAt: string;
}

export interface DiffUpdatedParams {
  diffs: StagedDiff[];
}

// ---------- fs.*（P2.8 工作区文件管理，intent M8 / spec 附录 A-2） ----------

/** fs.list 条目（目录在前、各自按名排序，bridge/src/fs.ts 负责排序）。 */
export interface FsEntry {
  name: string;
  kind: 'dir' | 'file';
  /** 文件字节数；目录恒 0。 */
  size: number;
  /** ISO-8601 修改时间。 */
  mtime: string;
}

/** fs.setRoot / fs.root 响应。 */
export interface FsRootResult {
  root: string | null;
}

// ---------- session.*（P2.8 会话管理，intent M9 / spec §11 / A-2 #12-14） ----------

/** `.novalab/sessions/index.json` 条目：一个内核生命周期的元数据。 */
export interface SessionMeta {
  id: string;
  startedAt: string;
  /** 未结束（live）时缺省。 */
  endedAt?: string;
  cellCount: number;
  source: 'local' | 'agent';
}

/** 会话快照 cell（`<sessionId>.snapshot.json`）：全量 cell + 输出缓冲摘要。 */
export interface SessionSnapshotCell {
  id: string;
  code: string;
  execCount: number;
  defs: string[];
  refs: string[];
  /** 最近一次 run 的输出摘要（stdout/stderr 已在累积期 8KB 截断；mime 只留键名；writes 为 P2.9 文件写入通知路径）。 */
  output: {
    stdout: string;
    stderr: string;
    traceback: string | null;
    mimeKeys: string[];
    writes: string[];
  };
}

/** 会话结束快照全文。 */
export interface SessionSnapshot {
  sessionId: string;
  notebookPath: string;
  startedAt: string;
  endedAt: string;
  endReason?: SessionEndReason;
  cells: SessionSnapshotCell[];
}

/** session.open 响应：只读投影（live 会话 endedAt 为 null）。 */
export interface SessionOpenResult {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  cells: SessionSnapshotCell[];
  readOnly: true;
}

/** 会话结束原因（session.ended 通知）。 */
export type SessionEndReason = 'restart' | 'crash' | 'switch' | 'shutdown';

export interface SessionStartedParams {
  sessionId: string;
  startedAt: string;
  notebookPath: string;
}

export interface SessionEndedParams {
  sessionId: string;
  endedAt: string;
  reason: SessionEndReason;
}

// ---------- providers.*（P4 凭据加密存储 + LLM 代理，ADR-008，本任务冻结） ----------
//
//   providers.list     {}                          → ProvidersListResult
//   providers.set      {id?,kind,name,baseURL,     → ProviderSummary（upsert；apiKey
//                       model,apiKey?}               明文入→AES-256-GCM 加密落盘
//   providers.delete   {id}                        → ProvidersDeleteResult（幂等）
//   providers.setActive {id: string|null}          → ProvidersSetActiveResult
//
// 纪律：**apiKey 永不出桥** —— list/set 的响应只有 hasKey:boolean 掩码；
// set 的 apiKey 省略或空串 = 保留既有密文（前端编辑不回传 key）。
// 存储 .novalab/providers.json（0600），损坏 → 空态降级不抛（bridge/src/providers-store.ts）。
// LLM 请求本身不走 rpc：前端 SDK baseURL 指向 bridge 侧 HTTP 代理
// http://127.0.0.1:7789/llm/<providerId>/v1（bridge/src/llm-proxy.ts，SSE 流式透传，
// 真 key 由代理按 kind 注入上游请求头）。

/** provider 协议类型（与前端 providers.ts ProviderId 一致）。 */
export type ProviderKind = 'anthropic-compat' | 'openai-compat';

/** providers.list / providers.set 的响应条目：无 apiKey，只有 hasKey 掩码。 */
export interface ProviderSummary {
  id: string;
  kind: ProviderKind;
  name: string;
  baseURL: string;
  model: string;
  hasKey: boolean;
}

export interface ProvidersListResult {
  providers: ProviderSummary[];
  /** null = 无用户选择（前端走 dev-env 兜底）。 */
  activeProviderId: string | null;
}

export interface ProvidersDeleteResult {
  deleted: boolean;
}

export interface ProvidersSetActiveResult {
  activeProviderId: string | null;
}

// ---------- 内核 stdio wire 契约（§6.2，与 py 工作线共同冻结） ----------

/**
 * 内核方法集（内核只说"执行语"，不含文件/diff 概念之外的东西）：
 * - ping            → {pong:true}
 * - load_file       {path}                → NotebookState
 * - save_file       {path, cells}         → {ok:true}
 * - set_cells       {cells:[{id,code}]}   → SetCellsResult（含重算 cells）
 * - exec_cell       {cellId, cascade}     → RunReport（期间发 run.* 通知）
 * - exec_repl       {code}                → RunReport（cellId="repl"，输出经 run.* 通知回灌）
 * - introspect      {}                    → {schemas: VarSchema[]}
 * - shutdown        → {ok:true} 后进程退出
 *
 * 内核通知（stdout 无 id 行）：run.stdout/run.stderr {cellId,text}、
 * run.mime {cellId,mime,data}、run.error {cellId,traceback,frames}、
 * run.notify {cellId,kind,path}（kind='file-write'，P2.9 写事件）、
 * run.done {cellId,execCount,cascaded,durationMs}、run.started {cellId}（可选）。
 */
export type KernelMethod =
  | 'ping'
  | 'load_file'
  | 'save_file'
  | 'set_cells'
  | 'exec_cell'
  | 'exec_repl'
  | 'introspect'
  | 'shutdown';

export interface KernelRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface KernelResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface KernelNotificationMsg {
  method: string;
  params?: unknown;
}

export type KernelWireMessage = KernelResponse | KernelNotificationMsg;

export function isKernelResponse(msg: KernelWireMessage): msg is KernelResponse {
  return typeof (msg as KernelResponse).id === 'number';
}
