import type { Cell } from '../kernel/types';

interface CellHeaderProps {
  cell: Cell;
  onRun: (cellId: string) => void;
  /** cell.save 返回的编译错（spec §12：保存即报，不进运行队列）。 */
  compileError?: string;
}

/**
 * cell 头（截图元素 3 + 增量徽章）：
 * [execCount] 执行计数徽章（repl 匿名 cell 显示 [repl]）· python 语言 chip ·
 * stale 灰徽章 · side-effect amber 徽章（默认不级联）· hover 浮现运行按钮 ▶。
 */
export function CellHeader({ cell, onRun, compileError }: CellHeaderProps) {
  const running = cell.status === 'running';
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
          disabled={running}
          title="Run cell (Ctrl/Cmd+Enter)"
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
