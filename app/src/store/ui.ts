/**
 * UI 偏好 store（Q 线，spec 附录 A-3 #23 + A-4；P4.2 App View）：
 * - 顶栏 `Files | Notebook` 视图切换（localStorage novalab.view）；
 * - 主题切换 dark/light（A-4：localStorage novalab.theme，默认 dark；
 *   落地 = document.documentElement.dataset.theme → styles.css token 覆盖）；
 * - P4.2 App View 模式（edit/app，localStorage novalab.appMode + URL ?view=app
 *   双向同步——URL 是分享/刷新入口，App.tsx 负责 replaceState 回写）。
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
  /** P4.2 App View：edit = 编辑器主视图；app = 只读报告视图（隐藏代码）。 */
  appMode: AppMode;
  setAppMode: (m: AppMode) => void;
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

/* ---- P4.2：App View 模式（edit 默认；app = 只读报告视图，spec §15.4） ---- */

export type AppMode = 'edit' | 'app';

export const APP_MODE_KEY = 'novalab.appMode';

/** 存储值 → 模式（未知/损坏值一律回退 edit 主视图）。 */
export function parseAppMode(raw: string | null | undefined): AppMode {
  return raw === 'app' ? 'app' : 'edit';
}

export function loadAppMode(storage: Pick<Storage, 'getItem'>): AppMode {
  try {
    return parseAppMode(storage.getItem(APP_MODE_KEY));
  } catch {
    return 'edit';
  }
}

export function persistAppMode(storage: Pick<Storage, 'setItem'>, mode: AppMode): void {
  try {
    storage.setItem(APP_MODE_KEY, mode);
  } catch {
    /* 忽略 */
  }
}

/**
 * URL ?view= 参数 → 模式（P4.2 双向同步的读侧）。
 * 仅识别 `view=app`（进入）与 `view=edit`（退出）；其他值/缺省 → null（无意见）。
 */
export function parseAppModeParam(raw: string | null | undefined): AppMode | null {
  if (raw === 'app') return 'app';
  if (raw === 'edit') return 'edit';
  return null;
}

/** search 串（含或不含前导 `?`）→ 模式意见；无 view 参数 → null。 */
export function appModeFromSearch(search: string): AppMode | null {
  try {
    return parseAppModeParam(new URLSearchParams(search).get('view'));
  } catch {
    return null;
  }
}

/**
 * 模式 → search 串回写（写侧纯函数）：app 置 view=app，edit 删除 view 参数；
 * 其余参数（如 ?path=）原样保留。
 */
export function searchWithAppMode(search: string, mode: AppMode): string {
  const params = new URLSearchParams(search);
  if (mode === 'app') params.set('view', 'app');
  else params.delete('view');
  const s = params.toString();
  return s === '' ? '' : `?${s}`;
}

const initialTheme = typeof localStorage !== 'undefined' ? loadTheme(localStorage) : 'dark';
applyTheme(initialTheme);

/** 初始模式：URL ?view=app 优先（分享/刷新入口），其次 localStorage，最后 edit。 */
function initialAppMode(): AppMode {
  if (typeof window !== 'undefined') {
    const fromUrl = appModeFromSearch(window.location.search);
    if (fromUrl) return fromUrl;
  }
  return typeof localStorage !== 'undefined' ? loadAppMode(localStorage) : 'edit';
}

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
  appMode: initialAppMode(),
  setAppMode: (m) => {
    if (typeof localStorage !== 'undefined') persistAppMode(localStorage, m);
    set({ appMode: m });
  },
}));
