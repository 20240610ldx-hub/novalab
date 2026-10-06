import { useNotebook, type CascadeOverride } from '../store/notebook';
import { useSession, viewOnlyFooter } from '../store/session';
import type { KernelState } from '../kernel/types';
import { DiffTray } from './diff/Tray';
import { CascadeAskDialog } from './diff/CascadeAskDialog';

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

const CASCADE_OPTIONS: { value: CascadeOverride; label: string }[] = [
  { value: 'policy', label: 'policy' },
  { value: 'auto', label: 'auto' },
  { value: 'mark-only', label: 'mark-only' },
  { value: 'ask', label: 'ask' },
];

/**
 * 底部内核状态栏（截图元素 6）：
 * 左 "Python kernel · shared with the agent" | 中间拖拽把手 |
 * 右 cell 计数（A-2 #16）+ 级联策略开关（P2.4）+ idle/busy/dead。
 * P2.8：历史会话只读时左侧换为 `Python · ended HH:MM — view only; …`（A-2 #12）。
 *
 * P2.3 挂载宿主：DiffTray / CascadeAskDialog 均为 fixed 定位（徽章钉在视口
 * 顶栏右侧、弹窗居中），挂载位置不影响视觉位置；选这里是因为 App.tsx 不在
 * P2.3 的文件所有权清单内。
 */
export function KernelStatusBar() {
  const kernelState = useNotebook((s) => s.kernelState);
  const cellCount = useNotebook((s) => s.cells.length);
  const cascadeOverride = useNotebook((s) => s.cascadeOverride);
  const setCascadeOverride = useNotebook((s) => s.setCascadeOverride);
  const readOnly = useSession((s) => s.readOnly);
  const viewingEndedAt = useSession((s) => s.viewingEndedAt);

  const endedDate = viewingEndedAt ? new Date(viewingEndedAt) : null;
  const leftText =
    readOnly && endedDate && !Number.isNaN(endedDate.getTime())
      ? viewOnlyFooter(endedDate)
      : 'Python kernel · shared with the agent';

  return (
    <div className="relative flex items-center justify-between border-t border-[var(--border)] px-3 py-1.5 text-[12px] text-[var(--muted)]">
      {/* fixed 定位的 diff 审阅托盘与级联确认窗（视觉位置在顶栏右侧/视口中央） */}
      <DiffTray />
      <CascadeAskDialog />

      <span>{leftText}</span>
      {/* 拖拽把手：P2 拖出变量 inspector（S3），目前仅视觉 */}
      <span
        className="cursor-row-resize tracking-[0.2em] text-[var(--muted)] select-none"
        title="drag to expand variable inspector (P2)"
      >
        ⠿⠿
      </span>
      <span className="flex items-center gap-2">
        {/* A-2 #16：footer 右侧 cell 计数（只读视图 = 截断后展示数） */}
        <span>{cellCount} cells</span>
        {/* P2.4 级联策略开关：policy = decideStalePolicy 裁决（Owner 默认 mark-only） */}
        <label className="flex items-center gap-1" title="上游重跑/diff 采纳后，stale 下游的处理策略">
          cascade:
          <select
            value={cascadeOverride}
            onChange={(e) => setCascadeOverride(e.target.value as CascadeOverride)}
            className="rounded border border-[var(--border)] bg-[var(--bg)] px-1 py-0.5 text-[11px] text-[var(--text)] outline-none focus:border-[var(--accent-run)]"
          >
            {CASCADE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <span style={{ color: statusColor(kernelState) }}>{statusText(kernelState)}</span>
      </span>
    </div>
  );
}
