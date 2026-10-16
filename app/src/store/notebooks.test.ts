/**
 * store/notebooks 单测（P3.1 多 tab 多内核，intent S1 / A-2 #18）：
 * - 切换缓存/恢复（tab 切走捕获切片、切回即时恢复）；
 * - 未保存确认 predicate（hasUnsavedChanges + dirty 标记联动）；
 * - 只读 tab 护栏矩阵（ended tab → capabilityMatrix 全禁 + 写路径 no-op）；
 * - notebook.list 归一化（坏条目丢弃、ended 派生、dirty 保留）与 tabLabel。
 *
 * 纯 node 环境：mock bridge 客户端，直接驱动 store（不起 WS/内核）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cell } from '../kernel/types';
import {
  emptyCache,
  hasUnsavedChanges,
  canRestartTab,
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
  rpcMock: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({})),
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
  vi.useFakeTimers();
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
    historyView: false,
    kernelState: 'connecting',
  });
  useSession.setState({ readOnly: false, viewingId: null, viewingEndedAt: null, historyTotal: 0 });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** Explicitly release each ACK; no network or wall-clock timing in race regressions. */
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settleQueue() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function seedA(extra: Cell[] = []) {
  useNotebooks.setState({ tabs: [mkTab('nb-a', '/a.py')], activeId: 'nb-a', caches: {} });
  useNotebook.setState({ cells: [mkCell('a', 'x = 1'), ...extra], notebookPath: '/a.py' });
}

function calls(method: string) {
  return rpcMock.mock.calls.filter(([m]) => m === method);
}

function dispatchLifecycle(save: () => Promise<unknown>, close: () => Promise<unknown> = async () => ({})) {
  rpcMock.mockImplementation(async (method) => {
    if (method === 'cell.save') return save();
    if (method === 'notebook.close') return close();
    if (method === 'notebook.list') return [];
    return {};
  });
}

function tabError() {
  return useNotebooks.getState().activeTab()?.error;
}

function flushSaves(id: string) {
  return useNotebook.getState().flushSaves(id);
}

describe('notebooks · deferred save / close reliability', () => {
  it('older same-cell ACK cannot confirm a later draft or apply its stale analysis', async () => {
    seedA();
    const ack = deferred();
    dispatchLifecycle(() => ack.promise);
    useNotebook.getState().setCellCode('a', 'x = 2');
    const save = useNotebook.getState().saveCell('a', 'x = 2');
    await settleQueue();
    useNotebook.getState().setCellCode('a', 'x = 3');
    ack.resolve({ dagEdges: [{ from: 'old', to: 'a' }], staleSet: ['a'], compileError: 'old error' });
    await save;
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(true);
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 3');
    expect(useNotebook.getState().staleSet).toEqual([]);
    expect(useNotebook.getState().compileErrors).toEqual({});
  });

  it('saving one cell never clears another unsaved cell', async () => {
    seedA([mkCell('b', 'y = 1')]);
    const ack = deferred();
    dispatchLifecycle(() => ack.promise);
    useNotebook.getState().setCellCode('a', 'x = 2');
    const save = useNotebook.getState().saveCell('a', 'x = 2');
    await settleQueue();
    useNotebook.getState().setCellCode('b', 'y = 2');
    ack.resolve({ dagEdges: [], staleSet: [] });
    await save;
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(true);
    await useNotebook.getState().saveCell('b', 'y = 2');
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(false);
  });

  it.each(['a', 'b'])('ACK belongs to A after switching to B (B cell id = %s)', async (bCellId) => {
    seedA();
    const nb = useNotebooks.getState();
    nb.setTabs([...nb.tabs, mkTab('nb-b', '/b.py')]);
    nb.saveCache('nb-b', cacheWith([mkCell(bCellId, 'y = 1')]));
    const ack = deferred();
    dispatchLifecycle(() => ack.promise);
    useNotebook.getState().setCellCode('a', 'x = 2');
    const save = useNotebook.getState().saveCell('a', 'x = 2');
    await settleQueue();
    await useNotebook.getState().switchTab('nb-b');
    useNotebook.getState().setCellCode(bCellId, 'y = 2');
    ack.resolve({ dagEdges: [{ from: 'a', to: 'a-downstream' }], staleSet: ['a'] });
    await save;
    expect(calls('cell.save')[0]![1]).toEqual({ notebookId: 'nb-a', cellId: 'a', code: 'x = 2' });
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(true);
    expect(useNotebook.getState().cells[0]!.code).toBe('y = 2');
    expect(useNotebook.getState().dagEdges).toEqual([]);
    expect(useNotebook.getState().staleSet).toEqual([]);
    expect(useNotebooks.getState().tabs.find((t) => t.notebookId === 'nb-a')!.dirty).toBe(false);
    expect(nb.readCache('nb-a')!.staleSet).toEqual(['a']);
    await useNotebook.getState().switchTab('nb-a');
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 2');
    expect(useNotebook.getState().staleSet).toEqual(['a']);
  });

  it('overlapping saves for one notebook reach RPC in FIFO order', async () => {
    seedA();
    const first = deferred();
    const second = deferred();
    let count = 0;
    dispatchLifecycle(() => ++count === 1 ? first.promise : second.promise);
    useNotebook.getState().setCellCode('a', 'x = 2');
    const one = useNotebook.getState().saveCell('a', 'x = 2');
    useNotebook.getState().setCellCode('a', 'x = 3');
    const two = useNotebook.getState().saveCell('a', 'x = 3');
    await settleQueue();
    expect(calls('cell.save')).toHaveLength(1);
    first.resolve({ dagEdges: [], staleSet: ['old'] });
    await one;
    await settleQueue();
    expect(calls('cell.save').map(([, p]) => (p as { code: string }).code)).toEqual(['x = 2', 'x = 3']);
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(true);
    second.resolve({ dagEdges: [], staleSet: [] });
    await two;
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(false);
  });

  it('autosave debounce captures notebook identity across tab switch', async () => {
    seedA();
    const nb = useNotebooks.getState();
    nb.setTabs([...nb.tabs, mkTab('nb-b', '/b.py')]);
    nb.saveCache('nb-b', cacheWith([mkCell('a', 'y = 1')]));
    useNotebook.getState().setCellCode('a', 'x = 2');
    await useNotebook.getState().switchTab('nb-b');
    useNotebook.getState().setCellCode('a', 'y = 2');
    await vi.advanceTimersByTimeAsync(300);
    expect(calls('cell.save').map(([, p]) => p)).toEqual([
      { notebookId: 'nb-a', cellId: 'a', code: 'x = 2' },
      { notebookId: 'nb-b', cellId: 'a', code: 'y = 2' },
    ]);
    expect(useNotebook.getState().cells[0]!.code).toBe('y = 2');
  });

  it('close flushes latest drafts after queued save, blocks edits, and cancels timer revival', async () => {
    seedA();
    const first = deferred();
    const latest = deferred();
    const closeAck = deferred();
    let count = 0;
    dispatchLifecycle(() => ++count === 1 ? first.promise : latest.promise, () => closeAck.promise);
    useNotebook.getState().setCellCode('a', 'x = 2');
    const save = useNotebook.getState().saveCell('a', 'x = 2');
    await settleQueue();
    useNotebook.getState().setCellCode('a', 'x = 3');
    const close = useNotebook.getState().closeTab('nb-a');
    await settleQueue();
    expect(calls('notebook.close')).toHaveLength(0);
    useNotebook.getState().setCellCode('a', 'x = 4');
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 3');
    first.resolve({ dagEdges: [], staleSet: [] });
    await save;
    await settleQueue();
    expect(calls('cell.save').map(([, p]) => (p as { code: string }).code)).toEqual(['x = 2', 'x = 3']);
    expect(calls('notebook.close')).toHaveLength(0);
    latest.resolve({ dagEdges: [], staleSet: [] });
    await settleQueue();
    expect(calls('notebook.close')).toHaveLength(1);
    closeAck.resolve({});
    await close;
    expect(useNotebooks.getState().tabs).toEqual([]);
    expect(useNotebook.getState().cells).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls('cell.save')).toHaveLength(2);
    expect(useNotebooks.getState().readCache('nb-a')).toBeUndefined();
  });

  it('save failure remains dirty with error and can retry latest draft', async () => {
    seedA();
    const failed = deferred();
    dispatchLifecycle(() => failed.promise);
    useNotebook.getState().setCellCode('a', 'x = 2');
    const save = useNotebook.getState().saveCell('a', 'x = 2');
    await settleQueue();
    failed.reject(new Error('disk full'));
    await save;
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(true);
    expect(useNotebooks.getState().readCache('nb-a')!.cells[0]!.code).toBe('x = 2');
    expect(tabError()).toMatchObject({ operation: 'save', message: 'disk full' });
    dispatchLifecycle(async () => ({ dagEdges: [], staleSet: [] }));
    const retry = flushSaves('nb-a');
    expect(retry).toBeInstanceOf(Promise);
    await retry;
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(false);
    expect(tabError()).toBeUndefined();
  });

  it('close save failure preserves tab/cache/draft and retry saves before closing', async () => {
    seedA();
    const failed = deferred();
    dispatchLifecycle(() => failed.promise);
    useNotebook.getState().setCellCode('a', 'x = 2');
    const close = useNotebook.getState().closeTab('nb-a');
    await settleQueue();
    expect(calls('notebook.close')).toHaveLength(0);
    failed.reject(new Error('write denied'));
    await close;
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(true);
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 2');
    expect(useNotebooks.getState().readCache('nb-a')!.cells[0]!.code).toBe('x = 2');
    expect(tabError()).toMatchObject({ operation: 'close', message: 'write denied' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls('cell.save')).toHaveLength(1);
    dispatchLifecycle(async () => ({ dagEdges: [], staleSet: [] }));
    await useNotebook.getState().closeTab('nb-a');
    expect(calls('notebook.close')).toHaveLength(1);
    expect(useNotebooks.getState().tabs).toEqual([]);
  });

  it('notebook.close RPC failure preserves cache/focus and exposes retryable error', async () => {
    seedA();
    useNotebooks.getState().saveCache('nb-a', cacheWith(useNotebook.getState().cells));
    const failed = deferred();
    dispatchLifecycle(async () => ({}), () => failed.promise);
    const close = useNotebook.getState().closeTab('nb-a');
    await settleQueue();
    failed.reject(new Error('shutdown write failed'));
    await close;
    expect(useNotebooks.getState().activeId).toBe('nb-a');
    expect(useNotebooks.getState().tabs).toHaveLength(1);
    expect(useNotebooks.getState().readCache('nb-a')!.cells[0]!.code).toBe('x = 1');
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 1');
    expect(tabError()).toMatchObject({ operation: 'close', message: 'shutdown write failed' });
    dispatchLifecycle(async () => ({}));
    await useNotebook.getState().closeTab('nb-a');
    expect(useNotebooks.getState().tabs).toEqual([]);
  });

  it('opening B preserves the latest A draft for closing A in the background', async () => {
    seedA();
    const ack = deferred();
    let saveCount = 0;
    rpcMock.mockImplementation(async (method) => {
      if (method === 'cell.save') return ++saveCount === 1 ? ack.promise : { dagEdges: [], staleSet: [] };
      if (method === 'notebook.open') return { notebookId: 'nb-b', state: { cells: [{ id: 'a', code: 'y = 1' }] } };
      if (method === 'notebook.list') return [mkTab('nb-a', '/a.py'), mkTab('nb-b', '/b.py')];
      return {};
    });
    useNotebook.getState().setCellCode('a', 'x = 2');
    const save = useNotebook.getState().saveCell('a', 'x = 2');
    await settleQueue();
    useNotebook.getState().setCellCode('a', 'x = 3');
    ack.resolve({ dagEdges: [], staleSet: [] });
    await save;
    await useNotebook.getState().openNotebook('/b.py');
    expect(useNotebooks.getState().readCache('nb-a')!.cells[0]!.code).toBe('x = 3');
    expect(useNotebook.getState().cells[0]!.code).toBe('y = 1');
    rpcMock.mockImplementation(async (method) => method === 'notebook.list' ? [mkTab('nb-b', '/b.py')] : {});
    await useNotebook.getState().closeTab('nb-a');
    expect(calls('cell.save').map(([, p]) => p)).toEqual([
      { notebookId: 'nb-a', cellId: 'a', code: 'x = 2' },
      { notebookId: 'nb-a', cellId: 'a', code: 'x = 3' },
    ]);
    expect(useNotebook.getState().cells[0]!.code).toBe('y = 1');
  });

  it('focus switch while close RPC is pending keeps the new focus view', async () => {
    seedA();
    const nb = useNotebooks.getState();
    nb.setTabs([...nb.tabs, mkTab('nb-b', '/b.py')]);
    nb.saveCache('nb-b', cacheWith([mkCell('b', 'y = 1')]));
    const ack = deferred();
    rpcMock.mockImplementation(async (method) => {
      if (method === 'notebook.close') return ack.promise;
      if (method === 'notebook.list') return [mkTab('nb-b', '/b.py')];
      return {};
    });
    const close = useNotebook.getState().closeTab('nb-a');
    await settleQueue();
    await useNotebook.getState().switchTab('nb-b');
    useNotebook.getState().setCellCode('b', 'y = 2');
    ack.resolve({});
    await close;
    expect(useNotebook.getState().cells[0]!.code).toBe('y = 2');
    expect(useNotebook.getState().notebookPath).toBe('/b.py');
    expect(useNotebooks.getState().activeId).toBe('nb-b');
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(true);
  });

  it('queued saves do not serialize independent notebooks', async () => {
    seedA();
    const nb = useNotebooks.getState();
    nb.setTabs([...nb.tabs, mkTab('nb-b', '/b.py')]);
    nb.saveCache('nb-b', cacheWith([mkCell('b', 'y = 1')]));
    const ack = deferred();
    rpcMock.mockImplementation(async (method, params) => method === 'cell.save' &&
      (params as { notebookId: string }).notebookId === 'nb-a' ? ack.promise : {});
    useNotebook.getState().setCellCode('a', 'x = 2');
    const save = useNotebook.getState().saveCell('a', 'x = 2');
    await settleQueue();
    await useNotebook.getState().switchTab('nb-b');
    useNotebook.getState().setCellCode('b', 'y = 2');
    await useNotebook.getState().saveCell('b', 'y = 2');
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(false);
    ack.resolve({});
    await save;
  });

  it('live autosave ACK updates its cache while history projection stays visible', async () => {
    seedA();
    const ack = deferred();
    rpcMock.mockImplementation(async (method) => {
      if (method === 'cell.save') return ack.promise;
      if (method === 'session.open') return {
        sessionId: 'past', endedAt: '2026-01-01', cells: [{ id: 'a', code: 'x = 0' }],
      };
      return {};
    });
    useNotebook.getState().setCellCode('a', 'x = 2');
    const save = useNotebook.getState().saveCell('a', 'x = 2');
    await settleQueue();
    await useSession.getState().openHistory('past');
    expect(useNotebook.getState().historyView).toBe(true);
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 0');
    ack.resolve({ dagEdges: [{ from: 'a', to: 'downstream' }], staleSet: ['a'] });
    await save;
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 0');
    expect(useNotebook.getState().historyView).toBe(true);
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(false);
    expect(useNotebooks.getState().readCache('nb-a')!.cells[0]!.code).toBe('x = 2');
    await useSession.getState().backToLive();
    expect(useNotebook.getState().historyView).toBe(false);
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 2');
    expect(useNotebook.getState().staleSet).toEqual(['a']);
  });

  it('leaving a history projection via tab switch does not restore the previous notebook backup', async () => {
    seedA();
    const nb = useNotebooks.getState();
    nb.setTabs([...nb.tabs, mkTab('nb-b', '/b.py')]);
    nb.saveCache('nb-b', cacheWith([mkCell('b', 'y = 1')]));
    rpcMock.mockImplementation(async (method) => method === 'session.open' ? {
      sessionId: 'past', endedAt: '2026-01-01', cells: [{ id: 'a', code: 'x = 0' }],
    } : {});
    await useSession.getState().openHistory('past');
    await useNotebook.getState().switchTab('nb-b');
    expect(useNotebook.getState().historyView).toBe(false);
    await useSession.getState().backToLive();
    expect(useNotebook.getState().cells[0]!.code).toBe('y = 1');
    expect(nb.readCache('nb-a')!.cells[0]!.code).toBe('x = 1');
  });

  it('older notebook.state cannot overwrite a pending local draft', () => {
    seedA();
    useNotebook.getState().setCellCode('a', 'x = 2');
    useNotebook.getState().applyNotebookState({
      cells: [{ id: 'a', code: 'x = 1' }],
      dagEdges: [{ from: 'old', to: 'a' }], staleSet: ['a'],
    });
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 2');
    expect(useNotebook.getState().dagEdges).toEqual([]);
    expect(useNotebook.getState().staleSet).toEqual([]);
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(true);
  });

  it('close flushes every unsaved cell before notebook.close', async () => {
    seedA([mkCell('b', 'y = 1')]);
    dispatchLifecycle(async () => ({ dagEdges: [], staleSet: [] }));
    useNotebook.getState().setCellCode('a', 'x = 2');
    useNotebook.getState().setCellCode('b', 'y = 2');
    await useNotebook.getState().closeTab('nb-a');
    expect(rpcMock.mock.calls.map(([method]) => method)).toEqual(['cell.save', 'cell.save', 'notebook.close', 'notebook.list']);
    expect(calls('cell.save').map(([, p]) => p)).toEqual([
      { notebookId: 'nb-a', cellId: 'a', code: 'x = 2' },
      { notebookId: 'nb-a', cellId: 'b', code: 'y = 2' },
    ]);
  });

  it('multi-cell flush keeps each confirmed cell compile error until its own next save', async () => {
    seedA([mkCell('b', 'y = 1')]);
    rpcMock.mockImplementation(async (method, params) => method === 'cell.save' &&
      (params as { cellId: string }).cellId === 'a' ? { compileError: 'a syntax error' } : {});
    useNotebook.getState().setCellCode('a', 'x =');
    useNotebook.getState().setCellCode('b', 'y = 2');
    await flushSaves('nb-a');
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(false);
    expect(useNotebook.getState().compileErrors).toEqual({ a: 'a syntax error' });
    useNotebook.getState().setCellCode('a', 'x = 3');
    rpcMock.mockResolvedValue({});
    await useNotebook.getState().saveCell('a', 'x = 3');
    expect(useNotebook.getState().compileErrors).toEqual({});
  });

  it('failed queue entry does not prevent a subsequent save', async () => {
    seedA();
    const ack = deferred();
    let count = 0;
    dispatchLifecycle(() => ++count === 1 ? ack.promise : Promise.resolve({}));
    useNotebook.getState().setCellCode('a', 'x = 2');
    const first = useNotebook.getState().saveCell('a', 'x = 2');
    useNotebook.getState().setCellCode('a', 'x = 3');
    const second = useNotebook.getState().saveCell('a', 'x = 3');
    await settleQueue();
    ack.reject(new Error('temporary write failure'));
    await first;
    await second;
    expect(calls('cell.save')).toHaveLength(2);
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 3');
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(false);
    expect(tabError()).toBeUndefined();
  });

  it('close keeps its edit guard until all queued cells finish even when one fails', async () => {
    seedA([mkCell('b', 'y = 1')]);
    const first = deferred();
    const second = deferred();
    let count = 0;
    dispatchLifecycle(() => ++count === 1 ? first.promise : second.promise);
    useNotebook.getState().setCellCode('a', 'x = 2');
    useNotebook.getState().setCellCode('b', 'y = 2');
    const close = useNotebook.getState().closeTab('nb-a');
    await settleQueue();
    first.reject(new Error('a write failed'));
    await settleQueue();
    expect(useNotebooks.getState().activeTab()!.closing).toBe(true);
    expect(calls('notebook.close')).toHaveLength(0);
    second.resolve({});
    await close;
    expect(useNotebooks.getState().activeTab()!.closing).toBe(false);
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(true);
    expect(tabError()).toMatchObject({ operation: 'close', message: 'a write failed' });
  });

  it('list refresh preserves local closing and error state', async () => {
    seedA();
    useNotebooks.getState().setClosing('nb-a', true);
    useNotebooks.getState().setError('nb-a', { operation: 'save', message: 'disk full' });
    rpcMock.mockResolvedValue([mkTab('nb-a', '/a.py')]);
    await useNotebooks.getState().refreshList();
    expect(useNotebooks.getState().activeTab()).toMatchObject({ closing: true, error: { message: 'disk full' } });
  });

  it('dirty ended draft is still unsaved and failed persistence refuses close', async () => {
    seedA();
    useNotebook.getState().setCellCode('a', 'x = 2');
    useNotebooks.getState().setKernelState('nb-a', 'dead');
    expect(hasUnsavedChanges(useNotebooks.getState().activeTab()!)).toBe(true);
    dispatchLifecycle(async () => { throw new Error('kernel is dead'); });
    await useNotebook.getState().closeTab('nb-a');
    expect(calls('notebook.close')).toHaveLength(0);
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(true);
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 2');
    expect(tabError()).toMatchObject({ operation: 'close', message: 'kernel is dead' });
  });
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
  it('hasUnsavedChanges：dirty → true，包括 ended tab', () => {
    expect(hasUnsavedChanges({ dirty: true, ended: false })).toBe(true);
    expect(hasUnsavedChanges({ dirty: false, ended: false })).toBe(false);
    expect(hasUnsavedChanges({ dirty: true, ended: true })).toBe(true); // 内核结束不代表草稿落盘
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
  it('canRestartTab：只允许干净 dead/ended owner，拒绝 dirty 和过渡态', () => {
    expect(canRestartTab(mkTab('a', '/a.py', { ended: true, kernelState: 'dead' }))).toBe(true);
    expect(canRestartTab(mkTab('a', '/a.py', { ended: true, kernelState: 'dead', dirty: true }))).toBe(false);
    expect(canRestartTab(mkTab('a', '/a.py', { ended: false, kernelState: 'idle' }))).toBe(false);
    expect(canRestartTab(mkTab('a', '/a.py', { ended: true, kernelState: 'dead', restarting: true }))).toBe(false);
  });

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

  it('ended tab：普通写路径 no-op，但 clean lifecycle restart 放行', async () => {
    useNotebooks.setState({ tabs: [mkTab('nb-a', '/a.py', { ended: true, kernelState: 'dead' })], activeId: 'nb-a', caches: {} });
    useNotebook.setState({ cells: [mkCell('a', 'x = 1')], notebookPath: '/a.py', activeCellId: 'a' });
    rpcMock.mockResolvedValue({ notebookId: 'nb-a', notebookPath: '/a.py', state: { cells: [{ id: 'a', code: 'x = 1' }] } });

    useNotebook.getState().setCellCode('a', 'zzz');
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 1'); // 未改

    await useNotebook.getState().runCell('a');
    expect(useNotebook.getState().cells[0]!.status).toBe('idle'); // 未 running/error

    await useNotebook.getState().runRepl('1+1');
    expect(useNotebook.getState().cells.some((c) => c.id === 'repl')).toBe(false);

    await useNotebook.getState().restartKernel();
    expect(calls('kernel.restart')).toHaveLength(1);
    expect(useNotebooks.getState().activeTab()!.ended).toBe(false);
  });

  it('dirty ended tab：restart preserves draft and records a retryable error', async () => {
    const draftCache = cacheWith([mkCell('a', 'x = 9')]);
    draftCache.drafts = { a: { code: 'x = 9', revision: 1 } };
    useNotebooks.setState({ tabs: [mkTab('nb-a', '/a.py', { ended: true, kernelState: 'dead', dirty: true })], activeId: 'nb-a', caches: { 'nb-a': draftCache } });
    useNotebook.setState({ cells: [mkCell('a', 'x = 9')], notebookPath: '/a.py', activeCellId: 'a' });

    await useNotebook.getState().restartKernel();
    expect(calls('kernel.restart')).toHaveLength(0);
    expect(useNotebooks.getState().readCache('nb-a')?.drafts.a?.code).toBe('x = 9');
    expect(tabError()).toMatchObject({ operation: 'restart' });
  });

  it('duplicate lifecycle restart sends one owner request', async () => {
    const ack = deferred<{ notebookId: string; notebookPath: string; state: { cells: { id: string; code: string }[] } }>();
    useNotebooks.setState({ tabs: [mkTab('nb-a', '/a.py', { ended: true, kernelState: 'dead' })], activeId: 'nb-a', caches: {} });
    useNotebook.setState({ cells: [mkCell('a', 'x = 1')], notebookPath: '/a.py', activeCellId: 'a' });
    rpcMock.mockImplementation(async (method) => method === 'kernel.restart' ? ack.promise : {});

    const first = useNotebook.getState().restartKernel();
    await settleQueue();
    const second = useNotebook.getState().restartKernel();
    await second;
    expect(calls('kernel.restart')).toHaveLength(1);
    ack.resolve({ notebookId: 'nb-a', notebookPath: '/a.py', state: { cells: [{ id: 'a', code: 'x = 1' }] } });
    await first;
    expect(useNotebooks.getState().activeTab()!.ended).toBe(false);
  });

  it('restart response updates only owner cache after switching to B', async () => {
    const ack = deferred<{ notebookId: string; notebookPath: string; state: { cells: { id: string; code: string }[] } }>();
    useNotebooks.setState({ tabs: [mkTab('nb-a', '/a.py', { ended: true, kernelState: 'dead' }), mkTab('nb-b', '/b.py')], activeId: 'nb-a', caches: {} });
    useNotebook.setState({ cells: [mkCell('a', 'x = 1')], notebookPath: '/a.py', activeCellId: 'a' });
    useNotebooks.getState().saveCache('nb-b', cacheWith([mkCell('b', 'y = 2')]));
    rpcMock.mockImplementation(async (method) => {
      if (method === 'kernel.restart') return ack.promise;
      if (method === 'notebook.switch') return { notebookId: 'nb-b', state: { cells: [{ id: 'b', code: 'y = 2' }] } };
      return {};
    });

    const restart = useNotebook.getState().restartKernel();
    await settleQueue();
    await useNotebook.getState().switchTab('nb-b');
    ack.resolve({ notebookId: 'nb-a', notebookPath: '/a.py', state: { cells: [{ id: 'a', code: 'x = 7' }] } });
    await restart;
    expect(useNotebooks.getState().activeId).toBe('nb-b');
    expect(useNotebook.getState().cells[0]!.code).toBe('y = 2');
    expect(useNotebooks.getState().readCache('nb-a')?.cells[0]!.code).toBe('x = 7');
    expect(useNotebooks.getState().tabs.find((tab) => tab.notebookId === 'nb-b')?.ended).toBe(false);
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
