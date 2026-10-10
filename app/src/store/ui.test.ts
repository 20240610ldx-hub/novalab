/**
 * A-4 主题持久化的纯函数单测（v0.1.1：视图切换已迁至 store/layout）（注入 fake storage，无 DOM 依赖）。
 */

import { describe, expect, it } from 'vitest';
import { THEME_KEY, loadTheme, parseTheme, persistTheme, useUi } from './ui';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

describe('useUi store', () => {
  it('setTheme 更新内存态并回落 dark 默认', () => {
    expect(useUi.getState().theme).toBe('dark');
    useUi.getState().setTheme('light');
    expect(useUi.getState().theme).toBe('light');
    useUi.getState().setTheme('dark');
    expect(useUi.getState().theme).toBe('dark');
  });
});

describe('loadTheme / persistTheme（A-4）', () => {
  it('空 storage → 默认 dark；roundtrip light', () => {
    const s = fakeStorage();
    expect(loadTheme(s)).toBe('dark');
    persistTheme(s, 'light');
    expect(s.dump()[THEME_KEY]).toBe('light');
    expect(loadTheme(s)).toBe('light');
  });

  it('未知值/异常 storage → dark 兜底不炸', () => {
    expect(parseTheme('solarized')).toBe('dark');
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadTheme(throwing)).toBe('dark');
    expect(() => persistTheme(throwing, 'light')).not.toThrow();
  });
});
