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
