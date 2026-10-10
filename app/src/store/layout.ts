/**
 * 工作台布局 store（v0.1.1，Owner 裁决：学 VS Code / JupyterLab 的工作台结构）。
 *
 *  ┌───────────────────── TitleBar（细栏：工作区 · 会话 pill · 布局/主题/App View）──┐
 *  │Act│ SidePanel        │ Editor（tab 条 + Welcome / notebook）  │ AgentPanel      │
 *  │ivi│ （活动栏选中项的  │                                        │ （可开合、可缩放）│
 *  │ty │  详细栏，可缩放） │                                        │                 │
 *  └───────────────────── StatusBar（细栏：连接 · 内核 · 隐私策略 · provider · cells）─┘
 *
 * 状态：活动栏选中项、侧栏/Agent 栏开合与宽度、编辑区显示 Welcome 还是 notebook。
 * 持久化 localStorage `novalab.layout`（JSON）；纯函数注入 storage 便于 vitest。
 * 取代 Q 线 A-3 #23 的 `Files | Notebook` 顶栏切换（Files 回归侧栏 Explorer）。
 */

import { create } from 'zustand';

export type Activity = 'explorer' | 'sessions' | 'variables';

export const ACTIVITIES: readonly Activity[] = ['explorer', 'sessions', 'variables'];

/** 编辑区内容：welcome = 引导页（JupyterLab Launcher 式）；notebook = 当前 tab。 */
export type EditorView = 'welcome' | 'notebook';

export interface LayoutPrefs {
  activity: Activity;
  sideOpen: boolean;
  sideWidth: number;
  agentOpen: boolean;
  agentWidth: number;
}

export const LAYOUT_KEY = 'novalab.layout';

export const SIDE_MIN = 180;
export const SIDE_MAX = 560;
export const AGENT_MIN = 280;
export const AGENT_MAX = 720;

export const DEFAULT_LAYOUT: LayoutPrefs = {
  activity: 'explorer',
  sideOpen: true,
  sideWidth: 260,
  agentOpen: true,
  agentWidth: 380,
};

export function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 宽容解析：未知字段丢弃、越界宽度夹紧、类型不对回默认。 */
export function parseLayout(raw: string | null | undefined): LayoutPrefs {
  let obj: Record<string, unknown> = {};
  try {
    const v: unknown = raw ? JSON.parse(raw) : {};
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) obj = v as Record<string, unknown>;
  } catch {
    /* 损坏 → 全默认 */
  }
  const d = DEFAULT_LAYOUT;
  return {
    activity: ACTIVITIES.includes(obj.activity as Activity) ? (obj.activity as Activity) : d.activity,
    sideOpen: typeof obj.sideOpen === 'boolean' ? obj.sideOpen : d.sideOpen,
    sideWidth: typeof obj.sideWidth === 'number' ? clamp(obj.sideWidth, SIDE_MIN, SIDE_MAX) : d.sideWidth,
    agentOpen: typeof obj.agentOpen === 'boolean' ? obj.agentOpen : d.agentOpen,
    agentWidth: typeof obj.agentWidth === 'number' ? clamp(obj.agentWidth, AGENT_MIN, AGENT_MAX) : d.agentWidth,
  };
}

export function loadLayout(storage: Pick<Storage, 'getItem'>): LayoutPrefs {
  try {
    return parseLayout(storage.getItem(LAYOUT_KEY));
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function persistLayout(storage: Pick<Storage, 'setItem'>, prefs: LayoutPrefs): void {
  try {
    storage.setItem(LAYOUT_KEY, JSON.stringify(prefs));
  } catch {
    /* 忽略：内存态仍生效 */
  }
}

/**
 * 活动栏点击语义（VS Code）：点未选中项 → 切换并确保侧栏打开；
 * 点已选中项 → 开合侧栏。
 */
export function clickActivity(prefs: Pick<LayoutPrefs, 'activity' | 'sideOpen'>, a: Activity): Pick<LayoutPrefs, 'activity' | 'sideOpen'> {
  if (prefs.activity === a) return { activity: a, sideOpen: !prefs.sideOpen };
  return { activity: a, sideOpen: true };
}

interface LayoutState extends LayoutPrefs {
  editorView: EditorView;
  selectActivity: (a: Activity) => void;
  toggleSide: () => void;
  toggleAgent: () => void;
  setSideWidth: (w: number) => void;
  setAgentWidth: (w: number) => void;
  showWelcome: () => void;
  showNotebook: () => void;
}

const storage = typeof localStorage !== 'undefined' ? localStorage : null;
const initial = storage ? loadLayout(storage) : { ...DEFAULT_LAYOUT };

function prefsOf(s: LayoutState): LayoutPrefs {
  return {
    activity: s.activity,
    sideOpen: s.sideOpen,
    sideWidth: s.sideWidth,
    agentOpen: s.agentOpen,
    agentWidth: s.agentWidth,
  };
}

export const useLayout = create<LayoutState>((set, get) => {
  const update = (patch: Partial<LayoutPrefs>) => {
    set(patch);
    if (storage) persistLayout(storage, prefsOf(get()));
  };
  return {
    ...initial,
    editorView: 'welcome',
    selectActivity: (a) => update(clickActivity(get(), a)),
    toggleSide: () => update({ sideOpen: !get().sideOpen }),
    toggleAgent: () => update({ agentOpen: !get().agentOpen }),
    setSideWidth: (w) => update({ sideWidth: clamp(w, SIDE_MIN, SIDE_MAX) }),
    setAgentWidth: (w) => update({ agentWidth: clamp(w, AGENT_MIN, AGENT_MAX) }),
    showWelcome: () => set({ editorView: 'welcome' }),
    showNotebook: () => set({ editorView: 'notebook' }),
  };
});
