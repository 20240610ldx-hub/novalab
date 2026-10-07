/**
 * store/notebooks 单测（P3.1 多 tab 多内核，intent S1 / A-2 #18）：
 * - 切换缓存/恢复（tab 切走捕获切片、切回即时恢复）；
 * - 未保存确认 predicate（hasUnsavedChanges + dirty 标记联动）；
 * - 只读 tab 护栏矩阵（ended tab → capabilityMatrix 全禁 + 写路径 no-op）；
 * - notebook.list 归一化（坏条目丢弃、ended 派生、dirty 保留）与 tabLabel。
 *
 * 纯 node 环境：mock bridge 客户端，直接驱动 store（不起 WS/内核）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cell } from '../kernel/types';
import {
  emptyCache,
  hasUnsavedChanges,
  normalizeTabs,
  tabLabel,
  useNotebooks,
  type NotebookCache,
  type NotebookTab,
} from './notebooks';
import { useNotebook } from './notebook';
import { capabilityMatrix, useSession } from './session';

const { handlers, rpcMock } = vi.hoisted(() => ({
  handlers: [] as ((method: string, params: unknown) => void)[],
  rpcMock: vi.fn(async (_method: string, _params?: unknown) => ({})),
}));
vi.mock('../bridge/client', () => ({
  bridge: {
    connect: vi.fn(async () => {}),
    onNotification: (h: (method: string, params: unknown) => void) => {
      handlers.push(h);
      return () => {};
    },
    rpc: (m: string, p?: unknown) => rpcMock(m, p),
  },
}));

function mkCell(id: string, code = `# ${id}`): Cell {
  return {
    id,
    code,
    execCount: null,
    status: 'idle',
    defs: [],
    refs: [],
    sideEffect: false,
    kind: 'code',
    output: null,
  };
}

function mkTab(id: string, p: string, over: Partial<NotebookTab> = {}): NotebookTab {
  return {
    notebookId: id,
    path: p,
    kernelState: 'idle',
    cellCount: 1,
    ended: false,
    rssMB: null,
    dirty: false,
    ...over,
  };
}

function cacheWith(cells: Cell[]): NotebookCache {
  return { ...emptyCache(), cells, activeCellId: cells[0]?.id ?? null };
}

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({});
  handlers.length = 0;
  useNotebooks.setState({ tabs: [], activeId: null, caches: {} });
  useNotebook.setState({
    cells: [],
    dagEdges: [],
    staleSet: [],
    schemas: [],
    diffs: [],
    diffMarks: {},
    compileErrors: {},
    uiCollapsed: {},
    lastRunMs: {},
    activeCellId: null,
    notebookPath: null,
    kernelState: 'connecting',
  });
  useSession.setState({ readOnly: false, viewingId: null, viewingEndedAt: null, historyTotal: 0 });
});

describe('notebooks · 切换缓存/恢复', () => {
  it('切走捕获焦点切片入旧 tab 缓存，切回从缓存即时恢复', async () => {
    const tabA = mkTab('nb-a', '/w/a.py');
    const tabB = mkTab('nb-b', '/w/b.py');
    useNotebooks.setState({ tabs: [tabA, tabB], activeId: 'nb-a', caches: {} });
    // 焦点视图当前显示 A 的 cells
    useNotebook.setState({ cells: [mkCell('a', 'x = 1')], notebookPath: '/w/a.py', activeCellId: 'a' });
    // B 的缓存预置（模拟此前打开过 B）
    useNotebooks.getState().saveCache('nb-b', cacheWith([mkCell('b', 'y = 2')]));

    // A → B
    await useNotebook.getState().switchTab('nb-b');
    expect(useNotebooks.getState().activeId).toBe('nb-b');
    expect(useNotebook.getState().notebookPath).toBe('/w/b.py');
    expect(useNotebook.getState().cells.map((c) => c.id)).toEqual(['b']); // 从缓存恢复
    // 旧 tab A 的切片已被捕获入缓存
    expect(useNotebooks.getState().readCache('nb-a')?.cells.map((c) => c.id)).toEqual(['a']);
    expect(useNotebooks.getState().readCache('nb-a')?.cells[0]!.code).toBe('x = 1');

    // B → A：切回状态即在
    await useNotebook.getState().switchTab('nb-a');
    expect(useNotebooks.getState().activeId).toBe('nb-a');
    expect(useNotebook.getState().notebookPath).toBe('/w/a.py');
    expect(useNotebook.getState().cells.map((c) => c.id)).toEqual(['a']);
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 1');
  });

  it('切到同一 tab 为 no-op（不重复捕获/网络）', async () => {
    useNotebooks.setState({ tabs: [mkTab('nb-a', '/a.py')], activeId: 'nb-a', caches: {} });
    await useNotebook.getState().switchTab('nb-a');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('无本地缓存时用 bridge switch 返回的 state 兜底恢复', async () => {
    useNotebooks.setState({ tabs: [mkTab('nb-a', '/a.py'), mkTab('nb-b', '/b.py')], activeId: 'nb-a', caches: {} });
    useNotebook.setState({ cells: [mkCell('a')], notebookPath: '/a.py' });
    rpcMock.mockImplementation(async (m: string) =>
      m === 'notebook.switch'
        ? { notebookId: 'nb-b', state: { cells: [{ id: 'z', code: 'z = 9' }], dagEdges: [], schemas: [], staleSet: [], execCounts: {} } }
        : {},
    );
    await useNotebook.getState().switchTab('nb-b');
    expect(useNotebook.getState().cells.map((c) => c.id)).toEqual(['z']);
    // 兜底恢复后也写入缓存
    expect(useNotebooks.getState().readCache('nb-b')?.cells.map((c) => c.id)).toEqual(['z']);
  });

  it('关闭焦点 tab → 焦点转移到剩余 tab 并恢复其缓存', async () => {
    useNotebooks.setState({ tabs: [mkTab('nb-a', '/a.py'), mkTab('nb-b', '/b.py')], activeId: 'nb-a', caches: {} });
    useNotebook.setState({ cells: [mkCell('a')], notebookPath: '/a.py' });
    useNotebooks.getState().saveCache('nb-b', cacheWith([mkCell('b')]));
    // close 后 refreshList 返回仅剩 B
    rpcMock.mockImplementation(async (m: string) =>
      m === 'notebook.list'
        ? [{ notebookId: 'nb-b', path: '/b.py', kernelState: 'idle', cellCount: 1, rssMB: null }]
        : {},
    );
    await useNotebook.getState().closeTab('nb-a');
    expect(useNotebooks.getState().tabs.map((t) => t.notebookId)).toEqual(['nb-b']);
    expect(useNotebooks.getState().activeId).toBe('nb-b');
    expect(useNotebook.getState().cells.map((c) => c.id)).toEqual(['b']);
    expect(useNotebooks.getState().readCache('nb-a')).toBeUndefined(); // 缓存随 tab 摘除
  });
});

describe('notebooks · 未保存确认 predicate', () => {
  it('hasUnsavedChanges：dirty 且非 ended → true；否则 false', () => {
    expect(hasUnsavedChanges({ dirty: true, ended: false })).toBe(true);
    expect(hasUnsavedChanges({ dirty: false, ended: false })).toBe(false);
    expect(hasUnsavedChanges({ dirty: true, ended: true })).toBe(false); // 只读快照无"未保存"
    expect(hasUnsavedChanges({ dirty: false, ended: true })).toBe(false);
  });

  it('setCellCode 标脏当前 tab；saveCell 落盘后清脏', async () => {
    useNotebooks.setState({ tabs: [mkTab('nb-a', '/a.py')], activeId: 'nb-a', caches: {} });
    useNotebook.setState({ cells: [mkCell('a', 'x = 1')], notebookPath: '/a.py' });
    expect(hasUnsavedChanges(useNotebooks.getState().activeTab()!)).toBe(false);

    useNotebook.getState().setCellCode('a', 'x = 2');
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(true);
    expect(hasUnsavedChanges(useNotebooks.getState().activeTab()!)).toBe(true);

    rpcMock.mockResolvedValue({ dagEdges: [], staleSet: [] });
    await useNotebook.getState().saveCell('a', 'x = 2');
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(false);
    expect(hasUnsavedChanges(useNotebooks.getState().activeTab()!)).toBe(false);
  });
});

describe('notebooks · 只读 tab 护栏矩阵（ended = view-only）', () => {
  it('capabilityMatrix(true)：编辑器/运行/REPL/diff/restart 全禁 + viewOnly', () => {
    const m = capabilityMatrix(true);
    expect(m).toEqual({
      editorReadOnly: true,
      runDisabled: true,
      replDisabled: true,
      diffDisabled: true,
      restartDisabled: true,
      viewOnly: true,
    });
  });

  it('ended tab：写路径 action 全部 no-op（复用只读护栏语义）', async () => {
    useNotebooks.setState({ tabs: [mkTab('nb-a', '/a.py', { ended: true, kernelState: 'dead' })], activeId: 'nb-a', caches: {} });
    useNotebook.setState({ cells: [mkCell('a', 'x = 1')], notebookPath: '/a.py', activeCellId: 'a' });

    useNotebook.getState().setCellCode('a', 'zzz');
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 1'); // 未改

    await useNotebook.getState().runCell('a');
    expect(useNotebook.getState().cells[0]!.status).toBe('idle'); // 未 running/error

    await useNotebook.getState().runRepl('1+1');
    expect(useNotebook.getState().cells.some((c) => c.id === 'repl')).toBe(false);

    await useNotebook.getState().restartKernel();
    expect(rpcMock).not.toHaveBeenCalled(); // 未触碰 bridge（内核已死）
  });

  it('live tab：写路径放行（runCell 到达 bridge）', async () => {
    useNotebooks.setState({ tabs: [mkTab('nb-a', '/a.py', { ended: false })], activeId: 'nb-a', caches: {} });
    useNotebook.setState({ cells: [mkCell('a', 'x = 1')], notebookPath: '/a.py', activeCellId: 'a' });
    rpcMock.mockRejectedValue(new Error('bridge 未连接'));
    await useNotebook.getState().runCell('a');
    expect(rpcMock).toHaveBeenCalled();
    expect(useNotebook.getState().cells[0]!.status).toBe('error'); // 到达 bridge 后失败置 error
  });
});

describe('notebooks · 纯函数', () => {
  it('tabLabel = 路径末段文件名（兼容 / 与 \\）', () => {
    expect(tabLabel('/w/dir/demo.py')).toBe('demo.py');
    expect(tabLabel('D:\\nb\\demo.py')).toBe('demo.py');
    expect(tabLabel('demo.py')).toBe('demo.py');
  });

  it('normalizeTabs：坏条目丢弃、kernelState dead → ended、保留本地 dirty', () => {
    const prev = [mkTab('nb-a', '/a.py', { dirty: true })];
    const tabs = normalizeTabs(
      [
        { notebookId: 'nb-a', path: '/a.py', kernelState: 'idle', cellCount: 3, rssMB: 12 },
        { notebookId: 'nb-b', path: '/b.py', kernelState: 'dead', cellCount: 1, rssMB: null },
        { path: '/no-id.py' }, // 缺 notebookId → 丢弃
        null,
        { notebookId: 'nb-c', path: '/c.py' }, // kernelState 缺省 → idle
      ],
      prev,
    );
    expect(tabs.map((t) => t.notebookId)).toEqual(['nb-a', 'nb-b', 'nb-c']);
    expect(tabs[0]!.dirty).toBe(true); // 沿用旧 dirty
    expect(tabs[0]!.rssMB).toBe(12);
    expect(tabs[1]!.ended).toBe(true); // dead → ended
    expect(tabs[2]!.kernelState).toBe('idle');
    expect(tabs[2]!.dirty).toBe(false);
    expect(normalizeTabs('nope', [])).toEqual([]);
  });

  it('refreshList：activeId 失效时回退首个 tab', async () => {
    useNotebooks.setState({ tabs: [mkTab('gone', '/gone.py')], activeId: 'gone', caches: {} });
    rpcMock.mockImplementation(async (m: string) =>
      m === 'notebook.list'
        ? [{ notebookId: 'nb-x', path: '/x.py', kernelState: 'idle', cellCount: 0, rssMB: null }]
        : {},
    );
    await useNotebooks.getState().refreshList();
    expect(useNotebooks.getState().activeId).toBe('nb-x');
    expect(useNotebooks.getState().tabs.map((t) => t.notebookId)).toEqual(['nb-x']);
  });
});
