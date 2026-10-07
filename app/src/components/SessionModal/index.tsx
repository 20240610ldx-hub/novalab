/**
 * SessionModal（P3.4，spec §7 `<SessionModal> segments 折叠分组 + export .ipynb`）。
 *
 * - 头部：`Session notebook` + notebook 名 + `N sessions · M cells`；顶部 import .ipynb；
 * - 主体：按 session.list 分组（buildSegments：会话即 segment，>30min 间隔在会话内
 *   再切子段——parts>1 时 header 注记）；每段折叠/展开，展开列该会话快照 cells 的
 *   只读精简行 `[n] + 首行代码 + 状态点`；>500 cell 复用 store 既有截断 selector；
 * - footer 右：`.ipynb` 导出（export.ipynb rpc）；-32600/-32601 → 降级
 *   （tooltip「接线 pending」，P3.1 router 合入后自然恢复）。
 * - Esc / 遮罩点击关闭。挂载点：SessionBar（fixed 覆盖层，挂载位置不影响视觉）。
 */

import { useEffect, useState } from 'react';
import {
  buildSegments,
  modalSummary,
  truncationBanner,
  useSession,
  type SessionSegment,
} from '../../store/session';
import { useNotebook } from '../../store/notebook';
import {
  DOT_COLOR,
  cellRowLabel,
  sessionHeaderText,
  statusDot,
  summaryLabel,
} from './selectors';

/** 单个会话段：header（点击折叠/展开）+ 展开时的只读 cell 精简行。 */
function SessionSection({ seg }: { seg: SessionSegment }) {
  const [expanded, setExpanded] = useState(false);
  const loading = useSession((s) => s.snapshotLoading[seg.sessionId] ?? false);
  const cells = useSession((s) => s.snapshotCells[seg.sessionId]);
  const total = useSession((s) => s.snapshotTotals[seg.sessionId] ?? 0);
  const loadSnapshot = useSession((s) => s.loadSnapshot);
  const banner = cells ? truncationBanner(total) : null;

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) void loadSnapshot(seg.sessionId);
  };

  return (
    <section className="rounded-md border border-[var(--border)] bg-[var(--panel)]">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-[var(--text)] hover:bg-[var(--bg)]"
      >
        <span aria-hidden className="text-[9px] text-[var(--muted)]">{expanded ? '▼' : '▶'}</span>
        <span className="min-w-0 flex-1 truncate font-mono">{sessionHeaderText(seg)}</span>
        {seg.live && (
          <span className="rounded bg-[var(--bg)] px-1 text-[10px] text-[var(--accent-ok)]">live</span>
        )}
        {seg.source === 'agent' && (
          <span className="rounded bg-[var(--bg)] px-1 text-[10px] text-[var(--accent-run)]">agent</span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-[var(--border)] px-3 py-1.5">
          {banner && (
            <p className="mb-1 rounded border border-[var(--accent-run)] px-2 py-1 text-[11px] text-[var(--accent-run)]">
              {banner}
            </p>
          )}
          {loading && <p className="py-1 text-[11px] text-[var(--muted)]">加载快照…</p>}
          {!loading && cells && cells.length === 0 && (
            <p className="py-1 text-[11px] text-[var(--muted)]">无快照 cells（live 会话尚未落盘或快照缺失）。</p>
          )}
          {!loading &&
            cells?.map((c, i) => (
              <div key={c.id} className="flex items-center gap-2 py-0.5 text-[11px]">
                <span aria-hidden style={{ color: DOT_COLOR[statusDot(c)] }}>●</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[var(--text)]">{cellRowLabel(i, c.code)}</span>
                {c.execCount > 0 && <span className="text-[var(--muted)]">[{c.execCount}]</span>}
              </div>
            ))}
        </div>
      )}
    </section>
  );
}

export function SessionModal() {
  const modalOpen = useSession((s) => s.modalOpen);
  const closeModal = useSession((s) => s.closeModal);
  const sessions = useSession((s) => s.sessions);
  const exportState = useSession((s) => s.exportState);
  const importState = useSession((s) => s.importState);
  const exportIpynb = useSession((s) => s.exportIpynb);
  const importNotebook = useSession((s) => s.importNotebook);
  const notebookPath = useNotebook((s) => s.notebookPath);
  const [importPath, setImportPath] = useState('');

  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modalOpen, closeModal]);

  if (!modalOpen) return null;

  const segments = buildSegments(sessions);
  const summary = modalSummary(sessions);
  const fileName = notebookPath ? notebookPath.split(/[\\/]/).pop() : null;
  const exportPending = exportState.status === 'pending-wiring';
  const busy = exportState.status === 'working' || importState.status === 'working';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={closeModal}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Session notebook"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-[min(720px,92vw)] flex-col rounded-lg border border-[var(--border)] bg-[var(--panel)] shadow-xl"
      >
        {/* 头部 */}
        <header className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] text-[var(--text)]">Session notebook</h2>
            <p className="truncate text-[11px] text-[var(--muted)]">
              {fileName ?? '未打开 notebook'} · {summaryLabel(summary.sessionCount, summary.cellCount)}
            </p>
          </div>
          {/* 顶部 import .ipynb（路径输入 → import.ipynb rpc → openNotebook） */}
          <div className="flex items-center gap-1.5">
            <input
              value={importPath}
              onChange={(e) => setImportPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && importPath.trim() !== '') void importNotebook(importPath);
              }}
              placeholder="path/to/notes.ipynb"
              aria-label="import .ipynb 路径"
              className="w-52 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-[11px] text-[var(--text)] placeholder:text-[var(--muted)]"
            />
            <button
              type="button"
              disabled={busy || importPath.trim() === ''}
              title={
                importState.status === 'pending-wiring'
                  ? '接线 pending —— import.ipynb 尚未接入 router（P3.1 合入后生效）'
                  : 'import .ipynb → 生成 NovaLab .py 并打开（outputs 丢弃、magic 降级注释）'
              }
              onClick={() => {
                void importNotebook(importPath).then((ok) => {
                  if (ok) setImportPath('');
                });
              }}
              className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text)] hover:border-[var(--accent-run)] disabled:opacity-50"
            >
              import .ipynb
            </button>
            <button
              type="button"
              onClick={closeModal}
              aria-label="关闭"
              className="rounded px-1.5 py-0.5 text-[13px] text-[var(--muted)] hover:text-[var(--text)]"
            >
              ✕
            </button>
          </div>
        </header>

        {/* 主体：会话段列表 */}
        <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
          {segments.length === 0 && (
            <p className="py-6 text-center text-[12px] text-[var(--muted)]">
              暂无会话记录 —— 打开 notebook 并运行 cell 后开始。
            </p>
          )}
          {segments.map((seg) => (
            <SessionSection key={seg.sessionId} seg={seg} />
          ))}
          {importState.warnings.length > 0 && (
            <details className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--muted)]">
              <summary>import 降级警告（{importState.warnings.length}）</summary>
              <ul className="mt-1 list-disc pl-4">
                {importState.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>

        {/* footer：左状态文案，右 .ipynb 导出 */}
        <footer className="flex items-center gap-3 border-t border-[var(--border)] px-4 py-2.5">
          <p className="min-w-0 flex-1 truncate text-[11px] text-[var(--muted)]" aria-live="polite">
            {exportState.message ?? importState.message ?? ''}
          </p>
          <button
            type="button"
            disabled={busy || sessions.length === 0}
            title={
              exportPending
                ? '接线 pending —— export.ipynb 尚未接入 router（P3.1 合入后生效）'
                : '导出当前/浏览中会话为 .ipynb（nbformat 4.5）'
            }
            onClick={() => {
              void exportIpynb();
            }}
            className={`rounded border px-2.5 py-1 font-mono text-[11px] ${
              exportPending
                ? 'border-[var(--border)] text-[var(--muted)] opacity-70'
                : 'border-[var(--border)] text-[var(--text)] hover:border-[var(--accent-run)]'
            } disabled:opacity-50`}
          >
            .ipynb{exportPending ? '（接线 pending）' : ''}
          </button>
        </footer>
      </div>
    </div>
  );
}
