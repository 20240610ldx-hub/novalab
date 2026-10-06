import { describe, expect, it } from 'vitest';
import {
  buildChatPayload,
  buildFixPayload,
  byteLength,
  enforceFieldLimit,
  filterSchemasForCell,
  MAX_FIELD_BYTES,
  PREVIEW_BYTES,
  summarizeTraceback,
  truncateToBytes,
} from './payload';
import type { VarSchema } from '../kernel/types';

/**
 * payload.ts 的隐私硬规则单测（spec §8）：
 * 4KB 截断（含多字节安全）、DataFrame 全量永不进 payload、schema/traceback 计数、rowsSent 恒 0。
 */

const frames = [
  { file: 'demo.py', line: 12, fn: '<module>', srcLine: 'result = df.groupby("k").agg(v)' },
  { file: 'pandas/core/frame.py', line: 100, fn: 'groupby', srcLine: 'raise KeyError(name)' },
];

function makeSchemas(n: number, over: Partial<VarSchema> = {}): VarSchema[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `var${i}`,
    type: 'DataFrame',
    shape: [1000, 5],
    columns: [
      { name: 'a', dtype: 'int64' },
      { name: 'b', dtype: 'str' },
    ],
    ...over,
  }));
}

describe('truncateToBytes（4KB 硬闸）', () => {
  it('短字符串原样返回', () => {
    expect(truncateToBytes('hello')).toBe('hello');
    expect(truncateToBytes('x'.repeat(MAX_FIELD_BYTES))).toBe('x'.repeat(MAX_FIELD_BYTES));
  });

  it('超过 4KB 截断且整体（含 marker）≤ 4096 字节', () => {
    const big = 'a'.repeat(MAX_FIELD_BYTES * 3);
    const out = truncateToBytes(big);
    expect(byteLength(out)).toBeLessThanOrEqual(MAX_FIELD_BYTES);
    expect(out.endsWith('…[truncated]')).toBe(true);
    expect(big.startsWith(out.slice(0, 100))).toBe(true); // 保留的是前缀
  });

  it('多字节（CJK）字符不被劈成乱码', () => {
    const cjk = '数'.repeat(MAX_FIELD_BYTES); // 每字 3 字节
    const out = truncateToBytes(cjk);
    expect(byteLength(out)).toBeLessThanOrEqual(MAX_FIELD_BYTES);
    expect(out).not.toContain('�'); // 无替换字符 = 无残尾
    const body = out.slice(0, -'…[truncated]'.length);
    expect(body.length).toBeGreaterThan(0);
    expect([...body].every((ch) => ch === '数')).toBe(true);
  });

  it('enforceFieldLimit 双保险：已组装文本再过一次闸', () => {
    const once = truncateToBytes('b'.repeat(MAX_FIELD_BYTES * 2));
    expect(byteLength(enforceFieldLimit(once))).toBeLessThanOrEqual(MAX_FIELD_BYTES);
    // 即使有人绕过第一道闸拼出超长串，第二道也拦得住
    expect(byteLength(enforceFieldLimit('c'.repeat(MAX_FIELD_BYTES + 10)))).toBeLessThanOrEqual(
      MAX_FIELD_BYTES,
    );
  });
});

describe('buildFixPayload（One-click Fix 的出进程内容）', () => {
  it('包含代码/traceback/schema 三段，计数正确，rowsSent 恒 0', () => {
    const p = buildFixPayload({
      cellId: 'c1',
      cellCode: 'df.groupby("k")',
      traceback: { text: 'Traceback…\nKeyError: k', frames },
      schemas: makeSchemas(3),
    });
    expect(p.sections.length).toBe(3);
    expect(p.schemaCount).toBe(3);
    expect(p.tracebackCount).toBe(1);
    expect(p.rowsSent).toBe(0);
    expect(p.text).toContain('df.groupby("k")');
    expect(p.text).toContain('KeyError: k');
    expect(p.text).toContain('propose_code_change'); // 指令：必须走工具提议（spec §7 单一来源工具名）
    expect(p.text).toContain('var0');
  });

  it('DataFrame 全量（100KB preview）不得进入 payload：preview 截 200B、单段截 4KB', () => {
    const hugePreview = 'row,'.repeat(25_000); // 100KB 行数据伪装成 preview
    const p = buildFixPayload({
      cellId: 'c1',
      cellCode: 'x = 1',
      traceback: { text: 'KeyError: k', frames },
      schemas: makeSchemas(2, { preview: hugePreview }),
    });
    expect(p.rowsSent).toBe(0);
    for (const sec of p.sections) {
      expect(sec.bytes).toBeLessThanOrEqual(MAX_FIELD_BYTES);
    }
    // 每个 preview 最多 200B：全文中 preview 段远小于原始 100KB×2
    expect(byteLength(p.text)).toBeLessThan(MAX_FIELD_BYTES * 4);
    expect(p.text).not.toContain('row,'.repeat(100));
    // schema 行里的 preview 确实被截过（出现截断 marker 或 ≤ PREVIEW_BYTES）
    const schemaSection = p.sections[2]!;
    expect(schemaSection.text).toContain('[truncated]');
    expect(PREVIEW_BYTES).toBe(200);
  });

  it('超长 cell 代码也被 4KB 闸截断', () => {
    const p = buildFixPayload({
      cellId: 'c1',
      cellCode: '# code\n' + 'y = 2\n'.repeat(5_000),
      traceback: { text: 'err', frames: [] },
      schemas: [],
    });
    const codeSection = p.sections[0]!;
    expect(codeSection.bytes).toBeLessThanOrEqual(MAX_FIELD_BYTES);
    expect(codeSection.text.endsWith('…[truncated]')).toBe(true);
  });
});

describe('buildChatPayload', () => {
  it('用户粘贴超 4KB 文本同样被截断（防 DataFrame 全量入 payload）', () => {
    const p = buildChatPayload('z'.repeat(MAX_FIELD_BYTES * 2));
    expect(p.sections[0]!.bytes).toBeLessThanOrEqual(MAX_FIELD_BYTES);
    expect(p.schemaCount).toBe(0);
    expect(p.tracebackCount).toBe(0);
    expect(p.rowsSent).toBe(0);
  });
});

describe('辅助纯函数', () => {
  it('filterSchemasForCell 按 refs ∪ defs 过滤', () => {
    const schemas: VarSchema[] = [
      { name: 'df_raw', type: 'DataFrame' },
      { name: 'model', type: 'LinearRegression' },
      { name: 'unrelated', type: 'int' },
    ];
    const cell = { defs: ['model'], refs: ['df_raw'] };
    expect(filterSchemasForCell(schemas, cell).map((s) => s.name).sort()).toEqual([
      'df_raw',
      'model',
    ]);
    expect(filterSchemasForCell(schemas, null)).toEqual([]);
  });

  it('summarizeTraceback 保留末行异常与尾部帧，超长截断', () => {
    const manyFrames = Array.from({ length: 30 }, (_, i) => ({
      file: `f${i}.py`,
      line: i,
      fn: `fn${i}`,
      srcLine: `line ${i}`,
    }));
    const out = summarizeTraceback({ text: 'Traceback (most recent call last):\nKeyError: k', frames: manyFrames });
    expect(out).toContain('KeyError: k');
    expect(out).toContain('f29.py'); // 尾部帧保留
    expect(out).not.toContain('f0.py'); // 头部帧丢弃
    expect(out).toContain('earlier frames omitted');
    expect(byteLength(out)).toBeLessThanOrEqual(MAX_FIELD_BYTES);
  });
});
