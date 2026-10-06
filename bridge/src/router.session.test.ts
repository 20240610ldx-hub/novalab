/**
 * RpcRouter · fs.* / session.*（P2.8）集成单测：
 * - notebook.open → 默认 root = dirname、session.started、事件按会话落盘；
 * - fs.* RPC 走 FsManager 监狱（越界 -32602）；setRoot 可改；
 * - kernel.restart / 内核崩溃 → 旧会话 ended（snapshot + index）+ 新会话 live；
 * - session.list / session.open RPC 形状（readOnly:true）。
 * 每个测试独立 tmp 工作区（index.json 跨测试不串扰）。
 */

import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KernelSupervisor } from './supervisor';
import { RpcRouter } from './router';
import { FakeKernel } from './testing/fake-kernel';
import { SessionStore } from './session-store';
import type {
  FsEntry,
  FsRootResult,
  NotebookState,
  RpcResponse,
  SessionEndedParams,
  SessionMeta,
  SessionOpenResult,
  SessionSnapshot,
  SessionStartedParams,
} from './protocol';

let ws: string; // 每测试新建的工作区（= 默认 root）
let nbPath: string;
let sessionsDir: string;
let sup: KernelSupervisor | undefined;
let fakes: FakeKernel[] = [];
let notes: { method: string; params?: unknown }[] = [];
let router: RpcRouter;
let reqId = 0;

/** 会话时钟：每次调用前进 1 分钟，时间戳可预期且 id 不冲突。 */
let clockNow = new Date('2026-10-06T08:00:00Z');
function clock(): Date {
  const t = clockNow;
  clockNow = new Date(t.getTime() + 60_000);
  return t;
}

function setup(): void {
  ws = mkdtempSync(path.join(tmpdir(), 'novalab-rs-'));
  nbPath = path.join(ws, 'demo.py');
  sessionsDir = path.join(ws, '.novalab', 'sessions');
  writeFileSync(nbPath, 'x = 1\n', 'utf8');
  writeFileSync(path.join(ws, 'other.py'), 'q = 1\n', 'utf8');
  fakes = [];
  notes = [];
  reqId = 0;
  clockNow = new Date('2026-10-06T08:00:00Z');
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
    clock,
    sessionStore: new SessionStore(clock),
  });
}

async function call(method: string, params?: unknown): Promise<RpcResponse> {
  return router.handle({ jsonrpc: '2.0', id: ++reqId, method, params });
}

async function openNotebook(): Promise<NotebookState> {
  const res = await call('notebook.open', { path: nbPath });
  expect(res.error).toBeUndefined();
  return res.result as NotebookState;
}

function lastParams<T>(method: string): T | undefined {
  for (let i = notes.length - 1; i >= 0; i--) {
    if (notes[i]!.method === method) return notes[i]!.params as T;
  }
  return undefined;
}

function allParams<T>(method: string): T[] {
  return notes.filter((n) => n.method === method).map((n) => n.params as T);
}

function index(): SessionMeta[] {
  return JSON.parse(readFileSync(path.join(sessionsDir, 'index.json'), 'utf8')) as SessionMeta[];
}

function sessionFileEvents(id: string): { kind: string; cellId?: string }[] {
  return readFileSync(path.join(sessionsDir, `${id}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { kind: string; cellId?: string });
}

afterEach(() => {
  router?.dispose();
  sup?.stop();
  sup = undefined;
});

describe('RpcRouter · fs.*', () => {
  it('notebook.open 后默认 root = dirname；fs.root 可查询', async () => {
    setup();
    await openNotebook();
    const res = await call('fs.root');
    expect((res.result as FsRootResult).root).toBe(realpathSync(ws));
  });

  it('fs.setRoot 改 root；非法目录 → -32602', async () => {
    setup();
    await openNotebook();
    const other = path.join(ws, 'elsewhere');
    mkdirSync(other, { recursive: true });
    const ok = await call('fs.setRoot', { dir: other });
    expect((ok.result as FsRootResult).root).toBe(realpathSync(other));
    const bad = await call('fs.setRoot', { dir: path.join(ws, 'nope') });
    expect(bad.error?.code).toBe(-32602);
    // root 仍是 other（bad setRoot 未生效）
    expect((await call('fs.root')).result).toEqual({ root: realpathSync(other) });
  });

  it('未设置 root（未 open）时 fs.list → -32602', async () => {
    setup();
    const res = await call('fs.list', { dir: '' });
    expect(res.error?.code).toBe(-32602);
  });

  it('fs.list / mkdir / rename / remove / writeFile 经 RPC 往返', async () => {
    setup();
    await openNotebook();
    const list = await call('fs.list', { dir: '' });
    const names = (list.result as FsEntry[]).map((e) => e.name);
    expect(names).toContain('demo.py');
    expect(names).toContain('other.py');

    expect((await call('fs.mkdir', { dir: 'data' })).error).toBeUndefined();
    expect((await call('fs.writeFile', { path: 'data/n.py', content: '# /// script\n# ///\n' })).error).toBeUndefined();
    expect(existsSync(path.join(ws, 'data', 'n.py'))).toBe(true);
    expect((await call('fs.rename', { from: 'data/n.py', to: 'data/m.py' })).error).toBeUndefined();
    expect((await call('fs.remove', { path: 'data' })).error).toBeUndefined();
    expect(existsSync(path.join(ws, 'data'))).toBe(false);
  });

  it('越界路径经 RPC → -32602（.. 链 / 绝对路径 / 穿越文件名）', async () => {
    setup();
    await openNotebook();
    const outside = path.dirname(ws); // mkdtemp 父目录 = tmpdir
    const escapes: [string, Record<string, unknown>][] = [
      ['fs.list', { dir: '..' }],
      ['fs.list', { dir: '../..' }],
      ['fs.mkdir', { dir: '../pwn' }],
      ['fs.remove', { path: path.join(outside, 'stolen.py') }],
      ['fs.rename', { from: 'demo.py', to: '../../stolen.py' }],
      ['fs.writeFile', { path: '../evil.py', content: 'x' }],
      ['fs.list', { dir: tmpdir() }],
      ['fs.list', { dir: process.platform === 'win32' ? 'C:\\Windows' : '/etc' }],
    ];
    for (const [method, params] of escapes) {
      const res = await call(method, params);
      expect(res.error?.code, `${method} ${JSON.stringify(params)}`).toBe(-32602);
    }
  });
});

describe('RpcRouter · session 生命周期', () => {
  it('notebook.open → session.started + live index 条目；事件落 <id>.jsonl', async () => {
    setup();
    await openNotebook();
    const started = lastParams<SessionStartedParams>('session.started');
    expect(started).toBeDefined();
    expect(started!.notebookPath).toBe(nbPath);

    const idx = index();
    expect(idx).toHaveLength(1);
    expect(idx[0]!.id).toBe(started!.sessionId);
    expect(idx[0]!.endedAt).toBeUndefined();
    expect(idx[0]!.cellCount).toBe(3);

    await call('cell.save', { cellId: 'a', code: 'x = 2' });
    await call('cell.run', { cellId: 'a', cascade: false });
    const kinds = sessionFileEvents(started!.sessionId).map((e) => e.kind);
    expect(kinds).toEqual(['save', 'run']);
  });

  it('kernel.restart → 旧会话 ended（snapshot + index.endedAt）+ 新会话 live', async () => {
    setup();
    await openNotebook();
    const first = lastParams<SessionStartedParams>('session.started')!;
    await call('cell.run', { cellId: 'a', cascade: false }); // execCount/输出进快照
    notes = [];

    const res = await call('kernel.restart');
    expect(res.error).toBeUndefined();

    const ended = lastParams<SessionEndedParams>('session.ended');
    expect(ended).toMatchObject({ sessionId: first.sessionId, reason: 'restart' });
    const next = allParams<SessionStartedParams>('session.started');
    expect(next).toHaveLength(1);
    expect(next[0]!.sessionId).not.toBe(first.sessionId);

    const idx = index();
    expect(idx).toHaveLength(2);
    expect(idx[0]!.endedAt).toBe(ended!.endedAt);
    expect(idx[1]!.endedAt).toBeUndefined();

    // snapshot：cells 全量 + 输出缓冲摘要（run 后 stdout 已累积）
    const snapFile = path.join(sessionsDir, `${first.sessionId}.snapshot.json`);
    const snap: SessionSnapshot = JSON.parse(readFileSync(snapFile, 'utf8'));
    expect(snap.endReason).toBe('restart');
    expect(snap.cells).toHaveLength(3);
    const cellA = snap.cells.find((c) => c.id === 'a')!;
    expect(cellA.execCount).toBe(1);
    expect(cellA.output.stdout).toContain('fake output for a');
  });

  it('内核崩溃 → 当前会话 ended（reason=crash）；restart 后开新会话', async () => {
    setup();
    await openNotebook();
    const first = lastParams<SessionStartedParams>('session.started')!;
    fakes[0]!.crash(1);
    const ended = lastParams<SessionEndedParams>('session.ended');
    expect(ended).toMatchObject({ sessionId: first.sessionId, reason: 'crash' });
    expect(index()[0]!.endedAt).toBe(ended!.endedAt);

    await call('kernel.restart');
    const second = allParams<SessionStartedParams>('session.started').at(-1)!;
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(index()).toHaveLength(2);
    expect(index()[1]!.endedAt).toBeUndefined();
  });

  it('切换 notebook → 旧会话 ended（reason=switch）+ 新 notebook 开新会话', async () => {
    setup();
    await openNotebook();
    const first = lastParams<SessionStartedParams>('session.started')!;
    const otherNb = path.join(ws, 'other.py');
    const res = await call('notebook.open', { path: otherNb });
    expect(res.error).toBeUndefined();
    expect(lastParams<SessionEndedParams>('session.ended')).toMatchObject({
      sessionId: first.sessionId,
      reason: 'switch',
    });
    const second = allParams<SessionStartedParams>('session.started').at(-1)!;
    expect(second.notebookPath).toBe(otherNb);
    // other.py 的 sessions 与 demo.py 同目录（.novalab 在 ws 下）→ index 2 条
    expect(index()).toHaveLength(2);
    // root 跟随最近一次 open（dirname 不变）
    expect((await call('fs.root')).result).toEqual({ root: realpathSync(ws) });
  });

  it('dispose → 会话 ended（reason=shutdown），快照落盘', async () => {
    setup();
    await openNotebook();
    const first = lastParams<SessionStartedParams>('session.started')!;
    router.dispose();
    const ended = lastParams<SessionEndedParams>('session.ended');
    expect(ended).toMatchObject({ sessionId: first.sessionId, reason: 'shutdown' });
    expect(existsSync(path.join(sessionsDir, `${first.sessionId}.snapshot.json`))).toBe(true);
  });
});

describe('RpcRouter · session.list / session.open', () => {
  it('session.list：默认当前 notebook；live cellCount 以缓存为准', async () => {
    setup();
    await openNotebook();
    const started = lastParams<SessionStartedParams>('session.started')!;
    // diff.accept insert_below 增加一个 cell（缓存 4 > index 记录的 3）
    const stage = await call('diff.stage', { targetCellId: 'a', action: 'insert_below', newCode: 'z = 9' });
    await call('diff.accept', { diffId: (stage.result as { diffId: string }).diffId });

    const res = await call('session.list', {});
    const metas = res.result as SessionMeta[];
    expect(metas).toHaveLength(1);
    expect(metas[0]!.id).toBe(started.sessionId);
    expect(metas[0]!.cellCount).toBe(4);
    expect(metas[0]!.source).toBe('local');
  });

  it('session.list 显式 notebookPath（未 open 也可读盘）；缺参且无 open → -32602', async () => {
    setup();
    const res = await call('session.list', { notebookPath: nbPath });
    expect(res.error).toBeUndefined();
    expect(Array.isArray(res.result)).toBe(true);

    sup?.stop();
    setup(); // 新 router（无 open）
    const bad = await call('session.list', {});
    expect(bad.error?.code).toBe(-32602);
  });

  it('session.open：历史会话 → {cells, endedAt, readOnly:true}；未知 id → -32602', async () => {
    setup();
    await openNotebook();
    const first = lastParams<SessionStartedParams>('session.started')!;
    await call('cell.run', { cellId: 'b', cascade: false });
    await call('kernel.restart');

    const res = await call('session.open', { sessionId: first.sessionId });
    expect(res.error).toBeUndefined();
    const opened = res.result as SessionOpenResult;
    expect(opened.readOnly).toBe(true);
    expect(opened.sessionId).toBe(first.sessionId);
    expect(typeof opened.endedAt).toBe('string');
    expect(opened.cells).toHaveLength(3);
    const cellB = opened.cells.find((c) => c.id === 'b')!;
    expect(cellB.execCount).toBe(1);
    expect(cellB.output.stdout).toContain('fake output for b');

    const bad = await call('session.open', { sessionId: 's-19700101T000000-ffff' });
    expect(bad.error?.code).toBe(-32602);
  });

  it('session.open live id → 内存投影（endedAt:null, readOnly:true）', async () => {
    setup();
    await openNotebook();
    const live = lastParams<SessionStartedParams>('session.started')!;
    const res = await call('session.open', { sessionId: live.sessionId });
    const opened = res.result as SessionOpenResult;
    expect(opened.endedAt).toBeNull();
    expect(opened.readOnly).toBe(true);
    expect(opened.cells).toHaveLength(3);
  });
});
