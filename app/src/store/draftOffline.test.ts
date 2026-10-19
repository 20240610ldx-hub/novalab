/**
 * 第 7 轮后续（Owner 2026-10-17 批准 O1–O6）：bridge 断线 / bridge-lost 时由 Tauri Rust 命令
 * write_draft_journal 写同格式恢复日志；在线仍走 bridge draft.write；浏览器 dev 不写。
 * 指纹用前端 tab 最后确认的 baselineSha256（D4）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cell } from '../kernel/types';

type StatusEvent = { status: 'idle' | 'connected' | 'reconnecting' | 'down'; generation: number; newInstance: boolean };

const { rpc, statusListeners, invoke, tauri } = vi.hoisted(() => ({
  rpc: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(),
  statusListeners: [] as ((e: StatusEvent) => void)[],
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(),
  tauri: { on: true },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => tauri.on }));
vi.mock('../bridge/client', async (load) => ({
  ...await load<typeof import('../bridge/client')>(),
  bridge: {
    rpc,
    connect: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    onNotification: () => () => {},
    onStatus: (listener: (e: StatusEvent) => void) => { statusListeners.push(listener); return () => {}; },
  },
}));
import { useNotebook, CELL_SAVE_DEBOUNCE_MS, DRAFT_JOURNAL_DEBOUNCE_MS, REPL_CELL_ID } from './notebook';
import { emptyCache, useNotebooks, type NotebookTab } from './notebooks';
import { useSession } from './session';

const SHA_A = 'a'.repeat(64);
function cell(id = 'a', code = 'x = 1', over: Partial<Cell> = {}): Cell {
  return { id, code, execCount: 3, status: 'idle', defs: [], refs: [], sideEffect: false,
    kind: 'code', output: { stdout: 'secret output', stderr: '', mime: {}, traceback: null, writes: [] }, ...over };
}
function tab(id: string, path: string, over: Partial<NotebookTab> = {}): NotebookTab {
  return { notebookId: id, path, kernelState: 'idle', cellCount: 2, ended: false, rssMB: null, dirty: false, ...over };
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function calls(method: string) { return rpc.mock.calls.filter(([m]) => m === method); }
function emit(e: StatusEvent) { for (const l of statusListeners) l(e); }
function tabOf(id: string) { return useNotebooks.getState().tabs.find((t) => t.notebookId === id); }
const expectedCells = [{ id: 'a', code: 'x = 2' }, { id: 'b', code: 'y = x' }];

beforeEach(async () => {
  vi.useFakeTimers(); rpc.mockReset(); invoke.mockReset(); tauri.on = true;
  rpc.mockImplementation(async (m) => {
    if (m === 'notebook.list') return [tab('A', 'D:\\nb\\a.py')];
    if (m === 'cell.save') return { dagEdges: [], staleSet: [], baselineSha256: 'b'.repeat(64) };
    if (m === 'draft.write') return { draftId: '1-aaaaaaaa', bytes: 10 };
    if (m === 'draft.clear') return { removed: 1 };
    return {};
  });
  invoke.mockImplementation(async (cmd) => (cmd === 'write_draft_journal' ? { draftId: '2-bbbbbbbb', bytes: 20 } : true));
  useNotebooks.setState({ tabs: [tab('A', 'D:\\nb\\a.py', { baselineSha256: SHA_A })], activeId: 'A', caches: {} });
  useNotebook.setState({ ...emptyCache(), notebookPath: 'D:\\nb\\a.py', historyView: false, kernelState: 'live',
    bridgeConnected: true, cascadeAsk: null,
    cells: [cell('a'), cell('b', 'y = x'), cell(REPL_CELL_ID, 'secret_repl = 1', { kind: 'repl' })] });
  useSession.setState({ readOnly: false, viewingId: null, viewingEndedAt: null, currentId: 's-A', sessions: [], currentEndedAt: null });
  await useNotebook.getState().connectBridge();
  emit({ status: 'connected', generation: 1, newInstance: false });
  await settle();
  rpc.mockClear(); invoke.mockClear();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('offline draft journal via Tauri', () => {
  it('while reconnecting: writes through write_draft_journal with the tab fingerprint, not through the bridge', async () => {
    emit({ status: 'reconnecting', generation: 1, newInstance: false });
    useNotebook.getState().setCellCode('a', 'x = 2');
    await vi.advanceTimersByTimeAsync(DRAFT_JOURNAL_DEBOUNCE_MS + 100);
    expect(invoke.mock.calls.filter(([c]) => c === 'write_draft_journal')).toEqual([['write_draft_journal', {
      notebookPath: 'D:\\nb\\a.py', baselineSha256: SHA_A, cells: expectedCells, dirtyCellIds: ['a'],
    }]]);
    expect(calls('draft.write')).toHaveLength(0);
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('secret');
    expect(tabOf('A')!.draftJournaled).toBe(true);
  });

  it('bridge-lost tab (new bridge generation): also journaled through Tauri', async () => {
    emit({ status: 'reconnecting', generation: 1, newInstance: false });
    emit({ status: 'connected', generation: 2, newInstance: true });
    await settle();
    expect(tabOf('A')!.bridgeLost).toBe(true);
    useNotebook.getState().setCellCode('a', 'x = 2');
    await vi.advanceTimersByTimeAsync(DRAFT_JOURNAL_DEBOUNCE_MS + 100);
    expect(invoke.mock.calls.filter(([c]) => c === 'write_draft_journal')).toHaveLength(1);
    expect(calls('draft.write')).toHaveLength(0);
  });

  it('unknown tab fingerprint is sent as null', async () => {
    useNotebooks.setState({ tabs: [tab('A', 'D:\\nb\\a.py')] });
    emit({ status: 'down', generation: 1, newInstance: false });
    useNotebook.getState().setCellCode('a', 'x = 2');
    await vi.advanceTimersByTimeAsync(DRAFT_JOURNAL_DEBOUNCE_MS + 100);
    expect(invoke.mock.calls.find(([c]) => c === 'write_draft_journal')?.[1]).toMatchObject({ baselineSha256: null });
  });

  it('browser dev (no Tauri): nothing is written while offline', async () => {
    tauri.on = false;
    emit({ status: 'reconnecting', generation: 1, newInstance: false });
    useNotebook.getState().setCellCode('a', 'x = 2');
    await vi.advanceTimersByTimeAsync(DRAFT_JOURNAL_DEBOUNCE_MS * 2);
    expect(invoke.mock.calls.filter(([c]) => c === 'write_draft_journal')).toHaveLength(0);
    expect(calls('draft.write')).toHaveLength(0);
  });

  it('online: the bridge stays the writer even inside Tauri (O6)', async () => {
    rpc.mockImplementation(async (m) => {
      if (m === 'cell.save') throw new Error('permission denied');
      if (m === 'draft.write') return { draftId: '1-aaaaaaaa', bytes: 10 };
      return {};
    });
    useNotebook.getState().setCellCode('a', 'x = 2');
    await vi.advanceTimersByTimeAsync(DRAFT_JOURNAL_DEBOUNCE_MS + CELL_SAVE_DEBOUNCE_MS);
    expect(calls('draft.write')).toHaveLength(1);
    expect(invoke.mock.calls.filter(([c]) => c === 'write_draft_journal')).toHaveLength(0);
  });

  it('an over-limit offline copy shows the round-7 notice', async () => {
    invoke.mockImplementation(async () => { throw 'draft journal is 3000000 bytes; limit is 2097152'; });
    emit({ status: 'reconnecting', generation: 1, newInstance: false });
    useNotebook.getState().setCellCode('a', 'x = 2');
    await vi.advanceTimersByTimeAsync(DRAFT_JOURNAL_DEBOUNCE_MS + 100);
    expect(tabOf('A')!.draftJournalError).toContain('2 MB');
  });

  it('after reconnecting to the same bridge, the resumed save clears the offline journal', async () => {
    emit({ status: 'reconnecting', generation: 1, newInstance: false });
    useNotebook.getState().setCellCode('a', 'x = 2');
    await vi.advanceTimersByTimeAsync(DRAFT_JOURNAL_DEBOUNCE_MS + 100);
    expect(tabOf('A')!.draftJournaled).toBe(true);
    emit({ status: 'connected', generation: 1, newInstance: false });
    await settle();
    await vi.advanceTimersByTimeAsync(CELL_SAVE_DEBOUNCE_MS * 3);
    expect(calls('cell.save').length).toBeGreaterThanOrEqual(1);
    expect(tabOf('A')!.dirty).toBe(false);
    expect(calls('draft.clear')).toEqual([['draft.clear', { notebookId: 'A' }]]);
  });
});
