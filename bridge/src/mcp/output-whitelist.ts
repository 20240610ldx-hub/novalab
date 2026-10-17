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
    z.object({ diffId: z.string(), dependsOn: z.array(z.string()).optional() }),
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
} satisfies Record<AgentToolName, z.ZodType>;

/** 顶层字段的专属上限（Infinity = 不截断）；其余字符串一律 PREVIEW_STRING_LIMIT。 */
const TOP_LEVEL_LIMITS: Partial<Record<AgentToolName, Record<string, number>>> = {
  get_cell_output: { traceback: TRACEBACK_CHAR_LIMIT },
  execute_cell: { traceback: TRACEBACK_CHAR_LIMIT },
  get_cell_code: { code: Number.POSITIVE_INFINITY },
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
  limit: number,
  truncated: string[],
): unknown {
  if (typeof value === 'string') {
    const capped = capString(value, limit);
    if (capped === null) return value;
    truncated.push(path || '(root)');
    return capped;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => capDeep(v, `${path}[${i}]`, PREVIEW_STRING_LIMIT, truncated));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        capDeep(v, path ? `${path}.${k}` : k, PREVIEW_STRING_LIMIT, truncated),
      ]),
    );
  }
  return value;
}

function capOutput(tool: string, value: unknown, truncated: string[]): unknown {
  const limits = TOP_LEVEL_LIMITS[tool as AgentToolName];
  if (!limits || !value || typeof value !== 'object' || Array.isArray(value)) {
    return capDeep(value, '', PREVIEW_STRING_LIMIT, truncated);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      const limit = limits[k] ?? PREVIEW_STRING_LIMIT;
      return [k, capDeep(v, k, limit, truncated)];
    }),
  );
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
