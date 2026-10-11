import { Braces, Files, History, House, Settings, type LucideIcon } from 'lucide-react';
import { useLayout, type Activity } from '../../store/layout';
import { useAgentStore } from '../../store/agent';
import { useI18n, type I18nKey } from '../../i18n';

/**
 * 活动栏（VS Code Activity Bar / JupyterLab 左侧 tab 条）：细竖栏图标。
 * 上组 = 侧栏视图（点其他项切换并展开，点当前项开合）；下组 = Welcome 与设置。
 */
const ITEMS: { id: Activity; icon: LucideIcon; label: I18nKey }[] = [
  { id: 'explorer', icon: Files, label: 'wb.explorer' },
  { id: 'sessions', icon: History, label: 'wb.sessions' },
  { id: 'variables', icon: Braces, label: 'wb.variables' },
];

function IconButton({
  icon: Icon,
  label,
  active = false,
  onClick,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      onClick={onClick}
      className={`relative flex h-11 w-full items-center justify-center transition-colors ${
        active ? 'text-[var(--text)]' : 'text-[var(--muted)] hover:text-[var(--text)]'
      }`}
    >
      {active && <span aria-hidden className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r bg-[var(--accent-run)]" />}
      <Icon size={20} strokeWidth={1.6} aria-hidden />
    </button>
  );
}

export function ActivityBar() {
  const activity = useLayout((s) => s.activity);
  const sideOpen = useLayout((s) => s.sideOpen);
  const editorView = useLayout((s) => s.editorView);
  const selectActivity = useLayout((s) => s.selectActivity);
  const showWelcome = useLayout((s) => s.showWelcome);
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);
  const { t } = useI18n();

  return (
    <nav
      aria-label={t('wb.activityBar')}
      className="flex w-12 shrink-0 flex-col items-stretch border-r border-[var(--border)] bg-[var(--chrome)]"
    >
      {ITEMS.map((it) => (
        <IconButton
          key={it.id}
          icon={it.icon}
          label={t(it.label)}
          active={sideOpen && activity === it.id}
          testId={`activity-${it.id}`}
          onClick={() => selectActivity(it.id)}
        />
      ))}
      <div className="flex-1" />
      <IconButton
        icon={House}
        label={t('wb.welcome')}
        active={editorView === 'welcome'}
        testId="activity-welcome"
        onClick={showWelcome}
      />
      <IconButton icon={Settings} label={t('wb.settings')} testId="activity-settings" onClick={() => setSettingsOpen(true)} />
    </nav>
  );
}
