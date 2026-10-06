/**
 * Sidebar 纯逻辑助手（P2.8，无 DOM/网络依赖，helpers.test.ts 覆盖）：
 * 排序 / notebook 判定 / 路径拼接 / marimo 头模板 / 文件名合法性 /
 * 最近打开（localStorage，注入 storage 以便 node 环境单测）。
 */

/** fs.list 条目（与 bridge/src/protocol.ts FsEntry 字段一致）。 */
export interface FsEntry {
  name: string;
  kind: 'dir' | 'file';
  size: number;
  mtime: string;
}

/** 目录在前、文件在后；同类按名大小写不敏感升序（jupyterlab DirListing 排序语义）。 */
export function sortEntries(entries: readonly FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    const la = a.name.toLowerCase();
    const lb = b.name.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
}

/** .py = notebook（marimo 兼容主存储，spec §4）；其余文件灰显不可开。 */
export function isNotebookFile(name: string): boolean {
  return name.toLowerCase().endsWith('.py');
}

/** root（平台分隔符）+ rel（恒 '/'）→ 绝对路径。 */
export function joinFsPath(root: string, rel: string): string {
  if (rel === '') return root;
  const sep = root.includes('\\') ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep);
}

/** rel 路径的父目录（'' 表示 root）。 */
export function parentRel(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

/** 8 位十六进制 cell id（与 py/novakernel.serialize.new_cell_id 同形状）。 */
export function newCellId(rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += Math.floor(rand() * 16).toString(16);
  return out;
}

/**
 * 新建 notebook 模板：PEP723 头（与 py serialize.DEFAULT_HEADER_LINES 一致）
 * + 一个空 cell marker（CELL_MARKER_RE 可解析）。
 */
export function notebookTemplate(cellId: string = newCellId()): string {
  return [
    '# /// script',
    '# requires-python = ">=3.11"',
    '# dependencies = []',
    '# ///',
    '',
    `# %% [cell-id: ${cellId}]`,
    '',
    '',
  ].join('\n');
}

/** 文件名合法性（bridge fs.ts isValidName 的前端镜像：提交前本地校验）。 */
export function validName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes(':') &&
    !/[\x00-\x1f]/.test(name) &&
    name !== '.' &&
    name !== '..'
  );
}

/** 确保 .py 后缀（新建 notebook：用户省略时补全）。 */
export function ensurePySuffix(name: string): string {
  return isNotebookFile(name) ? name : `${name}.py`;
}

/** 重命名时的输入框选区：文件选中主名（扩展名保留），目录全选（jupyterlab _doRename 语义）。 */
export function renameSelection(name: string): { start: number; end: number } {
  if (isNotebookFile(name)) {
    const dot = name.lastIndexOf('.');
    if (dot > 0) return { start: 0, end: dot };
  }
  return { start: 0, end: name.length };
}

/* ---------- 最近打开（localStorage，spec：sidebar 最近打开） ---------- */

export const RECENT_KEY = 'novalab.recent';
export const RECENT_LIMIT = 8;

export interface RecentEntry {
  path: string;
  openedAt: string;
}

/** 最小 storage 形状（localStorage 子集；node 单测注入内存实现）。 */
export interface KvStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadRecent(storage: KvStorage): RecentEntry[] {
  try {
    const raw = JSON.parse(storage.getItem(RECENT_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e): e is RecentEntry => !!e && typeof e === 'object' && typeof (e as RecentEntry).path === 'string')
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/** 新路径置顶、去重（大小写敏感——Windows 下同一文件不同写法视为同条目的场景可忽略）、封顶。 */
export function pushRecent(list: readonly RecentEntry[], entry: RecentEntry, limit: number = RECENT_LIMIT): RecentEntry[] {
  const rest = list.filter((e) => e.path !== entry.path);
  return [entry, ...rest].slice(0, limit);
}

export function saveRecent(storage: KvStorage, list: readonly RecentEntry[]): void {
  try {
    storage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式等：最近打开不值得崩 UI */
  }
}

/** 显示名：basename（兼容 / 与 \）。 */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 父目录显示（recent 条目的次要信息）。 */
export function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? '' : p.slice(0, i);
}

/** human 文件大小（sidebar 行尾信息）。 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
