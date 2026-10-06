import { useAgentStore } from '../../store/agent';
import { useNotebook } from '../../store/notebook';
import { buildFixPayload, filterSchemasForCell, summarizeTraceback } from '../../agent/payload';

/**
 * One-click Fix 卡片（spec §10 <FixCard traceback+schema+Apply/>，M5 演示脚本一环）。
 * 数据源：agent store 的 lastError（由 watchNotebookErrors 对 notebook store 的
 * run.error 只读订阅转存，不改 H 线代码）。
 * 修复按钮：组装截断后的 payload（代码+traceback 摘要+refs∪defs schema）→ 记入
 * 审计（ContextChip）→ 以预置 user 消息触发一轮对话；模型应调 propose_code_change →
 * bridge diff.stage → H 线的行内 Diff（本卡片不实现 diff UI）。
 */
export function FixCard({ onFix }: { onFix: (payloadText: string) => void }) {
  const lastError = useAgentStore((s) => s.lastError);
  const setLastError = useAgentStore((s) => s.setLastError);
  const setLastPayload = useAgentStore((s) => s.setLastPayload);
  const cell = useNotebook((s) => s.cells.find((c) => c.id === lastError?.cellId));
  const schemas = useNotebook((s) => s.schemas);

  if (!lastError) return null;

  const related = filterSchemasForCell(schemas, cell);
  const summary = summarizeTraceback({ text: lastError.tracebackText, frames: lastError.frames });
  // 卡片内只显示尾部 3 行（完整摘要进 payload）
  const tailLines = summary.split('\n').filter(Boolean).slice(-3);

  const fix = () => {
    const payload = buildFixPayload({
      cellId: lastError.cellId,
      cellCode: cell?.code ?? '',
      traceback: { text: lastError.tracebackText, frames: lastError.frames },
      schemas: related,
    });
    setLastPayload(payload); // ContextChip 审计
    onFix(payload.text);
  };

  return (
    <div className="mx-2 mt-2 rounded-md border border-[var(--accent-err)] bg-[var(--diff-del)] p-2 text-[11px]">
      <div className="flex items-center gap-2">
        <span className="font-bold text-[var(--accent-err)]">run.error</span>
        <span className="text-[var(--muted)]">cell {lastError.cellId}</span>
        <button
          type="button"
          onClick={() => setLastError(null)}
          title="忽略（不修复）"
          className="ml-auto text-[var(--muted)] hover:text-[var(--text)]"
        >
          ✕
        </button>
      </div>

      <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all text-[var(--text)]">
        {tailLines.join('\n')}
      </pre>

      {related.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {related.map((s) => (
            <span
              key={s.name}
              title={s.columns?.map((c) => `${c.name}:${c.dtype}`).join(', ') ?? s.type}
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-1 py-0.5 text-[var(--muted)]"
            >
              {s.name}: {s.type}
            </span>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={fix}
        className="mt-2 w-full rounded border border-[var(--accent-run)] px-2 py-1 text-[12px] text-[var(--accent-run)] hover:bg-[var(--accent-run)] hover:text-[var(--bg)]"
      >
        修复（traceback + {related.length} schemas → Agent）
      </button>
    </div>
  );
}
