import { useEffect, useState } from 'react';
import { controlVarName, specStr, type ControlPayload } from './logic';
import { useControlCommit } from './useControlCommit';

/** text：击键不触发级联，Enter / 失焦提交（草稿与已提交值相同则不发）。 */
export function TextControl({ payload }: { payload: ControlPayload }) {
  const label = specStr(payload.spec['label']) ?? controlVarName(payload.controlId);
  const initial = typeof payload.value === 'string' ? payload.value : '';
  const { value, pending, commit } = useControlCommit<string>(payload.controlId, initial);

  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const submit = () => {
    if (draft !== value) commit(draft);
  };

  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 max-w-[40%] truncate text-[var(--muted)]" title={label}>
        {label}
      </span>
      <input
        type="text"
        value={draft}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        onBlur={submit}
        className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-[var(--text)] outline-none focus:border-[var(--accent-run)]"
        style={{ fontFamily: 'var(--font-mono)' }}
      />
      {pending && <span className="shrink-0 text-[11px] text-[var(--muted)]">syncing…</span>}
    </div>
  );
}
