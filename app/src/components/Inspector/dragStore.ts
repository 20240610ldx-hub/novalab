/**
 * Inspector 抽屉控制器（P3.2）：把手拖拽 / 双击折叠的状态单例。
 *
 * 拖拽逻辑全部在这里（KernelStatusBar 只转发把手的 pointerdown，最小改动）：
 * - pointerdown 记录起点；pointermove 以「起点Y - 当前Y」调高度（clamp 120–480，
 *   抽屉在 footer 上方，向上拖增高）；pointerup 落盘 localStorage；
 * - 两次 pointerdown 间隔 < 350ms 且上一击未发生真拖动（>2px）→ 判定双击 =
 *   折叠/展开（StatusBar 不接 dblclick prop，保持单一 onHandlePointerDown）；
 * - 折叠态起拖：首次移动直接张开到 MIN(120px)。
 *
 * 组件经 useSyncExternalStore 订阅；控制器本身不依赖 React。
 * node 单测：createInspectorController(注入 storage) 直接驱动，无 window 时
 * pointerdown 降级为"仅张开"（拖拽路径由纯函数 heightFromDrag 覆盖）。
 */

import {
  DOUBLE_CLICK_MS,
  DRAG_SLOP_PX,
  clampHeight,
  heightFromDrag,
  loadHeight,
  saveHeight,
  type KvStorage,
} from './helpers';

export interface InspectorView {
  open: boolean;
  height: number;
}

export interface InspectorController {
  subscribe: (l: () => void) => () => void;
  getSnapshot: () => InspectorView;
  /** 把手 pointerdown 入口（KernelStatusBar onHandlePointerDown 直连）。 */
  handlePointerDown: (e: { clientY: number; preventDefault?: () => void }) => void;
  setOpen: (open: boolean) => void;
  setHeight: (h: number) => void;
}

function browserStorage(): KvStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function createInspectorController(storage: KvStorage | null = browserStorage()): InspectorController {
  let state: InspectorView = { open: false, height: loadHeight(storage) };
  const listeners = new Set<() => void>();

  let dragging = false;
  let dragStartY = 0;
  let dragStartHeight = 0;
  let lastDownAt = 0;
  let lastDragMoved = false;

  function setState(patch: Partial<InspectorView>) {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  }

  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    if (Math.abs(e.clientY - dragStartY) > DRAG_SLOP_PX) lastDragMoved = true;
    setState({ open: true, height: heightFromDrag(dragStartHeight, dragStartY, e.clientY) });
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    saveHeight(storage, state.height);
  };

  return {
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getSnapshot: () => state,

    handlePointerDown: (e) => {
      e.preventDefault?.();
      const now = Date.now();
      if (!lastDragMoved && now - lastDownAt < DOUBLE_CLICK_MS) {
        // 双击把手 = 折叠/展开（高度保留，展开用持久化值）
        lastDownAt = 0;
        setState({ open: !state.open });
        saveHeight(storage, state.height);
        return;
      }
      lastDownAt = now;
      lastDragMoved = false;
      if (typeof window === 'undefined') {
        // node 单测环境：无 pointermove/up，退化为直接张开
        setState({ open: true });
        return;
      }
      dragging = true;
      dragStartY = e.clientY;
      dragStartHeight = state.open ? state.height : 0;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },

    setOpen: (open) => {
      setState({ open });
      if (open) saveHeight(storage, state.height);
    },

    setHeight: (h) => {
      setState({ open: true, height: clampHeight(h) });
      saveHeight(storage, h);
    },
  };
}

/** App 级单例：App.tsx 把 handlePointerDown 递给 KernelStatusBar，Inspector 订阅。 */
export const inspectorController = createInspectorController();

/** KernelStatusBar 把手 prop 的稳定引用。 */
export const inspectorHandlePointerDown = (e: { clientY: number; preventDefault?: () => void }) =>
  inspectorController.handlePointerDown(e);
