/** Real stdio kernel regression: proposing a diff must preserve the running notebook. */
import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { RpcRouter } from './router';
import { KernelSupervisor, StdioKernelTransport } from './supervisor';
import type { KernelRequest, RpcResponse } from './protocol';

const pyDir = fileURLToPath(new URL('../../py/', import.meta.url));
const python = path.join(pyDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
let supervisor: KernelSupervisor | undefined;
let directory: string | undefined;
let kernelExited: Promise<void> | undefined;

afterEach(async () => {
  supervisor?.stop();
  await kernelExited;
  supervisor = undefined;
  kernelExited = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

it('real kernel: stage validates once and preserves controls, values, source, DAG, counts and stale flags', async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'novalab-preflight-'));
  const notebook = path.join(directory, 'notebook.py');
  const source = [
    '# %% [cell-id: aaaaaaaa]',
    'from novakernel import ui',
    's = ui.slider(0, 10)',
    '',
    '# %% [cell-id: bbbbbbbb]',
    'y = s.value + 1',
    '',
    '# %% [cell-id: cccccccc]',
    'z = y * 2',
    '',
  ].join('\n');
  writeFileSync(notebook, source, 'utf8');
  const requests: KernelRequest[] = [];
  supervisor = new KernelSupervisor({
    transportFactory: () => {
      // Own stdio process; use the project interpreter directly when installed.
      const transport = new StdioKernelTransport(pyDir, {
        NOVALAB_PACKAGED: '0', NOVALAB_PY_DIR: pyDir,
      }, {
        spawnImpl: ((command: string, args: readonly string[], options: SpawnOptions) => {
          const child = existsSync(python)
            ? spawn(python, ['-m', 'novakernel.server'], options)
            : spawn(command, args, options);
          kernelExited = new Promise<void>((resolve) => child.once('close', () => resolve()));
          return child;
        }) as typeof spawn,
      });
      const send = transport.send.bind(transport);
      transport.send = (request) => {
        requests.push(request);
        send(request);
      };
      return transport;
    },
    pingIntervalMs: 60_000,
  });
  const notes: { method: string; params?: unknown }[] = [];
  const router = new RpcRouter({
    supervisor,
    broadcast: (method, params) => notes.push({ method, params }),
  });
  let id = 0;
  const call = async (method: string, params?: unknown): Promise<RpcResponse> => {
    const response = await router.handle({ jsonrpc: '2.0', id: ++id, method, params });
    expect(response.error).toBeUndefined();
    return response;
  };
  await call('notebook.open', { path: notebook });
  await call('cell.run', { cellId: 'aaaaaaaa', cascade: true });
  await supervisor.request('control.set', { controlId: 'aaaaaaaa::s', value: 7 });
  // Test instrumentation executes only this explicit REPL request, outside staging.
  await call('kernel.repl', { code: '_saved_control = s\n_saved_y = y\n_saved_z = z' });
  const contextBefore = (await call('agent.context')).result;
  const cellsBefore = (await call('agent.listCells')).result;
  const requestStart = requests.length;
  const noteStart = notes.length;

  const valid = await call('diff.stage', {
    targetCellId: 'bbbbbbbb', action: 'update', newCode: 'y = s.value + 100',
  });
  expect(valid.result).toEqual({ diffId: 'diff-1' });
  const rejected = await call('diff.stage', {
    targetCellId: 'bbbbbbbb', action: 'update', newCode: 's = 2',
  });
  expect(rejected.result).toMatchObject({ rejected: true });
  const syntax = await call('diff.stage', {
    targetCellId: 'bbbbbbbb', action: 'update', newCode: 'def broken(:',
  });
  expect(syntax.result).toMatchObject({ rejected: true });
  const inserted = await call('diff.stage', {
    targetCellId: 'aaaaaaaa', action: 'insert_below', newCode: 'extra = s.value',
  });
  expect(inserted.result).toEqual({ diffId: 'diff-2' });

  // This assertion fails against the old probe/rollback implementation.
  // First stage validates once; with diff-1 pending, each later stage validates alone + stacked (F2).
  expect(requests.slice(requestStart).map((r) => r.method)).toEqual(Array(7).fill('validate_cells'));
  expect(notes.slice(noteStart).filter((n) => n.method.startsWith('run.'))).toEqual([]);
  expect((await call('agent.context')).result).toEqual(contextBefore);
  expect((await call('agent.listCells')).result).toEqual(cellsBefore);
  expect((await call('agent.cellCode', { cellId: 'bbbbbbbb' })).result).toEqual({
    cellId: 'bbbbbbbb', code: 'y = s.value + 1',
  });
  expect(readFileSync(notebook, 'utf8')).toBe(source);

  const checked = await call('kernel.repl', {
    code: "assert s is _saved_control\nassert s.control_id == 'aaaaaaaa::s'\nassert s.value == 7\nassert y == _saved_y == 8\nassert z == _saved_z == 16",
  });
  expect(checked.result).toMatchObject({ ok: true });

  // Acceptance remains the first mutation and executes only the accepted cell.
  const acceptStart = requests.length;
  const accepted = await call('diff.accept', { diffId: 'diff-1' });
  expect(accepted.result).toMatchObject({ run: { cellId: 'bbbbbbbb', ok: true, cascaded: [] } });
  expect(requests.slice(acceptStart).map((r) => r.method)).toEqual([
    'set_cells', 'save_file', 'exec_cell', 'introspect',
  ]);
}, 30_000);
