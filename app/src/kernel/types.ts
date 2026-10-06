/** 内核与 notebook 的共享类型（spec §5/§6 的前端投影）。 */

export type CellStatus = 'idle' | 'running' | 'error' | 'stale';

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
