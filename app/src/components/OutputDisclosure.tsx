import { useState, type ReactNode } from 'react';

interface OutputDisclosureProps {
  /** 摘要行右侧的计数提示（如 stdout 行数）。 */
  summary?: string;
  children: ReactNode;
  /** error 时默认展开。 */
  defaultOpen?: boolean;
}

/**
 * `▶ output` 可折叠披露区（截图元素 5）：收起时只留一行箭头 + 摘要，
 * 展开后由 OutputRenderer 渲染 MIME bundle。error 输出默认展开。
 */
export function OutputDisclosure({ summary, children, defaultOpen = false }: OutputDisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1 text-[12px] text-[var(--muted)] hover:text-[var(--text)]"
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
