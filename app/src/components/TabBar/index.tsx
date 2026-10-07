/**
 * TabBar（P3.1 多 tab 多内核，intent S1 / A-2 #18）。
 *
 * 一个 tab = 一个已打开的 notebook（= 一个保活的 Python 内核进程）：
 * - 文件名 + 内核状态点（idle/busy/restarting/dead 配色）+ ended 灰化（view-only）
 *   + 未保存改动标记（●）；
 * - 点击切焦点（内核不杀，切回状态即在）；× 关闭（有未保存改动先确认）；
 * - + 新建 tab（路径输入 → notebook.open）；
 * - Ctrl+Tab / Ctrl+Shift+Tab 循环切换（只吃 Ctrl+Tab，不劫持编辑器内 Tab 缩进，
 *   同 H 线快捷键纪律）；
 * - ended（内核 dead / 会话结束）tab = view-only：同步 session.readOnly 复用既有只读护栏。
 *
 * 挂载于 App.tsx header（最小改动，与 SessionBar 并列）。
 */

import { useEffect, useRef, useState } from 'react';
import {
  hasUnsavedChanges,
  tabLabel,
  useNotebooks,
  type BridgeKernelState,
  type NotebookTab,
} from '../../store/notebooks';
import { useNotebook } from '../../store/notebook';
import { useSession } from '../../store/session';
import { useI18n, type TFn } from '../../i18n';

/** 内核状态点配色（与 KernelStatusBar 一致的 CSS 变量）。 */
function dotColor(t: NotebookTab): string {
  if (t.ended) return 'var(--muted)';
  switch (t.kernelState as BridgeKernelState) {
    case 'busy':
      return 'var(--accent-run)';
    case 'dead':
      return 'var(--accent-err)';
    case 'restarting':
      return 'var(--muted)';
    default:
      return 'var(--accent-ok)';
  }
}

function stateTitle(t: TFn, tab: NotebookTab): string {
  if (tab.ended) return t('tab.endedTitle');
  const mem = tab.rssMB !== null ? ` · ${tab.rssMB}MB` : '';
  return t('tab.stateTitle', { state: tab.kernelState, mem, path: tab.path });
}

export function TabBar() {
  const tabs = useNotebooks((s) => s.tabs);
  const activeId = useNotebooks((s) => s.activeId);
  const switchTab = useNotebook((s) => s.switchTab);
  const closeTab = useNotebook((s) => s.closeTab);
  const openNotebook = useNotebook((s) => s.openNotebook);
  const refreshList = useNotebooks((s) => s.refreshList);
  const { t } = useI18n();

  const [adding, setAdding] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // 连接建立后再拉 tab 列表（挂载即拉会抢跑 connectBridge，产生 console 噪声）
  const bridgeConnected = useNotebook((s) => s.bridgeConnected);
  useEffect(() => {
    if (bridgeConnected) void refreshList();
  }, [refreshList, bridgeConnected]);

  // ended（内核 dead / 会话结束）tab = view-only：同步 session.readOnly（复用只读护栏）。
  // 历史会话视图（viewingId）优先，不在此干预。
  const activeEnded = useNotebooks((s) => {
    const t = s.tabs.find((x) => x.notebookId === s.activeId);
    return t?.ended ?? false;
  });
  const viewingId = useSession((s) => s.viewingId);
  useEffect(() => {
    if (viewingId) return;
    if (useSession.getState().readOnly !== activeEnded) {
      useSession.setState({ readOnly: activeEnded });
    }
  }, [activeEnded, viewingId]);

  // 切 tab → SessionBar 只读 active notebook 的会话历史（刷新到当前 notebook 目录）
  const refreshSessions = useSession((s) => s.refreshSessions);
  useEffect(() => {
    if (activeId && !viewingId) void refreshSessions();
  }, [activeId, viewingId, refreshSessions]);

  // Ctrl+Tab / Ctrl+Shift+Tab 循环切换（capture，仅吃 Ctrl+Tab；不触碰编辑器 Tab 缩进）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 'Tab') return;
      const list = useNotebooks.getState().tabs;
      if (list.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      const cur = useNotebooks.getState().activeId;
      const idx = list.findIndex((t) => t.notebookId === cur);
      const dir = e.shiftKey ? -1 : 1;
      const next = list[(idx + dir + list.length) % list.length]!;
      void useNotebook.getState().switchTab(next.notebookId);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const onClose = (t: NotebookTab) => {
    if (hasUnsavedChanges(t)) {
      const ok = window.confirm(`"${tabLabel(t.path)}" 有未保存改动，确定关闭？（内核将 shutdown，会话结束）`);
      if (!ok) return;
    }
    void closeTab(t.notebookId);
  };

  const submitNew = () => {
    const p = pathInput.trim();
    setAdding(false);
    setPathInput('');
    if (p) void openNotebook(p);
  };

  return (
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {tabs.map((tab) => {
        const active = tab.notebookId === activeId;
        return (
          <div
            key={tab.notebookId}
            role="tab"
            aria-selected={active}
            title={stateTitle(t, tab)}
            onClick={() => void switchTab(tab.notebookId)}
            className={`group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-t border border-b-0 px-2.5 py-1 text-[12px] ${
              active
                ? 'border-[var(--border)] bg-[var(--panel)] text-[var(--text)]'
                : 'border-transparent bg-transparent text-[var(--muted)] hover:bg-[var(--bg)]'
            } ${tab.ended ? 'opacity-60' : ''}`}
          >
            {/* 内核状态点（ended 灰） */}
            <span aria-hidden style={{ color: dotColor(tab), fontSize: 9 }}>
              ●
            </span>
            <span className={`max-w-40 truncate ${tab.ended ? 'italic' : ''}`}>{tabLabel(tab.path)}</span>
            {/* 未保存改动标记 */}
            {tab.dirty && !tab.ended && (
              <span aria-hidden title={t('tab.dirtyTitle')} className="text-[9px] text-[var(--accent-run)]">
                ●
              </span>
            )}
            {tab.ended && (
              <span className="rounded bg-[var(--bg)] px-1 text-[9px] text-[var(--muted)]">ended</span>
            )}
            {/* × 关闭 */}
            <button
              type="button"
              aria-label={`close ${tabLabel(tab.path)}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab);
              }}
              className="ml-0.5 rounded px-1 text-[var(--muted)] opacity-60 hover:bg-[var(--bg)] hover:text-[var(--accent-err)] group-hover:opacity-100"
            >
              ×
            </button>
          </div>
        );
      })}

      {/* + 新建 tab：路径输入（走 notebook.open） */}
      {adding ? (
        <span className="flex shrink-0 items-center gap-1">
          <input
            ref={inputRef}
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitNew();
              else if (e.key === 'Escape') {
                setAdding(false);
                setPathInput('');
              }
            }}
            placeholder="path/to/notebook.py"
            spellCheck={false}
            className="w-48 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-[12px] placeholder-[var(--muted)] outline-none focus:border-[var(--accent-run)]"
          />
        </span>
      ) : (
        <button
          type="button"
          aria-label="new tab"
          title={t('tab.newTitle')}
          onClick={() => setAdding(true)}
          className="shrink-0 rounded px-2 py-0.5 text-[13px] text-[var(--muted)] hover:bg-[var(--bg)] hover:text-[var(--text)]"
        >
          +
        </button>
      )}
    </div>
  );
}
