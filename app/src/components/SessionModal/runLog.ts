/**
 * 运行历史（ADR-014）：bridge `session.runs` 的前端视图——按 cell 分组、补齐去重的代码正文、
 * 计算相邻两次尝试的逐行差异。纯函数，便于单测。
 */

export interface RunRecordWire {
  runId: string;
  ts: string;
  durationMs: number;
  cellId: string;
  attempt: number;
  actor: 'user' | 'agent';
  trigger: 'direct' | 'cascade' | 'accept' | 'repl';
  rootRunId?: string;
  codeSha256: string;
  code?: string;
  codeOmitted?: true;
  ok: boolean;
  error?: { name: string; line?: number };
}

function isWire(v: unknown): v is RunRecordWire {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.runId === 'string' && typeof r.cellId === 'string' && typeof r.codeSha256 === 'string' &&
    typeof r.ok === 'boolean' && typeof r.attempt === 'number' && typeof r.ts === 'string';
}

/** `session.runs` 响应 → 记录数组（形状不对 → 空，宽容降级）。 */
export function normalizeRunsWire(res: unknown): RunRecordWire[] {
  const records = typeof res === 'object' && res !== null ? (res as { records?: unknown }).records : undefined;
  return Array.isArray(records) ? records.filter(isWire) : [];
}

/** cellId → 该 cell 的尝试（开始顺序）；同哈希的后续记录借用首次内联的正文。 */
export function historyByCell(records: readonly RunRecordWire[]): Map<string, RunRecordWire[]> {
  const codeByHash = new Map<string, string>();
  for (const r of records) if (r.code !== undefined && !codeByHash.has(r.codeSha256)) codeByHash.set(r.codeSha256, r.code);
  const out = new Map<string, RunRecordWire[]>();
  for (const r of records) {
    const code = r.code ?? codeByHash.get(r.codeSha256);
    const list = out.get(r.cellId) ?? [];
    list.push(code !== undefined ? { ...r, code } : r);
    out.set(r.cellId, list);
  }
  return out;
}

export interface DiffLine {
  op: '=' | '-' | '+';
  text: string;
}

/** 逐行差异的计算上限（n·m 个单元）；超过则整体替换，避免大 cell 卡界面。 */
const LCS_CELL_LIMIT = 1_000_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > LCS_CELL_LIMIT) {
    return [...a.map((text) => ({ op: '-' as const, text })), ...b.map((text) => ({ op: '+' as const, text }))];
  }
  // LCS 长度表（自底向上），再正向回溯输出
  const w = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: '=', text: a[i]! });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
      out.push({ op: '-', text: a[i++]! });
    } else {
      out.push({ op: '+', text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ op: '-', text: a[i++]! });
  while (j < b.length) out.push({ op: '+', text: b[j++]! });
  return out;
}
