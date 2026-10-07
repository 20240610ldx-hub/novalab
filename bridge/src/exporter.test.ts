/**
 * exporter 单测（P3.4）：nbformat 4.5 骨架构造、source 行数组、五路输出映射
 * （stream/display_data/error/writes/execution_count）、meta 透传、id 去重、
 * 参数校验与写盘。纯模块直调（不经 router——P3.1 接线前契约即本文件）。
 */

import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IpynbError,
  buildNotebook,
  buildOutputs,
  exportIpynb,
  parseTracebackTail,
  toSourceLines,
  type ExportCell,
} from './exporter';

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'novalab-export-'));
}

interface NbCell {
  cell_type: string;
  id: string;
  execution_count: number | null;
  outputs: Record<string, unknown>[];
  source: string[];
}

function nbOf(p: string): { cells: NbCell[]; metadata: Record<string, unknown>; nbformat: number; nbformat_minor: number } {
  return JSON.parse(readFileSync(p, 'utf8'));
}

describe('toSourceLines（nbformat 多行字符串约定）', () => {
  it('行间保留 \\n、末行不带；末尾换行不产生空元素；空文本 → []', () => {
    expect(toSourceLines('a\nb')).toEqual(['a\n', 'b']);
    expect(toSourceLines('a\nb\n')).toEqual(['a\n', 'b']);
    expect(toSourceLines('single')).toEqual(['single']);
    expect(toSourceLines('')).toEqual([]);
    expect(toSourceLines('\n')).toEqual([]); // 纯换行文本 → 空 source
  });
});

describe('buildNotebook（nbformat 4.5 骨架）', () => {
  it('顶层字段：nbformat 4.5 + kernelspec + cells', () => {
    const nb = buildNotebook([{ code: 'x = 1', execCount: 2 }]);
    expect(nb['nbformat']).toBe(4);
    expect(nb['nbformat_minor']).toBe(5);
    const meta = nb['metadata'] as Record<string, unknown>;
    expect(meta['kernelspec']).toEqual({ display_name: 'Python 3', language: 'python', name: 'python3' });
    const cells = nb['cells'] as NbCell[];
    expect(cells).toHaveLength(1);
    expect(cells[0]!.cell_type).toBe('code');
    expect(cells[0]!.execution_count).toBe(2);
    expect(cells[0]!.source).toEqual(['x = 1']);
  });

  it('execCount 0/缺省/null → execution_count null', () => {
    const nb = buildNotebook([{ code: 'a' }, { code: 'b', execCount: 0 }, { code: 'c', execCount: null }]);
    expect((nb['cells'] as NbCell[]).map((c) => c.execution_count)).toEqual([null, null, null]);
  });

  it('meta → metadata.novalab（含 exporter 标记；undefined 键不落）', () => {
    const nb = buildNotebook([], { sessionId: 's1', startedAt: 'T0', notebookPath: 'n.py' });
    const novalab = (nb['metadata'] as Record<string, Record<string, unknown>>)['novalab']!;
    expect(novalab).toMatchObject({ exporter: 'novalab-p3.4', sessionId: 's1', startedAt: 'T0', notebookPath: 'n.py' });
    expect(novalab).not.toHaveProperty('endedAt');
  });

  it('cell id：缺省派生 cell-<i>，重复加后缀去重（nbformat 4.5 唯一性）', () => {
    const nb = buildNotebook([{ id: 'dup', code: 'a' }, { id: 'dup', code: 'b' }, { code: 'c' }]);
    expect((nb['cells'] as NbCell[]).map((c) => c.id)).toEqual(['dup', 'dup-2', 'cell-2']);
  });

  it('非数组 cells → IpynbError(-32602)', () => {
    expect(() => buildNotebook('nope' as unknown as ExportCell[])).toThrow(IpynbError);
    try {
      buildNotebook(null as unknown as ExportCell[]);
    } catch (e) {
      expect((e as IpynbError).code).toBe(-32602);
    }
  });
});

describe('buildOutputs（五路映射）', () => {
  it('stdout / stderr → stream（name 区分，text 行数组）', () => {
    const outs = buildOutputs({ stdout: 'hello\nworld\n', stderr: 'warn\n' });
    expect(outs).toEqual([
      { output_type: 'stream', name: 'stdout', text: ['hello\n', 'world'] },
      { output_type: 'stream', name: 'stderr', text: ['warn'] },
    ]);
  });

  it('text/plain + image/png → 单个 display_data bundle；其余 mime 键忽略', () => {
    const outs = buildOutputs({
      mime: { 'text/plain': '<Figure>', 'image/png': 'iVBORw0=', 'application/json': { a: 1 } as unknown as string },
    });
    expect(outs).toHaveLength(1);
    expect(outs[0]).toEqual({
      output_type: 'display_data',
      metadata: {},
      data: { 'text/plain': ['<Figure>'], 'image/png': 'iVBORw0=' },
    });
  });

  it('traceback → error：ename/evalue 解析 + traceback 行数组', () => {
    const tb = 'Traceback (most recent call last):\n  File "<cell a>", line 1\nValueError: boom';
    const outs = buildOutputs({ traceback: tb });
    expect(outs[0]).toMatchObject({ output_type: 'error', ename: 'ValueError', evalue: 'boom' });
    expect((outs[0]!['traceback'] as string[])[2]).toContain('ValueError: boom');
  });

  it('traceback 末行不匹配 Name: msg → ename=Error 回退', () => {
    expect(parseTracebackTail('some weird tail')).toEqual({ ename: 'Error', evalue: 'some weird tail' });
    expect(parseTracebackTail('KeyboardInterrupt')).toEqual({ ename: 'KeyboardInterrupt', evalue: '' });
  });

  it('writes → stream stdout 行 `wrote <path>`（A-2 #15 同文案）', () => {
    const outs = buildOutputs({ writes: ['D:/out/a.csv', 'D:/out/b.csv'] });
    expect(outs).toEqual([
      { output_type: 'stream', name: 'stdout', text: ['wrote D:/out/a.csv\n', 'wrote D:/out/b.csv'] },
    ]);
  });

  it('全形态输出 → 固定顺序 [stdout, stderr, display_data, error, writes-stream]；null/空 → []', () => {
    const outs = buildOutputs({
      stdout: 'o\n',
      stderr: 'e\n',
      mime: { 'text/plain': 'repr' },
      traceback: 'RuntimeError: x',
      writes: ['/tmp/f'],
    });
    expect(outs.map((o) => o['output_type'])).toEqual(['stream', 'stream', 'display_data', 'error', 'stream']);
    expect(outs[4]!['name']).toBe('stdout');
    expect(buildOutputs(null)).toEqual([]);
    expect(buildOutputs({})).toEqual([]);
  });
});

describe('exportIpynb（写盘入口）', () => {
  it('写盘 .ipynb：父目录递归创建、JSON 可回读、返回 {path, nbCells, nbOutputs}', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'deep', 'sess.ipynb');
    const res = exportIpynb(
      {
        targetPath: target,
        cells: [
          { id: 'a1', code: 'x = 1', execCount: 1, output: { stdout: 'hi\n' } },
          { id: 'a2', code: 'raise ValueError("boom")', execCount: 2, output: { traceback: 'ValueError: boom' } },
          { id: 'a3', code: '# never run' },
        ],
      },
      { sessionId: 's-20261007T090000-abcd' },
    );
    expect(res.path).toBe(path.resolve(target));
    expect(res.nbCells).toBe(3);
    expect(res.nbOutputs).toBe(2);
    expect(existsSync(target)).toBe(true);
    const nb = nbOf(res.path);
    expect(nb.cells[0]!.outputs[0]).toMatchObject({ output_type: 'stream', name: 'stdout' });
    expect(nb.cells[1]!.outputs[0]).toMatchObject({ output_type: 'error', ename: 'ValueError' });
    expect(nb.cells[2]!.outputs).toEqual([]);
    expect((nb.metadata['novalab'] as Record<string, unknown>)['sessionId']).toBe('s-20261007T090000-abcd');
  });

  it('参数校验：targetPath 空/含 NUL、cells 非数组 → IpynbError(-32602)', () => {
    expect(() => exportIpynb({ cells: [], targetPath: '  ' })).toThrow(/非空 targetPath/);
    expect(() => exportIpynb({ cells: [], targetPath: 'a\0b.ipynb' })).toThrow(IpynbError);
    expect(() => exportIpynb({ cells: 'x' as unknown as ExportCell[], targetPath: 'a.ipynb' })).toThrow(IpynbError);
    expect(() => exportIpynb(null as unknown as { cells: ExportCell[]; targetPath: string })).toThrow(IpynbError);
  });
});
