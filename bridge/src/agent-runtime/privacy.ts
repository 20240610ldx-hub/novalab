/**
 * M5 隐私白名单 —— pi transformContext 的第二道闸 + 审计（ADR-012 spike）。
 *
 * 第一道闸仍在 router 的 agent.* 出口（serializePreview 4KB、agent.cellOutput 只回
 * traceback + mimeKeys）。这里在**每次 LLM 请求之前**再对上下文里的全部 toolResult
 * 做一次按工具的输出白名单：
 *  - 已知工具：JSON 解析 → zod 输出白名单（默认 strip，未列出的键一律丢弃）→ 字符串截断；
 *  - 解析失败 / 形状不符 / 未知工具：fail closed，整条替换为 redacted 占位；
 *  - isError 的工具结果（异常文本）：只截断，不解析；
 *  - 图片等非文本块：丢弃（二进制不在白名单）。
 *
 * transformContext 每轮都会对整段 transcript 跑一遍，所以审计按 toolCallId 去重：
 * 每个工具结果只记一条（字节数 / 丢弃的键 / 是否截断 / 是否 redacted）。
 * 白名单与 spec §7/§8 对齐；bridge 出口若回归（比如误把 stdout 塞回 agent.cellOutput），
 * 这里会丢掉并在审计里留下 droppedKeys —— 见 runtime.test.ts 的故障注入用例。
 */

import { z } from 'zod';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { AGENT_TOOL_NAMES, type AgentToolName } from '../mcp/tools';
import { PREVIEW_STRING_LIMIT, TRUNCATION_SUFFIX } from '../preview';
/** = router.OUTPUT_CHAR_LIMIT（不 import router，避免把内核监督链拉进本模块；单测钉住相等）。 */
export const TRACEBACK_CHAR_LIMIT = 8192;

/** 字段级上限：一般字符串 4KB（spec §8），traceback 8KB（spec §7 工具 2），源码原文不截断（spec §7 工具 6）。 */
const FIELD_LIMITS: Record<string, number> = { traceback: TRACEBACK_CHAR_LIMIT };
const UNCAPPED_FIELDS = new Set(['code']);

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

/** 每个工具允许出进程的输出形状（z.object 默认 strip：白名单外的键被丢弃）。 */
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
    z.object({ diffId: z.string() }),
    z.object({ rejected: z.literal(true), reason: compileError }),
  ]),
  execute_cell: z.object({
    cellId: z.string(),
    ok: z.boolean(),
    cascaded: z.array(z.string()),
    durationMs: z.number(),
    traceback: z.string().optional(),
  }),
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

export interface PrivacyAuditEntry {
  toolCallId: string;
  tool: string;
  /** 实际进入 LLM 请求的文本字节数（过闸之后）。 */
  bytes: number;
  /** 白名单外被丢弃的键路径（非空 = bridge 第一道闸有回归）。 */
  droppedKeys: string[];
  truncatedFields: string[];
  /** 整条被替换为占位（未知工具 / 形状不符 / 非 JSON）。 */
  redacted: boolean;
  isError: boolean;
}

const enc = new TextEncoder();
const byteLen = (s: string): number => enc.encode(s).length;
const KNOWN = new Set<string>(AGENT_TOOL_NAMES);

/** 已被第一道闸截过（limit + 后缀）的字段原样放行，不叠加第二个后缀。 */
function overLimit(s: string, limit: number): boolean {
  return s.length > limit + TRUNCATION_SUFFIX.length;
}

/** 深度截断字符串字段，记下被截的字段名。 */
function capDeep(value: unknown, truncated: string[], key = ''): unknown {
  if (typeof value === 'string') {
    if (UNCAPPED_FIELDS.has(key)) return value;
    const limit = FIELD_LIMITS[key] ?? PREVIEW_STRING_LIMIT;
    if (!overLimit(value, limit)) return value;
    truncated.push(key || '(root)');
    return value.slice(0, limit) + TRUNCATION_SUFFIX;
  }
  if (Array.isArray(value)) return value.map((v) => capDeep(v, truncated, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, capDeep(v, truncated, k)]),
    );
  }
  return value;
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
      if (!(k in (clean as Record<string, unknown>))) out.push(path);
      else out.push(...diffKeys(v, (clean as Record<string, unknown>)[k], path));
    }
    return out;
  }
  return [];
}

export const REDACTED_TEXT = '[novalab] tool result withheld by privacy whitelist (M5)';

/** 单条工具结果文本过白名单（纯函数，供 transformContext 与单测共用）。 */
export function sanitizeToolResultText(
  tool: string,
  text: string,
  isError: boolean,
): { text: string; droppedKeys: string[]; truncatedFields: string[]; redacted: boolean } {
  const truncatedFields: string[] = [];
  if (isError) {
    const capped = capDeep(text, truncatedFields) as string;
    return { text: capped, droppedKeys: [], truncatedFields, redacted: false };
  }
  if (!KNOWN.has(tool)) return { text: REDACTED_TEXT, droppedKeys: [], truncatedFields, redacted: true };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { text: REDACTED_TEXT, droppedKeys: [], truncatedFields, redacted: true };
  }
  const parsed = TOOL_OUTPUT_WHITELIST[tool as AgentToolName].safeParse(raw);
  if (!parsed.success) return { text: REDACTED_TEXT, droppedKeys: [], truncatedFields, redacted: true };
  const droppedKeys = diffKeys(raw, parsed.data);
  const clean = capDeep(parsed.data, truncatedFields);
  return { text: JSON.stringify(clean), droppedKeys, truncatedFields, redacted: false };
}

/**
 * 构造 transformContext：只改发往 LLM 的副本（agent.state 里的 transcript 保留原样，
 * 供本地 UI / session 使用——与"stdout 留在本地"同一语义）。
 */
export function createPrivacyGate(onAudit: (entry: PrivacyAuditEntry) => void) {
  const seen = new Set<string>();
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> =>
    messages.map((m) => {
      if (m.role !== 'toolResult') return m;
      const text = m.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      const r = sanitizeToolResultText(m.toolName, text, m.isError);
      if (!seen.has(m.toolCallId)) {
        seen.add(m.toolCallId);
        onAudit({
          toolCallId: m.toolCallId,
          tool: m.toolName,
          bytes: byteLen(r.text),
          droppedKeys: r.droppedKeys,
          truncatedFields: r.truncatedFields,
          redacted: r.redacted,
          isError: m.isError,
        });
      }
      // structuredContent / details 可能携带未过闸的原值：发往 LLM 的副本一并去掉（只留过闸文本）
      const { structuredContent: _sc, details: _d, ...rest } = m as typeof m & { structuredContent?: unknown };
      return { ...rest, content: [{ type: 'text' as const, text: r.text }] };
    });
}
