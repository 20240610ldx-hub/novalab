/**
 * 草稿恢复日志格式的共享夹具（bridge 读 / Tauri Rust 离线写，两侧同一组样例）。
 * Rust 侧对应用例在 app/src-tauri/src/drafts.rs 的 tests 模块。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DRAFT_MAX_COPIES, DRAFT_TTL_MS, draftsDir, listDraftIds, readDraft } from './drafts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', 'draft-journal');
const valid = readFileSync(path.join(fixtures, 'valid.v1.draft.json'), 'utf8');
const invalid = JSON.parse(readFileSync(path.join(fixtures, 'invalid-cases.json'), 'utf8')) as { cases: { name: string; body: string }[] };
const prune = JSON.parse(readFileSync(path.join(fixtures, 'prune-cases.json'), 'utf8')) as {
  maxCopies: number; ttlMs: number; cases: { name: string; now: number; existing: number[]; expect: number[] }[];
};

let work: string | undefined;
function notebook(): string {
  work = mkdtempSync(path.join(tmpdir(), 'novalab-draft-fixtures-'));
  const file = path.join(work, 'a.py');
  writeFileSync(file, '# %% [cell-id: aaaaaaaa]\nx = 1\n');
  mkdirSync(draftsDir(file), { recursive: true });
  return file;
}
const place = (nb: string, ms: number, body: string, n = 0) => {
  const draftId = `${ms}-${n.toString(16).padStart(8, '0')}`;
  writeFileSync(path.join(draftsDir(nb), `a.py.${draftId}.draft.json`), body);
  return draftId;
};
afterEach(() => { if (work) rmSync(work, { recursive: true, force: true }); work = undefined; });

describe('shared draft-journal fixtures', () => {
  it('the bounds in the fixtures are the bridge bounds', () => {
    expect(prune.maxCopies).toBe(DRAFT_MAX_COPIES);
    expect(prune.ttlMs).toBe(DRAFT_TTL_MS);
  });

  it('reads the canonical v1 journal exactly', () => {
    const nb = notebook();
    const id = place(nb, 1760688000000, valid);
    expect(readDraft(nb, id)).toEqual({ draftId: id, ...JSON.parse(valid) });
  });

  for (const c of invalid.cases) {
    it(`rejects invalid journal: ${c.name}`, () => {
      const nb = notebook();
      expect(readDraft(nb, place(nb, 1760688000000, c.body))).toBeNull();
    });
  }

  for (const c of prune.cases) {
    it(`prunes: ${c.name}`, () => {
      const nb = notebook();
      c.existing.forEach((ms, i) => place(nb, ms, valid, i));
      expect(listDraftIds(nb, c.now).map((id) => Number(id.split('-')[0]))).toEqual(c.expect);
    });
  }
});
