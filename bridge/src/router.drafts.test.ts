/**
 * 第 7 轮：draft.* RPC 与 notebook.open 的 draftRecovery。
 * 日志写在 notebook 旁 .novalab/drafts；基线指纹由 bridge 记录（不信前端）；
 * 重开只提示、不自动应用；指纹不一致只能保存为本地副本（第 4 轮 backup_file）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RpcRouter } from './router';
import { MultiSupervisor, type KernelTransport } from './supervisor';
import type { KernelRequest, KernelWireMessage, NotebookOpenResult, RpcResponse } from './protocol';
import { listDraftIds, readLatestDraft, writeDraft } from './drafts';

const backups: { cells: unknown }[] = [];
const kernels: DraftKernel[] = [];
class DraftKernel implements KernelTransport {
  private message?: (message: KernelWireMessage) => void;
  private exit?: (code: number | null) => void;
  constructor() { kernels.push(this); }
  send(request: KernelRequest) {
    queueMicrotask(() => {
      let result: unknown = {};
      switch (request.method) {
        case 'load_file':
          result = {
            cells: [{ id: 'a', code: 'x = 1', defs: ['x'], refs: [] }, { id: 'b', code: 'y = x', defs: ['y'], refs: ['x'] }],
            dagEdges: [], schemas: [], staleSet: [], execCounts: { a: 0, b: 0 }, baselineSha256: 'sha-disk',
          };
          break;
        case 'backup_file':
          backups.push({ cells: request.params!['cells'] });
          result = { recoveryPath: path.join(path.dirname(String(request.params!['path'])), 'a.py.novalab-recovery-x.py') };
          break;
        case 'save_file': result = { ok: true, baselineSha256: 'sha-saved' }; break;
        case 'set_cells': {
          const cells = request.params!['cells'] as { id: string; code: string }[];
          result = { cells: cells.map((c) => ({ ...c, defs: [], refs: [] })), dagEdges: [], staleSet: [] };
          break;
        }
        case 'introspect': result = { schemas: [] }; break;
        case 'ping': result = { pong: true }; break;
      }
      this.message?.({ id: request.id, result });
    });
  }
  onMessage(callback: (message: KernelWireMessage) => void) { this.message = callback; }
  onExit(callback: (code: number | null) => void) { this.exit = callback; }
  kill() { this.exit?.(null); }
}

let work: string;
let nbPath: string;
let multi: MultiSupervisor | undefined;
let router: RpcRouter | undefined;
let id = 0;
function setup() {
  work = mkdtempSync(path.join(tmpdir(), 'novalab-router-drafts-'));
  nbPath = path.join(work, 'a.py');
  writeFileSync(nbPath, '# %% [cell-id: a]\nx = 1\n');
  multi = new MultiSupervisor({ transportFactory: () => new DraftKernel(), pingIntervalMs: 60_000 });
  router = new RpcRouter({ multi, broadcast: () => {} });
}
async function call(method: string, params?: unknown): Promise<RpcResponse> {
  return router!.handle({ jsonrpc: '2.0', id: ++id, method, params });
}
async function open(): Promise<NotebookOpenResult & { draftRecovery?: Record<string, unknown> }> {
  const res = await call('notebook.open', { path: nbPath });
  expect(res.error).toBeUndefined();
  return res.result as NotebookOpenResult & { draftRecovery?: Record<string, unknown> };
}
const cells = [{ id: 'a', code: 'x = 2  # draft' }, { id: 'b', code: 'y = x' }];
afterEach(() => {
  router?.dispose();
  multi?.stopAll();
  router = undefined;
  multi = undefined;
  backups.length = 0;
  kernels.length = 0;
  rmSync(work, { recursive: true, force: true });
});

describe('draft.write / draft.clear', () => {
  it('records the bridge-side baseline (ignores any client fingerprint) and returns the draft id', async () => {
    setup();
    const { notebookId } = await open();
    const res = await call('draft.write', { notebookId, cells, dirtyCellIds: ['a'], baselineSha256: 'sha-from-client' });
    expect(res.error).toBeUndefined();
    const { draftId } = res.result as { draftId: string; bytes: number };
    const stored = readLatestDraft(nbPath)!;
    expect(stored.draftId).toBe(draftId);
    expect(stored.baselineSha256).toBe('sha-disk');
    expect(stored.cells).toEqual(cells);
    expect(stored.dirtyCellIds).toEqual(['a']);
  });

  it('rejects malformed payloads and unknown notebooks', async () => {
    setup();
    const { notebookId } = await open();
    expect((await call('draft.write', { notebookId, cells: 'x', dirtyCellIds: [] })).error).toBeDefined();
    expect((await call('draft.write', { notebookId, cells: [{ id: 'a' }], dirtyCellIds: [] })).error).toBeDefined();
    expect((await call('draft.write', { notebookId, cells, dirtyCellIds: [1] })).error).toBeDefined();
    expect((await call('draft.write', { notebookId: 'nb-missing', cells, dirtyCellIds: ['a'] })).error).toBeDefined();
    expect(listDraftIds(nbPath)).toEqual([]);
  });

  it('still journals after the kernel died (bridge-side write, baseline kept)', async () => {
    setup();
    const { notebookId } = await open();
    kernels[0]!.kill();
    const res = await call('draft.write', { notebookId, cells, dirtyCellIds: ['a'] });
    expect(res.error).toBeUndefined();
    expect(readLatestDraft(nbPath)!.baselineSha256).toBe('sha-disk');
  });

  it('reports an over-limit copy as invalid params and writes nothing', async () => {
    setup();
    const { notebookId } = await open();
    const res = await call('draft.write', { notebookId, cells: [{ id: 'a', code: 'x'.repeat(2 * 1024 * 1024) }], dirtyCellIds: ['a'] });
    expect(res.error?.code).toBe(-32602);
    expect(listDraftIds(nbPath)).toEqual([]);
  });

  it('draft.clear removes every copy of that notebook', async () => {
    setup();
    const { notebookId } = await open();
    await call('draft.write', { notebookId, cells, dirtyCellIds: ['a'] });
    const res = await call('draft.clear', { notebookId });
    expect(res.result).toEqual({ removed: 1 });
    expect(listDraftIds(nbPath)).toEqual([]);
  });
});

describe('notebook.open offers (never applies) the latest journal', () => {
  it('matching fingerprint → baselineMatches true with the journal cells; disk state is unchanged', async () => {
    setup();
    const { draftId } = writeDraft(nbPath, { baselineSha256: 'sha-disk', cells, dirtyCellIds: ['a'] });
    const opened = await open();
    expect(opened.state.cells[0]!.code).toBe('x = 1');
    expect(opened.draftRecovery).toMatchObject({ draftId, baselineMatches: true, dirtyCellIds: ['a'], cells });
    expect(typeof opened.draftRecovery!['savedAt']).toBe('string');
  });

  it('different or missing fingerprint → baselineMatches false', async () => {
    setup();
    writeDraft(nbPath, { baselineSha256: 'sha-older', cells, dirtyCellIds: ['a'] });
    expect((await open()).draftRecovery).toMatchObject({ baselineMatches: false });
  });

  it('unknown fingerprint is treated as changed', async () => {
    setup();
    writeDraft(nbPath, { baselineSha256: null, cells, dirtyCellIds: ['a'] });
    expect((await open()).draftRecovery).toMatchObject({ baselineMatches: false });
  });

  it('a journal whose dirty cells already equal the disk is dropped silently', async () => {
    setup();
    writeDraft(nbPath, { baselineSha256: 'sha-older', cells: [{ id: 'a', code: 'x = 1' }, { id: 'b', code: 'y = x' }], dirtyCellIds: ['a'] });
    expect((await open()).draftRecovery).toBeUndefined();
    expect(listDraftIds(nbPath)).toEqual([]);
  });

  it('re-opening an already open notebook does not offer the journal again', async () => {
    setup();
    await open();
    writeDraft(nbPath, { baselineSha256: 'sha-disk', cells, dirtyCellIds: ['a'] });
    expect((await open()).draftRecovery).toBeUndefined();
  });
});

describe('draft.preserve', () => {
  it('writes the journal cells as a round-4 recovery copy, clears the journal and leaves the notebook alone', async () => {
    setup();
    const { draftId } = writeDraft(nbPath, { baselineSha256: 'sha-older', cells, dirtyCellIds: ['a'] });
    const { notebookId } = await open();
    const before = readFileSync(nbPath, 'utf8');
    const res = await call('draft.preserve', { notebookId, draftId });
    expect(res.error).toBeUndefined();
    expect((res.result as { recoveryPath: string }).recoveryPath).toContain('novalab-recovery');
    expect(backups).toEqual([{ cells }]);
    expect(listDraftIds(nbPath)).toEqual([]);
    expect(readFileSync(nbPath, 'utf8')).toBe(before);
  });

  it('rejects an unknown draft id without calling backup_file', async () => {
    setup();
    const { notebookId } = await open();
    const res = await call('draft.preserve', { notebookId, draftId: '1-deadbeef' });
    expect(res.error?.code).toBe(-32602);
    expect(backups).toEqual([]);
  });
});
