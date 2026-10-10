import { useMemo, useState } from 'react';
import { useLayout, type Activity } from '../../store/layout';
import { useNotebook } from '../../store/notebook';
import { sessionName, useSession } from '../../store/session';
import { useI18n, type I18nKey } from '../../i18n';
import { ExplorerTree } from '../sidebar';
import { makePickSession } from '../SessionBar';
import { filterSchemas, previewOneLine, shapeOrLen, sortSchemas } from '../Inspector/helpers';

/**
 * 侧栏（VS Code Side Bar）：活动栏选中项的详细栏目，宽度由右缘 Splitter 缩放。
 *  - explorer  = 工作区文件树（原 Files 全幅视图收进侧栏）；
 *  - sessions  = 当前 notebook 的会话历史（live / ended·read-only）+ Session notebook 入口；
 *  - variables = 内核变量 schema 列表（本地可信，不经截断；与底部 Inspector 抽屉同源数据）。
 */
const TITLES: Record<Activity, I18nKey> = {
  explorer: 'wb.explorer',
  sessions: 'wb.sessions',
  variables: 'wb.variables',
};

export function SidePanel({ width }: { width: number }) {
  const activity = useLayout((s) => s.activity);
  const { t } = useI18n();
  return (
    <aside
      data-testid="side-panel"
      aria-label={t(TITLES[activity])}
      style={{ width }}
      className="flex shrink-0 flex-col bg-[var(--side)]"
    >
      <div className="flex h-8 shrink-0 items-center px-4 text-[11px] tracking-wider text-[var(--muted)] uppercase">
        {t(TITLES[activity])}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {activity === 'explorer' && <ExplorerTree />}
        {activity === 'sessions' && <SessionsView />}
        {activity === 'variables' && <VariablesView />}
      </div>
    </aside>
  );
}

function fmtStart(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : sessionName(d);
}

function SessionsView() {
  const notebookPath = useNotebook((s) => s.notebookPath);
  const sessions = useSession((s) => s.sessions);
  const currentId = useSession((s) => s.currentId);
  const viewingId = useSession((s) => s.viewingId);
  const openModal = useSession((s) => s.openModal);
  const { t } = useI18n();
  const pick = makePickSession(() => {});

  if (!notebookPath) {
    return <p className="px-4 py-2 text-[11px] leading-relaxed text-[var(--muted)]">{t('wb.sessionsEmpty')}</p>;
  }
  const ordered = [...sessions].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={openModal}
          className="w-full rounded border border-[var(--border)] px-2 py-1 text-left text-[12px] text-[var(--text)] hover:border-[var(--accent-run)]"
        >
          ⧉ {t('wb.openSessionNotebook')}
        </button>
      </div>
      <ul className="nl-scroll-thin min-h-0 flex-1 overflow-y-auto pb-2" data-testid="sessions-list">
        {ordered.map((m) => {
          const live = m.endedAt === undefined;
          const isViewing = m.id === viewingId;
          const isCurrent = m.id === currentId && live;
          return (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => pick(m.id)}
                className={`flex w-full items-center gap-2 px-4 py-1 text-left text-[12px] hover:bg-[var(--panel-2)] ${
                  isViewing || (isCurrent && !viewingId) ? 'text-[var(--text)]' : 'text-[var(--muted)]'
                }`}
              >
                <span aria-hidden style={{ color: live ? 'var(--accent-ok)' : 'var(--muted)' }}>●</span>
                <span className="min-w-0 flex-1 truncate">{fmtStart(m.startedAt)}</span>
                <span className="shrink-0 text-[10px]">{t('kernel.cells', { count: m.cellCount })}</span>
                <span className="shrink-0 rounded bg-[var(--chip-bg)] px-1 text-[10px] text-[var(--chip-text)]">
                  {live ? 'live' : 'read-only'}
                </span>
              </button>
            </li>
          );
        })}
        {ordered.length === 0 && <li className="px-4 py-1 text-[11px] text-[var(--muted)]">{t('session.empty')}</li>}
      </ul>
    </div>
  );
}

function VariablesView() {
  const schemas = useNotebook((s) => s.schemas);
  const notebookPath = useNotebook((s) => s.notebookPath);
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const rows = useMemo(() => sortSchemas(filterSchemas(schemas, query), 'name', 'asc'), [schemas, query]);

  if (!notebookPath) {
    return <p className="px-4 py-2 text-[11px] leading-relaxed text-[var(--muted)]">{t('wb.variablesEmpty')}</p>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pb-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('wb.filterVariables')}
          spellCheck={false}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-[12px] placeholder-[var(--muted)] outline-none focus:border-[var(--accent-run)]"
        />
      </div>
      <ul className="nl-scroll-thin min-h-0 flex-1 overflow-y-auto pb-2" data-testid="variables-list">
        {rows.map((s) => (
          <li key={s.name} className="px-4 py-1 hover:bg-[var(--panel-2)]" title={previewOneLine(s, 400)}>
            <div className="flex items-baseline gap-2 text-[12px]">
              <span className="min-w-0 truncate text-[var(--text)]">{s.name}</span>
              <span className="ml-auto shrink-0 text-[10px] text-[var(--muted)]">{s.type}</span>
            </div>
            <div className="flex gap-2 text-[10px] text-[var(--muted)]">
              <span className="shrink-0">{shapeOrLen(s)}</span>
              <span className="min-w-0 truncate">{previewOneLine(s, 80)}</span>
            </div>
          </li>
        ))}
        {rows.length === 0 && <li className="px-4 py-1 text-[11px] text-[var(--muted)]">{t('wb.noVariables')}</li>}
      </ul>
    </div>
  );
}
