import { useNotebook } from './store/notebook';

/**
 * 三栏骨架：主列（TabBar / CellList / KernelStatusBar / InlineREPL）+ 右 AgentPanel。
 * 复刻清单见 docs/spec.md 附录 A；P1.4 起逐组件替换占位。
 */
export function App() {
  const { cells, kernelState, activeCellId, setActive } = useNotebook();

  return (
    <div className="flex h-full">
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
          <span className="rounded-full bg-[var(--panel)] px-3 py-1">demo.py · python</span>
          <span className="ml-auto flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-[var(--accent-ok)]">
            ● {kernelState}
          </span>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          {cells.length === 0 ? (
            <p className="text-[var(--muted)]">
              尚无 cell —— P1.3 bridge 接通后由 notebook.open 加载 .py。
            </p>
          ) : (
            cells.map((c) => (
              <section
                key={c.id}
                onClick={() => setActive(c.id)}
                className={`mb-4 rounded-md border p-3 ${
                  activeCellId === c.id ? 'border-[var(--accent-run)]' : 'border-[var(--border)]'
                } bg-[var(--panel)]`}
              >
                <div className="mb-2 flex gap-2 text-[var(--muted)]">
                  <span>[{c.execCount ?? ' '}]</span>
                  <span className="rounded bg-[var(--bg)] px-1.5">python</span>
                  {c.status === 'stale' && <span>stale</span>}
                </div>
                <pre className="whitespace-pre-wrap">{c.code}</pre>
              </section>
            ))
          )}
        </div>

        <footer className="border-t border-[var(--border)]">
          <div className="flex items-center justify-between px-3 py-1.5 text-[var(--muted)]">
            <span>Python kernel · shared with the agent</span>
            <span>{kernelState === 'busy' ? 'busy' : 'idle'}</span>
          </div>
          <div className="border-t border-[var(--border)] px-3 py-2 text-[var(--muted)]">
            &gt;&gt;&gt; run code in this kernel…
          </div>
        </footer>
      </main>

      <aside className="w-80 shrink-0 border-l border-[var(--border)] p-3 text-[var(--muted)]">
        <p className="mb-2 text-[var(--text)]">Agent</p>
        <p>
          context chip · 流式对话 · One-click Fix 卡片 —— P2 阶段落地（spec §7/§9）。
        </p>
      </aside>
    </div>
  );
}
