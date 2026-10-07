import { describe, expect, it, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  KernelSupervisor,
  StdioKernelTransport,
  resolveKernelSpawnSpec,
  ensureKernelVenv,
  type CommandRunner,
} from './supervisor';
import { FakeKernel } from './testing/fake-kernel';
import type { KernelStatusParams, NotebookState } from './protocol';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sup: KernelSupervisor | undefined;
const fakes: FakeKernel[] = [];
const statuses: KernelStatusParams[] = [];

function makeSupervisor(opts: { pingIntervalMs?: number; pingTimeoutMs?: number } = {}): KernelSupervisor {
  fakes.length = 0;
  statuses.length = 0;
  const s = new KernelSupervisor({
    transportFactory: () => {
      const f = new FakeKernel();
      fakes.push(f);
      return f;
    },
    pingIntervalMs: opts.pingIntervalMs ?? 60_000,
    pingTimeoutMs: opts.pingTimeoutMs ?? 60_000,
  });
  s.on('status', (p: KernelStatusParams) => statuses.push(p));
  sup = s;
  return s;
}

afterEach(() => {
  sup?.stop();
  sup = undefined;
});

describe('KernelSupervisor', () => {
  it('start：spawn + load_file，返回 NotebookState，state=idle', async () => {
    const s = makeSupervisor();
    const state = (await s.start('D:/nb/demo.py')) as NotebookState;
    expect(fakes).toHaveLength(1);
    expect(fakes[0]!.loadedPath).toBe('D:/nb/demo.py');
    expect(fakes[0]!.countOf('load_file')).toBe(1);
    expect(state.cells.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(state.dagEdges).toContainEqual({ from: 'a', to: 'b' });
    expect(s.state).toBe('idle');
    // 启动过程广播过 restarting → idle
    expect(statuses.map((p) => p.state)).toEqual(['restarting', 'idle']);
  });

  it('health：idle 时按间隔发 ping', async () => {
    const s = makeSupervisor({ pingIntervalMs: 10 });
    await s.start('D:/nb/demo.py');
    await sleep(65);
    expect(fakes[0]!.countOf('ping')).toBeGreaterThanOrEqual(2);
    expect(s.state).toBe('idle');
  });

  it('busy（exec 中）不做 ping 判定，防误杀长跑 cell', async () => {
    const s = makeSupervisor({ pingIntervalMs: 10, pingTimeoutMs: 15 });
    await s.start('D:/nb/demo.py');
    fakes[0]!.execDelayMs = 120;
    const p = s.request('exec_cell', { cellId: 'a', cascade: false });
    const pingsAtBusy = fakes[0]!.countOf('ping');
    await sleep(60);
    expect(fakes[0]!.countOf('ping')).toBe(pingsAtBusy);
    expect(s.state).toBe('busy');
    const report = await p;
    expect((report as { ok: boolean }).ok).toBe(true);
  });

  it('ping 超时（idle）→ 判定死亡，state=dead', async () => {
    const s = makeSupervisor({ pingIntervalMs: 10, pingTimeoutMs: 20 });
    await s.start('D:/nb/demo.py');
    fakes[0]!.ignorePing = true;
    await sleep(120);
    expect(s.state).toBe('dead');
    expect(statuses.at(-1)).toEqual({ state: 'dead', queueDepth: 0 });
  });

  it('崩溃检测：exit → 拒绝在途请求 + state=dead', async () => {
    const s = makeSupervisor();
    await s.start('D:/nb/demo.py');
    fakes[0]!.execDelayMs = 5_000;
    const p = s.request('exec_cell', { cellId: 'a', cascade: false });
    fakes[0]!.crash(1);
    expect(s.state).toBe('dead');
    await expect(p).rejects.toThrow(/内核/);
  });

  it('restart：杀进程重 spawn + load_file 回放同一路径', async () => {
    const s = makeSupervisor();
    await s.start('D:/nb/demo.py');
    fakes[0]!.crash(1);
    expect(s.state).toBe('dead');

    const state = (await s.restart()) as NotebookState;
    expect(fakes).toHaveLength(2);
    expect(fakes[1]!.loadedPath).toBe('D:/nb/demo.py');
    expect(fakes[1]!.countOf('load_file')).toBe(1);
    expect(state.cells).toHaveLength(3);
    expect(s.state).toBe('idle');
    const seq = statuses.map((p) => p.state);
    expect(seq).toEqual(['restarting', 'idle', 'dead', 'restarting', 'idle']);
  });

  it('并发 exec 请求 FIFO 排队，queueDepth 体现在 kernel.status', async () => {
    const s = makeSupervisor();
    await s.start('D:/nb/demo.py');
    fakes[0]!.execDelayMs = 30;

    const p1 = s.request('exec_cell', { cellId: 'a', cascade: false });
    const p2 = s.request('exec_cell', { cellId: 'b', cascade: false });
    const p3 = s.request('exec_repl', { code: '1+1' });
    // 第一个立即在途，其余排队
    expect(s.state).toBe('busy');
    expect(s.queueDepth).toBe(2);
    expect(statuses.at(-1)).toEqual({ state: 'busy', queueDepth: 2 });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect((r1 as { cellId: string }).cellId).toBe('a');
    expect((r2 as { cellId: string }).cellId).toBe('b');
    expect((r3 as { cellId: string }).cellId).toBe('repl');
    expect(fakes[0]!.maxConcurrency).toBe(1);
    expect(s.queueDepth).toBe(0);
    expect(s.state).toBe('idle');
    expect(statuses.at(-1)).toEqual({ state: 'idle', queueDepth: 0 });
  });

  it('内核返回 error → 请求 reject，state 不受影响', async () => {
    const s = makeSupervisor();
    await s.start('D:/nb/demo.py');
    await expect(s.request('no_such_method', {})).rejects.toThrow(/method not found/);
    expect(s.state).toBe('idle');
  });
});

/* ------------------------------------------------------------------ */
/* P4.1b packaged mode: env 解析 + 首启自装 venv（FakeTransport 级）     */
/* ------------------------------------------------------------------ */

describe('resolveKernelSpawnSpec（P4.1b env 覆盖与回落）', () => {
  it('无 env → 回落现状：uvBin=uv、pyDir=构造入参、packaged=false', () => {
    const spec = resolveKernelSpawnSpec('D:/repo/py', {});
    expect(spec.uvBin).toBe('uv');
    expect(spec.pyDir).toBe('D:/repo/py');
    expect(spec.packaged).toBe(false);
    expect(spec.args).toEqual(['run', '--directory', 'D:/repo/py', 'python', '-m', 'novakernel.server']);
  });

  it('NOVALAB_UV_BIN / NOVALAB_PY_DIR 覆盖 uv 命令与 pyDir', () => {
    const spec = resolveKernelSpawnSpec('D:/repo/py', {
      NOVALAB_UV_BIN: 'C:/inst/binaries/uv-x86_64-pc-windows-msvc.exe',
      NOVALAB_PY_DIR: 'C:/inst/py-resources/py',
    });
    expect(spec.uvBin).toBe('C:/inst/binaries/uv-x86_64-pc-windows-msvc.exe');
    expect(spec.pyDir).toBe('C:/inst/py-resources/py');
    expect(spec.args).toEqual([
      'run',
      '--directory',
      'C:/inst/py-resources/py',
      'python',
      '-m',
      'novakernel.server',
    ]);
    expect(spec.packaged).toBe(false); // 仅 PACKAGED=1 才 true
  });

  it('NOVALAB_PACKAGED=1 → packaged=true（触发首启自装）', () => {
    const spec = resolveKernelSpawnSpec('D:/repo/py', {
      NOVALAB_PACKAGED: '1',
      NOVALAB_UV_BIN: 'C:/inst/uv.exe',
      NOVALAB_PY_DIR: 'C:/inst/py',
    });
    expect(spec.packaged).toBe(true);
    expect(spec.uvBin).toBe('C:/inst/uv.exe');
    expect(spec.pyDir).toBe('C:/inst/py');
  });

  it('部分 env：只给 NOVALAB_PY_DIR，uvBin 仍回落 uv', () => {
    const spec = resolveKernelSpawnSpec('D:/repo/py', { NOVALAB_PY_DIR: 'C:/inst/py' });
    expect(spec.uvBin).toBe('uv');
    expect(spec.pyDir).toBe('C:/inst/py');
  });
});

/** 记录调用序列的假 runner（不真正 spawn）。 */
function fakeRunner(results: Array<{ ok: boolean; code: number | null }>): {
  runner: CommandRunner;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let i = 0;
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    const r = results[i++] ?? { ok: true, code: 0 };
    return r;
  };
  return { runner, calls };
}

describe('ensureKernelVenv（P4.1b 首启自装与 BYO 回落）', () => {
  it('.venv 已存在 → 不自装，直接 true（幂等）', async () => {
    const { runner, calls } = fakeRunner([]);
    const ok = await ensureKernelVenv('uv', 'C:/inst/py', {
      runner,
      venvExists: () => true,
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(0); // 未跑任何 uv 命令
  });

  it('.venv 缺失 → uv python install + uv sync --all-extras（用注入 uvBin/pyDir），成功 true', async () => {
    const { runner, calls } = fakeRunner([
      { ok: true, code: 0 },
      { ok: true, code: 0 },
    ]);
    const ok = await ensureKernelVenv('C:/inst/uv.exe', 'C:/inst/py', {
      runner,
      venvExists: () => false,
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([
      { cmd: 'C:/inst/uv.exe', args: ['python', 'install'] },
      { cmd: 'C:/inst/uv.exe', args: ['sync', '--directory', 'C:/inst/py', '--all-extras'] },
    ]);
  });

  it('uv python install 失败 → false（BYO 回落），且不跑 uv sync', async () => {
    const { runner, calls } = fakeRunner([{ ok: false, code: 1 }]);
    const ok = await ensureKernelVenv('uv', 'C:/inst/py', {
      runner,
      venvExists: () => false,
    });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1); // 只跑了 install
    expect(calls[0]!.args).toEqual(['python', 'install']);
  });

  it('uv sync 失败 → false（BYO 回落）', async () => {
    const { runner, calls } = fakeRunner([
      { ok: true, code: 0 },
      { ok: false, code: 2 },
    ]);
    const ok = await ensureKernelVenv('uv', 'C:/inst/py', {
      runner,
      venvExists: () => false,
    });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(2); // install + sync 都跑了，sync 失败
  });

  it('默认 venvExists 走 fs（不存在的路径 → 需要自装），runner 被调用', async () => {
    const { runner, calls } = fakeRunner([{ ok: true, code: 0 }]);
    // 用一个几乎必然不存在的 .venv 路径，验证默认 existsSync 分支返回 false → 触发自装
    const ok = await ensureKernelVenv('uv', 'Z:/__novalab_nonexistent__/py', { runner });
    expect(ok).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.args[0]).toBe('python');
  });

  it('超时由 runner 负责（此处注入 ok:false 模拟超时后的失败）→ false', async () => {
    const { runner } = fakeRunner([{ ok: false, code: null }]);
    const ok = await ensureKernelVenv('uv', 'C:/inst/py', {
      runner,
      timeoutMs: 1,
      venvExists: () => false,
    });
    expect(ok).toBe(false);
  });
});

describe('StdioKernelTransport spawn 路径（P4.1b，注入假 spawn 不真拉进程）', () => {
  /** 记录 spawn 调用与 stdin 写入的假 spawn 实现。 */
  function fakeSpawn() {
    const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const writes: string[] = [];
    const impl = ((cmd: string, args: readonly string[], opts?: { cwd?: string }) => {
      calls.push({ cmd: String(cmd), args: args.map(String), cwd: opts?.cwd });
      const ee = new EventEmitter() as unknown as ChildProcess & Record<string, unknown>;
      (ee as Record<string, unknown>).stdin = {
        writable: true,
        write: (s: string) => {
          writes.push(s);
          return true;
        },
        on: () => {},
      };
      (ee as Record<string, unknown>).stdout = { setEncoding: () => {}, on: () => {} };
      (ee as Record<string, unknown>).stderr = { setEncoding: () => {}, on: () => {} };
      (ee as Record<string, unknown>).pid = 12345;
      (ee as Record<string, unknown>).kill = () => true;
      return ee;
    }) as unknown as typeof spawn;
    return { impl, calls, writes };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('dev（无 env）→ 同步 spawn uv + 构造入参 pyDir', () => {
    const { impl, calls } = fakeSpawn();
    const t = new StdioKernelTransport('D:/repo/py', {}, { spawnImpl: impl });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('uv');
    expect(calls[0]!.cwd).toBe('D:/repo/py');
    expect(calls[0]!.args).toEqual([
      'run',
      '--directory',
      'D:/repo/py',
      'python',
      '-m',
      'novakernel.server',
    ]);
    t.kill();
  });

  it('packaged + 自装成功 → spawn sidecar uvBin + 资源 pyDir', async () => {
    const { impl, calls } = fakeSpawn();
    const t = new StdioKernelTransport(
      'D:/repo/py',
      {
        NOVALAB_PACKAGED: '1',
        NOVALAB_UV_BIN: 'C:/inst/binaries/uv.exe',
        NOVALAB_PY_DIR: 'C:/inst/py-resources/py',
      },
      { spawnImpl: impl, ensureVenv: async () => true },
    );
    // packaged 走异步 bootstrap：构造后尚未 spawn
    expect(calls).toHaveLength(0);
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('C:/inst/binaries/uv.exe');
    expect(calls[0]!.cwd).toBe('C:/inst/py-resources/py');
    t.kill();
  });

  it('packaged + 自装失败 → BYO 回落：spawn PATH uv（pyDir 仍为资源目录）', async () => {
    const { impl, calls } = fakeSpawn();
    const t = new StdioKernelTransport(
      'D:/repo/py',
      {
        NOVALAB_PACKAGED: '1',
        NOVALAB_UV_BIN: 'C:/inst/binaries/uv.exe',
        NOVALAB_PY_DIR: 'C:/inst/py-resources/py',
      },
      { spawnImpl: impl, ensureVenv: async () => false },
    );
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('uv'); // 回落 BYO，不用 sidecar uvBin
    expect(calls[0]!.cwd).toBe('C:/inst/py-resources/py');
    t.kill();
  });

  it('bootstrap 在途的 send() 缓冲，spawn 后 flush（load_file 首启不丢）', async () => {
    const { impl, writes } = fakeSpawn();
    const t = new StdioKernelTransport(
      'D:/repo/py',
      { NOVALAB_PACKAGED: '1', NOVALAB_PY_DIR: 'C:/inst/py' },
      { spawnImpl: impl, ensureVenv: async () => true },
    );
    // child 尚未 spawn：send 进缓冲，不抛
    t.send({ id: 1, method: 'load_file', params: { path: 'D:/nb.py' } });
    expect(writes).toHaveLength(0);
    await tick();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"load_file"');
    t.kill();
  });
});
