/**
 * Q 线 #20：输出分区纯函数 deriveOutputSegments 单测（无 DOM）。
 * 覆盖：空输出、stdout 单独、stdout+stderr 顺序各自成区、traceback 分区
 * （frames 保留）、mime 已知键顺序与未知键排除、text/html 富表示优先（ADR-011）。
 */

import { describe, expect, it } from 'vitest';
import { deriveOutputSegments } from './OutputRenderer';
import { createEmptyOutput, type CellOutput } from '../kernel/types';

function out(partial: Partial<CellOutput>): CellOutput {
  return { ...createEmptyOutput(), ...partial };
}

describe('deriveOutputSegments（输出分区）', () => {
  it('空输出 → 无分区', () => {
    expect(deriveOutputSegments(out({}))).toEqual([]);
  });

  it('仅 stdout → 单个 stdout 分区（中性面板数据源）', () => {
    const segs = deriveOutputSegments(out({ stdout: 'hello\n' }));
    expect(segs).toEqual([{ kind: 'stdout', text: 'hello\n' }]);
  });

  it('stdout + stderr → 两个独立分区，stdout 在前（参考图 [76] 相继堆叠）', () => {
    const segs = deriveOutputSegments(out({ stdout: 'rows=5\n', stderr: 'RuntimeWarning: x\n' }));
    expect(segs.map((s) => s.kind)).toEqual(['stdout', 'stderr']);
    expect(segs[1]).toEqual({ kind: 'stderr', text: 'RuntimeWarning: x\n' });
  });

  it('traceback → 独立红面板分区，frames 原样保留，排在 stdout/stderr 之后', () => {
    const frames = [{ file: '<cell e5d6f7a8>', line: 3, fn: '<module>', srcLine: 'label = row["county"]' }];
    const segs = deriveOutputSegments(
      out({ stdout: 'a\n', stderr: 'b\n', traceback: { text: 'KeyError: county', frames } }),
    );
    expect(segs.map((s) => s.kind)).toEqual(['stdout', 'stderr', 'traceback']);
    expect(segs[2]).toEqual({ kind: 'traceback', text: 'KeyError: county', frames });
  });

  it('mime：text/plain 数组拼接为 text-plain 分区；image/png → image；未知键不产生分区', () => {
    const segs = deriveOutputSegments(
      out({
        mime: {
          'text/plain': ['col\n', '1'],
          'image/png': 'aGVsbG8=',
          'application/vnd.vega.v5+json': '{}',
        },
      }),
    );
    expect(segs).toEqual([
      { kind: 'text-plain', text: 'col\n1' },
      { kind: 'image', data: 'aGVsbG8=' },
    ]);
  });

  it('text/html + text/plain → 只出 html 分区（富表示优先），text/plain 随分区携带作回落', () => {
    const segs = deriveOutputSegments(
      out({ mime: { 'text/plain': '   county\n0  沈阳', 'text/html': '<table><tr><td>沈阳</td></tr></table>' } }),
    );
    expect(segs).toEqual([
      {
        kind: 'html',
        html: '<table><tr><td>沈阳</td></tr></table>',
        fallbackText: '   county\n0  沈阳',
      },
    ]);
  });

  it('仅 text/html → html 分区且 fallbackText 为 null；空 html 串视为缺失 → 回到 text-plain', () => {
    expect(deriveOutputSegments(out({ mime: { 'text/html': ['<table>', '</table>'] } }))).toEqual([
      { kind: 'html', html: '<table></table>', fallbackText: null },
    ]);
    expect(deriveOutputSegments(out({ mime: { 'text/plain': '42', 'text/html': '' } }))).toEqual([
      { kind: 'text-plain', text: '42' },
    ]);
  });

  it('html 分区占 text-plain 原位：stdout → html → image → control', () => {
    const segs = deriveOutputSegments(
      out({
        stdout: 'rows=4\n',
        mime: {
          'application/vnd.novalab.control+json': '{}',
          'image/png': 'aGVsbG8=',
          'text/html': '<table></table>',
          'text/plain': 'df',
        },
      }),
    );
    expect(segs.map((s) => s.kind)).toEqual(['stdout', 'html', 'image', 'control']);
  });

  it('control mime → control 分区（载荷原样透传 ControlRenderer）', () => {
    const payload = JSON.stringify({ controlId: 'c1::s', kind: 'slider', spec: {}, value: 42 });
    const segs = deriveOutputSegments(
      out({ mime: { 'application/vnd.novalab.control+json': payload } }),
    );
    expect(segs).toEqual([{ kind: 'control', data: payload }]);
  });
});
