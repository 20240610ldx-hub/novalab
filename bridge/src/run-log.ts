/**
 * RunLog —— 追加式运行日志（ADR-014）：`.novalab/sessions/<sessionId>.runs.jsonl`。
 *
 * 每个被执行的 cell 一行（直接运行 / 级联 / 采纳 Diff / REPL 各自成行），回答"跑了什么、成没成、
 * 谁触发的、和上一次比改了哪里"。不存输出内容（stdout 正文、图、表）与异常 evalue。
 *
 * - started(cellId) 在 run.started 时登记（代码取自当时的缓存），finished(cellId) 在 run.done /
 *   run.error 时落盘一行；没有 started 的 finished 忽略。
 * - 代码按 sha256 去重：本会话首次出现的哈希才内联正文；累计正文超过 maxCodeChars 后只记哈希。
 * - 超过 maxRecords 行只写一次 `{"v":1,"truncated":true}` 标记后停止记录。
 * - 同步追加（appendFileSync）：运行是人速事件，换取崩溃时最多丢最后一行。
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { TRUNCATION_SUFFIX } from './preview';

export type RunActor = 'user' | 'agent';
export type RunTrigger = 'direct' | 'cascade' | 'accept' | 'repl';

export interface RunOutSummary {
  stdoutBytes: number;
  stderrBytes: number;
  mime: string[];
  writes: string[];
}

export interface RunLogRecord {
  v: 1;
  runId: string;
  ts: string;
  durationMs: number;
  cellId: string;
  attempt: number;
  actor: RunActor;
  trigger: RunTrigger;
  rootRunId?: string;
  codeSha256: string;
  code?: string;
  codeOmitted?: true;
  ok: boolean;
  error?: { name: string; line?: number };
  out: RunOutSummary;
}

export interface RunStartInfo {
  code: string;
  actor: RunActor;
  trigger: RunTrigger;
  /** 级联时触发它的根 cell（同一请求内的进行中运行）。 */
  rootCellId?: string;
}

export interface RunFinishInfo {
  ok: boolean;
  attempt: number;
  /** 内核自报的单 cell 耗时（run.done 的 durationMs；级联时根的 run.done 晚于下游发出，墙钟会偏大）。 */
  durationMs?: number;
  error?: { name: string; line?: number };
  out: RunOutSummary;
}

export interface RunLogOptions {
  clock?: () => Date;
  maxRecords?: number;
  maxCodeChars?: number;
}

export const RUN_LOG_MAX_RECORDS = 10_000;
export const RUN_LOG_MAX_CODE_CHARS = 2_000_000;

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 事件流 `<id>.jsonl` → 运行日志 `<id>.runs.jsonl`（同目录、同生命周期）。 */
export function runLogFileFor(eventsFile: string): string {
  return eventsFile.replace(/\.jsonl$/, '.runs.jsonl');
}

interface Pending {
  runId: string;
  t0: number;
  ts: string;
  info: RunStartInfo;
  rootRunId?: string;
}

export class RunLog {
  private seq = 0;
  private written = 0;
  private codeChars = 0;
  private truncated = false;
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  /** cellId → 最近一次开始的 runId（级联开始时根运行可能已结束）。 */
  private readonly lastRunId = new Map<string, string>();
  private readonly clock: () => Date;
  private readonly maxRecords: number;
  private readonly maxCodeChars: number;

  constructor(readonly file: string, opts: RunLogOptions = {}) {
    this.clock = opts.clock ?? (() => new Date());
    this.maxRecords = opts.maxRecords ?? RUN_LOG_MAX_RECORDS;
    this.maxCodeChars = opts.maxCodeChars ?? RUN_LOG_MAX_CODE_CHARS;
  }

  started(cellId: string, info: RunStartInfo): void {
    const now = this.clock();
    const runId = `r-${++this.seq}`;
    const rootRunId = info.rootCellId !== undefined ? this.lastRunId.get(info.rootCellId) : undefined;
    this.pending.set(cellId, { runId, t0: now.getTime(), ts: now.toISOString(), info, ...(rootRunId ? { rootRunId } : {}) });
    this.lastRunId.set(cellId, runId);
  }

  finished(cellId: string, fin: RunFinishInfo): void {
    const p = this.pending.get(cellId);
    if (!p) return;
    this.pending.delete(cellId);
    if (this.truncated) return;
    if (this.written >= this.maxRecords) {
      this.truncated = true;
      appendFileSync(this.file, JSON.stringify({ v: 1, truncated: true }) + '\n', 'utf8');
      return;
    }
    const sha = sha256Hex(p.info.code);
    const rec: RunLogRecord = {
      v: 1,
      runId: p.runId,
      ts: p.ts,
      durationMs: fin.durationMs ?? Math.max(0, this.clock().getTime() - p.t0),
      cellId,
      attempt: fin.attempt,
      actor: p.info.actor,
      trigger: p.info.trigger,
      codeSha256: sha,
      ok: fin.ok,
      out: fin.out,
    };
    if (p.rootRunId) rec.rootRunId = p.rootRunId;
    if (!this.seen.has(sha)) {
      if (this.codeChars + p.info.code.length <= this.maxCodeChars) {
        this.seen.add(sha);
        this.codeChars += p.info.code.length;
        rec.code = p.info.code;
      } else {
        rec.codeOmitted = true;
      }
    }
    if (fin.error) rec.error = fin.error;
    appendFileSync(this.file, JSON.stringify(rec) + '\n', 'utf8');
    this.written++;
  }
}

function isRecord(v: unknown): v is RunLogRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return r['v'] === 1 && typeof r['runId'] === 'string' && typeof r['cellId'] === 'string' &&
    typeof r['codeSha256'] === 'string' && typeof r['ok'] === 'boolean';
}

/** 宽容读取：坏行 / 未知版本跳过；文件不存在 → 空。 */
export function readRunLog(file: string, filter: { cellId?: string } = {}): { records: RunLogRecord[]; truncated: boolean } {
  if (!existsSync(file)) return { records: [], truncated: false };
  const records: RunLogRecord[] = [];
  let truncated = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>)['truncated'] === true) {
      truncated = true;
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (filter.cellId !== undefined && parsed.cellId !== filter.cellId) continue;
    records.push(parsed);
  }
  // 落盘顺序 = 结束顺序（真实内核里级联根的 run.done 晚于下游）；按开始顺序（会话内 runId 序号）返回
  const seq = (r: RunLogRecord): number => Number(r.runId.slice(2)) || 0;
  records.sort((a, b) => seq(a) - seq(b));
  return { records, truncated };
}

// ---------- Agent 视图（get_run_history，ADR-014 O2 已由 Owner 开放） ----------

/** 每次尝试的代码差异上限（字符）；超出截断。 */
export const RUN_DIFF_CHAR_LIMIT = 2000;
export const RUN_HISTORY_DEFAULT_LIMIT = 10;
export const RUN_HISTORY_MAX_LIMIT = 20;
/** 逐行差异的计算上限（n·m）；超过则整体替换。与前端 runLog.ts 同值。 */
const LCS_CELL_LIMIT = 1_000_000;

export interface AgentRunAttempt {
  attempt: number;
  ok: boolean;
  actor: RunActor;
  trigger: RunTrigger;
  durationMs: number;
  error?: { name: string; line?: number };
  /** 相对上一次尝试代码是否变化（首次尝试为 false）。 */
  codeChanged: boolean;
  /** 变化行：`- 旧` / `+ 新`；正文未记录（超预算）时缺省。 */
  diff?: string;
}

export interface AgentRunHistory {
  cellId: string;
  /** 本会话该 cell 的尝试总数（attempts 只含最近 limit 次）。 */
  totalAttempts: number;
  attempts: AgentRunAttempt[];
}

/** 只含变化行的逐行差异（LCS）。 */
export function changedLines(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: string[] = [];
  if (a.length * b.length > LCS_CELL_LIMIT) {
    for (const t of a) out.push(`- ${t}`);
    for (const t of b) out.push(`+ ${t}`);
    return out.join('\n');
  }
  const w = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out.join('\n');
}

/**
 * 会话全部记录 → 某 cell 最近 limit 次尝试的 Agent 视图。
 * 不含输出内容与 evalue（日志本就不存）；代码只以"相对上一次的变化行"出现。
 * 正文按哈希在整个会话里查（同一段代码可能首次出现在别的 cell）。
 */
export function agentRunHistory(records: readonly RunLogRecord[], cellId: string, limit = RUN_HISTORY_DEFAULT_LIMIT): AgentRunHistory {
  const codeByHash = new Map<string, string>();
  for (const r of records) if (r.code !== undefined && !codeByHash.has(r.codeSha256)) codeByHash.set(r.codeSha256, r.code);
  const mine = records.filter((r) => r.cellId === cellId);
  const n = Math.max(1, Math.min(RUN_HISTORY_MAX_LIMIT, Math.floor(limit)));
  const start = Math.max(0, mine.length - n);
  const attempts: AgentRunAttempt[] = [];
  for (let k = start; k < mine.length; k++) {
    const r = mine[k]!;
    const prev = k > 0 ? mine[k - 1] : undefined;
    const codeChanged = prev !== undefined && prev.codeSha256 !== r.codeSha256;
    const a: AgentRunAttempt = {
      attempt: r.attempt,
      ok: r.ok,
      actor: r.actor,
      trigger: r.trigger,
      durationMs: r.durationMs,
      codeChanged,
    };
    if (r.error) a.error = r.error;
    if (codeChanged) {
      const before = codeByHash.get(prev!.codeSha256);
      const after = codeByHash.get(r.codeSha256);
      if (before !== undefined && after !== undefined) {
        const d = changedLines(before, after);
        a.diff = d.length > RUN_DIFF_CHAR_LIMIT ? d.slice(0, RUN_DIFF_CHAR_LIMIT) + TRUNCATION_SUFFIX : d;
      }
    }
    attempts.push(a);
  }
  return { cellId, totalAttempts: mine.length, attempts };
}
