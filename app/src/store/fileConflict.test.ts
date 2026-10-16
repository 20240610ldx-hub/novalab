import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cell } from '../kernel/types';

const { rpc, handlers } = vi.hoisted(() => ({
  rpc: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(),
  handlers: [] as ((method: string, params: unknown) => void)[],
}));
vi.mock('../bridge/client', async (load) => ({
  ...await load<typeof import('../bridge/client')>(),
  bridge: { rpc, connect: vi.fn(async () => {}), onNotification: (handler: (method: string, params: unknown) => void) => {
    handlers.push(handler); return () => {};
  } },
}));
import * as client from '../bridge/client';
import { useNotebook } from './notebook';
import { emptyCache, useNotebooks, type NotebookTab } from './notebooks';
import { useSession } from './session';

function cell(id = 'a', code = 'x = 1'): Cell {
  return { id, code, execCount: 7, status: 'idle', defs: [], refs: [], sideEffect: false,
    kind: 'code', output: { stdout: 'old output', stderr: '', mime: {}, traceback: null, writes: [] } };
}
function tab(id: string, path: string): NotebookTab {
  return { notebookId: id, path, kernelState: 'idle', cellCount: 1, ended: false, rssMB: null, dirty: false };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function calls(method: string) { return rpc.mock.calls.filter(([m]) => m === method); }
function conflictError(recoveryPath: string | null = '/copies/local.py', recoveryError?: string) {
  return Object.assign(new Error('external modification'), { code: -32002,
    data: { kind: 'external-modification', notebookPath: '/a.py', recoveryPath, ...(recoveryError ? { recoveryError } : {}) } });
}
function conflict(id = 'A') {
  return useNotebooks.getState().tabs.find((t) => t.notebookId === id)?.conflict;
}
function reload(id = 'A') {
  return useNotebook.getState().reloadFromDisk(id);
}
function fireExternal(id = 'A', path = '/a.py') {
  for (const handler of handlers) handler('notebook.externalChange', { notebookId: id, notebookPath: path });
}
function diskResult(id = 'A') {
  return { notebookId: id, recoveryPath: '/copies/latest-local.py',
    state: { cells: [{ id: 'a', code: 'x = 99', execCount: 0 }], dagEdges: [], staleSet: [], schemas: [], execCounts: { a: 0 } } };
}

beforeEach(async () => {
  vi.useFakeTimers(); rpc.mockReset(); rpc.mockResolvedValue({});
  useNotebooks.setState({ tabs: [tab('A', '/a.py')], activeId: 'A', caches: {} });
  useNotebook.setState({ ...emptyCache(), cells: [cell()], notebookPath: '/a.py', historyView: false,
    kernelState: 'live', bridgeConnected: true, cascadeAsk: null });
  useSession.setState({ readOnly: false, viewingId: null, viewingEndedAt: null, currentId: 's-A', sessions: [], currentEndedAt: null });
  await useNotebook.getState().connectBridge();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('notebook open ownership', () => {
  function seedRuntime() {
    useNotebook.setState({
      cells: [cell(), { ...cell('repl', 'print("OLD_REPL")'), kind: 'repl' }],
      diffs: [{ id: 'd-old', targetCellId: 'a', action: 'update', newCode: 'x=4', state: 'proposed', origin: 'agent' }],
      diffMarks: { 'd-old': { origin: 'user' } }, compileErrors: { a: 'old error' },
      schemas: [{ name: 'old', type: 'int' }], lastRunMs: { a: 9 }, staleSet: ['a'],
      dagEdges: [{ from: 'a', to: 'old' }], uiCollapsed: { repl: true }, activeCellId: 'repl',
    });
    useNotebook.getState().setCellCode('a', 'x = 2');
  }
  function notifyFocus(id: string) {
    for (const handler of handlers) handler('focus.changed', { notebookId: id });
  }

  it('new open isolates A runtime and drafts while preserving its complete owner cache', async () => {
    seedRuntime();
    rpc.mockImplementation(async (m) => m === 'notebook.open'
      ? { notebookId: 'B', state: { cells: [{ id: 'a', code: 'y = 1' }], dagEdges: [], staleSet: [], schemas: [] } }
      : m === 'notebook.list' ? [tab('A', '/a.py'), tab('B', '/b.py')] : {});
    await useNotebook.getState().openNotebook('/b.py');
    const state = useNotebook.getState();
    expect(state.cells.map((c) => c.code)).toEqual(['y = 1']);
    expect(state.cells[0]!.output).toBeNull(); expect(state.cells[0]!.execCount).toBeNull();
    expect(state.diffs).toEqual([]); expect(state.diffMarks).toEqual({}); expect(state.schemas).toEqual([]);
    expect(state.compileErrors).toEqual({}); expect(state.staleSet).toEqual([]); expect(state.lastRunMs).toEqual({});
    expect(state.uiCollapsed).toEqual({}); expect(state.dagEdges).toEqual([]);
    expect(useNotebooks.getState().readCache('B')!.cells.map((c) => c.id)).toEqual(['a']);
    const a = useNotebooks.getState().readCache('A')!;
    expect(a.cells.map((c) => c.code)).toEqual(['x = 2', 'print("OLD_REPL")']);
    expect(a.cells[0]!.output!.stdout).toBe('old output');
    expect(a.drafts.a!.code).toBe('x = 2'); expect(a.diffs).toHaveLength(1);
    expect(useNotebooks.getState().tabs.find((t) => t.notebookId === 'A')!.dirty).toBe(true);
  });

  it('reopening an existing ID restores that owner cache including unsaved source', async () => {
    seedRuntime();
    rpc.mockImplementation(async (m) => m === 'notebook.open'
      ? { notebookId: 'A', state: { cells: [{ id: 'a', code: 'disk old' }] } }
      : m === 'notebook.list' ? [tab('A', '/a.py')] : {});
    await useNotebook.getState().openNotebook('/a.py');
    expect(useNotebook.getState().cells.map((c) => c.code)).toEqual(['x = 2', 'print("OLD_REPL")']);
    expect(useNotebook.getState().diffs).toHaveLength(1);
    expect(useNotebook.getState().compileErrors).toEqual({ a: 'old error' });
    expect(useNotebooks.getState().readCache('A')!.drafts.a!.code).toBe('x = 2');
  });

  it('same-ID reopen after an uncached open restores A without taking B runtime', async () => {
    seedRuntime();
    rpc.mockImplementation(async (m, p) => {
      if (m === 'notebook.open') {
        const id = (p as { path: string }).path === '/b.py' ? 'B' : 'A';
        for (const handler of handlers) handler('focus.changed', { notebookId: id });
        return { notebookId: id, state: { cells: [{ id: 'a', code: id === 'B' ? 'y = 1' : 'disk old' }] } };
      }
      if (m === 'notebook.list') return [tab('A', '/a.py'), tab('B', '/b.py')];
      return {};
    });
    await useNotebook.getState().openNotebook('/b.py');
    useNotebook.getState().setCellCode('a', 'y = 2');
    await useNotebook.getState().openNotebook('/a.py');
    expect(useNotebook.getState().cells.map((c) => c.code)).toEqual(['x = 2', 'print("OLD_REPL")']);
    expect(useNotebook.getState().diffs[0]!.id).toBe('d-old');
    expect(useNotebooks.getState().readCache('B')!.cells.map((c) => c.code)).toEqual(['y = 2']);
    expect(useNotebooks.getState().readCache('A')!.drafts.a!.code).toBe('x = 2');
  });

  it('early focus notifications cannot seed a new owner cache from the old visible cells', async () => {
    seedRuntime();
    useNotebooks.getState().setTabs([tab('A', '/a.py'), tab('B', '/b.py'), tab('C', '/c.py')]);
    const ack = deferred();
    rpc.mockImplementation(async (m) => {
      if (m === 'notebook.open') { notifyFocus('B'); return ack.promise; }
      if (m === 'notebook.list') return [tab('A', '/a.py'), tab('B', '/b.py'), tab('C', '/c.py')];
      return {};
    });
    const pending = useNotebook.getState().openNotebook('/b.py'); await settle();
    notifyFocus('C');
    expect(useNotebooks.getState().readCache('B')!.cells).toEqual([]);
    expect(useNotebooks.getState().readCache('B')!.compileErrors).toEqual({});
    ack.resolve({ notebookId: 'B', state: { cells: [{ id: 'a', code: 'y = 1' }] } });
    await pending;
    expect(useNotebook.getState().cells.map((c) => c.code)).toEqual(['y = 1']);
    expect(useNotebooks.getState().readCache('A')!.cells).toHaveLength(2);
  });
});

describe('external file conflict lifecycle', () => {
  it('BridgeClient preserves RPC code and structured data in a typed error', async () => {
    const c = new client.BridgeClient();
    const raw = c as unknown as { ws: { send: (s: string) => void }; dispatch: (m: unknown) => void };
    let id = 0; raw.ws = { send: (s) => { id = JSON.parse(s).id; } };
    const pending = c.rpc('cell.save');
    raw.dispatch({ id, error: { code: -32002, message: 'changed', data: conflictError().data } });
    const error = await pending.catch((e: unknown) => e) as { code?: number; data?: unknown };
    expect(error.code).toBe(-32002);
    expect(error.data).toEqual(conflictError().data);
    expect(error.constructor.name).toBe('BridgeRpcError');
  });

  it('save conflict preserves local source/draft and backup details without generic Retry state', async () => {
    rpc.mockRejectedValue(conflictError());
    useNotebook.getState().setCellCode('a', 'x = 2');
    await useNotebook.getState().saveCell('a', 'x = 2');
    expect(conflict()).toMatchObject({ notebookPath: '/a.py', recoveryPath: '/copies/local.py' });
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(true);
    expect(useNotebooks.getState().readCache('A')!.cells[0]!.code).toBe('x = 2');
    expect(useNotebooks.getState().activeTab()!.error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(600);
    expect(calls('cell.save')).toHaveLength(1);
  });

  it('external notification cancels owner timers; local edits stay cached without autosave', async () => {
    useNotebook.getState().setCellCode('a', 'x = 2');
    fireExternal();
    useNotebook.getState().setCellCode('a', 'x = 3');
    await vi.advanceTimersByTimeAsync(600);
    expect(calls('cell.save')).toHaveLength(0);
    expect(conflict()).toBeDefined();
    expect(useNotebooks.getState().readCache('A')!.drafts.a!.code).toBe('x = 3');
    await useNotebook.getState().saveCell('a', 'x = 3');
    expect(calls('cell.save')).toHaveLength(0);
  });

  it('external A notification cannot pause B with same cell IDs', async () => {
    useNotebooks.getState().setTabs([tab('A', '/a.py'), tab('B', '/b.py')]);
    useNotebooks.getState().saveCache('B', { ...emptyCache(), cells: [cell('a', 'y = 1')] });
    useNotebook.getState().setCellCode('a', 'x = 2');
    await useNotebook.getState().switchTab('B');
    useNotebook.getState().setCellCode('a', 'y = 2');
    fireExternal();
    await vi.advanceTimersByTimeAsync(300);
    expect(calls('cell.save').map(([, p]) => p)).toEqual([{ notebookId: 'B', cellId: 'a', code: 'y = 2' }]);
    expect(useNotebook.getState().cells[0]!.code).toBe('y = 2');
    expect(conflict('A')).toBeDefined();
    expect(conflict('B')).toBeUndefined();
  });

  it('queued save is checked again before RPC; old ACK cannot clear conflict/new draft', async () => {
    const ack = deferred(); rpc.mockImplementation(async (m) => m === 'cell.save' ? ack.promise : {});
    useNotebook.getState().setCellCode('a', 'x = 2');
    const first = useNotebook.getState().saveCell('a', 'x = 2'); await settle();
    useNotebook.getState().setCellCode('a', 'x = 3');
    const second = useNotebook.getState().saveCell('a', 'x = 3');
    fireExternal(); ack.resolve({ dagEdges: [{ from: 'old', to: 'a' }], staleSet: ['a'] });
    await first; await second;
    expect(calls('cell.save')).toHaveLength(1);
    expect(conflict()).toBeDefined();
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(true);
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 3');
    expect(useNotebook.getState().dagEdges).toEqual([]);
  });

  it('conflict close refuses removal including direct closeRpc', async () => {
    useNotebook.getState().setCellCode('a', 'x = 2'); fireExternal();
    rpc.mockImplementation(async (m) => m === 'notebook.list' ? [] : {});
    await useNotebook.getState().closeTab('A');
    await useNotebooks.getState().closeRpc('A').catch(() => {});
    expect(calls('notebook.close')).toHaveLength(0);
    expect(useNotebooks.getState().tabs).toHaveLength(1);
    expect(useNotebooks.getState().readCache('A')!.drafts.a!.code).toBe('x = 2');
  });

  it('close receives conflict and preserves backup failure message and tab', async () => {
    rpc.mockImplementation(async (m) => { if (m === 'notebook.close') throw conflictError(null, 'backup denied'); return []; });
    await useNotebook.getState().closeTab('A');
    expect(useNotebooks.getState().tabs).toHaveLength(1);
    expect(conflict()).toMatchObject({ recoveryPath: null, recoveryError: 'backup denied' });
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 1');
    expect(useNotebooks.getState().activeTab()!.error).toBeUndefined();
  });

  it('explicit reload drains save ACK, freezes edit/close, backs up full latest source, and resets runtime', async () => {
    const ack = deferred(); const reloadAck = deferred();
    rpc.mockImplementation(async (m) => m === 'cell.save' ? ack.promise : m === 'notebook.reload' ? reloadAck.promise : {});
    useNotebook.getState().setCellCode('a', 'x = 2');
    const save = useNotebook.getState().saveCell('a', 'x = 2'); await settle();
    useNotebook.getState().setCellCode('a', 'x = 3'); fireExternal();
    useNotebook.setState({ cells: [...useNotebook.getState().cells, { ...cell('repl', '1+1'), kind: 'repl' }],
      diffs: [{ id: 'd1', targetCellId: 'a', action: 'update', newCode: 'x=4', state: 'proposed', origin: 'agent' }],
      compileErrors: { a: 'old error' }, schemas: [{ name: 'old', type: 'int' }], lastRunMs: { a: 9 } });
    const pending = reload(); expect(pending).toBeInstanceOf(Promise); await settle();
    useNotebook.getState().setCellCode('a', 'x = 4'); await useNotebook.getState().closeTab('A');
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 3');
    expect(calls('notebook.reload')).toHaveLength(0);
    expect(calls('notebook.close')).toHaveLength(0);
    ack.resolve({}); await save; await settle();
    expect(calls('notebook.reload')[0]![1]).toEqual({ notebookId: 'A', cells: [{ id: 'a', code: 'x = 3' }] });
    reloadAck.resolve(diskResult()); await pending;
    expect(useNotebook.getState().cells.map((c) => c.id)).toEqual(['a']);
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 99');
    expect(useNotebook.getState().cells[0]!.output).toBeNull();
    expect(useNotebook.getState().diffs).toEqual([]); expect(useNotebook.getState().schemas).toEqual([]);
    expect(useNotebook.getState().compileErrors).toEqual({}); expect(useNotebook.getState().lastRunMs).toEqual({});
    expect(useNotebooks.getState().readCache('A')!.drafts).toEqual({});
    expect(conflict()).toBeUndefined(); expect(useNotebooks.getState().activeTab()!.dirty).toBe(false);
    expect(useNotebooks.getState().activeTab()!.recoveryPath).toBe('/copies/latest-local.py');
    await vi.advanceTimersByTimeAsync(1000); expect(calls('cell.save')).toHaveLength(1);
  });

  it('reload failure preserves local code and conflict for explicit retry', async () => {
    useNotebook.getState().setCellCode('a', 'x = 2'); fireExternal();
    rpc.mockRejectedValue(new Error('backup denied'));
    await reload();
    expect(conflict()).toMatchObject({ message: 'backup denied' });
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 2');
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(true);
    rpc.mockResolvedValue(diskResult()); await reload();
    expect(calls('notebook.reload')).toHaveLength(2); expect(conflict()).toBeUndefined();
  });

  it('A reload ACK after switching B updates only A cache', async () => {
    useNotebooks.getState().setTabs([tab('A', '/a.py'), tab('B', '/b.py')]);
    useNotebooks.getState().saveCache('B', { ...emptyCache(), cells: [cell('a', 'y = 1')] });
    fireExternal(); const ack = deferred(); rpc.mockImplementation(async (m) => m === 'notebook.reload' ? ack.promise : {});
    const pending = reload(); await settle(); await useNotebook.getState().switchTab('B');
    useNotebook.getState().setCellCode('a', 'y = 2'); ack.resolve(diskResult()); await pending;
    expect(useNotebook.getState().cells[0]!.code).toBe('y = 2');
    expect(useNotebooks.getState().activeId).toBe('B');
    expect(useNotebooks.getState().readCache('A')!.cells[0]!.code).toBe('x = 99');
    expect(useNotebooks.getState().activeTab()!.dirty).toBe(true);
  });

  it('history cannot initiate reload; history entered during reload stays visible', async () => {
    fireExternal(); useNotebook.setState({ historyView: true }); useSession.setState({ readOnly: true, viewingId: 'past' });
    await reload(); expect(calls('notebook.reload')).toHaveLength(0);
    useNotebook.setState({ historyView: false }); useSession.setState({ readOnly: false, viewingId: null });
    const ack = deferred(); rpc.mockImplementation(async (m) => m === 'notebook.reload' ? ack.promise : m === 'session.open'
      ? { sessionId: 'past', endedAt: 'old', cells: [{ id: 'a', code: 'x = 0' }] } : {});
    const pending = reload(); await settle(); await useSession.getState().openHistory('past');
    ack.resolve(diskResult()); await pending;
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 0'); expect(useNotebook.getState().historyView).toBe(true);
    await useSession.getState().backToLive(); expect(useNotebook.getState().cells[0]!.code).toBe('x = 99');
  });

  it('list refresh retains conflict and reload lifecycle markers', async () => {
    fireExternal(); const ack = deferred(); rpc.mockImplementation(async (m) => m === 'notebook.reload' ? ack.promise : m === 'notebook.list' ? [tab('A', '/a.py')] : {});
    const pending = reload(); await settle(); await useNotebooks.getState().refreshList();
    expect(conflict()).toBeDefined();
    expect(useNotebooks.getState().activeTab()!.reloading).toBe(true);
    ack.resolve(diskResult()); await pending;
  });

  it('same-revision old ACK keeps the unresolved conflict and its local draft', async () => {
    const ack = deferred(); rpc.mockImplementation(async (m) => m === 'cell.save' ? ack.promise : {});
    useNotebook.getState().setCellCode('a', 'x = 2');
    const pending = useNotebook.getState().saveCell('a', 'x = 2'); await settle();
    fireExternal(); ack.resolve({}); await pending;
    expect(conflict()).toBeDefined(); expect(useNotebooks.getState().activeTab()!.dirty).toBe(true);
    expect(useNotebooks.getState().readCache('A')!.drafts.a!.code).toBe('x = 2');
  });

  it('explicit reload waits through a failed save and preserves sent latest local source', async () => {
    const ack = deferred(); rpc.mockImplementation(async (m) => m === 'cell.save' ? ack.promise : m === 'notebook.reload' ? diskResult() : {});
    useNotebook.getState().setCellCode('a', 'x = 2');
    const save = useNotebook.getState().saveCell('a', 'x = 2'); await settle();
    useNotebook.getState().setCellCode('a', 'x = 3'); fireExternal();
    const pending = reload(); await settle(); expect(calls('notebook.reload')).toHaveLength(0);
    ack.reject(conflictError()); await save; await pending;
    expect(calls('notebook.reload')[0]![1]).toEqual({ notebookId: 'A', cells: [{ id: 'a', code: 'x = 3' }] });
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 99');
  });

  it('older full-state broadcast cannot replace a clean local source during conflict', () => {
    fireExternal();
    useNotebook.getState().applyNotebookState({ cells: [{ id: 'a', code: 'x = 99' }] });
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 1');
    expect(conflict()).toBeDefined();
  });

  it('close ACK after external notification cannot delete local cache', async () => {
    const ack = deferred(); rpc.mockImplementation(async (m) => m === 'notebook.close' ? ack.promise : []);
    const pending = useNotebook.getState().closeTab('A'); await settle();
    fireExternal(); ack.resolve({}); await pending;
    expect(useNotebooks.getState().tabs).toHaveLength(1); expect(conflict()).toBeDefined();
    expect(useNotebooks.getState().readCache('A')!.cells[0]!.code).toBe('x = 1');
  });

  it('invalid external notification owner/path is ignored', () => {
    fireExternal('unknown'); fireExternal('A', '/wrong.py');
    expect(conflict()).toBeUndefined();
  });

  it('diff save conflict returns to review and does not create generic Retry', async () => {
    useNotebook.setState({ diffs: [{ id: 'd1', targetCellId: 'a', action: 'update', newCode: 'x=2', state: 'proposed', origin: 'agent' }] });
    rpc.mockRejectedValue(conflictError()); await useNotebook.getState().acceptDiff('d1');
    expect(conflict()).toBeDefined(); expect(useNotebook.getState().diffs[0]!.state).toBe('proposed');
    expect(useNotebook.getState().cells[0]!.code).toBe('x = 1');
    expect(useNotebooks.getState().activeTab()!.error).toBeUndefined();
  });

  it('returning from history restores live reload read-only guard', async () => {
    fireExternal(); const ack = deferred(); rpc.mockImplementation(async (m) => m === 'notebook.reload' ? ack.promise : m === 'session.open'
      ? { sessionId: 'past', endedAt: 'old', cells: [{ id: 'a', code: 'x = 0' }] } : {});
    const pending = reload(); await settle(); await useSession.getState().openHistory('past');
    await useSession.getState().backToLive();
    expect(useSession.getState().readOnly).toBe(true);
    ack.resolve(diskResult()); await pending;
  });

  it('new session notifications for background A cannot overwrite B session', () => {
    useNotebook.setState({ notebookPath: '/b.py' });
    useSession.getState().onStarted({ sessionId: 's-A-new', notebookPath: '/a.py' });
    expect(useSession.getState().currentId).toBe('s-A');
    useSession.getState().onEnded({ sessionId: 's-A', notebookPath: '/a.py' });
    expect(useSession.getState().currentEndedAt).toBeNull();
  });
});
