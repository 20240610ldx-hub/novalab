import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  FilePlus,
  FileText,
  FolderOpen,
  LoaderCircle,
  Plug,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react';
import { bridge } from '../../bridge/client';
import { useNotebook } from '../../store/notebook';
import { useSession } from '../../store/session';
import { useLayout } from '../../store/layout';
import { useI18n, type I18nKey } from '../../i18n';
import { CopyButton } from '../CellEditor';
import { useOpenNotebookAbs } from '../sidebar';
import { ensurePySuffix, joinFsPath, loadRecent, notebookTemplate, validName, type FsEntry } from '../sidebar/helpers';
import { CHECK_ORDER, fixCommand, type CheckId, type CheckStatus } from './envChecks';
import { mcpAddCommand, nextUntitledName, recentItems, relativeTime, splitPath } from './logic';
import { useEnvChecks } from './useEnvChecks';

/**
 * Welcome 页（v0.1.1，Owner：引导页做成 JupyterLab Welcome 的样式）。
 * 编辑区无 notebook 时显示，或活动栏 ⌂ 随时召回：
 *  左栏 = Start（新建 / 打开文件 / 打开文件夹 / 新会话 / 连接外部 Agent）+ Recent；
 *  右栏 = Environment（常驻自检，取代首启模态）+ Keyboard（常用快捷键）。
 * 浏览器 dev 无原生文件对话框 → 行内路径输入（Tauri 原生对话框留作后续）。
 */

type Pending = 'new' | 'file' | 'folder' | 'connect' | null;

const CHECK_LABEL: Record<CheckId, I18nKey> = {
  bridge: 'onboarding.check.bridge',
  kernel: 'onboarding.check.kernel',
  deps: 'onboarding.check.deps',
  writable: 'onboarding.check.writable',
};

const SHORTCUTS: { keys: string; label: I18nKey }[] = [
  { keys: 'Ctrl+Enter', label: 'welcome.kRun' },
  { keys: 'Tab / Esc', label: 'welcome.kDiff' },
  { keys: 'Ctrl+Tab', label: 'welcome.kTabs' },
  { keys: 'Ctrl+B', label: 'welcome.kSide' },
  { keys: 'Ctrl+Alt+B', label: 'welcome.kAgent' },
];

function StatusIcon({ status }: { status: CheckStatus }) {
  switch (status) {
    case 'ok':
      return <CircleCheck size={15} className="shrink-0 text-[var(--accent-ok)]" aria-label="ok" />;
    case 'fail':
      return <CircleX size={15} className="shrink-0 text-[var(--accent-err)]" aria-label="failed" />;
    case 'skip':
      return <CircleDashed size={15} className="shrink-0 text-[var(--muted)]" aria-label="skipped" />;
    default:
      return <LoaderCircle size={15} className="shrink-0 animate-spin text-[var(--muted)]" aria-label="checking" />;
  }
}

function Heading({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-[15px] font-semibold text-[var(--text)]">{children}</h2>;
}

function StartItem({
  icon: Icon,
  label,
  hint,
  disabled,
  onClick,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      data-testid={testId}
      className="group flex items-center gap-3 py-1.5 text-left text-[14px] text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-45"
    >
      <Icon size={20} strokeWidth={1.5} className="shrink-0 text-[var(--accent-run)]" aria-hidden />
      <span className="group-enabled:group-hover:underline group-enabled:group-hover:underline-offset-4">{label}</span>
    </button>
  );
}

function InlineInput({
  initial,
  placeholder,
  submitLabel,
  error,
  onSubmit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  submitLabel: string;
  error: string | null;
  onSubmit: (v: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  useEffect(() => setV(initial), [initial]);
  return (
    <div className="mb-2 ml-8">
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit(v);
            if (e.key === 'Escape') onCancel();
          }}
          placeholder={placeholder}
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[12px] placeholder-[var(--muted)] outline-none focus:border-[var(--accent-run)]"
        />
        <button
          type="button"
          onClick={() => onSubmit(v)}
          className="rounded border border-[var(--border)] px-2 py-1 text-[12px] hover:border-[var(--accent-run)]"
        >
          {submitLabel}
        </button>
      </div>
      {error && <p className="mt-1 text-[11px] text-[var(--accent-err)]">{error}</p>}
    </div>
  );
}

export function Welcome() {
  const { t, lang } = useI18n();
  const root = useSession((s) => s.root);
  const setRootDir = useSession((s) => s.setRootDir);
  const notebookPath = useNotebook((s) => s.notebookPath);
  const connected = useNotebook((s) => s.bridgeConnected);
  const restartKernel = useNotebook((s) => s.restartKernel);
  const selectActivity = useLayout((s) => s.selectActivity);
  const showNotebook = useLayout((s) => s.showNotebook);
  const openNotebookAbs = useOpenNotebookAbs();
  const { checks, rerun } = useEnvChecks();

  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [untitled, setUntitled] = useState('untitled.py');
  const [mcpLaunch, setMcpLaunch] = useState<string[] | null>(null);

  const recents = useMemo(() => {
    try {
      return recentItems(loadRecent(localStorage));
    } catch {
      return [];
    }
  }, []);

  const open = (p: Pending) => {
    setError(null);
    setPending((cur) => (cur === p ? null : p));
  };

  // 新建：拉 root 列表算不冲突的默认名
  useEffect(() => {
    if (pending !== 'new' || !root) return;
    void bridge
      .rpc<FsEntry[]>('fs.list', { dir: '' })
      .then((list) => setUntitled(nextUntitledName((Array.isArray(list) ? list : []).map((e) => e.name))))
      .catch(() => setUntitled('untitled.py'));
  }, [pending, root]);

  // 连接外部 Agent：bridge 回报自己的 MCP 启动命令（dev = pnpm tsx；安装版 = sidecar node）
  useEffect(() => {
    if (pending !== 'connect' || !connected) return;
    void bridge
      .rpc<{ mcpLaunch?: string[] | null }>('bridge.mcpLaunch')
      .then((r) => setMcpLaunch(Array.isArray(r?.mcpLaunch) ? r.mcpLaunch : null))
      .catch(() => setMcpLaunch(null));
  }, [pending, connected]);

  const createNotebook = async (raw: string) => {
    const name = ensurePySuffix(raw.trim());
    if (!root) return setError(t('welcome.needsWorkspace'));
    if (!name || !validName(name)) return setError(t('welcome.badName', { name: raw }));
    try {
      await bridge.rpc('fs.writeFile', { path: name, content: notebookTemplate() });
      setPending(null);
      openNotebookAbs(joinFsPath(root, name));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const openFile = (raw: string) => {
    const p = raw.trim();
    if (!p) return;
    setPending(null);
    openNotebookAbs(p);
  };

  const openFolder = async (raw: string) => {
    const p = raw.trim();
    if (!p) return;
    await setRootDir(p);
    if (useSession.getState().root) {
      setPending(null);
      selectActivity('explorer');
      if (!useLayout.getState().sideOpen) useLayout.getState().toggleSide();
    } else {
      setError(t('welcome.folderFailed', { path: p }));
    }
  };

  const mcpCmd = mcpLaunch ? mcpAddCommand(mcpLaunch, notebookPath) : null;
  const now = Date.now();

  return (
    <div className="nl-scroll-thin h-full overflow-y-auto" data-testid="welcome">
      <div className="mx-auto max-w-5xl px-10 pt-14 pb-16">
        <h1 className="select-none text-[72px] leading-none font-light tracking-tight lowercase" aria-label="NovaLab">
          <span className="text-[var(--muted)]">nova</span>
          <span className="text-[var(--accent-run)]">lab</span>
        </h1>
        <p className="mt-3 text-[13px] text-[var(--muted)]">{t('welcome.tagline')}</p>

        <div className="mt-12 grid grid-cols-1 gap-x-16 gap-y-10 md:grid-cols-2">
          {/* ---- Start ---- */}
          <section>
            <Heading>{t('welcome.start')}</Heading>
            <div className="flex flex-col">
              <StartItem
                icon={FilePlus}
                label={t('welcome.newNotebook')}
                hint={root ? undefined : t('welcome.needsWorkspace')}
                disabled={!connected}
                testId="welcome-new"
                onClick={() => open('new')}
              />
              {pending === 'new' &&
                (root ? (
                  <InlineInput
                    initial={untitled}
                    placeholder="untitled.py"
                    submitLabel={t('welcome.create')}
                    error={error}
                    onSubmit={(v) => void createNotebook(v)}
                    onCancel={() => setPending(null)}
                  />
                ) : (
                  <p className="mb-2 ml-8 text-[12px] text-[var(--muted)]">{t('welcome.needsWorkspace')}</p>
                ))}
              <StartItem
                icon={FileText}
                label={t('welcome.openFile')}
                disabled={!connected}
                testId="welcome-open-file"
                onClick={() => open('file')}
              />
              {pending === 'file' && (
                <InlineInput
                  initial={root ? joinFsPath(root, '') : ''}
                  placeholder={t('app.pathPlaceholder')}
                  submitLabel={t('app.open')}
                  error={error}
                  onSubmit={openFile}
                  onCancel={() => setPending(null)}
                />
              )}
              <StartItem
                icon={FolderOpen}
                label={t('welcome.openFolder')}
                disabled={!connected}
                testId="welcome-open-folder"
                onClick={() => open('folder')}
              />
              {pending === 'folder' && (
                <InlineInput
                  initial={root ?? ''}
                  placeholder={t('welcome.folderPlaceholder')}
                  submitLabel={t('app.open')}
                  error={error}
                  onSubmit={(v) => void openFolder(v)}
                  onCancel={() => setPending(null)}
                />
              )}
              <StartItem
                icon={RotateCcw}
                label={t('welcome.newSession')}
                hint={notebookPath ? t('welcome.newSessionHint') : t('welcome.needsNotebook')}
                disabled={!notebookPath}
                testId="welcome-new-session"
                onClick={() => {
                  void restartKernel();
                  showNotebook();
                }}
              />
              <StartItem
                icon={Plug}
                label={t('welcome.connect')}
                testId="welcome-connect"
                onClick={() => open('connect')}
              />
              {pending === 'connect' && (
                <div className="mb-2 ml-8 text-[12px] text-[var(--muted)]">
                  <p className="mb-1.5 leading-relaxed">{t('welcome.connectHint')}</p>
                  {mcpCmd ? (
                    <div className="relative rounded border border-[var(--border)] bg-[var(--panel-2)] p-2 pr-9">
                      <code className="block break-all text-[11px] text-[var(--text)]">{mcpCmd}</code>
                      <span className="absolute right-1.5 top-1.5">
                        <CopyButton getText={() => mcpCmd} label={t('welcome.copy')} />
                      </span>
                    </div>
                  ) : (
                    <p>{t('welcome.connectUnavailable')}</p>
                  )}
                </div>
              )}
            </div>

            <div className="mt-10">
              <Heading>{t('welcome.recent')}</Heading>
              {recents.length === 0 ? (
                <p className="text-[12px] text-[var(--muted)]">{t('welcome.noRecent')}</p>
              ) : (
                <ul className="flex flex-col gap-1" data-testid="welcome-recent">
                  {recents.map((r) => {
                    const { name, dir } = splitPath(r.path);
                    return (
                      <li key={r.path}>
                        <button
                          type="button"
                          disabled={!connected}
                          onClick={() => openNotebookAbs(r.path)}
                          title={r.path}
                          className="group flex w-full items-baseline gap-3 text-left text-[13px] disabled:opacity-45"
                        >
                          <span className="shrink-0 text-[var(--text)] group-enabled:group-hover:underline group-enabled:group-hover:underline-offset-4">
                            {name}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--muted)]">{dir}</span>
                          <span className="shrink-0 text-[11px] text-[var(--muted)]">
                            {relativeTime(r.openedAt, now, lang)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          {/* ---- Environment + Keyboard ---- */}
          <section>
            <div className="flex items-baseline justify-between">
              <Heading>{t('welcome.environment')}</Heading>
              <button
                type="button"
                onClick={rerun}
                className="text-[12px] text-[var(--muted)] hover:text-[var(--text)] hover:underline"
              >
                {t('welcome.recheck')}
              </button>
            </div>
            <ul className="flex flex-col gap-2" data-testid="welcome-env">
              {CHECK_ORDER.map((id) => {
                const c = checks[id];
                const fix = c.status === 'fail' ? fixCommand(id, c.status) : null;
                return (
                  <li key={id} className="text-[13px]" data-check={id} data-status={c.status}>
                    <div className="flex items-center gap-2">
                      <StatusIcon status={c.status} />
                      <span className="text-[var(--text)]">{t(CHECK_LABEL[id])}</span>
                    </div>
                    {c.error && (
                      <p
                        className={`ml-6 mt-0.5 break-words text-[11px] ${
                          c.status === 'fail' ? 'text-[var(--accent-err)]' : 'text-[var(--muted)]'
                        }`}
                      >
                        {c.error}
                      </p>
                    )}
                    {fix && (
                      <p className="ml-6 mt-0.5 text-[11px] text-[var(--muted)]">
                        {t('onboarding.fixLabel')} <code className="rounded bg-[var(--chip-bg)] px-1 text-[var(--text)]">{fix}</code>
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>

            <div className="mt-10">
              <Heading>{t('welcome.keyboard')}</Heading>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
                {SHORTCUTS.map((s) => (
                  <div key={s.keys} className="contents">
                    <dt>
                      <kbd className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 text-[11px] text-[var(--text)]">
                        {s.keys}
                      </kbd>
                    </dt>
                    <dd className="text-[var(--muted)]">{t(s.label)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
