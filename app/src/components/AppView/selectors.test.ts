/**
 * AppView 选择器单测（P4.2）：散文块判定/剥前缀、可见 cell 过滤、标题派生。
 * 纯函数（无 DOM/store 依赖）。
 */

import { describe, expect, it } from 'vitest';
import type { Cell, CellOutput } from '../../kernel/types';
import { appViewCells, isMdLine, isProseCell, notebookTitle, proseParagraphs } from './selectors';

function cell(over: Partial<Cell> = {}): Cell {
  return {
    id: 'c1',
    code: 'x = 1',
    execCount: null,
    status: 'idle',
    defs: [],
    refs: [],
    sideEffect: false,
    kind: 'code',
    output: null,
    ...over,
  };
}

function output(over: Partial<CellOutput> = {}): CellOutput {
  return { stdout: '', stderr: '', mime: {}, traceback: null, writes: [], ...over };
}

describe('isMdLine / isProseCell', () => {
  it('识别 `# [md]` 前缀行（含缩进与无空格变体），普通注释/代码不算', () => {
    expect(isMdLine('# [md] hello')).toBe(true);
    expect(isMdLine('  # [md] hello')).toBe(true);
    expect(isMdLine('#[md] hello')).toBe(true);
    expect(isMdLine('# plain comment')).toBe(false);
    expect(isMdLine('x = 1  # [md] inline')).toBe(false);
  });

  it('cell 含任一 md 行即散文块；importer 头行注记单独存在不算', () => {
    expect(isProseCell(cell({ code: '# [md] title\n# [md] body' }))).toBe(true);
    expect(isProseCell(cell({ code: '# markdown cell —— P4 渲染为富文本\nx = 1' }))).toBe(false);
    expect(isProseCell(cell({ code: 'x = 1' }))).toBe(false);
  });
});

describe('proseParagraphs', () => {
  it('剥前缀、空行分段、段内换行保留', () => {
    const code = [
      '# markdown cell —— P4 渲染为富文本；原文以 \'# [md]\' 前缀保留',
      '# [md] First paragraph line one',
      '# [md] line two',
      '# [md]',
      '# [md] Second paragraph',
    ].join('\n');
    expect(proseParagraphs(code)).toEqual(['First paragraph line one\nline two', 'Second paragraph']);
  });

  it('非 md 行（代码/普通注释）一律丢弃；无 md 行 → 空数组', () => {
    expect(proseParagraphs('# [md] keep\nx = 1\n# drop')).toEqual(['keep']);
    expect(proseParagraphs('x = 1\n# plain')).toEqual([]);
  });

  it('尾部空段不产出（末尾空 md 行 flush 出空串被丢弃）', () => {
    expect(proseParagraphs('# [md] a\n# [md]\n# [md]  ')).toEqual(['a']);
  });
});

describe('appViewCells', () => {
  it('保留散文块与有输出的 code cell；隐藏无输出代码 cell 与 repl cell', () => {
    const prose = cell({ id: 'p', code: '# [md] hello' });
    const ran = cell({ id: 'r', code: 'print(1)', output: output({ stdout: '1\n' }) });
    const bare = cell({ id: 'b', code: 'x = 1' });
    const repl = cell({ id: 'repl', kind: 'repl', code: '1+1', output: output({ stdout: '2\n' }) });
    const emptyOut = cell({ id: 'e', code: 'y = 2', output: output() });
    expect(appViewCells([prose, ran, bare, repl, emptyOut]).map((c) => c.id)).toEqual(['p', 'r']);
  });

  it('空列表 → 空列表（报告空态由组件层文案兜底）', () => {
    expect(appViewCells([])).toEqual([]);
  });
});

describe('notebookTitle', () => {
  it('basename 去 .py；两种路径分隔符；null/空/尾分隔符 → null', () => {
    expect(notebookTitle('D:/ws/operon.py')).toBe('operon');
    expect(notebookTitle('D:\\ws\\operon.py')).toBe('operon');
    expect(notebookTitle('notes.txt')).toBe('notes.txt');
    expect(notebookTitle(null)).toBeNull();
    expect(notebookTitle('')).toBeNull();
    expect(notebookTitle('dir/')).toBeNull();
  });
});
