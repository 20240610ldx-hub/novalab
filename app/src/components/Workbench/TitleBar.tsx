import { Monitor, Moon, PanelLeft, PanelRight, SquarePen, Sun, type LucideIcon } from 'lucide-react';
import { useLayout } from '../../store/layout';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { useI18n } from '../../i18n';
import { SessionBar, SessionStatusPill } from '../SessionBar';
import { baseName } from '../sidebar/helpers';

/**
 * 顶部细栏（VS Code title bar / command center 位）：
 *  左 = 品牌 + 工作区名；中 = 会话 pill（Claude Science 的 notebook·会话切换器 + ⧉ Sessions）；
 *  右 = 侧栏 / Agent 栏开合、App View、主题、live/Ended pill。
 */
function ChromeButton({
  icon: Icon,
  label,
  pressed,
  onClick,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  pressed?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      data-testid={testId}
      onClick={onClick}
      className={`flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--panel)] ${
        pressed ? 'text-[var(--text)]' : 'text-[var(--muted)] hover:text-[var(--text)]'
      }`}
    >
      <Icon size={15} strokeWidth={1.7} aria-hidden />
    </button>
  );
}

export function ThemeToggle() {
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const { t } = useI18n();
  const toLight = theme === 'dark';
  return (
    <ChromeButton
      icon={toLight ? Sun : Moon}
      label={toLight ? t('wb.themeLight') : t('wb.themeDark')}
      testId="toggle-theme"
      onClick={() => setTheme(toLight ? 'light' : 'dark')}
    />
  );
}

export function TitleBar() {
  const root = useSession((s) => s.root);
  const sideOpen = useLayout((s) => s.sideOpen);
  const agentOpen = useLayout((s) => s.agentOpen);
  const toggleSide = useLayout((s) => s.toggleSide);
  const toggleAgent = useLayout((s) => s.toggleAgent);
  const appMode = useUi((s) => s.appMode);
  const setAppMode = useUi((s) => s.setAppMode);
  const { t } = useI18n();
  const appView = appMode === 'app';

  return (
    <header
      data-testid="title-bar"
      className="relative flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--chrome)] px-2 text-[12px]"
    >
      <span className="flex min-w-0 shrink-0 items-center gap-1.5 pl-1">
        <span aria-hidden className="text-[13px] text-[var(--accent-run)]">◈</span>
        <span className="text-[var(--text)]">
          Nova<span className="text-[var(--accent-run)]">Lab</span>
        </span>
        <span className="text-[var(--muted)]">·</span>
        <span className="max-w-44 truncate text-[var(--muted)]" title={root ?? t('app.workspaceTooltip')}>
          {root ? baseName(root) || root : t('wb.noWorkspace')}
        </span>
      </span>

      {/* 中：会话 pill（绝对居中，窄窗时让位不重叠） */}
      <div className="pointer-events-none absolute left-1/2 -translate-x-1/2">
        <div className="pointer-events-auto">
          <SessionBar />
        </div>
      </div>

      <span className="ml-auto flex items-center gap-1">
        {!appView && (
          <>
            <ChromeButton icon={PanelLeft} label={t('wb.toggleSide')} pressed={sideOpen} testId="toggle-side" onClick={toggleSide} />
            <ChromeButton icon={PanelRight} label={t('wb.toggleAgent')} pressed={agentOpen} testId="toggle-agent" onClick={toggleAgent} />
          </>
        )}
        <ChromeButton
          icon={appView ? SquarePen : Monitor}
          label={appView ? t('app.toEditMode') : t('app.toAppView')}
          pressed={appView}
          testId="toggle-app-view"
          onClick={() => setAppMode(appView ? 'edit' : 'app')}
        />
        <ThemeToggle />
        <span className="ml-1">
          <SessionStatusPill />
        </span>
      </span>
    </header>
  );
}
