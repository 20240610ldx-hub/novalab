/**
 * exporter.ts —— NovaLab 会话 → nbformat 4.5 `.ipynb` 导出（P3.4，spec §11 / A-2 #14）。
 *
 * 纯模块：不依赖 router/supervisor/protocol（类型本地导出，接线者在 router 侧适配）。
 * exportIpynb({cells, targetPath}, meta?) = buildNotebook（纯函数，可单测）+ fs 写盘。
 *
 * 输出映射（CellOutput → nbformat outputs，顺序固定）：
 *   stdout              → {output_type:'stream', name:'stdout', text:[行…]}
 *   stderr              → {output_type:'stream', name:'stderr', …}
 *   mime['text/plain'] / mime['image/png']（base64）
 *                       → 合并为单个 {output_type:'display_data', data:{…}}（其余 mime 键忽略）
 *   traceback           → {output_type:'error', ename, evalue, traceback:[行…]}
 *                         ename/evalue 从 traceback 最后一个非空行 `Name: msg` 解析，失败回退 Error
 *   writes              → {output_type:'stream', name:'stdout', text:['wrote <path>\n'…]}（A-2 #15 同文案）
 *   execCount           → execution_count（0/缺省 → null）
 *   source              → 按行数组（行间保留 '\n'，末行不带；nbformat 约定）
 *
 * 接线（P3.1 合入后由 orchestrator 接）：
 *   router 'export.ipynb' {path, sessionId?, target?} → 取该会话 cells（含 mime 数据）
 *   → exportIpynb({cells, targetPath}, meta) → 响应 {path, nbCells, nbOutputs}。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ERR_INTERNAL, ERR_INVALID_PARAMS } from './protocol';

/** 导出级错误：code 直接映射 JSON-RPC 错误码（默认 -32602，接线者透传即可）。 */
export class IpynbError extends Error {
  constructor(
    message: string,
    readonly code: number = ERR_INVALID_PARAMS,
  ) {
    super(message);
    this.name = 'IpynbError';
  }
}

/* ---------- 输入类型（本地定义；protocol.ts 由 P3.1 独占，禁改） ---------- */

/** 一次运行的输出缓冲（比 SessionSnapshotCell.output 富：mime 携带数据而非仅键名）。 */
export interface ExportCellOutput {
  stdout?: string;
  stderr?: string;
  /** 完整 traceback 文本（run.error 的 traceback 原文）。 */
  traceback?: string | null;
  /** mime-type → 文本或 base64（image/png）；string[] 按行数组宽容接受。 */
  mime?: Record<string, string | string[]>;
  /** run.notify file-write 落盘路径（P2.9）。 */
  writes?: string[];
}

export interface ExportCell {
  id?: string;
  code?: string;
  /** ≤0 / 缺省 → execution_count: null。 */
  execCount?: number | null;
  output?: ExportCellOutput | null;
}

/** notebook 级元数据（写入 metadata.novalab，供追溯；全部可选）。 */
export interface ExportMeta {
  notebookPath?: string;
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  endReason?: string;
}

export interface ExportResult {
  /** 写盘后的绝对路径。 */
  path: string;
  nbCells: number;
  nbOutputs: number;
}

/* ---------- nbformat 构造（纯函数） ---------- */

/** 文本 → nbformat 多行字符串数组：行间保留 '\n'，末行不带；空文本 → []。 */
export function toSourceLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop(); // 末尾换行不产生空行元素
  if (parts.length === 1 && parts[0] === '') return []; // 纯换行文本 → 空 source
  return parts.map((l, i) => (i < parts.length - 1 ? `${l}\n` : l));
}

/** traceback 末行 `ValueError: boom` → {ename, evalue}；裸异常名（KeyboardInterrupt）→ evalue ''；不匹配 → Error/末行原文。 */
export function parseTracebackTail(traceback: string): { ename: string; evalue: string } {
  const lines = traceback.split('\n').filter((l) => l.trim() !== '');
  const tail = (lines[lines.length - 1] ?? '').trim();
  const m = /^([A-Za-z_][\w.]*)\s*:\s*(.*)$/.exec(tail);
  if (m) return { ename: m[1]!, evalue: m[2]! };
  if (/^[A-Za-z_][\w.]*$/.test(tail) && tail !== '') return { ename: tail, evalue: '' };
  return { ename: 'Error', evalue: tail };
}

/** mime 值归一化：string | string[] → string（string[] join('')，nbformat 允许两种形态）。 */
function mimeText(v: string | string[]): string {
  return Array.isArray(v) ? v.join('') : v;
}

interface NbOutput {
  output_type: 'stream' | 'display_data' | 'error';
  [k: string]: unknown;
}

/** 单 cell 输出缓冲 → nbformat outputs（顺序：stdout、stderr、display_data、error、writes）。 */
export function buildOutputs(out: ExportCellOutput | null | undefined): NbOutput[] {
  if (!out) return [];
  const res: NbOutput[] = [];
  if (out.stdout) {
    res.push({ output_type: 'stream', name: 'stdout', text: toSourceLines(out.stdout) });
  }
  if (out.stderr) {
    res.push({ output_type: 'stream', name: 'stderr', text: toSourceLines(out.stderr) });
  }
  const plain = out.mime?.['text/plain'];
  const png = out.mime?.['image/png'];
  if (plain !== undefined || png !== undefined) {
    const data: Record<string, unknown> = {};
    if (plain !== undefined) data['text/plain'] = toSourceLines(mimeText(plain));
    if (png !== undefined) data['image/png'] = mimeText(png); // base64 单串
    res.push({ output_type: 'display_data', metadata: {}, data });
  }
  if (out.traceback) {
    const { ename, evalue } = parseTracebackTail(out.traceback);
    res.push({
      output_type: 'error',
      ename,
      evalue,
      traceback: toSourceLines(out.traceback),
    });
  }
  if (out.writes && out.writes.length > 0) {
    res.push({
      output_type: 'stream',
      name: 'stdout',
      text: toSourceLines(out.writes.map((w) => `wrote ${w}`).join('\n')),
    });
  }
  return res;
}

/** nbformat 4.5 要求 cell id 唯一：cell.id 缺省/重复时派生 `cell-<i>`/加后缀。 */
function uniqueCellIds(cells: readonly ExportCell[]): string[] {
  const seen = new Set<string>();
  return cells.map((c, i) => {
    let base = typeof c.id === 'string' && c.id !== '' ? c.id : `cell-${i}`;
    while (seen.has(base)) base = `${base}-2`;
    seen.add(base);
    return base;
  });
}

/** cells + meta → nbformat 4.5 JSON 对象（纯函数，单测直调）。 */
export function buildNotebook(cells: readonly ExportCell[], meta?: ExportMeta): Record<string, unknown> {
  if (!Array.isArray(cells)) throw new IpynbError('exportIpynb 需要 cells 数组');
  const ids = uniqueCellIds(cells);
  const nbCells = cells.map((c, i) => {
    const outputs = buildOutputs(c.output);
    const ec = typeof c.execCount === 'number' && c.execCount > 0 ? c.execCount : null;
    return {
      cell_type: 'code',
      id: ids[i],
      execution_count: ec,
      metadata: {},
      outputs,
      source: toSourceLines(typeof c.code === 'string' ? c.code : ''),
    };
  });
  const novalab: Record<string, unknown> = { exporter: 'novalab-p3.4' };
  if (meta) {
    for (const k of ['notebookPath', 'sessionId', 'startedAt', 'endedAt', 'endReason'] as const) {
      if (meta[k] !== undefined) novalab[k] = meta[k];
    }
  }
  return {
    cells: nbCells,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
      novalab,
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

/* ---------- 写盘入口 ---------- */

/**
 * 导出 .ipynb：构造 nbformat 4.5 并写入 targetPath（父目录不存在则递归创建）。
 * 返回 {path（绝对路径）, nbCells, nbOutputs}。参数非法 → IpynbError(-32602)，
 * fs 失败 → IpynbError(-32603)。
 */
export function exportIpynb(
  input: { cells: readonly ExportCell[]; targetPath: string },
  meta?: ExportMeta,
): ExportResult {
  if (!input || typeof input !== 'object') throw new IpynbError('exportIpynb 需要 {cells, targetPath}');
  const { cells, targetPath } = input;
  if (!Array.isArray(cells)) throw new IpynbError('exportIpynb 需要 cells 数组');
  if (typeof targetPath !== 'string' || targetPath.trim() === '' || targetPath.includes('\0')) {
    throw new IpynbError('exportIpynb 需要非空 targetPath');
  }
  const nb = buildNotebook(cells, meta);
  const abs = path.resolve(targetPath);
  try {
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(nb, null, 1)}\n`, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new IpynbError(`export.ipynb 写盘失败: ${e?.message ?? String(err)}`, ERR_INTERNAL);
  }
  const nbCells = nb['cells'] as unknown[];
  const nbOutputs = (nb['cells'] as { outputs: unknown[] }[]).reduce((n, c) => n + c.outputs.length, 0);
  return { path: abs, nbCells: nbCells.length, nbOutputs };
}
