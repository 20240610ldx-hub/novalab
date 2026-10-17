/**
 * SessionStore 单测（P2.8）：begin/append/end 生命周期、snapshot 往返、
 * index.json 维护（live → endedAt/cellCount 更新、损坏宽容）、同秒 id 唯一。
 */

import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore, makeSessionId } from './session-store';
import type { SessionMeta, SessionSnapshot, SessionSnapshotCell } from './protocol';

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'novalab-sessions-'));
}

function cells(n: number, execCount = 1): SessionSnapshotCell[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    code: `x${i} = ${i}`,
    execCount: i < execCount ? execCount : 0,
    defs: [`x${i}`],
    refs: [],
    output: {
      stdout: i === 0 ? 'hello\n' : '',
      stderr: '',
      traceback: null,
      mimeKeys: i === 0 ? ['text/plain'] : [],
      writes: [],
    },
  }));
}

function readIndex(dir: string): SessionMeta[] {
  return JSON.parse(readFileSync(path.join(dir, '.novalab', 'sessions', 'index.json'), 'utf8')) as SessionMeta[];
}

describe('SessionStore · 生命周期', () => {
  it('begin：建 sessions 目录 + 空 jsonl + index live 条目（无 endedAt，source=local）', () => {
    const dir = tmpDir();
    const store = new SessionStore(() => new Date('2026-10-06T08:00:00Z'));
    const s = store.begin({ notebookDir: dir, notebookPath: path.join(dir, 'nb.py'), cellCount: 3 });
    expect(s.id).toBe('s-20261006T080000-' + s.id.slice(-4));
    expect(s.startedAt).toBe('2026-10-06T08:00:00.000Z');
    const sessionsDir = SessionStore.dirFor(dir);
    expect(existsSync(path.join(sessionsDir, `${s.id}.jsonl`))).toBe(true);
    expect(readFileSync(path.join(sessionsDir, `${s.id}.jsonl`), 'utf8')).toBe('');
    const index = readIndex(dir);
    expect(index).toHaveLength(1);
    // O-2：index 条目带 notebookPath（同目录多 .py 据此区分归属）
    expect(index[0]).toEqual({
      id: s.id,
      startedAt: s.startedAt,
      cellCount: 3,
      source: 'local',
      notebookPath: path.join(dir, 'nb.py'),
    });
    expect(index[0]!.endedAt).toBeUndefined();
  });

  it('append：事件按行落 <id>.jsonl（{ts,kind,actor,...}，与 session-log 同形状）', () => {
    const dir = tmpDir();
    const store = new SessionStore(() => new Date('2026-10-06T08:00:00Z'));
    const s = store.begin({ notebookDir: dir, notebookPath: path.join(dir, 'nb.py'), cellCount: 0 });
    s.append({ kind: 'save', cellId: 'a', payloadRef: 'chars:3' });
    s.append({ kind: 'run', actor: 'agent', cellId: 'a', payloadRef: 'exec:1' });
    const lines = readFileSync(s.jsonlFile, 'utf8').split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: '2026-10-06T08:00:00.000Z', kind: 'save', actor: 'user', cellId: 'a', payloadRef: 'chars:3',
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({ actor: 'agent' });
  });

  it('end：写 snapshot.json（cells 全量 + endedAt + endReason）并更新 index', () => {
    const dir = tmpDir();
    let now = new Date('2026-10-06T08:00:00Z');
    const store = new SessionStore(() => now);
    const s = store.begin({ notebookDir: dir, notebookPath: path.join(dir, 'nb.py'), cellCount: 0 });
    now = new Date('2026-10-06T09:30:00Z');
    const meta = store.end(s, cells(2), 'restart');

    expect(meta.endedAt).toBe('2026-10-06T09:30:00.000Z');
    expect(meta.cellCount).toBe(2);
    const index = readIndex(dir);
    expect(index).toHaveLength(1);
    expect(index[0]).toEqual({ ...meta, source: 'local', notebookPath: path.join(dir, 'nb.py') });

    const snap: SessionSnapshot = JSON.parse(
      readFileSync(path.join(SessionStore.dirFor(dir), `${s.id}.snapshot.json`), 'utf8'),
    );
    expect(snap.sessionId).toBe(s.id);
    expect(snap.notebookPath).toBe(path.join(dir, 'nb.py'));
    expect(snap.startedAt).toBe('2026-10-06T08:00:00.000Z');
    expect(snap.endedAt).toBe('2026-10-06T09:30:00.000Z');
    expect(snap.endReason).toBe('restart');
    expect(snap.cells).toHaveLength(2);
    expect(snap.cells[0]!.output.stdout).toBe('hello\n');
    expect(snap.cells[0]!.output.mimeKeys).toEqual(['text/plain']);
  });

  it('open：snapshot 往返一致 + 事件流一并返回；未知/未结束 id → null', () => {
    const dir = tmpDir();
    const store = new SessionStore(() => new Date('2026-10-06T08:00:00Z'));
    const s = store.begin({ notebookDir: dir, notebookPath: path.join(dir, 'nb.py'), cellCount: 0 });
    s.append({ kind: 'run', cellId: 'c0' });
    // 未结束：没有 snapshot → null（live 投影由 router 内存兜底）
    expect(store.open(dir, s.id)).toBeNull();

    store.end(s, cells(2), 'crash');
    const found = store.open(dir, s.id);
    expect(found).not.toBeNull();
    expect(found!.snapshot.cells).toEqual(cells(2));
    expect(found!.meta.endedAt).toBeDefined();
    expect(found!.events).toHaveLength(1);
    expect(found!.events[0]).toMatchObject({ kind: 'run', cellId: 'c0' });

    expect(store.open(dir, 's-nope-0000')).toBeNull();
    expect(store.open(dir, '..\\..\\evil')).toBeNull(); // 文件名白名单拒绝
  });

  it('多会话：index 按 begin 顺序追加；restart 语义 = 旧 ended + 新 live', () => {
    const dir = tmpDir();
    let t = new Date('2026-10-06T08:00:00Z');
    const store = new SessionStore(() => t);
    const s1 = store.begin({ notebookDir: dir, notebookPath: path.join(dir, 'nb.py'), cellCount: 3 });
    t = new Date('2026-10-06T08:10:00Z');
    store.end(s1, cells(3), 'restart');
    const s2 = store.begin({ notebookDir: dir, notebookPath: path.join(dir, 'nb.py'), cellCount: 3 });

    const index = store.list(dir);
    expect(index.map((m) => m.id)).toEqual([s1.id, s2.id]);
    expect(index[0]!.endedAt).toBe('2026-10-06T08:10:00.000Z');
    expect(index[1]!.endedAt).toBeUndefined(); // live
    t = new Date('2026-10-06T08:20:00Z');
    store.end(s2, cells(4), 'shutdown');
    expect(store.list(dir).map((m) => m.cellCount)).toEqual([3, 4]);
  });
});

describe('SessionStore · O-2 同目录多 notebook 归属', () => {
  it('list 按 notebookPath 过滤：只返回属于该 notebook 的会话', () => {
    const dir = tmpDir();
    const a = path.join(dir, 'a.py');
    const b = path.join(dir, 'b.py');
    const store = new SessionStore(() => new Date('2026-10-06T08:00:00Z'));
    const sa = store.begin({ notebookDir: dir, notebookPath: a, cellCount: 1 });
    const sb = store.begin({ notebookDir: dir, notebookPath: b, cellCount: 1 });

    expect(store.list(dir).map((m) => m.id).sort()).toEqual([sa.id, sb.id].sort());
    expect(store.list(dir, a).map((m) => m.id)).toEqual([sa.id]);
    expect(store.list(dir, b).map((m) => m.id)).toEqual([sb.id]);
  });

  it('无归属的历史条目：该 notebook 无归属条目时兜底可见（升级不丢列表）', () => {
    const dir = tmpDir();
    const sessionsDir = SessionStore.dirFor(dir);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      path.join(sessionsDir, 'index.json'),
      JSON.stringify([{ id: 's-legacy', startedAt: '2026-01-01T00:00:00Z', cellCount: 2, source: 'local' }]),
      'utf8',
    );
    const store = new SessionStore();
    expect(store.list(dir, path.join(dir, 'a.py')).map((m) => m.id)).toEqual(['s-legacy']);
  });

  it('无归属且缺少快照的旧条目仍保留，不能猜成另一个 notebook', () => {
    const dir = tmpDir();
    const sessionsDir = SessionStore.dirFor(dir);
    const store = new SessionStore(() => new Date('2026-10-06T08:00:00Z'));
    const s = store.begin({ notebookDir: dir, notebookPath: path.join(dir, 'a.py'), cellCount: 1 });
    // 无法恢复归属的旧记录保留；新记录出现不应使旧记录消失。
    const index = JSON.parse(readFileSync(path.join(sessionsDir, 'index.json'), 'utf8')) as SessionMeta[];
    index.push({ id: 's-legacy', startedAt: '2026-01-01T00:00:00Z', cellCount: 2, source: 'local' });
    writeFileSync(path.join(sessionsDir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');

    expect(store.list(dir, path.join(dir, 'a.py')).map((m) => m.id)).toEqual([s.id, 's-legacy']);
    expect(store.list(dir).map((m) => m.id).sort()).toEqual([s.id, 's-legacy'].sort());
  });

  it('旧版历史从 snapshot 恢复归属；新会话不隐藏同 notebook 的旧历史', () => {
    const dir = tmpDir();
    const a = path.join(dir, 'a.py');
    const b = path.join(dir, 'b.py');
    const store = new SessionStore();
    const oldA = store.begin({ notebookDir: dir, notebookPath: a, cellCount: 1 });
    store.end(oldA, cells(1));
    const oldB = store.begin({ notebookDir: dir, notebookPath: b, cellCount: 1 });
    store.end(oldB, cells(1));
    const indexFile = path.join(SessionStore.dirFor(dir), 'index.json');
    const legacy = readIndex(dir).map(({ notebookPath: _path, ...m }) => m);
    writeFileSync(indexFile, JSON.stringify(legacy), 'utf8');
    const current = store.begin({ notebookDir: dir, notebookPath: a, cellCount: 1 });

    const listed = store.list(dir, a);
    expect(listed.map((m) => m.id)).toEqual([oldA.id, current.id]);
    expect(listed.every((m) => m.notebookPath === a)).toBe(true);
    expect(store.list(dir, b).map((m) => m.id)).toEqual([oldB.id]);
  });

  it('路径大小写按宿主平台比较：Windows 折叠，Linux 保留区别', () => {
    const dir = tmpDir();
    const nb = path.join(dir, 'a.py');
    const store = new SessionStore(() => new Date('2026-10-06T08:00:00Z'));
    const s = store.begin({ notebookDir: dir, notebookPath: nb, cellCount: 1 });
    expect(store.list(dir, nb.toUpperCase()).map((m) => m.id)).toEqual(process.platform === 'win32' ? [s.id] : []);
  });
});

describe('SessionStore · 容错', () => {
  it('list：目录缺失 / index 损坏 → []（不抛）', () => {
    const dir = tmpDir();
    const store = new SessionStore();
    expect(store.list(dir)).toEqual([]);
    mkdirSync(SessionStore.dirFor(dir), { recursive: true });
    writeFileSync(path.join(SessionStore.dirFor(dir), 'index.json'), '{broken', 'utf8');
    expect(store.list(dir)).toEqual([]);
  });

  it('end：index 条目丢失（外部损坏）→ 兜底追加完整元数据', () => {
    const dir = tmpDir();
    const store = new SessionStore(() => new Date('2026-10-06T08:00:00Z'));
    const s = store.begin({ notebookDir: dir, notebookPath: path.join(dir, 'nb.py'), cellCount: 0 });
    writeFileSync(path.join(SessionStore.dirFor(dir), 'index.json'), '[]', 'utf8');
    const meta = store.end(s, cells(1), 'crash');
    const index = store.list(dir);
    expect(index).toHaveLength(1);
    expect(index[0]).toEqual(meta);
    expect(index[0]!.cellCount).toBe(1);
  });

  it('readEvents：半行损坏跳过；文件缺失 → []', () => {
    const dir = tmpDir();
    const store = new SessionStore();
    const sessionsDir = SessionStore.dirFor(dir);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      path.join(sessionsDir, 's-x.jsonl'),
      '{"ts":"2026-10-06T08:00:00.000Z","kind":"run","actor":"user"}\n{"broken\n',
      'utf8',
    );
    const events = store.readEvents(dir, 's-x');
    expect(events).toHaveLength(1);
    expect(store.readEvents(dir, 'missing')).toEqual([]);
  });

  it('scanIds：只认事件流，不把运行日志 <id>.runs.jsonl 当成会话（ADR-014）', () => {
    const dir = tmpDir();
    const sessionsDir = SessionStore.dirFor(dir);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(path.join(sessionsDir, 's-a.jsonl'), '', 'utf8');
    writeFileSync(path.join(sessionsDir, 's-a.runs.jsonl'), '', 'utf8');
    expect(new SessionStore().scanIds(dir)).toEqual(['s-a']);
  });

  it('makeSessionId：同一时钟连续生成也不冲突（随机后缀）', () => {
    const t = new Date('2026-10-06T08:00:00Z');
    const ids = new Set(Array.from({ length: 50 }, () => makeSessionId(t)));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^s-20261006T080000-[0-9a-f]{4}$/);
  });
});
