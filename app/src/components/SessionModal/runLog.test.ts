import { describe, expect, it } from 'vitest';
import { historyByCell, lineDiff, normalizeRunsWire, type RunRecordWire } from './runLog';

function rec(over: Partial<RunRecordWire>): RunRecordWire {
  return {
    runId: 'r-1', ts: '2026-10-17T10:00:00.000Z', durationMs: 5, cellId: 'a', attempt: 1,
    actor: 'user', trigger: 'direct', codeSha256: 'h1', ok: true, ...over,
  };
}

describe('运行历史（ADR-014 前端）', () => {
  it('wire 宽容归一化：非数组 / 缺字段条目丢弃', () => {
    expect(normalizeRunsWire('garbage')).toEqual([]);
    expect(normalizeRunsWire({ records: [rec({}), { runId: 1 }, null] })).toHaveLength(1);
  });

  it('按 cell 分组，并用同哈希的首次正文补齐后续记录的代码', () => {
    const records = [
      rec({ runId: 'r-1', code: 'x = 1', codeSha256: 'h1' }),
      rec({ runId: 'r-2', cellId: 'b', codeSha256: 'hb', code: 'y = x' }),
      rec({ runId: 'r-3', attempt: 2, codeSha256: 'h1' }), // 同代码重跑：正文去重未内联
      rec({ runId: 'r-4', attempt: 3, codeSha256: 'h9', codeOmitted: true }),
    ];
    const byCell = historyByCell(records);
    expect(byCell.get('a')!.map((r) => [r.attempt, r.code ?? null])).toEqual([[1, 'x = 1'], [2, 'x = 1'], [3, null]]);
    expect(byCell.get('b')).toHaveLength(1);
  });

  it('lineDiff：逐行 = / - / +，保留顺序', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { op: '=', text: 'a' },
      { op: '-', text: 'b' },
      { op: '+', text: 'B' },
      { op: '=', text: 'c' },
      { op: '+', text: 'd' },
    ]);
    expect(lineDiff('same', 'same')).toEqual([{ op: '=', text: 'same' }]);
  });

  it('lineDiff 超大输入不做 O(n·m) 计算：整体替换', () => {
    const big = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join('\n');
    const out = lineDiff(big, big + '\nextra');
    expect(out.filter((d) => d.op === '-')).toHaveLength(1500);
    expect(out.filter((d) => d.op === '+')).toHaveLength(1501);
  });
});
