/**
 * Provenance —— 结果溯源（ADR-015）：`.novalab/provenance.jsonl`（与 notebook 同目录，跨会话保留）。
 *
 * 每次运行结束、且读写过文件时追加一行：产生它的 cell / 会话 / runId（关联 ADR-014 运行日志）、
 * 代码哈希，以及本次读（输入）、写（输出）文件的 SHA-256 与字节数。只算哈希，不读内容进任何上下文。
 *
 * - 哈希在运行结束后流式计算（异步，不阻塞执行队列）；同一文件既读又写 → 只记为输出并标 inPlace。
 * - 超过 maxHashBytes 的文件不算哈希（skipped: 'too-large'）；已不存在的记 'missing'。
 * - 追加按调用顺序串行（promise 链），同目录多个 notebook 共用一个文件（记录带 notebook 名）。
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const PROVENANCE_MAX_HASH_BYTES = 1024 * 1024 * 1024;

export type ProvenanceSkip = 'too-large' | 'missing' | 'unreadable';

export interface ProvenanceFile {
  path: string;
  sha256: string | null;
  bytes: number | null;
  skipped?: ProvenanceSkip;
  /** 同一次运行先读后写（输入哈希已不可得，只记写后的输出）。 */
  inPlace?: true;
}

export interface ProvenanceRecord {
  v: 1;
  ts: string;
  notebook: string;
  sessionId: string;
  runId: string;
  cellId: string;
  codeSha256: string;
  inputs: ProvenanceFile[];
  outputs: ProvenanceFile[];
}

export interface ProvenanceEntry {
  notebook: string;
  sessionId: string;
  runId: string;
  cellId: string;
  codeSha256: string;
  reads: readonly string[];
  writes: readonly string[];
}

export interface ProvenanceOptions {
  clock?: () => Date;
  maxHashBytes?: number;
}

export function provenanceFileFor(notebookDir: string): string {
  return path.join(notebookDir, '.novalab', 'provenance.jsonl');
}

/** 路径比较键：绝对化；Windows 不区分大小写、分隔符统一。 */
export function pathKey(p: string): string {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.replace(/\//g, '\\').toLowerCase() : abs;
}

/** 流式 SHA-256；超上限不读（只给字节数），不存在 / 读不了各自标注。 */
export async function hashFile(
  file: string,
  maxBytes = PROVENANCE_MAX_HASH_BYTES,
): Promise<{ sha256: string | null; bytes: number | null; skipped?: ProvenanceSkip }> {
  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) return { sha256: null, bytes: null, skipped: 'unreadable' };
    size = st.size;
  } catch {
    return { sha256: null, bytes: null, skipped: 'missing' };
  }
  if (size > maxBytes) return { sha256: null, bytes: size, skipped: 'too-large' };
  try {
    const h = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(file)) {
      h.update(chunk as Buffer);
      bytes += (chunk as Buffer).length;
    }
    return { sha256: h.digest('hex'), bytes };
  } catch {
    return { sha256: null, bytes: size, skipped: 'unreadable' };
  }
}

async function fingerprint(p: string, maxBytes: number, inPlace = false): Promise<ProvenanceFile> {
  const h = await hashFile(p, maxBytes);
  return {
    path: p,
    sha256: h.sha256,
    bytes: h.bytes,
    ...(h.skipped ? { skipped: h.skipped } : {}),
    ...(inPlace ? { inPlace: true as const } : {}),
  };
}

export class ProvenanceLog {
  private tail: Promise<void> = Promise.resolve();
  private readonly clock: () => Date;
  private readonly maxHashBytes: number;

  constructor(readonly file: string, opts: ProvenanceOptions = {}) {
    this.clock = opts.clock ?? (() => new Date());
    this.maxHashBytes = opts.maxHashBytes ?? PROVENANCE_MAX_HASH_BYTES;
  }

  /** 登记一次运行（无读写 → 不记）。时间取调用时刻；哈希与落盘在后台串行完成。 */
  record(entry: ProvenanceEntry): void {
    if (entry.reads.length === 0 && entry.writes.length === 0) return;
    const ts = this.clock().toISOString();
    this.tail = this.tail
      .then(async () => {
        const written = new Set(entry.writes.map(pathKey));
        const inputs: ProvenanceFile[] = [];
        for (const p of entry.reads) if (!written.has(pathKey(p))) inputs.push(await fingerprint(p, this.maxHashBytes));
        const readKeys = new Set(entry.reads.map(pathKey));
        const outputs: ProvenanceFile[] = [];
        for (const p of entry.writes) outputs.push(await fingerprint(p, this.maxHashBytes, readKeys.has(pathKey(p))));
        const rec: ProvenanceRecord = {
          v: 1,
          ts,
          notebook: entry.notebook,
          sessionId: entry.sessionId,
          runId: entry.runId,
          cellId: entry.cellId,
          codeSha256: entry.codeSha256,
          inputs,
          outputs,
        };
        await mkdir(path.dirname(this.file), { recursive: true });
        await appendFile(this.file, JSON.stringify(rec) + '\n', 'utf8');
      })
      .catch(() => undefined); // 只丢这一条，不影响后续记录与执行
  }

  /** 等待已登记的记录全部落盘（导出 / 查询 / 测试前调用）。 */
  whenIdle(): Promise<void> {
    return this.tail;
  }
}

function isRecord(v: unknown): v is ProvenanceRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return r['v'] === 1 && typeof r['runId'] === 'string' && typeof r['cellId'] === 'string' &&
    Array.isArray(r['inputs']) && Array.isArray(r['outputs']);
}

/** 宽容读取：坏行跳过；文件不存在 → []。按落盘顺序（= 运行结束顺序）。 */
export function readProvenance(file: string): ProvenanceRecord[] {
  if (!existsSync(file)) return [];
  const out: ProvenanceRecord[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) out.push(parsed);
    } catch {
      /* 半行（崩溃时写坏）跳过 */
    }
  }
  return out;
}

export type ProvenanceCurrent = 'same' | 'modified' | 'missing' | 'unknown';

export interface ProvenanceLookup {
  path: string;
  /** 没有任何运行写过这个文件 → null。 */
  producedBy: { notebook: string; sessionId: string; runId: string; cellId: string; ts: string; codeSha256: string } | null;
  recorded?: ProvenanceFile;
  /** 文件现在与记录相比。 */
  current?: ProvenanceCurrent;
  inputs?: (ProvenanceFile & { current: ProvenanceCurrent })[];
}

async function compare(f: ProvenanceFile, maxBytes: number): Promise<ProvenanceCurrent> {
  const now = await hashFile(f.path, maxBytes);
  if (now.skipped === 'missing') return 'missing';
  if (f.sha256 === null || now.sha256 === null) return 'unknown';
  return now.sha256 === f.sha256 ? 'same' : 'modified';
}

/** 最近一次产生该文件的运行 + 现场重算：文件与各输入现在是否仍与记录一致。 */
export async function lookupProvenance(file: string, target: string, maxBytes = PROVENANCE_MAX_HASH_BYTES): Promise<ProvenanceLookup> {
  const key = pathKey(target);
  const records = readProvenance(file);
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    const out = r.outputs.find((o) => pathKey(o.path) === key);
    if (!out) continue;
    const inputs = [];
    for (const inp of r.inputs) inputs.push({ ...inp, current: await compare(inp, maxBytes) });
    return {
      path: target,
      producedBy: { notebook: r.notebook, sessionId: r.sessionId, runId: r.runId, cellId: r.cellId, ts: r.ts, codeSha256: r.codeSha256 },
      recorded: out,
      current: await compare(out, maxBytes),
      inputs,
    };
  }
  return { path: target, producedBy: null };
}

/** 导出用：notebook 目录内写相对路径（/ 分隔），目录外只留 `<external>/文件名`。 */
export function exportPath(p: string, notebookDir: string): string {
  const rel = path.relative(notebookDir, p);
  if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return `<external>/${path.basename(p)}`;
}
