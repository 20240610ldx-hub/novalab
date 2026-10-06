import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionLogger, type SessionEvent } from './session-log';

function tmpNotebookDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'novalab-session-'));
}

function readLines(file: string): SessionEvent[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as SessionEvent);
}

describe('SessionLogger', () => {
  it('写到 <notebookDir>/.novalab/session.jsonl（目录不存在则创建）', () => {
    const dir = tmpNotebookDir();
    const logger = new SessionLogger(dir);
    expect(logger.file).toBe(path.join(dir, '.novalab', 'session.jsonl'));
    logger.append({ kind: 'run', cellId: 'a' });
    const lines = readLines(logger.file);
    expect(lines).toHaveLength(1);
  });

  it('每行是 {ts, kind, actor, cellId, payloadRef} JSON，追加不覆盖', () => {
    const logger = new SessionLogger(tmpNotebookDir(), () => new Date('2026-10-06T08:00:00Z'));
    logger.append({ kind: 'run', actor: 'user', cellId: 'a1b2c3', payloadRef: 'exec:1' });
    logger.append({ kind: 'diff_proposed', actor: 'agent', cellId: 'd4e5f6', payloadRef: 'diff-1' });
    logger.append({ kind: 'repl', payloadRef: 'ok:true' });

    const lines = readLines(logger.file);
    expect(lines).toHaveLength(3);

    const [l1, l2, l3] = lines as [SessionEvent, SessionEvent, SessionEvent];
    expect(l1).toEqual({
      ts: '2026-10-06T08:00:00.000Z',
      kind: 'run',
      actor: 'user',
      cellId: 'a1b2c3',
      payloadRef: 'exec:1',
    });
    expect(l2).toEqual({
      ts: '2026-10-06T08:00:00.000Z',
      kind: 'diff_proposed',
      actor: 'agent',
      cellId: 'd4e5f6',
      payloadRef: 'diff-1',
    });
    // actor 默认 user；未提供的可选字段不出现在 JSON 里
    expect(l3).toEqual({ ts: '2026-10-06T08:00:00.000Z', kind: 'repl', actor: 'user', payloadRef: 'ok:true' });
    expect(l3.actor).toBe('user');
    expect(l3).not.toHaveProperty('cellId');
  });

  it('ts 为 ISO-8601；kind 覆盖全部事件类型', () => {
    const logger = new SessionLogger(tmpNotebookDir());
    const kinds = ['run', 'error', 'diff_proposed', 'diff_accepted', 'diff_rejected', 'repl', 'save'] as const;
    for (const kind of kinds) logger.append({ kind });
    const lines = readLines(logger.file);
    expect(lines.map((l) => l.kind)).toEqual([...kinds]);
    for (const l of lines) {
      expect(Number.isNaN(Date.parse(l.ts))).toBe(false);
      expect(new Date(l.ts).toISOString()).toBe(l.ts);
    }
  });
});
