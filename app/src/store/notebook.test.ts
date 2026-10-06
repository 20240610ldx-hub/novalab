import { describe, expect, it } from 'vitest';
import {
  applyRunEvent,
  applyStaleSet,
  mapKernelState,
  normalizeCells,
  normalizeDiffs,
  upsertReplCell,
} from './notebook';
import { createEmptyOutput, type Cell } from '../kernel/types';

function makeCell(over: Partial<Cell> = {}): Cell {
  return {
    id: 'c1',
    code: 'x = 1',
    execCount: null,
    status: 'idle',
    defs: ['x'],
    refs: [],
    sideEffect: false,
    kind: 'code',
    output: null,
    ...over,
  };
}

describe('applyRunEvent（run.* 通知 reducer）', () => {
  it('run.started 置 running 并清空旧输出', () => {
    const old: Cell = makeCell({ output: { ...createEmptyOutput(), stdout: 'old' } });
    const next = applyRunEvent([old], 'run.started', { cellId: 'c1' });
    expect(next[0]!.status).toBe('running');
    expect(next[0]!.output?.stdout).toBe('');
  });

  it('run.stdout / run.stderr 增量追加', () => {
    let cells = applyRunEvent([makeCell()], 'run.started', { cellId: 'c1' });
    cells = applyRunEvent(cells, 'run.stdout', { cellId: 'c1', text: 'a' });
    cells = applyRunEvent(cells, 'run.stdout', { cellId: 'c1', text: 'b' });
    cells = applyRunEvent(cells, 'run.stderr', { cellId: 'c1', text: 'warn' });
    expect(cells[0]!.output?.stdout).toBe('ab');
    expect(cells[0]!.output?.stderr).toBe('warn');
  });

  it('run.mime 写入 bundle（单条与整包两种形态）', () => {
    let cells = applyRunEvent([makeCell()], 'run.mime', {
      cellId: 'c1',
      mime: 'text/plain',
      data: '42',
    });
    cells = applyRunEvent(cells, 'run.mime', {
      cellId: 'c1',
      bundle: { 'image/png': 'iVBOR...' },
    });
    expect(cells[0]!.output?.mime['text/plain']).toBe('42');
    expect(cells[0]!.output?.mime['image/png']).toBe('iVBOR...');
  });

  it('run.done 落 execCount 并回到 idle（error 不被覆盖）', () => {
    const ok = applyRunEvent(
      [makeCell({ status: 'running' })],
      'run.done',
      { cellId: 'c1', execCount: 42, cascaded: [], durationMs: 5 },
    );
    expect(ok[0]!.status).toBe('idle');
    expect(ok[0]!.execCount).toBe(42);

    const err = applyRunEvent(
      [makeCell({ status: 'error' })],
      'run.done',
      { cellId: 'c1', execCount: 43 },
    );
    expect(err[0]!.status).toBe('error');
  });

  it('run.error 存结构化 traceback（frames 归一化）', () => {
    const cells = applyRunEvent([makeCell({ status: 'running' })], 'run.error', {
      cellId: 'c1',
      traceback: 'KeyError: foo',
      frames: [{ file: 'demo.py', line: 12, fn: '<module>', srcLine: "df['foo']" }],
    });
    expect(cells[0]!.status).toBe('error');
    expect(cells[0]!.output?.traceback?.text).toBe('KeyError: foo');
    expect(cells[0]!.output?.traceback?.frames[0]).toEqual({
      file: 'demo.py',
      line: 12,
      fn: '<module>',
      srcLine: "df['foo']",
    });
  });

  it('未知 cellId / 未知方法不改动列表', () => {
    const cells = [makeCell()];
    expect(applyRunEvent(cells, 'run.stdout', { cellId: 'nope', text: 'x' })).toEqual(cells);
    expect(applyRunEvent(cells, 'run.weird', { cellId: 'c1' })).toEqual(cells);
  });
});

describe('applyStaleSet（stale 徽章派生）', () => {
  it('集合内 idle cell 标 stale，集合外 stale 恢复 idle', () => {
    const cells = [
      makeCell({ id: 'a' }),
      makeCell({ id: 'b', status: 'stale' }),
      makeCell({ id: 'c' }),
    ];
    const next = applyStaleSet(cells, ['a']);
    expect(next.map((c) => c.status)).toEqual(['stale', 'idle', 'idle']);
  });

  it('running / error 状态不被 stale 覆盖', () => {
    const cells = [
      makeCell({ id: 'a', status: 'running' }),
      makeCell({ id: 'b', status: 'error' }),
    ];
    const next = applyStaleSet(cells, ['a', 'b']);
    expect(next.map((c) => c.status)).toEqual(['running', 'error']);
  });
});

describe('mapKernelState / normalizeCells', () => {
  it('kernel.status idle → live，其余直映', () => {
    expect(mapKernelState('idle')).toBe('live');
    expect(mapKernelState('busy')).toBe('busy');
    expect(mapKernelState('dead')).toBe('dead');
    expect(mapKernelState('restarting')).toBe('restarting');
    expect(mapKernelState('???')).toBe('connecting');
  });

  it('normalizeCells 补默认值并应用 execCounts', () => {
    const cells = normalizeCells(
      [{ id: 'a', code: 'x=1' }, { id: 'b' }],
      { a: 3, b: null },
    );
    expect(cells[0]).toMatchObject({ id: 'a', execCount: 3, status: 'idle', kind: 'code' });
    expect(cells[1]!.output).toBeNull();
    expect(cells[1]!.defs).toEqual([]);
  });
});

describe('upsertReplCell（持久 [repl] cell）', () => {
  it('首次运行追加 kind=repl 的持久 cell（id 固定）', () => {
    const next = upsertReplCell([makeCell({ id: 'a' })], 'repl', 'df.head()');
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({
      id: 'repl',
      kind: 'repl',
      status: 'running',
      code: 'df.head()',
    });
  });

  it('后续运行复用同一 cell：清空输出、更新代码、位置不变', () => {
    const seeded: Cell = {
      ...makeCell({ id: 'repl', kind: 'repl' }),
      output: { ...createEmptyOutput(), stdout: 'stale-output' },
      code: 'old',
    };
    const next = upsertReplCell([makeCell({ id: 'a' }), seeded], 'repl', 'new-cmd');
    expect(next).toHaveLength(2);
    expect(next[1]!.id).toBe('repl');
    expect(next[1]!.code).toBe('new-cmd');
    expect(next[1]!.status).toBe('running');
    expect(next[1]!.output?.stdout).toBe(''); // 输出缓冲已清空
  });
});

describe('normalizeDiffs（diff.updated status→state 映射）', () => {
  it('bridge 的 status 字段映射到前端 state，未知值兜底 proposed', () => {
    const diffs = normalizeDiffs({
      diffs: [
        { id: 'd1', targetCellId: 'a', action: 'update', newCode: 'x', status: 'accepted' },
        { id: 'd2', targetCellId: 'b', action: 'insert_below', newCode: 'y', status: 'rejected' },
        { id: 'd3', targetCellId: 'c', action: 'update', newCode: 'z', status: 'weird' },
        { id: 'd4', targetCellId: 'd', action: 'update', newCode: 'w', status: 'proposed' },
      ],
    });
    expect(diffs.map((d) => d.state)).toEqual(['accepted', 'rejected', 'proposed', 'proposed']);
    expect(diffs[1]!.action).toBe('insert_below');
    expect(diffs[0]!.origin).toBe('agent');
  });

  it('非数组/缺省 diffs 返回空数组', () => {
    expect(normalizeDiffs({})).toEqual([]);
    expect(normalizeDiffs(null)).toEqual([]);
  });
});
