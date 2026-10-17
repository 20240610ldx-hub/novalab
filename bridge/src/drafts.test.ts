/**
 * 第 7 轮草稿恢复日志：原子写、有界（5 份 / 7 天 / 2 MiB）、只含 id/code、损坏份不影响旧份。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DRAFT_MAX_BYTES, DRAFT_MAX_COPIES, DRAFT_TTL_MS, DraftTooLargeError,
  clearDrafts, draftsDir, listDraftIds, readDraft, readLatestDraft, writeDraft,
} from './drafts';

let work: string | undefined;
function notebook(name = 'a.py'): string {
  work ??= mkdtempSync(path.join(tmpdir(), 'novalab-drafts-'));
  const file = path.join(work, name);
  writeFileSync(file, '# %% [cell-id: a]\nx = 1\n');
  return file;
}
const input = (code = 'x = 2') => ({ baselineSha256: 'sha-base', cells: [{ id: 'a', code }], dirtyCellIds: ['a'] });
afterEach(() => { if (work) rmSync(work, { recursive: true, force: true }); work = undefined; });

describe('draft journal', () => {
  it('writes one complete file under .novalab/drafts next to the notebook, leaving no temp file', () => {
    const nb = notebook();
    const t = Date.UTC(2026, 9, 17, 8, 0, 0);
    const { draftId, bytes } = writeDraft(nb, input(), t);
    const dir = draftsDir(nb);
    expect(dir).toBe(path.join(path.dirname(nb), '.novalab', 'drafts'));
    const files = readdirSync(dir);
    expect(files).toEqual([`a.py.${draftId}.draft.json`]);
    const body = readFileSync(path.join(dir, files[0]!), 'utf8');
    expect(Buffer.byteLength(body)).toBe(bytes);
    const parsed = JSON.parse(body);
    expect(Object.keys(parsed).sort()).toEqual(['baselineSha256', 'cells', 'dirtyCellIds', 'notebook', 'savedAt', 'version']);
    expect(parsed).toMatchObject({ version: 1, notebook: 'a.py', baselineSha256: 'sha-base', dirtyCellIds: ['a'], cells: [{ id: 'a', code: 'x = 2' }] });
    expect(parsed.savedAt).toBe(new Date(t).toISOString());
    if (process.platform !== 'win32') expect(statSync(path.join(dir, files[0]!)).mode & 0o777).toBe(0o600);
  });

  it('keeps only id/code per cell (no outputs, exec counts or other fields)', () => {
    const nb = notebook();
    const cells = [{ id: 'a', code: 'x = 2', output: { stdout: 'secret result' }, execCount: 4, kind: 'code' }] as never;
    writeDraft(nb, { baselineSha256: null, cells, dirtyCellIds: ['a'] });
    const stored = readLatestDraft(nb)!;
    expect(stored.cells).toEqual([{ id: 'a', code: 'x = 2' }]);
    expect(JSON.stringify(stored)).not.toContain('secret result');
  });

  it(`keeps at most ${DRAFT_MAX_COPIES} copies per notebook and never touches other notebooks' drafts`, () => {
    const nb = notebook('a.py');
    const other = notebook('aa.py');
    writeDraft(other, input('other'), 1_000);
    const t0 = Date.UTC(2026, 9, 17);
    const ids = Array.from({ length: DRAFT_MAX_COPIES + 2 }, (_, i) => writeDraft(nb, input(`x = ${i}`), t0 + i * 1_000).draftId);
    expect(listDraftIds(nb, t0 + 10_000)).toEqual(ids.slice(-DRAFT_MAX_COPIES).reverse());
    expect(readLatestDraft(nb, t0 + 10_000)!.cells[0]!.code).toBe(`x = ${DRAFT_MAX_COPIES + 1}`);
    expect(listDraftIds(other, 2_000)).toHaveLength(1);
  });

  it('drops copies older than 7 days by their recorded timestamp', () => {
    const nb = notebook();
    const t0 = Date.UTC(2026, 9, 1);
    writeDraft(nb, input('old'), t0);
    const fresh = writeDraft(nb, input('new'), t0 + DRAFT_TTL_MS).draftId;
    expect(listDraftIds(nb, t0 + DRAFT_TTL_MS + 1)).toEqual([fresh]);
    expect(readdirSync(draftsDir(nb))).toHaveLength(1);
    expect(readLatestDraft(nb, t0 + 2 * DRAFT_TTL_MS + 1)).toBeNull();
    expect(readdirSync(draftsDir(nb))).toHaveLength(0);
  });

  it('refuses a copy above the size limit and writes nothing', () => {
    const nb = notebook();
    expect(() => writeDraft(nb, input('x'.repeat(DRAFT_MAX_BYTES)))).toThrow(DraftTooLargeError);
    expect(listDraftIds(nb)).toEqual([]);
  });

  it('falls back to the previous copy when the newest one is corrupt', () => {
    const nb = notebook();
    const t0 = Date.UTC(2026, 9, 17);
    writeDraft(nb, input('good'), t0);
    const bad = writeDraft(nb, input('bad'), t0 + 1_000).draftId;
    writeFileSync(path.join(draftsDir(nb), `a.py.${bad}.draft.json`), '{"version":1,"cells":');
    expect(readLatestDraft(nb, t0 + 2_000)!.cells[0]!.code).toBe('good');
  });

  it('reads by id only within this notebook and rejects path-like ids', () => {
    const nb = notebook();
    const { draftId } = writeDraft(nb, input());
    expect(readDraft(nb, draftId)!.draftId).toBe(draftId);
    expect(readDraft(nb, '../../a.py')).toBeNull();
    expect(readDraft(nb, '0-zzzzzzzz')).toBeNull();
  });

  it('clears only this notebook and reports how many copies were removed', () => {
    const nb = notebook('a.py');
    const other = notebook('b.py');
    writeDraft(nb, input(), 1_000);
    writeDraft(nb, input(), 2_000);
    writeDraft(other, input(), 1_000);
    expect(clearDrafts(nb)).toBe(2);
    expect(listDraftIds(nb, 3_000)).toEqual([]);
    expect(listDraftIds(other, 3_000)).toHaveLength(1);
    expect(clearDrafts(path.join(work!, 'missing.py'))).toBe(0);
  });
});
