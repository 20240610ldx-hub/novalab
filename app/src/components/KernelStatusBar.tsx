import { useNotebook } from '../store/notebook';
import type { KernelState } from '../kernel/types';

/** 前端 KernelState → 状态栏文案（live/connecting 显示为 idle，截图元素 6）。 */
function statusText(s: KernelState): string {
  switch (s) {
    case 'busy':
      return 'busy';
    case 'dead':
      return 'dead';
    case 'restarting':
      return 'restarting';
    default:
      return 'idle';
  }
}

function statusColor(s: KernelState): string {
  switch (s) {
    case 'busy':
      return 'var(--accent-run)';
    case 'dead':
      return 'var(--accent-err)';
    default:
      return 'var(--accent-ok)';
  }
}

/**
 * 底部内核状态栏（截图元素 6，P1 只画拖拽把手不做变量 inspector）：
 * 左 "Python kernel · shared with the agent" | 中间拖拽把手 | 右 idle/busy/dead。
 */
export function KernelStatusBar() {
  const kernelState = useNotebook((s) => s.kernelState);
  return (
    <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-1.5 text-[12px] text-[var(--muted)]">
      <span>Python kernel · shared with the agent</span>
      {/* 拖拽把手：P2 拖出变量 inspector（S3），P1 仅视觉 */}
      <span
        className="cursor-row-resize tracking-[0.2em] text-[var(--muted)] select-none"
        title="drag to expand variable inspector (P2)"
      >
        ⠿⠿
      </span>
      <span style={{ color: statusColor(kernelState) }}>{statusText(kernelState)}</span>
    </div>
  );
}
