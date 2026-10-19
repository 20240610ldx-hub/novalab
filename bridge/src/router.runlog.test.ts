/**
 * ADR-014：router 把每次 cell 执行写进 `.novalab/sessions/<id>.runs.jsonl`，并经 session.runs 读回。
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KernelSupervisor } from './supervisor';
import { RpcRouter } from './router';
import { FakeKernel } from './testing/fake-kernel';
import type { RpcResponse } from './protocol';
import type { RunLogRecord } from './run-log';
import { executeAgentTool, sanitizeToolOutput } from './mcp/tools';

let sup: KernelSupervisor | undefined;
let fakes: FakeKernel[] = [];
let notes: { method: string; params?: unknown }[] = [];
let router: RpcRouter;
let reqId = 0;

function setup(): void {
  fakes = [];
  notes = [];
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
    confirmers: () => 1,
  });
}

async function call(method: string, params?: unknown): Promise<RpcResponse> {
  return router.handle({ jsonrpc: '2.0', id: ++reqId, method, params });
}

async function open(): Promise<string> {
  const nb = path.join(mkdtempSync(path.join(tmpdir(), 'novalab-runlog-')), 'demo.py');
  const res = await call('notebook.open', { path: nb });
  expect(res.error).toBeUndefined();
  return nb;
}

async function runs(params: Record<string, unknown> = {}): Promise<{ records: RunLogRecord[]; truncated: boolean }> {
  const res = await call('session.runs', params);
  expect(res.error).toBeUndefined();
  return res.result as { records: RunLogRecord[]; truncated: boolean };
}

afterEach(() => {
  sup?.stop();
  sup = undefined;
});

describe('运行日志（ADR-014）', () => {
  it('改一点再跑：两次尝试各一行，代码哈希不同、第二次内联新代码', async () => {
    setup();
    await open();
    await call('cell.run', { cellId: 'a' });
    await call('cell.save', { cellId: 'a', code: 'x = 2' });
    await call('cell.run', { cellId: 'a' });
    const { records } = await runs({ cellId: 'a' });
    expect(records.map((r) => [r.attempt, r.code, r.trigger, r.actor, r.ok])).toEqual([
      [1, 'x = 1', 'direct', 'user', true],
      [2, 'x = 2', 'direct', 'user', true],
    ]);
    expect(records[0]!.codeSha256).not.toBe(records[1]!.codeSha256);
  });

  it('失败也记：ok=false、计数照增、错误只留异常类名', async () => {
    setup();
    await open();
    fakes[0]!.failCell = { cellId: 'b', traceback: 'Traceback (most recent call last):\nKeyError: \'secret-value\'' };
    await call('cell.run', { cellId: 'b' });
    const [rec] = (await runs({ cellId: 'b' })).records;
    expect(rec).toMatchObject({ ok: false, attempt: 1, error: { name: 'KeyError' } });
    expect(JSON.stringify(rec)).not.toContain('secret-value'); // 不存 evalue
  });

  it('级联下游各自成行：trigger=cascade、rootRunId 指向根运行', async () => {
    setup();
    await open();
    await call('cell.run', { cellId: 'a', cascade: true });
    const { records } = await runs();
    const root = records.find((r) => r.cellId === 'a')!;
    expect(root.trigger).toBe('direct');
    const downstream = records.filter((r) => r.cellId !== 'a');
    expect(downstream.length).toBeGreaterThan(0);
    for (const r of downstream) expect(r).toMatchObject({ trigger: 'cascade', rootRunId: root.runId });
  });

  it('Agent 经 execute_cell（用户确认后）触发的运行记 actor=agent', async () => {
    setup();
    await open();
    const pending = call('agent.executeCell', { cellId: 'a' });
    await new Promise((r) => setTimeout(r, 10));
    const req = notes.find((n) => n.method === 'agent.confirmRequest')!.params as { requestId: string };
    await call('agent.confirmResponse', { requestId: req.requestId, allow: true });
    expect((await pending).error).toBeUndefined();
    expect((await runs({ cellId: 'a' })).records[0]).toMatchObject({ actor: 'agent', trigger: 'direct' });
  });

  it('REPL 也记（trigger=repl，代码为 REPL 输入）', async () => {
    setup();
    await open();
    await call('kernel.repl', { code: 'x * 10' });
    expect((await runs({ cellId: 'repl' })).records[0]).toMatchObject({ trigger: 'repl', code: 'x * 10', ok: true });
  });

  it('导出 .ipynb：每个 cell 的 metadata.novalab.runs 带尝试历史（无代码正文、无输出）', async () => {
    setup();
    const nb = await open();
    await call('cell.run', { cellId: 'a' });
    fakes[0]!.failCell = { cellId: 'a', traceback: 'Traceback (most recent call last):\nValueError: boom' };
    await call('cell.run', { cellId: 'a' });
    const target = path.join(path.dirname(nb), 'out.ipynb');
    expect((await call('export.ipynb', { path: nb, target })).error).toBeUndefined();
    const ipynb = JSON.parse(readFileSync(target, 'utf8')) as { cells: { id: string; metadata: Record<string, unknown> }[] };
    const cellA = ipynb.cells.find((c) => c.id === 'a')!;
    const hist = (cellA.metadata['novalab'] as { runs: Record<string, unknown>[] }).runs;
    expect(hist.map((r) => r['ok'])).toEqual([true, false]);
    expect(hist[1]).toMatchObject({ attempt: 2, error: { name: 'ValueError' }, actor: 'user', trigger: 'direct' });
    for (const r of hist) {
      expect(r).not.toHaveProperty('code');
      expect(r).not.toHaveProperty('out');
    }
    expect(ipynb.cells.find((c) => c.id === 'c')!.metadata).toEqual({}); // 没跑过的 cell 不加元数据
  });

  it('采纳 Diff 后的运行记 trigger=accept', async () => {
    setup();
    await open();
    const staged = (await call('diff.stage', { targetCellId: 'a', action: 'update', newCode: 'x = 5' })).result as { diffId: string };
    await call('diff.accept', { diffId: staged.diffId });
    expect((await runs({ cellId: 'a' })).records.at(-1)).toMatchObject({ trigger: 'accept', code: 'x = 5' });
  });

  it('Agent 工具 get_run_history（O2）：成败 / 错误类名 / 变化行过白名单闸，异常信息正文不出进程', async () => {
    setup();
    await open();
    fakes[0]!.failCell = { cellId: 'a', traceback: "Traceback (most recent call last):\nKeyError: 'secret-value'" };
    await call('cell.run', { cellId: 'a' });
    fakes[0]!.failCell = undefined;
    await call('cell.save', { cellId: 'a', code: 'x = 2' });
    await call('cell.run', { cellId: 'a' });
    await call('cell.run', { cellId: 'a' });
    const raw = await executeAgentTool(router, 'get_run_history', { cellId: 'a' });
    const gate = sanitizeToolOutput('get_run_history', raw);
    expect(gate.redacted).toBe(false);
    expect(gate.droppedKeys).toEqual([]);
    expect(gate.output).toEqual({
      cellId: 'a',
      totalAttempts: 3,
      attempts: [
        { attempt: 1, ok: false, actor: 'user', trigger: 'direct', durationMs: expect.any(Number), error: { name: 'KeyError' }, codeChanged: false },
        { attempt: 2, ok: true, actor: 'user', trigger: 'direct', durationMs: expect.any(Number), codeChanged: true, diff: '- x = 1\n+ x = 2' },
        { attempt: 3, ok: true, actor: 'user', trigger: 'direct', durationMs: expect.any(Number), codeChanged: false },
      ],
    });
    expect(JSON.stringify(gate.output)).not.toContain('secret-value');
    const last = await executeAgentTool(router, 'get_run_history', { cellId: 'a', limit: 1 });
    expect(last).toMatchObject({ totalAttempts: 3, attempts: [{ attempt: 3 }] });
    expect((await call('agent.runHistory', { cellId: 'nope' })).error).toBeDefined();
  });
});
