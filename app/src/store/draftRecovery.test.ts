/**
 * 第 7 轮：跨应用 dirty 草稿有界恢复（前端语义）。
 * - 只有在去抖后仍未保存的草稿才写恢复日志（draft.write）；正常自动保存成功则不写；断线不写；
 * - 写过日志的 tab 保存后无剩余草稿 → draft.clear；
 * - 重开只提示：指纹一致可"恢复草稿"（回到本地草稿、不发 cell.save、不写盘）；
 *   不一致只能"保存为本地副本"（draft.preserve）或丢弃；等待期间该 tab 保存成功 → 降级为不一致。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cell } from '../kernel/types';

type StatusEvent = { status: 'idle' | 'connected' | 'reconnecting' | 'down'; generation: number; newInstance: boolean };

const { rpc, statusListeners } = vi.hoisted(() => ({
  rpc: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(),
  statusListeners: [] as ((e: StatusEvent) => void)[],
}));
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

let saveFails = true;
beforeEach(async () => {
  vi.useFakeTimers(); rpc.mockReset(); saveFails = true;
  rpc.mockImplementation(async (m) => {
    if (m === 'notebook.list') return [tab('A', '/a.py')];
    if (m === 'cell.save') {
      if (saveFails) throw new Error('permission denied');
      return { dagEdges: [], staleSet: [], baselineSha256: 'sha-saved' };
    }
    if (m === 'draft.write') return { draftId: '1-aaaaaaaa', bytes: 10 };
    if (m === 'draft.clear') return { removed: 1 };
    return {};
  });
  useNotebooks.setState({ tabs: [tab('A', '/a.py', { baselineSha256: 'sha-A' })], activeId: 'A', caches: {} });
  useNotebook.setState({ ...emptyCache(), notebookPath: '/a.py', historyView: false, kernelState: 'live',
    bridgeConnected: true, cascadeAsk: null,
    cells: [cell('a'), cell('b', 'y = x'), cell(REPL_CELL_ID, '1 + 1', { kind: 'repl' })] });
  useSession.setState({ readOnly: false, viewingId: null, viewingEndedAt: null, currentId: 's-A', sessions: [], currentEndedAt: null });
  await useNotebook.getState().connectBridge();
  emit({ status: 'connected', generation: 1, newInstance: false });
  await settle();
  rpc.mockClear();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('recovery journal writes', () => {
  it('journals a draft that is still unsaved after the debounce: persistent cells only, id/code only', async () => {
    useNotebook.getState().setCellCode('a', 'x = 2');
    await vi.advanceTimersByTimeAsync(DRAFT_JOURNAL_DEBOUNCE_MS + CELL_SAVE_DEBOUNCE_MS);
    expect(calls('cell.save')).toHaveLength(1);
    expect(calls('draft.write')).toEqual([['draft.write', {
      notebookId: 'A', dirtyCellIds: ['a'],
      cells: [{ id: 'a', code: 'x = 2' }, { id: 'b', code: 'y = x' }],
    }]]);
    expect(JSON.stringify(calls('draft.write'))).not.toContain('secret output');
  });

  it('writes nothing when autosave succeeded within the debounce', async () => {
    saveFails = false;
    useNotebook.getState().setCellCode('a', 'x = 2');
    await vi.advanceTimersByTimeAsync(DRAFT_JOURNAL_DEBOUNCE_MS * 2);
    expect(calls('cell.save')).toHaveLength(1);
    expect(calls('draft.write')).toHaveLength(0);
    expect(calls('draft.clear')).toHaveLength(0);
  });

  it('does not journal while the bridge is disconnected', async () => {
    emit({ status: 'reconnecting', generation: 1, newInstance: false });
    useNotebook.getState().setCellCode('a', 'x = 2');
    await vi.advanceTimersByTimeAsync(DRAFT_JOURNAL_DEBOUNCE_MS * 2);
    expect(calls('draft.write')).toHaveLength(0);
  });

  it('clears the journal once a later save leaves the tab without drafts', async () => {
    useNotebook.getState().setCellCode('a', 'x = 2');
    await vi.advanceTimersByTimeAsync(DRAFT_JOURNAL_DEBOUNCE_MS + CELL_SAVE_DEBOUNCE_MS);
    expect(calls('draft.write')).toHaveLength(1);
    saveFails = false;
    useNotebook.getState().setCellCode('a', 'x = 3');
    await vi.advanceTimersByTimeAsync(CELL_SAVE_DEBOUNCE_MS * 3);
    expect(tabOf('A')!.dirty).toBe(false);
    expect(calls('draft.clear')).toEqual([['draft.clear', { notebookId: 'A' }]]);
  });
});

describe('offer on reopen (never applied automatically)', () => {
  const offer = (baselineMatches: boolean) => ({
    draftId: '9-bbbbbbbb', savedAt: '2026-10-17T08:00:00.000Z', baselineMatches,
    dirtyCellIds: ['c'], cells: [{ id: 'c', code: 'z = 2  # recovered' }],
  });
  async function openWith(baselineMatches: boolean) {
    rpc.mockImplementation(async (m) => {
      if (m === 'notebook.open') {
        return { notebookId: 'C', state: { cells: [{ id: 'c', code: 'z = 1' }], baselineSha256: 'sha-C' }, draftRecovery: offer(baselineMatches) };
      }
      if (m === 'notebook.list') return [tab('A', '/a.py'), tab('C', '/c.py')];
      if (m === 'cell.save') return { dagEdges: [], staleSet: [], baselineSha256: 'sha-C2' };
      if (m === 'draft.preserve') return { recoveryPath: '/c.py.novalab-recovery-1.py' };
      if (m === 'draft.clear') return { removed: 1 };
      return {};
    });
    await useNotebook.getState().openNotebook('/c.py');
    await settle();
  }

  it('shows the offer and leaves the disk version in the editor', async () => {
    await openWith(true);
    expect(tabOf('C')!.draftRecovery).toMatchObject({ draftId: '9-bbbbbbbb', baselineMatches: true });
    expect(useNotebook.getState().cells[0]!.code).toBe('z = 1');
    expect(tabOf('C')!.dirty).toBe(false);
  });

  it('restore puts the drafts back as unsaved local drafts without sending cell.save', async () => {
    await openWith(true);
    useNotebook.getState().restoreDraft('C');
    await vi.advanceTimersByTimeAsync(DRAFT_JOURNAL_DEBOUNCE_MS * 2);
    expect(useNotebook.getState().cells[0]!.code).toBe('z = 2  # recovered');
    expect(useNotebooks.getState().readCache('C')!.drafts.c!.code).toBe('z = 2  # recovered');
    expect(tabOf('C')!.dirty).toBe(true);
    expect(tabOf('C')!.draftRecovery).toBeUndefined();
    expect(calls('cell.save')).toHaveLength(0);
  });

  it('restore is refused when the fingerprint did not match', async () => {
    await openWith(false);
    useNotebook.getState().restoreDraft('C');
    expect(useNotebook.getState().cells[0]!.code).toBe('z = 1');
    expect(tabOf('C')!.draftRecovery).toMatchObject({ baselineMatches: false });
  });

  it('preserve writes a local copy via draft.preserve and shows its path', async () => {
    await openWith(false);
    await useNotebook.getState().preserveDraft('C');
    expect(calls('draft.preserve')).toEqual([['draft.preserve', { notebookId: 'C', draftId: '9-bbbbbbbb' }]]);
    expect(tabOf('C')!.recoveryPath).toBe('/c.py.novalab-recovery-1.py');
    expect(tabOf('C')!.draftRecovery).toBeUndefined();
    expect(useNotebook.getState().cells[0]!.code).toBe('z = 1');
  });

  it('discard clears the journal and the offer', async () => {
    await openWith(true);
    await useNotebook.getState().discardDraft('C');
    expect(calls('draft.clear')).toEqual([['draft.clear', { notebookId: 'C' }]]);
    expect(tabOf('C')!.draftRecovery).toBeUndefined();
  });

  it('a successful save while the offer is pending downgrades it to "changed"', async () => {
    await openWith(true);
    useNotebook.getState().setCellCode('c', 'z = 5');
    await vi.advanceTimersByTimeAsync(CELL_SAVE_DEBOUNCE_MS * 3);
    expect(calls('cell.save')).toHaveLength(1);
    expect(tabOf('C')!.draftRecovery).toMatchObject({ baselineMatches: false });
    expect(calls('draft.clear')).toHaveLength(0);
  });
});
