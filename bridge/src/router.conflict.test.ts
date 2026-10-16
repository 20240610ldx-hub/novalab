/** External writes never reload implicitly; explicit reload backs up local source first. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from './router';
import { MultiSupervisor, type KernelTransport } from './supervisor';
import type { KernelRequest, KernelWireMessage, NotebookOpenResult, NotebookState, RpcResponse } from './protocol';
import type { FsEventSource } from './watch';

const initial = (): NotebookState => ({
  cells: [{ id: 'a', code: 'x = 1', defs: ['x'], refs: [], execCount: 0 }],
  dagEdges: [], schemas: [], staleSet: [], execCounts: { a: 0 },
});

class ControlledKernel implements KernelTransport {
  requests: KernelRequest[] = [];
  state = initial();
  loaded = false;
  fail = new Map<string, { code: number; message: string; data?: unknown }>();
  hold?: string;
  held?: KernelRequest;
  private message?: (message: KernelWireMessage) => void;
  private exit?: (code: number | null) => void;
  send(request: KernelRequest) {
    this.requests.push(structuredClone(request));
    if (this.hold === request.method || (request.method === 'load_file' && holdNextLoad)) { this.held = request; return; }
    this.reply(request);
  }
  release() {
    const held = this.held;
    this.hold = undefined;
    this.held = undefined;
    if (held) this.reply(held);
  }
  notify(method: string, params: unknown) { this.message?.({ method, params }); }
  backupPath: string | null = 'local.recovery.py';
  private reply(request: KernelRequest) {
    queueMicrotask(() => {
      const error = this.fail.get(request.method);
      if (error) { this.message?.({ id: request.id, error }); return; }
      let result: unknown = {};
      switch (request.method) {
        case 'load_file':
          if (failNextLoad) {
            failNextLoad = false;
            this.message?.({ id: request.id, error: { code: -32000, message: 'load failed' } });
            return;
          }
          result = structuredClone(this.state);
          this.loaded = true;
          break;
        case 'backup_file': result = { recoveryPath: this.backupPath }; break;
        case 'save_file': result = { ok: true }; break;
        case 'set_cells': {
          const cells = request.params!['cells'] as { id: string; code: string }[];
          this.state.cells = cells.map((c) => ({ ...c, defs: [], refs: [], execCount: 0 }));
          result = { cells: this.state.cells, dagEdges: [], staleSet: ['a'] };
          break;
        }
        case 'validate_cells': result = {}; break;
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

class Source implements FsEventSource {
  callback?: (event: string, filename: string) => void;
  add() {}
  remove() {}
  close() {}
  onEvent(callback: (event: string, filename: string) => void) { this.callback = callback; }
  change(filename: string) { this.callback?.('change', filename); }
}

let multi: MultiSupervisor | undefined;
let router: RpcRouter | undefined;
let directory: string | undefined;
let kernels: ControlledKernel[];
let notes: { method: string; params: unknown }[];
let source: Source;
let id: number;
let failNextLoad = false;
let holdNextLoad = false;
function setup() {
  directory = mkdtempSync(path.join(tmpdir(), 'novalab-conflict-'));
  kernels = [];
  failNextLoad = false;
  holdNextLoad = false;
  notes = [];
  source = new Source();
  id = 0;
  multi = new MultiSupervisor({
    transportFactory: () => { const kernel = new ControlledKernel(); kernels.push(kernel); return kernel; },
    pingIntervalMs: 60_000,
  });
  router = new RpcRouter({
    multi, broadcast: (method, params) => notes.push({ method, params }),
    watcherFactory: () => source, watcherDebounceMs: 1, watcherSuppressMs: 0,
  });
}
async function call(method: string, params?: unknown): Promise<RpcResponse> {
  return router!.handle({ jsonrpc: '2.0', id: ++id, method, params });
}
async function open(name: string) {
  const filename = path.join(directory!, name);
  const response = await call('notebook.open', { path: filename });
  expect(response.error).toBeUndefined();
  return { filename, ...(response.result as NotebookOpenResult) };
}
function liveSession(filename: string) {
  return ([...notes].reverse().find((n) => n.method === 'session.started' && (n.params as { notebookPath: string }).notebookPath === filename)!.params as { sessionId: string }).sessionId;
}
afterEach(() => {
  router?.dispose();
  multi?.stopAll();
  vi.useRealTimers();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('notebook conflict protection', () => {
  it('kernel conflict data survives supervisor and WS errors; failed save and close retain local draft/session', async () => {
    setup();
    const a = await open('a.py');
    const sessionId = liveSession(a.filename);
    const data = { kind: 'external-modification', notebookPath: a.filename, recoveryPath: null, recoveryError: 'backup denied' };
    kernels[0]!.fail.set('save_file', { code: -32002, message: 'file changed externally', data });
    const saved = await call('cell.save', { notebookId: a.notebookId, cellId: 'a', code: 'x = 99' });
    expect(saved.error).toEqual({ code: -32002, message: 'file changed externally', data });
    const closed = await call('notebook.close', { notebookId: a.notebookId });
    expect(closed.error).toEqual(saved.error);
    expect((await call('agent.cellCode', { cellId: 'a' })).result).toEqual({ cellId: 'a', code: 'x = 99' });
    expect((await call('session.open', { notebookPath: a.filename, sessionId })).result).toMatchObject({ endedAt: null });
    expect((await call('notebook.list')).result).toMatchObject([{ notebookId: a.notebookId, kernelState: 'idle' }]);
  });

  it('watcher only notifies the owner, even with clean cache: no load, cache reset, or session turnover', async () => {
    setup();
    const a = await open('a.py');
    const sessionId = liveSession(a.filename);
    kernels[0]!.state.cells[0]!.code = 'external = 2';
    const count = kernels[0]!.requests.length;
    const noteStart = notes.length;
    vi.useFakeTimers();
    source.change(a.filename);
    await vi.advanceTimersByTimeAsync(2);
    expect(kernels[0]!.requests.slice(count)).toEqual([]);
    expect(notes.slice(noteStart)).toEqual([{ method: 'notebook.externalChange', params: { notebookId: a.notebookId, notebookPath: a.filename } }]);
    expect((await call('agent.cellCode', { cellId: 'a' })).result).toEqual({ cellId: 'a', code: 'x = 1' });
    expect((await call('session.open', { notebookPath: a.filename, sessionId })).result).toMatchObject({ endedAt: null });
  });

  it('explicit background reload backs up supplied full draft before load and starts only its own new session', async () => {
    setup();
    const a = await open('a.py');
    const oldSession = liveSession(a.filename);
    const b = await open('b.py');
    const bSession = liveSession(b.filename);
    kernels[0]!.state = { ...initial(), cells: [{ id: 'disk', code: 'on_disk = 2', defs: ['on_disk'], refs: [], execCount: 0 }], execCounts: { disk: 0 } };
    const cells = [{ id: 'a', code: 'x = 50' }, { id: 'unsent', code: 'local_only = 8' }];
    const start = kernels[0]!.requests.length;
    const noteStart = notes.length;
    const loaded = await call('notebook.reload', { notebookId: a.notebookId, cells });
    expect(loaded.error).toBeUndefined();
    expect(loaded.result).toMatchObject({ notebookId: a.notebookId, recoveryPath: 'local.recovery.py', state: { cells: [{ id: 'disk', code: 'on_disk = 2' }] } });
    expect(kernels[0]!.requests.slice(start)).toEqual([
      expect.objectContaining({ method: 'backup_file', params: { path: a.filename, cells } }),
      expect.objectContaining({ method: 'load_file', params: { path: a.filename } }),
    ]);
    expect(notes.slice(noteStart).map((n) => n.method)).toEqual(['session.ended', 'session.started']);
    expect(liveSession(a.filename)).not.toBe(oldSession);
    expect(liveSession(b.filename)).toBe(bSession);
    expect((await call('agent.cellCode', { cellId: 'a' })).result).toEqual({ cellId: 'a', code: 'x = 1' });
    expect((await call('session.open', { notebookPath: a.filename, sessionId: oldSession })).result).toMatchObject({ endedAt: expect.any(String) });
    expect((await call('notebook.switch', { notebookId: a.notebookId })).result).toMatchObject({ state: { cells: [{ id: 'disk' }] } });
    expect(kernels[1]!.requests.filter((r) => r.method === 'backup_file')).toEqual([]);
  });

  it.each(['backup_file', 'load_file'])('%s failure preserves cache, proposal, and old session, and allows retry', async (method) => {
    setup();
    const a = await open('a.py');
    const sessionId = liveSession(a.filename);
    const staged = await call('diff.stage', { targetCellId: 'a', action: 'update', newCode: 'x = 2' });
    expect(staged.error).toBeUndefined();
    kernels[0]!.fail.set(method, { code: -32000, message: 'test failure' });
    const start = kernels[0]!.requests.length;
    const noteStart = notes.length;
    const failed = await call('notebook.reload', { notebookId: a.notebookId });
    expect(failed.error).toMatchObject({ code: -32000, message: 'test failure' });
    expect(kernels[0]!.requests.slice(start).map((r) => r.method)).toEqual(method === 'backup_file' ? ['backup_file'] : ['backup_file', 'load_file']);
    expect(notes.slice(noteStart)).toEqual([]);
    expect((await call('agent.cellCode', { cellId: 'a' })).result).toEqual({ cellId: 'a', code: 'x = 1' });
    expect((await call('session.open', { notebookPath: a.filename, sessionId })).result).toMatchObject({ endedAt: null });
    kernels[0]!.fail.clear();
    expect((await call('notebook.reload', { notebookId: a.notebookId })).error).toBeUndefined();
    expect((await call('diff.accept', { diffId: (staged.result as { diffId: string }).diffId })).error?.code).toBe(-32602);
  });

  it('reload requires a usable backup path and preserves failed-save dirty cache until successful reload', async () => {
    setup();
    const a = await open('a.py');
    const kernel = kernels[0]!;
    const sessionId = liveSession(a.filename);
    kernel.fail.set('save_file', { code: -32002, message: 'external edit' });
    expect((await call('cell.save', { notebookId: a.notebookId, cellId: 'a', code: 'x = 77' })).error?.code).toBe(-32002);
    kernel.backupPath = null;
    const start = kernel.requests.length;
    expect((await call('notebook.reload', { notebookId: a.notebookId })).error?.code).toBe(-32000);
    expect(kernel.requests.slice(start).map((r) => r.method)).toEqual(['backup_file']);
    expect((await call('session.open', { notebookPath: a.filename, sessionId })).result).toMatchObject({ endedAt: null });
    expect((await call('agent.cellCode', { cellId: 'a' })).result).toEqual({ cellId: 'a', code: 'x = 77' });
    // If cache persistence were cleared by failed reload, a dead close would discard it.
    kernel.kill();
    expect((await call('notebook.close', { notebookId: a.notebookId })).error).toMatchObject({ code: -32000, message: expect.stringContaining('unsaved') });
  });

  it('successful reload clears previous output/proposals and dirty state without any user-code execution', async () => {
    setup();
    const a = await open('a.py');
    const kernel = kernels[0]!;
    kernel.notify('run.started', { cellId: 'a' });
    kernel.notify('run.error', { cellId: 'a', traceback: 'old error', frames: [] });
    expect((await call('agent.cellOutput', { cellId: 'a' })).result).toMatchObject({ traceback: 'old error' });
    const staged = await call('diff.stage', { targetCellId: 'a', action: 'update', newCode: 'x = 3' });
    kernel.fail.set('save_file', { code: -32002, message: 'external edit' });
    await call('cell.save', { notebookId: a.notebookId, cellId: 'a', code: 'x = 90' });
    kernel.fail.clear();
    kernel.state = initial();
    const start = kernel.requests.length;
    const reloaded = await call('notebook.reload', { notebookId: a.notebookId });
    expect(reloaded.error).toBeUndefined();
    expect(kernel.requests.slice(start).map((r) => r.method)).toEqual(['backup_file', 'load_file']);
    expect(kernel.requests[start]!.params!['cells']).toEqual([{ id: 'a', code: 'x = 90' }]);
    expect((await call('agent.cellOutput', { cellId: 'a' })).result).toEqual({ traceback: null, mimeKeys: [] });
    expect((await call('diff.accept', { diffId: (staged.result as { diffId: string }).diffId })).error?.code).toBe(-32602);
    kernel.kill();
    expect((await call('notebook.close', { notebookId: a.notebookId })).result).toEqual({ notebookId: a.notebookId, closed: true });
  });

  it('reload validates explicit IDs and cells before any backup/load; empty full document is valid', async () => {
    setup();
    const a = await open('a.py');
    const start = kernels[0]!.requests.length;
    for (const notebookId of [undefined, null, 5, '', 'nb-missing']) {
      expect((await call('notebook.reload', { notebookId })).error?.code).toBe(-32602);
    }
    for (const cells of [null, {}, [null], [{ id: 'a' }], [{ id: 5, code: '' }], [{ id: 'a', code: 4 }], [{ id: 'a', code: '' }, { id: 'a', code: '' }]]) {
      expect((await call('notebook.reload', { notebookId: a.notebookId, cells })).error?.code).toBe(-32602);
    }
    expect(kernels[0]!.requests.slice(start)).toEqual([]);
    expect((await call('notebook.reload', { notebookId: a.notebookId, cells: [] })).error).toBeUndefined();
    expect(kernels[0]!.requests.slice(start)[0]!.params).toEqual({ path: a.filename, cells: [] });
  });

  it('clean dead restart is owner-addressed, cold-only, and clears old runtime projections', async () => {
    setup();
    const a = await open('a.py');
    const kernel = kernels[0]!;
    kernel.notify('run.started', { cellId: 'a' });
    kernel.notify('run.error', { cellId: 'a', traceback: 'old', frames: [] });
    const staged = await call('diff.stage', { targetCellId: 'a', action: 'update', newCode: 'x = 2' });
    kernel.kill();
    const start = kernel.requests.length;
    const restarted = await call('kernel.restart', { notebookId: a.notebookId });
    expect(restarted.error).toBeUndefined();
    expect(restarted.result).toMatchObject({ notebookId: a.notebookId, notebookPath: a.filename });
    expect(kernels[0]!.requests.slice(start).map((request) => request.method)).toEqual([]);
    expect(kernels[1]!.requests.map((request) => request.method)).toEqual(['load_file']);
    expect((await call('agent.cellOutput', { cellId: 'a' })).result).toEqual({ traceback: null, mimeKeys: [] });
    expect((await call('diff.accept', { diffId: (staged.result as { diffId: string }).diffId })).error?.code).toBe(-32602);
  });

  it('dirty dead restart refuses without transport request and preserves local cache', async () => {
    setup();
    const a = await open('a.py');
    const kernel = kernels[0]!;
    kernel.fail.set('save_file', { code: -32000, message: 'disk unavailable' });
    const saved = await call('cell.save', { notebookId: a.notebookId, cellId: 'a', code: 'x = 9' });
    expect(saved.error?.code).toBe(-32000);
    kernel.fail.clear();
    kernel.kill();
    const start = kernel.requests.length;
    const refused = await call('kernel.restart', { notebookId: a.notebookId });
    expect(refused.error?.code).toBe(-32000);
    expect(kernel.requests.slice(start)).toEqual([]);
    expect((await call('agent.cellCode', { cellId: 'a' })).result).toEqual({ cellId: 'a', code: 'x = 9' });
  });

  it('restart failure keeps old dead session state and does not start a replacement session', async () => {
    setup();
    const a = await open('a.py');
    const firstSession = liveSession(a.filename);
    kernels[0]!.kill();
    failNextLoad = true;
    const noteStart = notes.length;
    const failed = await call('kernel.restart', { notebookId: a.notebookId });
    expect(failed.error?.code).toBe(-32000);
    expect(notes.slice(noteStart).map((note) => note.method)).not.toContain('session.started');
    expect((await call('session.open', { notebookPath: a.filename, sessionId: firstSession })).result).toMatchObject({ endedAt: expect.any(String) });
    expect((await call('notebook.list')).result).toMatchObject([{ notebookId: a.notebookId, ended: true, kernelState: 'dead' }]);
  });

  it('duplicate restart is rejected while the first owner restart is in flight', async () => {
    setup();
    const a = await open('a.py');
    kernels[0]!.kill();
    holdNextLoad = true;
    const first = call('kernel.restart', { notebookId: a.notebookId });
    await vi.waitFor(() => expect(kernels[1]!.held).toBeDefined());
    const duplicate = await call('kernel.restart', { notebookId: a.notebookId });
    expect(duplicate.error?.message).toContain('already in progress');
    kernels[1]!.release();
    expect((await first).error).toBeUndefined();
  });

  it('restart waits behind a previously received save in the owner FIFO', async () => {
    setup();
    const a = await open('a.py');
    const kernel = kernels[0]!;
    kernel.hold = 'save_file';
    const saved = call('cell.save', { notebookId: a.notebookId, cellId: 'a', code: 'x = 8' });
    await vi.waitFor(() => expect(kernel.held).toBeDefined());
    const restarted = call('kernel.restart', { notebookId: a.notebookId });
    expect(kernels.length).toBe(1);
    kernel.release();
    expect((await saved).error).toBeUndefined();
    expect((await restarted).error).toBeUndefined();
    expect(kernels).toHaveLength(2);
    expect(kernels[1]!.requests.map((request) => request.method)).toEqual(['load_file']);
  });

  it('reload waits for queued save and backs up latest cache, while close waits for backup/load', async () => {
    setup();
    const a = await open('a.py');
    const kernel = kernels[0]!;
    kernel.hold = 'save_file';
    const saved = call('cell.save', { notebookId: a.notebookId, cellId: 'a', code: 'x = 88' });
    await vi.waitFor(() => expect(kernel.held).toBeDefined());
    const start = kernel.requests.length;
    const reload = call('notebook.reload', { notebookId: a.notebookId });
    const close = call('notebook.close', { notebookId: a.notebookId });
    await Promise.resolve();
    expect(kernel.requests.slice(start)).toEqual([]);
    kernel.release();
    expect((await saved).error).toBeUndefined();
    expect((await reload).error).toBeUndefined();
    expect((await close).error).toBeUndefined();
    expect(kernel.requests.slice(start).map((r) => r.method)).toEqual(['backup_file', 'load_file', 'save_file']);
    expect(kernel.requests[start]!.params!['cells']).toEqual([{ id: 'a', code: 'x = 88' }]);
    expect((await call('notebook.reload', { notebookId: a.notebookId })).error?.code).toBe(-32602);
  });
});
