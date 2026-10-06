/**
 * UiStore —— UI 状态 sidecar `.novalab/ui.json`（spec §4, ADR-002, plan P1.8）。
 *
 * UI 状态（折叠、activeCell）不进 .py，存 notebook 目录下的 `.novalab/ui.json`：
 *   { "<notebookPath>": { collapsed: {cellId: bool}, activeCellId: string|null } }
 *
 * - get/set 以 notebookPath 为键；set 为 shallow merge（patch 顶层键整体替换）。
 * - 文件损坏/缺失/形状不对 → 一律回退默认空对象，不抛（UI 状态不值得崩 RPC）。
 * - 写入 debounce（默认 200ms）合并连发；flush() 立即落盘（进程退场调）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface NotebookUiState {
  collapsed: Record<string, boolean>;
  activeCellId: string | null;
}

/** ui.set 的补丁：shallow merge，只认这两个键。 */
export type UiPatch = Partial<NotebookUiState>;

/** ui.json 的文件形状：notebookPath → 该 notebook 的 UI 状态。 */
export type UiFileShape = Record<string, NotebookUiState>;

export interface UiStoreOptions {
  /** 写入 debounce，默认 200ms。 */
  debounceMs?: number;
}

interface FileEntry {
  readonly file: string;
  data: UiFileShape;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_STATE: NotebookUiState = { collapsed: {}, activeCellId: null };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 宽容归一化：任何形状的条目都洗成合法 NotebookUiState（垃圾键丢弃）。 */
function normalizeEntry(raw: unknown): NotebookUiState {
  if (!isPlainObject(raw)) return { ...DEFAULT_STATE, collapsed: {} };
  const collapsed: Record<string, boolean> = {};
  if (isPlainObject(raw['collapsed'])) {
    for (const [cellId, v] of Object.entries(raw['collapsed'])) {
      if (typeof v === 'boolean') collapsed[cellId] = v;
    }
  }
  const active = raw['activeCellId'];
  return {
    collapsed,
    activeCellId: typeof active === 'string' ? active : null,
  };
}

function normalizeFile(raw: unknown): UiFileShape {
  if (!isPlainObject(raw)) return {};
  const out: UiFileShape = {};
  for (const [key, value] of Object.entries(raw)) out[key] = normalizeEntry(value);
  return out;
}

export class UiStore {
  private readonly debounceMs: number;
  private readonly entries = new Map<string, FileEntry>();

  constructor(opts: UiStoreOptions = {}) {
    this.debounceMs = opts.debounceMs ?? 200;
  }

  /** notebookPath → 它的 sidecar 文件（notebook 目录下的 .novalab/ui.json）。 */
  static fileFor(notebookPath: string): string {
    return path.join(path.dirname(notebookPath), '.novalab', 'ui.json');
  }

  /** 读 UI 状态；文件缺失/损坏 → 默认空对象（不抛）。 */
  get(notebookPath: string): NotebookUiState {
    const entry = this.fileEntry(notebookPath);
    return normalizeEntry(entry.data[notebookPath]);
  }

  /** shallow merge 写入并调度落盘，返回合并后的完整状态。 */
  set(notebookPath: string, patch: UiPatch): NotebookUiState {
    const entry = this.fileEntry(notebookPath);
    const current = normalizeEntry(entry.data[notebookPath]);
    const next: NotebookUiState = { ...current };
    if (patch.collapsed !== undefined) next.collapsed = normalizeEntry({ collapsed: patch.collapsed }).collapsed;
    if (patch.activeCellId !== undefined) {
      next.activeCellId = typeof patch.activeCellId === 'string' ? patch.activeCellId : null;
    }
    entry.data[notebookPath] = next;
    this.scheduleWrite(entry);
    return { collapsed: { ...next.collapsed }, activeCellId: next.activeCellId };
  }

  /** 立即写出全部脏文件（debounce 未到期也写）；进程退场/单测断言用。 */
  flush(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.timer = undefined;
      this.writeNow(entry);
    }
  }

  close(): void {
    this.flush();
  }

  // ---------- 内部 ----------

  private fileEntry(notebookPath: string): FileEntry {
    const file = UiStore.fileFor(notebookPath);
    let entry = this.entries.get(file);
    if (!entry) {
      entry = { file, data: this.readSafe(file), dirty: false };
      this.entries.set(file, entry);
    }
    return entry;
  }

  private readSafe(file: string): UiFileShape {
    try {
      return normalizeFile(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return {}; // 缺失或损坏 JSON → 空文件形状
    }
  }

  private scheduleWrite(entry: FileEntry): void {
    entry.dirty = true;
    if (entry.timer !== undefined) return; // debounce：窗口内连发合并为一次写
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      this.writeNow(entry);
    }, this.debounceMs);
    entry.timer.unref?.();
  }

  private writeNow(entry: FileEntry): void {
    if (!entry.dirty) return;
    entry.dirty = false;
    try {
      mkdirSync(path.dirname(entry.file), { recursive: true });
      writeFileSync(entry.file, JSON.stringify(entry.data, null, 2) + '\n', 'utf8');
    } catch (err) {
      process.stderr.write(
        `[bridge] ui.json 写入失败（${entry.file}）: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}
