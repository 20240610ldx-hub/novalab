/**
 * AppView 纯选择器（P4.2，spec §15.4：隐藏代码区 + 仅渲染控件与输出）。
 * 无 DOM/store 依赖，selectors.test.ts 覆盖。
 *
 * 散文来源 = `# [md]` 前缀注释块（bridge/src/importer.ts 的 markdown cell
 * 降级格式：每行 `# [md] <原文>`）。App View 把这些行还原为散文段落；
 * cell 代码本身永不渲染（只读报告语义）。
 */

import { isOutputEmpty, type Cell } from '../../kernel/types';

/** `# [md]` 行前缀（允许行首空白、# 后可无空格；前缀后一个可选空格）。 */
const MD_LINE_RE = /^\s*#\s*\[md\]\s?(.*)$/;

/** importer 生成的头行注记（`# markdown cell —— P4 渲染为富文本…`）不展示。 */
const MD_HEADER_RE = /^\s*#\s*markdown cell\b/;

/** 单行是否为 `# [md]` 前缀行。 */
export function isMdLine(line: string): boolean {
  return MD_LINE_RE.test(line);
}

/** 整个 cell 是否为散文块：至少一行 `# [md]` 前缀。 */
export function isProseCell(cell: Pick<Cell, 'code'>): boolean {
  return cell.code.split('\n').some(isMdLine);
}

/**
 * `# [md]` 注释块 → 散文段落：逐行剥前缀，空行分段，段内换行以 \n 保留；
 * 非 `# [md]` 行（importer 头行注记、普通代码/注释）一律丢弃。
 * 无 md 行 → 空数组。
 */
export function proseParagraphs(code: string): string[] {
  const paras: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    const text = cur.join('\n').trim();
    if (text !== '') paras.push(text);
    cur = [];
  };
  for (const line of code.split('\n')) {
    if (MD_HEADER_RE.test(line)) continue;
    const m = MD_LINE_RE.exec(line);
    if (!m) continue;
    const text = m[1] ?? '';
    if (text.trim() === '') flush();
    else cur.push(text);
  }
  flush();
  return paras;
}

/**
 * App View 可见 cell：散文块（有 md 行）或有非空输出的 code cell。
 * 无输出的纯代码 cell 在报告视图里没有可渲染物 → 隐藏；repl 匿名 cell 不入报告。
 */
export function appViewCells(cells: readonly Cell[]): Cell[] {
  return cells.filter(
    (c) => c.kind === 'code' && (isProseCell(c) || !isOutputEmpty(c.output)),
  );
}

/** notebook 标题 = 路径 basename 去 .py 后缀；null/空 → null（组件层用 untitled 兜底）。 */
export function notebookTitle(path: string | null): string | null {
  if (!path) return null;
  const base = path.split(/[\\/]/).pop() ?? '';
  if (base === '') return null;
  return base.replace(/\.py$/, '');
}
