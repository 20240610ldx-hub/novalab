import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KernelSupervisor } from './supervisor';
import { RpcRouter, type RouterDeps } from './router';
import { FakeKernel } from './testing/fake-kernel';
import type { RpcResponse } from './protocol';
import type { ShadowRunner, ShadowRunOutcome, ShadowRunRequest, ShadowVerifyOutcome } from './shadow/manager';

/**
 * ADR-013 S1/S2（router 层，假影子执行器）：
 * - O1 = (b)：每轮（agent.turnBegin）首次 shadow.run 先问用户，复用 agent.confirm* 通道（kind 'shadow_run'）；
 *   允许后同轮不再问；拒绝后同轮不再运行也不再问；没有轮次时每次都问；新一轮作废待确认请求。
 * - bridge 预算：每轮运行次数上限、墙钟上限。
 * - 第一道 M5 闸：按类型重建报告，白名单外字段（preview / rows / 任意键）一律不出。
 * - 核验绑定：verificationId ↔ 改动 + 源码修订；V0–V3 分级；软约束（照常入队，标状态）；源码变动 → expired。
 */

const DIR = mkdtempSync(path.join(tmpdir(), 'novalab-shadow-router-'));
const CANARY = 'CANARY_ROW_7f3a';

let sup: KernelSupervisor | undefined;
let fake: FakeKernel;
let notes: { method: string; params?: unknown }[] = [];
let router: RpcRouter;
let shadow: FakeShadow;
let reqId = 0;

type Raw = Record<string, unknown>;

function frameSummary(rows: number, extra: Raw = {}): Raw {
  return {
    schema: { type: 'DataFrame', shape: [rows, 2], columns: ['a', 'b'], dtypes: { a: 'int64', b: 'object' }, preview: [{ a: CANARY }] },
    stats: { columns: { a: { count: rows, nullCount: 0, sum: 10, mean: 1, secret: CANARY }, b: { count: rows, nullCount: 0, nUnique: 3 } } },
    ...extra,
  };
}

/** 形如 shadow_server run 的原始结果（含故意夹带的白名单外字段）。 */
function kernelResult(req: ShadowRunRequest, opts: { failCell?: string; autoFail?: boolean } = {}): Raw {
  const cand = req.candidates[0]!;
  const baseCode = new Map(req.base.map((c) => [c.id, c.code]));
  const changed = cand.cells.filter((c) => baseCode.get(c.id) !== c.code).map((c) => c.id);
  const cells = changed.map((id) => ({
    id,
    role: 'closure',
    ok: id !== opts.failCell,
    durationMs: 3,
    ...(id === opts.failCell ? { traceback: `KeyError: '<value>'\n${'x'.repeat(10_000)}` } : {}),
    stdout: CANARY,
  }));
  return {
    before: { name: 'before', cells: [{ id: 'a', role: 'upstream', ok: true, durationMs: 1 }], vars: [], rows: [CANARY] },
    candidates: [
      {
        name: 'after',
        plan: { changed, upstream: [], closure: changed },
        cells,
        vars: [
          { name: 'df', before: frameSummary(12), after: frameSummary(10), delta: { shape: { before: [12, 2], after: [10, 2] }, stats: { a: { count: -2 } }, raw: CANARY } },
          { name: 'n', after: { schema: { type: 'int', value: CANARY } } },
        ],
        autoChecks: opts.autoFail
          ? [{ id: 'auto:non_empty:df', kind: 'non_empty', status: 'fail', total: 0, violations: 1 }]
          : [],
        blocked: [{ kind: 'network', count: 1, url: `http://${CANARY}` }],
        nondeterminism: [{ cellId: 'a', reason: 'wall-clock' }, { cellId: 'a', reason: CANARY }],
        figures: 1,
        durationMs: 7,
        compileError: undefined,
        leaked: CANARY,
      },
    ],
  };
}

class FakeShadow implements ShadowRunner {
  readonly memLimitBytes = 1024 ** 3;
  runs: ShadowRunRequest[] = [];
  verifies: { key: string; candidate: string; contracts: unknown[] }[] = [];
  cancels = 0;
  released: string[] = [];
  runImpl: (req: ShadowRunRequest) => Promise<ShadowRunOutcome> = async (req) => ({ status: 'ok', result: kernelResult(req) });
  verifyImpl: (contracts: Raw[]) => Promise<ShadowVerifyOutcome> = async (contracts) => ({
    status: 'ok',
    result: { contracts: contracts.map((c, i) => ({ id: c['id'] ?? `c${i + 1}`, kind: c['kind'], status: 'pass', total: 10, violations: 0, echo: CANARY })) },
  });
  private pendingCancel?: () => void;

  run(req: ShadowRunRequest): Promise<ShadowRunOutcome> {
    this.runs.push(req);
    return this.runImpl(req);
  }
  verify(key: string, candidate: string, contracts: unknown[]): Promise<ShadowVerifyOutcome> {
    this.verifies.push({ key, candidate, contracts });
    return this.verifyImpl(contracts as Raw[]);
  }
  /** 让下一次 run 挂起直到 cancel。 */
  hangNextRun(): void {
    this.runImpl = (req) => {
      this.runs.length; // keep req recorded by run()
      void req;
      return new Promise((resolve) => {
        this.pendingCancel = () => resolve({ status: 'cancelled' });
      });
    };
  }
  cancel(): boolean {
    this.cancels++;
    if (!this.pendingCancel) return false;
    this.pendingCancel();
    this.pendingCancel = undefined;
    return true;
  }
  release(key: string): void {
    this.released.push(key);
  }
  dispose(): void {}
}

async function setup(extra: Partial<RouterDeps> = {}, withShadow = true): Promise<void> {
  notes = [];
  reqId = 0;
  shadow = new FakeShadow();
  sup = new KernelSupervisor({
    transportFactory: () => {
      fake = new FakeKernel();
      fake.cells = [
        { id: 'a', code: 'x = 1', execCount: 0, defs: ['x'], refs: [] },
        { id: 'b', code: 'y = x + 1', execCount: 0, defs: ['y'], refs: ['x'] },
      ];
      return fake;
    },
    pingIntervalMs: 60_000,
  });
  router = new RpcRouter({
    supervisor: sup,
    broadcast: (method, params) => notes.push({ method, params }),
    ...(withShadow ? { shadow } : {}),
    ...extra,
  });
  expect((await call('notebook.open', { path: path.join(DIR, 'demo.py') })).error).toBeUndefined();
}

function call(method: string, params?: unknown): Promise<RpcResponse> {
  return router.handle({ jsonrpc: '2.0', id: ++reqId, method, params });
}

async function ok<T = Raw>(method: string, params?: unknown): Promise<T> {
  const res = await call(method, params);
  expect(res.error).toBeUndefined();
  return res.result as T;
}

function confirmRequests(): Raw[] {
  return notes.filter((n) => n.method === 'agent.confirmRequest').map((n) => n.params as Raw);
}

async function waitConfirm(count: number): Promise<Raw> {
  for (let i = 0; i < 100; i++) {
    const reqs = confirmRequests();
    if (reqs.length >= count) return reqs[count - 1]!;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`expected ${count} agent.confirmRequest broadcasts`);
}

const EDIT_B = { targetCellId: 'b', action: 'update', newCode: 'y = x + 2' };

/** 运行一次并按需应答确认。 */
async function runShadow(answer: boolean | null, nth: number, params: Raw = { changes: [EDIT_B] }): Promise<Raw> {
  const pending = call('shadow.run', params);
  if (answer !== null) {
    const req = await waitConfirm(nth);
    await ok('agent.confirmResponse', { requestId: req['requestId'], allow: answer });
  }
  const res = await pending;
  expect(res.error).toBeUndefined();
  return res.result as Raw;
}

afterEach(() => {
  router?.dispose();
  sup?.stop();
  sup = undefined;
});

describe('shadow.run · 每轮首次确认（O1 = b）', () => {
  it('没有影子执行器 → unavailable，不弹确认', async () => {
    await setup({ confirmers: () => 1 }, false);
    const res = await ok('shadow.run', { changes: [EDIT_B] });
    expect(res).toMatchObject({ runId: null, status: 'unavailable' });
    expect(confirmRequests()).toHaveLength(0);
  });

  it('没有可确认的前端 → denied no-confirmer，影子不运行', async () => {
    await setup();
    expect(await ok('shadow.run', { changes: [EDIT_B] })).toMatchObject({ denied: true, reason: 'no-confirmer' });
    expect(shadow.runs).toHaveLength(0);
  });

  it('同一轮：首次问、允许后不再问；新一轮重新问', async () => {
    await setup({ confirmers: () => 1 });
    await ok('agent.turnBegin', { turnId: 't1' });
    const first = await runShadow(true, 1);
    expect(first['status']).toBe('ok');
    const req = confirmRequests()[0]!;
    expect(req).toMatchObject({ kind: 'shadow_run', turnId: 't1' });
    expect((req['summary'] as Raw)['changes']).toEqual([{ cellId: 'b', action: 'update', firstLine: 'y = x + 2' }]);
    await runShadow(null, 0);
    expect(confirmRequests()).toHaveLength(1);
    expect(shadow.runs).toHaveLength(2);

    await ok('agent.turnBegin', { turnId: 't2' });
    await runShadow(true, 2);
    expect(confirmRequests()).toHaveLength(2);
  });

  it('拒绝 → 本轮不再运行也不再追问', async () => {
    await setup({ confirmers: () => 1 });
    await ok('agent.turnBegin', { turnId: 't1' });
    expect(await runShadow(false, 1)).toMatchObject({ denied: true, reason: 'user-declined' });
    expect(await ok('shadow.run', { changes: [EDIT_B] })).toMatchObject({ denied: true, reason: 'user-declined' });
    expect(confirmRequests()).toHaveLength(1);
    expect(shadow.runs).toHaveLength(0);
  });

  it('没有 turnBegin → 每次都问（漏接线只会多问）', async () => {
    await setup({ confirmers: () => 1 });
    await runShadow(true, 1);
    await runShadow(true, 2);
    expect(confirmRequests()).toHaveLength(2);
  });

  it('等待确认时开始新一轮 → 待确认按拒绝结算，不运行', async () => {
    await setup({ confirmers: () => 1 });
    await ok('agent.turnBegin', { turnId: 't1' });
    const pending = call('shadow.run', { changes: [EDIT_B] });
    await waitConfirm(1);
    await ok('agent.turnBegin', { turnId: 't2' });
    expect((await pending).result).toMatchObject({ denied: true, reason: 'user-declined' });
    expect(shadow.runs).toHaveLength(0);
    expect(notes.some((n) => n.method === 'agent.confirmResolved')).toBe(true);
  });

  it('每轮运行次数用尽 → budget-exceeded，不运行', async () => {
    await setup({ confirmers: () => 1, shadowBudget: { runsPerTurn: 2 } });
    await ok('agent.turnBegin', { turnId: 't1' });
    await runShadow(true, 1);
    await runShadow(null, 0);
    const third = await runShadow(null, 0);
    expect(third).toMatchObject({ runId: null, status: 'budget-exceeded' });
    expect((third['budget'] as Raw)['runsUsed']).toBe(2);
    expect(shadow.runs).toHaveLength(2);
  });

  it('shadow.cancel → 影子执行器 cancel，run 以 cancelled 结算', async () => {
    await setup({ confirmers: () => 1 });
    await ok('agent.turnBegin', { turnId: 't1' });
    shadow.hangNextRun();
    const pending = call('shadow.run', { changes: [EDIT_B] });
    const req = await waitConfirm(1);
    await ok('agent.confirmResponse', { requestId: req['requestId'], allow: true });
    for (let i = 0; i < 50 && shadow.runs.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    expect(await ok('shadow.cancel', {})).toMatchObject({ cancelled: true });
    expect((await pending).result).toMatchObject({ status: 'cancelled' });
  });

  it('影子请求携带全量 base、按序应用的候选与 notebook 目录', async () => {
    await setup({ confirmers: () => 1 });
    await runShadow(true, 1, {
      changes: [EDIT_B, { targetCellId: 'b', action: 'insert_below', newCode: 'z = y * 2' }],
    });
    const req = shadow.runs[0]!;
    expect(req.base).toEqual([{ id: 'a', code: 'x = 1' }, { id: 'b', code: 'y = x + 1' }]);
    expect(req.candidates[0]!.cells.map((c) => c.code)).toEqual(['x = 1', 'y = x + 2', 'z = y * 2']);
    expect(req.notebookDir).toBe(DIR);
  });
});

describe('第一道 M5 闸：按类型重建影子报告', () => {
  it('白名单外字段一律不出；traceback 截断；未知枚举丢弃', async () => {
    await setup({ confirmers: () => 1 });
    shadow.runImpl = async (req) => ({ status: 'ok', result: kernelResult(req, { failCell: 'b' }) });
    const report = await runShadow(true, 1);
    const json = JSON.stringify(report);
    expect(json).not.toContain(CANARY);
    expect(json).not.toContain('preview');
    expect(report['status']).toBe('failed');
    const after = report['after'] as Raw;
    const cell = (after['cells'] as Raw[])[0]!;
    expect((cell['traceback'] as string).length).toBeLessThanOrEqual(8192 + 20);
    const df = (report['vars'] as Raw[]).find((v) => v['name'] === 'df')!;
    expect(((df['after'] as Raw)['schema'] as Raw)['columns']).toEqual(['a', 'b']);
    expect((df['delta'] as Raw)['shape']).toEqual({ before: [12, 2], after: [10, 2] });
    expect(report['nondeterminism']).toEqual([{ cellId: 'a', reason: 'wall-clock' }]);
    expect(report['blocked']).toEqual([{ kind: 'network', count: 1 }]);
  });

  it('影子编译错误为纯字符串时归一为 {message, cellIds}', async () => {
    await setup({ confirmers: () => 1 });
    shadow.runImpl = async (req) => {
      const r = kernelResult(req);
      (r['candidates'] as Raw[])[0]!['compileError'] = "multiple definitions of 'x' (cells a, b)";
      return { status: 'ok', result: r };
    };
    const report = await runShadow(true, 1);
    expect(report['status']).toBe('compile-error');
    expect(report['compileError']).toEqual({ message: "multiple definitions of 'x' (cells a, b)", cellIds: ['a', 'b'] });
  });
});

describe('核验绑定与 Diff 分级（软约束）', () => {
  async function verified(contracts: Raw[] = [{ kind: 'row_count', target: 'df', op: '<=', ref: { target: 'df', phase: 'before' } }]) {
    const run = await runShadow(true, 1);
    const ver = await ok<Raw>('shadow.verify', { runId: run['runId'], contracts });
    return { run, ver };
  }

  it('verify 只出状态与计数，带 verificationId', async () => {
    await setup({ confirmers: () => 1 });
    const { ver } = await verified();
    expect(ver).toMatchObject({ status: 'pass', verificationId: expect.any(String) });
    expect(JSON.stringify(ver)).not.toContain(CANARY);
    expect(shadow.verifies[0]).toMatchObject({ candidate: 'after' });
  });

  it('V2 数据变换 + 通过的契约 → verified；无 verificationId → unverified', async () => {
    await setup({ confirmers: () => 1 });
    const { ver } = await verified();
    const staged = await ok<Raw>('diff.stage', { ...EDIT_B, verificationId: ver['verificationId'] });
    expect(staged['verification']).toEqual({ status: 'verified', level: 'V2', missing: [] });
    const bare = await ok<Raw>('diff.stage', { targetCellId: 'a', action: 'update', newCode: 'x = 3' });
    expect((bare['verification'] as Raw)['status']).toBe('unverified');
    expect((bare['diffId'] as string).length).toBeGreaterThan(0); // 软约束：照常入队
  });

  it('只跑影子没 verify：V2 缺契约 → unverified，missing 含 contract', async () => {
    await setup({ confirmers: () => 1 });
    const run = await runShadow(true, 1);
    const staged = await ok<Raw>('diff.stage', { ...EDIT_B, verificationId: run['verificationId'] });
    expect(staged['verification']).toMatchObject({ status: 'unverified', level: 'V2', missing: ['contract'] });
  });

  it('闭包内 cell 失败或默认检查失败 → failed', async () => {
    await setup({ confirmers: () => 1 });
    shadow.runImpl = async (req) => ({ status: 'ok', result: kernelResult(req, { autoFail: true }) });
    const { ver } = await verified();
    const staged = await ok<Raw>('diff.stage', { ...EDIT_B, verificationId: ver['verificationId'] });
    expect((staged['verification'] as Raw)['status']).toBe('failed');
  });

  it('只改注释 → V0 not-required', async () => {
    await setup({ confirmers: () => 1 });
    const staged = await ok<Raw>('diff.stage', { targetCellId: 'b', action: 'update', newCode: '# note\ny = x + 1' });
    expect(staged['verification']).toEqual({ status: 'not-required', level: 'V0', missing: [] });
  });

  it('intent refactor → V3 需要 equivalent 覆盖闭包里改前改后都在的数据变量', async () => {
    await setup({ confirmers: () => 1 });
    const { ver } = await verified();
    const v3 = await ok<Raw>('diff.stage', { ...EDIT_B, intent: 'refactor', verificationId: ver['verificationId'] });
    expect(v3['verification']).toMatchObject({ status: 'unverified', level: 'V3', missing: ['equivalent:df'] });
    const ver2 = await ok<Raw>('shadow.verify', { runId: (ver as Raw)['runId'], contracts: [{ kind: 'equivalent', targets: ['df'] }] });
    const ok3 = await ok<Raw>('diff.stage', { ...EDIT_B, intent: 'refactor', verificationId: ver2['verificationId'] });
    expect(ok3['verification']).toMatchObject({ status: 'verified', level: 'V3' });
  });

  it('核验与改动不符 → unverified；源码改动后 → expired（已入队的 diff 同步标记）', async () => {
    await setup({ confirmers: () => 1 });
    const { ver } = await verified();
    const other = await ok<Raw>('diff.stage', { targetCellId: 'b', action: 'update', newCode: 'y = x + 9', verificationId: ver['verificationId'] });
    expect(other['verification']).toMatchObject({ status: 'unverified', missing: ['shadow_run covering this change'] });

    const staged = await ok<Raw>('diff.stage', { ...EDIT_B, verificationId: ver['verificationId'] });
    expect((staged['verification'] as Raw)['status']).toBe('verified');
    await ok('cell.save', { cellId: 'a', code: 'x = 5' });
    const updates = notes.filter((n) => n.method === 'diff.updated');
    const last = (updates[updates.length - 1]!.params as { diffs: Raw[] }).diffs.find((d) => d['diffId'] === staged['diffId'])!;
    expect((last['verification'] as Raw)['status']).toBe('expired');
    const late = await ok<Raw>('diff.stage', { ...EDIT_B, verificationId: ver['verificationId'] });
    expect((late['verification'] as Raw)['status']).toBe('expired');
  });

  it('同一次影子运行覆盖的多条改动：按序采纳前一条后，后一条仍然有效', async () => {
    await setup({ confirmers: () => 1 });
    const edits = [
      { targetCellId: 'a', action: 'update', newCode: 'x = 2' },
      { targetCellId: 'b', action: 'update', newCode: 'y = x + 2' },
    ];
    const run = await runShadow(true, 1, { changes: edits });
    const ver = await ok<Raw>('shadow.verify', { runId: run['runId'], contracts: [{ kind: 'not_null', target: 'df', columns: ['a'] }] });
    const d1 = await ok<Raw>('diff.stage', { ...edits[0], verificationId: ver['verificationId'] });
    const d2 = await ok<Raw>('diff.stage', { ...edits[1], verificationId: ver['verificationId'] });
    expect((d1['verification'] as Raw)['status']).toBe('verified');
    await ok('diff.accept', { diffId: d1['diffId'] });
    const updates = notes.filter((n) => n.method === 'diff.updated');
    const last = (updates[updates.length - 1]!.params as { diffs: Raw[] }).diffs.find((d) => d['diffId'] === d2['diffId'])!;
    expect((last['verification'] as Raw)['status']).toBe('verified');
  });

  it('verify 针对的不是最近一次运行 → not-retained；关闭 notebook 释放影子进程', async () => {
    await setup({ confirmers: () => 1 });
    await ok('agent.turnBegin', { turnId: 't1' });
    const r1 = await runShadow(true, 1);
    await runShadow(null, 0);
    expect(await ok('shadow.verify', { runId: r1['runId'], contracts: [] })).toMatchObject({ status: 'not-retained' });
  });
});
