import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KernelSupervisor } from './supervisor';
import { RpcRouter } from './router';
import { FakeKernel } from './testing/fake-kernel';
import type { DiffUpdatedParams, RpcResponse } from './protocol';

/**
 * F2（ADR-012 G-1 真实复现）：「把定义搬到新 cell」需要两条 diff（update 原 cell 去掉定义 +
 * insert_below 新 cell）。旧预检只看「当前 cells + 本条」，两种顺序都被单赋值拒绝。
 * 新语义：有待审 diff 时，本条既单独验证、也叠加全部待审 diff 验证；
 * 单独失败而叠加通过 → 入队并记录 dependsOn；单独通过而叠加失败 → 与待审 diff 冲突，拒绝。
 */

const NB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'novalab-diffqueue-')), 'demo.py');
const HELPER = 'def helper(v):\n    return v + 1';

let sup: KernelSupervisor | undefined;
let fake: FakeKernel;
let notes: { method: string; params?: unknown }[] = [];
let router: RpcRouter;
let reqId = 0;

async function setup(): Promise<void> {
  notes = [];
  reqId = 0;
  sup = new KernelSupervisor({
    transportFactory: () => {
      fake = new FakeKernel();
      fake.detectDuplicateDefs = true;
      fake.cells = [
        { id: 'a', code: `${HELPER}\ny = helper(1)`, execCount: 0, defs: ['helper', 'y'], refs: [] },
        { id: 'b', code: 'z = y * 2', execCount: 0, defs: ['z'], refs: ['y'] },
      ];
      return fake;
    },
    pingIntervalMs: 60_000,
  });
  router = new RpcRouter({ supervisor: sup, broadcast: (method, params) => notes.push({ method, params }) });
  const opened = await call('notebook.open', { path: NB_PATH });
  expect(opened.error).toBeUndefined();
}

async function call(method: string, params?: unknown): Promise<RpcResponse> {
  return router.handle({ jsonrpc: '2.0', id: ++reqId, method, params });
}

function lastDiffs(): DiffUpdatedParams['diffs'] {
  for (let i = notes.length - 1; i >= 0; i--) {
    if (notes[i]!.method === 'diff.updated') return (notes[i]!.params as DiffUpdatedParams).diffs;
  }
  return [];
}

function validateCandidates(): { id: string; code: string }[][] {
  return fake.requests
    .filter((r) => r.method === 'validate_cells')
    .map((r) => (r.params as { cells: { id: string; code: string }[] }).cells);
}

afterEach(() => {
  sup?.stop();
  sup = undefined;
});

describe('diff 队列 · 叠加待审 diff 预检（F2）', () => {
  it('没有待审 diff 时仍只验证一次（保持既有行为）', async () => {
    await setup();
    const res = await call('diff.stage', { targetCellId: 'b', action: 'update', newCode: 'z = y * 3' });
    expect(res.result).toEqual({ diffId: 'diff-1' });
    expect(fake.countOf('validate_cells')).toBe(1);
  });

  it('搬移定义（先 update 原 cell、再 insert 新 cell）：第二条入队并记录 dependsOn', async () => {
    await setup();
    expect((await call('diff.stage', { targetCellId: 'a', action: 'update', newCode: 'y = helper(1)' })).result).toEqual({ diffId: 'diff-1' });
    const inserted = await call('diff.stage', { targetCellId: 'a', action: 'insert_below', newCode: HELPER });
    expect(inserted.result).toEqual({ diffId: 'diff-2', dependsOn: ['diff-1'] });
    expect(lastDiffs().find((d) => d.diffId === 'diff-2')?.dependsOn).toEqual(['diff-1']);
    // 叠加候选里原 cell 已是 diff-1 的新代码，新 cell 带 helper 定义
    const stacked = validateCandidates().at(-1)!;
    expect(stacked.find((c) => c.id === 'a')?.code).toBe('y = helper(1)');
    expect(stacked.filter((c) => c.code === HELPER)).toHaveLength(1);
    expect(fake.countOf('set_cells')).toBe(0);
    expect(fake.countOf('exec_cell')).toBe(0);
  });

  it('依赖未采纳时先采纳后一条 → 拒绝且不改动 notebook；按顺序采纳都成功', async () => {
    await setup();
    await call('diff.stage', { targetCellId: 'a', action: 'update', newCode: 'y = helper(1)' });
    await call('diff.stage', { targetCellId: 'a', action: 'insert_below', newCode: HELPER });
    const early = await call('diff.accept', { diffId: 'diff-2' });
    expect(early.error?.code).toBe(-32602);
    expect(early.error?.message).toContain('diff-1');
    expect(fake.countOf('set_cells')).toBe(0);
    expect(lastDiffs().find((d) => d.diffId === 'diff-2')?.status).toBe('proposed');

    expect((await call('diff.accept', { diffId: 'diff-1' })).error).toBeUndefined();
    const second = await call('diff.accept', { diffId: 'diff-2' });
    expect(second.error).toBeUndefined();
    expect((second.result as { compileError?: unknown }).compileError).toBeUndefined();
  });

  it('依赖被拒绝后，采纳依赖它的 diff → 拒绝并提示重新提议', async () => {
    await setup();
    await call('diff.stage', { targetCellId: 'a', action: 'update', newCode: 'y = helper(1)' });
    await call('diff.stage', { targetCellId: 'a', action: 'insert_below', newCode: HELPER });
    await call('diff.reject', { diffId: 'diff-1' });
    const res = await call('diff.accept', { diffId: 'diff-2' });
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toMatch(/diff-1.*rejected/);
    expect(fake.countOf('set_cells')).toBe(0);
  });

  it('搬移顺序反了（先 insert）：拒绝，并提示先 update 当前定义它的 cell', async () => {
    await setup();
    const res = await call('diff.stage', { targetCellId: 'a', action: 'insert_below', newCode: HELPER });
    const out = res.result as { rejected?: boolean; reason?: { message: string }; hint?: string };
    expect(out.rejected).toBe(true);
    expect(out.reason?.message).toContain("multiple definitions of 'helper'");
    expect(out.hint).toContain('update');
    expect(out.hint).toContain("'a'");
  });

  it('同一条消息里并发的两次 stage（AI SDK 并行工具调用，ADR-012 F3）按到达顺序串行，第二条看得到第一条', async () => {
    await setup();
    const [first, second] = await Promise.all([
      call('diff.stage', { targetCellId: 'a', action: 'update', newCode: 'y = helper(1)' }),
      call('diff.stage', { targetCellId: 'a', action: 'insert_below', newCode: HELPER }),
    ]);
    expect(first.result).toEqual({ diffId: 'diff-1' });
    expect(second.result).toEqual({ diffId: 'diff-2', dependsOn: ['diff-1'] });
  });

  it('单独通过、叠加待审 diff 后冲突 → 拒绝并指出冲突的待审 diff', async () => {
    await setup();
    await call('diff.stage', { targetCellId: 'b', action: 'update', newCode: 'z = y * 2\nw = 1' });
    const res = await call('diff.stage', { targetCellId: 'a', action: 'update', newCode: `${HELPER}\ny = helper(1)\nw = 2` });
    const out = res.result as { rejected?: boolean; reason?: { message: string }; conflictsWith?: string[] };
    expect(out.rejected).toBe(true);
    expect(out.reason?.message).toContain("multiple definitions of 'w'");
    expect(out.conflictsWith).toEqual(['diff-1']);
    expect(lastDiffs()).toHaveLength(1);
  });
});
