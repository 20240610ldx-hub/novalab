/**
 * ADR-013 S1/S2 真实进程验收：真实 novakernel（用户内核）+ 真实 ShadowManager（影子进程、沙箱、内存上限）。
 *
 * 覆盖 §7.3 的硬门槛：用户状态不变（execCounts / 变量 / stale / 文件树）、canary 0 泄漏（经两道 M5 闸）、
 * 沙箱拦截工作区写入、超时整树终止 + scratch 清理、取消延迟、内存上限下的 MemoryError、预算、
 * 核验 → verified → 源码变更后 expired。
 *
 * 数据全部是合成的（含 canary 列），不使用任何真实数据或凭据。
 * 设 NOVALAB_SHADOW_EVIDENCE=<file.json> 时把实测数值写入该文件（封存证据用）。
 */
import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, expect, it } from 'vitest';
import { RpcRouter, type ShadowBudget } from './router';
import { KernelSupervisor, StdioKernelTransport } from './supervisor';
import { ShadowManager } from './shadow/manager';
import { executeAgentTool, sanitizeToolOutput } from './mcp/tools';
import type { RpcResponse } from './protocol';

const pyDir = fileURLToPath(new URL('../../py/', import.meta.url));
const python = path.join(pyDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const CANARY = 'CANARY_ROW_7f3a';
const MiB = 1024 ** 2;

const SOURCE = [
  '# %% [cell-id: aaaaaaaa]',
  'import numpy as np',
  'import pandas as pd',
  `raw = pd.DataFrame({"g": ["A", "B", "C", "D"] * 25, "v": np.arange(100, dtype=float), "tag": ["${CANARY}"] * 100})`,
  '',
  '# %% [cell-id: bbbbbbbb]',
  'clean = raw[raw["v"] >= 0]',
  '',
  '# %% [cell-id: cccccccc]',
  'summary = clean.groupby("g")["v"].sum()',
  '',
].join('\n');

const evidence: Record<string, unknown> = {};

interface Harness {
  call: (method: string, params?: unknown) => Promise<RpcResponse>;
  ok: <T = Record<string, unknown>>(method: string, params?: unknown) => Promise<T>;
  router: RpcRouter;
  manager: ShadowManager;
  dir: string;
  notebook: string;
  scratchRoot: string;
  confirms: () => number;
}

let supervisor: KernelSupervisor | undefined;
let kernelExited: Promise<void> | undefined;
let harness: Harness | undefined;
const cleanup: string[] = [];

afterEach(async () => {
  harness?.router.dispose();
  supervisor?.stop();
  await kernelExited;
  supervisor = undefined;
  kernelExited = undefined;
  harness = undefined;
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

afterAll(() => {
  const out = process.env['NOVALAB_SHADOW_EVIDENCE'];
  if (out) writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
});

async function open(opts: { memLimitBytes?: number; budget?: Partial<ShadowBudget> } = {}): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'novalab-shadow-acc-'));
  const scratchRoot = mkdtempSync(path.join(tmpdir(), 'novalab-shadow-scratch-'));
  cleanup.push(dir, scratchRoot);
  const notebook = path.join(dir, 'notebook.py');
  writeFileSync(notebook, SOURCE, 'utf8');
  writeFileSync(path.join(dir, 'input.csv'), 'g,v\nA,1\n', 'utf8');
  supervisor = new KernelSupervisor({
    transportFactory: () =>
      new StdioKernelTransport(pyDir, { NOVALAB_PACKAGED: '0', NOVALAB_PY_DIR: pyDir }, {
        spawnImpl: ((command: string, args: readonly string[], options: SpawnOptions) => {
          const child = existsSync(python)
            ? spawn(python, ['-m', 'novakernel.server'], options)
            : spawn(command, args, options);
          kernelExited = new Promise<void>((resolve) => child.once('close', () => resolve()));
          return child;
        }) as typeof spawn,
      }),
    pingIntervalMs: 60_000,
  });
  const manager = new ShadowManager({ pyDir, tmpRoot: scratchRoot, ...(opts.memLimitBytes ? { memLimitBytes: opts.memLimitBytes } : {}) });
  let confirmCount = 0;
  let router!: RpcRouter;
  let id = 0;
  const call = (method: string, params?: unknown) => router.handle({ jsonrpc: '2.0', id: ++id, method, params });
  router = new RpcRouter({
    supervisor,
    shadow: manager,
    confirmers: () => 1,
    ...(opts.budget ? { shadowBudget: opts.budget } : {}),
    broadcast: (method, params) => {
      // 前端替身：每次 shadow_run 确认都点「允许」
      const p = params as { kind?: string; requestId?: string };
      if (method === 'agent.confirmRequest' && p.kind === 'shadow_run') {
        confirmCount++;
        setImmediate(() => void call('agent.confirmResponse', { requestId: p.requestId, allow: true }));
      }
    },
  });
  const ok = async <T,>(method: string, params?: unknown): Promise<T> => {
    const res = await call(method, params);
    expect(res.error, `${method}: ${res.error?.message}`).toBeUndefined();
    return res.result as T;
  };
  await ok('notebook.open', { path: notebook });
  await ok('cell.run', { cellId: 'aaaaaaaa', cascade: true });
  harness = { call, ok, router, manager, dir, notebook, scratchRoot, confirms: () => confirmCount };
  return harness;
}

function tree(dir: string): Record<string, { size: number; mtimeMs: number; sha: string }> {
  const out: Record<string, { size: number; mtimeMs: number; sha: string }> = {};
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    // NovaLab 自己的会话审计日志（O8：影子运行只记元数据）单独断言，不算用户文件
    if (name.startsWith(`.novalab${path.sep}sessions`)) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isFile()) out[name] = { size: st.size, mtimeMs: st.mtimeMs, sha: readFileSync(p).toString('base64').slice(0, 64) };
  }
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

const CHANGE_FILTER = { targetCellId: 'bbbbbbbb', action: 'update', newCode: 'clean = raw[raw["v"] >= 10]' };

it('用户状态不变：execCounts / 变量 / stale / 文件树；工作区写入被沙箱拦截（X-1）', async () => {
  const h = await open();
  const before = {
    cells: await h.ok('agent.listCells'),
    vars: await h.ok('kernel.vars'),
    context: await h.ok('agent.context'),
    files: tree(h.dir),
  };
  await h.ok('agent.turnBegin', { turnId: 't1' });
  const report = await h.ok<Record<string, unknown>>('shadow.run', {
    changes: [
      CHANGE_FILTER,
      // 第一层：静态副作用检测 → 不运行（skipped side-effect）
      { targetCellId: 'cccccccc', action: 'insert_below', newCode: 'leak = summary.to_csv("leak.csv")' },
      // 第二层：静态检测看不出的动态写入 → 运行时沙箱拦截（ShadowSandboxError）
      { targetCellId: 'cccccccc', action: 'insert_below', newCode: 'sneaky = getattr(summary, "to_" + "csv")("sne" + "aky.csv")' },
    ],
  });
  const cells = (report['after'] as { cells: { id: string; ok: boolean; skipped?: string; traceback?: string }[] }).cells;
  expect(cells.find((c) => c.id === 'new-2')).toMatchObject({ ok: false, skipped: 'side-effect' });
  const sneaky = cells.find((c) => c.id === 'new-3')!;
  expect(sneaky.ok).toBe(false);
  expect(sneaky.traceback).toContain('blocked');
  expect(report['status']).toBe('failed');
  expect(report['blocked']).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'file-write' })]));
  const clean = (report['vars'] as { name: string; delta?: { shape?: unknown } }[]).find((v) => v.name === 'clean');
  expect(clean?.delta?.shape).toEqual({ before: [100, 3], after: [90, 3] });

  const after = {
    cells: await h.ok('agent.listCells'),
    vars: await h.ok('kernel.vars'),
    context: await h.ok('agent.context'),
    files: tree(h.dir),
  };
  expect(after).toEqual(before);
  expect(existsSync(path.join(h.dir, 'leak.csv'))).toBe(false);
  expect(existsSync(path.join(h.dir, 'sneaky.csv'))).toBe(false);
  const sessionsDir = path.join(h.dir, '.novalab', 'sessions');
  const events = readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(path.join(sessionsDir, f), 'utf8').trim().split('\n'))
    .map((l) => JSON.parse(l) as { kind: string; actor: string; payloadRef?: string });
  const shadowEvents = events.filter((e) => e.kind.startsWith('shadow_'));
  expect(shadowEvents.map((e) => e.kind)).toEqual(['shadow_confirm', 'shadow_run']);
  expect(shadowEvents.find((e) => e.kind === 'shadow_run')).toMatchObject({ actor: 'agent' });
  expect(JSON.stringify(shadowEvents)).not.toContain(CANARY);
  const repl = await h.ok<{ ok: boolean }>('kernel.repl', { code: 'assert len(clean) == 100\nassert "leak" not in globals() and "sneaky" not in globals()' });
  expect(repl.ok).toBe(true);
  evidence['userStateUnchanged'] = { compared: ['listCells', 'kernel.vars', 'agent.context', 'fileTree'], equal: true, staticSkip: 'side-effect', runtimeBlocked: report['blocked'], workspaceWrites: 0 };
}, 60_000);

it('canary 0 泄漏：经 executeAgentTool + 第二道闸，shadow_run / verify / propose 全部不含行数据', async () => {
  const h = await open();
  const host = { invoke: (m: string, p?: unknown) => h.router.invoke(m, p) };
  await h.ok('agent.turnBegin', { turnId: 't1' });
  const outputs: unknown[] = [];
  const dropped: string[] = [];
  const gate = (tool: 'shadow_run' | 'verify' | 'propose_code_change', raw: unknown) => {
    const g = sanitizeToolOutput(tool, raw);
    expect(g.redacted).toBe(false);
    dropped.push(...g.droppedKeys);
    outputs.push(g.output);
    return g.output as Record<string, unknown>;
  };
  const run = gate('shadow_run', await executeAgentTool(host, 'shadow_run', { changes: [CHANGE_FILTER] }));
  expect(run['status']).toBe('ok');
  const ver = gate(
    'verify',
    await executeAgentTool(host, 'verify', {
      runId: run['runId'],
      contracts: [
        { kind: 'not_null', target: 'clean', columns: ['g', 'v'] },
        { kind: 'row_count', target: 'clean', op: '<=', ref: { target: 'clean', phase: 'before' } },
        { kind: 'columns_present', target: 'clean', columns: ['tag'] },
      ],
    }),
  );
  expect(ver['status']).toBe('pass');
  gate('propose_code_change', await executeAgentTool(host, 'propose_code_change', { ...CHANGE_FILTER, verificationId: ver['verificationId'] }));
  const json = JSON.stringify(outputs);
  expect(json).not.toContain(CANARY);
  expect(dropped).toEqual([]); // 第一道闸已经干净：第二道闸无需丢键
  evidence['canaryLeak'] = { leaks: 0, toolOutputs: outputs.length, bytes: json.length, secondGateDroppedKeys: dropped.length };
}, 60_000);

it('超时：影子进程整树终止、scratch 删除，用户内核仍可用', async () => {
  const h = await open({ budget: { runMs: 2_000 } });
  await h.ok('agent.turnBegin', { turnId: 't1' });
  let pid: number | undefined;
  const pending = h.ok<Record<string, unknown>>('shadow.run', {
    changes: [{ targetCellId: 'cccccccc', action: 'update', newCode: 'summary = 0\nwhile True:\n    pass' }],
  });
  await until(() => (pid = h.manager.livePids()[0]) !== undefined, 15_000);
  const t0 = Date.now();
  const report = await pending;
  expect(report['status']).toBe('timeout');
  expect(pid).toBeDefined();
  const dead = await until(() => !alive(pid!), 2_000);
  expect(dead).toBe(true);
  expect(await until(() => readdirSync(h.scratchRoot).length === 0, 2_000)).toBe(true);
  expect((await h.ok<{ ok: boolean }>('kernel.repl', { code: 'assert len(clean) == 100' })).ok).toBe(true);
  evidence['timeout'] = { runMs: 2_000, status: report['status'], pidDead: dead, scratchLeft: readdirSync(h.scratchRoot).length, settleAfterPidSeenMs: Date.now() - t0 };
}, 60_000);

it('取消：shadow.cancel 到进程退出 < 500 ms（5 次取 p95）', async () => {
  const h = await open();
  await h.ok('agent.turnBegin', { turnId: 't1' });
  const latencies: number[] = [];
  for (let i = 0; i < 5; i++) {
    const pending = h.ok<Record<string, unknown>>('shadow.run', {
      changes: [{ targetCellId: 'cccccccc', action: 'update', newCode: `summary = ${i}\nwhile True:\n    pass` }],
    });
    let pid: number | undefined;
    expect(await until(() => (pid = h.manager.livePids()[0]) !== undefined, 15_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 1_500)); // 让 init / 上游重放完成，确保停在闭包里
    const t0 = performance.now();
    expect(await h.ok('shadow.cancel', {})).toMatchObject({ cancelled: true });
    const report = await pending;
    expect(await until(() => !alive(pid!), 2_000)).toBe(true);
    latencies.push(performance.now() - t0);
    expect(report['status']).toBe('cancelled');
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
  expect(p95).toBeLessThan(500);
  expect(await until(() => readdirSync(h.scratchRoot).length === 0, 2_000)).toBe(true);
  evidence['cancel'] = { samplesMs: latencies.map((x) => Math.round(x)), p95Ms: Math.round(p95), thresholdMs: 500 };
}, 120_000);

it('内存上限（512 MiB，实测执行）：超限分配 → MemoryError 报告，用户内核不受影响', async () => {
  const h = await open({ memLimitBytes: 512 * MiB });
  // 直接看 init 读回的执行机制（Windows Job Object / POSIX rlimit）
  const direct = await h.manager.run({
    key: 'probe',
    notebookDir: h.dir,
    base: [{ id: 'p', code: 'x = 1' }],
    candidates: [{ name: 'after', cells: [{ id: 'p', code: 'x = 2' }] }],
    timeoutMs: 30_000,
  });
  expect(direct.status).toBe('ok');
  const memLimit = (direct as { memLimit?: { mechanism?: unknown; limitBytes?: unknown } }).memLimit;
  expect(memLimit?.mechanism).toBeTruthy();
  expect(memLimit?.limitBytes).toBe(512 * MiB);
  h.manager.release('probe');

  await h.ok('agent.turnBegin', { turnId: 't1' });
  const report = await h.ok<Record<string, unknown>>('shadow.run', {
    changes: [{ targetCellId: 'cccccccc', action: 'update', newCode: 'summary = np.ones((1024, 1024, 128))' }],
  });
  expect(report['status']).toBe('failed');
  const cell = ((report['after'] as { cells: { id: string; ok: boolean; traceback?: string }[] }).cells).find((c) => c.id === 'cccccccc')!;
  expect(cell.ok).toBe(false);
  expect(cell.traceback).toContain('MemoryError');
  expect((await h.ok<{ ok: boolean }>('kernel.repl', { code: 'assert len(clean) == 100' })).ok).toBe(true);
  evidence['memoryLimit'] = { mechanism: memLimit?.mechanism, limitBytes: memLimit?.limitBytes, attemptedBytes: 1024 ** 3, result: 'MemoryError' };
}, 60_000);

it('预算与每轮确认：同轮只问一次，超出次数 → budget-exceeded 且不启动进程', async () => {
  const h = await open({ budget: { runsPerTurn: 2 } });
  await h.ok('agent.turnBegin', { turnId: 't1' });
  await h.ok('shadow.run', { changes: [CHANGE_FILTER] });
  await h.ok('shadow.run', { changes: [CHANGE_FILTER] });
  const third = await h.ok<Record<string, unknown>>('shadow.run', { changes: [CHANGE_FILTER] });
  expect(third).toMatchObject({ runId: null, status: 'budget-exceeded' });
  expect(h.confirms()).toBe(1);
  await h.ok('agent.turnBegin', { turnId: 't2' });
  await h.ok('shadow.run', { changes: [CHANGE_FILTER] });
  expect(h.confirms()).toBe(2);
  evidence['budget'] = { runsPerTurn: 2, thirdRun: third['status'], confirmsForTwoTurns: h.confirms() };
}, 90_000);

it('ADR-016 技能包：真实影子内核里核验类别映射守恒与 IPF 配平残差', async () => {
  const h = await open();
  await h.ok('agent.turnBegin', { turnId: 't-skills' });
  const newCode = [
    'group_map = {"A": "AB", "B": "AB", "C": "CD", "D": "CD"}',
    'merged = raw.assign(pair=raw["g"].map(group_map)).groupby("pair", as_index=False)["v"].sum()',
    'seed = pd.DataFrame([[1.0, 2.0], [3.0, 4.0]], index=["r1", "r2"], columns=["c1", "c2"])',
    'row_t = pd.Series([30.0, 10.0], index=["r2", "r1"])',
    'col_t = np.array([15.0, 25.0])',
    'def ipf(m, r, c, tol=1e-9, max_iter=200):',
    '    m = m.to_numpy(dtype=float).copy()',
    '    r = r.reindex(seed.index).to_numpy(dtype=float)',
    '    for i in range(max_iter):',
    '        m *= (r / m.sum(axis=1))[:, None]',
    '        m *= c / m.sum(axis=0)',
    '        resid = max(np.abs(m.sum(axis=1) - r).max(), np.abs(m.sum(axis=0) - c).max())',
    '        if resid < tol:',
    '            break',
    '    return pd.DataFrame(m, index=seed.index, columns=seed.columns), i + 1, resid',
    'fitted, ipf_iters, ipf_resid = ipf(seed, row_t, col_t)',
  ].join('\n');
  const run = await h.ok<Record<string, unknown>>('shadow.run', {
    changes: [{ targetCellId: 'cccccccc', action: 'insert_below', newCode }],
  });
  expect(run['status']).toBe('ok');
  const ver = await h.ok<{ status: string; contracts: Record<string, unknown>[] }>('shadow.verify', {
    runId: run['runId'],
    contracts: [
      { kind: 'mapping_conserved', mapping: 'group_map', before: { target: 'raw', column: 'g', value: 'v', phase: 'after' }, after: { target: 'merged', column: 'pair', value: 'v' } },
      { kind: 'mapping_conserved', mapping: { A: 'AB', B: 'AB' }, before: { target: 'raw', column: 'g', phase: 'after' }, after: { target: 'merged', column: 'pair', value: 'v' } },
      { kind: 'margins_match', target: 'fitted', rows: 'row_t', cols: 'col_t' },
      { kind: 'margins_match', target: 'seed', rows: 'row_t', cols: 'col_t' },
    ],
  });
  // id 由 bridge 按声明顺序分配：c1 映射、c2 缺两个类别的映射、c3 配平结果、c4 未配平的种子
  const byId = Object.fromEntries(ver.contracts.map((c) => [c['id'], c]));
  expect(byId['c1']).toMatchObject({ status: 'pass', total: 2, violations: 0, unmapped: 0 });
  expect(byId['c2']).toMatchObject({ status: 'fail', unmapped: 2 });
  expect(byId['c3']).toMatchObject({ status: 'pass', total: 4, violations: 0 });
  expect(byId['c4']).toMatchObject({ status: 'fail', total: 4, violations: 4 });
  expect(ver.status).toBe('fail');
  expect(JSON.stringify(ver)).not.toContain(CANARY);
  evidence['skillPacks'] = Object.fromEntries(ver.contracts.map((c) => [c['id'], c['status']]));
}, 60_000);

it('核验 → verified；保存上游 cell 后已入队 diff → expired', async () => {
  const h = await open();
  await h.ok('agent.turnBegin', { turnId: 't1' });
  const run = await h.ok<Record<string, unknown>>('shadow.run', { changes: [CHANGE_FILTER] });
  const ver = await h.ok<Record<string, unknown>>('shadow.verify', {
    runId: run['runId'],
    contracts: [{ kind: 'row_count', target: 'clean', op: '<=', ref: { target: 'clean', phase: 'before' } }],
  });
  expect(ver['status']).toBe('pass');
  const staged = await h.ok<Record<string, unknown>>('diff.stage', { ...CHANGE_FILTER, verificationId: ver['verificationId'] });
  expect(staged['verification']).toEqual({ status: 'verified', level: 'V2', missing: [] });
  await h.ok('cell.save', { cellId: 'aaaaaaaa', code: SOURCE.split('\n').slice(1, 4).join('\n').replace('np.arange(100', 'np.arange(200') });
  const late = await h.ok<Record<string, unknown>>('diff.stage', { targetCellId: 'cccccccc', action: 'update', newCode: 'summary = clean["v"].sum()', verificationId: ver['verificationId'] });
  expect((late['verification'] as { status: string }).status).toBe('unverified');
  const again = await h.ok<Record<string, unknown>>('diff.stage', { ...CHANGE_FILTER, verificationId: ver['verificationId'] });
  expect((again['verification'] as { status: string }).status).toBe('expired');
  evidence['verification'] = { staged: 'verified', afterUpstreamSave: 'expired' };
}, 60_000);
