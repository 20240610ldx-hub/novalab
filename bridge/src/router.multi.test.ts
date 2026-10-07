/**
 * P3.1 多 tab 多内核路由测试（intent S1 / A-2 #18）。
 *
 * 用 MultiSupervisor（每 path 一 FakeKernel）验证：
 * - 双内核并存（两个 FakeKernel 同时保活）；
 * - switch 焦点隔离（A 的 cell.run 不落到 B 的内核 / 不改 B 的缓存）；
 * - notebook.close → 会话 ended('shutdown') + snapshot 落盘 + tab 摘除；
 * - notebook.list 的 rssMB 字段形状（FakeKernel 无 pid → null）。
 */

import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MultiSupervisor } from './supervisor';
import { RpcRouter } from './router';
import { FakeKernel } from './testing/fake-kernel';
import type {
  NotebookOpenResult,
  NotebookSummary,
  RpcResponse,
  RunReport,
  SessionEndedParams,
} from './protocol';

let multi: MultiSupervisor | undefined;
let fakes: FakeKernel[] = [];
let notes: { method: string; params?: unknown }[] = [];
let router: RpcRouter;
let reqId = 0;

const dirA = mkdtempSync(path.join(tmpdir(), 'novalab-multi-a-'));
const dirB = mkdtempSync(path.join(tmpdir(), 'novalab-multi-b-'));
const NB_A = path.join(dirA, 'a.py');
const NB_B = path.join(dirB, 'b.py');
const SESSIONS_A = path.join(dirA, '.novalab', 'sessions');

function setup(): void {
  fakes = [];
  notes = [];
  reqId = 0;
  multi = new MultiSupervisor({
    transportFactory: () => {
      const f = new FakeKernel();
      const idx = fakes.length;
      // 每个内核预置唯一 cell（k0 / k1 …），便于断言焦点隔离
      f.cells = [{ id: `k${idx}`, code: `v${idx} = ${idx}`, execCount: 0, defs: [`v${idx}`], refs: [] }];
      fakes.push(f);
      return f;
    },
    pingIntervalMs: 60_000, // 测试期间不触发 health ping
  });
  router = new RpcRouter({
    multi,
    broadcast: (method, params) => notes.push({ method, params }),
  });
}

async function call(method: string, params?: unknown): Promise<RpcResponse> {
  return router.handle({ jsonrpc: '2.0', id: ++reqId, method, params });
}

async function open(path_: string): Promise<NotebookOpenResult> {
  const res = await call('notebook.open', { path: path_ });
  expect(res.error).toBeUndefined();
  return res.result as NotebookOpenResult;
}

function lastParams<T>(method: string): T | undefined {
  for (let i = notes.length - 1; i >= 0; i--) {
    if (notes[i]!.method === method) return notes[i]!.params as T;
  }
  return undefined;
}

afterEach(() => {
  multi?.stopAll();
  multi = undefined;
});

describe('RpcRouter · P3.1 多 tab 多内核', () => {
  it('notebook.open 返回 {notebookId, state}；两个 notebook = 两个并存 FakeKernel', async () => {
    setup();
    const a = await open(NB_A);
    const b = await open(NB_B);
    expect(a.notebookId).toMatch(/^nb-[0-9a-f]{8}$/);
    expect(b.notebookId).not.toBe(a.notebookId);
    expect(a.state.cells.map((c) => c.id)).toEqual(['k0']);
    expect(b.state.cells.map((c) => c.id)).toEqual(['k1']);
    // 双内核保活：两个 FakeKernel 都创建且各自 load_file 一次
    expect(fakes).toHaveLength(2);
    expect(fakes[0]!.loadedPath).toBe(NB_A);
    expect(fakes[1]!.loadedPath).toBe(NB_B);
    expect(fakes[0]!.countOf('load_file')).toBe(1);
    expect(fakes[1]!.countOf('load_file')).toBe(1);

    const list = (await call('notebook.list')).result as NotebookSummary[];
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.path)).toEqual([NB_A, NB_B]);
    expect(list.every((s) => s.kernelState === 'idle')).toBe(true);
    // open 期间焦点内核的 kernel.status（restarting→idle）应广播给前端（状态 pill 不卡 connecting）
    const statuses = notes.filter((n) => n.method === 'kernel.status');
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.at(-1)!.params).toMatchObject({ state: 'idle' });
  });

  it('同一路径重复 open = 聚焦既有 tab，不新建内核（进程保活）', async () => {
    setup();
    const a1 = await open(NB_A);
    const a2 = await open(NB_A);
    expect(a2.notebookId).toBe(a1.notebookId);
    expect(fakes).toHaveLength(1);
    expect(fakes[0]!.countOf('load_file')).toBe(1); // 未重启
    const list = (await call('notebook.list')).result as NotebookSummary[];
    expect(list).toHaveLength(1);
  });

  it('switch 焦点隔离：A 的 cell.run 不落到 B 的内核，也不改 B 的缓存', async () => {
    setup();
    const a = await open(NB_A);
    const b = await open(NB_B);

    // 焦点切到 A，运行 A 的 cell
    const swA = await call('notebook.switch', { notebookId: a.notebookId });
    expect((swA.result as NotebookOpenResult).notebookId).toBe(a.notebookId);
    expect(lastParams<{ notebookId: string }>('focus.changed')).toEqual({ notebookId: a.notebookId });

    const runA = await call('cell.run', { cellId: 'k0', cascade: false });
    expect((runA.result as RunReport).ok).toBe(true);
    expect(fakes[0]!.countOf('exec_cell')).toBe(1);
    expect(fakes[1]!.countOf('exec_cell')).toBe(0); // B 的内核未受影响

    // 焦点在 A 时，B 的 cell id 未知（缓存隔离）
    expect((await call('cell.run', { cellId: 'k1', cascade: false })).error?.code).toBe(-32602);

    // 切到 B：其状态仍是初始（execCount 0），A 的运行没有污染 B
    const swB = await call('notebook.switch', { notebookId: b.notebookId });
    const bState = (swB.result as NotebookOpenResult).state;
    expect(bState.cells.map((c) => c.id)).toEqual(['k1']);
    expect(bState.cells[0]!.execCount).toBe(0);
    const listCells = (await call('agent.listCells')).result as { id: string }[];
    expect(listCells.map((c) => c.id)).toEqual(['k1']);

    // B 上运行自己的 cell 正常，且不落到 A
    const runB = await call('cell.run', { cellId: 'k1', cascade: false });
    expect((runB.result as RunReport).ok).toBe(true);
    expect(fakes[1]!.countOf('exec_cell')).toBe(1);
    expect(fakes[0]!.countOf('exec_cell')).toBe(1); // A 仍只有先前那一次
  });

  it('切 tab 不杀内核：切走再切回，进程保活、执行计数仍在', async () => {
    setup();
    const a = await open(NB_A);
    const b = await open(NB_B);
    await call('notebook.switch', { notebookId: a.notebookId });
    await call('cell.run', { cellId: 'k0', cascade: false });
    // 切到 B 再切回 A：内核未被杀（仍是同一 FakeKernel，无重 spawn）
    await call('notebook.switch', { notebookId: b.notebookId });
    await call('notebook.switch', { notebookId: a.notebookId });
    expect(fakes).toHaveLength(2);
    expect(fakes[0]!.countOf('load_file')).toBe(1);
    const aState = (await call('notebook.switch', { notebookId: a.notebookId })).result as NotebookOpenResult;
    expect(aState.state.cells[0]!.execCount).toBe(1); // 执行计数保活
  });

  it('notebook.close：save_file + 会话 ended(shutdown) + snapshot 落盘 + tab 摘除 + 焦点转移', async () => {
    setup();
    const a = await open(NB_A);
    const b = await open(NB_B);
    await call('notebook.switch', { notebookId: a.notebookId });
    await call('cell.run', { cellId: 'k0', cascade: false });
    notes = [];

    const closeRes = await call('notebook.close', { notebookId: a.notebookId });
    expect(closeRes.result).toEqual({ notebookId: a.notebookId, closed: true });

    // 未保存改动先 save_file（FakeKernel 收到 save_file）
    expect(fakes[0]!.countOf('save_file')).toBeGreaterThanOrEqual(1);
    // 会话 ended 广播，reason=shutdown
    expect(lastParams<SessionEndedParams>('session.ended')).toMatchObject({ reason: 'shutdown' });
    // snapshot 落盘：A 的 sessions 目录出现 <id>.snapshot.json
    const snapshotFiles = readdirSync(SESSIONS_A).filter((f) => f.endsWith('.snapshot.json'));
    expect(snapshotFiles.length).toBeGreaterThanOrEqual(1);
    const snap = JSON.parse(readFileSync(path.join(SESSIONS_A, snapshotFiles[0]!), 'utf8')) as {
      endReason?: string;
      cells: { id: string }[];
    };
    expect(snap.endReason).toBe('shutdown');
    expect(snap.cells.map((c) => c.id)).toEqual(['k0']);

    // tab 摘除 + A 的内核已停（进程退场）
    const list = (await call('notebook.list')).result as NotebookSummary[];
    expect(list.map((s) => s.notebookId)).toEqual([b.notebookId]);
    // 焦点转移到剩下的 B
    expect(lastParams<{ notebookId: string }>('focus.changed')).toEqual({ notebookId: b.notebookId });
    const listCells = (await call('agent.listCells')).result as { id: string }[];
    expect(listCells.map((c) => c.id)).toEqual(['k1']);
  });

  it('notebook.close 未知 id → -32602；关掉唯一 tab 后焦点为空 → 业务方法 -32001', async () => {
    setup();
    const a = await open(NB_A);
    expect((await call('notebook.close', { notebookId: 'nb-deadbeef' })).error?.code).toBe(-32602);
    await call('notebook.close', { notebookId: a.notebookId });
    expect((await call('notebook.list')).result).toEqual([]);
    expect((await call('cell.run', { cellId: 'k0' })).error?.code).toBe(-32001);
  });

  it('notebook.list：rssMB 字段形状（FakeKernel 无 pid → null），kernelState/cellCount 就位', async () => {
    setup();
    await open(NB_A);
    const list = (await call('notebook.list')).result as NotebookSummary[];
    expect(list).toHaveLength(1);
    const s = list[0]!;
    // 形状断言：rssMB 存在且为 number|null（Windows/无 pid 环境为 null）
    expect('rssMB' in s).toBe(true);
    expect(s.rssMB === null || typeof s.rssMB === 'number').toBe(true);
    expect(s.kernelState).toBe('idle');
    expect(s.cellCount).toBe(1);
    expect(s.ended).toBeUndefined();
    expect(typeof s.notebookId).toBe('string');
    expect(s.path).toBe(NB_A);
  });

  it('内核崩溃 → 该 tab list 标记 ended（view-only 数据源）', async () => {
    setup();
    const a = await open(NB_A);
    fakes[0]!.crash(1);
    const list = (await call('notebook.list')).result as NotebookSummary[];
    const s = list.find((x) => x.notebookId === a.notebookId)!;
    expect(s.kernelState).toBe('dead');
    expect(s.ended).toBe(true);
  });

  it('snapshot 落盘存在性 sanity（避免误读空目录）', async () => {
    setup();
    await open(NB_A);
    expect(existsSync(SESSIONS_A)).toBe(true);
    // index.json 有一条 live 会话
    const index = JSON.parse(readFileSync(path.join(SESSIONS_A, 'index.json'), 'utf8')) as { id: string }[];
    expect(index.length).toBeGreaterThanOrEqual(1);
  });
});
