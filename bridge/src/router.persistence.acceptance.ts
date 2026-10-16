/** Real files + isolated stdio kernels: targeted saves, FIFO close and failure retention. */
import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { RpcRouter } from './router';
import { MultiSupervisor, StdioKernelTransport } from './supervisor';
import type { KernelRequest, NotebookOpenResult, RpcResponse } from './protocol';

const pyDir = fileURLToPath(new URL('../../py/', import.meta.url));
const python = path.join(pyDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
let multi: MultiSupervisor | undefined;
let directory: string | undefined;
let exited: Promise<void>[] = [];
let transports: StdioKernelTransport[] = [];
let requests: KernelRequest[][] = [];
let notes: { method: string; params?: unknown }[] = [];
let reqId = 0;

function setup() {
  directory = mkdtempSync(path.join(tmpdir(), 'novalab-persistence-'));
  exited = [];
  transports = [];
  requests = [];
  notes = [];
  reqId = 0;
  multi = new MultiSupervisor({
    transportFactory: () => {
      const transport = new StdioKernelTransport(pyDir, {
        NOVALAB_PACKAGED: '0', NOVALAB_PY_DIR: pyDir,
      }, {
        spawnImpl: ((command: string, args: readonly string[], options: SpawnOptions) => {
          const child = existsSync(python)
            ? spawn(python, ['-m', 'novakernel.server'], options)
            : spawn(command, args, options);
          exited.push(new Promise<void>((resolve) => child.once('close', () => resolve())));
          return child;
        }) as typeof spawn,
      });
      const seen: KernelRequest[] = [];
      requests.push(seen);
      const send = transport.send.bind(transport);
      transport.send = (request) => { seen.push(request); send(request); };
      transports.push(transport);
      return transport;
    },
    pingIntervalMs: 60_000,
  });
  const router = new RpcRouter({ multi, broadcast: (method, params) => notes.push({ method, params }) });
  return (method: string, params?: unknown): Promise<RpcResponse> => router.handle({
    jsonrpc: '2.0', id: ++reqId, method, params,
  });
}

function notebook(name: string) {
  const filename = path.join(directory!, name);
  const source = '# %% [cell-id: aaaaaaaa]\nx = 1\n';
  writeFileSync(filename, source, 'utf8');
  return { filename, source };
}

function holdNext(transport: StdioKernelTransport, method: string) {
  const send = transport.send.bind(transport);
  let held: KernelRequest | undefined;
  let signal!: () => void;
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  transport.send = (request) => {
    if (request.method === method && !held) { held = request; signal(); }
    else send(request);
  };
  return { reached, release: () => { transport.send = send; if (held) send(held); } };
}

afterEach(async () => {
  multi?.stopAll();
  await Promise.all(exited);
  multi = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

it('real kernels: background saves stay on A, serialize complete writes, and close waits for the latest save', async () => {
  const call = setup();
  const aFile = notebook('a.py');
  const bFile = notebook('b.py');
  const a = (await call('notebook.open', { path: aFile.filename })).result as NotebookOpenResult;
  const b = (await call('notebook.open', { path: bFile.filename })).result as NotebookOpenResult;
  const gate = holdNext(transports[0]!, 'set_cells');
  const first = call('cell.save', { notebookId: a.notebookId, cellId: 'aaaaaaaa', code: 'x = 10' });
  await gate.reached;
  const second = call('cell.save', { notebookId: a.notebookId, cellId: 'aaaaaaaa', code: 'x = 20' });
  const closing = call('notebook.close', { notebookId: a.notebookId });
  try {
    expect((await call('cell.save', { notebookId: b.notebookId, cellId: 'aaaaaaaa', code: 'x = 30' })).error).toBeUndefined();
    expect(readFileSync(aFile.filename, 'utf8')).toBe(aFile.source);
    expect(readFileSync(bFile.filename, 'utf8')).toContain('x = 30');
    expect(requests[0]!.filter((r) => ['set_cells', 'save_file'].includes(r.method))).toEqual([]);
  } finally {
    gate.release();
  }
  expect((await first).error).toBeUndefined();
  expect((await second).error).toBeUndefined();
  expect((await closing).result).toEqual({ notebookId: a.notebookId, closed: true });
  expect(readFileSync(aFile.filename, 'utf8')).toContain('x = 20');
  expect(readFileSync(bFile.filename, 'utf8')).toContain('x = 30');
  expect(requests[0]!.filter((r) => ['set_cells', 'save_file'].includes(r.method)).map((r) => r.method)).toEqual([
    'set_cells', 'save_file', 'set_cells', 'save_file', 'save_file',
  ]);
  expect(notes.filter((n) => n.method.startsWith('run.'))).toEqual([]);
  expect((await call('agent.cellCode', { cellId: 'aaaaaaaa' })).result).toEqual({ cellId: 'aaaaaaaa', code: 'x = 30' });
  expect(notes.filter((n) => n.method === 'focus.changed').at(-1)!.params).toEqual({ notebookId: b.notebookId });
}, 30_000);

it('real filesystem write failure preserves live notebook, draft, session and kernel until close can persist', async () => {
  const call = setup();
  const { filename, source } = notebook('a.py');
  const opened = await call('notebook.open', { path: filename });
  expect(opened.error).toBeUndefined();
  const { notebookId } = opened.result as NotebookOpenResult;
  const sessionId = (notes.find((n) => n.method === 'session.started')!.params as { sessionId: string }).sessionId;
  const backup = `${filename}.backup`;
  renameSync(filename, backup);
  mkdirSync(filename); // Deterministic write failure on Windows and Linux (even root).
  const saving = await call('cell.save', { notebookId, cellId: 'aaaaaaaa', code: 'x = 99' });
  expect(saving.error?.code).toBe(-32000);
  expect(readFileSync(backup, 'utf8')).toBe(source);
  const closing = await call('notebook.close', { notebookId });
  expect(closing.error?.code).toBe(-32000);
  expect((await call('notebook.list')).result).toMatchObject([{ notebookId, kernelState: 'idle' }]);
  expect((await call('agent.cellCode', { cellId: 'aaaaaaaa' })).result).toEqual({ cellId: 'aaaaaaaa', code: 'x = 99' });
  expect((await call('session.open', { notebookPath: filename, sessionId })).result).toMatchObject({ endedAt: null });
  expect(notes.filter((n) => n.method === 'session.ended')).toEqual([]);
  expect(await multi!.get(filename)!.request('ping')).toMatchObject({ pong: true });
  expect(notes.filter((n) => n.method.startsWith('run.'))).toEqual([]);

  rmSync(filename, { recursive: true, force: true });
  renameSync(backup, filename);
  expect((await call('notebook.close', { notebookId })).result).toEqual({ notebookId, closed: true });
  expect(readFileSync(filename, 'utf8')).toContain('x = 99');
  expect((await call('notebook.list')).result).toEqual([]);
  expect((await call('cell.save', { notebookId, cellId: 'aaaaaaaa', code: 'x = 100' })).error?.code).toBe(-32602);
}, 30_000);
