import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KernelSupervisor } from './supervisor';
import { RpcRouter } from './router';
import { FakeKernel } from './testing/fake-kernel';
import type {
  DiffUpdatedParams,
  KernelStatusParams,
  NotebookState,
  RpcResponse,
  RunDoneParams,
  RunReport,
  SaveResult,
} from './protocol';

interface SessionEventLike {
  ts: string;
  kind: string;
  actor: string;
  cellId?: string;
  payloadRef?: string;
}

const NB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'novalab-router-')), 'demo.py');
// P2.8：session 事件按内核生命周期分文件（.novalab/sessions/<id>.jsonl + index.json）
const SESSIONS_DIR = path.join(path.dirname(NB_PATH), '.novalab', 'sessions');

let sup: KernelSupervisor | undefined;
let fakes: FakeKernel[] = [];
let notes: { method: string; params?: unknown }[] = [];
let router: RpcRouter;
let reqId = 0;

function setup(): void {
  fakes = [];
  notes = [];
  reqId = 0;
  sup = new KernelSupervisor({
    transportFactory: () => {
      const f = new FakeKernel();
      fakes.push(f);
      return f;
    },
    pingIntervalMs: 60_000, // 测试期间不触发 health ping
  });
  router = new RpcRouter({
    supervisor: sup,
    broadcast: (method, params) => notes.push({ method, params }),
  });
}

async function call(method: string, params?: unknown): Promise<RpcResponse> {
  return router.handle({ jsonrpc: '2.0', id: ++reqId, method, params });
}

async function openNotebook(): Promise<NotebookState> {
  const res = await call('notebook.open', { path: NB_PATH });
  expect(res.error).toBeUndefined();
  return res.result as NotebookState;
}

/** index 顺序最后一个（= 最新）会话的事件流。 */
function sessionEvents(): SessionEventLike[] {
  let index: { id: string }[];
  try {
    index = JSON.parse(readFileSync(path.join(SESSIONS_DIR, 'index.json'), 'utf8')) as { id: string }[];
  } catch {
    return [];
  }
  const last = index.at(-1);
  if (!last) return [];
  const file = path.join(SESSIONS_DIR, `${last.id}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as SessionEventLike);
}

function lastParams<T>(method: string): T | undefined {
  for (let i = notes.length - 1; i >= 0; i--) {
    if (notes[i]!.method === method) return notes[i]!.params as T;
  }
  return undefined;
}

afterEach(() => {
  sup?.stop();
  sup = undefined;
});

describe('RpcRouter · notebook/cell', () => {
  it('ping 兼容保留', async () => {
    setup();
    const res = await call('ping');
    expect(typeof (res.result as { pong: number }).pong).toBe('number');
  });

  it('notebook.open：spawn 内核 + load_file → notebook.state 快照', async () => {
    setup();
    const state = await openNotebook();
    expect(state.cells.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(state.dagEdges).toContainEqual({ from: 'a', to: 'b' });
    expect(state.dagEdges).toContainEqual({ from: 'b', to: 'c' });
    expect(state.staleSet).toEqual([]);
    expect(state.execCounts).toEqual({ a: 0, b: 0, c: 0 });
    expect(Array.isArray(state.schemas)).toBe(true);
    expect(fakes[0]!.loadedPath).toBe(NB_PATH);
  });

  it('未 open 时业务方法回 -32001', async () => {
    setup();
    const res = await call('cell.save', { cellId: 'a', code: 'x=1' });
    expect(res.error?.code).toBe(-32001);
  });

  it('cell.save：更新缓存 → 内核 set_cells 收全量 cells → {dagEdges, staleSet} + session 事件', async () => {
    setup();
    await openNotebook();
    const res = await call('cell.save', { cellId: 'a', code: 'x = 2' });
    const saved = res.result as SaveResult;
    expect(saved.dagEdges).toContainEqual({ from: 'a', to: 'b' });
    expect(saved.staleSet.sort()).toEqual(['b', 'c']);
    expect(saved.compileError).toBeUndefined();

    const setCells = fakes[0]!.requests.filter((r) => r.method === 'set_cells');
    expect(setCells).toHaveLength(1);
    const cells = (setCells[0]!.params as { cells: { id: string; code: string }[] }).cells;
    expect(cells).toHaveLength(3); // 全量
    expect(cells[0]).toEqual({ id: 'a', code: 'x = 2' });

    const events = sessionEvents();
    expect(events.at(-1)).toMatchObject({ kind: 'save', actor: 'user', cellId: 'a' });
  });

  it('cell.save 编译错透传 compileError', async () => {
    setup();
    await openNotebook();
    fakes[0]!.nextCompileError = { message: 'multiple definitions of x', cellIds: ['a', 'b'] };
    const res = await call('cell.save', { cellId: 'b', code: 'x = 3' });
    const saved = res.result as SaveResult;
    expect(saved.compileError).toEqual({ message: 'multiple definitions of x', cellIds: ['a', 'b'] });
  });

  it('cell.save 未知 cellId → -32602', async () => {
    setup();
    await openNotebook();
    const res = await call('cell.save', { cellId: 'nope', code: '' });
    expect(res.error?.code).toBe(-32602);
  });

  it('cell.run：RunReport + run.* 通知转发 + execCounts 更新 + session run 事件', async () => {
    setup();
    await openNotebook();
    const res = await call('cell.run', { cellId: 'a', cascade: false });
    const report = res.result as RunReport;
    expect(report).toMatchObject({ cellId: 'a', ok: true, cascaded: [] });
    expect(typeof report.durationMs).toBe('number');

    // 流式通知全部转发给 ws 客户端
    const runNotes = notes.filter((n) => n.method.startsWith('run.'));
    expect(runNotes.map((n) => n.method)).toEqual(['run.started', 'run.stdout', 'run.done']);
    expect((runNotes[1]!.params as { cellId: string }).cellId).toBe('a');
    const done = lastParams<RunDoneParams>('run.done');
    expect(done).toMatchObject({ cellId: 'a', execCount: 1 });

    expect(sessionEvents().at(-1)).toMatchObject({ kind: 'run', cellId: 'a', payloadRef: 'exec:1' });
  });

  it('cell.run cascade=true：级联 cells 出现在 cascaded 且逐格 run.done', async () => {
    setup();
    await openNotebook();
    const res = await call('cell.run', { cellId: 'a', cascade: true });
    const report = res.result as RunReport;
    expect(report.ok).toBe(true);
    expect(report.cascaded.sort()).toEqual(['b', 'c']);
    const dones = notes.filter((n) => n.method === 'run.done');
    expect(dones).toHaveLength(3);
  });

  it('cell.run 失败：ok=false + traceback + run.error 转发 + session error 事件', async () => {
    setup();
    await openNotebook();
    fakes[0]!.failCell = { cellId: 'b', traceback: 'Traceback ...\nZeroDivisionError' };
    const res = await call('cell.run', { cellId: 'b', cascade: false });
    const report = res.result as RunReport;
    expect(report.ok).toBe(false);
    expect(report.traceback).toContain('ZeroDivisionError');
    expect(notes.some((n) => n.method === 'run.error')).toBe(true);
    expect(sessionEvents().at(-1)).toMatchObject({ kind: 'error', cellId: 'b' });
  });
});

describe('RpcRouter · kernel', () => {
  it('kernel.vars：introspect 的 schemas 全量返回', async () => {
    setup();
    await openNotebook();
    const res = await call('kernel.vars');
    const { schemas } = res.result as { schemas: { name: string }[] };
    expect(schemas.map((s) => s.name).sort()).toEqual(['x', 'y']);
  });

  it('kernel.repl：exec_repl + 输出以 run.* 通知回灌（cellId="repl"）', async () => {
    setup();
    await openNotebook();
    const res = await call('kernel.repl', { code: 'x + 1' });
    const report = res.result as RunReport;
    expect(report).toMatchObject({ cellId: 'repl', ok: true });
    const stdout = notes.find((n) => n.method === 'run.stdout');
    expect((stdout!.params as { cellId: string }).cellId).toBe('repl');
    expect(sessionEvents().at(-1)).toMatchObject({ kind: 'repl', cellId: 'repl' });
  });

  it('kernel.restart：重 spawn + load_file 回放 + kernel.status 通知', async () => {
    setup();
    await openNotebook();
    notes = [];
    const res = await call('kernel.restart');
    expect(res.error).toBeUndefined();
    expect((res.result as NotebookState).cells).toHaveLength(3);
    expect(fakes).toHaveLength(2);
    expect(fakes[1]!.loadedPath).toBe(NB_PATH);
    const states = notes
      .filter((n) => n.method === 'kernel.status')
      .map((n) => (n.params as KernelStatusParams).state);
    expect(states).toEqual(['restarting', 'idle']);
  });

  it('内核崩溃 → kernel.status dead 通知广播', async () => {
    setup();
    await openNotebook();
    notes = [];
    fakes[0]!.crash(1);
    const status = lastParams<KernelStatusParams>('kernel.status');
    expect(status).toEqual({ state: 'dead', queueDepth: 0 });
    // 死后业务请求回 kernel 错误
    const res = await call('cell.run', { cellId: 'a' });
    expect(res.error?.code).toBe(-32000);
  });
});

describe('RpcRouter · diff 暂存队列', () => {
  it('diff.stage：入队 + diff.updated 通知 + session diff_proposed', async () => {
    setup();
    await openNotebook();
    const res = await call('diff.stage', {
      targetCellId: 'b',
      action: 'update',
      newCode: 'y = x + 2',
      rationale: 'fix off-by-one',
    });
    const { diffId } = res.result as { diffId: string };
    expect(diffId).toBe('diff-1');
    const upd = lastParams<DiffUpdatedParams>('diff.updated');
    expect(upd!.diffs).toHaveLength(1);
    expect(upd!.diffs[0]).toMatchObject({
      diffId: 'diff-1',
      targetCellId: 'b',
      action: 'update',
      newCode: 'y = x + 2',
      rationale: 'fix off-by-one',
      status: 'proposed',
    });
    expect(sessionEvents().at(-1)).toMatchObject({ kind: 'diff_proposed', cellId: 'b', payloadRef: 'diff-1' });
  });

  it('diff.stage 非法 action / 未知 cell → -32602', async () => {
    setup();
    await openNotebook();
    expect((await call('diff.stage', { targetCellId: 'b', action: 'delete', newCode: '' })).error?.code).toBe(-32602);
    expect((await call('diff.stage', { targetCellId: 'zz', action: 'update', newCode: '' })).error?.code).toBe(-32602);
  });

  it('diff.accept(update)：执行 cell.save + cell.run cascade=false', async () => {
    setup();
    await openNotebook();
    const { diffId } = (await call('diff.stage', { targetCellId: 'b', action: 'update', newCode: 'y = x + 2' })).result as { diffId: string };
    const res = await call('diff.accept', { diffId });
    const out = res.result as { diffId: string; dagEdges: unknown[]; staleSet: string[]; run?: RunReport };
    expect(out.diffId).toBe(diffId);
    expect(out.run).toMatchObject({ cellId: 'b', ok: true });

    const setCells = fakes[0]!.requests.filter((r) => r.method === 'set_cells');
    // P2.7：diff.stage 编译预检（试探 + 回滚）2 次 + diff.accept 保存 1 次
    expect(setCells).toHaveLength(3);
    const cells = (setCells[2]!.params as { cells: { id: string; code: string }[] }).cells;
    expect(cells.find((c) => c.id === 'b')!.code).toBe('y = x + 2');

    const exec = fakes[0]!.requests.filter((r) => r.method === 'exec_cell');
    expect(exec).toHaveLength(1);
    expect(exec[0]!.params).toEqual({ cellId: 'b', cascade: false });

    expect(lastParams<DiffUpdatedParams>('diff.updated')!.diffs[0]!.status).toBe('accepted');
    const kinds = sessionEvents().map((e) => e.kind);
    expect(kinds).toContain('diff_accepted');
    expect(kinds.at(-1)).toBe('run');
  });

  it('diff.accept(insert_below)：新 cell 插到目标之后并运行新 cell', async () => {
    setup();
    await openNotebook();
    const { diffId } = (await call('diff.stage', { targetCellId: 'a', action: 'insert_below', newCode: 'z = x * 10' })).result as { diffId: string };
    const res = await call('diff.accept', { diffId });
    const out = res.result as { run?: RunReport };
    const newId = out.run!.cellId;
    expect(newId).not.toBe('a');
    expect(newId).toMatch(/^[0-9a-f]{8}$/);

    const setCells = fakes[0]!.requests.filter((r) => r.method === 'set_cells');
    // 最后一次 = diff.accept 的保存（前面是 stage 预检的试探 + 回滚）
    const cells = (setCells.at(-1)!.params as { cells: { id: string; code: string }[] }).cells;
    expect(cells).toHaveLength(4);
    expect(cells[0]!.id).toBe('a');
    expect(cells[1]).toEqual({ id: newId, code: 'z = x * 10' });
    const exec = fakes[0]!.requests.filter((r) => r.method === 'exec_cell');
    expect(exec[0]!.params).toEqual({ cellId: newId, cascade: false });
  });

  it('diff.accept 遇编译错：不运行，返回 compileError', async () => {
    setup();
    await openNotebook();
    const { diffId } = (await call('diff.stage', { targetCellId: 'b', action: 'update', newCode: 'x = 1' })).result as { diffId: string };
    fakes[0]!.nextCompileError = { message: 'multiple definitions of x', cellIds: ['a', 'b'] };
    const res = await call('diff.accept', { diffId });
    const out = res.result as { compileError?: { message: string }; run?: RunReport };
    expect(out.compileError?.message).toContain('multiple definitions');
    expect(out.run).toBeUndefined();
    expect(fakes[0]!.countOf('exec_cell')).toBe(0);
  });

  it('diff.reject：状态 rejected + 通知 + session；重复处理 → -32602', async () => {
    setup();
    await openNotebook();
    const { diffId } = (await call('diff.stage', { targetCellId: 'c', action: 'update', newCode: 'print(y + 1)' })).result as { diffId: string };
    const res = await call('diff.reject', { diffId });
    expect(res.result).toEqual({ diffId, status: 'rejected' });
    expect(lastParams<DiffUpdatedParams>('diff.updated')!.diffs[0]!.status).toBe('rejected');
    expect(sessionEvents().at(-1)).toMatchObject({ kind: 'diff_rejected', payloadRef: diffId });
    expect((await call('diff.accept', { diffId })).error?.code).toBe(-32602);
    expect((await call('diff.reject', { diffId })).error?.code).toBe(-32602);
  });
});

describe('RpcRouter · 其他', () => {
  it('export.ipynb → -32600 P3 feature', async () => {
    setup();
    const res = await call('export.ipynb', { path: 'x', target: 'y' });
    expect(res.error).toEqual({ code: -32600, message: 'P3 feature' });
  });

  it('未知方法 → -32601', async () => {
    setup();
    const res = await call('bogus.method');
    expect(res.error?.code).toBe(-32601);
  });
});
