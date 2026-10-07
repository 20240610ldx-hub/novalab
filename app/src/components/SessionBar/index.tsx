import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNotebook } from '../../store/notebook';
import {
  SESSION_CELL_LIMIT,
  endedLabel,
  sessionName,
  truncationBanner,
  useSession,
  type SessionMeta,
} from '../../store/session';
import { SessionModal } from '../SessionModal';

/* ------------------------------------------------------------------ */
/* P2.8 SessionBar（spec 附录 A-2 #12/#13/#14）                          */
/*                                                                     */
/* - 左 pill：会话切换器下拉（当前 live + 历史：名称=startedAt、cell 数、  */
/*   read-only 标签、来源标签 local）；                                   */
/* - 右 pill（SessionStatusPill，替换原 LivePill 位）：`live` /            */
/*   `Ended HH:MM`，下拉 = 同一会话列表；kernel dead 时附 restart 行；     */
/* - 截断横幅（>500 cells）：fixed 顶部居中（挂载位置不影响视觉位置，      */
/*   同 DiffTray 先例），导出按钮走 store exportIpynb（P3.4：-32600/-32601  */
/*   降级「接线 pending」，router 接线在 P3.1 合入后由 orchestrator 统一接）；*/
/* - `⧉ Sessions` 入口按钮 → SessionModal（P3.4）。                        */
/* ------------------------------------------------------------------ */

function fmt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : sessionName(d);
}

function endedText(iso: string | null | undefined): string {
  if (!iso) return 'ended';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'ended' : endedLabel(d);
}

/** 会话列表下拉体（左 pill 与右 pill 共用）。 */
function SessionMenu({
  sessions,
  currentId,
  viewingId,
  onPick,
  onClose,
  footer,
}: {
  sessions: SessionMeta[];
  currentId: string | null;
  viewingId: string | null;
  onPick: (sessionId: string) => void;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 最新在前（live 置顶由 currentId 高亮体现）
  const ordered = [...sessions].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-50 mt-1 max-h-80 w-80 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--panel)] py-1 shadow-lg"
    >
      {ordered.length === 0 && (
        <p className="px-3 py-2 text-[12px] text-[var(--muted)]">暂无会话记录 —— 打开 notebook 后开始。</p>
      )}
      {ordered.map((m) => {
        const live = m.endedAt === undefined;
        const isCurrent = m.id === currentId;
        const isViewing = m.id === viewingId;
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => onPick(m.id)}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-[var(--bg)] ${
              isViewing ? 'text-[var(--accent-run)]' : 'text-[var(--text)]'
            }`}
          >
            <span aria-hidden style={{ color: live ? 'var(--accent-ok)' : 'var(--muted)' }}>●</span>
            <span className="min-w-0 flex-1 truncate">{fmt(m.startedAt)}</span>
            <span className="text-[var(--muted)]">{m.cellCount} cells</span>
            {live && isCurrent && (
              <span className="rounded bg-[var(--bg)] px-1 text-[10px] text-[var(--accent-ok)]">live</span>
            )}
            {!live && (
              <span className="rounded bg-[var(--bg)] px-1 text-[10px] text-[var(--muted)]">read-only</span>
            )}
            {m.source === 'agent' && (
              <span className="rounded bg-[var(--bg)] px-1 text-[10px] text-[var(--accent-run)]">agent</span>
            )}
          </button>
        );
      })}
      {footer}
    </div>
  );
}

/** 下拉共用的选取逻辑：live 当前会话 → backToLive；历史 → openHistory。 */
function makePickSession(close: () => void): (sessionId: string) => void {
  return (sessionId) => {
    const s = useSession.getState();
    close();
    if (sessionId === s.currentId && !s.currentEndedAt) {
      void s.backToLive();
    } else {
      void s.openHistory(sessionId);
    }
  };
}

/** header 左 pill：notebook 名 + 会话切换下拉（A-2 #13）+ SessionModal 入口（P3.4）。 */
export function SessionBar() {
  const notebookPath = useNotebook((s) => s.notebookPath);
  const sessions = useSession((s) => s.sessions);
  const currentId = useSession((s) => s.currentId);
  const viewingId = useSession((s) => s.viewingId);
  const refreshSessions = useSession((s) => s.refreshSessions);
  const openModal = useSession((s) => s.openModal);
  const [open, setOpen] = useState(false);

  // 打开下拉时拉最新列表（live cellCount / 新 ended 会话）
  const toggle = () => {
    if (!open) void refreshSessions();
    setOpen((v) => !v);
  };

  const fileName = notebookPath ? notebookPath.split(/[\\/]/).pop() : null;
  const viewing = sessions.find((m) => m.id === viewingId);
  const label = viewing ? fmt(viewing.startedAt) : fileName ? `${fileName} · python` : 'NovaLab';

  return (
    <div className="relative flex items-center gap-1.5">
      <button
        type="button"
        onClick={toggle}
        disabled={!notebookPath}
        title="session switcher — 当前与历史会话"
        className="flex items-center gap-1.5 rounded-full bg-[var(--panel)] px-3 py-1 hover:border-[var(--border)] disabled:cursor-default disabled:opacity-60"
      >
        <span className="max-w-56 truncate">{label}</span>
        {viewing && (
          <span className="rounded bg-[var(--bg)] px-1 text-[10px] text-[var(--muted)]">read-only</span>
        )}
        <span aria-hidden className="text-[9px] text-[var(--muted)]">▼</span>
      </button>
      {/* P3.4：SessionModal 入口（segments 折叠分组 + .ipynb 导出/导入） */}
      <button
        type="button"
        onClick={openModal}
        disabled={!notebookPath}
        title="Session notebook — 会话浏览 · .ipynb 导出/导入"
        className="flex items-center gap-1 rounded-full bg-[var(--panel)] px-2.5 py-1 text-[12px] text-[var(--muted)] hover:border-[var(--border)] hover:text-[var(--text)] disabled:cursor-default disabled:opacity-60"
      >
        <span aria-hidden>⧉</span>
        <span>Sessions</span>
      </button>
      {open && notebookPath && (
        <SessionMenu
          sessions={sessions}
          currentId={currentId}
          viewingId={viewingId}
          onPick={makePickSession(() => setOpen(false))}
          onClose={() => setOpen(false)}
        />
      )}
      {/* A-2 #14 截断横幅：fixed 顶部居中（挂载点不影响视觉位置） */}
      <TruncationBanner />
      {/* P3.4 SessionModal：fixed 覆盖层，modalOpen=false 时渲染 null */}
      <SessionModal />
    </div>
  );
}

/** header 右 pill：`live` / `Ended HH:MM`，下拉 = 同会话列表（A-2 #12）。 */
export function SessionStatusPill() {
  const kernelState = useNotebook((s) => s.kernelState);
  const restartKernel = useNotebook((s) => s.restartKernel);
  const readOnly = useSession((s) => s.readOnly);
  const sessions = useSession((s) => s.sessions);
  const currentId = useSession((s) => s.currentId);
  const currentEndedAt = useSession((s) => s.currentEndedAt);
  const viewingId = useSession((s) => s.viewingId);
  const refreshSessions = useSession((s) => s.refreshSessions);
  const [open, setOpen] = useState(false);

  const ended = currentEndedAt !== null;
  const color = ended ? 'var(--accent-err)' : kernelState === 'busy' ? 'var(--accent-run)' : kernelState === 'dead' ? 'var(--accent-err)' : 'var(--accent-ok)';
  const text = ended ? endedText(currentEndedAt) : kernelState;

  const toggle = () => {
    if (!open) void refreshSessions();
    setOpen((v) => !v);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        title={ended ? 'kernel session ended — 浏览历史会话' : `kernel ${kernelState} — 会话列表`}
        className="flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 py-0.5 text-[12px] hover:border-[var(--muted)]"
        style={{ color }}
      >
        <span aria-hidden>●</span>
        {text}
        <span aria-hidden className="text-[9px] text-[var(--muted)]">▼</span>
      </button>
      {open && (
        <SessionMenu
          sessions={sessions}
          currentId={currentId}
          viewingId={viewingId}
          onPick={makePickSession(() => setOpen(false))}
          onClose={() => setOpen(false)}
          footer={
            kernelState === 'dead' && !readOnly ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  void restartKernel();
                }}
                className="mt-1 w-full border-t border-[var(--border)] px-3 py-1.5 text-left text-[12px] text-[var(--accent-err)] hover:bg-[var(--bg)]"
              >
                ↻ restart kernel（开启新会话）
              </button>
            ) : undefined
          }
        />
      )}
    </div>
  );
}

/** >500 cells 横幅 + export.ipynb 按钮（走 store action：-32600/-32601 降级「接线 pending」，P3.4）。 */
function TruncationBanner() {
  const viewingId = useSession((s) => s.viewingId);
  const historyTotal = useSession((s) => s.historyTotal);
  const exportState = useSession((s) => s.exportState);
  if (!viewingId) return null;
  const text = truncationBanner(historyTotal);
  if (!text) return null;
  const pending = exportState.status === 'pending-wiring';
  return (
    <div className="fixed left-1/2 top-2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-md border border-[var(--accent-run)] bg-[var(--panel)] px-4 py-2 text-[12px] shadow-lg">
      <span>{text}</span>
      <button
        type="button"
        title={
          pending
            ? '接线 pending —— export.ipynb 尚未接入 router（P3.1 合入后生效）'
            : `export .ipynb — 完整日志见 ${SESSION_CELL_LIMIT}+ 导出（nbformat 4.5）`
        }
        onClick={() => {
          void useSession.getState().exportIpynb(viewingId);
        }}
        className="rounded border border-[var(--border)] px-2 py-0.5 text-[var(--muted)] hover:border-[var(--accent-run)]"
      >
        export .ipynb{pending ? '（接线 pending）' : ''}
      </button>
    </div>
  );
}
