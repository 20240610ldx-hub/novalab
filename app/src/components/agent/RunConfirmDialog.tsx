import { useNotebook, type ExecuteConfirmRequest, type ShadowConfirmRequest } from '../../store/notebook';

/* ------------------------------------------------------------------ */
/* Agent 运行确认（两种）：                                             */
/*  - execute_cell：在「你的 kernel」上执行，每次都问（过渡闸）；         */
/*  - shadow_run（ADR-013 O1 = b）：影子环境试运行，每轮首次问一次。      */
/*                                                                     */
/* store.runConfirms 非空时渲染队首。                                   */
/* 只认显式按钮：点罩层不关闭（避免误触 = 误批准/误拒绝）；默认焦点在「拒绝」。 */
/* 任一窗口先答即生效，bridge 广播 agent.confirmResolved 撤掉其余窗口的弹窗。 */
/* ------------------------------------------------------------------ */

export function RunConfirmDialog() {
  const req = useNotebook((s) => s.runConfirms[0]);
  const queued = useNotebook((s) => s.runConfirms.length);
  const answer = useNotebook((s) => s.answerRunConfirm);
  if (!req) return null;

  const isShadow = req.kind === 'shadow_run';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" role="presentation">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={isShadow ? 'Agent 请求影子试运行' : 'Agent 请求执行 cell'}
        data-testid="run-confirm-dialog"
        data-kind={req.kind}
        className="w-[30rem] rounded-md border border-[var(--border)] bg-[var(--panel)] p-3 text-[12px]"
      >
        {isShadow ? <ShadowBody req={req} queued={queued} /> : <ExecuteBody req={req} queued={queued} />}
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
            {isShadow ? (req.rememberForTurn ? '允许本轮影子运行' : '允许这一次') : '允许执行'}
          </button>
        </div>
      </div>
    </div>
  );
}

function QueuedNote({ queued }: { queued: number }) {
  return queued > 1 ? <span className="text-[var(--muted)]">（另有 {queued - 1} 个请求排队）</span> : null;
}

function ExecuteBody({ req, queued }: { req: ExecuteConfirmRequest; queued: number }) {
  return (
    <>
      <p className="mb-2 text-[var(--text)]">
        Agent 请求在你的 kernel 上执行 cell <span className="font-[var(--font-mono)]">{req.cellId}</span>
        {req.cascade && <span className="text-[var(--accent-stale)]">，并级联执行下游 stale cells</span>}
        <QueuedNote queued={queued} />
      </p>
      <pre className="mb-3 max-h-56 overflow-auto rounded border border-[var(--border)] p-2 font-[var(--font-mono)] text-[11px]">
        {req.code}
      </pre>
      <p className="mb-3 text-[var(--muted)]">执行会改变 kernel 里的变量，并可能读写文件或发起网络请求。</p>
    </>
  );
}

function formatGiB(bytes: number): string {
  if (bytes <= 0) return '—';
  const gib = bytes / 1024 ** 3;
  return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GiB`;
}

const ACTION_LABEL: Record<ShadowConfirmRequest['changes'][number]['action'], string> = {
  update: '改写',
  insert_below: '在其后插入',
};

function ShadowBody({ req, queued }: { req: ShadowConfirmRequest; queued: number }) {
  return (
    <>
      <p className="mb-2 text-[var(--text)]">
        Agent 想在影子环境里试运行 {req.changes.length} 处改动，看看结果再提议
        <QueuedNote queued={queued} />
      </p>
      <ul
        data-testid="shadow-confirm-changes"
        className="mb-2 max-h-40 overflow-auto rounded border border-[var(--border)] p-2 font-[var(--font-mono)] text-[11px]"
      >
        {req.changes.map((c, i) => (
          <li key={i} className="truncate">
            <span className="text-[var(--muted)]">
              {c.cellId} · {ACTION_LABEL[c.action]}：
            </span>
            {c.firstLine || '（空）'}
          </li>
        ))}
      </ul>
      <p className="mb-1 text-[var(--text)]" data-testid="shadow-confirm-safety">
        你的 kernel、变量和文件都不会被改动：影子进程是独立副本，按源码重放上游 cell。
      </p>
      <p className="mb-3 text-[var(--muted)]">
        沙箱拦截网络、子进程和临时目录外的写入；内存上限 {formatGiB(req.memLimitBytes)}，单次最长 {Math.round(req.runMs / 1000)} 秒。
        Agent 只会看到类型、形状、列名和聚合统计，看不到行数据。
        {req.rememberForTurn ? ` 允许后本轮不再询问（本轮最多再运行 ${req.runsLeft} 次）。` : ' 这次允许只对这一次运行有效。'}
      </p>
    </>
  );
}
