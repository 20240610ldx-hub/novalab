import { useNotebook } from '../../store/notebook';

/* ------------------------------------------------------------------ */
/* P2.4 级联 'ask' 档确认小窗                                            */
/*                                                                     */
/* store.cascadeAsk 非空时渲染：列出将被级联重跑的下游 cells             */
/* （文档序=拓扑序）+ 侧效应徽章（cell.sideEffect，内核启发式检测）。      */
/* 「cascade run」→ resolve(true) 前端逐格 cell.run；                   */
/* 「mark only」/点罩层关闭 → resolve(false) 只保留 stale 标灰           */
/* （Owner 裁决默认语义）。挂载点同 DiffTray（KernelStatusBar，fixed）。   */
/* ------------------------------------------------------------------ */

export function CascadeAskDialog() {
  const ask = useNotebook((s) => s.cascadeAsk);
  const resolveCascadeAsk = useNotebook((s) => s.resolveCascadeAsk);
  if (!ask) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={() => resolveCascadeAsk(false)}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="cascade 确认"
        className="w-[26rem] rounded-md border border-[var(--border)] bg-[var(--panel)] p-3 text-[12px]"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-2 text-[var(--text)]">
          {ask.triggeredBy === 'user-run'
            ? `运行 cell ${ask.sourceCellId} 后，级联重跑下游？`
            : `采纳后 cell ${ask.sourceCellId} 已重跑，级联重跑 stale 下游？`}{' '}
          <span className="text-[var(--muted)]">（{ask.downstream.length} cells，拓扑序）</span>
        </p>

        <ul className="mb-3 max-h-48 overflow-y-auto rounded border border-[var(--border)]">
          {ask.downstream.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-2 border-b border-[var(--border)] px-2 py-1 last:border-b-0"
            >
              <span className="shrink-0 text-[var(--muted)]">{c.id}</span>
              <code className="min-w-0 flex-1 truncate font-[var(--font-mono)] text-[11px]">
                {c.code.split('\n')[0]}
              </code>
              {/* 侧效应徽章：调 API/写文件/跑模型的 cell，级联代价高（spec §5） */}
              {c.sideEffect && (
                <span
                  className="shrink-0 rounded bg-[var(--diff-del)] px-1 py-0.5 text-[10px] text-[var(--accent-err)]"
                  title="内核启发式检测到副作用（写文件/外发请求）"
                >
                  ⚡ side-effect
                </span>
              )}
            </li>
          ))}
        </ul>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => resolveCascadeAsk(false)}
            className="rounded border border-[var(--border)] px-2 py-0.5 text-[var(--muted)] hover:border-[var(--text)]"
            title="只标灰 stale，不自动重跑（Owner 裁决默认）"
          >
            mark only
          </button>
          <button
            type="button"
            onClick={() => resolveCascadeAsk(true)}
            className="rounded border border-[var(--accent-run)] px-2 py-0.5 text-[var(--accent-run)] hover:bg-[var(--panel)]"
            title="按拓扑序逐格 cell.run"
          >
            cascade run
          </button>
        </div>
      </div>
    </div>
  );
}
