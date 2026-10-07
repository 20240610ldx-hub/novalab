/**
 * i18n 骨架单测（P4.3）：en/zh 键集完全相等（任务验收项）+
 * parseLang/loadLang/persistLang 惯式（注入 fake storage）+ 插值。
 */

import { describe, expect, it } from 'vitest';
import { en } from './en';
import { zh } from './zh';
import { LANG_KEY, interpolate, loadLang, parseLang, persistLang, translate } from './index';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

describe('字典键集', () => {
  it('zh 键集与 en 完全一致（无缺键、无多键）', () => {
    const enKeys = Object.keys(en).sort();
    const zhKeys = Object.keys(zh).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it('无空值（每个键在两种语言都有非空字符串）', () => {
    for (const [k, v] of Object.entries(en)) expect(v, `en.${k}`).not.toBe('');
    for (const [k, v] of Object.entries(zh)) expect(v, `zh.${k}`).not.toBe('');
  });
});

describe('parseLang / loadLang / persistLang', () => {
  it('"zh" → zh；"en"/null/未知值 → en 兜底', () => {
    expect(parseLang('zh')).toBe('zh');
    expect(parseLang('en')).toBe('en');
    expect(parseLang(null)).toBe('en');
    expect(parseLang('garbage')).toBe('en');
  });

  it('空 storage → 默认 en；roundtrip zh 写入 novalab.lang', () => {
    const s = fakeStorage();
    expect(loadLang(s)).toBe('en');
    persistLang(s, 'zh');
    expect(s.dump()[LANG_KEY]).toBe('zh');
    expect(loadLang(s)).toBe('zh');
  });

  it('storage 抛异常（隐私模式）不炸：load 回退 en、persist 静默', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadLang(throwing)).toBe('en');
    expect(() => persistLang(throwing, 'zh')).not.toThrow();
  });
});

describe('interpolate / translate', () => {
  it('{var} 占位替换；缺键保留占位原文', () => {
    expect(interpolate('a {x} b {y}', { x: 1, y: 'two' })).toBe('a 1 b two');
    expect(interpolate('a {x} b', {})).toBe('a {x} b');
    expect(interpolate('no vars')).toBe('no vars');
  });

  it('translate：en/zh 各取各的词条并插值（kernel.cells / kernel.viewOnlyFooter）', () => {
    expect(translate('en', 'kernel.cells', { count: 19 })).toBe('19 cells');
    expect(translate('zh', 'kernel.cells', { count: 19 })).toBe('19 cells');
    expect(translate('en', 'kernel.viewOnlyFooter', { time: '15:14' })).toContain('ended 15:14');
    expect(translate('zh', 'kernel.viewOnlyFooter', { time: '15:14' })).toContain('结束于 15:14');
  });
});
