/**
 * P2.9：CellOutput.writes 与 lastCellFrameLine 纯逻辑（error (line N) 徽章 /
 * 编辑器出错行装饰共用的行号派生）。
 */

import { describe, expect, it } from 'vitest';
import {
  createEmptyOutput,
  isOutputEmpty,
  lastCellFrameLine,
  type TracebackFrame,
} from './types';

function frame(file: string, line: number, fn = '<module>'): TracebackFrame {
  return { file, line, fn };
}

describe('createEmptyOutput / isOutputEmpty（writes 增补）', () => {
  it('空输出含 writes: []，且视为空', () => {
    const o = createEmptyOutput();
    expect(o.writes).toEqual([]);
    expect(isOutputEmpty(o)).toBe(true);
  });

  it('仅有 writes 也算非空（披露面板要能展开）', () => {
    expect(isOutputEmpty({ ...createEmptyOutput(), writes: ['D:/x.csv'] })).toBe(false);
  });

  it('null / 其余字段回归', () => {
    expect(isOutputEmpty(null)).toBe(true);
    expect(isOutputEmpty({ ...createEmptyOutput(), stdout: 'a' })).toBe(false);
    // 防御：writes 缺失（旧快照）不抛、视为空
    const legacy = { stdout: '', stderr: '', mime: {}, traceback: null } as never;
    expect(isOutputEmpty(legacy)).toBe(true);
  });
});

describe('lastCellFrameLine', () => {
  it('取最后一个 <cell …> 用户帧的行号', () => {
    const frames = [
      frame('<cell a>', 3),
      frame('C:/py/lib/pandas/core.py', 812, 'to_csv'),
      frame('<cell a>', 7),
      frame('C:/py/lib/site-packages/x.py', 88, 'inner'),
    ];
    expect(lastCellFrameLine(frames)).toBe(7);
  });

  it('无用户帧（纯库帧）→ null', () => {
    expect(lastCellFrameLine([frame('C:/py/lib/x.py', 10)])).toBeNull();
  });

  it('空 / undefined → null', () => {
    expect(lastCellFrameLine([])).toBeNull();
    expect(lastCellFrameLine(undefined)).toBeNull();
  });

  it('非法行号（0/NaN）的用户帧被跳过', () => {
    expect(lastCellFrameLine([frame('<cell a>', 0), frame('<cell a>', Number.NaN)])).toBeNull();
    expect(lastCellFrameLine([frame('<cell a>', 5), frame('<cell b>', 0)])).toBe(5);
  });

  it('repl 帧（<cell repl>）同样按用户帧处理', () => {
    expect(lastCellFrameLine([frame('<cell repl>', 2)])).toBe(2);
  });
});
