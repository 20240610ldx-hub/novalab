/**
 * PreviewSerializer —— 隐私硬截断出口（spec §8 / ADR-006，纯函数）。
 *
 * 规则：
 * - 任何字符串字段 >4KB（4096 字符）→ 截断至 4096 字符并追加 '…[truncated]'。
 * - schema 对象（及一切对象/数组结构）原样放行：不改形状、不删键，仅字符串字段受截断。
 * - 非字符串标量原样放行；循环引用替换为 '[circular]'。
 *
 * 所有出进程数据（给 LLM / MCP / agent 上下文）必须经过 serializePreview。
 */

export const PREVIEW_STRING_LIMIT = 4096;
export const TRUNCATION_SUFFIX = '…[truncated]';

/** 单个字符串的硬截断。 */
export function truncateString(s: string): string {
  if (s.length <= PREVIEW_STRING_LIMIT) return s;
  return s.slice(0, PREVIEW_STRING_LIMIT) + TRUNCATION_SUFFIX;
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return truncateString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = walk(v, seen);
  }
  return out;
}

/** 深度遍历任意 JSON 值，对所有字符串字段施加 4KB 硬截断。 */
export function serializePreview<T>(value: T): unknown {
  return walk(value as unknown, new WeakSet<object>());
}

/** 命名导出，便于 spec §8 "唯一出口" 引用。 */
export const PreviewSerializer = {
  serialize: serializePreview,
  truncateString,
  limit: PREVIEW_STRING_LIMIT,
  suffix: TRUNCATION_SUFFIX,
} as const;
