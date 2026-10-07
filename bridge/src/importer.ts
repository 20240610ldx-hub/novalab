/**
 * importer.ts —— `.ipynb`（nbformat）→ NovaLab `.py` 一次性导入转换（P3.4，spec §11）。
 *
 * 纯模块：不依赖 router/protocol（错误码常量除外），单测直调。
 * 生成格式 = py/novakernel/serialize.py `write` 的 TS 复刻（read→write→read 往返
 * 语义守恒由单测 round-trip 验证）：
 *   - PEP723 头（DEFAULT_HEADER_LINES 逐字一致）+ 空行；
 *   - cell 分隔 `# %% [cell-id: <8hex>]`（id 一律新生成，不复用 nb id）；
 *   - cell 代码 strip 首尾换行、cell 间空一行、文件以单个 '\n' 结尾（LF）。
 *
 * 降级规则（全部进 warnings）：
 *   - markdown cell → 注释块 cell：`# [md] ` 前缀逐行保留原文 + 头行注明 P4 渲染；
 *   - raw cell      → `# [raw] ` 前缀注释块（宽容）；
 *   - magic（行首 % / !）→ `# [magic] ` 注释降级；
 *   - outputs       → 丢弃；
 *   - nbformat 主版本 ≠ 4 → 宽容转换 + warning。
 *
 * 写盘：targetPath 缺省 = 源同目录、去扩展名 + `.py`；flag 'wx' 排他——
 * 目标已存在 → ImportError(-32602)，绝不覆盖既有数据（fs.writeFile 同纪律）。
 *
 * 接线（P3.1 合入后由 orchestrator 接）：
 *   router 'import.ipynb' {path, targetPath?} → importIpynb(path, targetPath)
 *   → 响应 {path, cells, warnings}（前端成功后 openNotebook(path)）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ERR_INTERNAL, ERR_INVALID_PARAMS } from './protocol';

/** 导入级错误：code 直接映射 JSON-RPC 错误码（默认 -32602）。 */
export class ImportError extends Error {
  constructor(
    message: string,
    readonly code: number = ERR_INVALID_PARAMS,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

/* ---------- 类型（本地导出；protocol.ts 禁改） ---------- */

export type ImportedCellKind = 'code' | 'markdown' | 'raw';

export interface ImportedCell {
  /** 新生成的 8hex id（serialize.new_cell_id 同形状）。 */
  id: string;
  /** .py 里该 cell 的最终代码文本（已降级/注释化，未 strip——serializePy 写出时 strip）。 */
  code: string;
  kind: ImportedCellKind;
}

export interface ImportResult {
  /** 写盘后的 .py 绝对路径。 */
  path: string;
  cells: ImportedCell[];
  warnings: string[];
}

/* ---------- serialize.write 的 TS 复刻（纯函数） ---------- */

/** 与 py serialize.DEFAULT_HEADER_LINES 逐字一致。 */
export const DEFAULT_HEADER_LINES = [
  '# /// script',
  '# requires-python = ">=3.11"',
  '# dependencies = []',
  '# ///',
];

/** 8 位十六进制 cell id（py serialize.new_cell_id / app helpers.newCellId 同形状）。 */
export function newCellId(rand: () => string = () => randomBytes(4).toString('hex')): string {
  return rand().slice(0, 8).toLowerCase();
}

function stripNewlines(s: string): string {
  return s.replace(/^\n+/, '').replace(/\n+$/, '');
}

/** cells → NovaLab .py 全文（py serialize.write 语义：strip('\n')、空一行、单 '\n' 结尾）。 */
export function serializePy(cells: readonly { id: string; code: string }[]): string {
  const head = DEFAULT_HEADER_LINES.join('\n');
  const blocks = cells.map((c) => `# %% [cell-id: ${c.id}]\n${stripNewlines(c.code)}`);
  const text = blocks.length > 0 ? `${head}\n\n${blocks.join('\n\n')}` : head;
  return `${text.replace(/\n+$/, '')}\n`;
}

/* ---------- nbformat 宽容读取 ---------- */

/** source: string | string[] → 文本（nbformat 两形态；坏值 → ''）。 */
export function joinSource(source: unknown): string {
  if (typeof source === 'string') return source;
  if (Array.isArray(source)) return source.map((l) => (typeof l === 'string' ? l : '')).join('');
  return '';
}

const MAGIC_RE = /^\s*[%!]/;

/** magic 行（% / ! 开头）→ `# [magic] ` 注释降级；返回降级后行。 */
function demoteMagicLine(line: string): string {
  return `# [magic] ${line.trim()}`;
}

/**
 * 单个 nb cell → ImportedCell（纯函数；warnings 追加进 out）。
 * cellNo 为 1-based 序号（warnings 文案用）。
 */
export function convertCell(
  raw: Record<string, unknown>,
  cellNo: number,
  newId: () => string,
  warnings: string[],
): ImportedCell {
  const cellType = raw['cell_type'] === 'markdown' ? 'markdown' : raw['cell_type'] === 'raw' ? 'raw' : 'code';
  const text = stripNewlines(joinSource(raw['source']));

  if (cellType === 'markdown') {
    warnings.push(`cell ${cellNo}: markdown cell 转为 '# [md]' 注释块（P4 将渲染为富文本）`);
    const body = text
      .split('\n')
      .map((l) => `# [md] ${l}`.replace(/# \[md\] $/, '# [md]'))
      .join('\n');
    return {
      id: newId(),
      kind: 'markdown',
      code: `# markdown cell —— P4 渲染为富文本；原文以 '# [md]' 前缀保留\n${body}`,
    };
  }

  if (cellType === 'raw') {
    warnings.push(`cell ${cellNo}: raw cell 降级为 '# [raw]' 注释块`);
    const body = text.split('\n').map((l) => `# [raw] ${l}`.replace(/# \[raw\] $/, '# [raw]')).join('\n');
    return { id: newId(), kind: 'raw', code: body };
  }

  // code cell：outputs 丢弃 + magic 注释降级
  const outputs = raw['outputs'];
  if (Array.isArray(outputs) && outputs.length > 0) {
    warnings.push(`cell ${cellNo}: 丢弃 ${outputs.length} 条 outputs（导入不保留执行结果）`);
  }
  const lines = text.split('\n');
  const code = lines
    .map((line, i) => {
      if (!MAGIC_RE.test(line)) return line;
      warnings.push(`cell ${cellNo}: 第 ${i + 1} 行 magic 降级为注释: ${line.trim()}`);
      return demoteMagicLine(line);
    })
    .join('\n');
  return { id: newId(), kind: 'code', code };
}

/** nbformat JSON 文本 → {cells, warnings}（纯函数，单测直调）。 */
export function parseNotebookText(
  text: string,
  newId: () => string = () => newCellId(),
): { cells: ImportedCell[]; warnings: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ImportError(`import.ipynb：不是合法 JSON: ${(err as Error).message}`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new ImportError('import.ipynb：顶层不是 notebook 对象');
  }
  const nb = json as Record<string, unknown>;
  if (!Array.isArray(nb['cells'])) {
    throw new ImportError('import.ipynb：缺少 cells 数组（不是 nbformat notebook？）');
  }
  const warnings: string[] = [];
  const major = nb['nbformat'];
  if (typeof major === 'number' && major !== 4) {
    warnings.push(`nbformat ${major}.${String(nb['nbformat_minor'] ?? '?')}（目标 4.5）—— 宽容转换`);
  }
  const cells: ImportedCell[] = [];
  (nb['cells'] as unknown[]).forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      warnings.push(`cell ${i + 1}: 非对象条目跳过`);
      return;
    }
    cells.push(convertCell(raw as Record<string, unknown>, i + 1, newId, warnings));
  });
  return { cells, warnings };
}

/* ---------- 写盘入口 ---------- */

/** 缺省 target：同目录、去扩展名 + '.py'。 */
export function defaultTargetPath(sourcePath: string): string {
  const dir = path.dirname(sourcePath);
  const base = path.basename(sourcePath, path.extname(sourcePath));
  return path.join(dir, `${base}.py`);
}

/**
 * 读 .ipynb → 生成 NovaLab .py（wx 排他写盘）→ {path, cells, warnings}。
 * targetPath 缺省 = defaultTargetPath(path)。源不存在/坏 JSON/目标已存在 → ImportError(-32602)，
 * 其余 fs 失败 → ImportError(-32603)。
 */
export function importIpynb(
  sourcePath: string,
  targetPath?: string,
  newId: () => string = () => newCellId(),
): ImportResult {
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '' || sourcePath.includes('\0')) {
    throw new ImportError('import.ipynb 需要非空 path');
  }
  let text: string;
  try {
    text = readFileSync(sourcePath, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'ENOENT') throw new ImportError(`import.ipynb：源文件不存在: ${sourcePath}`);
    throw new ImportError(`import.ipynb：读取失败: ${e?.message ?? String(err)}`, ERR_INTERNAL);
  }
  const { cells, warnings } = parseNotebookText(text, newId);
  const target = path.resolve(typeof targetPath === 'string' && targetPath !== '' ? targetPath : defaultTargetPath(sourcePath));
  const py = serializePy(cells);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, py, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'EEXIST') {
      throw new ImportError(`import.ipynb：目标已存在（wx 排他，不覆盖）: ${target}`);
    }
    throw new ImportError(`import.ipynb：写盘失败: ${e?.message ?? String(err)}`, ERR_INTERNAL);
  }
  return { path: target, cells, warnings };
}
