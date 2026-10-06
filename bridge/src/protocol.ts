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
