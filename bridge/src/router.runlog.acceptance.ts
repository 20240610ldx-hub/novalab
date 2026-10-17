/** Real stdio kernel: ADR-014 run log records attempts, failures (class + user line), cascades and REPL. */
import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { RpcRouter } from './router';
import { KernelSupervisor, StdioKernelTransport } from './supervisor';
import type { RpcResponse } from './protocol';
import type { RunLogRecord } from './run-log';

const pyDir = fileURLToPath(new URL('../../py/', import.meta.url));
const python = path.join(pyDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const SOURCE = [
  '# %% [cell-id: aaaaaaaa]',
  'rows = {"a": 1}',
  '',
  '# %% [cell-id: bbbbbbbb]',
  'total = sum(rows.values())',
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

it('real kernel: attempts, failure line, cascade attribution and REPL land in the run log', async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'novalab-runlog-acc-'));
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
  const call = (method: string, params?: unknown): Promise<RpcResponse> =>
    router.handle({ jsonrpc: '2.0', id: ++id, method, params });
  expect((await call('notebook.open', { path: notebook })).error).toBeUndefined();

  expect((await call('cell.run', { cellId: 'aaaaaaaa', cascade: true })).error).toBeUndefined();
  // 改一点再跑：第 2 行访问不存在的键 → 失败
  expect((await call('cell.save', { cellId: 'bbbbbbbb', code: 'total = sum(rows.values())\nfirst = rows["zz"]' })).error).toBeUndefined();
  expect((await call('cell.run', { cellId: 'bbbbbbbb' })).error).toBeUndefined();
  expect((await call('kernel.repl', { code: 'len(rows)' })).error).toBeUndefined();

  const { records } = (await call('session.runs')).result as { records: RunLogRecord[] };
  const [rootA, cascB, failB, repl] = records;
  expect(rootA).toMatchObject({ cellId: 'aaaaaaaa', trigger: 'direct', ok: true, attempt: 1 });
  expect(cascB).toMatchObject({ cellId: 'bbbbbbbb', trigger: 'cascade', rootRunId: rootA!.runId, ok: true, attempt: 1 });
  expect(failB).toMatchObject({ cellId: 'bbbbbbbb', trigger: 'direct', ok: false, attempt: 2, error: { name: 'KeyError', line: 2 } });
  expect(failB!.code).toContain('rows["zz"]');
  expect(failB!.codeSha256).not.toBe(cascB!.codeSha256);
  expect(repl).toMatchObject({ cellId: 'repl', trigger: 'repl', ok: true, code: 'len(rows)' });
  expect(JSON.stringify(records)).not.toContain("'zz'"); // evalue（KeyError: 'zz'）不落日志
  for (const r of records) expect(r.durationMs).toBeGreaterThanOrEqual(0);
});
