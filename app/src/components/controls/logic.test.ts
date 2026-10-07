/**
 * logic.test.ts — P3.3 控件纯函数单测：clamp / 80ms 节流 coalesce / 乐观更新
 * 回退 reducer / 载荷解析（JSON 串、对象、数组、坏载荷）/ table 选择归一。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clampSlider,
  controlReduce,
  controlVarName,
  createThrottler,
  normalizeSelection,
  parseControlPayload,
  type ControlState,
} from './logic';

describe('clampSlider', () => {
  it('keeps in-range values and clamps out-of-range both ways', () => {
    expect(clampSlider(5, 0, 10)).toBe(5);
    expect(clampSlider(999, 0, 10)).toBe(10);
    expect(clampSlider(-999, 0, 10)).toBe(0);
  });

  it('handles reversed bounds (start > stop)', () => {
    expect(clampSlider(5, 10, 0)).toBe(5);
    expect(clampSlider(15, 10, 0)).toBe(10);
  });

  it('guards non-finite input', () => {
    expect(clampSlider(Number.NaN, 2, 8)).toBe(2);
    expect(clampSlider(Number.POSITIVE_INFINITY, 2, 8)).toBe(8);
    expect(clampSlider(Number.NEGATIVE_INFINITY, 2, 8)).toBe(2);
  });
});

describe('createThrottler (80ms coalesce)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces a drag burst into one send with the latest value', () => {
    const send = vi.fn();
    const t = createThrottler<number>(80, send);
    t.schedule(1);
    t.schedule(3);
    t.schedule(7);
    expect(send).not.toHaveBeenCalled(); // trailing edge：窗口内不发
    vi.advanceTimersByTime(80);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(7);
  });

  it('sends again after the window passes', () => {
    const send = vi.fn();
    const t = createThrottler<number>(80, send);
    t.schedule(1);
    vi.advanceTimersByTime(80);
    t.schedule(2);
    vi.advanceTimersByTime(80);
    expect(send.mock.calls).toEqual([[1], [2]]);
  });

  it('flush sends pending immediately without a duplicate timer send', () => {
    const send = vi.fn();
    const t = createThrottler<number>(80, send);
    t.schedule(4);
    t.flush(); // slider 松手
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(4);
    vi.advanceTimersByTime(200);
    expect(send).toHaveBeenCalledTimes(1); // 不再重复发
    t.flush(); // 无挂起 → 无操作
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('cancel drops the pending value', () => {
    const send = vi.fn();
    const t = createThrottler<number>(80, send);
    t.schedule(4);
    t.cancel();
    vi.advanceTimersByTime(200);
    t.flush();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('controlReduce (乐观更新/回退)', () => {
  const init: ControlState<number> = { value: 0, lastGood: 0, pending: false };

  it('local applies optimistically and keeps lastGood', () => {
    const s = controlReduce(init, { type: 'local', value: 7 });
    expect(s).toEqual({ value: 7, lastGood: 0, pending: true });
  });

  it('ack promotes the optimistic value to lastGood', () => {
    const s = controlReduce(controlReduce(init, { type: 'local', value: 7 }), { type: 'ack' });
    expect(s).toEqual({ value: 7, lastGood: 7, pending: false });
  });

  it('error rolls back to lastGood (bridge 未接线 -32601 降级路径)', () => {
    const acked = controlReduce(init, { type: 'local', value: 5 });
    const s = controlReduce(acked, { type: 'error' });
    expect(s).toEqual({ value: 0, lastGood: 0, pending: false });
    // 成功过一次后再失败 → 回到上次成功值而非初始值
    const s2 = controlReduce(controlReduce(s, { type: 'local', value: 9 }), { type: 'error' });
    expect(s2.value).toBe(0);
    const ackedOnce = controlReduce(
      controlReduce(controlReduce(init, { type: 'local', value: 3 }), { type: 'ack' }),
      { type: 'local', value: 9 },
    );
    expect(controlReduce(ackedOnce, { type: 'error' }).value).toBe(3);
  });

  it('reset syncs both values from a fresh kernel payload', () => {
    const dirty: ControlState<number> = { value: 7, lastGood: 7, pending: false };
    expect(controlReduce(dirty, { type: 'reset', value: 0 })).toEqual({
      value: 0,
      lastGood: 0,
      pending: false,
    });
  });
});

describe('parseControlPayload', () => {
  const payload = { controlId: 'c1::s', kind: 'slider', spec: { start: 0, stop: 10 }, value: 3 };

  it('parses the kernel JSON-string form', () => {
    const got = parseControlPayload(JSON.stringify(payload));
    expect(got).toEqual([payload]);
  });

  it('accepts an already-parsed object and arrays (future multi-control store)', () => {
    expect(parseControlPayload(payload)).toEqual([payload]);
    const got = parseControlPayload([
      payload,
      JSON.stringify({ ...payload, controlId: 'c1::b' }),
    ]);
    expect(got).toHaveLength(2);
  });

  it('drops malformed input without throwing', () => {
    expect(parseControlPayload('not json{')).toEqual([]);
    expect(parseControlPayload(undefined)).toEqual([]);
    expect(parseControlPayload({ kind: 'slider' })).toEqual([]); // 缺 controlId
    expect(parseControlPayload('')).toEqual([]);
  });

  it('dedupes by controlId, last wins (cell 重跑重建覆盖旧值)', () => {
    const got = parseControlPayload([payload, { ...payload, value: 9 }]);
    expect(got).toEqual([{ ...payload, value: 9 }]);
  });

  it('normalizes a missing/invalid spec to {}', () => {
    const got = parseControlPayload({ controlId: 'c1::x', kind: 'text', value: '' });
    expect(got[0]?.spec).toEqual({});
  });
});

describe('normalizeSelection', () => {
  it('filters out-of-range, dedupes, and keeps order', () => {
    expect(normalizeSelection([0, 5, 2, 0], 3, 'multi')).toEqual([0, 2]);
    expect(normalizeSelection(null, 3, 'multi')).toEqual([]);
    expect(normalizeSelection(1, 3, 'multi')).toEqual([1]); // 标量容错
    expect(normalizeSelection(['2', 1.0], 3, 'multi')).toEqual([2, 1]);
  });

  it('single mode keeps only the last valid index', () => {
    expect(normalizeSelection([0, 2], 3, 'single')).toEqual([2]);
  });

  it('mode=null (non-selectable) is always null', () => {
    expect(normalizeSelection([0, 1], 3, null)).toBeNull();
  });
});

describe('controlVarName', () => {
  it('extracts the variable name from controlId', () => {
    expect(controlVarName('c1::s')).toBe('s');
    expect(controlVarName('repl::expr')).toBe('expr');
    expect(controlVarName('plain')).toBe('plain');
  });
});
