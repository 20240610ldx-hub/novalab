import { Bot, Cpu, Lock, Plug } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNotebook } from '../../store/notebook';
import { useAgentStore } from '../../store/agent';
import { hasDevEnvModel } from '../../agent/providers';
import { useI18n } from '../../i18n';

/**
 * 底部细栏（VS Code status bar）：只放"一眼要知道"的状态与少数快捷开关。
 *  左 = bridge 连接 · 内核状态；右 = 隐私边界提示 · 当前 LLM provider · cell 数 · 语言。
 * bridge 断开时整条转红（与 VS Code 远程断连同语义），点击无副作用，仅提示。
 */
function Item({
  children,
  title,
  onClick,
  testId,
}: {
  children: ReactNode;
  title: string;
  onClick?: () => void;
  testId?: string;
}) {
  const cls = 'flex h-full items-center gap-1 px-2 whitespace-nowrap';
  return onClick ? (
    <button type="button" title={title} onClick={onClick} data-testid={testId} className={`${cls} hover:bg-[var(--panel)]`}>
      {children}
    </button>
  ) : (
    <span title={title} data-testid={testId} className={cls}>
      {children}
    </span>
  );
}

const KERNEL_COLOR: Record<string, string> = {
  live: 'var(--accent-ok)',
  restarting: 'var(--accent-run)',
  busy: 'var(--accent-run)',
  dead: 'var(--accent-err)',
  connecting: 'var(--muted)',
};

export function StatusBar() {
  const connected = useNotebook((s) => s.bridgeConnected);
  const kernelState = useNotebook((s) => s.kernelState);
  const notebookPath = useNotebook((s) => s.notebookPath);
  const cellCount = useNotebook((s) => s.cells.length);
  const providers = useAgentStore((s) => s.providers);
  const activeProviderId = useAgentStore((s) => s.activeProviderId);
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);
  const { t, lang, setLang } = useI18n();

  const active = providers.find((p) => p.id === activeProviderId);
  const providerLabel = active
    ? `${active.name} · ${active.model}`
    : hasDevEnvModel()
      ? t('wb.providerDev')
      : t('wb.providerNone');

  return (
    <footer
      data-testid="status-bar"
      className={`flex h-6 shrink-0 items-stretch justify-between border-t text-[11px] ${
        connected
          ? 'border-[var(--border)] bg-[var(--chrome)] text-[var(--muted)]'
          : 'border-[var(--accent-err)] bg-[var(--accent-err)] text-white'
      }`}
    >
      <span className="flex items-stretch">
        <Item title={connected ? t('wb.bridgeOnTitle') : t('wb.bridgeOffTitle')} testId="status-bridge">
          <Plug size={12} aria-hidden />
          {connected ? t('wb.bridgeOn') : t('wb.bridgeOff')}
        </Item>
        {connected && notebookPath && (
          <Item title={t('wb.kernelTitle')} testId="status-kernel">
            <Cpu size={12} aria-hidden style={{ color: KERNEL_COLOR[kernelState] }} />
            Python · {kernelState}
          </Item>
        )}
      </span>
      <span className="flex items-stretch">
        <Item title={t('wb.outputsWithheldTitle')} testId="status-privacy">
          <Lock size={12} aria-hidden />
          {t('chip.outputsWithheld')}
        </Item>
        <Item title={t('wb.providerTitle')} onClick={() => setSettingsOpen(true)} testId="status-provider">
          <Bot size={12} aria-hidden />
          <span className="max-w-48 truncate">{providerLabel}</span>
        </Item>
        {notebookPath && <Item title={t('wb.cellsTitle')}>{t('kernel.cells', { count: cellCount })}</Item>}
        <Item title={t('settings.language')} onClick={() => setLang(lang === 'en' ? 'zh' : 'en')} testId="status-lang">
          {lang === 'en' ? 'EN' : '中文'}
        </Item>
      </span>
    </footer>
  );
}
