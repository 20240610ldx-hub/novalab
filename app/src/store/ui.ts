/**
 * UI 偏好 store（Q 线，spec 附录 A-3 #23 + A-4）：
 * - 顶栏 `Files | Notebook` 视图切换（localStorage novalab.view）；
 * - 主题切换 dark/light（A-4：localStorage novalab.theme，默认 dark；
 *   落地 = document.documentElement.dataset.theme → styles.css token 覆盖）。
 *
 * 独立小 store（不并入 session.ts——视图偏好与会话生命周期无关，且避免
 * node 环境测试经 session.ts 拖入 bridge client）。纯函数注入 storage 以便 vitest。
 */

import { create } from 'zustand';

export type AppView = 'files' | 'notebook';

export const VIEW_KEY = 'novalab.view';

/** 存储值 → 视图（未知/损坏值一律回退 notebook 主视图）。 */
export function parseView(raw: string | null | undefined): AppView {
  return raw === 'files' ? 'files' : 'notebook';
}

/** 读取持久化视图；storage 不可用（隐私模式/node）→ 'notebook'。 */
export function loadView(storage: Pick<Storage, 'getItem'>): AppView {
  try {
    return parseView(storage.getItem(VIEW_KEY));
  } catch {
    return 'notebook';
  }
}

/** 写入持久化视图；storage 不可用时静默忽略（内存态仍生效）。 */
export function persistView(storage: Pick<Storage, 'setItem'>, view: AppView): void {
  try {
    storage.setItem(VIEW_KEY, view);
  } catch {
    /* 忽略 */
  }
}

interface UiState {
  view: AppView;
  setView: (v: AppView) => void;
  theme: AppTheme;
  setTheme: (t: AppTheme) => void;
}

/* ---- A-4：主题（dark 默认；light = [data-theme='light'] token 覆盖） ---- */

export type AppTheme = 'dark' | 'light';

export const THEME_KEY = 'novalab.theme';

/** 存储值 → 主题（未知/损坏值一律回退 dark 默认）。 */
export function parseTheme(raw: string | null | undefined): AppTheme {
  return raw === 'light' ? 'light' : 'dark';
}

export function loadTheme(storage: Pick<Storage, 'getItem'>): AppTheme {
  try {
    return parseTheme(storage.getItem(THEME_KEY));
  } catch {
    return 'dark';
  }
}

export function persistTheme(storage: Pick<Storage, 'setItem'>, theme: AppTheme): void {
  try {
    storage.setItem(THEME_KEY, theme);
  } catch {
    /* 忽略 */
  }
}

/** 主题落地：html[data-theme]（styles.css 变量覆盖入口；node 环境静默跳过）。 */
export function applyTheme(theme: AppTheme): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
}

const initialTheme = typeof localStorage !== 'undefined' ? loadTheme(localStorage) : 'dark';
applyTheme(initialTheme);

export const useUi = create<UiState>((set) => ({
  view: typeof localStorage !== 'undefined' ? loadView(localStorage) : 'notebook',
  setView: (v) => {
    if (typeof localStorage !== 'undefined') persistView(localStorage, v);
    set({ view: v });
  },
  theme: initialTheme,
  setTheme: (t) => {
    if (typeof localStorage !== 'undefined') persistTheme(localStorage, t);
    applyTheme(t);
    set({ theme: t });
  },
}));
