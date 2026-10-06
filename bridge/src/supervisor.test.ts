import { describe, expect, it, afterEach } from 'vitest';
import { KernelSupervisor } from './supervisor';
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
