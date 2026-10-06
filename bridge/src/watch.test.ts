import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotebookWatcher, type FsEventSource } from './watch';
import { KernelSupervisor } from './supervisor';
import { RpcRouter } from './router';
import { FakeKernel } from './testing/fake-kernel';
import type { NotebookState, RpcResponse } from './protocol';

/** 假事件源：手动 emit，单测不碰真 fs/chokidar。 */
class FakeEventSource implements FsEventSource {
  readonly added: string[] = [];
  readonly removed: string[] = [];
  closeCount = 0;
  private cb?: (event: string, filePath: string) => void;

  add(filePath: string): void {
    this.added.push(filePath);
  }
  remove(filePath: string): void {
    this.removed.push(filePath);
  }
  close(): void {
    this.closeCount++;
  }
  onEvent(cb: (event: string, filePath: string) => void): void {
    this.cb = cb;
  }
  emit(event: string, filePath: string): void {
    this.cb?.(event, filePath);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- NotebookWatcher 单元（假事件源 + fake timers） ----------

describe('NotebookWatcher · debounce / 自写跳过 / unwatch', () => {
  const FILE = path.resolve(mkdtempSync(path.join(tmpdir(), 'novalab-watch-')), 'demo.py');

  function make(opts?: { debounceMs?: number; suppressMs?: number }) {
    const sources: FakeEventSource[] = [];
    const changes: string[] = [];
    const watcher = new NotebookWatcher({
      sourceFactory: () => {
        const s = new FakeEventSource();
        sources.push(s);
        return s;
      },
      onExternalChange: (p) => {
        changes.push(p);
      },
      debounceMs: opts?.debounceMs ?? 300,
      suppressMs: opts?.suppressMs ?? 500,
    });
    return { watcher, source: () => sources[0]!, changes };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('watch 注册路径；连发事件 debounce 合并为一次回调', () => {
    vi.useFakeTimers();
    const { watcher, source, changes } = make();
    watcher.watch(FILE);
    expect(source().added).toEqual([FILE]);

    source().emit('change', FILE);
    vi.advanceTimersByTime(100);
    source().emit('change', FILE);
    vi.advanceTimersByTime(100);
    source().emit('change', FILE);
    vi.advanceTimersByTime(299);
    expect(changes).toEqual([]); // 静默期未满
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([FILE]); // 三次合并为一次
  });

  it('自写窗口内的事件被忽略；窗口过后恢复触发', () => {
    vi.useFakeTimers();
    const { watcher, source, changes } = make();
    watcher.watch(FILE);

    watcher.markSelfWrite(FILE); // 写盘前
    source().emit('change', FILE);
    vi.advanceTimersByTime(200);
    watcher.markSelfWrite(FILE); // 写盘后 → 窗口顺延至 +500ms
    source().emit('change', FILE);
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([]); // 全部落在 suppress 窗口内

    vi.advanceTimersByTime(10); // 窗口已过
    source().emit('change', FILE);
    vi.advanceTimersByTime(300);
    expect(changes).toEqual([FILE]);
  });

  it('debounce 到点时复查 suppress：窗口后到的 markSelfWrite 也能拦截', () => {
    vi.useFakeTimers();
    const { watcher, source, changes } = make();
    watcher.watch(FILE);
    source().emit('change', FILE);
    vi.advanceTimersByTime(200);
    watcher.markSelfWrite(FILE); // 事件已入 debounce 队列，但写盘标记后到
    vi.advanceTimersByTime(200);
    expect(changes).toEqual([]);
  });

  it('非 change/add 事件（unlink 等）与异路径事件不触发', () => {
    vi.useFakeTimers();
    const { watcher, source, changes } = make();
    watcher.watch(FILE);
    source().emit('unlink', FILE);
    source().emit('change', path.join(path.dirname(FILE), 'other.py'));
    vi.advanceTimersByTime(600);
    expect(changes).toEqual([]);
  });

  it('重开 notebook：unwatch 旧路径、watch 新路径；旧路径事件不再触发', () => {
    vi.useFakeTimers();
    const { watcher, source, changes } = make();
    const FILE2 = path.join(path.dirname(FILE), 'second.py');
    watcher.watch(FILE);
    watcher.watch(FILE2);
    expect(source().removed).toEqual([FILE]);
    expect(source().added).toEqual([FILE, FILE2]);

    source().emit('change', FILE);
    vi.advanceTimersByTime(600);
    expect(changes).toEqual([]);

    source().emit('change', FILE2);
    vi.advanceTimersByTime(300);
    expect(changes).toEqual([FILE2]);
  });

  it('close：unwatch 当前路径并关闭事件源', () => {
    const { watcher, source } = make();
    watcher.watch(FILE);
    watcher.close();
    expect(source().removed).toEqual([FILE]);
    expect(source().closeCount).toBe(1);
    expect(watcher.watchedPath).toBeUndefined();
  });
});

// ---------- router 集成（FakeKernel + 假事件源，缩短窗口用真实计时器） ----------

const NB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'novalab-watch-router-')), 'demo.py');
const SESSION_FILE = path.join(path.dirname(NB_PATH), '.novalab', 'session.jsonl');

interface SessionEventLike {
  ts: string;
  kind: string;
  cellId?: string;
  payloadRef?: string;
}

function sessionEvents(): SessionEventLike[] {
  if (!existsSync(SESSION_FILE)) return [];
  return readFileSync(SESSION_FILE, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as SessionEventLike);
}

describe('RpcRouter · 外部变更热重载', () => {
  let sup: KernelSupervisor | undefined;
  let router: RpcRouter | undefined;

  afterEach(() => {
    router?.dispose();
    sup?.stop();
    sup = undefined;
    router = undefined;
  });

  function setup() {
    const fakes: FakeKernel[] = [];
    const sources: FakeEventSource[] = [];
    const notes: { method: string; params?: unknown }[] = [];
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
      watcherFactory: () => {
        const s = new FakeEventSource();
        sources.push(s);
        return s;
      },
      watcherDebounceMs: 10,
      watcherSuppressMs: 80,
    });
    let reqId = 0;
    const call = (method: string, params?: unknown): Promise<RpcResponse> =>
      router!.handle({ jsonrpc: '2.0', id: ++reqId, method, params });
    return { fakes, sources, notes, call, source: () => sources[0]! };
  }

  it('notebook.open → watch 该 .py', async () => {
    const { call, source } = setup();
    const res = await call('notebook.open', { path: NB_PATH });
    expect(res.error).toBeUndefined();
    expect(source().added).toEqual([path.resolve(NB_PATH)]);
  });

  it('外部变更 → load_file + notebook.state 广播 + session external_reload', async () => {
    const { fakes, notes, call, source } = setup();
    await call('notebook.open', { path: NB_PATH });
    // 外部改文件后内核侧的新状态（FakeKernel：改内存 cells 再 emit 事件）
    fakes[0]!.cells = [
      { id: 'a', code: 'x = 99', execCount: 0, defs: ['x'], refs: [] },
    ];
    expect(fakes[0]!.countOf('load_file')).toBe(1);

    source().emit('change', NB_PATH);
    source().emit('change', NB_PATH); // debounce 合并
    await sleep(60);

    expect(fakes[0]!.countOf('load_file')).toBe(2);
    const states = notes.filter((n) => n.method === 'notebook.state');
    expect(states).toHaveLength(1);
    const state = states[0]!.params as NotebookState;
    expect(state.cells).toHaveLength(1);
    expect(state.cells[0]!.code).toBe('x = 99');
    expect(sessionEvents().at(-1)).toMatchObject({
      kind: 'external_reload',
      payloadRef: path.resolve(NB_PATH),
    });
  });

  it('自写跳过：cell.save 写盘（save_file）前后维持 suppress 窗口，事件不触发重载', async () => {
    const { fakes, notes, call, source } = setup();
    await call('notebook.open', { path: NB_PATH });

    const res = await call('cell.save', { cellId: 'a', code: 'x = 2' });
    expect(res.error).toBeUndefined();
    // cell.save 落盘链路：set_cells 后跟 save_file（全量 cells）
    expect(fakes[0]!.countOf('save_file')).toBe(1);
    const saveReq = fakes[0]!.requests.find((r) => r.method === 'save_file')!;
    expect((saveReq.params as { path: string }).path).toBe(NB_PATH);

    // 自己写盘引发的 fs 事件（suppress 窗口内）→ 忽略
    source().emit('change', NB_PATH);
    await sleep(40);
    expect(fakes[0]!.countOf('load_file')).toBe(1);
    expect(notes.filter((n) => n.method === 'notebook.state')).toHaveLength(0);

    // 窗口过后的真实外部变更 → 仍然触发
    await sleep(80);
    source().emit('change', NB_PATH);
    await sleep(40);
    expect(fakes[0]!.countOf('load_file')).toBe(2);
  });

  it('重开另一 notebook：旧路径 unwatch，旧路径事件不再重载', async () => {
    const { fakes, call, source } = setup();
    await call('notebook.open', { path: NB_PATH });
    const NB2 = path.join(mkdtempSync(path.join(tmpdir(), 'novalab-watch-router2-')), 'b.py');
    await call('notebook.open', { path: NB2 });
    expect(source().removed).toEqual([path.resolve(NB_PATH)]);

    source().emit('change', NB_PATH);
    await sleep(40);
    expect(fakes[1]!.countOf('load_file')).toBe(1); // 只有 open 时那一次
  });
});
