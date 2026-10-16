/** Real stdio lifecycle: stopping/restarting settles old work without replay. */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { KernelSupervisor, StdioKernelTransport } from './supervisor';
import type { KernelRequest, NotebookState } from './protocol';

const pyDir = fileURLToPath(new URL('../../py/', import.meta.url));
const python = path.join(pyDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
let supervisor: KernelSupervisor | undefined;
let directory: string | undefined;
let exited: Promise<void>[] = [];

async function bounded<T>(promise: Promise<T>, timeoutMs = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('old execution promises did not settle')), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(async () => {
  supervisor?.stop();
  await Promise.all(exited);
  supervisor = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

for (const action of ['stop', 'restart', 'crash'] as const) {
  it(`real ${action}: active and queued calls settle; new kernel cold-loads without old work`, async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'novalab-queue-lifecycle-'));
    exited = [];
    const filename = path.join(directory, 'lifecycle.py');
    const forbiddenWrite = path.join(directory, 'old-queued-execution.txt');
    writeFileSync(filename, '# %% [cell-id: aaaaaaaa]\nx = 1\nx\n', 'utf8');
    const sent: KernelRequest[][] = [];
    const children: ChildProcess[] = [];
    supervisor = new KernelSupervisor({
      transportFactory: () => {
        const transport = new StdioKernelTransport(pyDir, { NOVALAB_PACKAGED: '0', NOVALAB_PY_DIR: pyDir }, {
          spawnImpl: ((command: string, args: readonly string[], options: SpawnOptions) => {
            const child = existsSync(python)
              ? spawn(python, ['-m', 'novakernel.server'], options)
              : spawn(command, args, options);
            children.push(child);
            exited.push(new Promise<void>((resolve) => child.once('close', () => resolve())));
            return child;
          }) as typeof spawn,
        });
        const requests: KernelRequest[] = [];
        sent.push(requests);
        const send = transport.send.bind(transport);
        transport.send = (request) => { requests.push(request); send(request); };
        return transport;
      },
      pingIntervalMs: 60_000,
    });
    await supervisor.start(filename);
    const started = new Promise<void>((resolve) => {
      const onNotification = (event: { method: string }) => {
        if (event.method === 'run.started') {
          supervisor!.off('notification', onNotification);
          resolve();
        }
      };
      supervisor!.on('notification', onNotification);
    });
    const first = supervisor.request('exec_repl', { code: 'import time; time.sleep(60)' });
    const second = supervisor.request('exec_repl', {
      code: `from pathlib import Path; Path(${JSON.stringify(forbiddenWrite)}).write_text('must not run')`,
    });
    const third = supervisor.request('exec_cell', { cellId: 'aaaaaaaa', cascade: false });
    // Attach rejection handlers before terminating the running child.
    const settled = Promise.allSettled([first, second, third]);
    await bounded(started, 10_000);
    expect(supervisor.queueDepth).toBe(2);
    if (action === 'crash') {
      const crashed = new Promise<void>((resolve) => supervisor!.once('crash', () => resolve()));
      expect(children[0]!.kill('SIGKILL')).toBe(true);
      await bounded(crashed);
      expect(supervisor.state).toBe('dead');
      expect(supervisor.queueDepth).toBe(0);
    }
    const reloaded = action === 'stop'
      ? (supervisor.stop(), supervisor.start(filename))
      : supervisor.restart();
    const outcomes = await bounded(settled);
    expect(outcomes.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    const state = await reloaded as NotebookState;
    expect(state.execCounts).toEqual({ aaaaaaaa: 0 });
    expect(sent[1]!.map((request) => request.method)).toEqual(['load_file']);
    expect(existsSync(forbiddenWrite)).toBe(false);
    expect(await supervisor.request('exec_repl', { code: 'fresh = 7' })).toMatchObject({ ok: true });
    expect(existsSync(forbiddenWrite)).toBe(false);
    expect(supervisor.queueDepth).toBe(0);
    expect(supervisor.state).toBe('idle');
  }, 30_000);
}
