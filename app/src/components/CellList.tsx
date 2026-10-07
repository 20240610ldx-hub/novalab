import { useEffect, useMemo, useRef, useState } from 'react';
import { useNotebook } from '../store/notebook';
import { isOutputEmpty, lastCellFrameLine, type Cell } from '../kernel/types';
import { CellHeader } from './CellHeader';
import { CellEditor } from './CellEditor';
import { DiffOverlay } from './diff/InlineDiff';
import { OutputDisclosure } from './OutputDisclosure';
import { OutputRenderer } from './OutputRenderer';

/**
 * 轻量窗口化（100 cell 60fps 目标，spec §13）：
 * 每个 cell 的外框（header + 占位/编辑器 + output）始终挂载以维持滚动几何与
 * IntersectionObserver 观察点；但只有落在视口 ±2 屏（rootMargin=200vh）内的
 * cell 才真正挂载 CM6 实例，视口外的 cell 渲染静态 <pre> 占位。滚动进出视口时
 * 挂载/销毁编辑器——CM6 多实例内存与首屏解析开销因此被限制在可见窗口，
 * 而非随 cell 总数线性增长。
 */

interface CellProps {
  cell: Cell;
  active: boolean;
  mounted: boolean; // 是否在窗口化视口内（决定挂 CM6 还是静态占位）
  compileError?: string;
  onActivate: (id: string) => void;
  onCodeChange: (id: string, code: string) => void;
  onRun: (id: string) => void;
}

function CellView({
  cell,
  active,
  mounted,
  compileError,
  onActivate,
  onCodeChange,
  onRun,
}: CellProps) {
  const hasOutput = !isOutputEmpty(cell.output);

  return (
    <section
      data-cell-id={cell.id}
      onClick={() => onActivate(cell.id)}
      className="group border-b border-[var(--border)] px-4 pt-1.5 pb-3 last:border-b-0"
    >
      <CellHeader cell={cell} onRun={onRun} compileError={compileError} />

      {/* A-4 #5：代码面板 = 与页面底色分层的圆角面板（active 琥珀 1px 描边），无重边框 */}
      <div
        className="mt-1 overflow-hidden rounded-md bg-[var(--panel)]"
        style={{ border: `1px solid ${active ? 'var(--accent-run)' : 'transparent'}` }}
      >
        {mounted ? (
          <CellEditor
            value={cell.code}
            onChange={(code) => onCodeChange(cell.id, code)}
            errorLine={
              cell.status === 'error' ? lastCellFrameLine(cell.output?.traceback?.frames) : null
            }
          />
        ) : (
          // 静态占位：与编辑器同字体/行高，保证滚动几何接近、切回时无跳变
          <pre className="whitespace-pre overflow-x-auto px-3 py-[6px] text-[13px] leading-[1.65] text-[var(--text)]">
            {cell.code}
          </pre>
        )}
      </div>

      {/* P2.3 DiffOverlay 挂载点：目标为本 cell 的 pending diff 行内审阅 UI（无则 null） */}
      <DiffOverlay cellId={cell.id} />

      {hasOutput && cell.output && (
        <OutputDisclosure
          defaultOpen={cell.status === 'error'}
          summary={cell.output.traceback ? 'error' : undefined}
        >
          <OutputRenderer output={cell.output} />
        </OutputDisclosure>
      )}
    </section>
  );
}

export function CellList() {
  const cells = useNotebook((s) => s.cells);
  const activeCellId = useNotebook((s) => s.activeCellId);
  const compileErrors = useNotebook((s) => s.compileErrors);
  const setActive = useNotebook((s) => s.setActive);
  const setCellCode = useNotebook((s) => s.setCellCode);
  const saveCell = useNotebook((s) => s.saveCell);
  const runCell = useNotebook((s) => s.runCell);

  // 视口内（±2 屏）的 cell id 集合
  const [inView, setInView] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  // 本地 debounce：编辑 → 立即更新 store.code，300ms 静默后发 cell.save
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // 观察依赖用 id 序列而非 length：换 notebook 时 DOM 节点被替换，需重建 observer
  const cellIds = useMemo(() => cells.map((c) => c.id).join('|'), [cells]);

  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setInView((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.cellId;
            if (!id) continue;
            if (e.isIntersecting && !next.has(id)) {
              next.add(id);
              changed = true;
            } else if (!e.isIntersecting && next.has(id)) {
              next.delete(id);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { root: null, rootMargin: '200% 0px', threshold: 0 },
    );
    for (const el of root.querySelectorAll<HTMLElement>('[data-cell-id]')) {
      observer.observe(el);
    }
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellIds]);

  // 卸载时清空 debounce 计时器
  useEffect(() => {
    const timers = saveTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const handleCodeChange = useMemo(
    () => (id: string, code: string) => {
      setCellCode(id, code); // 受控：立即回写 store.cell.code
      const timers = saveTimers.current;
      const prev = timers.get(id);
      if (prev) clearTimeout(prev);
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          void saveCell(id, code); // 300ms debounce → cell.save（重算 DAG/stale）
        }, 300),
      );
    },
    [setCellCode, saveCell],
  );

  if (cells.length === 0) {
    return (
      <p className="p-4 text-[var(--muted)]">
        尚无 cell —— 打开一个 .py notebook 后由 notebook.state 加载。
      </p>
    );
  }

  return (
    <div ref={listRef} className="pb-4">
      {cells.map((c) => (
        <CellView
          key={c.id}
          cell={c}
          active={activeCellId === c.id}
          mounted={inView.has(c.id)}
          compileError={compileErrors[c.id]}
          onActivate={setActive}
          onCodeChange={handleCodeChange}
          onRun={(id) => void runCell(id)}
        />
      ))}
    </div>
  );
}
