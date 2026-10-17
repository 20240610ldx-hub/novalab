/**
 * SessionModal（P3.4；v0.1.1 对齐 Claude Science「Session notebook」）。
 *
 * 结构（逐元素对照 Owner 参考图）：
 *  - 头部：`Session notebook` 标题 + notebook 名 chip + `N sessions · M cells`，右上 ×；
 *  - 分组行（每个内核会话一行，可折叠）：▾ **来源**（NovaLab / Agent）+ `短 id · 开始时间 ·
 *    N cells · M segments` + live / read-only 标签；打开模态时最新会话默认展开；
 *  - 段头：`NOTEBOOK` 小号大写 + `python` chip + `· N cells`（单内核会话 = 一个段）；
 *  - cell 行（无卡片边框，行间全宽分隔线）：`[n]` + 语言 chip（+ `error (line N)` 实心红 pill）
 *    + 右对齐内核名；代码面板 = 行号 gutter + 与编辑器同规则的着色（tokenizeLines）+ 出错行
 *    红底 + 横向滚动 + hover 复制钮；`▶ output` 披露（error 默认展开）；`wrote <路径>` 行；
 *  - live 会话从 notebook store 渲染（OutputRenderer：图像 / 表格 / 富 MIME 内联，同 Claude
 *    Science 图内联）；历史会话来自快照（仅文本 + mime 键名注记，见功能矩阵 N2）；
 *  - footer：左 import .ipynb（折叠成链接），右下 `⤓ .ipynb` 导出。
 * 渲染经 portal 挂到 body：标题栏居中容器带 transform，会成为 fixed 的包含块（v0.1.1 修复）。
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Download, X } from 'lucide-react';
import {
  buildSegments,
  modalSummary,
  truncationBanner,
  useSession,
  type SessionSegment,
  type SessionSnapshotCell,
} from '../../store/session';
import { useNotebook } from '../../store/notebook';
import { isOutputEmpty, lastCellFrameLine, type Cell } from '../../kernel/types';
import { useI18n } from '../../i18n';
import { CopyButton, tokenizeLines } from '../CellEditor';
import { ErrPanel, OutPanel, OutputRenderer, WriteNotifications } from '../OutputRenderer';
import {
  errorLineFromTraceback,
  execBadge,
  groupMeta,
  groupTitle,
  plural,
  snapshotHasOutput,
} from './selectors';

/* ------------------------------------------------------------------ */
/* 只读代码面板：行号 gutter + 着色 + 出错行红底                         */
/* ------------------------------------------------------------------ */

function ReadOnlyCode({ code, errorLine }: { code: string; errorLine: number | null }) {
  const lines = useMemo(() => tokenizeLines(code), [code]);
  return (
    <div className="nl-scroll-thin overflow-x-auto rounded-md bg-[var(--bg)] py-2 text-[12.5px] leading-[1.7]">
      {/* min-w-full：出错行红底铺满面板宽度（短行时不只覆盖文字） */}
      <table className="min-w-full border-collapse">
        <tbody>
          {lines.map((toks, i) => (
            <tr key={i} className={errorLine === i + 1 ? 'nl-err-line' : ''}>
              <td className="w-10 select-none pr-4 pl-3 text-right align-top text-[var(--gutter-fg)]">{i + 1}</td>
              <td className="pr-6 whitespace-pre text-[var(--text)]">
                {toks.length === 0 ? ' ' : toks.map((t, k) => (t.cls ? <span key={k} className={t.cls}>{t.text}</span> : t.text))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* cell 行（live 与快照共用外壳）                                        */
/* ------------------------------------------------------------------ */

function CellRow({
  badge,
  code,
  errorLine,
  hasError,
  index,
  output,
  writes,
}: {
  badge: string;
  code: string;
  errorLine: number | null;
  hasError: boolean;
  index: number;
  /** 输出主体（null = 无输出，不渲染披露行）。 */
  output: ReactNode | null;
  writes: string[];
}) {
  const [open, setOpen] = useState(hasError);
  const { t } = useI18n();
  return (
    <article className="border-b border-[var(--border)] px-6 py-4" data-testid="session-cell">
      <div className="mb-2 flex items-center gap-2 text-[12px] select-none">
        <span className="text-[var(--muted)]" title="execution count">
          {badge}
        </span>
        <span className="rounded-md bg-[var(--chip-bg)] px-2 py-0.5 text-[var(--chip-text)]">python</span>
        {hasError && (
          <span className="rounded-full bg-[var(--err-border)] px-2 py-0.5 text-white" title={t('sessionModal.errorBadgeTitle')}>
            {errorLine !== null ? `error (line ${errorLine})` : 'error'}
          </span>
        )}
        <span className="ml-auto text-[var(--muted)]">python</span>
      </div>

      <div className="group relative">
        <ReadOnlyCode code={code} errorLine={hasError ? errorLine : null} />
        <div className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton getText={() => code} label={`copy cell ${index + 1} code`} />
        </div>
      </div>

      {output !== null && (
        <>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="mt-2 flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-[12px] text-[var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-run)]"
          >
            <span aria-hidden className="text-[10px] text-[var(--muted)]">
              {open ? '▼' : '▶'}
            </span>
            output
          </button>
          {open && <div className="mt-1.5 space-y-2 text-[12px]">{output}</div>}
        </>
      )}
      {writes.length > 0 && (
        <div className="mt-1.5">
          <WriteNotifications writes={writes} />
        </div>
      )}
    </article>
  );
}

/** 快照 cell（历史会话：文本形态）。 */
function SnapshotRow({ cell, index }: { cell: SessionSnapshotCell; index: number }) {
  const { t } = useI18n();
  const o = cell.output;
  const errorLine = o?.traceback ? errorLineFromTraceback(o.traceback) : null;
  const textual =
    !!o && (o.stdout !== '' || o.stderr !== '' || !!o.traceback || (o.mimeKeys?.length ?? 0) > 0);
  const body = snapshotHasOutput(cell) && textual && o ? (
    <>
      {o.stdout !== '' && (
        <OutPanel>
          <pre className="whitespace-pre-wrap break-words px-3 py-2">{o.stdout}</pre>
        </OutPanel>
      )}
      {o.stderr !== '' && (
        <ErrPanel>
          <pre className="whitespace-pre-wrap break-words px-3 py-2">{o.stderr}</pre>
        </ErrPanel>
      )}
      {o.traceback && (
        <ErrPanel>
          <pre className="whitespace-pre-wrap break-words px-3 py-2">{o.traceback}</pre>
        </ErrPanel>
      )}
      {(o.mimeKeys?.length ?? 0) > 0 && (
        <p className="px-1 text-[11px] text-[var(--muted)]">{t('sessionModal.mimeNote', { keys: o.mimeKeys.join(', ') })}</p>
      )}
    </>
  ) : null;
  return (
    <CellRow
      badge={execBadge(cell, index)}
      code={cell.code}
      errorLine={errorLine}
      hasError={!!o?.traceback}
      index={index}
      output={body}
      writes={o?.writes ?? []}
    />
  );
}

/** live cell（当前会话：notebook store 富输出，图像/表格内联）。 */
function LiveRow({ cell, index }: { cell: Cell; index: number }) {
  const o = cell.output;
  const tb = o?.traceback ?? null;
  const rich = o && !isOutputEmpty({ ...o, writes: [] }) ? <OutputRenderer output={{ ...o, writes: [] }} /> : null;
  return (
    <CellRow
      badge={`[${cell.execCount ?? index + 1}]`}
      code={cell.code}
      errorLine={tb ? (lastCellFrameLine(tb.frames) ?? errorLineFromTraceback(tb.text)) : null}
      hasError={!!tb}
      index={index}
      output={rich}
      writes={o?.writes ?? []}
    />
  );
}

/* ------------------------------------------------------------------ */
/* 分组（会话）                                                          */
/* ------------------------------------------------------------------ */

function SegmentHeader({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--side)] px-6 py-2.5 text-[12px] text-[var(--muted)]">
      <span className="text-[11px] tracking-[0.12em] uppercase">Notebook</span>
      <span className="rounded-md bg-[var(--chip-bg)] px-2 py-0.5 text-[var(--chip-text)]">python</span>
      <span>· {plural(count, 'cell')}</span>
    </div>
  );
}

function SessionGroup({ seg, defaultOpen, isLive }: { seg: SessionSegment; defaultOpen: boolean; isLive: boolean }) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const { t } = useI18n();
  const loading = useSession((s) => s.snapshotLoading[seg.sessionId] ?? false);
  const snapshot = useSession((s) => s.snapshotCells[seg.sessionId]);
  const total = useSession((s) => s.snapshotTotals[seg.sessionId] ?? 0);
  const loadSnapshot = useSession((s) => s.loadSnapshot);
  const liveCells = useNotebook((s) => s.cells);
  const executed = useMemo(
    // 失败的运行同样属于会话记录（旧内核 run.error 不带 execCount → 以 traceback 兜底）
    () =>
      liveCells.filter(
        (c) => c.kind === 'code' && ((c.execCount !== null && c.execCount > 0) || c.output?.traceback != null),
      ),
    [liveCells],
  );

  useEffect(() => {
    // O-2：按会话所属 notebook 查询，而非当前 notebook（列表可能来自另一个文件）
    if (expanded && !isLive) void loadSnapshot(seg.sessionId, seg.notebookPath);
  }, [expanded, isLive, loadSnapshot, seg.sessionId, seg.notebookPath]);

  const banner = !isLive && snapshot ? truncationBanner(total) : null;
  const count = isLive ? executed.length : (snapshot?.length ?? seg.cellCount);

  return (
    <section data-testid="session-group" data-session-id={seg.sessionId} data-live={isLive}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 border-b border-[var(--border)] px-6 py-3 text-left text-[13px] hover:bg-[var(--panel-2)]"
      >
        {expanded ? (
          <ChevronDown size={15} className="shrink-0 text-[var(--muted)]" aria-hidden />
        ) : (
          <ChevronRight size={15} className="shrink-0 text-[var(--muted)]" aria-hidden />
        )}
        <span className="font-semibold text-[var(--text)]">{groupTitle(seg)}</span>
        <span className="min-w-0 flex-1 truncate text-[var(--muted)]">{groupMeta(seg)}</span>
        <span
          className={`shrink-0 rounded-md bg-[var(--chip-bg)] px-1.5 text-[11px] ${
            seg.live ? 'text-[var(--accent-ok)]' : 'text-[var(--chip-text)]'
          }`}
        >
          {seg.live ? 'live' : 'read-only'}
        </span>
      </button>
      {expanded && (
        <div>
          <SegmentHeader count={count} />
          {banner && (
            <p className="border-b border-[var(--border)] px-6 py-2 text-[11px] text-[var(--accent-run)]">{banner}</p>
          )}
          {!isLive && loading && <p className="px-6 py-3 text-[12px] text-[var(--muted)]">{t('sessionModal.loadingSnapshot')}</p>}
          {isLive
            ? executed.map((c, i) => <LiveRow key={c.id} cell={c} index={i} />)
            : !loading && snapshot?.map((c, i) => <SnapshotRow key={c.id} cell={c} index={i} />)}
          {((isLive && executed.length === 0) || (!isLive && !loading && snapshot && snapshot.length === 0)) && (
            <p className="border-b border-[var(--border)] px-6 py-3 text-[12px] text-[var(--muted)]">
              {t('sessionModal.noSnapshotCells')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

export function SessionModal() {
  const modalOpen = useSession((s) => s.modalOpen);
  const closeModal = useSession((s) => s.closeModal);
  const sessions = useSession((s) => s.sessions);
  const currentId = useSession((s) => s.currentId);
  const readOnly = useSession((s) => s.readOnly);
  const exportState = useSession((s) => s.exportState);
  const importState = useSession((s) => s.importState);
  const exportIpynb = useSession((s) => s.exportIpynb);
  const importNotebook = useSession((s) => s.importNotebook);
  const notebookPath = useNotebook((s) => s.notebookPath);
  const [importOpen, setImportOpen] = useState(false);
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

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={closeModal}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('sessionModal.title')}
        onClick={(e) => e.stopPropagation()}
        className="flex h-[min(88vh,980px)] w-[min(1200px,94vw)] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
      >
        <header className="flex items-center gap-3 px-7 py-5">
          <h2 className="text-[20px] font-semibold text-[var(--text)]">{t('sessionModal.title')}</h2>
          <span className="max-w-64 truncate rounded-md bg-[var(--chip-bg)] px-2 py-0.5 text-[12px] text-[var(--chip-text)]">
            {fileName ?? t('sessionModal.noNotebook')}
          </span>
          <span className="text-[12px] text-[var(--muted)]">
            {t('sessionModal.summary', { sessions: summary.sessionCount, cells: summary.cellCount })}
          </span>
          <button
            type="button"
            onClick={closeModal}
            aria-label={t('sessionModal.closeAria')}
            className="ml-auto rounded p-1 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--text)]"
          >
            <X size={18} aria-hidden />
          </button>
        </header>

        <div className="nl-scroll-thin min-h-0 flex-1 overflow-y-auto border-t border-[var(--border)]">
          {segments.length === 0 && (
            <p className="py-10 text-center text-[12px] text-[var(--muted)]">{t('sessionModal.empty')}</p>
          )}
          {segments.map((seg, i) => (
            <SessionGroup
              key={seg.sessionId}
              seg={seg}
              defaultOpen={i === 0}
              // 只有当前 notebook 的当前会话可用编辑区富输出；其余按来源查询投影。
              isLive={seg.live && seg.sessionId === currentId && seg.notebookPath === notebookPath && !readOnly}
            />
          ))}
          {importState.warnings.length > 0 && (
            <details className="mx-6 my-3 rounded-md border border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--muted)]">
              <summary>{t('sessionModal.importWarnings', { count: importState.warnings.length })}</summary>
              <ul className="mt-1 list-disc pl-4">
                {importState.warnings.map((w, k) => (
                  <li key={k}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <footer className="flex items-center gap-3 border-t border-[var(--border)] px-6 py-3 text-[12px]">
          {importOpen ? (
            <span className="flex items-center gap-1.5">
              <input
                autoFocus
                value={importPath}
                onChange={(e) => setImportPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && importPath.trim() !== '') void importNotebook(importPath);
                  if (e.key === 'Escape') setImportOpen(false);
                }}
                placeholder={t('sessionModal.importPlaceholder')}
                aria-label={t('sessionModal.importAria')}
                className="w-64 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[11px] text-[var(--text)] placeholder:text-[var(--muted)]"
              />
              <button
                type="button"
                disabled={busy || importPath.trim() === ''}
                title={importState.status === 'pending-wiring' ? t('sessionModal.importWiringPending') : t('sessionModal.importTitle')}
                onClick={() => {
                  void importNotebook(importPath).then((ok) => {
                    if (ok) setImportPath('');
                  });
                }}
                className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text)] hover:border-[var(--accent-run)] disabled:opacity-50"
              >
                {t('sessionModal.importButton')}
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              title={t('sessionModal.importTitle')}
              className="text-[var(--muted)] hover:text-[var(--text)] hover:underline"
            >
              {t('sessionModal.importButton')}…
            </button>
          )}
          <p className="min-w-0 flex-1 truncate text-[11px] text-[var(--muted)]" aria-live="polite">
            {exportState.message ?? importState.message ?? ''}
          </p>
          <button
            type="button"
            disabled={busy || sessions.length === 0}
            title={exportPending ? t('sessionModal.exportWiringPending') : t('sessionModal.exportTitle')}
            onClick={() => void exportIpynb()}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--text)] disabled:opacity-50"
          >
            <Download size={14} aria-hidden />
            .ipynb{exportPending ? t('sessionModal.exportPendingSuffix') : ''}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
