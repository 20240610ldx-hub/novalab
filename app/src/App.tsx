import { useEffect, useRef, useState } from 'react';
import { useNotebook } from './store/notebook';
import { CellList } from './components/CellList';
import { KernelStatusBar } from './components/KernelStatusBar';
import { InlineREPL } from './components/InlineREPL';
import { LivePill } from './components/LivePill';

/**
 * 主列（header / CellList / KernelStatusBar / InlineREPL）+ 右 AgentPanel 占位。
 * 复刻清单见 docs/spec.md 附录 A（元素 2-7 于 P1.4/P1.6 落地）。
 * 启动：bridge.connect() → 失败显示降级横幅；?path= 存在则 notebook.open。
 * 快捷键：Ctrl/Cmd+Enter 运行 active cell。
 */
export function App() {
  const kernelState = useNotebook((s) => s.kernelState);
  const bridgeConnected = useNotebook((s) => s.bridgeConnected);
  const notebookPath = useNotebook((s) => s.notebookPath);
  const [attempted, setAttempted] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const bootRef = useRef(false);

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

  const fileName = notebookPath ? notebookPath.split(/[\\/]/).pop() : null;

  return (
    <div className="flex h-full">
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
          <span className="rounded-full bg-[var(--panel)] px-3 py-1">
            {fileName ? `${fileName} · python` : 'NovaLab'}
          </span>

          {/* 无 ?path= 时的打开入口 */}
          {!notebookPath && (
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

          {/* 元素 2：右上 live pill */}
          <span className="ml-auto">
            <LivePill />
          </span>
        </header>

        {/* 降级横幅：bridge 连接失败（编辑器 UI 仍可浏览，内核功能不可用） */}
        {attempted && !bridgeConnected && (
          <div className="border-b border-[var(--accent-err)] bg-[var(--diff-del)] px-3 py-1.5 text-[12px] text-[var(--accent-err)]">
            bridge 未连接 —— kernel / 运行 / 文件功能不可用（ws://127.0.0.1:7788）。
            请确认 bridge 进程已启动后刷新。
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          <CellList />
        </div>

        <footer>
          {/* 元素 6：内核状态栏 */}
          <KernelStatusBar />
          {/* 元素 7：内联 REPL */}
          <InlineREPL />
        </footer>
      </main>

      <aside className="w-80 shrink-0 border-l border-[var(--border)] p-3 text-[var(--muted)]">
        <p className="mb-2 text-[var(--text)]">Agent</p>
        <p>
          context chip · 流式对话 · One-click Fix 卡片 —— P2 阶段落地（spec §7/§9）。
          {kernelState === 'dead' && ' （kernel dead：点右上 pill 重启）'}
        </p>
      </aside>
    </div>
  );
}
