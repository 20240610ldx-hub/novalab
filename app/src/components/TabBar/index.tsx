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
  if (tab.bridgeLost) return t('tab.bridgeLostTitle');
  if (tab.ended) return t('tab.endedTitle');
  const mem = tab.rssMB !== null ? ` · ${tab.rssMB}MB` : '';
  return t('tab.stateTitle', { state: tab.kernelState, mem, path: tab.path });
}

/**
 * @param dimActive 编辑区正显示 Welcome 时为 true：当前 tab 不再呈 selected 态
 *   （aria-selected=false → 去掉 active pill 样式），点击它即回到 notebook。
 */
/** 恢复日志时间：本地时区 HH:MM（跨日加日期）。 */
function formatDraftTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const hm = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return at.toDateString() === new Date().toDateString() ? hm : `${at.toLocaleDateString()} ${hm}`;
}

export function TabBar({ dimActive = false }: { dimActive?: boolean } = {}) {
  const tabs = useNotebooks((s) => s.tabs);
  const activeId = useNotebooks((s) => s.activeId);
  const switchTab = useNotebook((s) => s.switchTab);
  const closeTab = useNotebook((s) => s.closeTab);
  const flushSaves = useNotebook((s) => s.flushSaves);
  const reloadFromDisk = useNotebook((s) => s.reloadFromDisk);
  const reopenLostTab = useNotebook((s) => s.reopenLostTab);
  const reopenAllLostTabs = useNotebook((s) => s.reopenAllLostTabs);
  const restoreDraft = useNotebook((s) => s.restoreDraft);
  const preserveDraft = useNotebook((s) => s.preserveDraft);
  const discardDraft = useNotebook((s) => s.discardDraft);
  const bridgeStatus = useNotebook((s) => s.bridgeStatus);
  const historyView = useNotebook((s) => s.historyView);
  const openNotebook = useNotebook((s) => s.openNotebook);
  const refreshList = useNotebooks((s) => s.refreshList);
  const { t } = useI18n();
  const lostTabs = tabs.filter((tab) => tab.bridgeLost && !tab.conflict);

  const [adding, setAdding] = useState(false);
  const [reopeningAll, setReopeningAll] = useState(false);
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
    return (t?.ended ?? false) || (t?.reloading ?? false) || (t?.restarting ?? false);
  });
  const viewingId = useSession((s) => s.viewingId);
  useEffect(() => {
    if (viewingId) return;
    if (useSession.getState().readOnly !== activeEnded) {
      useSession.setState({ readOnly: activeEnded });
    }
  }, [activeEnded, viewingId]);

  // notebook.open 的 session.started 早于前端路径提交；路径落定后再刷新，切 tab 同理。
  const notebookPath = useNotebook((s) => s.notebookPath);
  const refreshSessions = useSession((s) => s.refreshSessions);
  useEffect(() => {
    if (notebookPath && !viewingId) void refreshSessions(notebookPath);
  }, [notebookPath, viewingId, refreshSessions]);

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
    if (t.closing || t.reloading || t.conflict) return;
    if (hasUnsavedChanges(t)) {
      const ok = window.confirm(`"${tabLabel(t.path)}" 有未保存改动，保存后关闭？（内核将 shutdown，会话结束）`);
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
    <div className="flex min-w-0 flex-col">
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {tabs.map((tab) => {
        const active = tab.notebookId === activeId;
        return (
          <div
            key={tab.notebookId}
            role="tab"
            aria-selected={active && !dimActive}
            title={stateTitle(t, tab)}
            onClick={() => void switchTab(tab.notebookId)}
            className={`group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-t border border-b-0 px-2.5 py-1 text-[12px] ${
              active
                ? 'border-[var(--border)] bg-[var(--panel)] text-[var(--text)]'
                : 'border-transparent bg-transparent text-[var(--muted)] hover:bg-[var(--bg)]'
            } ${tab.ended || tab.bridgeLost ? 'opacity-60' : ''}`}
            data-bridge-lost={tab.bridgeLost ? 'true' : undefined}
          >
            {/* 内核状态点（ended 灰） */}
            <span aria-hidden style={{ color: dotColor(tab), fontSize: 9 }}>
              ●
            </span>
            <span className={`max-w-40 truncate ${tab.ended || tab.bridgeLost ? 'italic' : ''}`}>{tabLabel(tab.path)}</span>
            {/* 未保存改动标记 */}
            {tab.dirty && (
              <span aria-hidden title={t('tab.dirtyTitle')} className="text-[9px] text-[var(--accent-run)]">
                ●
              </span>
            )}
            {tab.ended && !tab.bridgeLost && (
              <span className="rounded bg-[var(--bg)] px-1 text-[9px] text-[var(--muted)]">ended</span>
            )}
            {tab.bridgeLost && (
              <span className="rounded bg-[var(--bg)] px-1 text-[9px] text-[var(--muted)]">{t('tab.bridgeLostBadge')}</span>
            )}
            {/* × 关闭 */}
            <button
              type="button"
              aria-label={`close ${tabLabel(tab.path)}`}
              disabled={tab.closing || tab.reloading || !!tab.conflict}
              aria-busy={tab.closing || tab.reloading}
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
    {lostTabs.length >= 2 && (
      <div role="status" data-testid="bridge-lost-all"
        className="flex items-center gap-2 border-t border-[var(--border)] px-2 py-1 text-[12px] text-[var(--muted)]">
        <span className="min-w-0 flex-1">{t('tab.bridgeLostAllSummary', { count: lostTabs.length })}</span>
        <button
          type="button"
          data-testid="bridge-lost-reopen-all"
          disabled={bridgeStatus !== 'connected' || reopeningAll}
          onClick={() => {
            setReopeningAll(true);
            void reopenAllLostTabs().finally(() => setReopeningAll(false));
          }}
          className="shrink-0 rounded border border-[var(--accent-run)] px-2 py-0.5 text-[var(--accent-run)] hover:bg-[var(--panel)] disabled:opacity-50"
        >{reopeningAll ? t('tab.bridgeLostReopeningAll') : t('tab.bridgeLostReopenAll')}</button>
      </div>
    )}
    {lostTabs.map((tab) => (
      <div key={`lost-${tab.notebookId}`} role="status" data-testid="bridge-lost-row"
        className="flex items-center gap-2 border-t border-[var(--border)] px-2 py-1 text-[12px] text-[var(--muted)]">
        <span className="min-w-0 flex-1">
          {tabLabel(tab.path)} · {tab.dirty ? t('tab.bridgeLostDirty') : t('tab.bridgeLostClean')}
        </span>
        <button
          type="button"
          data-testid="bridge-lost-reopen"
          disabled={bridgeStatus !== 'connected' || reopeningAll}
          onClick={() => void reopenLostTab(tab.notebookId)}
          className="shrink-0 rounded border border-[var(--border)] px-2 py-0.5 text-[var(--text)] disabled:opacity-50"
        >{t('tab.bridgeLostReopen')}</button>
      </div>
    ))}
    {tabs.filter((tab) => tab.draftRecovery).map((tab) => {
      const offer = tab.draftRecovery!;
      const vars = { time: formatDraftTime(offer.savedAt), count: offer.dirtyCellIds.length };
      return (
        <div key={`draft-${tab.notebookId}`} role="alert" data-testid="draft-recovery"
          data-baseline-matches={offer.baselineMatches ? 'true' : 'false'}
          className="space-y-1 border-t border-[var(--border)] px-2 py-2 text-[12px] text-[var(--text)]">
          <p>{tabLabel(tab.path)} · {offer.baselineMatches ? t('tab.draftFoundMatch', vars) : t('tab.draftFoundChanged', vars)}</p>
          {offer.error && <p className="text-[var(--accent-err)]">{offer.error}</p>}
          <div className="flex gap-2">
            {offer.baselineMatches ? (
              <button type="button" data-testid="draft-restore" disabled={historyView}
                onClick={() => restoreDraft(tab.notebookId)}
                className="rounded border border-[var(--border)] px-2 py-0.5 disabled:opacity-50">{t('tab.draftRestore')}</button>
            ) : (
              <button type="button" data-testid="draft-preserve" disabled={bridgeStatus !== 'connected'}
                onClick={() => void preserveDraft(tab.notebookId)}
                className="rounded border border-[var(--border)] px-2 py-0.5 disabled:opacity-50">{t('tab.draftPreserve')}</button>
            )}
            <button type="button" data-testid="draft-discard" disabled={bridgeStatus !== 'connected'}
              onClick={() => void discardDraft(tab.notebookId)}
              className="rounded border border-[var(--border)] px-2 py-0.5 text-[var(--muted)] disabled:opacity-50">{t('tab.draftDiscard')}</button>
          </div>
        </div>
      );
    })}
    {tabs.filter((tab) => tab.draftJournalError).map((tab) => (
      <div key={`draft-error-${tab.notebookId}`} role="status" className="border-t border-[var(--border)] px-2 py-1 text-[12px] text-[var(--muted)]">
        {tabLabel(tab.path)} · {tab.draftJournalError}
      </div>
    ))}
    {tabs.filter((tab) => tab.conflict).map((tab) => (
      <div key={tab.notebookId} role="alert" className="space-y-1 border-t border-[var(--border)] px-2 py-2 text-[12px] text-[var(--accent-err)]">
        <p>{tabLabel(tab.path)} 的文件已有外部版本。本地编辑仍保留，自动保存已暂停。</p>
        {tab.conflict!.recoveryPath && <p className="break-all text-[var(--text)]">本地副本：{tab.conflict!.recoveryPath}</p>}
        {tab.conflict!.recoveryError && <p>本地副本保存失败：{tab.conflict!.recoveryError}</p>}
        {tab.conflict!.message && <p>加载外部版本失败：{tab.conflict!.message}</p>}
        <button
          type="button"
          disabled={tab.reloading || tab.closing || historyView || !!viewingId}
          aria-busy={tab.reloading}
          onClick={() => void reloadFromDisk(tab.notebookId)}
          className="rounded border border-[var(--border)] px-2 py-0.5 text-[var(--text)] disabled:opacity-50"
        >保留本地副本并加载磁盘版本</button>
        {tab.reloading && <p className="text-[var(--muted)]">正在保留本地副本并加载外部版本…</p>}
      </div>
    ))}
    {tabs.filter((tab) => tab.recoveryPath && !tab.conflict).map((tab) => (
      <div key={tab.notebookId} role="status" className="break-all border-t border-[var(--border)] px-2 py-1 text-[12px] text-[var(--muted)]">
        {tabLabel(tab.path)} · 本地副本：{tab.recoveryPath}
      </div>
    ))}
    {tabs.filter((tab) => tab.error && !tab.conflict).map((tab) => (
      <div key={tab.notebookId} role="alert" className="flex items-center gap-2 border-t border-[var(--border)] px-2 py-1 text-[12px] text-[var(--accent-err)]">
        <span>{tabLabel(tab.path)} · {tab.error!.operation === 'close' ? '关闭失败' : tab.error!.operation === 'restart' ? '重启失败' : tab.error!.operation === 'reopen' ? '重新打开失败' : '保存失败'}：{tab.error!.message}</span>
        <button
          type="button"
          disabled={tab.closing}
          onClick={() => {
            if (tab.error!.operation === 'close') void closeTab(tab.notebookId);
            else if (tab.error!.operation === 'reopen') void reopenLostTab(tab.notebookId);
            else if (tab.error!.operation === 'restart') {
              void (async () => {
                if (useNotebooks.getState().activeId !== tab.notebookId) await switchTab(tab.notebookId);
                await useNotebook.getState().restartKernel();
              })();
            } else void flushSaves(tab.notebookId).catch(() => {});
          }}
          className="shrink-0 rounded border border-[var(--border)] px-2 py-0.5 text-[var(--text)] disabled:opacity-50"
        >Retry</button>
      </div>
    ))}
    </div>
  );
}
