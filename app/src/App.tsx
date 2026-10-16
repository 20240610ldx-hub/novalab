import { useEffect, useRef, useState } from 'react';
import { House } from 'lucide-react';
import { useNotebook } from './store/notebook';
import { appModeFromSearch, searchWithAppMode, useUi } from './store/ui';
import { AGENT_MAX, AGENT_MIN, DEFAULT_LAYOUT, SIDE_MAX, SIDE_MIN, useLayout } from './store/layout';
import { useI18n } from './i18n';
import { CellList } from './components/CellList';
import { KernelStatusBar } from './components/KernelStatusBar';
import { InlineREPL } from './components/InlineREPL';
import { TabBar } from './components/TabBar';
import { useWorkspaceSync } from './components/sidebar';
import { AgentPanel } from './components/AgentPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { Inspector } from './components/Inspector';
import { inspectorHandlePointerDown } from './components/Inspector/dragStore';
import { AppView } from './components/AppView';
import { Welcome } from './components/Welcome';
import { ActivityBar } from './components/Workbench/ActivityBar';
import { SidePanel } from './components/Workbench/SidePanel';
import { Splitter } from './components/Workbench/Splitter';
import { StatusBar } from './components/Workbench/StatusBar';
import { TitleBar } from './components/Workbench/TitleBar';

/**
 * v0.1.1 工作台布局（Owner 裁决：学 VS Code / JupyterLab）：
 *
 *   TitleBar ─────────────────────────────────────────────────────────────
 *   ActivityBar │ SidePanel ║ Editor（tab 条 + Welcome | notebook）║ AgentPanel
 *   StatusBar ────────────────────────────────────────────────────────────
 *
 * - 活动栏切换侧栏视图（Explorer / Sessions / Variables），点当前项开合；Ctrl+B 同；
 * - 侧栏与 Agent 栏右/左缘 Splitter 拖拽缩放（双击复位），宽度与开合持久化（store/layout）；
 * - 编辑区：无 notebook 或用户点 ⌂ → Welcome（JupyterLab 式引导，含常驻环境自检）；
 *   notebook 视图保留 Claude Science 元素（cell 列表、Inspector 抽屉、内核状态栏、REPL）；
 * - App View（P4.2）：隐藏活动栏/侧栏/Agent 栏，编辑区换成只读报告；
 * - 启动：bridge.connect() → ?path= 存在则 notebook.open。
 * 快捷键：Ctrl/Cmd+Enter 运行 active cell（仅 notebook 编辑视图）；Ctrl+B 侧栏；Ctrl+Alt+B Agent 栏。
 */
export function App() {
  const bridgeConnected = useNotebook((s) => s.bridgeConnected);
  const bridgeStatus = useNotebook((s) => s.bridgeStatus);
  const notebookPath = useNotebook((s) => s.notebookPath);
  const appMode = useUi((s) => s.appMode);
  const sideOpen = useLayout((s) => s.sideOpen);
  const sideWidth = useLayout((s) => s.sideWidth);
  const agentOpen = useLayout((s) => s.agentOpen);
  const agentWidth = useLayout((s) => s.agentWidth);
  const editorView = useLayout((s) => s.editorView);
  const { t } = useI18n();
  const [attempted, setAttempted] = useState(false);
  const bootRef = useRef(false);

  // root 镜像 + 最近打开记录
  useWorkspaceSync();

  // 启动序列：连接 bridge，然后按 ?path= 打开 notebook（StrictMode 双挂载防重）
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    void useNotebook
      .getState()
      .connectBridge()
      .then(async () => {
        setAttempted(true);
        const path = new URLSearchParams(window.location.search).get('path');
        if (path && useNotebook.getState().bridgeConnected) {
          await useNotebook.getState().openNotebook(path);
        }
      });
  }, []);

  // 打开 / 切换到某个 notebook（任何入口：Explorer、Welcome、tab、?path=）→ 编辑区显示 notebook
  useEffect(
    () =>
      useNotebook.subscribe((s, prev) => {
        if (s.notebookPath && s.notebookPath !== prev.notebookPath) useLayout.getState().showNotebook();
      }),
    [],
  );

  // P4.2：appMode → URL ?view=app 回写（幂等守卫；replaceState 不触发 popstate）
  useEffect(() => {
    const next = searchWithAppMode(window.location.search, appMode);
    if (next !== window.location.search) {
      window.history.replaceState(null, '', `${window.location.pathname}${next}`);
    }
  }, [appMode]);

  // P4.2：浏览器前进/后退 → 读回 ?view=
  useEffect(() => {
    const onPop = () => {
      const fromUrl = appModeFromSearch(window.location.search);
      if (fromUrl && useUi.getState().appMode !== fromUrl) useUi.getState().setAppMode(fromUrl);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // 全局快捷键（capture：抢在 CM6 keymap 之前）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const layout = useLayout.getState();
      if (e.key === 'Enter') {
        if (useUi.getState().appMode === 'app' || layout.editorView !== 'notebook') return;
        e.preventDefault();
        e.stopPropagation();
        const s = useNotebook.getState();
        if (s.activeCellId) void s.runCell(s.activeCellId);
      } else if (e.key.toLowerCase() === 'b' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (e.altKey) layout.toggleAgent();
        else layout.toggleSide();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const appViewActive = appMode === 'app';
  const showWelcome = !notebookPath || editorView === 'welcome';

  return (
    <div className="flex h-full flex-col">
      <TitleBar />

      <div className="flex min-h-0 flex-1">
        {!appViewActive && <ActivityBar />}
        {!appViewActive && sideOpen && (
          <>
            <SidePanel width={sideWidth} />
            <Splitter
              side="left"
              width={sideWidth}
              min={SIDE_MIN}
              max={SIDE_MAX}
              label={t('wb.resizeSide')}
              onResize={(w) => useLayout.getState().setSideWidth(w)}
              onReset={() => useLayout.getState().setSideWidth(DEFAULT_LAYOUT.sideWidth)}
            />
          </>
        )}

        <main className="flex min-w-0 flex-1 flex-col bg-[var(--bg)]" data-testid="editor">
          {/* 降级横幅：bridge 连接失败（编辑器 UI 仍可浏览，内核功能不可用） */}
          {bridgeStatus === 'reconnecting' && (
            <div role="status" data-testid="bridge-reconnecting" className="border-b border-[var(--accent-err)] bg-[var(--diff-del)] px-3 py-1.5 text-[12px] text-[var(--accent-err)]">
              {t('app.bridgeReconnecting')}
            </div>
          )}
          {bridgeStatus === 'down' && (
            <div role="alert" data-testid="bridge-down" className="flex items-center gap-2 border-b border-[var(--accent-err)] bg-[var(--diff-del)] px-3 py-1.5 text-[12px] text-[var(--accent-err)]">
              <span className="min-w-0 flex-1">{t('app.bridgeGaveUp')}</span>
              <button
                type="button"
                data-testid="bridge-retry"
                onClick={() => void useNotebook.getState().retryBridge()}
                className="shrink-0 rounded border border-[var(--border)] px-2 py-0.5 text-[var(--text)]"
              >{t('app.bridgeRetry')}</button>
            </div>
          )}
          {attempted && !bridgeConnected && bridgeStatus === 'idle' && (
            <div className="border-b border-[var(--accent-err)] bg-[var(--diff-del)] px-3 py-1.5 text-[12px] text-[var(--accent-err)]">
              {t('app.bridgeDown')}
            </div>
          )}

          {appViewActive ? (
            <AppView />
          ) : (
            <>
              {/* 编辑区 tab 条：⌂ Welcome + notebook tabs（P3.1 多 tab，A-4 #6 pill 样式） */}
              <div
                className="flex items-center gap-1 border-b border-[var(--border)] bg-[var(--tab-strip)] px-2 py-1"
                onClickCapture={(e) => {
                  if ((e.target as HTMLElement).closest('[role="tab"]')) useLayout.getState().showNotebook();
                }}
              >
                <button
                  type="button"
                  aria-pressed={showWelcome}
                  title={t('wb.welcome')}
                  data-testid="tab-welcome"
                  onClick={() => useLayout.getState().showWelcome()}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] ${
                    showWelcome
                      ? 'border-[var(--border)] bg-[var(--tab-active)] text-[var(--text)] shadow-sm'
                      : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]'
                  }`}
                >
                  <House size={13} aria-hidden />
                  {t('wb.welcome')}
                </button>
                <TabBar dimActive={showWelcome} />
              </div>

              {showWelcome ? (
                <div className="min-h-0 flex-1">
                  <Welcome />
                </div>
              ) : (
                <>
                  <div className="flex-1 overflow-y-auto">
                    <CellList />
                  </div>
                  {/* P3.2：变量 inspector 抽屉（footer 上方） */}
                  <Inspector />
                  <footer>
                    {/* 元素 6：内核状态栏（⠿ 把手 → Inspector 拖出）；元素 7：内联 REPL */}
                    <KernelStatusBar onHandlePointerDown={inspectorHandlePointerDown} />
                    <InlineREPL />
                  </footer>
                </>
              )}
            </>
          )}
        </main>

        {!appViewActive && agentOpen && (
          <>
            <Splitter
              side="right"
              width={agentWidth}
              min={AGENT_MIN}
              max={AGENT_MAX}
              label={t('wb.resizeAgent')}
              onResize={(w) => useLayout.getState().setAgentWidth(w)}
              onReset={() => useLayout.getState().setAgentWidth(DEFAULT_LAYOUT.agentWidth)}
            />
            <aside
              data-testid="agent-panel"
              style={{ width: agentWidth }}
              className="flex shrink-0 flex-col bg-[var(--side)]"
            >
              <AgentPanel />
            </aside>
          </>
        )}
      </div>

      <StatusBar />
      <SettingsPanel onOpenWelcome={() => useLayout.getState().showWelcome()} />
    </div>
  );
}
