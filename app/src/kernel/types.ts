/** 内核与 notebook 的共享类型（spec §5/§6 的前端投影）。 */

export type CellStatus = 'idle' | 'running' | 'error' | 'stale';

/** code = 文件里的正式 cell；repl = 底部 REPL 输出回灌的匿名 cell（[repl] 徽章，不落盘）。 */
export type CellKind = 'code' | 'repl';

/** traceback 单帧（run.error 通知的 frames 元素，spec §6.1/§12）。 */
export interface TracebackFrame {
  file: string;
  line: number;
  fn: string;
  srcLine?: string;
}

export interface TracebackInfo {
  text: string;
  frames: TracebackFrame[];
}

/** MIME bundle：mime-type → 文本或 base64（image/png 等二进制走 base64）。 */
export type MimeBundle = Record<string, string | string[]>;

/** 一次运行累积的输出缓冲（run.stdout/stderr/mime/error/notify 通知增量填充）。 */
export interface CellOutput {
  stdout: string;
  stderr: string;
  mime: MimeBundle;
  traceback: TracebackInfo | null;
  /** run.notify kind='file-write' 的落盘路径（写入顺序，bridge/内核已去重，≤50 条，P2.9）。 */
  writes: string[];
}

export function createEmptyOutput(): CellOutput {
  return { stdout: '', stderr: '', mime: {}, traceback: null, writes: [] };
}

export function isOutputEmpty(o: CellOutput | null): boolean {
  if (!o) return true;
  return (
    o.stdout === '' &&
    o.stderr === '' &&
    o.traceback === null &&
    Object.keys(o.mime).length === 0 &&
    (o.writes?.length ?? 0) === 0
  );
}

/**
 * traceback 中最后一个属于 cell 自身代码的帧的行号（P2.9 error (line N) 徽章 /
 * 编辑器出错行装饰共用）。用户帧 = file 以 "<cell " 开头（内核 _cell_filename
 * 契约）；stdlib / site-packages 帧被跳过。无用户帧 → null（徽章退化为 "error"）。
 */
export function lastCellFrameLine(frames: readonly TracebackFrame[] | undefined): number | null {
  if (!frames) return null;
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i]!;
    if (f.file.startsWith('<cell ') && Number.isFinite(f.line) && f.line >= 1) {
      return f.line;
    }
  }
  return null;
}

export interface Cell {
  id: string;
  code: string;
  execCount: number | null;
  status: CellStatus;
  /** 本 cell 顶层定义的名字（AST 提取，内核上报）。 */
  defs: string[];
  /** 本 cell 顶层读取的名字。 */
  refs: string[];
  /** 启发式检测到副作用（写文件/外发请求）——默认不参与 auto-cascade。 */
  sideEffect: boolean;
  kind: CellKind;
  /** 最近一次运行的输出缓冲；null = 尚未运行过。 */
  output: CellOutput | null;
}

export interface DagEdge {
  from: string; // 上游 cellId（defs 方）
  to: string; // 下游 cellId（refs 方）
}

export interface ColumnSchema {
  name: string;
  dtype: string;
}

/** 变量 schema：只含结构，不含全量数据（隐私边界 M5 的前端形态）。 */
export interface VarSchema {
  name: string;
  type: string;
  shape?: number[];
  columns?: ColumnSchema[];
  len?: number;
  /** head(1).to_dict() 或 repr 截断 200 字符。 */
  preview?: string;
}

export interface RunReport {
  cellId: string;
  ok: boolean;
  cascaded: string[];
  durationMs: number;
  traceback?: string;
}

export type KernelState = 'connecting' | 'live' | 'busy' | 'restarting' | 'dead';

export interface StagedDiff {
  id: string;
  targetCellId: string;
  action: 'update' | 'insert_below';
  newCode: string;
  rationale?: string;
  origin: 'agent' | 'user';
  state: 'proposed' | 'edited-staged' | 'accepted' | 'rejected';
}

/* ---- bridge 协议载荷（spec §6.1 的前端投影；字段名与 bridge 工作线约定一致） ---- */

/** notebook.open 的响应，也作为 notebook.state 通知的载荷（外部改动热推送）。 */
export interface NotebookStatePayload {
  cells: Cell[];
  dagEdges: DagEdge[];
  schemas: VarSchema[];
  staleSet: string[];
  execCounts?: Record<string, number | null>;
}

/** cell.save 的响应：重算后的 DAG 与失效集合；compileError = 编译错（不进运行队列）。 */
export interface CellSaveResult {
  dagEdges: DagEdge[];
  staleSet: string[];
  compileError?: string;
}

/** kernel.status 通知载荷。state=idle 在前端映射为 KernelState 'live'。 */
export interface KernelStatusPayload {
  state: 'idle' | 'busy' | 'restarting' | 'dead';
  queueDepth?: number;
}

/**
 * run.notify 通知载荷（P2.9）：内核结构化副作用事件。kind='file-write' 时
 * path 为写入文件的绝对路径（reducer 追加进 CellOutput.writes，去重限 50 条）。
 */
export interface RunNotifyPayload {
  cellId: string;
  kind: 'file-write' | (string & NonNullable<unknown>);
  path?: string;
}

/** kernel.repl 的响应（输出同时以 run.* 通知流式推送，其 cellId 恒为 "repl"）。 */
export interface ReplResult {
  /** 仅信息字段：bridge/内核不使用前端匿名 id，run.* 的 cellId 恒为 "repl"。 */
  cellId?: string;
  ok?: boolean;
  stdout?: string;
  stderr?: string;
  mime?: MimeBundle;
  traceback?: string;
  frames?: TracebackFrame[];
}
