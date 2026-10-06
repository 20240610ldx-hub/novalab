/**
 * FsManager —— 工作区文件系统 RPC 的实现（P2.8，intent M8 / spec 附录 A-2）。
 *
 * 安全边界（越界一律 FsError code=-32602）：
 * 1. 词法检查：path.resolve(root, input) 必须 === root 或落在 root + sep 前缀内；
 * 2. 符号链接检查：目标（或其最近的存在祖先）realpath 后仍须在 realpath(root) 内
 *    —— 防 root 内一个指向外部的 junction/symlink 成为逃逸通道；
 * 3. NUL 字节、root 未设置 → 同样拒绝。
 *
 * 全部操作同步（本地目录、人速频率；bridge 单线程可接受）。
 * root 默认 = 最近一次 notebook.open 的 dirname（router 调 setRootDefault），
 * 前端"设为工作区"按钮走 fs.setRoot。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { ERR_INTERNAL, ERR_INVALID_PARAMS, type FsEntry } from './protocol';

/** fs.* 的路由级错误：code 直接映射 JSON-RPC 错误码（默认 -32602）。 */
export class FsError extends Error {
  constructor(
    message: string,
    readonly code: number = ERR_INVALID_PARAMS,
  ) {
    super(message);
    this.name = 'FsError';
  }
}

/** 已知 errno → JSON-RPC 错误码（参数/状态类 -32602，其余 -32603）。 */
function mapFsError(err: unknown, op: string): FsError {
  if (err instanceof FsError) return err;
  const e = err as NodeJS.ErrnoException;
  const code =
    e?.code === 'EEXIST' ||
    e?.code === 'ENOENT' ||
    e?.code === 'ENOTDIR' ||
    e?.code === 'EISDIR' ||
    e?.code === 'EPERM' ||
    e?.code === 'EACCES' ||
    e?.code === 'EBUSY' ||
    e?.code === 'ENOTEMPTY'
      ? ERR_INVALID_PARAMS
      : ERR_INTERNAL;
  return new FsError(`fs.${op} 失败: ${e?.message ?? String(err)}`, code);
}

/** Windows 路径比较大小写不敏感（realpathSync.native 会归一大小写）。 */
const CASE_INSENSITIVE = process.platform === 'win32';

function fold(p: string): string {
  return CASE_INSENSITIVE ? p.toLowerCase() : p;
}

/** target === base 或以 base + sep 开头（已 fold）。 */
function pathContains(base: string, target: string): boolean {
  const b = fold(base);
  const t = fold(target);
  return t === b || t.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

function realpathSafe(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** 从 p 向上找第一个存在的祖先（含自身）；symlink 检查的锚点。 */
function nearestExisting(p: string): string {
  let cur = p;
  for (;;) {
    if (existsSync(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

/** 文件名合法性（jupyterlab isValidFileName 同规则 + 控制字符：非空、不含 / \ : 与 0x00-0x1f）。 */
export function isValidName(name: string): boolean {
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

export class FsManager {
  private root: string | null = null;

  getRoot(): string | null {
    return this.root;
  }

  /**
   * 显式设置工作区 root（fs.setRoot）。dir 必须是已存在的目录，否则 -32602。
   * 返回归一化（resolve + realpath）后的 root。
   */
  setRoot(dir: string): string {
    if (typeof dir !== 'string' || dir.trim() === '' || dir.includes('\0')) {
      throw new FsError('setRoot 需要非空目录路径');
    }
    const resolved = path.resolve(dir.trim());
    let st;
    try {
      st = statSync(resolved);
    } catch {
      throw new FsError(`setRoot：目录不存在: ${resolved}`);
    }
    if (!st.isDirectory()) throw new FsError(`setRoot：不是目录: ${resolved}`);
    this.root = realpathSafe(resolved) ?? resolved;
    return this.root;
  }

  /** notebook.open 的默认 root（已存在则不动——仅在 root 未设置或指向旧 notebook 目录时刷新）。 */
  setRootDefault(dir: string): string | null {
    try {
      return this.setRoot(dir);
    } catch {
      return this.root; // 默认 root 失败不阻塞 notebook.open
    }
  }

  // ---------- 路径监狱 ----------

  /**
   * 把入参（相对 root 或绝对路径）resolve 后验证仍在 root 内；越界抛 -32602。
   * 返回词法 resolve 后的绝对路径（后续 fs 调用直接使用）。
   */
  resolveInside(input: string, op: string): string {
    const root = this.root;
    if (!root) throw new FsError(`fs.${op}：尚未设置工作区 root（先 fs.setRoot 或 notebook.open）`);
    if (typeof input !== 'string' || input.includes('\0')) {
      throw new FsError(`fs.${op}：非法路径参数`);
    }
    const resolved = path.resolve(root, input);
    if (!pathContains(root, resolved)) {
      throw new FsError(`fs.${op}：路径越出工作区 root: ${input}`);
    }
    // symlink/junction 逃逸：对最近存在祖先做 realpath 再验一次
    const realRoot = realpathSafe(root);
    const realTarget = realpathSafe(nearestExisting(resolved));
    if (realRoot && realTarget && !pathContains(realRoot, realTarget)) {
      throw new FsError(`fs.${op}：路径经符号链接越出工作区 root: ${input}`);
    }
    return resolved;
  }

  // ---------- 操作 ----------

  /** 列目录：目录在前、文件在后，各自按名（大小写不敏感）升序。 */
  list(dir: string): FsEntry[] {
    const abs = this.resolveInside(dir, 'list');
    let dirents;
    try {
      dirents = readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      throw mapFsError(err, 'list');
    }
    const out: FsEntry[] = [];
    for (const d of dirents) {
      let st;
      try {
        // 不追符号链接（lstat 语义）：断链/环也能稳定列出
        st = statSync(path.join(abs, d.name), { throwIfNoEntry: false });
      } catch {
        st = undefined;
      }
      const isDir = d.isDirectory() || (d.isSymbolicLink() && st?.isDirectory()) ;
      out.push({
        name: d.name,
        kind: isDir ? 'dir' : 'file',
        size: isDir ? 0 : (st?.size ?? 0),
        mtime: (st?.mtime ?? new Date(0)).toISOString(),
      });
    }
    return out.sort(compareEntries);
  }

  mkdir(dir: string): { path: string } {
    const abs = this.resolveInside(dir, 'mkdir');
    try {
      mkdirSync(abs, { recursive: true });
    } catch (err) {
      throw mapFsError(err, 'mkdir');
    }
    return { path: abs };
  }

  /** 重命名/移动（限 root 内）；目标已存在 → -32602（不做静默覆盖）。 */
  rename(from: string, to: string): { path: string } {
    const src = this.resolveInside(from, 'rename');
    const dst = this.resolveInside(to, 'rename');
    if (src === dst) throw new FsError('fs.rename：源与目标相同');
    if (existsSync(dst)) throw new FsError(`fs.rename：目标已存在: ${to}`);
    if (!isValidName(path.basename(dst))) {
      throw new FsError(`fs.rename：非法目标名: ${path.basename(dst)}`);
    }
    try {
      renameSync(src, dst);
    } catch (err) {
      throw mapFsError(err, 'rename');
    }
    return { path: dst };
  }

  /** 删除文件或目录（目录递归）。前端负责"输入文件名确认"，bridge 直接执行。 */
  remove(target: string): { removed: string } {
    const abs = this.resolveInside(target, 'remove');
    if (this.root && fold(abs) === fold(this.root)) {
      throw new FsError('fs.remove：不能删除工作区 root 本身');
    }
    try {
      const st = statSync(abs, { throwIfNoEntry: false });
      if (!st) throw new FsError(`fs.remove：不存在: ${target}`);
      if (st.isDirectory()) rmSync(abs, { recursive: true, force: false });
      else unlinkSync(abs);
    } catch (err) {
      throw mapFsError(err, 'remove');
    }
    return { removed: abs };
  }

  /**
   * 新建文件（wx 排他：已存在 → -32602，绝不覆盖既有数据）。
   * 目前唯一调用方是 sidebar"新建 notebook"（marimo 头模板）。
   */
  writeFile(target: string, content: string): { path: string } {
    const abs = this.resolveInside(target, 'writeFile');
    if (typeof content !== 'string') throw new FsError('fs.writeFile：content 必须是 string');
    try {
      writeFileSync(abs, content, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      throw mapFsError(err, 'writeFile');
    }
    return { path: abs };
  }
}

/** 目录在前、文件在后；同类按名大小写不敏感升序（jupyterlab DirListing 排序语义）。 */
export function compareEntries(a: FsEntry, b: FsEntry): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
  const la = a.name.toLowerCase();
  const lb = b.name.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return 0;
}
