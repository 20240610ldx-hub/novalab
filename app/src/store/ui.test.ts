/**
 * Q 线 #23：视图切换持久化的纯函数单测（注入 fake storage，无 DOM 依赖）。
 */

import { describe, expect, it } from 'vitest';
import { THEME_KEY, VIEW_KEY, loadTheme, loadView, parseTheme, parseView, persistTheme, persistView, useUi } from './ui';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

describe('parseView', () => {
  it('"files" → files；"notebook"/null/未知值 → notebook 兜底', () => {
    expect(parseView('files')).toBe('files');
    expect(parseView('notebook')).toBe('notebook');
    expect(parseView(null)).toBe('notebook');
    expect(parseView('garbage')).toBe('notebook');
  });
});

describe('loadView / persistView', () => {
  it('空 storage → 默认 notebook；roundtrip files', () => {
    const s = fakeStorage();
    expect(loadView(s)).toBe('notebook');
    persistView(s, 'files');
    expect(s.dump()[VIEW_KEY]).toBe('files');
    expect(loadView(s)).toBe('files');
  });

  it('storage 抛异常（隐私模式）不炸：load 回退默认、persist 静默', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadView(throwing)).toBe('notebook');
    expect(() => persistView(throwing, 'files')).not.toThrow();
  });
});

describe('useUi store', () => {
  it('setView 更新内存态（node 环境无 localStorage 也可用）', () => {
    expect(useUi.getState().view).toBe('notebook');
    useUi.getState().setView('files');
    expect(useUi.getState().view).toBe('files');
    useUi.getState().setView('notebook');
    expect(useUi.getState().view).toBe('notebook');
  });

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
