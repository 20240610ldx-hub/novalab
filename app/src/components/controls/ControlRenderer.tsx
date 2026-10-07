import { useMemo } from 'react';
import { CheckboxControl } from './Checkbox';
import { ControlTable } from './ControlTable';
import { DateControl } from './DateControl';
import { SliderControl } from './Slider';
import { TextControl } from './TextControl';
import { parseControlPayload, type ControlPayload } from './logic';

function ControlItem({ payload }: { payload: ControlPayload }) {
  switch (payload.kind) {
    case 'slider':
      return <SliderControl payload={payload} />;
    case 'checkbox':
      return <CheckboxControl payload={payload} />;
    case 'text':
      return <TextControl payload={payload} />;
    case 'date':
      return <DateControl payload={payload} />;
    case 'table':
      return <ControlTable payload={payload} />;
    default:
      return (
        <div className="text-[12px] text-[var(--muted)]">
          unsupported control: {payload.kind} ({payload.controlId})
        </div>
      );
  }
}

/**
 * 控件 mime 载荷按 kind 分发（spec §15.2，P3.3）。
 *
 * raw = run.mime `application/vnd.novalab.control+json` 的 data：当前内核发
 * strict JSON 字符串（store 的 mime 通道是文本），parseControlPayload 对
 * 字符串/对象/数组都兼容。解析失败或未知 kind → 静默/muted 降级，不崩。
 */
export function ControlRenderer({ raw }: { raw: unknown }) {
  const controls = useMemo(() => parseControlPayload(raw), [raw]);
  if (controls.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      {controls.map((c) => (
        <ControlItem key={c.controlId} payload={c} />
      ))}
    </div>
  );
}
