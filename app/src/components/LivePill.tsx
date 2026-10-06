import { useNotebook } from '../store/notebook';
import type { KernelState } from '../kernel/types';

function pillColor(s: KernelState): string {
  switch (s) {
    case 'live':
      return 'var(--accent-ok)';
    case 'busy':
      return 'var(--accent-run)';
    case 'dead':
      return 'var(--accent-err)';
    case 'restarting':
      return 'var(--accent-run)';
    default:
      return 'var(--muted)';
  }
}

/**
 * 右上内核连接状态 pill（截图元素 2）：`● live/idle/busy/dead`。
 * dead → 红色，点击触发 kernel.restart（P1 精简版；重启/断开下拉菜单留后续）。
 */
export function LivePill() {
  const kernelState = useNotebook((s) => s.kernelState);
  const restartKernel = useNotebook((s) => s.restartKernel);
  const color = pillColor(kernelState);
  const dead = kernelState === 'dead';

  return (
    <button
      type="button"
      onClick={() => {
        if (dead) void restartKernel();
      }}
      disabled={!dead}
      title={dead ? 'kernel dead — click to restart' : `kernel ${kernelState}`}
      className={`flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 py-0.5 text-[12px] ${
        dead ? 'cursor-pointer hover:border-[var(--accent-err)]' : 'cursor-default'
      }`}
      style={{ color }}
    >
      <span aria-hidden>●</span>
      {kernelState}
    </button>
  );
}
