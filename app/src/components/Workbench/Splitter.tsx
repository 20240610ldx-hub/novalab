import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

/**
 * 竖向分隔条（侧栏 / Agent 栏宽度缩放，VS Code sash 语义）。
 * - 拖拽：pointer capture，宽度 = 起始宽 ± 位移（left 侧栏向右拖变宽；right Agent 栏向左拖变宽）；
 * - 双击：恢复默认宽度；键盘 ←/→ 每次 16px（role=separator 可聚焦）。
 * 夹紧在 store（setSideWidth / setAgentWidth）完成，这里只报原始值。
 */
export function Splitter({
  side,
  width,
  min,
  max,
  label,
  onResize,
  onReset,
}: {
  side: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  label: string;
  onResize: (w: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const sign = side === 'left' ? 1 : -1;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: width };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onResize(drag.current.w + sign * (e.clientX - drag.current.x));
  };
  const end = () => {
    drag.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') onResize(width - 16 * sign);
    else if (e.key === 'ArrowRight') onResize(width + 16 * sign);
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className="nl-sash relative z-10 w-1 shrink-0 cursor-col-resize outline-none"
    />
  );
}
