import { describe, expect, it } from 'vitest';
import { mcpAddCommand, nextUntitledName, recentItems, relativeTime, splitPath } from './logic';

describe('splitPath', () => {
  it('Windows 与 POSIX 路径', () => {
    expect(splitPath('D:\\data\\pop\\forecast.py')).toEqual({ name: 'forecast.py', dir: 'D:\\data\\pop' });
    expect(splitPath('/home/u/a.py')).toEqual({ name: 'a.py', dir: '/home/u' });
    expect(splitPath('a.py')).toEqual({ name: 'a.py', dir: '' });
    expect(splitPath('/home/u/dir/')).toEqual({ name: 'dir', dir: '/home/u' });
  });
});

describe('recentItems', () => {
  it('时间倒序、去重、截断', () => {
    const list = [
      { path: '/a.py', openedAt: '2026-10-01T00:00:00Z' },
      { path: '/b.py', openedAt: '2026-10-03T00:00:00Z' },
      { path: '/a.py', openedAt: '2026-10-02T00:00:00Z' },
      { path: '/c.py', openedAt: '2026-09-01T00:00:00Z' },
    ];
    expect(recentItems(list, 2).map((e) => e.path)).toEqual(['/b.py', '/a.py']);
    expect(recentItems(list).map((e) => e.path)).toEqual(['/b.py', '/a.py', '/c.py']);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  it('分级与语言', () => {
    expect(relativeTime('2026-10-10T11:59:30Z', now, 'en')).toBe('just now');
    expect(relativeTime('2026-10-10T11:50:00Z', now, 'en')).toBe('10m ago');
    expect(relativeTime('2026-10-10T09:00:00Z', now, 'zh')).toBe('3 小时前');
    expect(relativeTime('2026-10-08T12:00:00Z', now, 'en')).toBe('2d ago');
    expect(relativeTime('2026-08-01T12:00:00Z', now, 'en')).toBe('2026-08-01');
    expect(relativeTime('garbage', now, 'en')).toBe('');
  });
});

describe('nextUntitledName', () => {
  it('避开已存在名称（大小写不敏感）', () => {
    expect(nextUntitledName([])).toBe('untitled.py');
    expect(nextUntitledName(['Untitled.py'])).toBe('untitled-1.py');
    expect(nextUntitledName(['untitled.py', 'untitled-1.py'])).toBe('untitled-2.py');
  });
});

describe('mcpAddCommand', () => {
  it('含空格路径加引号；无 notebook 时不带位置参数', () => {
    const dev = ['pnpm', '--dir', 'D:/Notebook Agent/bridge', 'exec', 'tsx', 'src/main.ts'];
    expect(mcpAddCommand(dev, 'D:/data/a.py')).toBe(
      'claude mcp add novalab -- pnpm --dir "D:/Notebook Agent/bridge" exec tsx src/main.ts --mcp D:/data/a.py',
    );
    expect(mcpAddCommand(['C:/Program Files/NovaLab/node.exe', 'C:/Program Files/NovaLab/bridge-dist/bridge.mjs'], null)).toBe(
      'claude mcp add novalab -- "C:/Program Files/NovaLab/node.exe" "C:/Program Files/NovaLab/bridge-dist/bridge.mjs" --mcp',
    );
  });
});
