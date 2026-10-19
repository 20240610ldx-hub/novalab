/**
 * ADR-013 第一道 M5 闸（bridge 侧）：把影子内核的原始结果**按类型重建**为 Agent 报告。
 *
 * 只挑白名单字段、只认已知枚举、数值必须是有限数、字符串统一截断；从不 `{...raw}` 透传。
 * 影子内核（第 0 层）已经只构造摘要，这里是独立的一层：即使内核回归夹带了行数据，
 * 这里也不会转发。第二道闸（mcp/output-whitelist.ts）再按 zod 白名单剥一次。
 */

import { TRUNCATION_SUFFIX } from '../preview';
import type { CompileError } from '../protocol';

export const SHADOW_TRACEBACK_LIMIT = 8192;
const STRING_LIMIT = 512;
const MAX_CELLS = 200;
const MAX_VARS = 20;
const MAX_COLUMNS = 200;
const MAX_CONTRACTS = 64;

export type ShadowStatus =
  | 'ok'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'crashed'
  | 'unavailable'
  | 'limit-unavailable'
  | 'budget-exceeded'
  | 'compile-error';

export interface ShadowBudgetView {
  runsUsed: number;
  runsLimit: number;
  msUsed: number;
  msLimit: number;
}

export interface ShadowCellReport {
  id: string;
  role: 'upstream' | 'closure';
  ok: boolean;
  skipped?: 'side-effect' | 'blocked-upstream';
  durationMs: number;
  traceback?: string;
}

export type ColStats = Partial<Record<(typeof STAT_KEYS)[number], number>> & { suppressed?: boolean };

export interface VarSummary {
  schema: {
    type: string;
    shape?: number[];
    columns?: string[];
    dtypes?: Record<string, string>;
    dtype?: string;
    len?: number;
    columnsTruncated?: number;
  };
  stats?: { columns?: Record<string, ColStats>; values?: ColStats; truncatedColumns?: number };
}

export interface VarDelta {
  type?: { before: string | null; after: string | null };
  shape?: { before: number[] | null; after: number[] | null };
  columnsAdded?: string[];
  columnsRemoved?: string[];
  dtypeChanges?: Record<string, { before: string | null; after: string | null }>;
  stats?: Record<string, Record<string, number>>;
}

export interface ShadowVar {
  name: string;
  before?: VarSummary;
  after?: VarSummary;
  delta?: VarDelta;
}

export type ContractReason =
  | 'unknown-target'
  | 'unknown-column'
  | 'unsupported-type'
  | 'invalid-params'
  | 'evaluation-failed'
  | 'structure-mismatch';

export interface ContractResult {
  id: string;
  kind: string;
  phase?: 'before' | 'after';
  status: 'pass' | 'fail' | 'error';
  total?: number;
  violations?: number;
  /** mapping_conserved：源数据里没有映射的类别数。 */
  unmapped?: number;
  maxAbsDiff?: number;
  reason?: ContractReason;
}

export interface ShadowRunReport {
  runId: string | null;
  verificationId?: string;
  status: ShadowStatus;
  message?: string;
  before?: { cells: ShadowCellReport[] };
  after?: { plan: { changed: string[]; upstream: string[]; closure: string[] }; cells: ShadowCellReport[] };
  vars?: ShadowVar[];
  autoChecks?: ContractResult[];
  blocked?: { kind: BlockedKind; count: number }[];
  nondeterminism?: { cellId: string; reason: NondetReason }[];
  figures?: number;
  durationMs?: number;
  compileError?: CompileError;
  budget: ShadowBudgetView;
}

const STAT_KEYS = ['count', 'nullCount', 'nUnique', 'sum', 'mean', 'std', 'min', 'max', 'p05', 'p50', 'p95'] as const;
const BLOCKED_KINDS = ['file-write', 'file-delete', 'file-rename', 'network', 'subprocess', 'registry', 'process-control'] as const;
type BlockedKind = (typeof BLOCKED_KINDS)[number];
const NONDET_REASONS = ['unseeded-rng', 'wall-clock', 'entropy'] as const;
type NondetReason = (typeof NONDET_REASONS)[number];
const CONTRACT_REASONS: readonly ContractReason[] = [
  'unknown-target', 'unknown-column', 'unsupported-type', 'invalid-params', 'evaluation-failed', 'structure-mismatch',
];
export const CONTRACT_KINDS = [
  'columns_present', 'dtype', 'range', 'not_null', 'unique_key', 'row_count', 'sum_conserved', 'row_sums',
  'match_rate', 'equivalent', 'mapping_conserved', 'margins_match',
] as const;
const AUTO_KINDS = ['row_stochastic', 'non_empty', 'all_null_column', 'inf_values', 'null_rate'] as const;

type Raw = Record<string, unknown>;

function rec(v: unknown): Raw {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function int(v: unknown): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : Math.trunc(n);
}
export function cap(s: string, limit: number = STRING_LIMIT): string {
  return s.length <= limit ? s : s.slice(0, limit) + TRUNCATION_SUFFIX;
}
function str(v: unknown, limit = STRING_LIMIT): string | undefined {
  return typeof v === 'string' ? cap(v, limit) : undefined;
}
function strList(v: unknown, max = MAX_COLUMNS): string[] {
  return arr(v).filter((x): x is string => typeof x === 'string').slice(0, max).map((s) => cap(s));
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}
function intList(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(int);
  return out.every((x) => x !== undefined) ? (out as number[]) : undefined;
}

function colStats(v: unknown): ColStats {
  const r = rec(v);
  const out: ColStats = {};
  for (const k of STAT_KEYS) {
    const n = num(r[k]);
    if (n !== undefined) out[k] = n;
  }
  if (r['suppressed'] === true) out.suppressed = true;
  return out;
}

function strRecord<T>(v: unknown, map: (x: unknown) => T | undefined, max = MAX_COLUMNS): Record<string, T> {
  const out: Record<string, T> = {};
  let n = 0;
  for (const [k, x] of Object.entries(rec(v))) {
    if (n >= max) break;
    const m = map(x);
    if (m === undefined) continue;
    out[cap(k)] = m;
    n++;
  }
  return out;
}

export function varSummary(v: unknown): VarSummary | undefined {
  const r = rec(v);
  const s = rec(r['schema']);
  const type = str(s['type'], 128);
  if (!type) return undefined;
  const schema: VarSummary['schema'] = { type };
  const shape = intList(s['shape']);
  if (shape) schema.shape = shape;
  if (Array.isArray(s['columns'])) schema.columns = strList(s['columns']);
  if (s['dtypes'] !== undefined) schema.dtypes = strRecord(s['dtypes'], (x) => str(x, 64));
  const dtype = str(s['dtype'], 64);
  if (dtype) schema.dtype = dtype;
  const len = int(s['len']);
  if (len !== undefined) schema.len = len;
  const ct = int(s['columnsTruncated']);
  if (ct !== undefined) schema.columnsTruncated = ct;
  const out: VarSummary = { schema };
  if (r['stats'] !== undefined) {
    const st = rec(r['stats']);
    const stats: NonNullable<VarSummary['stats']> = {};
    if (st['columns'] !== undefined) stats.columns = strRecord(st['columns'], colStats);
    if (st['values'] !== undefined) stats.values = colStats(st['values']);
    const tc = int(st['truncatedColumns']);
    if (tc !== undefined) stats.truncatedColumns = tc;
    out.stats = stats;
  }
  return out;
}

function beforeAfter<T>(v: unknown, map: (x: unknown) => T | null): { before: T | null; after: T | null } | undefined {
  const r = rec(v);
  if (!('before' in r) && !('after' in r)) return undefined;
  return { before: map(r['before']), after: map(r['after']) };
}

function varDelta(v: unknown): VarDelta | undefined {
  const r = rec(v);
  const out: VarDelta = {};
  const t = beforeAfter(r['type'], (x) => str(x, 128) ?? null);
  if (t) out.type = t;
  const sh = beforeAfter(r['shape'], (x) => intList(x) ?? null);
  if (sh) out.shape = sh;
  if (r['columnsAdded'] !== undefined) out.columnsAdded = strList(r['columnsAdded']);
  if (r['columnsRemoved'] !== undefined) out.columnsRemoved = strList(r['columnsRemoved']);
  if (r['dtypeChanges'] !== undefined) {
    out.dtypeChanges = strRecord(r['dtypeChanges'], (x) => beforeAfter(x, (y) => str(y, 64) ?? null));
  }
  if (r['stats'] !== undefined) {
    out.stats = strRecord(r['stats'], (x) => {
      const m: Record<string, number> = {};
      for (const k of STAT_KEYS) {
        const n = num(rec(x)[k]);
        if (n !== undefined) m[k] = n;
      }
      return m;
    });
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function cellReports(v: unknown): ShadowCellReport[] {
  return arr(v)
    .slice(0, MAX_CELLS)
    .flatMap((c) => {
      const r = rec(c);
      const id = str(r['id'], 128);
      if (!id) return [];
      const out: ShadowCellReport = {
        id,
        role: oneOf(r['role'], ['upstream', 'closure'] as const) ?? 'closure',
        ok: r['ok'] === true,
        durationMs: int(r['durationMs']) ?? 0,
      };
      const skipped = oneOf(r['skipped'], ['side-effect', 'blocked-upstream'] as const);
      if (skipped) out.skipped = skipped;
      const tb = str(r['traceback'], SHADOW_TRACEBACK_LIMIT);
      if (tb) out.traceback = tb;
      return [out];
    });
}

export function contractResults(v: unknown, kinds: readonly string[] = [...CONTRACT_KINDS, ...AUTO_KINDS]): ContractResult[] {
  return arr(v)
    .slice(0, MAX_CONTRACTS)
    .flatMap((c) => {
      const r = rec(c);
      const status = oneOf(r['status'], ['pass', 'fail', 'error'] as const);
      const id = str(r['id'], 128);
      if (!status || !id) return [];
      const out: ContractResult = { id, kind: oneOf(r['kind'], kinds) ?? 'unknown', status };
      const phase = oneOf(r['phase'], ['before', 'after'] as const);
      if (phase) out.phase = phase;
      for (const k of ['total', 'violations', 'unmapped'] as const) {
        const n = int(r[k]);
        if (n !== undefined) out[k] = n;
      }
      const d = num(r['maxAbsDiff']);
      if (d !== undefined) out.maxAbsDiff = d;
      const reason = oneOf(r['reason'], CONTRACT_REASONS);
      if (reason) out.reason = reason;
      return [out];
    });
}

const DUPLICATE_DEF_RE = /multiple definitions of '([^']+)' \(cells ([^)]+)\)/g;
const CYCLE_RE = /circular dependency: (.+)/g;

/** 与 router diff.stage 同一归一化（并行包 4be321d）：纯字符串 → {message, cellIds}。 */
export function normalizeCompileError(raw: unknown): CompileError | undefined {
  if (raw == null || raw === '') return undefined;
  if (typeof raw === 'object' && typeof (raw as CompileError).message === 'string') {
    const cellIds = (raw as CompileError).cellIds;
    return { message: cap((raw as CompileError).message, 2048), cellIds: Array.isArray(cellIds) ? cellIds.map(String) : [] };
  }
  const message = String(raw);
  const ids = new Set<string>();
  for (const [, , list] of message.matchAll(DUPLICATE_DEF_RE)) for (const id of list!.split(', ')) ids.add(id);
  for (const [, chain] of message.matchAll(CYCLE_RE)) for (const id of chain!.split(' -> ')) ids.add(id.trim());
  return { message: cap(message, 2048), cellIds: [...ids] };
}

/** 运行要点（router 核验绑定用；不出进程）。 */
export interface RunFacts {
  closureOk: boolean;
  failedCells: string[];
  skippedSideEffect: string[];
  /** 改后存在的数据型变量（表 / 序列 / 数组）。 */
  dataVars: string[];
  /** 改前改后都存在的数据型变量（V3 equivalent 需覆盖）。 */
  comparable: string[];
  autoFailed: string[];
}

const DATA_TYPES = /^(DataFrame|GeoDataFrame|Series|GeoSeries|ndarray)$/;

export function buildRunReport(
  runId: string,
  raw: unknown,
  budget: ShadowBudgetView,
): { report: ShadowRunReport; facts: RunFacts } {
  const r = rec(raw);
  const cand = rec(arr(r['candidates'])[0]);
  const plan = rec(cand['plan']);
  const after = {
    plan: { changed: strList(plan['changed']), upstream: strList(plan['upstream']), closure: strList(plan['closure']) },
    cells: cellReports(cand['cells']),
  };
  const report: ShadowRunReport = { runId, status: 'ok', after, budget };
  if (r['before'] && typeof r['before'] === 'object') report.before = { cells: cellReports(rec(r['before'])['cells']) };
  const vars: ShadowVar[] = arr(cand['vars'])
    .slice(0, MAX_VARS)
    .flatMap((v) => {
      const x = rec(v);
      const name = str(x['name'], 128);
      if (!name) return [];
      const out: ShadowVar = { name };
      const b = varSummary(x['before']);
      const a = varSummary(x['after']);
      if (b) out.before = b;
      if (a) out.after = a;
      const d = varDelta(x['delta']);
      if (d) out.delta = d;
      return [out];
    });
  report.vars = vars;
  report.autoChecks = contractResults(cand['autoChecks'], AUTO_KINDS).map((c) => ({ ...c, id: c.id.startsWith('auto:') ? c.id : `auto:${c.id}` }));
  report.blocked = arr(cand['blocked']).flatMap((b) => {
    const kind = oneOf(rec(b)['kind'], BLOCKED_KINDS);
    const count = int(rec(b)['count']);
    return kind && count !== undefined ? [{ kind, count }] : [];
  });
  report.nondeterminism = arr(cand['nondeterminism']).flatMap((n) => {
    const cellId = str(rec(n)['cellId'], 128);
    const reason = oneOf(rec(n)['reason'], NONDET_REASONS);
    return cellId && reason ? [{ cellId, reason }] : [];
  });
  const figures = int(cand['figures']);
  if (figures !== undefined) report.figures = figures;
  const dur = int(cand['durationMs']);
  if (dur !== undefined) report.durationMs = dur;

  const ce = normalizeCompileError(cand['compileError']);
  const closure = new Set(after.plan.closure);
  const failedCells = after.cells.filter((c) => closure.has(c.id) && !c.ok && c.skipped !== 'side-effect').map((c) => c.id);
  const skippedSideEffect = after.cells.filter((c) => c.skipped === 'side-effect').map((c) => c.id);
  if (ce) {
    report.status = 'compile-error';
    report.compileError = ce;
  } else if (failedCells.length > 0) {
    report.status = 'failed';
  }
  const isData = (s?: VarSummary): boolean => !!s && DATA_TYPES.test(s.schema.type);
  const facts: RunFacts = {
    closureOk: !ce && failedCells.length === 0,
    failedCells,
    skippedSideEffect,
    dataVars: vars.filter((v) => isData(v.after)).map((v) => v.name),
    comparable: vars.filter((v) => isData(v.after) && isData(v.before)).map((v) => v.name),
    autoFailed: report.autoChecks.filter((c) => c.status === 'fail').map((c) => c.id),
  };
  return { report, facts };
}
