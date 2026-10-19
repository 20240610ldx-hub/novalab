/**
 * bridge 死亡 → 桌面恢复（第 6 轮，A15 子包）的 store 语义：
 * - 断线期间：bridgeConnected=false、运行/保存不发 RPC、允许继续编辑（D3），草稿只留本地；
 * - 新一代 bridge：tab 不被 notebook.list 抹掉，全部标记 bridgeLost，**不自动重开**（D1：等用户点击）；
 * - 用户点击重开 clean tab：只 notebook.open（冷加载），改键到新 id，不执行、不重放；
 * - dirty tab 可重开（D4）：磁盘仍是旧代基线 → 草稿保留、恢复自动保存；不同或未知 → 进入冲突流程；
 * - 同一实例重连（只断 WS）：tab 不丢、断线期间草稿补发保存。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cell } from '../kernel/types';

type StatusEvent = { status: 'idle' | 'connected' | 'reconnecting' | 'down'; generation: number; newInstance: boolean };

const { rpc, handlers, statusListeners } = vi.hoisted(() => ({
  rpc: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(),
  handlers: [] as ((method: string, params: unknown) => void)[],
  statusListeners: [] as ((e: StatusEvent) => void)[],
}));
vi.mock('../bridge/client', async (load) => ({
  ...await load<typeof import('../bridge/client')>(),
  bridge: {
    rpc,
    connect: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    onNotification: (handler: (method: string, params: unknown) => void) => {
      handlers.push(handler); return () => {};
    },
    onStatus: (listener: (e: StatusEvent) => void) => {
      statusListeners.push(listener); return () => {};
    },
  },
}));
import { BridgeDisconnectedError } from '../bridge/client';
import { useNotebook, CELL_SAVE_DEBOUNCE_MS } from './notebook';
import { emptyCache, canRestartTab, useNotebooks, type NotebookTab } from './notebooks';
import { useSession } from './session';

function cell(id = 'a', code = 'x = 1'): Cell {
  return { id, code, execCount: 3, status: 'idle', defs: [], refs: [], sideEffect: false,
    kind: 'code', output: { stdout: 'old output', stderr: '', mime: {}, traceback: null, writes: [] } };
}
function tab(id: string, path: string, over: Partial<NotebookTab> = {}): NotebookTab {
  return { notebookId: id, path, kernelState: 'idle', cellCount: 1, ended: false, rssMB: null, dirty: false, ...over };
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function calls(method: string) { return rpc.mock.calls.filter(([m]) => m === method); }
function emit(e: StatusEvent) { for (const l of statusListeners) l(e); }
function tabOf(id: string) { return useNotebooks.getState().tabs.find((t) => t.notebookId === id); }

beforeEach(async () => {
  vi.useFakeTimers(); rpc.mockReset();
  rpc.mockImplementation(async (m) => (m === 'notebook.list' ? [tab('A', '/a.py'), tab('B', '/b.py')] : {}));
  useNotebooks.setState({
    tabs: [tab('A', '/a.py', { baselineSha256: 'sha-A' }), tab('B', '/b.py', { baselineSha256: 'sha-B' })], activeId: 'A',
    caches: { B: { ...emptyCache(), cells: [cell('b', 'y = 1')] } },
  });
  useNotebook.setState({ ...emptyCache(), cells: [cell()], notebookPath: '/a.py', historyView: false,
    kernelState: 'live', bridgeConnected: true, cascadeAsk: null });
  useSession.setState({ readOnly: false, viewingId: null, viewingEndedAt: null, currentId: 's-A', sessions: [], currentEndedAt: null });
  await useNotebook.getState().connectBridge();
  emit({ status: 'connected', generation: 1, newInstance: false });
  await settle();
  rpc.mockClear();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('while the bridge is reconnecting', () => {
  it('reflects the status and keeps editing local without sending saves (D3)', async () => {
    emit({ status: 'reconnecting', generation: 1, newInstance: false });
    expect(useNotebook.getState().bridgeConnected).toBe(false);
    expect(useNotebook.getState().bridgeStatus).toBe('reconnecting');

    useNotebook.getState().setCellCode('a', 'x = 2');
    await vi.advanceTimersByTimeAsync(CELL_SAVE_DEBOUNCE_MS * 3);
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 2');
    expect(useNotebooks.getState().readCache('A')!.drafts.a!.code).toBe('x = 2');
    expect(tabOf('A')!.dirty).toBe(true);
    expect(calls('cell.save')).toHaveLength(0);
    expect(tabOf('A')!.error).toBeUndefined();
  });

  it('blocks run and REPL without RPCs', async () => {
    emit({ status: 'reconnecting', generation: 1, newInstance: false });
    await useNotebook.getState().runCell('a');
    await useNotebook.getState().runRepl('1 + 1');
    expect(calls('cell.run')).toHaveLength(0);
    expect(calls('kernel.repl')).toHaveLength(0);
  });

  it('marks a run interrupted by the disconnect as stale, not as a kernel error', async () => {
    rpc.mockImplementation(async (m) => {
      if (m === 'cell.run') throw new BridgeDisconnectedError();
      return {};
    });
    await useNotebook.getState().runCell('a');
    expect(useNotebook.getState().cells[0]!.status).toBe('stale');
  });
});

describe('after a new bridge instance comes up', () => {
  beforeEach(() => {
    rpc.mockImplementation(async (m) => (m === 'notebook.list' ? [] : {}));
  });

  it('keeps every tab, marks them bridge-lost and does not reopen anything automatically (D1)', async () => {
    useNotebook.getState().setCellCode('a', 'x = 5');
    emit({ status: 'reconnecting', generation: 1, newInstance: false });
    emit({ status: 'connected', generation: 2, newInstance: true });
    await settle();
    await useNotebooks.getState().refreshList(); // TabBar 在 bridgeConnected 翻真时也会调用

    const tabs = useNotebooks.getState().tabs;
    expect(tabs.map((t) => t.notebookId)).toEqual(['A', 'B']);
    expect(tabs.every((t) => t.bridgeLost === true && t.kernelState === 'dead')).toBe(true);
    expect(tabs.every((t) => t.ended === false)).toBe(true); // 仍可编辑（D3）
    expect(useNotebooks.getState().readCache('A')!.drafts.a!.code).toBe('x = 5');
    expect(useNotebook.getState().bridgeConnected).toBe(true);
    expect(calls('notebook.open')).toHaveLength(0);
    expect(calls('cell.save')).toHaveLength(0);
    expect(canRestartTab(tabOf('B')!)).toBe(false);
  });

  it('hides a duplicate entry the new bridge lists for a bridge-lost path', async () => {
    emit({ status: 'connected', generation: 2, newInstance: true });
    rpc.mockImplementation(async (m) => (m === 'notebook.list' ? [tab('nb-new', '/b.py')] : {}));
    await useNotebooks.getState().refreshList();
    expect(useNotebooks.getState().tabs.map((t) => t.notebookId)).toEqual(['A', 'B']);
  });

  it('cold-reopens a clean tab only on click: notebook.open once, rekeyed, no execution or replay', async () => {
    emit({ status: 'connected', generation: 2, newInstance: true });
    await settle();
    rpc.mockImplementation(async (m) => {
      if (m === 'notebook.open') {
        return { notebookId: 'A2', state: { cells: [{ id: 'a', code: 'x = 1 # disk', execCount: 0 }], dagEdges: [], staleSet: [], schemas: [] } };
      }
      if (m === 'notebook.list') return [tab('A2', '/a.py')];
      return {};
    });
    await useNotebook.getState().reopenLostTab('A');

    expect(calls('notebook.open')).toEqual([['notebook.open', { path: '/a.py' }]]);
    expect(rpc.mock.calls.filter(([m]) => /^(cell\.run|kernel\.|diff\.)/.test(m))).toHaveLength(0);
    const nb = useNotebooks.getState();
    expect(nb.activeId).toBe('A2');
    expect(nb.tabs.map((t) => t.notebookId)).toEqual(['A2', 'B']);
    expect(nb.tabs[0]!.bridgeLost).toBeFalsy();
    expect(nb.tabs[1]!.bridgeLost).toBe(true);
    expect(nb.readCache('A')).toBeUndefined();
    const cells = useNotebook.getState().cells;
    expect(cells.map((c) => c.code)).toEqual(['x = 1 # disk']);
    expect(cells[0]!.output).toBeNull();
    expect(cells[0]!.execCount).toBeNull();
    expect(useNotebook.getState().notebookPath).toBe('/a.py');
  });

  // D4（Owner 2026-10-16 批准）：dirty tab 可点击重开；以旧代最后确认的 baselineSha256 核对重开时的磁盘。
  function reopenReturns(baselineSha256: string) {
    rpc.mockImplementation(async (m) => {
      if (m === 'notebook.open') {
        return { notebookId: 'A2', state: { cells: [{ id: 'a', code: 'x = 1', execCount: 0 }], dagEdges: [], staleSet: [], schemas: [], baselineSha256 } };
      }
      if (m === 'notebook.list') return [tab('A2', '/a.py')];
      if (m === 'cell.save') return { dagEdges: [], staleSet: [], baselineSha256: 'sha-A-saved' };
      return {};
    });
  }
  async function dirtyThenNewGeneration() {
    useNotebook.getState().setCellCode('a', 'x = 9');
    emit({ status: 'reconnecting', generation: 1, newInstance: false });
    emit({ status: 'connected', generation: 2, newInstance: true });
    await settle();
  }

  it('reopens a dirty tab whose disk still matches the old baseline: drafts kept, autosave resumes on the new id', async () => {
    await dirtyThenNewGeneration();
    reopenReturns('sha-A');
    await useNotebook.getState().reopenLostTab('A');

    expect(calls('notebook.open')).toEqual([['notebook.open', { path: '/a.py' }]]);
    const a2 = tabOf('A2')!;
    expect(a2.bridgeLost).toBeFalsy();
    expect(a2.conflict).toBeUndefined();
    expect(a2.dirty).toBe(true);
    expect(useNotebooks.getState().readCache('A2')!.drafts.a!.code).toBe('x = 9');
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 9');
    expect(useNotebook.getState().cells[0]!.output).toBeNull();
    expect(useNotebook.getState().cells[0]!.execCount).toBeNull();

    await vi.advanceTimersByTimeAsync(CELL_SAVE_DEBOUNCE_MS * 3);
    expect(calls('cell.save')).toEqual([['cell.save', { notebookId: 'A2', cellId: 'a', code: 'x = 9' }]]);
    expect(tabOf('A2')!.dirty).toBe(false);
    expect(tabOf('A2')!.baselineSha256).toBe('sha-A-saved');
  });

  it('puts a dirty tab whose disk changed during the outage into the conflict flow, keeping drafts and pausing saves', async () => {
    await dirtyThenNewGeneration();
    reopenReturns('sha-EXTERNAL');
    await useNotebook.getState().reopenLostTab('A');

    const a2 = tabOf('A2')!;
    expect(a2.bridgeLost).toBeFalsy();
    expect(a2.conflict).toMatchObject({ notebookPath: '/a.py' });
    expect(a2.dirty).toBe(true);
    expect(useNotebooks.getState().readCache('A2')!.drafts.a!.code).toBe('x = 9');
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 9'); // local version stays visible
    await vi.advanceTimersByTimeAsync(CELL_SAVE_DEBOUNCE_MS * 3);
    expect(calls('cell.save')).toHaveLength(0);
  });

  it('treats a dirty tab without a known baseline as changed (conflict, never a blind save)', async () => {
    useNotebooks.setState({ tabs: useNotebooks.getState().tabs.map((t) => (t.notebookId === 'A' ? { ...t, baselineSha256: undefined } : t)) });
    await dirtyThenNewGeneration();
    reopenReturns('sha-A');
    await useNotebook.getState().reopenLostTab('A');
    expect(tabOf('A2')!.conflict).toMatchObject({ notebookPath: '/a.py' });
    await vi.advanceTimersByTimeAsync(CELL_SAVE_DEBOUNCE_MS * 3);
    expect(calls('cell.save')).toHaveLength(0);
  });

  it('records the fingerprint from open and from every save ACK', async () => {
    rpc.mockImplementation(async (m) => {
      if (m === 'notebook.open') return { notebookId: 'C', state: { cells: [{ id: 'c', code: 'z = 1' }], baselineSha256: 'sha-C' } };
      if (m === 'notebook.list') return [tab('A', '/a.py'), tab('B', '/b.py'), tab('C', '/c.py')];
      if (m === 'cell.save') return { dagEdges: [], staleSet: [], baselineSha256: 'sha-C2' };
      return {};
    });
    await useNotebook.getState().openNotebook('/c.py');
    expect(tabOf('C')!.baselineSha256).toBe('sha-C');
    useNotebook.getState().setCellCode('c', 'z = 2');
    await vi.advanceTimersByTimeAsync(CELL_SAVE_DEBOUNCE_MS * 3);
    expect(tabOf('C')!.baselineSha256).toBe('sha-C2');
    expect(tabOf('A')!.baselineSha256).toBe('sha-A'); // other owners untouched
  });

  it('keeps a reopen failure retryable without losing the tab', async () => {
    emit({ status: 'connected', generation: 2, newInstance: true });
    await settle();
    rpc.mockImplementation(async (m) => {
      if (m === 'notebook.open') throw new Error('ENOENT');
      return m === 'notebook.list' ? [] : {};
    });
    await useNotebook.getState().reopenLostTab('A');
    expect(tabOf('A')!.bridgeLost).toBe(true);
    expect(tabOf('A')!.error?.operation).toBe('reopen');
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 1');
  });

  it('switches between bridge-lost tabs locally without notebook.switch', async () => {
    emit({ status: 'connected', generation: 2, newInstance: true });
    await settle();
    await useNotebook.getState().switchTab('B');
    expect(calls('notebook.switch')).toHaveLength(0);
    expect(useNotebooks.getState().activeId).toBe('B');
    expect(useNotebook.getState().cells[0]!.code).toBe('y = 1');
  });

  it('closes a clean bridge-lost tab locally and refuses to drop a dirty one', async () => {
    useNotebook.getState().setCellCode('a', 'x = 7');
    emit({ status: 'reconnecting', generation: 1, newInstance: false });
    emit({ status: 'connected', generation: 2, newInstance: true });
    await settle();
    await useNotebook.getState().closeTab('B');
    expect(calls('notebook.close')).toHaveLength(0);
    expect(tabOf('B')).toBeUndefined();

    await useNotebook.getState().closeTab('A');
    expect(tabOf('A')).toBeDefined();
    expect(tabOf('A')!.error?.operation).toBe('close');
    expect(useNotebooks.getState().readCache('A')!.drafts.a!.code).toBe('x = 7');
  });

  it('does not let restartKernel address a stale notebook id', async () => {
    emit({ status: 'connected', generation: 2, newInstance: true });
    await settle();
    await useNotebook.getState().restartKernel();
    expect(calls('kernel.restart')).toHaveLength(0);
  });

  describe('reopen all (one explicit click, still D1)', () => {
    function openReturns(failPath?: string) {
      const opened: string[] = [];
      rpc.mockImplementation(async (m, p) => {
        if (m === 'notebook.open') {
          const path = (p as { path: string }).path;
          if (path === failPath) throw new Error('kernel spawn failed');
          opened.push(path);
          const id = `${path === '/a.py' ? 'A' : 'B'}2`;
          return { notebookId: id, state: { cells: [{ id: 'c', code: 'z = 1', execCount: 0 }], dagEdges: [], staleSet: [], schemas: [] } };
        }
        if (m === 'notebook.list') return opened.map((path) => tab(`${path === '/a.py' ? 'A' : 'B'}2`, path));
        return {};
      });
    }

    it('reopens every bridge-lost tab one at a time in tab order, runs nothing, and returns focus', async () => {
      emit({ status: 'connected', generation: 2, newInstance: true });
      await settle();
      useNotebooks.setState({ activeId: 'B' }); // 用户停在第二个标签上
      openReturns();
      await useNotebook.getState().reopenAllLostTabs();

      expect(calls('notebook.open').map(([, p]) => (p as { path: string }).path)).toEqual(['/a.py', '/b.py']);
      expect(rpc.mock.calls.filter(([m]) => /^(cell\.run|kernel\.|diff\.)/.test(m))).toHaveLength(0);
      const nb = useNotebooks.getState();
      expect(nb.tabs.map((t) => [t.notebookId, !!t.bridgeLost])).toEqual([['A2', false], ['B2', false]]);
      expect(nb.activeId).toBe('B2'); // 焦点回到用户原来的 tab
      expect(useNotebook.getState().notebookPath).toBe('/b.py');
    });

    it('keeps going past a failed reopen and leaves that tab reopenable with its error', async () => {
      emit({ status: 'connected', generation: 2, newInstance: true });
      await settle();
      openReturns('/b.py');
      await useNotebook.getState().reopenAllLostTabs();

      expect(calls('notebook.open')).toHaveLength(2);
      expect(tabOf('A2')!.bridgeLost).toBeFalsy();
      expect(tabOf('B')!.bridgeLost).toBe(true);
      expect(tabOf('B')!.error?.operation).toBe('reopen');
      expect(useNotebooks.getState().activeId).toBe('A2');
    });

    it('stops when the bridge drops mid-way instead of erroring every remaining tab', async () => {
      emit({ status: 'connected', generation: 2, newInstance: true });
      await settle();
      rpc.mockImplementation(async (m) => {
        if (m === 'notebook.open') {
          emit({ status: 'reconnecting', generation: 2, newInstance: false });
          throw new BridgeDisconnectedError();
        }
        return {};
      });
      await useNotebook.getState().reopenAllLostTabs();
      expect(calls('notebook.open')).toHaveLength(1);
      expect(tabOf('B')!.bridgeLost).toBe(true);
      expect(tabOf('B')!.error).toBeUndefined();
    });
  });
});

describe('same bridge instance (WS-only drop)', () => {
  it('keeps tabs live and resumes saving drafts made while disconnected', async () => {
    emit({ status: 'reconnecting', generation: 1, newInstance: false });
    useNotebook.getState().setCellCode('a', 'x = 3');
    rpc.mockImplementation(async (m) => (m === 'notebook.list' ? [tab('A', '/a.py'), tab('B', '/b.py')] : {}));
    emit({ status: 'connected', generation: 1, newInstance: false });
    await vi.advanceTimersByTimeAsync(CELL_SAVE_DEBOUNCE_MS * 3);
    expect(useNotebooks.getState().tabs.every((t) => !t.bridgeLost)).toBe(true);
    expect(calls('cell.save')).toEqual([['cell.save', { notebookId: 'A', cellId: 'a', code: 'x = 3' }]]);
  });
});

describe('down', () => {
  it('reports down and exposes a manual retry', async () => {
    emit({ status: 'down', generation: 1, newInstance: false });
    expect(useNotebook.getState().bridgeStatus).toBe('down');
    await useNotebook.getState().retryBridge();
    const { bridge } = await import('../bridge/client');
    expect(bridge.retry).toHaveBeenCalledTimes(1);
  });
});
