/**
 * M5 第二道闸：按工具的输出白名单（spec §7/§8，ADR-012 D3）。
 *
 * 第一道闸在 router 的 agent.* 出口（serializePreview 4KB、agent.cellOutput 只回
 * traceback + mimeKeys）。本模块与 harness 无关，在工具结果交给模型之前再过一次：
 *  - 已知工具：zod 输出白名单（z.object 默认 strip，白名单外的键一律丢弃并记入 droppedKeys）
 *    → 字符串字段截断；
 *  - 未知工具 / 形状不符（含非对象、缺字段、类型错）：fail closed，整条替换为占位文本；
 *  - 调用方可传 envelope（如 app safeRpc 的 {toolError}/{bridgeUpgradeNeeded}），同样 strip + 截断。
 *
 * 截断语义与 PreviewSerializer 对齐（按字符数，追加 TRUNCATION_SUFFIX）：一般字符串 4KB，
 * traceback 8KB（= router.OUTPUT_CHAR_LIMIT），get_cell_code 的源码原文不截断（spec §7 工具 6）。
 * 字段级上限只认**顶层键**——嵌套在 preview 等任意结构里的同名键不享受豁免。
 * 已被第一道闸截过（limit + 后缀）的字符串原样放行，不叠加第二个后缀。
 *
 * 与 tools.ts 同约束：只依赖 zod 与纯函数模块 ../preview，零 bridge 运行时依赖（app 侧经
 * '@novalab/bridge/mcp-tools' 消费）。
 */

import { z } from 'zod';
import { PREVIEW_STRING_LIMIT, TRUNCATION_SUFFIX } from '../preview';
// 只取类型：tools.ts 会 re-export 本模块，值级导入会成环
import type { AgentToolName } from './tools';

/** = router.OUTPUT_CHAR_LIMIT（不 import router：会把内核监督链拉进 app bundle）。 */
export const TRACEBACK_CHAR_LIMIT = 8192;
/** get_run_history 每次尝试的代码变化行上限（= run-log.RUN_DIFF_CHAR_LIMIT；本模块不 import bridge 运行时）。 */
export const RUN_DIFF_CHAR_LIMIT = 2000;

export const REDACTED_TEXT = '[novalab] tool result withheld by privacy whitelist (M5)';

const varSchema = z.object({
  name: z.string(),
  type: z.string(),
  shape: z.array(z.number()).optional(),
  columns: z.array(z.string()).optional(),
  dtypes: z.record(z.string(), z.string()).optional(),
  len: z.number().optional(),
  preview: z.unknown().optional(),
});

const compileError = z.object({ message: z.string(), cellIds: z.array(z.string()) });

// ---------- ADR-013 影子报告（对齐 shadow/report.ts 的类型重建；这里再按白名单剥一次） ----------

const diffVerification = z.object({
  status: z.enum(['verified', 'unverified', 'failed', 'expired', 'not-required']),
  level: z.enum(['V0', 'V1', 'V2', 'V3']),
  missing: z.array(z.string()),
});
const shadowBudget = z.object({ runsUsed: z.number(), runsLimit: z.number(), msUsed: z.number(), msLimit: z.number() });
const shadowCell = z.object({
  id: z.string(),
  role: z.enum(['upstream', 'closure']),
  ok: z.boolean(),
  skipped: z.enum(['side-effect', 'blocked-upstream']).optional(),
  durationMs: z.number(),
  traceback: z.string().optional(),
});
const colStats = z.object({
  count: z.number().optional(),
  nullCount: z.number().optional(),
  nUnique: z.number().optional(),
  sum: z.number().optional(),
  mean: z.number().optional(),
  std: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  p05: z.number().optional(),
  p50: z.number().optional(),
  p95: z.number().optional(),
  suppressed: z.boolean().optional(),
});
const shadowVarSummary = z.object({
  schema: z.object({
    type: z.string(),
    shape: z.array(z.number()).optional(),
    columns: z.array(z.string()).optional(),
    dtypes: z.record(z.string(), z.string()).optional(),
    dtype: z.string().optional(),
    len: z.number().optional(),
    columnsTruncated: z.number().optional(),
  }),
  stats: z
    .object({
      columns: z.record(z.string(), colStats).optional(),
      values: colStats.optional(),
      truncatedColumns: z.number().optional(),
    })
    .optional(),
});
const beforeAfter = <T extends z.ZodType>(t: T) => z.object({ before: t.nullable(), after: t.nullable() });
const shadowVarDelta = z.object({
  type: beforeAfter(z.string()).optional(),
  shape: beforeAfter(z.array(z.number())).optional(),
  columnsAdded: z.array(z.string()).optional(),
  columnsRemoved: z.array(z.string()).optional(),
  dtypeChanges: z.record(z.string(), beforeAfter(z.string())).optional(),
  stats: z.record(z.string(), z.record(z.string(), z.number())).optional(),
});
const contractResult = z.object({
  id: z.string(),
  kind: z.string(),
  phase: z.enum(['before', 'after']).optional(),
  status: z.enum(['pass', 'fail', 'error']),
  total: z.number().optional(),
  violations: z.number().optional(),
  unmapped: z.number().optional(),
  maxAbsDiff: z.number().optional(),
  reason: z
    .enum(['unknown-target', 'unknown-column', 'unsupported-type', 'invalid-params', 'evaluation-failed', 'structure-mismatch'])
    .optional(),
});
const shadowRunReport = z.object({
  runId: z.string().nullable(),
  verificationId: z.string().optional(),
  status: z.enum([
    'ok', 'failed', 'timeout', 'cancelled', 'crashed', 'unavailable', 'limit-unavailable', 'budget-exceeded', 'compile-error',
  ]),
  message: z.string().optional(),
  before: z.object({ cells: z.array(shadowCell) }).optional(),
  after: z
    .object({
      plan: z.object({ changed: z.array(z.string()), upstream: z.array(z.string()), closure: z.array(z.string()) }),
      cells: z.array(shadowCell),
    })
    .optional(),
  vars: z
    .array(z.object({ name: z.string(), before: shadowVarSummary.optional(), after: shadowVarSummary.optional(), delta: shadowVarDelta.optional() }))
    .optional(),
  autoChecks: z.array(contractResult).optional(),
  blocked: z
    .array(
      z.object({
        kind: z.enum(['file-write', 'file-delete', 'file-rename', 'network', 'subprocess', 'registry', 'process-control']),
        count: z.number(),
      }),
    )
    .optional(),
  nondeterminism: z.array(z.object({ cellId: z.string(), reason: z.enum(['unseeded-rng', 'wall-clock', 'entropy']) })).optional(),
  figures: z.number().optional(),
  durationMs: z.number().optional(),
  compileError: compileError.optional(),
  budget: shadowBudget,
});

/** 每个工具允许出进程的输出形状（对齐 router.ts AgentContext / CellOutputSnapshot / StageResult / RunReport / AgentCellSummary）。 */
export const TOOL_OUTPUT_WHITELIST = {
  get_notebook_context: z.object({
    dagEdges: z.array(z.object({ from: z.string(), to: z.string() })),
    schemas: z.array(varSchema),
    focusCellId: z.string().nullable(),
    staleSet: z.array(z.string()),
  }),
  get_cell_output: z.object({
    traceback: z.string().nullable(),
    mimeKeys: z.array(z.string()),
  }),
  propose_code_change: z.union([
    z.object({ diffId: z.string(), dependsOn: z.array(z.string()).optional(), verification: diffVerification.optional() }),
    z.object({
      rejected: z.literal(true),
      reason: compileError,
      hint: z.string().optional(),
      conflictsWith: z.array(z.string()).optional(),
    }),
  ]),
  execute_cell: z.union([
    z.object({
      cellId: z.string(),
      ok: z.boolean(),
      cascaded: z.array(z.string()),
      durationMs: z.number(),
      traceback: z.string().optional(),
    }),
    z.object({
      denied: z.literal(true),
      reason: z.enum(['no-confirmer', 'user-declined', 'timeout', 'focus-changed', 'code-changed']),
      message: z.string(),
    }),
  ]),
  list_cells: z.array(
    z.object({
      id: z.string(),
      execCount: z.number(),
      status: z.enum(['stale', 'error', 'ok', 'idle']),
      firstLine: z.string(),
      defs: z.array(z.string()),
      refs: z.array(z.string()),
    }),
  ),
  get_cell_code: z.object({ cellId: z.string(), code: z.string() }),
  shadow_run: z.union([
    shadowRunReport,
    z.object({
      denied: z.literal(true),
      reason: z.enum(['no-confirmer', 'user-declined', 'timeout', 'focus-changed']),
      message: z.string(),
    }),
  ]),
  verify: z.object({
    runId: z.string(),
    verificationId: z.string().optional(),
    status: z.enum(['pass', 'fail', 'error', 'not-retained', 'timeout', 'crashed', 'cancelled', 'unavailable']),
    contracts: z.array(contractResult),
  }),
  get_run_history: z.object({
    cellId: z.string(),
    totalAttempts: z.number(),
    attempts: z.array(
      z.object({
        attempt: z.number(),
        ok: z.boolean(),
        actor: z.enum(['user', 'agent']),
        trigger: z.enum(['direct', 'cascade', 'accept', 'repl']),
        durationMs: z.number(),
        error: z.object({ name: z.string(), line: z.number().optional() }).optional(),
        codeChanged: z.boolean(),
        diff: z.string().optional(),
      }),
    ),
  }),
} satisfies Record<AgentToolName, z.ZodType>;

/**
 * 字段的专属上限，按完整路径匹配（数组下标归一为 []；Infinity = 不截断）；其余字符串一律 PREVIEW_STRING_LIMIT。
 * 只列白名单里有确定类型的路径——任意结构（preview 等）里的同名键不享受豁免。
 */
const PATH_LIMITS: Partial<Record<AgentToolName, Record<string, number>>> = {
  get_cell_output: { traceback: TRACEBACK_CHAR_LIMIT },
  execute_cell: { traceback: TRACEBACK_CHAR_LIMIT },
  get_cell_code: { code: Number.POSITIVE_INFINITY },
  get_run_history: { 'attempts[].diff': RUN_DIFF_CHAR_LIMIT },
  shadow_run: { 'after.cells[].traceback': TRACEBACK_CHAR_LIMIT, 'before.cells[].traceback': TRACEBACK_CHAR_LIMIT },
};

export interface ToolOutputGateResult {
  /** 过闸后的输出（redacted 时为 REDACTED_TEXT）。 */
  output: unknown;
  /** 白名单外被丢弃的键路径（非空 = bridge 第一道闸有回归）。 */
  droppedKeys: string[];
  /** 被截断的字段路径。 */
  truncatedFields: string[];
  /** 整条被替换为占位（未知工具 / 形状不符）。 */
  redacted: boolean;
}

function capString(s: string, limit: number): string | null {
  if (s.length <= limit) return null;
  // 第一道闸已截过（恰为 limit + 后缀）：原样放行，避免 '…[truncated]…[truncated]'
  if (s.length <= limit + TRUNCATION_SUFFIX.length && s.endsWith(TRUNCATION_SUFFIX)) return null;
  return s.slice(0, limit) + TRUNCATION_SUFFIX;
}

function capDeep(
  value: unknown,
  path: string,
  limits: Record<string, number>,
  truncated: string[],
): unknown {
  if (typeof value === 'string') {
    const capped = capString(value, limits[path.replace(/\[\d+\]/g, '[]')] ?? PREVIEW_STRING_LIMIT);
    if (capped === null) return value;
    truncated.push(path || '(root)');
    return capped;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => capDeep(v, `${path}[${i}]`, limits, truncated));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        capDeep(v, path ? `${path}.${k}` : k, limits, truncated),
      ]),
    );
  }
  return value;
}

function capOutput(tool: string, value: unknown, truncated: string[]): unknown {
  return capDeep(value, '', PATH_LIMITS[tool as AgentToolName] ?? {}, truncated);
}

/** raw 里有、clean 里没有的键路径（只比对象键；数组按下标展开）。 */
function diffKeys(raw: unknown, clean: unknown, prefix = ''): string[] {
  if (Array.isArray(raw) && Array.isArray(clean)) {
    return raw.flatMap((r, i) => diffKeys(r, clean[i], `${prefix}[${i}]`));
  }
  if (raw && typeof raw === 'object' && clean && typeof clean === 'object') {
    const out: string[] = [];
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (!Object.prototype.hasOwnProperty.call(clean, k)) out.push(path);
      else out.push(...diffKeys(v, (clean as Record<string, unknown>)[k], path));
    }
    return out;
  }
  return [];
}

const KNOWN = new Set<string>(Object.keys(TOOL_OUTPUT_WHITELIST));

/**
 * 单条工具输出过白名单（纯函数）。
 * envelope：调用方自有的非数据结果形状（错误 / 升级提示），先于工具白名单匹配。
 */
export function sanitizeToolOutput(
  tool: string,
  value: unknown,
  opts: { envelope?: z.ZodType } = {},
): ToolOutputGateResult {
  const redacted = (): ToolOutputGateResult => ({
    output: REDACTED_TEXT,
    droppedKeys: [],
    truncatedFields: [],
    redacted: true,
  });
  if (!KNOWN.has(tool)) return redacted();

  let parsed = opts.envelope?.safeParse(value);
  if (!parsed?.success) parsed = TOOL_OUTPUT_WHITELIST[tool as AgentToolName].safeParse(value);
  if (!parsed.success) return redacted();

  const truncatedFields: string[] = [];
  const droppedKeys = diffKeys(value, parsed.data);
  const output = capOutput(tool, parsed.data, truncatedFields);
  return { output, droppedKeys, truncatedFields, redacted: false };
}
