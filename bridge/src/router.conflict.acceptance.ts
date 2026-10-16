/** External disk edits must survive background saves and clean closes. */
import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { RpcRouter } from './router';
import { MultiSupervisor, StdioKernelTransport } from './supervisor';
import type { NotebookOpenResult, RpcResponse } from './protocol';

const pyDir = fileURLToPath(new URL('../../py/', import.meta.url));
const python = path.join(pyDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
let multi: MultiSupervisor | undefined;
let directory: string | undefined;
let exited: Promise<void>[] = [];

afterEach(async () => {
  multi?.stopAll();
  await Promise.all(exited);
  multi = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

for (const operation of ['save', 'close'] as const) {
  it(`real external edit: background ${operation} preserves disk and local source`, async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'novalab-file-conflict-'));
    exited = [];
    const aPath = path.join(directory, 'a.py');
    const bPath = path.join(directory, 'b.py');
    const original = '# %% [cell-id: aaaaaaaa]\nx = 1\n';
    const external = '# %% [cell-id: aaaaaaaa]\nx = 9\n\n# %% [cell-id: bbbbbbbb]\ny = x + 99\n';
    writeFileSync(aPath, original, 'utf8');
    writeFileSync(bPath, original, 'utf8');
    const notifications: { method: string; params: unknown }[] = [];
    multi = new MultiSupervisor({
      transportFactory: () => new StdioKernelTransport(pyDir, { NOVALAB_PACKAGED: '0', NOVALAB_PY_DIR: pyDir }, {
        spawnImpl: ((command: string, args: readonly string[], options: SpawnOptions) => {
          const child = existsSync(python)
            ? spawn(python, ['-m', 'novakernel.server'], options)
            : spawn(command, args, options);
          exited.push(new Promise<void>((resolve) => child.once('close', () => resolve())));
          return child;
        }) as typeof spawn,
      }),
      pingIntervalMs: 60_000,
    });
    const router = new RpcRouter({ multi, broadcast: (method, params) => notifications.push({ method, params }) });
    let id = 0;
    const call = (method: string, params?: unknown): Promise<RpcResponse> => router.handle({ jsonrpc: '2.0', id: ++id, method, params });
    const a = (await call('notebook.open', { path: aPath })).result as NotebookOpenResult;
    const sessionId = (notifications.find((n) => n.method === 'session.started')!.params as { sessionId: string }).sessionId;
    const b = (await call('notebook.open', { path: bPath })).result as NotebookOpenResult;
    writeFileSync(aPath, external, 'utf8');
    const result = operation === 'save'
      ? await call('cell.save', { notebookId: a.notebookId, cellId: 'aaaaaaaa', code: 'x = 2' })
      : await call('notebook.close', { notebookId: a.notebookId });
    expect.soft(readFileSync(aPath, 'utf8')).toBe(external);
    expect(result.error?.code).toBe(-32002);
    const conflict = result.error!.data as { kind: string; recoveryPath: string; notebookPath: string };
    expect(conflict).toMatchObject({ kind: 'external-modification', notebookPath: aPath });
    expect(path.isAbsolute(conflict.recoveryPath)).toBe(true);
    expect(readFileSync(conflict.recoveryPath, 'utf8')).toContain(operation === 'save' ? 'x = 2' : 'x = 1');
    expect((await call('notebook.list')).result).toMatchObject([
      { notebookId: a.notebookId, kernelState: 'idle' }, { notebookId: b.notebookId, kernelState: 'idle' },
    ]);
    expect((await call('session.open', { notebookPath: aPath, sessionId })).result).toMatchObject({ endedAt: null });
    expect(notifications.filter((n) => n.method === 'session.ended')).toEqual([]);
    expect(notifications.filter((n) => n.method.startsWith('run.'))).toEqual([]);
    expect(await multi.get(aPath)!.request('ping')).toMatchObject({ pong: true });
    expect((await call('agent.cellCode', { cellId: 'aaaaaaaa' })).result).toEqual({ cellId: 'aaaaaaaa', code: 'x = 1' });
    const localCells = [{ id: 'aaaaaaaa', code: 'x = 12' }, { id: 'dddddddd', code: 'local_only = 7' }];
    const moved = `${aPath}.external`;
    renameSync(aPath, moved);
    try {
      const failedReload = await call('notebook.reload', { notebookId: a.notebookId, cells: localCells });
      expect(failedReload.error?.code).toBe(-32000);
      expect(readFileSync(moved, 'utf8')).toBe(external);
      expect((await call('session.open', { notebookPath: aPath, sessionId })).result).toMatchObject({ endedAt: null });
      expect(notifications.filter((n) => n.method === 'session.ended')).toEqual([]);
      expect((await call('notebook.list')).result).toMatchObject([
        { notebookId: a.notebookId, kernelState: 'idle' }, { notebookId: b.notebookId, kernelState: 'idle' },
      ]);
    } finally {
      renameSync(moved, aPath);
    }
    const reloading = await call('notebook.reload', { notebookId: a.notebookId, cells: localCells });
    expect(reloading.error).toBeUndefined();
    const reloaded = reloading.result as NotebookOpenResult & { recoveryPath: string };
    expect(reloaded.notebookId).toBe(a.notebookId);
    expect(reloaded.state.cells.map((cell) => cell.code)).toEqual(['x = 9', 'y = x + 99']);
    expect(reloaded.state.execCounts).toEqual({ aaaaaaaa: 0, bbbbbbbb: 0 });
    expect(readFileSync(aPath, 'utf8')).toBe(external);
    expect(readFileSync(reloaded.recoveryPath, 'utf8')).toContain('local_only = 7');
    expect(readFileSync(reloaded.recoveryPath, 'utf8')).toContain('x = 12');
    expect((await call('agent.cellCode', { cellId: 'aaaaaaaa' })).result).toEqual({ cellId: 'aaaaaaaa', code: 'x = 1' });
    expect(notifications.filter((n) => n.method.startsWith('run.'))).toEqual([]);
    expect(notifications.filter((n) => n.method === 'notebook.state')).toEqual([]);
    // Explicit reload advances only A's baseline; its next save is now authorized by that version.
    expect((await call('cell.save', { notebookId: a.notebookId, cellId: 'aaaaaaaa', code: 'x = 10' })).error).toBeUndefined();
    expect(readFileSync(aPath, 'utf8')).toContain('x = 10');
    expect(readFileSync(aPath, 'utf8')).toContain('y = x + 99');
  }, 30_000);
}
