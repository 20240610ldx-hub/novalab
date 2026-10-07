/**
 * SessionModal 纯 UI selector（P3.4；无 DOM/网络依赖，selectors.test.ts 覆盖）。
 * segments 语义在 store/session.ts buildSegments（会话即 segment，>30min 间隔切子段）。
 */

import { sessionName, type SessionSegment, type SessionSnapshotCell } from '../../store/session';

/** 只读精简行的状态点：error（红）/ 有输出（绿）/ 无输出（灰）。 */
export type DotKind = 'error' | 'output' | 'idle';

export const DOT_COLOR: Record<DotKind, string> = {
  error: 'var(--accent-err)',
  output: 'var(--accent-ok)',
  idle: 'var(--muted)',
};

export function statusDot(cell: SessionSnapshotCell): DotKind {
  const o = cell.output;
  if (!o) return 'idle';
  if (o.traceback) return 'error';
  const hasOutput =
    o.stdout !== '' || o.stderr !== '' || (o.writes?.length ?? 0) > 0 || (o.mimeKeys?.length ?? 0) > 0;
  return hasOutput ? 'output' : 'idle';
}

/** cell 代码首行（第一个非空白行，trim）；全空 → ''。 */
export function firstLine(code: string): string {
  for (const l of (code ?? '').split('\n')) {
    if (l.trim() !== '') return l.trim();
  }
  return '';
}

/** 只读精简行文案：`[n] <首行代码>`（1-based；空 cell 占位）。 */
export function cellRowLabel(index: number, code: string): string {
  const head = firstLine(code);
  return `[${index + 1}] ${head === '' ? '(空 cell)' : head}`;
}

/** ISO → `YYYY-MM-DD HH:MM`（本地时区）；坏值回退原文。 */
export function segmentTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : sessionName(d);
}

/** 会话段 header：`SESSION <startedAt> · N cells · read-only?`（+ 子段注记）。 */
export function sessionHeaderText(seg: SessionSegment): string {
  const base = `SESSION ${segmentTime(seg.startedAt)} · ${seg.cellCount} cells · ${seg.live ? 'live' : 'read-only'}`;
  return seg.parts > 1 ? `${base} · ${seg.parts} sub-segments (>30min gap)` : base;
}

/** modal 头部计数文案：`N sessions · M cells`。 */
export function summaryLabel(sessionCount: number, cellCount: number): string {
  return `${sessionCount} sessions · ${cellCount} cells`;
}
