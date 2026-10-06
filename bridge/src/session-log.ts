/**
 * SessionLogger —— `.novalab/session.jsonl` 追加式事件日志（spec §4/§11, ADR-002）。
 *
 * 每行一个 JSON 对象：{ts, kind, actor, cellId, payloadRef}。
 * 同步追加（appendFileSync）：事件频率低（人速），换取崩溃时审计连续。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type SessionEventKind =
  | 'run'
  | 'error'
  | 'diff_proposed'
  | 'diff_accepted'
  | 'diff_rejected'
  | 'repl'
  /** NovaLab 增补（超出 spec §11 清单）：用户直接保存 cell 的留痕。 */
  | 'save';

export type SessionActor = 'user' | 'agent';

export interface SessionEvent {
  ts: string;
  kind: SessionEventKind;
  actor: SessionActor;
  cellId?: string;
  payloadRef?: string;
}

export type SessionEventInput = Omit<SessionEvent, 'ts' | 'actor'> & {
  ts?: string;
  actor?: SessionActor;
};

export class SessionLogger {
  readonly file: string;

  constructor(
    notebookDir: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    const dir = path.join(notebookDir, '.novalab');
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'session.jsonl');
  }

  /** 追加一行事件，返回落盘的完整事件（含 ts）。 */
  append(event: SessionEventInput): SessionEvent {
    const full: SessionEvent = {
      ts: event.ts ?? this.clock().toISOString(),
      kind: event.kind,
      actor: event.actor ?? 'user',
      ...(event.cellId !== undefined ? { cellId: event.cellId } : {}),
      ...(event.payloadRef !== undefined ? { payloadRef: event.payloadRef } : {}),
    };
    appendFileSync(this.file, JSON.stringify(full) + '\n', 'utf8');
    return full;
  }
}
