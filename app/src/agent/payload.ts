import type { Cell, TracebackFrame, VarSchema } from '../kernel/types';

/**
 * Agent 出进程 payload 的组装与硬截断（spec §8 隐私边界 / M5 的前端形态）。
 *
 * 硬规则（双保险，不依赖模型自觉、也不只依赖 bridge 截断）：
 *  1. 任何进入 payload 的字符串字段先按 MAX_FIELD_BYTES(4KB) 截断；
 *  2. 组装完成后每个 section 再过一次 enforceFieldLimit（本地第二道闸）；
 *  3. schema preview 单独按 PREVIEW_BYTES(200B) 截断（head(1)/repr 级别）；
 *  4. 首条消息只含代码/traceback/schema 摘要；Agent 工具调用的返回另由
 *     auditToolResult 逐条记账（v0.1.1：审计覆盖工具出口，不再声称"0 rows sent"）。
 *
 * 本文件是纯函数集合（不触网、不读 store），vitest 直接覆盖，见 payload.test.ts。
 */

/** 单字段硬上限：4KB（spec §8 黑名单阈值）。 */
export const MAX_FIELD_BYTES = 4096;

/** schema preview（head(1)/repr）上限：200 字符级（spec §8 白名单：repr≤200）。 */
export const PREVIEW_BYTES = 200;

/** traceback 摘要最多保留的帧数（尾部优先——最接近出错点）。 */
export const MAX_TRACEBACK_FRAMES = 8;

export const TRUNCATION_MARKER = '…[truncated]';

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * 按 UTF-8 字节数截断（多字节字符不会被劈成乱码：二分找最长合法前缀）。
 * 结果 = 前缀 + marker，整体字节数 ≤ maxBytes（marker 自身超限时退化为纯截断）。
 */
export function truncateToBytes(
  text: string,
  maxBytes: number = MAX_FIELD_BYTES,
  marker: string = TRUNCATION_MARKER,
): string {
  if (byteLength(text) <= maxBytes) return text;
  const markerBytes = byteLength(marker);
  if (markerBytes >= maxBytes) {
    // 极端小预算：放弃 marker，直接按字节裁（丢弃尾部不完整多字节序列）
    return trimToBytePrefix(text, maxBytes);
  }
  return trimToBytePrefix(text, maxBytes - markerBytes) + marker;
}

/** 最长的、字节数 ≤ budget 的字符串前缀（二分）。 */
function trimToBytePrefix(text: string, budget: number): string {
  if (budget <= 0) return '';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const prefix = text.slice(0, lo);
  // 边界上被劈开的多字节字符：decode 一次丢弃残尾
  return new TextDecoder().decode(encoder.encode(prefix));
}

/** 双保险的第二道闸：对已组装文本再截断一次。 */
export function enforceFieldLimit(text: string): string {
  return truncateToBytes(text, MAX_FIELD_BYTES);
}

/** 出错 cell 的相关 schema：按 cell 的 refs ∪ defs 过滤（Fix 卡片与 payload 共用）。 */
export function filterSchemasForCell(
  schemas: readonly VarSchema[],
  cell: Pick<Cell, 'defs' | 'refs'> | null | undefined,
): VarSchema[] {
  if (!cell) return [];
  const names = new Set([...cell.defs, ...cell.refs]);
  return schemas.filter((s) => names.has(s.name));
}

/** 单个变量 schema → 一行摘要（结构信息 only；preview 按 200B 截断）。 */
export function schemaLine(s: VarSchema): string {
  const bits: string[] = [`${s.name}: ${s.type}`];
  if (s.shape) bits.push(`shape=${JSON.stringify(s.shape)}`);
  if (s.len != null) bits.push(`len=${s.len}`);
  if (s.columns?.length) {
    const cols = s.columns.map((c) => `${c.name}:${c.dtype}`).join(', ');
    bits.push(`columns=[${cols}]`);
  }
  if (s.preview != null) {
    // P3.5 起 preview 为 unknown（结构化对象或字符串）：统一序列化后按字节截断
    const pv = typeof s.preview === 'string' ? s.preview : JSON.stringify(s.preview);
    bits.push(`preview=${truncateToBytes(pv, PREVIEW_BYTES)}`);
  }
  return bits.join(' ');
}

export function schemasToText(schemas: readonly VarSchema[]): string {
  return schemas.map(schemaLine).join('\n');
}

/**
 * traceback 摘要：末行异常 + 尾部最多 MAX_TRACEBACK_FRAMES 帧
 * （Python traceback 的根因在最后，头部框架帧没有信息量）。
 */
export function summarizeTraceback(tb: {
  text: string;
  frames: readonly TracebackFrame[];
}): string {
  const lines: string[] = [];
  const frames = tb.frames.slice(-MAX_TRACEBACK_FRAMES);
  if (tb.frames.length > frames.length) {
    lines.push(`… (${tb.frames.length - frames.length} earlier frames omitted)`);
  }
  for (const f of frames) {
    lines.push(`File "${f.file}", line ${f.line}, in ${f.fn}`);
    if (f.srcLine) lines.push(`    ${f.srcLine}`);
  }
  const textLines = tb.text.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const last = textLines[textLines.length - 1];
  if (last && !lines.includes(last)) lines.push(last);
  return truncateToBytes(lines.join('\n'), MAX_FIELD_BYTES);
}

export interface PayloadSection {
  label: string;
  text: string;
  bytes: number;
}

/** ContextChip 审计条目：本次请求实际发送内容的逐段清单。 */
export interface AssembledPayload {
  sections: PayloadSection[];
  /** 组装后的完整 user 消息文本（实际发给模型的内容）。 */
  text: string;
  totalBytes: number;
  /** 进入 payload 的变量 schema 条数。 */
  schemaCount: number;
  /** 进入 payload 的 traceback 条数（0 | 1）。 */
  tracebackCount: number;
}

function section(label: string, text: string): PayloadSection {
  const safe = enforceFieldLimit(text); // 双保险：组装点再截一次
  return { label, text: safe, bytes: byteLength(safe) };
}

function assemble(
  sections: PayloadSection[],
  meta: { schemaCount: number; tracebackCount: number },
): AssembledPayload {
  const text = sections.map((s) => `## ${s.label}\n${s.text}`).join('\n\n');
  return {
    sections,
    text,
    totalBytes: byteLength(text),
    schemaCount: meta.schemaCount,
    tracebackCount: meta.tracebackCount,
  };
}

/**
 * One-click Fix 的预置 user 消息：出错 cell 代码 + traceback 摘要 + 相关 schema，
 * 外加明确要求模型走 propose_code_change 的指令（与 system prompt 的 Rulebook 呼应）。
 */
export function buildFixPayload(opts: {
  cellId: string;
  cellCode: string;
  traceback: { text: string; frames: readonly TracebackFrame[] };
  schemas: readonly VarSchema[];
}): AssembledPayload {
  const sections = [
    section(`cell ${opts.cellId} 当前代码`, opts.cellCode),
    section('traceback（摘要）', summarizeTraceback(opts.traceback)),
    section(
      `相关变量 schema（${opts.schemas.length} 条，仅结构无行数据）`,
      schemasToText(opts.schemas) || '(无)',
    ),
  ];
  const body = assemble(sections, { schemaCount: opts.schemas.length, tracebackCount: 1 });
  const text =
    `cell "${opts.cellId}" 运行失败。请阅读以下上下文并修复：\n\n` +
    `${body.text}\n\n` +
    `要求：遵守反应式单赋值规范（不重定义已有全局名，倾向新变量名/函数式风格）；` +
    `用 propose_code_change 工具提交修复（targetCellId="${opts.cellId}"），不要只贴代码文本。`;
  return { ...body, text, totalBytes: byteLength(text) };
}

/** 普通聊天输入 → 审计 payload（单 section；同样过 4KB 闸，防止用户粘贴 DataFrame 全量）。 */
export function buildChatPayload(userText: string): AssembledPayload {
  const sections = [section('user message', userText)];
  return assemble(sections, { schemaCount: 0, tracebackCount: 0 });
}

/* ---------------- v0.1.1：工具出口审计 ---------------- */

/** 审计条目里保留的结果预览上限（字节）。 */
export const TOOL_AUDIT_PREVIEW_BYTES = 600;

/** 一次 Agent 工具调用的出口记账（ContextChip 展开逐条列出）。 */
export interface ToolAuditEntry {
  tool: string;
  /** 工具返回值 JSON 的 UTF-8 字节数（= 下一轮发给模型的体积）。 */
  bytes: number;
  /** 截断预览（审计面板展示用）。 */
  preview: string;
  /** M5 第二道闸丢弃的白名单外键路径（非空 = bridge agent.* 出口回归）。 */
  droppedKeys: string[];
  /** 整条被第二道闸替换为占位（未知工具 / 形状不符）。 */
  redacted: boolean;
}

/** result 须是**过闸后**实际交给模型的值；gate 携带第二道闸的处置记录。 */
export function auditToolResult(
  tool: string,
  result: unknown,
  gate: { droppedKeys: string[]; redacted: boolean } = { droppedKeys: [], redacted: false },
): ToolAuditEntry {
  let json: string;
  try {
    json = JSON.stringify(result) ?? 'undefined';
  } catch {
    json = String(result);
  }
  return {
    tool,
    bytes: byteLength(json),
    preview: truncateToBytes(json, TOOL_AUDIT_PREVIEW_BYTES),
    droppedKeys: gate.droppedKeys,
    redacted: gate.redacted,
  };
}
