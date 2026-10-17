/**
 * 草稿恢复日志（第 7 轮，A15 子包；docs/proposal-draft-recovery.md）。
 * 位置：<notebook 目录>/.novalab/drafts/<basename>.<ms>-<rand8>.draft.json（Owner 裁决：notebook 旁、7 天）。
 * 有界：每 notebook 最多 DRAFT_MAX_COPIES 份、DRAFT_TTL_MS 后删除、单份 ≤ DRAFT_MAX_BYTES。
 * 只存持久 cell 的 id/code、dirty cell 列表与 bridge 记录的基线指纹；无输出、变量、REPL 或凭据。
 *
 * 写法沿用第 4 轮 serialize.write_file：同目录排它创建临时文件 → 写入 → fsync → rename；
 * 失败删除临时文件。由 bridge 写而非内核：草稿长期未保存的场景（内核 dead、保存暂停/失败）里
 * 只有 bridge 一定在。
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import path from 'node:path';

export const DRAFT_MAX_BYTES = 2 * 1024 * 1024;
export const DRAFT_MAX_COPIES = 5;
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface DraftCell { id: string; code: string }

export interface DraftJournal {
  version: 1;
  notebook: string;
  baselineSha256: string | null;
  savedAt: string;
  cells: DraftCell[];
  dirtyCellIds: string[];
}

export interface StoredDraft extends DraftJournal { draftId: string }

export interface DraftInput {
  baselineSha256: string | null;
  cells: DraftCell[];
  dirtyCellIds: string[];
}

export class DraftTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`draft journal is ${bytes} bytes; limit is ${DRAFT_MAX_BYTES}`);
    this.name = 'DraftTooLargeError';
  }
}

const DRAFT_ID = /^(\d{1,15})-([0-9a-f]{8})$/;
const SUFFIX = '.draft.json';

export function draftsDir(notebookPath: string): string {
  return path.join(path.dirname(path.resolve(notebookPath)), '.novalab', 'drafts');
}

function fileFor(notebookPath: string, draftId: string): string {
  return path.join(draftsDir(notebookPath), `${path.basename(notebookPath)}.${draftId}${SUFFIX}`);
}

/** 本 notebook 的日志（文件名精确匹配 `<basename>.<id>.draft.json`），按时间戳新→旧。 */
function ownEntries(notebookPath: string): { draftId: string; at: number }[] {
  const prefix = `${path.basename(notebookPath)}.`;
  let names: string[];
  try {
    names = readdirSync(draftsDir(notebookPath));
  } catch {
    return [];
  }
  const out: { draftId: string; at: number }[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(SUFFIX)) continue;
    const draftId = name.slice(prefix.length, -SUFFIX.length);
    const match = DRAFT_ID.exec(draftId);
    if (match) out.push({ draftId, at: Number(match[1]) });
  }
  return out.sort((a, b) => b.at - a.at || (a.draftId < b.draftId ? 1 : -1));
}

function removeQuietly(file: string): boolean {
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** 删过期（> TTL）与超出份数上限的旧份；返回保留的 id（新→旧）。 */
function prune(notebookPath: string, now: number): string[] {
  const kept: string[] = [];
  for (const entry of ownEntries(notebookPath)) {
    if (now - entry.at > DRAFT_TTL_MS || kept.length >= DRAFT_MAX_COPIES) {
      removeQuietly(fileFor(notebookPath, entry.draftId));
    } else {
      kept.push(entry.draftId);
    }
  }
  return kept;
}

function fsyncDirectory(dir: string): void {
  if (process.platform === 'win32') return; // Windows 不支持对目录句柄 fsync
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    /* 尽力而为：与第 4 轮一致，不承诺断电后的目录持久性 */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeDraft(notebookPath: string, input: DraftInput, now = Date.now()): { draftId: string; bytes: number } {
  const journal: DraftJournal = {
    version: 1,
    notebook: path.basename(notebookPath),
    baselineSha256: typeof input.baselineSha256 === 'string' ? input.baselineSha256 : null,
    savedAt: new Date(now).toISOString(),
    cells: input.cells.map((cell) => ({ id: String(cell.id), code: String(cell.code) })),
    dirtyCellIds: input.dirtyCellIds.map(String),
  };
  const body = JSON.stringify(journal);
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > DRAFT_MAX_BYTES) throw new DraftTooLargeError(bytes);

  const dir = draftsDir(notebookPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const draftId = `${now}-${randomBytes(4).toString('hex')}`;
  const target = fileFor(notebookPath, draftId);
  const temporary = path.join(dir, `.${path.basename(notebookPath)}.${draftId}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
  } catch (err) {
    removeQuietly(temporary);
    throw err;
  }
  fsyncDirectory(dir);
  prune(notebookPath, now);
  return { draftId, bytes };
}

export function listDraftIds(notebookPath: string, now = Date.now()): string[] {
  return prune(notebookPath, now);
}

function parseDraft(body: string, draftId: string): StoredDraft | null {
  try {
    const raw = JSON.parse(body) as Partial<DraftJournal>;
    if (raw.version !== 1 || !Array.isArray(raw.cells) || !Array.isArray(raw.dirtyCellIds)) return null;
    if (raw.cells.some((c) => !c || typeof c.id !== 'string' || typeof c.code !== 'string')) return null;
    if (raw.dirtyCellIds.some((id) => typeof id !== 'string')) return null;
    return {
      draftId,
      version: 1,
      notebook: typeof raw.notebook === 'string' ? raw.notebook : '',
      baselineSha256: typeof raw.baselineSha256 === 'string' ? raw.baselineSha256 : null,
      savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : '',
      cells: raw.cells.map((c) => ({ id: c.id, code: c.code })),
      dirtyCellIds: [...raw.dirtyCellIds],
    };
  } catch {
    return null;
  }
}

export function readDraft(notebookPath: string, draftId: string): StoredDraft | null {
  if (!DRAFT_ID.test(draftId)) return null;
  try {
    const body = readFileSync(fileFor(notebookPath, draftId), 'utf8');
    if (Buffer.byteLength(body, 'utf8') > DRAFT_MAX_BYTES) return null;
    return parseDraft(body, draftId);
  } catch {
    return null;
  }
}

/** 最新一份可解析的日志；损坏份跳过（不删除，留给 TTL/份数上限清理）。 */
export function readLatestDraft(notebookPath: string, now = Date.now()): StoredDraft | null {
  for (const draftId of prune(notebookPath, now)) {
    const draft = readDraft(notebookPath, draftId);
    if (draft) return draft;
  }
  return null;
}

export function clearDrafts(notebookPath: string): number {
  let removed = 0;
  for (const entry of ownEntries(notebookPath)) {
    if (removeQuietly(fileFor(notebookPath, entry.draftId))) removed += 1;
  }
  return removed;
}
