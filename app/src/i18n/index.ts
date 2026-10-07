/**
 * i18n 骨架（P4.3，Q3）：t(key, vars?) + useI18n()。
 *
 * - 字典：en.ts（默认）/ zh.ts，键集相等由 i18n.test.ts 单测把关；
 * - 语言持久化 localStorage 'novalab.lang'（store/ui.ts 的 load/persist 惯式：
 *   纯函数注入 storage，隐私模式/node 环境静默回退）；
 * - 插值：`{var}` 占位符替换（vars 缺省键时保留占位原文，不炸）；
 * - cell 代码与文档**不翻译**（Owner 纪律）；截图参考原文在 en 字典保留。
 *
 * useI18n() 返回 { lang, setLang, t }——组件在 lang 变化时重渲染；
 * 非组件场景直接用导出的 t()（读当前 store 语言）。
 */

import { useCallback } from 'react';
import { create } from 'zustand';
import { en } from './en';
import { zh } from './zh';

export type Lang = 'en' | 'zh';

export const LANG_KEY = 'novalab.lang';

export type I18nKey = keyof typeof en;

/** t 函数签名（组件外纯函数需要注入 t 时用，如 TabBar.stateTitle）。 */
export type TFn = (key: I18nKey, vars?: Record<string, string | number>) => string;

const DICTS: Record<Lang, Record<I18nKey, string>> = { en, zh };

/** 存储值 → 语言（未知/损坏值一律回退 en 默认）。 */
export function parseLang(raw: string | null | undefined): Lang {
  return raw === 'zh' ? 'zh' : 'en';
}

/** 读取持久化语言；storage 不可用（隐私模式/node）→ 'en'。 */
export function loadLang(storage: Pick<Storage, 'getItem'>): Lang {
  try {
    return parseLang(storage.getItem(LANG_KEY));
  } catch {
    return 'en';
  }
}

/** 写入持久化语言；storage 不可用时静默忽略（内存态仍生效）。 */
export function persistLang(storage: Pick<Storage, 'setItem'>, lang: Lang): void {
  try {
    storage.setItem(LANG_KEY, lang);
  } catch {
    /* 忽略 */
  }
}

/** `{var}` 插值：vars 缺键/值为 undefined 时保留占位原文（可见的坏，好过静默吞）。 */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = vars[name];
    return v === undefined ? m : String(v);
  });
}

/** 按语言取词并插值（未知 key 回退 key 本身——字典缺键在 UI 上可见可查）。 */
export function translate(lang: Lang, key: I18nKey, vars?: Record<string, string | number>): string {
  const template = DICTS[lang][key] ?? DICTS.en[key] ?? String(key);
  return interpolate(template, vars);
}

interface I18nState {
  lang: Lang;
  setLang: (l: Lang) => void;
}

const initialLang = typeof localStorage !== 'undefined' ? loadLang(localStorage) : 'en';

export const useI18nStore = create<I18nState>((set) => ({
  lang: initialLang,
  setLang: (l) => {
    if (typeof localStorage !== 'undefined') persistLang(localStorage, l);
    set({ lang: l });
  },
}));

/** 非组件场景的 t()：读当前 store 语言。 */
export function t(key: I18nKey, vars?: Record<string, string | number>): string {
  return translate(useI18nStore.getState().lang, key, vars);
}

/**
 * 组件入口：lang 变化触发重渲染；t 绑定当前语言。
 * t 必须引用稳定（useCallback 仅随 lang 变）——消费方把它放进 useCallback/
 * useEffect 依赖（如 Onboarding.runChecks），每次渲染新闭包会造成 effect
 * 反复重启 → setState 循环（真机 Maximum update depth 事故的根因之一）。
 */
export function useI18n(): { lang: Lang; setLang: (l: Lang) => void; t: TFn } {
  const lang = useI18nStore((s) => s.lang);
  const setLang = useI18nStore((s) => s.setLang);
  const t = useCallback(
    (key: I18nKey, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang],
  );
  return { lang, setLang, t };
}
