import {
  controlVarName,
  normalizeSelection,
  specNum,
  specStr,
  type ControlPayload,
  type SelectionMode,
} from './logic';
import { useControlCommit } from './useControlCommit';

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * table：spec.rows（内核截 head 100 行）渲染暗色表格；selection 模式下行可点选
 * （single 单选 toggle / multi 多选 toggle），value = 选中行索引列表，行点击即时发
 * control.set（spec §15.3）。selection=null → 纯展示不可选。
 */
export function ControlTable({ payload }: { payload: ControlPayload }) {
  const label = specStr(payload.spec['label']) ?? controlVarName(payload.controlId);

  const rawColumns = payload.spec['columns'];
  const columns: string[] = Array.isArray(rawColumns)
    ? rawColumns.map((c) =>
        c && typeof c === 'object'
          ? cellText((c as Record<string, unknown>)['name'])
          : cellText(c),
      )
    : [];
  const rawRows = payload.spec['rows'];
  const rows: Record<string, unknown>[] = Array.isArray(rawRows)
    ? (rawRows.filter((r) => r && typeof r === 'object') as Record<string, unknown>[])
    : [];
  const rowCount = specNum(payload.spec['rowCount'], rows.length);
  const mode: SelectionMode =
    payload.spec['selection'] === 'single' || payload.spec['selection'] === 'multi'
      ? payload.spec['selection']
      : null;

  const initial = normalizeSelection(payload.value, rowCount, mode);
  const { value, pending, commit } = useControlCommit<number[] | null>(payload.controlId, initial);
  const selected = normalizeSelection(value, rowCount, mode) ?? [];

  const toggle = (i: number): void => {
    if (!mode) return;
    if (mode === 'single') {
      commit(selected.includes(i) ? [] : [i]);
      return;
    }
    commit(selected.includes(i) ? selected.filter((x) => x !== i) : [...selected, i]);
  };

  // spec.columns 缺失时以首行对象键兜底
  const cols = columns.length > 0 ? columns : Object.keys(rows[0] ?? {});

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-2 text-[var(--muted)]">
        <span className="min-w-0 truncate" title={label}>
          {label}
        </span>
        <span className="shrink-0 text-[11px]">
          {rowCount} rows
          {mode ? ` · ${mode} select` : ''}
          {selected.length > 0 ? ` · selected [${selected.join(', ')}]` : ''}
        </span>
        {pending && <span className="shrink-0 text-[11px]">syncing…</span>}
      </div>
      <div className="max-h-64 min-w-0 overflow-auto rounded border border-[var(--border)]">
        <table className="w-full border-collapse text-[12px]" style={{ fontFamily: 'var(--font-mono)' }}>
          <thead>
            <tr>
              {cols.map((c) => (
                <th
                  key={c}
                  className="sticky top-0 border-b border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-left font-normal text-[var(--muted)]"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={i}
                onClick={() => toggle(i)}
                className={
                  (mode ? 'cursor-pointer ' : '') +
                  (selected.includes(i) ? 'bg-[var(--sel-bg)]' : i % 2 ? 'bg-[var(--panel)]' : '')
                }
              >
                {cols.map((c) => (
                  <td key={c} className="border-b border-[var(--border)] px-2 py-0.5 text-[var(--text)]">
                    {cellText(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="px-2 py-1.5 text-[var(--muted)]">(no rows)</div>}
      </div>
      {rowCount > rows.length && (
        <div className="text-[11px] text-[var(--muted)]">
          showing head {rows.length} of {rowCount} rows
        </div>
      )}
    </div>
  );
}
