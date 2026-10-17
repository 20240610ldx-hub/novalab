import { describe, expect, it } from 'vitest';
import { baseName, formatBytes, normalizeProvenance, shortHash } from './provenance';

describe('结果溯源（ADR-015 前端）', () => {
  it('宽容归一化：无记录 / 形状不对 → producedBy=null；未知字段与非法 current 丢弃', () => {
    expect(normalizeProvenance(null, 'x')).toEqual({ path: 'x', producedBy: null, inputs: [] });
    expect(normalizeProvenance({ producedBy: null }, 'x').producedBy).toBeNull();
    const v = normalizeProvenance(
      {
        producedBy: { cellId: 'b', runId: 'r-2', ts: 't', notebook: 'demo.py', extra: 1 },
        recorded: { path: 'x', sha256: 'abc', bytes: 3 },
        current: 'modified',
        inputs: [{ path: 'in.csv', sha256: null, bytes: 5, skipped: 'too-large', current: 'unknown' }, { nope: 1 }, { path: 'y', current: 'weird' }],
      },
      'x',
    );
    expect(v.producedBy).toEqual({ cellId: 'b', runId: 'r-2', ts: 't', notebook: 'demo.py' });
    expect(v.current).toBe('modified');
    expect(v.inputs).toEqual([
      { path: 'in.csv', sha256: null, bytes: 5, skipped: 'too-large', current: 'unknown' },
      { path: 'y', sha256: null, bytes: null },
    ]);
  });

  it('展示辅助：短哈希、文件名、字节数', () => {
    expect(shortHash('0123456789abcdef')).toBe('01234567');
    expect(shortHash(null)).toBe('—');
    expect(baseName('D:\\data\\survey.csv')).toBe('survey.csv');
    expect(baseName('/srv/out/fig.png')).toBe('fig.png');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(null)).toBe('');
  });
});
