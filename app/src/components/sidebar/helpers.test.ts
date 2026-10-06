/**
 * sidebar 纯逻辑助手单测（P2.8）：排序 / notebook 判定 / 路径拼接 /
 * marimo 头模板 / 重命名选区 / 最近打开（注入内存 storage）。
 */

import { describe, expect, it } from 'vitest';
import {
  RECENT_KEY,
  baseName,
  dirName,
  ensurePySuffix,
  humanSize,
  isNotebookFile,
  joinFsPath,
  loadRecent,
  newCellId,
  notebookTemplate,
  parentRel,
  pushRecent,
  renameSelection,
  saveRecent,
  sortEntries,
  validName,
  type FsEntry,
  type KvStorage,
  type RecentEntry,
} from './helpers';

function entry(name: string, kind: 'dir' | 'file'): FsEntry {
  return { name, kind, size: 0, mtime: '' };
}

function memStorage(): KvStorage & { dump: Record<string, string> } {
  const dump: Record<string, string> = {};
  return {
    dump,
    getItem: (k) => dump[k] ?? null,
    setItem: (k, v) => {
      dump[k] = v;
    },
  };
}

describe('sortEntries（jupyterlab DirListing 排序语义）', () => {
  it('目录在前、文件在后；同类大小写不敏感升序；不改原数组', () => {
    const input = [entry('z.py', 'file'), entry('B', 'dir'), entry('a.py', 'file'), entry('A', 'dir')];
    const sorted = sortEntries(input);
    expect(sorted.map((e) => e.name)).toEqual(['A', 'B', 'a.py', 'z.py']);
    expect(input.map((e) => e.name)).toEqual(['z.py', 'B', 'a.py', 'A']); // 原数组不动
  });
});

describe('notebook 判定与路径', () => {
  it('isNotebookFile：.py（含大写）为 notebook，其余不是', () => {
    expect(isNotebookFile('demo.py')).toBe(true);
    expect(isNotebookFile('DEMO.PY')).toBe(true);
    expect(isNotebookFile('data.csv')).toBe(false);
    expect(isNotebookFile('py')).toBe(false);
  });

  it('joinFsPath：rel 恒 / 分隔，输出跟随 root 的平台分隔符', () => {
    expect(joinFsPath('D:\\ws', 'sub/a.py')).toBe('D:\\ws\\sub\\a.py');
    expect(joinFsPath('D:\\ws\\', 'a.py')).toBe('D:\\ws\\a.py'); // 尾分隔符不重复
    expect(joinFsPath('/home/ws', 'sub/a.py')).toBe('/home/ws/sub/a.py');
    expect(joinFsPath('/home/ws', '')).toBe('/home/ws');
  });

  it('parentRel / baseName / dirName', () => {
    expect(parentRel('a/b/c.py')).toBe('a/b');
    expect(parentRel('c.py')).toBe('');
    expect(baseName('D:\\ws\\a.py')).toBe('a.py');
    expect(baseName('/ws/a.py')).toBe('a.py');
    expect(dirName('D:\\ws\\a.py')).toBe('D:\\ws');
    expect(dirName('a.py')).toBe('');
  });

  it('ensurePySuffix / validName', () => {
    expect(ensurePySuffix('nb')).toBe('nb.py');
    expect(ensurePySuffix('nb.PY')).toBe('nb.PY');
    expect(validName('a-b_c.py')).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'a\0b']) {
      expect(validName(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('humanSize', () => {
    expect(humanSize(512)).toBe('512 B');
    expect(humanSize(2048)).toBe('2.0 KB');
    expect(humanSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('marimo 头模板（与 py/novakernel.serialize 兼容）', () => {
  it('newCellId：8 位十六进制', () => {
    expect(newCellId()).toMatch(/^[0-9a-f]{8}$/);
    expect(newCellId(() => 0.9999)).toBe('ffffffff');
  });

  it('notebookTemplate：PEP723 头 + 可解析 cell marker', () => {
    const text = notebookTemplate('a1b2c3d4');
    const lines = text.split('\n');
    expect(lines.slice(0, 4)).toEqual([
      '# /// script',
      '# requires-python = ">=3.11"',
      '# dependencies = []',
      '# ///',
    ]);
    expect(text).toContain('# %% [cell-id: a1b2c3d4]');
    expect(text).toMatch(/^# %% \[cell-id: [0-9a-f]{8}\]$/m);
  });
});

describe('renameSelection（jupyterlab _doRename：文件选中主名）', () => {
  it('.py 选中扩展名前；非 .py/点开头全选', () => {
    expect(renameSelection('demo.py')).toEqual({ start: 0, end: 4 });
    expect(renameSelection('README')).toEqual({ start: 0, end: 6 });
    expect(renameSelection('.gitignore')).toEqual({ start: 0, end: 10 });
    expect(renameSelection('data.tar.gz')).toEqual({ start: 0, end: 11 }); // 非 notebook → 全选
    expect(renameSelection('.py')).toEqual({ start: 0, end: 3 }); // 点开头不切分
  });
});

describe('最近打开（localStorage）', () => {
  const e = (p: string, at = '2026-10-06T08:00:00.000Z'): RecentEntry => ({ path: p, openedAt: at });

  it('空/损坏 storage → []', () => {
    const s = memStorage();
    expect(loadRecent(s)).toEqual([]);
    s.setItem(RECENT_KEY, '{broken');
    expect(loadRecent(s)).toEqual([]);
    s.setItem(RECENT_KEY, '[{"nope":1},"x"]');
    expect(loadRecent(s)).toEqual([]); // 坏条目全部丢弃
  });

  it('pushRecent：新条目置顶、按 path 去重、封顶 8', () => {
    let list = pushRecent([], e('a'));
    list = pushRecent(list, e('b'));
    list = pushRecent(list, e('a', 'later'));
    expect(list.map((r) => r.path)).toEqual(['a', 'b']);
    expect(list[0]!.openedAt).toBe('later');
    for (let i = 0; i < 10; i++) list = pushRecent(list, e(`p${i}`));
    expect(list).toHaveLength(8);
    expect(list[0]!.path).toBe('p9');
  });

  it('saveRecent → loadRecent 往返', () => {
    const s = memStorage();
    const list = [e('x.py'), e('y.py')];
    saveRecent(s, list);
    expect(loadRecent(s)).toEqual(list);
  });
});
