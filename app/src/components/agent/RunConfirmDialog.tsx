import { useNotebook } from '../../store/notebook';

/* ------------------------------------------------------------------ */
/* Agent execute_cell 逐次确认（ADR-013 影子执行落地前的过渡闸）         */
/*                                                                     */
/* store.runConfirms 非空时渲染队首：展示将在「你的 kernel」上执行的源码。 */
/* 只认显式按钮：点罩层不关闭（避免误触 = 误批准/误拒绝）；默认焦点在「拒绝」。 */
/* 任一窗口先答即生效，bridge 广播 agent.confirmResolved 撤掉其余窗口的弹窗。 */
/* ------------------------------------------------------------------ */

export function RunConfirmDialog() {
  const req = useNotebook((s) => s.runConfirms[0]);
  const queued = useNotebook((s) => s.runConfirms.length);
  const answer = useNotebook((s) => s.answerRunConfirm);
  if (!req) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" role="presentation">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Agent 请求执行 cell"
        data-testid="run-confirm-dialog"
        className="w-[30rem] rounded-md border border-[var(--border)] bg-[var(--panel)] p-3 text-[12px]"
      >
        <p className="mb-2 text-[var(--text)]">
          Agent 请求在你的 kernel 上执行 cell <span className="font-[var(--font-mono)]">{req.cellId}</span>
          {req.cascade && <span className="text-[var(--accent-stale)]">，并级联执行下游 stale cells</span>}
          {queued > 1 && <span className="text-[var(--muted)]">（另有 {queued - 1} 个请求排队）</span>}
        </p>
        <pre className="mb-3 max-h-56 overflow-auto rounded border border-[var(--border)] p-2 font-[var(--font-mono)] text-[11px]">
          {req.code}
        </pre>
        <p className="mb-3 text-[var(--muted)]">执行会改变 kernel 里的变量，并可能读写文件或发起网络请求。</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            data-testid="run-confirm-deny"
            onClick={() => void answer(req.requestId, false)}
            className="rounded border border-[var(--border)] px-2 py-0.5 text-[var(--muted)] hover:border-[var(--text)]"
          >
            拒绝
          </button>
          <button
            type="button"
            data-testid="run-confirm-allow"
            onClick={() => void answer(req.requestId, true)}
            className="rounded border border-[var(--accent-run)] px-2 py-0.5 text-[var(--accent-run)] hover:bg-[var(--panel)]"
          >
            允许执行
          </button>
        </div>
      </div>
    </div>
  );
}
