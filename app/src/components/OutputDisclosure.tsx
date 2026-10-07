import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNotebook } from '../store/notebook';

interface OutputDisclosureProps {
  /** 摘要行右侧的计数提示（如 stdout 行数）。 */
  summary?: string;
  children: ReactNode;
  /** error 时默认展开。 */
  defaultOpen?: boolean;
  /**
   * 关联 cell id（P1.8：折叠状态经 store 持久化到 sidecar `.novalab/ui.json`）。
   * 缺省时从最近的祖先 `[data-cell-id]`（CellList 的 cell 外框）解析。
   */
  cellId?: string;
}

/**
 * `▶ output` 可折叠披露区（截图元素 5）：收起时只留一行箭头 + 摘要，
 * 展开后由 OutputRenderer 渲染 MIME bundle。error 输出默认展开。
 *
 * 折叠状态：sidecar 已有记录（uiCollapsed）时以 store 为准——openNotebook 水合、
 * 热重载的全量 notebook.state 都不会冲掉；无记录时回退本地 state（defaultOpen）。
 * 切换 → store.setCellCollapsed → ui.set（500ms debounce，store 内合并）。
 */
export function OutputDisclosure({ summary, children, defaultOpen = false, cellId }: OutputDisclosureProps) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const uiCollapsed = useNotebook((s) => s.uiCollapsed);
  const setCellCollapsed = useNotebook((s) => s.setCellCollapsed);

  // 未显式传 cellId 时从 DOM 解析（CellList 把每个 cell 包在 section[data-cell-id] 里）
  const hostRef = useRef<HTMLDivElement>(null);
  const [domCellId, setDomCellId] = useState<string | null>(null);
  useEffect(() => {
    if (cellId !== undefined) return;
    const id = hostRef.current?.closest('[data-cell-id]')?.getAttribute('data-cell-id');
    if (id) setDomCellId(id);
  }, [cellId]);

  const effectiveId = cellId ?? domCellId ?? undefined;
  const stored = effectiveId !== undefined ? uiCollapsed[effectiveId] : undefined;
  const open = stored !== undefined ? !stored : localOpen;

  const toggle = () => {
    const nextOpen = !open;
    setLocalOpen(nextOpen); // 无 sidecar 记录时的本地兜底
    if (effectiveId !== undefined) setCellCollapsed(effectiveId, !nextOpen);
  };

  return (
    <div className="mt-1" ref={hostRef}>
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-1.5 px-3 py-1 text-[12px] text-[var(--muted)] hover:text-[var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent-run)]"
        aria-expanded={open}
      >
        <span className="inline-block transition-transform" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
          ▶
        </span>
        <span>output</span>
        {summary && <span className="text-[var(--muted)]/70">· {summary}</span>}
      </button>
      {open && children}
    </div>
  );
}
