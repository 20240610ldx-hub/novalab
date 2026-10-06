import { describe, expect, it } from 'vitest';
import {
  PREVIEW_STRING_LIMIT,
  TRUNCATION_SUFFIX,
  serializePreview,
  truncateString,
} from './preview';

function randomString(len: number): string {
  const parts: string[] = [];
  let remaining = len;
  while (remaining > 0) {
    // 混合 ASCII、CJK、emoji（代理对）——截断按 String.length（UTF-16 码元）计。
    const kind = Math.floor(Math.random() * 3);
    let ch: string;
    if (kind === 0) ch = String.fromCharCode(32 + Math.floor(Math.random() * 95));
    else if (kind === 1) ch = String.fromCharCode(0x4e00 + Math.floor(Math.random() * 0x5000));
    else ch = String.fromCodePoint(0x1f300 + Math.floor(Math.random() * 0x500));
    parts.push(ch);
    remaining -= ch.length;
  }
  const s = parts.join('');
  return s.length > len ? s.slice(0, len) : s;
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value !== null && typeof value === 'object')
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  return out;
}

describe('truncateString', () => {
  it('短字符串原样返回', () => {
    expect(truncateString('hello')).toBe('hello');
    expect(truncateString('')).toBe('');
  });

  it('恰好 4096 字符不截断，4097 必截断', () => {
    const exact = randomString(PREVIEW_STRING_LIMIT);
    expect(truncateString(exact)).toBe(exact);
    const over = randomString(PREVIEW_STRING_LIMIT + 1);
    const out = truncateString(over);
    expect(out).toBe(over.slice(0, PREVIEW_STRING_LIMIT) + TRUNCATION_SUFFIX);
  });

  it('fuzz：1B–1MB 随机字符串，输出必 ≤4KB+标记', () => {
    const maxLen = PREVIEW_STRING_LIMIT + TRUNCATION_SUFFIX.length;
    for (let i = 0; i < 120; i++) {
      // 对数分布覆盖 1 .. 1_000_000 字符
      const len = 1 + Math.floor(Math.exp(Math.random() * Math.log(1_000_000)));
      const s = randomString(len);
      const out = truncateString(s);
      expect(out.length).toBeLessThanOrEqual(maxLen);
      if (s.length > PREVIEW_STRING_LIMIT) {
        expect(out.endsWith(TRUNCATION_SUFFIX)).toBe(true);
        expect(out.slice(0, PREVIEW_STRING_LIMIT)).toBe(s.slice(0, PREVIEW_STRING_LIMIT));
      } else {
        expect(out).toBe(s);
      }
    }
  });
});

describe('serializePreview', () => {
  it('fuzz：任意嵌套结构的字符串字段全部受限', () => {
    const maxLen = PREVIEW_STRING_LIMIT + TRUNCATION_SUFFIX.length;
    for (let i = 0; i < 40; i++) {
      const big = randomString(1 + Math.floor(Math.exp(Math.random() * Math.log(1_000_000))));
      const payload = {
        code: big,
        rows: [{ text: big }, { text: 'short' }],
        deep: { a: { b: { c: [big] } } },
        n: 42,
        ok: true,
        nil: null,
      };
      const out = serializePreview(payload);
      for (const s of collectStrings(out)) {
        expect(s.length).toBeLessThanOrEqual(maxLen);
      }
      // 非字符串标量原样放行
      const rec = out as typeof payload;
      expect(rec.n).toBe(42);
      expect(rec.ok).toBe(true);
      expect(rec.nil).toBeNull();
    }
  });

  it('schema 对象原样放行：不改形状、不删键', () => {
    const schema = {
      name: 'df',
      type: 'DataFrame',
      shape: [100000, 12],
      columns: ['county', 'value'],
      dtypes: { county: 'object', value: 'float64' },
      len: 100000,
      preview: { county: 'Ada', value: 1.5 },
    };
    expect(serializePreview(schema)).toEqual(schema);
  });

  it('schema 中超长 preview 字符串仍被截断（硬保证优先）', () => {
    const schema = { name: 's', type: 'str', preview: randomString(10_000) };
    const out = serializePreview(schema) as typeof schema;
    expect(Object.keys(out).sort()).toEqual(['name', 'preview', 'type']);
    expect(out.preview.length).toBeLessThanOrEqual(PREVIEW_STRING_LIMIT + TRUNCATION_SUFFIX.length);
    expect(out.preview.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it('循环引用不死循环', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    const out = serializePreview(a) as Record<string, unknown>;
    expect(out['name']).toBe('a');
    expect(out['self']).toBe('[circular]');
  });
});
