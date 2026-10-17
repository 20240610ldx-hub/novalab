import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KernelSupervisor } from './supervisor';
import { RpcRouter, type RouterDeps } from './router';
import { FakeKernel } from './testing/fake-kernel';
import type { RpcResponse } from './protocol';

/**
 * execute_cell 过渡确认（ADR-013 落地前）：Agent 每次执行 cell 都要用户在界面上点「允许」。
 * agent.executeCell → 广播 agent.confirmRequest → 前端回 agent.confirmResponse（先到先得）
 * → 广播 agent.confirmResolved → 允许才 exec_cell。没有可确认的前端（MCP 模式）一律拒绝。
 */

const DIR = mkdtempSync(path.join(tmpdir(), 'novalab-confirm-'));

let sup: KernelSupervisor | undefined;
let fake: FakeKernel;
let notes: { method: string; params?: unknown }[] = [];
let router: RpcRouter;
let reqId = 0;

interface ConfirmRequest {
  requestId: string;
  kind: string;
  cellId: string;
  code: string;
  cascade: boolean;
}

async function setup(extra: Partial<RouterDeps> = {}): Promise<void> {
  notes = [];
  reqId = 0;
  sup = new KernelSupervisor({
    transportFactory: () => {
      fake = new FakeKernel();
      fake.cells = [{ id: 'a', code: 'x = 1', execCount: 0, defs: ['x'], refs: [] }];
      return fake;
    },
    pingIntervalMs: 60_000,
  });
  router = new RpcRouter({ supervisor: sup, broadcast: (method, params) => notes.push({ method, params }), ...extra });
  expect((await call('notebook.open', { path: path.join(DIR, 'demo.py') })).error).toBeUndefined();
}

function call(method: string, params?: unknown): Promise<RpcResponse> {
  return router.handle({ jsonrpc: '2.0', id: ++reqId, method, params });
}

async function nextConfirmRequest(): Promise<ConfirmRequest> {
  for (let i = 0; i < 50; i++) {
    const n = notes.find((x) => x.method === 'agent.confirmRequest');
    if (n) return n.params as ConfirmRequest;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('no agent.confirmRequest broadcast');
}

afterEach(() => {
  router?.dispose();
  sup?.stop();
  sup = undefined;
});

describe('agent.executeCell · 逐次用户确认', () => {
  it('没有可确认的前端（MCP 模式 / 无 WS 客户端）→ denied no-confirmer，不执行', async () => {
    await setup();
    const res = await call('agent.executeCell', { cellId: 'a' });
    expect(res.result).toMatchObject({ denied: true, reason: 'no-confirmer' });
    expect(fake.countOf('exec_cell')).toBe(0);
    expect(notes.some((n) => n.method === 'agent.confirmRequest')).toBe(false);
  });

  it('用户允许 → 广播请求（含源码）→ 执行并返回 run 报告；广播 resolved', async () => {
    await setup({ confirmers: () => 1 });
    const pending = call('agent.executeCell', { cellId: 'a', cascade: true });
    const req = await nextConfirmRequest();
    expect(req).toMatchObject({ kind: 'execute_cell', cellId: 'a', code: 'x = 1', cascade: true });
    expect(fake.countOf('exec_cell')).toBe(0);

    expect((await call('agent.confirmResponse', { requestId: req.requestId, allow: true })).error).toBeUndefined();
    const res = await pending;
    expect(res.result).toMatchObject({ cellId: 'a', ok: true });
    expect(fake.countOf('exec_cell')).toBe(1);
    expect(notes.find((n) => n.method === 'agent.confirmResolved')?.params).toMatchObject({
      requestId: req.requestId,
      outcome: 'allowed',
    });
  });

  it('用户拒绝 → denied user-declined，不执行', async () => {
    await setup({ confirmers: () => 1 });
    const pending = call('agent.executeCell', { cellId: 'a' });
    const req = await nextConfirmRequest();
    await call('agent.confirmResponse', { requestId: req.requestId, allow: false });
    expect((await pending).result).toMatchObject({ denied: true, reason: 'user-declined' });
    expect(fake.countOf('exec_cell')).toBe(0);
  });

  it('超时 → denied timeout；之后的迟到回复被拒', async () => {
    await setup({ confirmers: () => 1, confirmTimeoutMs: 20 });
    const pending = call('agent.executeCell', { cellId: 'a' });
    const req = await nextConfirmRequest();
    expect((await pending).result).toMatchObject({ denied: true, reason: 'timeout' });
    const late = await call('agent.confirmResponse', { requestId: req.requestId, allow: true });
    expect(late.error?.code).toBe(-32602);
    expect(fake.countOf('exec_cell')).toBe(0);
  });

  it('多个窗口：先到先得，第二个回复被拒', async () => {
    await setup({ confirmers: () => 2 });
    const pending = call('agent.executeCell', { cellId: 'a' });
    const req = await nextConfirmRequest();
    await call('agent.confirmResponse', { requestId: req.requestId, allow: false });
    const second = await call('agent.confirmResponse', { requestId: req.requestId, allow: true });
    expect(second.error?.code).toBe(-32602);
    expect((await pending).result).toMatchObject({ denied: true, reason: 'user-declined' });
  });

  it('等待期间源码被改 → 批准作废（code-changed），不执行', async () => {
    await setup({ confirmers: () => 1 });
    const pending = call('agent.executeCell', { cellId: 'a' });
    const req = await nextConfirmRequest();
    expect((await call('cell.save', { cellId: 'a', code: 'x = 2' })).error).toBeUndefined();
    await call('agent.confirmResponse', { requestId: req.requestId, allow: true });
    expect((await pending).result).toMatchObject({ denied: true, reason: 'code-changed' });
    expect(fake.countOf('exec_cell')).toBe(0);
  });

  it('等待期间切换 notebook → 批准作废（focus-changed），不执行', async () => {
    await setup({ confirmers: () => 1 });
    const pending = call('agent.executeCell', { cellId: 'a' });
    const req = await nextConfirmRequest();
    expect((await call('notebook.open', { path: path.join(DIR, 'other.py') })).error).toBeUndefined();
    await call('agent.confirmResponse', { requestId: req.requestId, allow: true });
    expect((await pending).result).toMatchObject({ denied: true, reason: 'focus-changed' });
    expect(fake.countOf('exec_cell')).toBe(0);
  });

  it('dispose 时在途确认按 timeout 结算（不悬挂）', async () => {
    await setup({ confirmers: () => 1 });
    const pending = call('agent.executeCell', { cellId: 'a' });
    await nextConfirmRequest();
    router.dispose();
    expect((await pending).result).toMatchObject({ denied: true });
  });

  it('未知 cellId → 参数错误，不发确认', async () => {
    await setup({ confirmers: () => 1 });
    const res = await call('agent.executeCell', { cellId: 'zz' });
    expect(res.error?.code).toBe(-32602);
    expect(notes.some((n) => n.method === 'agent.confirmRequest')).toBe(false);
  });
});
