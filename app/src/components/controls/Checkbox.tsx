import { controlVarName, specStr, type ControlPayload } from './logic';
import { useControlCommit } from './useControlCommit';

/** checkbox：即时发 control.set（spec §15.3，无节流）。 */
export function CheckboxControl({ payload }: { payload: ControlPayload }) {
  const label = specStr(payload.spec['label']) ?? controlVarName(payload.controlId);
  const { value, pending, commit } = useControlCommit<boolean>(
    payload.controlId,
    payload.value === true,
  );

  return (
    <label className="flex w-fit cursor-pointer items-center gap-2">
      <input
        type="checkbox"
        checked={value}
        aria-label={label}
        onChange={(e) => commit(e.target.checked)}
        className="size-3.5 cursor-pointer accent-[var(--accent-run)]"
      />
      <span className="text-[var(--muted)]">{label}</span>
      {pending && <span className="text-[11px] text-[var(--muted)]">syncing…</span>}
    </label>
  );
}
