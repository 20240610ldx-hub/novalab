import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyRunEvent,
  applyStaleSet,
  mapKernelState,
  normalizeCells,
  normalizeDiffs,
  upsertReplCell,
  useNotebook,
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

describe('uiCollapsed sidecar（P1.8：hydrateUi / 折叠 action / 热重载保留）', () => {
  beforeEach(() => {
    // 重置为初始状态（notebookPath=null → 折叠/激活变更不会触发 bridge 持久化）
    useNotebook.setState({
      cells: [],
      dagEdges: [],
      staleSet: [],
      schemas: [],
      diffs: [],
      activeCellId: null,
      notebookPath: null,
      compileErrors: {},
      uiCollapsed: {},
    });
  });

  it('hydrateUi 水合折叠集合与 activeCellId，垃圾值被过滤', () => {
    useNotebook.getState().hydrateUi({
      collapsed: { a: true, b: false, junk: 'yes', n: 1 },
      activeCellId: 'b',
    });
    const s = useNotebook.getState();
    expect(s.uiCollapsed).toEqual({ a: true, b: false });
    expect(s.activeCellId).toBe('b');
  });

  it('hydrateUi 损坏/缺省载荷 → 空折叠集合，不抛、不覆盖 activeCellId', () => {
    useNotebook.setState({ activeCellId: 'keep-me', uiCollapsed: { old: true } });
    useNotebook.getState().hydrateUi(null);
    expect(useNotebook.getState().uiCollapsed).toEqual({});
    expect(useNotebook.getState().activeCellId).toBe('keep-me'); // null 不覆盖
    useNotebook.getState().hydrateUi({ collapsed: 'oops', activeCellId: 42 });
    expect(useNotebook.getState().uiCollapsed).toEqual({});
    expect(useNotebook.getState().activeCellId).toBe('keep-me');
  });

  it('setCellCollapsed 合并写 uiCollapsed（OutputDisclosure 切换的 store action）', () => {
    useNotebook.getState().setCellCollapsed('a', true);
    useNotebook.getState().setCellCollapsed('b', false);
    useNotebook.getState().setCellCollapsed('a', false);
    expect(useNotebook.getState().uiCollapsed).toEqual({ a: false, b: false });
  });

  it('热重载全量 notebook.state 不冲掉 uiCollapsed，仍存在的 activeCellId 保留', () => {
    useNotebook.setState({ uiCollapsed: { a: true }, activeCellId: 'b' });
    useNotebook.getState().applyNotebookState({
      cells: [
        { id: 'a', code: 'x = 1' },
        { id: 'b', code: 'y = x + 1' },
      ],
      dagEdges: [{ from: 'a', to: 'b' }],
      schemas: [],
      staleSet: [],
      execCounts: { a: 0, b: 0 },
    });
    const s = useNotebook.getState();
    expect(s.uiCollapsed).toEqual({ a: true }); // 折叠集合原样
    expect(s.activeCellId).toBe('b'); // 不被重置为首 cell
  });

  it('activeCellId 已不在新 cells 中 → 回退首 cell；[repl] cell 照旧保留', () => {
    const repl: Cell = { ...makeCell({ id: 'repl', kind: 'repl' }), output: createEmptyOutput() };
    useNotebook.setState({ cells: [repl], activeCellId: 'ghost', uiCollapsed: { ghost: true } });
    useNotebook.getState().applyNotebookState({
      cells: [{ id: 'n1', code: 'v = 1' }],
      dagEdges: [],
      schemas: [],
      staleSet: [],
      execCounts: { n1: 0 },
    });
    const s = useNotebook.getState();
    expect(s.activeCellId).toBe('n1');
    expect(s.cells.map((c) => c.id)).toEqual(['n1', 'repl']); // 持久 [repl] cell 保留
    expect(s.uiCollapsed).toEqual({ ghost: true }); // uiCollapsed 不随 cells 清理
  });
});

describe('applyRunEvent run.notify（P2.9 缝合：文件写事件 → output.writes）', () => {
  it('file-write 追加、同路径去重、封顶 50、非 file-write 忽略', () => {
    let cells: Cell[] = [{ ...makeCell({ id: 'w' }), output: createEmptyOutput() }];
    cells = applyRunEvent(cells, 'run.notify', { cellId: 'w', kind: 'file-write', path: 'P1' });
    cells = applyRunEvent(cells, 'run.notify', { cellId: 'w', kind: 'file-write', path: 'P1' });
    expect(cells[0]?.output?.writes).toEqual(['P1']);
    for (let i = 0; i < 60; i++) {
      cells = applyRunEvent(cells, 'run.notify', { cellId: 'w', kind: 'file-write', path: `F${i}` });
    }
    expect(cells[0]?.output?.writes.length).toBe(50);
    cells = applyRunEvent(cells, 'run.notify', { cellId: 'w', kind: 'other', path: 'X' });
    expect(cells[0]?.output?.writes.length).toBe(50);
  });
});
