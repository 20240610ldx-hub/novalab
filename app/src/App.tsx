import { useEffect, useRef, useState } from 'react';
import { useNotebook } from './store/notebook';
import { useSession } from './store/session';
import { useUi } from './store/ui';
import { CellList } from './components/CellList';
import { KernelStatusBar } from './components/KernelStatusBar';
import { InlineREPL } from './components/InlineREPL';
import { SessionBar, SessionStatusPill } from './components/SessionBar';
import { TabBar } from './components/TabBar';
import { FilesView, useWorkspaceSync } from './components/sidebar';
import { baseName } from './components/sidebar/helpers';
import { ThemeToggle, ViewSwitcher } from './components/ViewSwitcher';
import { AgentPanel } from './components/AgentPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { Inspector } from './components/Inspector';
import { inspectorHandlePointerDown } from './components/Inspector/dragStore';

/**
 * Q 线 A-3 #23 布局：header = 左工作区标题（fs.root 目录名）+ SessionBar pill ·
 * 中央 `Files | Notebook` 分段视图切换（ViewSwitcher，localStorage 持久化）·
 * 右 SessionStatusPill。
 * - Notebook 视图 = 原主列（TabBar / CellList / Inspector / footer REPL）+ 右 AgentPanel；
 * - Files 视图 = 全幅文件浏览面板（FilesView，替代原左缘 icon rail sidebar——rail 已移除）。
 * 启动：bridge.connect() → 失败显示降级横幅；?path= 存在则 notebook.open。
 * 快捷键：Ctrl/Cmd+Enter 运行 active cell（仅 Notebook 视图）。
 */
export function App() {
  const bridgeConnected = useNotebook((s) => s.bridgeConnected);
  const notebookPath = useNotebook((s) => s.notebookPath);
  const root = useSession((s) => s.root);
  const view = useUi((s) => s.view);
  const [attempted, setAttempted] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const bootRef = useRef(false);

  // root 镜像 + 最近打开记录（原 Sidebar 全局副作用，rail 移除后上移到 App）
  useWorkspaceSync();

  // 启动序列：连接 bridge，然后按 ?path= 打开 notebook（StrictMode 双挂载防重）
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    const store = useNotebook.getState();
    void store.connectBridge().then(async () => {
      setAttempted(true);
      const path = new URLSearchParams(window.location.search).get('path');
      if (path && useNotebook.getState().bridgeConnected) {
        await useNotebook.getState().openNotebook(path);
      }
    });
  }, []);

  // Ctrl/Cmd+Enter → 运行 active cell。capture 阶段拦截并 stopPropagation，
  // 抢在 CM6 defaultKeymap 的 Mod-Enter(insertBlankLine) 之前，焦点在编辑器内也生效。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if (useUi.getState().view !== 'notebook') return; // Files 视图不触发运行
        e.preventDefault();
        e.stopPropagation();
        const s = useNotebook.getState();
        if (s.activeCellId) void s.runCell(s.activeCellId);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const openPath = (p: string) => {
    const path = p.trim();
    if (!path) return;
    // 同步到 URL，刷新后可恢复同一 notebook
    const url = new URL(window.location.href);
    url.searchParams.set('path', path);
    window.history.replaceState(null, '', url.toString());
    void useNotebook.getState().openNotebook(path);
  };

  return (
    <div className="flex h-full">
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="relative flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
          {/* A-3 #23 左端：工作区标题（fs.root 目录名） */}
          <span
            className="min-w-0 max-w-44 shrink-0 truncate text-[12px] text-[var(--text)]"
            title={root ?? '尚无工作区（打开 notebook 后为其所在目录）'}
          >
            {root ? baseName(root) || root : 'workspace'}
          </span>

          {/* P2.8：会话切换器 pill（当前 + 历史，A-2 #13） */}
          <SessionBar />

          {/* 无 ?path= 时的打开入口（Notebook 视图） */}
          {!notebookPath && view === 'notebook' && (
            <span className="flex items-center gap-1">
              <input
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') openPath(pathInput);
                }}
                placeholder="path/to/notebook.py"
                spellCheck={false}
                className="w-56 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-[12px] placeholder-[var(--muted)] outline-none focus:border-[var(--accent-run)]"
              />
              <button
                type="button"
                onClick={() => openPath(pathInput)}
                className="rounded border border-[var(--border)] px-2 py-0.5 text-[12px] hover:border-[var(--accent-run)]"
              >
                Open
              </button>
            </span>
          )}

          {/* A-3 #23 中央：Files | Notebook 分段视图切换（绝对居中） */}
          <div className="pointer-events-none absolute left-1/2 -translate-x-1/2">
            <div className="pointer-events-auto">
              <ViewSwitcher />
            </div>
          </div>

          {/* A-4：header 右组 = 主题切换钮（Session pill 左）+ live/Ended pill（A-2 #12） */}
          <span className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <SessionStatusPill />
          </span>
        </header>

        {/* 降级横幅：bridge 连接失败（编辑器 UI 仍可浏览，内核功能不可用） */}
        {attempted && !bridgeConnected && (
          <div className="border-b border-[var(--accent-err)] bg-[var(--diff-del)] px-3 py-1.5 text-[12px] text-[var(--accent-err)]">
            bridge 未连接 —— kernel / 运行 / 文件功能不可用（ws://127.0.0.1:7788）。
            请确认 bridge 进程已启动后刷新。
          </div>
        )}

        {view === 'files' ? (
          /* A-3 #23：全幅文件浏览面板（树放大版 + 最近打开右栏） */
          <FilesView />
        ) : (
          <>
            {/* P3.1：多 tab 条（A-4 #6：浅色条 --tab-strip 上 active 白 pill） */}
            <div className="flex items-center border-b border-[var(--border)] bg-[var(--tab-strip)] px-2 py-1">
              <TabBar />
            </div>

            <div className="flex-1 overflow-y-auto">
              <CellList />
            </div>

            {/* P3.2：变量 inspector 抽屉（footer 上方；把手拖拽逻辑在 Inspector/dragStore） */}
            <Inspector />

            <footer>
              {/* 元素 6：内核状态栏（⠿ 把手 pointerdown → Inspector 拖出） */}
              <KernelStatusBar onHandlePointerDown={inspectorHandlePointerDown} />
              {/* 元素 7：内联 REPL */}
              <InlineREPL />
            </footer>
          </>
        )}
      </main>

      {/* P2.1/P2.5：Agent 面板（context chip · 流式对话 · One-click Fix）+ 设置入口；
          Files 全幅视图时让位（#23 全幅语义） */}
      {view === 'notebook' && (
        <aside className="flex w-96 shrink-0 flex-col border-l border-[var(--border)]">
          <AgentPanel />
        </aside>
      )}
      <SettingsPanel />
    </div>
  );
}
