/** Real stdio router lifecycle: dead restart is cold, owner-scoped, and draft-safe. */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { RpcRouter } from './router';
import { MultiSupervisor, StdioKernelTransport, type KernelTransport } from './supervisor';
import type { KernelRequest, NotebookOpenResult, RpcResponse, SessionMeta } from './protocol';

const pyDir = fileURLToPath(new URL('../../py/', import.meta.url));
const python = path.join(pyDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

type Capture = { child: ChildProcess; transport: KernelTransport; requests: KernelRequest[] };

let multi: MultiSupervisor | undefined;
let router: RpcRouter | undefined;
let directory: string | undefined;
let captures: Capture[] = [];
let exited: Promise<void>[] = [];
let notes: { method: string; params: unknown }[] = [];
let requestId = 0;

async function bounded<T>(promise: Promise<T>, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`acceptance 等待超时 (${timeoutMs}ms)`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待真实 router 生命周期事件超时');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function sessionNotes(method: string): { method: string; params: unknown }[] {
  return notes.filter((note) => note.method === method);
}

function currentSession(pathname: string): string {
  const started = [...sessionNotes('session.started')].reverse().find((note) =>
    (note.params as { notebookPath?: string }).notebookPath === pathname,
  );
  const id = (started?.params as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof id !== 'string') throw new Error(`缺少 ${pathname} 的 live session`);
  return id;
}

async function call(method: string, params?: unknown): Promise<RpcResponse> {
  return router!.handle({ jsonrpc: '2.0', id: ++requestId, method, params });
}

function makeFixture(forbiddenPath: string): string {
  return `# %% [cell-id: aaaaaaaa]\nprint("BEFORE_RESTART")\nx = 1\nx\n\n# %% [cell-id: bbbbbbbb]\nfrom pathlib import Path\nPath(${JSON.stringify(forbiddenPath)}).write_text("must not execute")\n`;
}

function setup(): void {
  directory = mkdtempSync(path.join(tmpdir(), 'novalab-router-restart-'));
  captures = [];
  exited = [];
  notes = [];
  requestId = 0;
  multi = new MultiSupervisor({
    transportFactory: () => {
      const requests: KernelRequest[] = [];
      const capture = { child: undefined as unknown as ChildProcess, transport: undefined as unknown as KernelTransport, requests };
      const transport = new StdioKernelTransport(
        pyDir,
        { NOVALAB_PACKAGED: '0', NOVALAB_PY_DIR: pyDir },
        {
          spawnImpl: ((command: string, args: readonly string[], options: SpawnOptions) => {
            const child = existsSync(python)
              ? spawn(python, ['-m', 'novakernel.server'], options)
              : spawn(command, args, options);
            capture.child = child;
            exited.push(new Promise<void>((resolve) => child.once('close', () => resolve())));
            return child;
          }) as typeof spawn,
        },
      );
      const send = transport.send.bind(transport);
      transport.send = (request) => {
        requests.push(structuredClone(request));
        send(request);
      };
      capture.transport = transport;
      captures.push(capture);
      return transport;
    },
    pingIntervalMs: 60_000,
  });
  router = new RpcRouter({ multi, broadcast: (method, params) => notes.push({ method, params }) });
}

afterEach(async () => {
  router?.dispose();
  multi?.stopAll();
  await Promise.all(exited);
  router = undefined;
  multi = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

it('real router restart: settles old work, cold-loads only, preserves history, and refuses dirty dead owners', async () => {
  setup();
  const notebookPath = path.join(directory!, 'restart.py');
  const forbiddenPath = path.join(directory!, 'forbidden.txt');
  const source = makeFixture(forbiddenPath);
  writeFileSync(notebookPath, source, 'utf8');

  const openResponse = await call('notebook.open', { path: notebookPath });
  expect(openResponse.error).toBeUndefined();
  const opened = openResponse.result as NotebookOpenResult;
  const notebookId = opened.notebookId;
  expect(captures).toHaveLength(1);
  expect(captures[0]!.requests.map((request) => request.method)).toEqual(['load_file']);
  expect(existsSync(forbiddenPath)).toBe(false);

  const firstSession = currentSession(notebookPath);
  await expect(call('cell.run', { notebookId, cellId: 'aaaaaaaa', cascade: false })).resolves.toMatchObject({ result: { ok: true } });
  await waitFor(() => notes.some((note) => note.method === 'run.done'));
  const staged = await call('diff.stage', { targetCellId: 'aaaaaaaa', action: 'update', newCode: 'x = 2' });
  expect(staged.error).toBeUndefined();
  const beforeCrash = await call('agent.cellOutput', { notebookId, cellId: 'aaaaaaaa' });
  expect((beforeCrash.result as { traceback: unknown; mimeKeys: unknown[] })).toMatchObject({ traceback: null });

  const longRun = call('kernel.repl', { code: 'import time; time.sleep(60)' });
  await waitFor(() => notes.some((note) => note.method === 'run.started' && (note.params as { cellId?: string }).cellId === 'repl'));
  const forbiddenQueued = call('kernel.repl', {
    code: `from pathlib import Path; Path(${JSON.stringify(forbiddenPath)}).write_text("queued must not execute")`,
  });
  const settled = Promise.allSettled([longRun, forbiddenQueued]);
  captures[0]!.transport.kill();
  const settledResponses = await bounded(settled);
  expect(settledResponses).toHaveLength(2);
  for (const settledResponse of settledResponses) {
    expect(settledResponse.status).toBe('fulfilled');
    if (settledResponse.status === 'fulfilled') expect(settledResponse.value.error?.code).toBe(-32000);
  }
  await waitFor(() => sessionNotes('session.ended').some((note) => {
    const params = note.params as { sessionId?: string; reason?: string };
    return params.sessionId === firstSession && params.reason === 'crash';
  }));
  expect((await call('notebook.list')).result).toMatchObject([{ notebookId, ended: true, kernelState: 'dead' }]);
  expect(existsSync(forbiddenPath)).toBe(false);

  const restartNotes = notes.length;
  const restarted = await call('kernel.restart', { notebookId });
  expect(restarted.error).toBeUndefined();
  expect(restarted.result).toMatchObject({ notebookId, notebookPath });
  await waitFor(() => sessionNotes('session.started').length >= 2);
  expect(captures).toHaveLength(2);
  expect(captures[1]!.requests.map((request) => request.method)).toEqual(['load_file']);
  expect(captures[1]!.requests.some((request) => request.method.startsWith('exec_'))).toBe(false);
  expect(existsSync(forbiddenPath)).toBe(false);
  expect(notes.slice(restartNotes).filter((note) => note.method === 'session.ended')).toEqual([]);
  expect((await call('agent.cellOutput', { notebookId, cellId: 'aaaaaaaa' })).result).toEqual({ traceback: null, mimeKeys: [] });
  expect((restarted.result as { state: { execCounts: Record<string, number> } }).state.execCounts).toEqual({ aaaaaaaa: 0, bbbbbbbb: 0 });
  const sessions = (await call('session.list', { notebookPath })).result as SessionMeta[];
  expect(sessions).toHaveLength(2);
  expect(sessions[0]!.id).toBe(firstSession);
  expect(sessions[0]!.endedAt).toBeDefined();
  expect(sessions[1]!.endedAt).toBeUndefined();
  const historical = await call('session.open', { notebookPath, sessionId: firstSession });
  expect(historical.result).toMatchObject({ sessionId: firstSession, readOnly: true, endedAt: expect.any(String) });
  expect(existsSync(forbiddenPath)).toBe(false);

  // A real external edit makes the next save dirty in the bridge cache; killing that
  // owner must not permit restart to overwrite the external bytes or spawn a child.
  const external = `${source}# external edit\n`;
  writeFileSync(notebookPath, external, 'utf8');
  const failedSave = await call('cell.save', { notebookId, cellId: 'aaaaaaaa', code: 'x = 99' });
  expect(failedSave.error?.code).toBe(-32002);
  const childCountBeforeRefusal = captures.length;
  const current = captures.at(-1)!;
  current.transport.kill();
  await waitFor(() => sessionNotes('session.ended').length >= 2);
  const refused = await call('kernel.restart', { notebookId });
  expect(refused.error?.code).toBe(-32000);
  expect(captures).toHaveLength(childCountBeforeRefusal);
  expect(readFileSync(notebookPath, 'utf8')).toBe(external);
}, 60_000);
