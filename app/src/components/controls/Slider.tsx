import { useEffect, useRef, useState } from 'react';
import {
  clampSlider,
  controlVarName,
  createThrottler,
  specNum,
  specStr,
  type ControlPayload,
  type Throttler,
} from './logic';
import { useControlCommit } from './useControlCommit';

/** slider 拖动发送节流窗口（spec §15.3：80ms coalesce，trailing edge 发最新值）。 */
export const SLIDER_THROTTLE_MS = 80;

export function SliderControl({ payload }: { payload: ControlPayload }) {
  const start = specNum(payload.spec['start'], 0);
  const stop = specNum(payload.spec['stop'], 100);
  const step = Math.abs(specNum(payload.spec['step'], 1)) || 1;
  const lo = Math.min(start, stop);
  const hi = Math.max(start, stop);
  const label = specStr(payload.spec['label']) ?? controlVarName(payload.controlId);

  const initial = clampSlider(specNum(payload.value, start), start, stop);
  const { value, pending, commit } = useControlCommit<number>(payload.controlId, initial);

  // 拖动中显示值本地即时更新（手感），control.set 走 80ms 节流（松手/失焦即 flush）
  const [display, setDisplay] = useState(value);
  useEffect(() => setDisplay(value), [value]);
  const throttler = useRef<Throttler<number> | null>(null);
  if (throttler.current === null) throttler.current = createThrottler(SLIDER_THROTTLE_MS, commit);
  useEffect(() => () => throttler.current?.cancel(), []);

  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 max-w-[40%] truncate text-[var(--muted)]" title={label}>
        {label}
      </span>
      <input
        type="range"
        min={lo}
        max={hi}
        step={step}
        value={display}
        aria-label={label}
        onChange={(e) => {
          const v = clampSlider(Number(e.target.value), start, stop);
          setDisplay(v);
          throttler.current?.schedule(v);
        }}
        onPointerUp={() => throttler.current?.flush()}
        onBlur={() => throttler.current?.flush()}
        className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[var(--accent-run)]"
      />
      <span className="shrink-0 text-[var(--text)]" style={{ fontFamily: 'var(--font-mono)' }}>
        {display}
      </span>
      {pending && <span className="shrink-0 text-[11px] text-[var(--muted)]">syncing…</span>}
    </div>
  );
}
