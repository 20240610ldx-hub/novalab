/**
 * P2.6/P2.7：router agent.* 四方法 + diff.stage 编译预检（FakeKernel in-process）。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KernelSupervisor } from './supervisor';
import {
  RpcRouter,
  OUTPUT_CHAR_LIMIT,
  WRITES_PATH_LIMIT,
  type AgentCellSummary,
  type AgentContext,
  type CellOutputSnapshot,
  type StageResult,
} from './router';
import { FakeKernel } from './testing/fake-kernel';
import { PREVIEW_STRING_LIMIT, TRUNCATION_SUFFIX } from './preview';
import type { DiffUpdatedParams, NotebookState, RpcResponse } from './protocol';

const NB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'novalab-agent-')), 'demo.py');

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
    pingIntervalMs: 60_000,
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

function countNotes(method: string): number {
  return notes.filter((n) => n.method === method).length;
}

afterEach(() => {
  sup?.stop();
  sup = undefined;
});

describe('agent.context', () => {
  it('返回 {dagEdges, schemas, focusCellId:null, staleSet}', async () => {
    setup();
    await openNotebook();
    const res = await call('agent.context');
    const ctx = res.result as AgentContext;
    expect(ctx.focusCellId).toBeNull();
    expect(ctx.dagEdges).toContainEqual({ from: 'a', to: 'b' });
    expect(ctx.dagEdges).toContainEqual({ from: 'b', to: 'c' });
    expect(ctx.staleSet).toEqual([]);
    expect(Array.isArray(ctx.schemas)).toBe(true);
    // 不含 cells 源码（无原始数据承诺）
    expect(Object.keys(ctx).sort()).toEqual(['dagEdges', 'focusCellId', 'schemas', 'staleSet']);
  });

  it('preview 截断生效：schemas 内 >4KB 字符串字段必截（spec §8）', async () => {
    setup();
    const big = 'z'.repeat(PREVIEW_STRING_LIMIT + 1000);
    // 预置超长 preview 字段 —— 必须在 open（load_file）前设置
    const fake = new FakeKernel();
    fake.overrideSchemas = [{ name: 'big', type: 'DataFrame', preview: big }];
    fakes.push(fake);
    sup!.stop();
    sup = new KernelSupervisor({ transportFactory: () => fake, pingIntervalMs: 60_000 });
    router = new RpcRouter({
      supervisor: sup,
      broadcast: (method, params) => notes.push({ method, params }),
    });
    await openNotebook();

    const ctx = (await call('agent.context')).result as AgentContext;
    const schema = ctx.schemas[0]!;
    expect(typeof schema.preview).toBe('string');
    const preview = schema.preview as string;
    expect(preview.length).toBe(PREVIEW_STRING_LIMIT + TRUNCATION_SUFFIX.length);
    expect(preview.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });
});

describe('agent.listCells', () => {
  it('摘要形状 + status 派生（idle → ok → stale → error）', async () => {
    setup();
    await openNotebook();

    const idle = (await call('agent.listCells')).result as AgentCellSummary[];
    expect(idle[0]).toEqual({
      id: 'a',
      execCount: 0,
      status: 'idle',
      firstLine: 'x = 1',
      defs: ['x'],
      refs: [],
    });
    expect(idle[1]!.refs).toEqual(['x']);

    await call('cell.run', { cellId: 'a' });
    const ok = (await call('agent.listCells')).result as AgentCellSummary[];
    expect(ok[0]).toMatchObject({ id: 'a', execCount: 1, status: 'ok' });

    // 改 a → b/c 变 stale
    await call('cell.save', { cellId: 'a', code: 'x = 2' });
    const stale = (await call('agent.listCells')).result as AgentCellSummary[];
    expect(stale.find((c) => c.id === 'b')!.status).toBe('stale');

    // b 运行失败 → error（traceback 缓存）
    fakes[0]!.failCell = { cellId: 'b', traceback: 'NameError: x' };
    await call('cell.run', { cellId: 'b' });
    const failed = (await call('agent.listCells')).result as AgentCellSummary[];
    expect(failed.find((c) => c.id === 'b')!.status).toBe('error');
  });
});

describe('agent.cellCode', () => {
  it('返回源码原文；未知 cell → -32602', async () => {
    setup();
    await openNotebook();
    const res = await call('agent.cellCode', { cellId: 'b' });
    expect(res.result).toEqual({ cellId: 'b', code: 'y = x + 1' });
    expect((await call('agent.cellCode', { cellId: 'zz' })).error?.code).toBe(-32602);
  });
});

describe('agent.cellOutput', () => {
  it('未运行过 → 全空快照', async () => {
    setup();
    await openNotebook();
    const out = (await call('agent.cellOutput', { cellId: 'a' })).result as CellOutputSnapshot;
    expect(out).toEqual({ stdout: '', stderr: '', traceback: null, mimeKeys: [], writes: [] });
  });

  it('从 run.* 通知流累积最近一次 stdout / traceback', async () => {
    setup();
    await openNotebook();
    await call('cell.run', { cellId: 'a' });
    const out = (await call('agent.cellOutput', { cellId: 'a' })).result as CellOutputSnapshot;
    expect(out.stdout).toBe('fake output for a\n');
    expect(out.stderr).toBe('');
    expect(out.traceback).toBeNull();

    // 失败运行 → traceback 进缓存
    fakes[0]!.failCell = { cellId: 'b', traceback: 'Traceback: boom' };
    await call('cell.run', { cellId: 'b' });
    const failed = (await call('agent.cellOutput', { cellId: 'b' })).result as CellOutputSnapshot;
    expect(failed.traceback).toBe('Traceback: boom');
  });

  it('超长 traceback 截断至 8KB + 后缀', async () => {
    setup();
    await openNotebook();
    fakes[0]!.failCell = { cellId: 'c', traceback: 'T'.repeat(OUTPUT_CHAR_LIMIT + 5000) };
    await call('cell.run', { cellId: 'c' });
    const out = (await call('agent.cellOutput', { cellId: 'c' })).result as CellOutputSnapshot;
    expect(out.traceback!.length).toBe(OUTPUT_CHAR_LIMIT + TRUNCATION_SUFFIX.length);
    expect(out.traceback!.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it('未知 cell → -32602；repl 输出可读', async () => {
    setup();
    await openNotebook();
    expect((await call('agent.cellOutput', { cellId: 'zz' })).error?.code).toBe(-32602);
    await call('kernel.repl', { code: 'print(1)' });
    const out = (await call('agent.cellOutput', { cellId: 'repl' })).result as CellOutputSnapshot;
    expect(out.stdout).toBe('repl: print(1)\n');
  });

  it('run.notify file-write 透传前端并累积进 writes（P2.9）', async () => {
    setup();
    await openNotebook();
    fakes[0]!.notifyWrites = { cellId: 'a', paths: ['/tmp/out.csv', '/tmp/plot.png'] };
    await call('cell.run', { cellId: 'a' });

    // 透传：broadcast 原样转发 run.notify
    const forwarded = notes.filter((n) => n.method === 'run.notify');
    expect(forwarded).toHaveLength(2);
    expect(forwarded[0]!.params).toEqual({ cellId: 'a', kind: 'file-write', path: '/tmp/out.csv' });

    // 累积：agent.cellOutput 带上 writes
    const out = (await call('agent.cellOutput', { cellId: 'a' })).result as CellOutputSnapshot;
    expect(out.writes).toEqual(['/tmp/out.csv', '/tmp/plot.png']);
  });

  it('writes 去重且封顶 50 条；重跑（run.started）清空', async () => {
    setup();
    await openNotebook();
    const many = Array.from({ length: WRITES_PATH_LIMIT + 20 }, (_, i) => `/tmp/f${i}.dat`);
    fakes[0]!.notifyWrites = { cellId: 'b', paths: [...many, '/tmp/dup.csv', '/tmp/dup.csv'] };
    await call('cell.run', { cellId: 'b' });
    const out = (await call('agent.cellOutput', { cellId: 'b' })).result as CellOutputSnapshot;
    expect(out.writes).toHaveLength(WRITES_PATH_LIMIT);

    fakes[0]!.notifyWrites = { cellId: 'b', paths: ['/tmp/only.csv'] };
    await call('cell.run', { cellId: 'b' });
    const next = (await call('agent.cellOutput', { cellId: 'b' })).result as CellOutputSnapshot;
    expect(next.writes).toEqual(['/tmp/only.csv']);
  });

  it('非 file-write kind / 缺 path 不进 writes，但仍透传', async () => {
    setup();
    await openNotebook();
    sup!.emit('notification', {
      method: 'run.notify',
      params: { cellId: 'a', kind: 'network-request', url: 'http://x' },
    });
    sup!.emit('notification', { method: 'run.notify', params: { cellId: 'a', kind: 'file-write' } });
    const out = (await call('agent.cellOutput', { cellId: 'a' })).result as CellOutputSnapshot;
    expect(out.writes).toEqual([]);
    // 透传与 kind 无关：router 对内核通知一律 broadcast
    expect(countNotes('run.notify')).toBe(2);
  });
});

describe('diff.stage 编译预检（P2.7）', () => {
  it('compileError → 不 stage，返回 {rejected:true, reason}', async () => {
    setup();
    await openNotebook();
    fakes[0]!.nextCompileError = { message: 'multiple definitions of x', cellIds: ['a', 'b'] };
    const res = await call('diff.stage', {
      targetCellId: 'b',
      action: 'update',
      newCode: 'x = 1',
    });
    expect(res.error).toBeUndefined();
    const out = res.result as StageResult;
    expect(out).toEqual({
      rejected: true,
      reason: { message: 'multiple definitions of x', cellIds: ['a', 'b'] },
    });
    // 未入队：无 diff.updated 广播，后续 accept 无 diffId 可用
    expect(countNotes('diff.updated')).toBe(0);

    // 试探 + 回滚 = 2 次 set_cells；试探带候选码，回滚复原
    const setCells = fakes[0]!.requests.filter((r) => r.method === 'set_cells');
    expect(setCells).toHaveLength(2);
    const probe = (setCells[0]!.params as { cells: { id: string; code: string }[] }).cells;
    const rollback = (setCells[1]!.params as { cells: { id: string; code: string }[] }).cells;
    expect(probe.find((c) => c.id === 'b')!.code).toBe('x = 1');
    expect(rollback.find((c) => c.id === 'b')!.code).toBe('y = x + 1');
    // 缓存未被污染
    expect((await call('agent.cellCode', { cellId: 'b' })).result).toEqual({
      cellId: 'b',
      code: 'y = x + 1',
    });
  });

  it('预检通过 → 正常 stage + diff.updated；回滚发生在 stage 前', async () => {
    setup();
    await openNotebook();
    const res = await call('diff.stage', {
      targetCellId: 'b',
      action: 'update',
      newCode: 'y = x + 2',
    });
    const out = res.result as StageResult;
    expect(out).toEqual({ diffId: 'diff-1' });
    expect(countNotes('diff.updated')).toBe(1);

    const setCells = fakes[0]!.requests.filter((r) => r.method === 'set_cells');
    expect(setCells).toHaveLength(2); // 试探 + 回滚（stage 本身不改内核）
    const rollback = (setCells[1]!.params as { cells: { id: string; code: string }[] }).cells;
    expect(rollback.find((c) => c.id === 'b')!.code).toBe('y = x + 1');
    // 内核回滚不影响缓存里的 diff 队列
    const diffs = (notes.find((n) => n.method === 'diff.updated')!.params as DiffUpdatedParams).diffs;
    expect(diffs[0]).toMatchObject({ diffId: 'diff-1', newCode: 'y = x + 2', status: 'proposed' });
  });

  it('insert_below 预检：候选含临时 id 的新 cell', async () => {
    setup();
    await openNotebook();
    const res = await call('diff.stage', {
      targetCellId: 'a',
      action: 'insert_below',
      newCode: 'z = x * 10',
    });
    expect(res.result).toEqual({ diffId: 'diff-1' });
    const setCells = fakes[0]!.requests.filter((r) => r.method === 'set_cells');
    const probe = (setCells[0]!.params as { cells: { id: string; code: string }[] }).cells;
    expect(probe).toHaveLength(4);
    expect(probe[1]).toEqual({ id: '__diff_precheck__', code: 'z = x * 10' });
    const rollback = (setCells[1]!.params as { cells: { id: string; code: string }[] }).cells;
    expect(rollback).toHaveLength(3);
  });

  it('未 open → -32001（预检不改变前置校验）', async () => {
    setup();
    const res = await call('diff.stage', { targetCellId: 'a', action: 'update', newCode: 'x' });
    expect(res.error?.code).toBe(-32001);
  });
});
