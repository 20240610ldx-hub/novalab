/** Real stdio kernel regression for F2: moving a definition between cells takes two queued diffs. */
import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { RpcRouter } from './router';
import { KernelSupervisor, StdioKernelTransport } from './supervisor';
import type { RpcResponse } from './protocol';
/** ADR-013：未经影子运行的改动照常入队，只标注 unverified（软约束）。 */
const UNVERIFIED = { status: 'unverified', level: 'V1', missing: ['shadow_run'] };

const pyDir = fileURLToPath(new URL('../../py/', import.meta.url));
const python = path.join(pyDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const HELPER = 'def helper(v):\n    return v + 1';
const SOURCE = [
  '# %% [cell-id: aaaaaaaa]',
  HELPER,
  '',
  'y = helper(1)',
  '',
  '# %% [cell-id: bbbbbbbb]',
  'z = y * 2',
  '',
].join('\n');

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

async function openNotebook(): Promise<(method: string, params?: unknown) => Promise<RpcResponse>> {
  directory = mkdtempSync(path.join(tmpdir(), 'novalab-diffqueue-'));
  const notebook = path.join(directory, 'notebook.py');
  writeFileSync(notebook, SOURCE, 'utf8');
  supervisor = new KernelSupervisor({
    transportFactory: () =>
      new StdioKernelTransport(pyDir, { NOVALAB_PACKAGED: '0', NOVALAB_PY_DIR: pyDir }, {
        spawnImpl: ((command: string, args: readonly string[], options: SpawnOptions) => {
          const child = existsSync(python)
            ? spawn(python, ['-m', 'novakernel.server'], options)
            : spawn(command, args, options);
          kernelExited = new Promise<void>((resolve) => child.once('close', () => resolve()));
          return child;
        }) as typeof spawn,
      }),
    pingIntervalMs: 60_000,
  });
  const router = new RpcRouter({ supervisor, broadcast: () => {} });
  let id = 0;
  const call = (method: string, params?: unknown) => router.handle({ jsonrpc: '2.0', id: ++id, method, params });
  expect((await call('notebook.open', { path: notebook })).error).toBeUndefined();
  expect((await call('cell.run', { cellId: 'aaaaaaaa', cascade: true })).error).toBeUndefined();
  return call;
}

it('real kernel: update-then-insert move is queued with dependsOn and lands only in order', async () => {
  const call = await openNotebook();
  expect((await call('diff.stage', { targetCellId: 'aaaaaaaa', action: 'update', newCode: 'y = helper(1)' })).result)
    .toEqual({ diffId: 'diff-1', verification: UNVERIFIED });
  expect((await call('diff.stage', { targetCellId: 'aaaaaaaa', action: 'insert_below', newCode: HELPER })).result)
    .toEqual({ diffId: 'diff-2', dependsOn: ['diff-1'], verification: UNVERIFIED });

  const early = await call('diff.accept', { diffId: 'diff-2' });
  expect(early.error?.message).toContain('accept diff-1 first');
  expect((await call('agent.cellCode', { cellId: 'aaaaaaaa' })).result).toMatchObject({ code: `${HELPER}\n\ny = helper(1)` });

  expect((await call('diff.accept', { diffId: 'diff-1' })).error).toBeUndefined();
  const second = await call('diff.accept', { diffId: 'diff-2' });
  expect(second.error).toBeUndefined();
  expect((second.result as { compileError?: unknown }).compileError).toBeUndefined();
  expect((await call('cell.run', { cellId: 'aaaaaaaa', cascade: true })).error).toBeUndefined();
  const checked = await call('kernel.repl', { code: 'assert helper(1) == 2\nassert y == 2\nassert z == 4' });
  expect(checked.result).toMatchObject({ ok: true });
}, 30_000);

it('real kernel: insert-first move is rejected with a hint naming the defining cell', async () => {
  const call = await openNotebook();
  const res = (await call('diff.stage', { targetCellId: 'aaaaaaaa', action: 'insert_below', newCode: HELPER })).result as {
    rejected?: boolean;
    reason?: { message: string };
    hint?: string;
  };
  expect(res.rejected).toBe(true);
  expect(res.reason?.message).toContain("multiple definitions of 'helper'");
  expect(res.hint).toContain("cell 'aaaaaaaa'");
  expect(res.hint).toContain('update');
}, 30_000);

it('real kernel: a diff that conflicts only with a pending diff is rejected with conflictsWith', async () => {
  const call = await openNotebook();
  expect((await call('diff.stage', { targetCellId: 'bbbbbbbb', action: 'update', newCode: 'z = y * 2\nw = 1' })).result)
    .toEqual({ diffId: 'diff-1', verification: UNVERIFIED });
  const res = (await call('diff.stage', {
    targetCellId: 'aaaaaaaa',
    action: 'update',
    newCode: `${HELPER}\n\ny = helper(1)\nw = 2`,
  })).result as { rejected?: boolean; reason?: { message: string }; conflictsWith?: string[] };
  expect(res.rejected).toBe(true);
  expect(res.reason?.message).toContain("multiple definitions of 'w'");
  expect(res.conflictsWith).toEqual(['diff-1']);
}, 30_000);
