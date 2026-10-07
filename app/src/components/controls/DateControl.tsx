import { controlVarName, specStr, type ControlPayload } from './logic';
import { useControlCommit } from './useControlCommit';

/**
 * date：原生 input[type=date]（值天然是 ISO 'YYYY-MM-DD'，与内核 Date.validate
 * 对齐）；清空发 null（内核归一为 None）。变更即时发。
 */
export function DateControl({ payload }: { payload: ControlPayload }) {
  const label = specStr(payload.spec['label']) ?? controlVarName(payload.controlId);
  const initial = typeof payload.value === 'string' ? payload.value : null;
  const { value, pending, commit } = useControlCommit<string | null>(payload.controlId, initial);

  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 max-w-[40%] truncate text-[var(--muted)]" title={label}>
        {label}
      </span>
      <input
        type="date"
        value={value ?? ''}
        aria-label={label}
        onChange={(e) => commit(e.target.value === '' ? null : e.target.value)}
        className="rounded border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-[var(--text)] outline-none focus:border-[var(--accent-run)]"
        style={{ colorScheme: 'dark', fontFamily: 'var(--font-mono)' }}
      />
      {pending && <span className="shrink-0 text-[11px] text-[var(--muted)]">syncing…</span>}
    </div>
  );
}
