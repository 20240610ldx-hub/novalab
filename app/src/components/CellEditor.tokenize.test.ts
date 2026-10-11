import { describe, expect, it } from 'vitest';
import { tokenizeLines } from './CellEditor';

const join = (line: { text: string }[]) => line.map((t) => t.text).join('');

describe('tokenizeLines（只读代码着色，与编辑器 overlay 同规则）', () => {
  it('逐行还原原文，不丢字符', () => {
    const code = 'import pandas as pd\n\ndf = pd.read_csv("a.csv")  # load\nprint(len(df))';
    const lines = tokenizeLines(code);
    expect(lines.map(join)).toEqual(code.split('\n'));
  });

  it('关键字 / 字符串 / 注释 / 数字 / 调用着色', () => {
    const [l1, l2] = tokenizeLines('import os\nx = f"v{1}" + 42  # c\n');
    expect(l1!.find((t) => t.text === 'import')?.cls).toBe('nl-kw');
    expect(l2!.find((t) => t.text === 'f"v{1}"')?.cls).toBe('nl-str');
    expect(l2!.find((t) => t.text === '42')?.cls).toBe('nl-num');
    expect(l2!.find((t) => t.text.startsWith('#'))?.cls).toBe('nl-com');
  });

  it('跨行三引号字符串整段着色', () => {
    const lines = tokenizeLines('s = """a\nb\nc"""\ny = 1');
    expect(lines[1]).toEqual([{ text: 'b', cls: 'nl-str' }]);
    expect(join(lines[2]!)).toBe('c"""');
    expect(lines[2]![0]!.cls).toBe('nl-str');
  });

  it('空代码 → 单个空行', () => {
    expect(tokenizeLines('')).toEqual([[]]);
  });
});
