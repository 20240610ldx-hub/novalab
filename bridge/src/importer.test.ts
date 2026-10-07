/**
 * importer 单测（P3.4）：serialize.write 复刻格式、markdown/raw/magic/outputs
 * 四类降级 + warnings、wx 排他、缺省 targetPath、坏输入，以及与 exporter 的
 * round-trip 语义守恒（export .ipynb → import .py → code 文本逐 cell 相等）。
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEADER_LINES,
  ImportError,
  defaultTargetPath,
  importIpynb,
  joinSource,
  newCellId,
  parseNotebookText,
  serializePy,
} from './importer';
import { exportIpynb } from './exporter';

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'novalab-import-'));
}

/** 确定性 id 序列：aaaaaaaa, bbbbbbbb, …（8hex 形状由 regex 断言单独覆盖）。 */
function seqIds(): () => string {
  const letters = 'abcdef0123456789';
  let i = 0;
  return () => letters[i++ % letters.length]!.repeat(8);
}

/** py serialize.CELL_MARKER_RE 的 TS 复制（生成物必须能被 py 侧解析）。 */
const CELL_MARKER_RE = /^# %% \[cell-id: ([0-9a-fA-F]{8})\][ \t]*$/;

function nb(cells: Record<string, unknown>[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5, ...extra });
}

function writeNb(dir: string, name: string, cells: Record<string, unknown>[], extra?: Record<string, unknown>): string {
  const p = path.join(dir, name);
  writeFileSync(p, nb(cells, extra), 'utf8');
  return p;
}

describe('serializePy（py serialize.write 复刻）', () => {
  it('PEP723 头 + cell marker + 空一行 + 单 \\n 结尾', () => {
    const text = serializePy([
      { id: 'aaaaaaaa', code: 'x = 1' },
      { id: 'bbbbbbbb', code: '\ny = 2\n' },
    ]);
    expect(text).toBe(
      [
        '# /// script',
        '# requires-python = ">=3.11"',
        '# dependencies = []',
        '# ///',
        '',
        '# %% [cell-id: aaaaaaaa]',
        'x = 1',
        '',
        '# %% [cell-id: bbbbbbbb]',
        'y = 2',
        '',
      ].join('\n'),
    );
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('空 cells → 仅头部；每行 marker 匹配 py CELL_MARKER_RE', () => {
    expect(serializePy([])).toBe(`${DEFAULT_HEADER_LINES.join('\n')}\n`);
    for (const line of serializePy([{ id: '0a1b2c3d', code: 'z' }]).split('\n')) {
      if (line.startsWith('# %%')) expect(CELL_MARKER_RE.test(line)).toBe(true);
    }
  });

  it('newCellId：8 位小写 hex；joinSource：string/string[]/坏值', () => {
    for (let i = 0; i < 20; i++) expect(newCellId()).toMatch(/^[0-9a-f]{8}$/);
    expect(joinSource('a\nb')).toBe('a\nb');
    expect(joinSource(['a\n', 'b'])).toBe('a\nb');
    expect(joinSource(undefined)).toBe('');
    expect(joinSource([1, 'x', null])).toBe('x');
  });
});

describe('importIpynb（转换与降级）', () => {
  it('code cells → .py：新 8hex id（不复用 nb id）、strip 首尾换行', () => {
    const dir = tmpDir();
    const src = writeNb(dir, 'a.ipynb', [
      { cell_type: 'code', id: 'nb-id-1', source: ['x = 1\n'], outputs: [] },
      { cell_type: 'code', id: 'nb-id-2', source: 'y = 2', outputs: [] },
    ]);
    const res = importIpynb(src, undefined, seqIds());
    expect(res.path).toBe(path.join(dir, 'a.py'));
    expect(res.cells.map((c) => c.id)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
    expect(res.cells.map((c) => c.code)).toEqual(['x = 1', 'y = 2']);
    expect(res.warnings).toEqual([]);
    const text = readFileSync(res.path, 'utf8');
    expect(text).toContain('# %% [cell-id: aaaaaaaa]\nx = 1');
    expect(text).not.toContain('nb-id-1');
  });

  it('缺省 targetPath = 同目录去扩展名 + .py；显式 targetPath 生效', () => {
    expect(defaultTargetPath('D:/nb/notes.ipynb')).toBe(path.join('D:/nb', 'notes.py'));
    const dir = tmpDir();
    const src = writeNb(dir, 'b.ipynb', [{ cell_type: 'code', source: 'pass' }]);
    const custom = path.join(dir, 'sub', 'custom.py');
    const res = importIpynb(src, custom, seqIds());
    expect(res.path).toBe(custom); // 父目录递归创建 + wx 写盘成功
    expect(readFileSync(custom, 'utf8')).toContain('pass');
  });

  it('wx 排他：目标已存在 → ImportError(-32602)，既有文件不被覆盖', () => {
    const dir = tmpDir();
    const src = writeNb(dir, 'c.ipynb', [{ cell_type: 'code', source: 'new = 1' }]);
    const existing = path.join(dir, 'c.py');
    writeFileSync(existing, 'ORIGINAL', 'utf8');
    try {
      importIpynb(src, existing, seqIds());
      expect.unreachable('应当抛 ImportError');
    } catch (e) {
      expect(e).toBeInstanceOf(ImportError);
      expect((e as ImportError).code).toBe(-32602);
    }
    expect(readFileSync(existing, 'utf8')).toBe('ORIGINAL');
  });

  it('markdown cell → "# [md]" 注释块 + P4 说明行 + warning', () => {
    const dir = tmpDir();
    const src = writeNb(dir, 'd.ipynb', [
      { cell_type: 'markdown', source: ['# Title\n', '\n', 'some **md**'] },
    ]);
    const res = importIpynb(src, undefined, seqIds());
    expect(res.cells[0]!.kind).toBe('markdown');
    expect(res.cells[0]!.code.split('\n')).toEqual([
      "# markdown cell —— P4 渲染为富文本；原文以 '# [md]' 前缀保留",
      '# [md] # Title',
      '# [md]',
      '# [md] some **md**',
    ]);
    expect(res.warnings[0]).toMatch(/markdown cell 转为 '# \[md\]' 注释块（P4 将渲染为富文本）/);
  });

  it('magic（% / !）→ "# [magic]" 注释降级 + 每行 warning', () => {
    const dir = tmpDir();
    const src = writeNb(dir, 'e.ipynb', [
      { cell_type: 'code', source: ['%matplotlib inline\n', 'x = 1\n', '  !ls -la'] },
    ]);
    const res = importIpynb(src, undefined, seqIds());
    expect(res.cells[0]!.code.split('\n')).toEqual(['# [magic] %matplotlib inline', 'x = 1', '# [magic] !ls -la']);
    expect(res.warnings).toHaveLength(2);
    expect(res.warnings[0]).toMatch(/第 1 行 magic 降级为注释: %matplotlib inline/);
    expect(res.warnings[1]).toMatch(/第 3 行 magic 降级为注释: !ls -la/);
  });

  it('outputs 丢弃 + warning；raw cell → "# [raw]" 注释块', () => {
    const dir = tmpDir();
    const src = writeNb(dir, 'f.ipynb', [
      { cell_type: 'code', source: 'plot()', outputs: [{ output_type: 'display_data', data: {} }, { output_type: 'stream', text: 'x' }] },
      { cell_type: 'raw', source: 'raw payload' },
    ]);
    const res = importIpynb(src, undefined, seqIds());
    expect(res.warnings.some((w) => /丢弃 2 条 outputs/.test(w))).toBe(true);
    expect(res.cells[1]!.kind).toBe('raw');
    expect(res.cells[1]!.code).toBe('# [raw] raw payload');
    expect(res.warnings.some((w) => /raw cell 降级/.test(w))).toBe(true);
  });

  it('nbformat 主版本 ≠ 4 → 宽容转换 + warning；非对象 cell 条目跳过', () => {
    const { cells, warnings } = parseNotebookText(
      nb([{ cell_type: 'code', source: 'ok' }, null as unknown as Record<string, unknown>], { nbformat: 3, nbformat_minor: 0 }),
      seqIds(),
    );
    expect(cells).toHaveLength(1);
    expect(warnings.some((w) => /nbformat 3\.0（目标 4\.5）/.test(w))).toBe(true);
    expect(warnings.some((w) => /非对象条目跳过/.test(w))).toBe(true);
  });

  it('坏输入：非 JSON / 缺 cells / 源不存在 / path 空 → ImportError(-32602)', () => {
    const dir = tmpDir();
    const bad = path.join(dir, 'bad.ipynb');
    writeFileSync(bad, '{not json', 'utf8');
    expect(() => importIpynb(bad)).toThrow(/不是合法 JSON/);
    const noCells = path.join(dir, 'nc.ipynb');
    writeFileSync(noCells, JSON.stringify({ nbformat: 4 }), 'utf8');
    expect(() => importIpynb(noCells)).toThrow(/缺少 cells 数组/);
    expect(() => importIpynb(path.join(dir, 'missing.ipynb'))).toThrow(/源文件不存在/);
    expect(() => importIpynb('  ')).toThrow(ImportError);
    try {
      importIpynb(bad);
    } catch (e) {
      expect((e as ImportError).code).toBe(-32602);
    }
  });
});

describe('round-trip：export → import 语义守恒', () => {
  it('code 文本逐 cell 相等（纯 code fixture，outputs 丢弃出 warning）', () => {
    const dir = tmpDir();
    const originals = [
      { id: 'c1', code: 'import pandas as pd\ndf = pd.DataFrame({"a": [1, 2]})', execCount: 1, output: { stdout: 'ok\n' } },
      { id: 'c2', code: 'def f(x):\n    return x * 2\n\nf(21)', execCount: 2, output: { mime: { 'text/plain': '42' } } },
      { id: 'c3', code: '# 中文注释\nprint("你好")', execCount: 3, output: { traceback: 'ValueError: boom' } },
      { id: 'c4', code: 'tail = True' }, // 未运行
    ];
    const ipynb = path.join(dir, 'rt.ipynb');
    const exp = exportIpynb({ cells: originals, targetPath: ipynb }, { sessionId: 's-rt' });
    expect(exp.nbCells).toBe(4);

    const res = importIpynb(ipynb, undefined, seqIds());
    expect(res.cells.map((c) => c.code)).toEqual(originals.map((c) => c.code));
    expect(res.cells.every((c) => c.kind === 'code')).toBe(true);
    // outputs 只在有输出的 3 个 cell 产生丢弃 warning
    expect(res.warnings.filter((w) => /outputs/.test(w))).toHaveLength(3);

    // 生成 .py 可被 py serialize.parse 的 marker 规则再解析（幂等：再 serialize 不变）
    const text = readFileSync(res.path, 'utf8');
    expect(serializePy(res.cells)).toBe(text);
    for (const line of text.split('\n')) {
      if (line.startsWith('# %%')) expect(CELL_MARKER_RE.test(line)).toBe(true);
    }
  });

  it('magic cell round-trip：导出保留原文，导入降级为注释 + warning（语义差异被显式记录）', () => {
    const dir = tmpDir();
    const ipynb = path.join(dir, 'rt2.ipynb');
    exportIpynb({ cells: [{ id: 'm1', code: '%time x = sum(range(10))\nprint(x)', execCount: 1 }], targetPath: ipynb });
    const res = importIpynb(ipynb, undefined, seqIds());
    expect(res.cells[0]!.code).toBe('# [magic] %time x = sum(range(10))\nprint(x)');
    expect(res.warnings).toHaveLength(1);
  });
});
