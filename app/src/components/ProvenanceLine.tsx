import { useState } from 'react';
import { Fingerprint } from 'lucide-react';
import { bridge } from '../bridge/client';
import { useI18n, type I18nKey } from '../i18n';
import { baseName, formatBytes, normalizeProvenance, shortHash, type ProvenanceCurrent, type ProvenanceFileWire, type ProvenanceView } from './provenance';

const CURRENT_KEYS: Record<ProvenanceCurrent, I18nKey> = {
  same: 'provenance.same',
  modified: 'provenance.modified',
  missing: 'provenance.missing',
  unknown: 'provenance.unknown',
};

const CURRENT_TONE: Record<ProvenanceCurrent, string> = {
  same: 'border-[var(--accent-ok)] text-[var(--accent-ok)]',
  modified: 'border-[var(--accent-stale)] text-[var(--accent-stale)]',
  missing: 'border-[var(--border)] text-[var(--muted)]',
  unknown: 'border-[var(--border)] text-[var(--muted)]',
};

function clock(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString([], { hour12: false });
}

function StatusPill({ current, title }: { current: ProvenanceCurrent; title?: string }) {
  const { t } = useI18n();
  return (
    <span className={`shrink-0 rounded-full border px-1.5 text-[10.5px] leading-[16px] ${CURRENT_TONE[current]}`} title={title}>
      {t(CURRENT_KEYS[current])}
    </span>
  );
}

function Hash({ file }: { file: ProvenanceFileWire }) {
  const { t } = useI18n();
  if (file.sha256) {
    return (
      <span className="shrink-0 tabular-nums text-[var(--muted)]" title={`SHA-256 ${file.sha256}`}>
        {shortHash(file.sha256)}
      </span>
    );
  }
  return <span className="shrink-0 text-[var(--muted)]">{file.skipped === 'too-large' ? t('provenance.tooLarge') : '—'}</span>;
}

function Detail({ view }: { view: ProvenanceView }) {
  const { t } = useI18n();
  if (!view.producedBy) return <p className="text-[var(--muted)]">{t('provenance.none')}</p>;
  const rec = view.recorded;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[var(--muted)]">{t('provenance.producedBy')}</span>
        <span className="text-[var(--text)]">cell {view.producedBy.cellId}</span>
        <span className="text-[var(--muted)]">· {clock(view.producedBy.ts)}</span>
        {rec && <Hash file={rec} />}
        {rec?.bytes !== null && rec?.bytes !== undefined && <span className="text-[var(--muted)]">{formatBytes(rec.bytes)}</span>}
        {view.current && <StatusPill current={view.current} title={t('provenance.currentTitle')} />}
        {rec?.inPlace && <span className="text-[var(--muted)]">{t('provenance.inPlace')}</span>}
      </div>
      {view.inputs.length === 0 ? (
        <p className="text-[var(--muted)]">{t('provenance.noInputs')}</p>
      ) : (
        <ul className="space-y-0.5">
          {view.inputs.map((f) => (
            <li key={f.path} className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-[var(--muted)]">{t('provenance.input')}</span>
              <span className="min-w-0 truncate text-[var(--text)]" title={f.path}>
                {baseName(f.path)}
              </span>
              <Hash file={f} />
              {f.current && <StatusPill current={f.current} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 「wrote …」一行（ADR-015）：点开向 bridge 查这个文件的来源——产生它的 cell 与时刻、内容指纹、
 * 现在是否被改过，以及当时各输入文件的指纹与是否变化。只在展开时查询（每次展开现场重算）。
 */
export function ProvenanceLine({ path, notebookPath }: { path: string; notebookPath?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ProvenanceView | null>(null);
  const [failed, setFailed] = useState(false);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    setFailed(false);
    bridge
      .rpc<unknown>('provenance.lookup', { path, ...(notebookPath ? { notebookPath } : {}) })
      .then((res) => setView(normalizeProvenance(res, path)))
      .catch(() => setFailed(true));
  };

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        title={t('provenance.toggleTitle')}
        data-testid="provenance-toggle"
        className="group flex max-w-full items-center gap-1.5 rounded px-0.5 text-left hover:text-[var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-run)]"
      >
        <Fingerprint size={12} aria-hidden className="shrink-0 opacity-50 group-hover:opacity-100" />
        <span className="whitespace-pre">wrote {path}</span>
      </button>
      {open && (
        <div className="ml-[18px] mt-1 border-l border-[var(--border)] py-0.5 pl-2.5 text-[11.5px] leading-[1.6]" data-testid="provenance-detail">
          {failed ? (
            <p className="text-[var(--muted)]">{t('provenance.unavailable')}</p>
          ) : view ? (
            <Detail view={view} />
          ) : (
            <p className="text-[var(--muted)]">…</p>
          )}
        </div>
      )}
    </div>
  );
}
