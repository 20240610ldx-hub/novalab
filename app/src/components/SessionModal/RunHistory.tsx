import { useMemo, useState } from 'react';
import { Bot } from 'lucide-react';
import { useI18n } from '../../i18n';
import { lineDiff, type RunRecordWire } from './runLog';

const TRIGGER_KEYS = {
  direct: 'sessionModal.trigger.direct',
  cascade: 'sessionModal.trigger.cascade',
  accept: 'sessionModal.trigger.accept',
  repl: 'sessionModal.trigger.repl',
} as const;

/** 时间戳 → 本地 HH:MM:SS（会话内足够区分；日期在分组行上）。 */
function clock(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString([], { hour12: false });
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/**
 * 一个 cell 的尝试历史（ADR-014）：每次运行一行（成败 · 触发方式 · 谁触发 · 耗时 · 时间），
 * 选中一行显示它相对上一次尝试的代码差异。不展示输出内容（日志本就不存）。
 */
export function RunHistory({ runs }: { runs: readonly RunRecordWire[] }) {
  const { t } = useI18n();
  const [selected, setSelected] = useState(runs.length - 1);
  const idx = Math.min(selected, runs.length - 1);
  const cur = runs[idx];
  const prev = idx > 0 ? runs[idx - 1] : undefined;
  const diff = useMemo(
    () => (cur?.code !== undefined && prev?.code !== undefined && cur.codeSha256 !== prev.codeSha256 ? lineDiff(prev.code, cur.code) : null),
    [cur, prev],
  );
  if (!cur) return null;

  const triggerLabel = (r: RunRecordWire) => t(TRIGGER_KEYS[r.trigger] ?? 'sessionModal.trigger.direct');

  return (
    <div className="mt-2 rounded-md border border-[var(--border)] bg-[var(--bg)] text-[12px]" data-testid="run-history">
      <ol className="max-h-48 overflow-y-auto py-1 nl-scroll-thin">
        {runs.map((r, i) => (
          <li key={r.runId}>
            <button
              type="button"
              onClick={() => setSelected(i)}
              aria-current={i === idx}
              className={`flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-[var(--panel-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent-run)] ${
                i === idx ? 'bg-[var(--panel-2)]' : ''
              }`}
            >
              <span className="w-8 shrink-0 tabular-nums text-[var(--muted)]">#{r.attempt}</span>
              {r.ok ? (
                <span className="shrink-0 rounded-full border border-[var(--accent-ok)] px-1.5 text-[10.5px] text-[var(--accent-ok)]">ok</span>
              ) : (
                <span className="shrink-0 rounded-full bg-[var(--err-border)] px-1.5 text-[10.5px] text-white">
                  {r.error?.name ?? 'error'}
                  {r.error?.line !== undefined ? ` (line ${r.error.line})` : ''}
                </span>
              )}
              <span className="shrink-0 text-[var(--muted)]">{triggerLabel(r)}</span>
              {r.actor === 'agent' && (
                <span className="flex shrink-0 items-center gap-0.5 text-[var(--accent-run)]" title={t('sessionModal.runByAgent')}>
                  <Bot size={12} aria-hidden />
                  agent
                </span>
              )}
              <span className="ml-auto shrink-0 tabular-nums text-[var(--muted)]">{fmtMs(r.durationMs)}</span>
              <span className="w-16 shrink-0 text-right tabular-nums text-[var(--muted)]">{clock(r.ts)}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="border-t border-[var(--border)] px-3 py-2">
        {!prev ? (
          <p className="text-[11px] text-[var(--muted)]">{t('sessionModal.firstAttempt')}</p>
        ) : cur.codeSha256 === prev.codeSha256 ? (
          <p className="text-[11px] text-[var(--muted)]">{t('sessionModal.codeUnchanged')}</p>
        ) : !diff ? (
          <p className="text-[11px] text-[var(--muted)]">{t('sessionModal.codeOmitted')}</p>
        ) : (
          <>
            <p className="mb-1 text-[11px] text-[var(--muted)]">{t('sessionModal.diffVsPrev', { attempt: prev.attempt })}</p>
            <pre className="nl-scroll-thin max-h-56 overflow-auto rounded bg-[var(--panel)] py-1 text-[11.5px] leading-[1.6]">
              {diff.map((d, k) => (
                <div
                  key={k}
                  className={
                    d.op === '+'
                      ? 'bg-[var(--diff-add)] px-2 text-[var(--text)]'
                      : d.op === '-'
                        ? 'bg-[var(--diff-del)] px-2 text-[var(--muted)]'
                        : 'px-2 text-[var(--muted)]'
                  }
                >
                  <span aria-hidden className="mr-2 select-none opacity-60">{d.op === '=' ? ' ' : d.op}</span>
                  {d.text === '' ? ' ' : d.text}
                </div>
              ))}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
