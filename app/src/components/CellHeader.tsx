import { lastCellFrameLine, type Cell } from '../kernel/types';
import { useSession } from '../store/session';

interface CellHeaderProps {
  cell: Cell;
  onRun: (cellId: string) => void;
  /** cell.save 返回的编译错（spec §12：保存即报，不进运行队列）。 */
  compileError?: string;
}

/**
 * cell 头（截图元素 3 + 增量徽章）：
 * [execCount] 执行计数徽章（repl 匿名 cell 显示 [repl]）· python 语言 chip ·
 * error (line N) 红徽章（P2.9，N = traceback 最后一个用户帧行号）·
 * stale 灰徽章 · side-effect amber 徽章（默认不级联）· hover 浮现运行按钮 ▶。
 */
export function CellHeader({ cell, onRun, compileError }: CellHeaderProps) {
  const running = cell.status === 'running';
  // P2.8：历史会话只读 → 运行钮禁用（禁用矩阵见 store/session.capabilityMatrix）
  const readOnly = useSession((s) => s.readOnly);
  // P2.9：出错行号取自最近一次 traceback 的最后一个 <cell …> 帧；无用户帧退化为 "error"
  const errorLine =
    cell.status === 'error' ? lastCellFrameLine(cell.output?.traceback?.frames) : null;
  return (
    <>
    <div className="group flex items-center gap-2 px-3 pt-2 text-[var(--muted)] select-none">
      {/* 执行计数徽章 */}
      <span
        className={
          cell.kind === 'repl'
            ? 'rounded bg-[var(--bg)] px-1.5 py-0.5 text-[var(--accent-run)]'
            : 'rounded bg-[var(--bg)] px-1.5 py-0.5'
        }
        title={cell.kind === 'repl' ? 'REPL 匿名 cell（不落盘）' : 'execution count'}
      >
        [{cell.kind === 'repl' ? 'repl' : (cell.execCount ?? ' ')}]
      </span>

      {/* 语言 chip */}
      <span className="rounded-full border border-[var(--border)] px-2 py-px text-[11px]">
        python
      </span>

      {/* error (line N) 红徽章（P2.9，参考图：语言 chip 旁） */}
      {cell.status === 'error' && (
        <span
          className="rounded bg-[var(--diff-del)] px-1.5 py-0.5 text-[11px] text-[var(--accent-err)]"
          title="最近一次运行失败"
        >
          {errorLine !== null ? `error (line ${errorLine})` : 'error'}
        </span>
      )}

      {/* stale 徽章 */}
      {cell.status === 'stale' && (
        <span
          className="rounded bg-[var(--bg)] px-1.5 py-0.5 text-[11px] text-[var(--accent-stale)]"
          title="上游已变更，本 cell 输出与当前变量状态不一致"
        >
          stale
        </span>
      )}

      {/* side-effect 徽章 */}
      {cell.sideEffect && (
        <span
          className="rounded bg-[var(--bg)] px-1.5 py-0.5 text-[11px] text-[var(--accent-run)]"
          title="含副作用，默认不级联"
        >
          side-effect
        </span>
      )}

      {/* 编译错提示（cell.save compileError，P1.5 完整行内化） */}

      <span className="ml-auto flex items-center gap-1">
        {running && <span className="text-[var(--accent-run)]">running…</span>}
        {/* hover 浮现运行按钮 */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRun(cell.id);
          }}
          disabled={running || readOnly}
          title={readOnly ? "read-only session — this kernel's namespace no longer exists" : 'Run cell (Ctrl/Cmd+Enter)'}
          className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-[var(--accent-run)] opacity-0 transition-opacity group-hover:opacity-100 hover:border-[var(--accent-run)] disabled:cursor-default disabled:opacity-40"
        >
          ▶
        </button>
      </span>
    </div>
    {compileError && (
      <div className="mx-3 mt-1 rounded border border-[var(--accent-err)] bg-[var(--diff-del)] px-2 py-1 text-[12px] text-[var(--accent-err)]">
        {compileError}
      </div>
    )}
    </>
  );
}
