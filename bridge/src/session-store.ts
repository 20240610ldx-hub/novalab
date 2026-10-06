/**
 * SessionStore —— 按内核生命周期落盘的会话存储（P2.8，intent M9 / spec §11 / A-2 #12-14）。
 *
 * 目录布局（notebook 目录下）：
 *   .novalab/sessions/index.json                 [{id, startedAt, endedAt?, cellCount, source:'local'}]
 *   .novalab/sessions/<sessionId>.jsonl          一个内核生命周期的事件流（原 session.jsonl 按会话拆分）
 *   .novalab/sessions/<sessionId>.snapshot.json  会话结束时写入：cells 全量 + 输出缓冲摘要
 *
 * 生命周期：begin（notebook.open / kernel.restart 后）→ append（router 事件）→
 * end（restart / crash / switch / shutdown：写 snapshot + 补 index.endedAt）。
 * index.json 宽容读取（损坏 → 空列表，不抛），写入为整文件重写（低频操作）。
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  SessionEndReason,
  SessionMeta,
  SessionSnapshot,
  SessionSnapshotCell,
} from './protocol';
import type { SessionEvent, SessionEventInput } from './session-log';

/** begin() 返回的活跃会话句柄：事件追加 + 文件定位。 */
export interface ActiveSession {
  readonly id: string;
  readonly startedAt: string;
  readonly notebookPath: string;
  readonly jsonlFile: string;
  /** 追加一行事件（同 SessionLogger.append 语义），返回落盘事件。 */
  append(event: SessionEventInput): SessionEvent;
}

export interface BeginSessionOptions {
  notebookDir: string;
  notebookPath: string;
  cellCount: number;
}

/** startedAt → 文件名安全且按时间可排序的 id：s-20261006T134502-a1b2。 */
export function makeSessionId(startedAt: Date, rand: () => string = () => randomBytes(2).toString('hex')): string {
  const compact = startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
  return `s-${compact}-${rand()}`;
}

export class SessionStore {
  constructor(private readonly clock: () => Date = () => new Date()) {}

  /** notebook 目录 → sessions 目录。 */
  static dirFor(notebookDir: string): string {
    return path.join(notebookDir, '.novalab', 'sessions');
  }

  // ---------- 生命周期 ----------

  /** 开新会话：建目录、写 index 条目（live：无 endedAt）、创建空 jsonl。 */
  begin(opts: BeginSessionOptions): ActiveSession {
    const dir = SessionStore.dirFor(opts.notebookDir);
    mkdirSync(dir, { recursive: true });
    const startedAt = this.clock();
    const id = makeSessionId(startedAt);
    const meta: SessionMeta = {
      id,
      startedAt: startedAt.toISOString(),
      cellCount: opts.cellCount,
      source: 'local',
    };
    const index = this.readIndex(dir);
    index.push(meta);
    this.writeIndex(dir, index);
    const jsonlFile = path.join(dir, `${id}.jsonl`);
    writeFileSync(jsonlFile, '', 'utf8');

    const startedAtIso = meta.startedAt;
    const notebookPath = opts.notebookPath;
    const clock = this.clock;
    return {
      id,
      startedAt: startedAtIso,
      notebookPath,
      jsonlFile,
      append(event: SessionEventInput): SessionEvent {
        const full: SessionEvent = {
          ts: event.ts ?? clock().toISOString(),
          kind: event.kind,
          actor: event.actor ?? 'user',
          ...(event.cellId !== undefined ? { cellId: event.cellId } : {}),
          ...(event.payloadRef !== undefined ? { payloadRef: event.payloadRef } : {}),
        };
        appendFileSync(jsonlFile, JSON.stringify(full) + '\n', 'utf8');
        return full;
      },
    };
  }

  /**
   * 结束会话：写 `<id>.snapshot.json`（cells 全量 + 输出摘要 + endReason）并补
   * index 的 endedAt/cellCount。index 中找不到条目（外部损坏）时兜底追加完整元数据。
   */
  end(
    session: ActiveSession,
    cells: SessionSnapshotCell[],
    reason?: SessionEndReason,
  ): SessionMeta {
    const dir = path.dirname(session.jsonlFile);
    const endedAt = this.clock().toISOString();
    const snapshot: SessionSnapshot = {
      sessionId: session.id,
      notebookPath: session.notebookPath,
      startedAt: session.startedAt,
      endedAt,
      ...(reason ? { endReason: reason } : {}),
      cells,
    };
    writeFileSync(path.join(dir, `${session.id}.snapshot.json`), JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

    const index = this.readIndex(dir);
    let meta = index.find((m) => m.id === session.id);
    if (!meta) {
      meta = { id: session.id, startedAt: session.startedAt, cellCount: cells.length, source: 'local' };
      index.push(meta);
    }
    meta.endedAt = endedAt;
    meta.cellCount = cells.length;
    this.writeIndex(dir, index);
    return { ...meta };
  }

  // ---------- 查询 ----------

  /** index.json 全量（时间序 = begin 顺序）；缺失/损坏 → []。 */
  list(notebookDir: string): SessionMeta[] {
    return this.readIndex(SessionStore.dirFor(notebookDir));
  }

  /**
   * 读已结束会话的快照 + 事件流。未结束（无 snapshot 文件）或未知 id → null，
   * live 会话的只读投影由 router 用内存缓存兜底。id 做文件名白名单校验。
   */
  open(
    notebookDir: string,
    sessionId: string,
  ): { meta: SessionMeta; snapshot: SessionSnapshot; events: SessionEvent[] } | null {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
    const dir = SessionStore.dirFor(notebookDir);
    let snapshot: SessionSnapshot;
    try {
      snapshot = JSON.parse(readFileSync(path.join(dir, `${sessionId}.snapshot.json`), 'utf8')) as SessionSnapshot;
    } catch {
      return null; // 未结束或不存在
    }
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.cells)) return null;
    const meta =
      this.readIndex(dir).find((m) => m.id === sessionId) ?? {
        id: sessionId,
        startedAt: snapshot.startedAt ?? new Date(0).toISOString(),
        ...(snapshot.endedAt ? { endedAt: snapshot.endedAt } : {}),
        cellCount: snapshot.cells.length,
        source: 'local' as const,
      };
    return { meta, snapshot, events: this.readEvents(notebookDir, sessionId) };
  }

  /** 读一个会话的事件流（jsonl 宽容解析：坏行跳过）。 */
  readEvents(notebookDir: string, sessionId: string): SessionEvent[] {
    const file = path.join(SessionStore.dirFor(notebookDir), `${sessionId}.jsonl`);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out: SessionEvent[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as SessionEvent);
      } catch {
        /* 半行（崩溃时写坏）跳过 */
      }
    }
    return out;
  }

  /** sessions 目录里全部 jsonl 的会话 id（index 损坏时的兜底重建源）。 */
  scanIds(notebookDir: string): string[] {
    try {
      return readdirSync(SessionStore.dirFor(notebookDir))
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.slice(0, -'.jsonl'.length))
        .sort();
    } catch {
      return [];
    }
  }

  // ---------- index.json ----------

  private readIndex(dir: string): SessionMeta[] {
    try {
      const raw = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
      if (!Array.isArray(raw)) return [];
      const out: SessionMeta[] = [];
      for (const e of raw) {
        if (!e || typeof e !== 'object') continue;
        const r = e as Record<string, unknown>;
        if (typeof r['id'] !== 'string' || typeof r['startedAt'] !== 'string') continue;
        out.push({
          id: r['id'],
          startedAt: r['startedAt'],
          ...(typeof r['endedAt'] === 'string' ? { endedAt: r['endedAt'] } : {}),
          cellCount: typeof r['cellCount'] === 'number' ? r['cellCount'] : 0,
          source: r['source'] === 'agent' ? 'agent' : 'local',
        });
      }
      return out;
    } catch {
      return []; // 缺失/损坏 → 空（UI 状态不值得崩 RPC）
    }
  }

  private writeIndex(dir: string, index: SessionMeta[]): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
  }
}
