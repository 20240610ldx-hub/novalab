/**
 * SessionModal selector 单测（P3.4）：状态点、精简行文案、段 header、
 * 计数文案。纯函数（无 DOM/store 依赖）。
 */

import { describe, expect, it } from 'vitest';
import type { SessionSegment, SessionSnapshotCell } from '../../store/session';
import {
  DOT_COLOR,
  cellRowLabel,
  firstLine,
  segmentTime,
  sessionHeaderText,
  statusDot,
  summaryLabel,
} from './selectors';

function snap(over: Partial<SessionSnapshotCell> = {}, outOver: Partial<SessionSnapshotCell['output']> = {}): SessionSnapshotCell {
  return {
    id: 'c1',
    code: 'x = 1',
    execCount: 1,
    defs: [],
    refs: [],
    output: { stdout: '', stderr: '', traceback: null, mimeKeys: [], writes: [], ...outOver },
    ...over,
  };
}

function seg(over: Partial<SessionSegment> = {}): SessionSegment {
  return {
    sessionId: 's1',
    startedAt: '2026-10-06T15:04:00.000Z',
    endedAt: '2026-10-06T16:00:00.000Z',
    cellCount: 3,
    source: 'local',
    live: false,
    parts: 1,
    partStarts: ['2026-10-06T15:04:00.000Z'],
    ...over,
  };
}

describe('statusDot（只读精简行状态点）', () => {
  it('traceback → error；有输出 → output；空 → idle', () => {
    expect(statusDot(snap({}, { traceback: 'ValueError: x' }))).toBe('error');
    expect(statusDot(snap({}, { stdout: 'hi\n' }))).toBe('output');
    expect(statusDot(snap({}, { writes: ['/tmp/a'] }))).toBe('output');
    expect(statusDot(snap({}, { mimeKeys: ['image/png'] }))).toBe('output');
    expect(statusDot(snap())).toBe('idle');
    expect(DOT_COLOR.error).toBe('var(--accent-err)');
  });
});

describe('精简行文案', () => {
  it('firstLine：首个非空白行 trim；全空 → ""', () => {
    expect(firstLine('\n\nimport pandas as pd\nx = 1')).toBe('import pandas as pd');
    expect(firstLine('   y = 2  \nz')).toBe('y = 2');
    expect(firstLine('\n  \n')).toBe('');
  });

  it('cellRowLabel：[n] 1-based + 首行；空 cell 占位', () => {
    expect(cellRowLabel(0, 'x = 1\ny = 2')).toBe('[1] x = 1');
    expect(cellRowLabel(41, '\n')).toBe('[42] (空 cell)');
  });
});

describe('段 header 与计数', () => {
  it('sessionHeaderText：SESSION <startedAt> · N cells · read-only?（live/子段注记）', () => {
    // 本地时区构造无关：segmentTime 只要求与 sessionName 一致，这里断言结构
    const h = sessionHeaderText(seg());
    expect(h).toMatch(/^SESSION .+ · 3 cells · read-only$/);
    expect(sessionHeaderText(seg({ live: true, endedAt: undefined }))).toMatch(/· live$/);
    expect(sessionHeaderText(seg({ parts: 2 }))).toMatch(/· 2 sub-segments \(>30min gap\)$/);
  });

  it('segmentTime：ISO → 本地 YYYY-MM-DD HH:MM；坏值回退原文', () => {
    const d = new Date(2026, 9, 6, 15, 4);
    expect(segmentTime(d.toISOString())).toBe('2026-10-06 15:04');
    expect(segmentTime('not-a-date')).toBe('not-a-date');
  });

  it('summaryLabel = `N sessions · M cells`', () => {
    expect(summaryLabel(2, 57)).toBe('2 sessions · 57 cells');
    expect(summaryLabel(0, 0)).toBe('0 sessions · 0 cells');
  });
});
