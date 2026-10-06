/**
 * FsManager 单测（P2.8）：root 监狱（词法 + 符号链接）、基本操作、错误码。
 * 越界 fuzz：.. 链、绝对路径、NUL、junction/symlink 逃逸（Windows 无权限时跳过 symlink 用例）。
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsError, FsManager, compareEntries, isValidName } from './fs';
import { ERR_INVALID_PARAMS } from './protocol';

function makeRoot(): { root: string; fs: FsManager } {
  const base = mkdtempSync(path.join(tmpdir(), 'novalab-fs-'));
  const root = path.join(base, 'ws');
  mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true });
  mkdirSync(path.join(base, 'outside'), { recursive: true });
  writeFileSync(path.join(root, 'a.py'), 'x = 1\n', 'utf8');
  writeFileSync(path.join(root, 'notes.txt'), 'hello', 'utf8');
  writeFileSync(path.join(root, 'sub', 'b.py'), 'y = 2\n', 'utf8');
  writeFileSync(path.join(base, 'outside', 'secret.env'), 'TOKEN=1', 'utf8');
  const fs = new FsManager();
  fs.setRoot(root);
  return { root, fs };
}

/** 越界入参 fuzz 语料（相对 root 或绝对路径）。 */
function escapeInputs(base: string, root: string): string[] {
  return [
    '..',
    '../..',
    '../../..',
    '../outside/secret.env',
    'sub/../../..',
    'sub/../..',
    path.join(base, 'outside'),
    path.join(base, 'outside', 'secret.env'),
    root + path.sep + '..',
    tmpdir(),
    process.platform === 'win32' ? 'C:\\Windows\\system32' : '/etc/passwd',
    'a\0b',
    '..\0',
  ];
}

describe('FsManager · root 与监狱', () => {
  it('setRoot：不存在 / 非目录 → FsError -32602', () => {
    const fs = new FsManager();
    const base = mkdtempSync(path.join(tmpdir(), 'novalab-fs-root-'));
    expect(() => fs.setRoot(path.join(base, 'nope'))).toThrow(FsError);
    writeFileSync(path.join(base, 'file.txt'), '', 'utf8');
    try {
      fs.setRoot(path.join(base, 'file.txt'));
      expect.unreachable('应当抛错');
    } catch (e) {
      expect((e as FsError).code).toBe(ERR_INVALID_PARAMS);
    }
  });

  it('未设置 root 时所有操作 → FsError', () => {
    const fs = new FsManager();
    expect(() => fs.list('')).toThrow(FsError);
    expect(fs.getRoot()).toBeNull();
  });

  it('root 自身（"" 与 "."）可 list；setRootDefault 失败不抛', () => {
    const { root, fs } = makeRoot();
    expect(fs.list('').length).toBeGreaterThan(0);
    expect(fs.list('.').length).toBeGreaterThan(0);
    expect(fs.setRootDefault(path.join(root, 'missing', 'x'))).toBe(realpathSync(root));
    expect(fs.getRoot()).toBe(realpathSync(root));
  });
});

describe('FsManager · 越界 fuzz（..、绝对路径、NUL）', () => {
  it('list/mkdir/rename/remove/writeFile 全部拒绝越界路径（-32602）', () => {
    const { root, fs } = makeRoot();
    const base = path.dirname(root);
    for (const bad of escapeInputs(base, root)) {
      const ops: (() => unknown)[] = [
        () => fs.list(bad),
        () => fs.mkdir(path.join(bad, 'pwn')),
        () => fs.rename('a.py', path.join(bad, 'stolen.py')),
        () => fs.rename(path.join(bad, 'secret.env'), 'pwn.txt'),
        () => fs.remove(bad),
        () => fs.writeFile(path.join(bad, 'pwn.txt'), 'x'),
      ];
      for (const op of ops) {
        let threw = false;
        try {
          op();
        } catch (e) {
          threw = true;
          expect(e, `input=${JSON.stringify(bad)}`).toBeInstanceOf(FsError);
          expect((e as FsError).code, `input=${JSON.stringify(bad)}`).toBe(ERR_INVALID_PARAMS);
        }
        expect(threw, `未拒绝越界路径: ${JSON.stringify(bad)}`).toBe(true);
      }
    }
    // 外部文件确实未被触碰
    expect(readFileSync(path.join(base, 'outside', 'secret.env'), 'utf8')).toBe('TOKEN=1');
  });

  it('符号链接/junction 逃逸：链接名在 root 内但 realpath 越界 → -32602', () => {
    const { root, fs } = makeRoot();
    const base = path.dirname(root);
    const outside = path.join(base, 'outside');
    const link = path.join(root, 'escape');
    try {
      // Windows 目录链接用 junction（无需管理员权限）；POSIX 用普通 symlink
      if (process.platform === 'win32') symlinkSync(outside, link, 'junction');
      else symlinkSync(outside, link);
    } catch {
      console.warn('symlink 创建失败（权限），跳过该用例');
      return;
    }
    expect(() => fs.list('escape')).toThrow(FsError);
    try {
      fs.writeFile('escape/pwn.txt', 'x');
      expect.unreachable('应当抛错');
    } catch (e) {
      expect((e as FsError).code).toBe(ERR_INVALID_PARAMS);
    }
    expect(() => fs.remove('escape/secret.env')).toThrow(FsError);
    expect(existsSync(path.join(outside, 'pwn.txt'))).toBe(false);
    expect(existsSync(path.join(outside, 'secret.env'))).toBe(true);
  });
});

describe('FsManager · 基本操作', () => {
  it('list：目录在前、按名升序；kind/size/mtime 形状', () => {
    const { fs } = makeRoot();
    const entries = fs.list('');
    expect(entries.map((e) => e.name)).toEqual(['sub', 'a.py', 'notes.txt']);
    expect(entries[0]).toMatchObject({ kind: 'dir', size: 0 });
    const py = entries.find((e) => e.name === 'a.py')!;
    expect(py.kind).toBe('file');
    expect(py.size).toBe(6);
    expect(new Date(py.mtime).toISOString()).toBe(py.mtime);
  });

  it('list 子目录（懒加载数据源）', () => {
    const { fs } = makeRoot();
    expect(fs.list('sub').map((e) => e.name)).toEqual(['deep', 'b.py']);
  });

  it('mkdir → rename → remove 往返；rename 目标已存在 → -32602', () => {
    const { root, fs } = makeRoot();
    fs.mkdir('data/2026');
    expect(fs.list('data').map((e) => e.name)).toEqual(['2026']);
    fs.rename('data/2026', 'data/2027');
    expect(existsSync(path.join(root, 'data', '2027'))).toBe(true);
    // 目标已存在 → 拒绝（不静默覆盖）
    fs.mkdir('data/2028');
    try {
      fs.rename('data/2028', 'data/2027');
      expect.unreachable('应当抛错');
    } catch (e) {
      expect((e as FsError).code).toBe(ERR_INVALID_PARAMS);
    }
    fs.remove('data/2028');
    expect(existsSync(path.join(root, 'data', '2028'))).toBe(false);
    fs.remove('data/2027');
    expect(existsSync(path.join(root, 'data', '2027'))).toBe(false);
    fs.remove('data');
    expect(existsSync(path.join(root, 'data'))).toBe(false);
  });

  it('remove root 自身被拒；remove 不存在 → FsError', () => {
    const { fs } = makeRoot();
    expect(() => fs.remove('')).toThrow(FsError);
    expect(() => fs.remove('nope.txt')).toThrow(FsError);
  });

  it('writeFile：wx 排他创建；二次写同名 → -32602（不覆盖）', () => {
    const { root, fs } = makeRoot();
    const res = fs.writeFile('new.py', '# /// script\n# ///\n');
    expect(readFileSync(res.path, 'utf8')).toContain('script');
    expect(path.dirname(res.path)).toBe(realpathSync(root));
    try {
      fs.writeFile('new.py', 'overwrite');
      expect.unreachable('应当抛错');
    } catch (e) {
      expect((e as FsError).code).toBe(ERR_INVALID_PARAMS);
    }
    expect(readFileSync(path.join(root, 'new.py'), 'utf8')).toContain('script');
  });
});

describe('FsManager · helpers', () => {
  it('compareEntries：dir 先于 file，同类大小写不敏感升序', () => {
    const entries = [
      { name: 'z.py', kind: 'file', size: 0, mtime: '' },
      { name: 'B', kind: 'dir', size: 0, mtime: '' },
      { name: 'a.py', kind: 'file', size: 0, mtime: '' },
      { name: 'A', kind: 'dir', size: 0, mtime: '' },
    ] as const;
    expect([...entries].sort(compareEntries).map((e) => e.name)).toEqual(['A', 'B', 'a.py', 'z.py']);
  });

  it('isValidName：拒绝空名、路径分隔符、. 与 ..', () => {
    expect(isValidName('a.py')).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'a\0']) {
      expect(isValidName(bad), bad).toBe(false);
    }
  });
});
