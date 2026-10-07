/**
 * ViewSwitcher（Q 线，spec 附录 A-3 #23）：header 中央分段控件 `Files | Notebook`。
 * 圆角分段、active 深底；状态存 store/ui（localStorage novalab.view 持久化）。
 * 注意：不用 role="tab"——TabBar 的内核 tab 已占用该 role（画廊 waitTabs 计数）。
 *
 * ThemeToggle（A-4）：header 右组 sun/moon 图标钮 → html[data-theme] +
 * localStorage novalab.theme（默认 dark）。
 */

import { Moon, Sun } from 'lucide-react';
import { useUi, type AppView } from '../../store/ui';

const ITEMS: { view: AppView; label: string }[] = [
  { view: 'files', label: 'Files' },
  { view: 'notebook', label: 'Notebook' },
];

export function ViewSwitcher() {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  return (
    <div
      role="group"
      aria-label="视图切换"
      className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-0.5"
    >
      {ITEMS.map((it) => {
        const active = view === it.view;
        return (
          <button
            key={it.view}
            type="button"
            aria-pressed={active}
            title={`${it.label} 视图`}
            onClick={() => setView(it.view)}
            className={`rounded-md px-3 py-0.5 text-[12px] transition-colors ${
              active
                ? 'bg-[var(--bg)] font-medium text-[var(--text)]'
                : 'text-[var(--muted)] hover:text-[var(--text)]'
            }`}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

export function ThemeToggle() {
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const toLight = theme === 'dark';
  return (
    <button
      type="button"
      title={toLight ? '切换浅色主题' : '切换深色主题'}
      aria-label="toggle theme"
      onClick={() => setTheme(toLight ? 'light' : 'dark')}
      className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:text-[var(--text)]"
    >
      {toLight ? <Sun size={14} aria-hidden /> : <Moon size={14} aria-hidden />}
    </button>
  );
}
