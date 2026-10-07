/**
 * SessionModal（P3.4，spec §7 `<SessionModal> segments 折叠分组 + export .ipynb`）。
 *
 * - 头部：`Session notebook` + notebook 名 + `N sessions · M cells`；顶部 import .ipynb；
 * - 主体：按 session.list 分组（buildSegments：会话即 segment，>30min 间隔在会话内
 *   再切子段——parts>1 时 header 注记）；每段折叠/展开，展开列该会话快照 cells 的
 *   **完整只读 cell 卡**（A-3 #24，Q 线）：[n] 徽章 + 语言 chip + error (line N)
 *   实心红 pill + 右对齐内核名 + 只读代码（出错行红底）+ 复制钮 + 输出区
 *   （stdout 中性面板 / stderr·traceback 红面板 / wrote 行 / mime 键名注记；
 *   历史快照仅文本形态）；>500 cell 复用 store 既有截断 selector；
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
  type SessionSnapshotCell,
} from '../../store/session';
import { useNotebook } from '../../store/notebook';
import { useI18n } from '../../i18n';
import { CopyButton } from '../CellEditor';
import { ErrPanel, OutPanel, WriteNotifications } from '../OutputRenderer';
import {
  errorLineFromTraceback,
  execBadge,
  sessionHeaderText,
  snapshotHasOutput,
} from './selectors';

/* ------------------------------------------------------------------ */
/* A-3 #24：完整只读 cell 卡                                             */
/* ------------------------------------------------------------------ */

/** 只读代码块：逐行 span（出错行 --err-line 整行红底，复用 errorLine 装饰观感）。 */
function ReadOnlyCode({ code, errorLine }: { code: string; errorLine: number | null }) {
  const lines = (code ?? '').split('\n');
  return (
    <pre className="nl-scroll-thin overflow-x-auto rounded-md bg-[var(--panel)] px-3 py-1.5 text-[12px] leading-[1.65] text-[var(--text)]">
      {lines.map((l, i) => (
        <span key={i} className={`block min-w-fit ${errorLine === i + 1 ? 'nl-err-line' : ''}`}>
          {l === '' ? ' ' : l}
        </span>
      ))}
    </pre>
  );
}

function SnapshotCellCard({ cell, index }: { cell: SessionSnapshotCell; index: number }) {
  const o = cell.output;
  const errorLine = o?.traceback ? errorLineFromTraceback(o.traceback) : null;
  const hasOutput = snapshotHasOutput(cell);
  // 折叠披露沿用 ▶/▼ output；error 卡默认展开
  const [open, setOpen] = useState(!!o?.traceback);
  const { t } = useI18n();

  return (
    <article className="my-2 rounded-md border border-[var(--border)] bg-[var(--bg)] pb-1">
      {/* 卡头：[n] 徽章 + 语言 chip + error (line N) 实心红 pill + 右对齐内核名 */}
      <div className="flex items-center gap-2 px-3 pt-2 text-[11px] select-none">
        <span className="text-[var(--muted)]" title="execution count">
          {execBadge(cell, index)}
        </span>
        <span
          className="rounded-full px-2 py-px"
          style={{ background: 'var(--chip-bg)', color: 'var(--chip-text)' }}
        >
          python
        </span>
        {o?.traceback && (
          <span
            className="rounded-full px-2 py-px text-white"
            style={{ background: 'var(--err-border)' }}
            title={t('sessionModal.errorBadgeTitle')}
          >
            {errorLine !== null ? `error (line ${errorLine})` : 'error'}
          </span>
        )}
        <span className="ml-auto text-[var(--muted)]" title="会话内核">
          python
        </span>
      </div>

      {/* 只读代码 + 右上复制钮（#21 同源组件，hover 显现） */}
      <div className="group relative mt-1 px-2">
        <ReadOnlyCode code={cell.code} errorLine={o?.traceback ? errorLine : null} />
        <div className="absolute right-3.5 top-2.5">
          <CopyButton getText={() => cell.code} label={`copy cell ${index + 1} code`} />
        </div>
      </div>

      {/* 输出区：stdout 中性面板 / stderr·traceback 红面板 / mime 键名注记 / wrote 行 */}
      {hasOutput && (
        <div className="px-2">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="flex w-full items-center gap-1.5 px-1 py-1 text-[11px] text-[var(--muted)] hover:text-[var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent-run)]"
          >
            <span aria-hidden>{open ? '▼' : '▶'}</span>
            <span>output</span>
            {o?.traceback && <span className="text-[var(--muted)]/70">· error</span>}
          </button>
          {open && (
            <div className="space-y-2 border-t border-[var(--border)] p-1.5 text-[12px]">
              {o?.stdout !== '' && o?.stdout != null && (
                <OutPanel>
                  <pre className="whitespace-pre-wrap break-words px-3 py-2">{o.stdout}</pre>
                </OutPanel>
              )}
              {o?.stderr !== '' && o?.stderr != null && (
                <ErrPanel>
                  <pre className="whitespace-pre-wrap break-words px-3 py-2">{o.stderr}</pre>
                </ErrPanel>
              )}
              {o?.traceback && (
                <ErrPanel>
                  <pre className="whitespace-pre-wrap break-words px-3 py-2">{o.traceback}</pre>
                </ErrPanel>
              )}
              {(o?.mimeKeys?.length ?? 0) > 0 && (
                <div className="px-1 text-[11px] text-[var(--muted)]">
                  {t('sessionModal.mimeNote', { keys: o.mimeKeys.join(', ') })}
                </div>
              )}
              <WriteNotifications writes={o?.writes ?? []} />
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ */

/** 单个会话段：header（点击折叠/展开）+ 展开时的完整只读 cell 卡（#24）。 */
function SessionSection({ seg }: { seg: SessionSegment }) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();
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
          {loading && <p className="py-1 text-[11px] text-[var(--muted)]">{t('sessionModal.loadingSnapshot')}</p>}
          {!loading && cells && cells.length === 0 && (
            <p className="py-1 text-[11px] text-[var(--muted)]">{t('sessionModal.noSnapshotCells')}</p>
          )}
          {!loading &&
            cells?.map((c, i) => <SnapshotCellCard key={c.id} cell={c} index={i} />)}
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
  const { t } = useI18n();

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
        aria-label={t('sessionModal.title')}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-[min(860px,92vw)] flex-col rounded-lg border border-[var(--border)] bg-[var(--panel)] shadow-xl"
      >
        {/* 头部 */}
        <header className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] text-[var(--text)]">{t('sessionModal.title')}</h2>
            <p className="truncate text-[11px] text-[var(--muted)]">
              {fileName ?? t('sessionModal.noNotebook')} ·{' '}
              {t('sessionModal.summary', { sessions: summary.sessionCount, cells: summary.cellCount })}
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
              placeholder={t('sessionModal.importPlaceholder')}
              aria-label={t('sessionModal.importAria')}
              className="w-52 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-[11px] text-[var(--text)] placeholder:text-[var(--muted)]"
            />
            <button
              type="button"
              disabled={busy || importPath.trim() === ''}
              title={
                importState.status === 'pending-wiring'
                  ? t('sessionModal.importWiringPending')
                  : t('sessionModal.importTitle')
              }
              onClick={() => {
                void importNotebook(importPath).then((ok) => {
                  if (ok) setImportPath('');
                });
              }}
              className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text)] hover:border-[var(--accent-run)] disabled:opacity-50"
            >
              {t('sessionModal.importButton')}
            </button>
            <button
              type="button"
              onClick={closeModal}
              aria-label={t('sessionModal.closeAria')}
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
              {t('sessionModal.empty')}
            </p>
          )}
          {segments.map((seg) => (
            <SessionSection key={seg.sessionId} seg={seg} />
          ))}
          {importState.warnings.length > 0 && (
            <details className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--muted)]">
              <summary>{t('sessionModal.importWarnings', { count: importState.warnings.length })}</summary>
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
                ? t('sessionModal.exportWiringPending')
                : t('sessionModal.exportTitle')
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
            .ipynb{exportPending ? t('sessionModal.exportPendingSuffix') : ''}
          </button>
        </footer>
      </div>
    </div>
  );
}
