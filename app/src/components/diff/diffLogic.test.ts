import { beforeEach, describe, expect, it, vi } from 'vitest';

/* bridge 客户端整体 mock：store 的 diff.* rpc 全部走这里（P2.3 单测不连真 bridge）。
   路径按本测试文件解析到同一模块 id，store/notebook.ts 的 import 同样被替换。 */
vi.mock('../../bridge/client', () => ({
  bridge: {
    connect: vi.fn(async () => {}),
    onNotification: vi.fn(() => () => {}),
    rpc: vi.fn(async () => ({})),
  },
}));

import { bridge } from '../../bridge/client';
import {
  chunkRevertChange,
  downstreamCells,
  mergeDiffMarks,
  normalizeDiffs,
  pendingDiffs,
  resolveCascadeDecision,
  trayKeyAction,
  useNotebook,
  TRAY_ESC_DOUBLE_MS,
  type DiffMarks,
} from '../../store/notebook';
import type { Cell, DagEdge, StagedDiff } from '../../kernel/types';
import type { StaleContext } from '../../kernel/stalePolicy';

const rpcMock = vi.mocked(bridge.rpc);

function makeCell(over: Partial<Cell> = {}): Cell {
  return {
    id: 'a',
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

function makeDiff(over: Partial<StagedDiff> = {}): StagedDiff {
  return {
    id: 'd1',
    targetCellId: 'a',
    action: 'update',
    newCode: 'x = 2',
    origin: 'agent',
    state: 'proposed',
    ...over,
  };
}

const ctx: StaleContext = { downstream: [], lastRunMs: 0, triggeredBy: 'user-run' };

/* ------------------------------------------------------------------ */

describe('normalizeDiffs（bridge 冻结契约字段）', () => {
  it('id 取 bridge 的 diffId 字段（兼容 id 别名），status→state 映射', () => {
    const diffs = normalizeDiffs({
      diffs: [
        { diffId: 'diff-1', targetCellId: 'a', action: 'update', newCode: 'x', status: 'proposed' },
        { id: 'diff-2', targetCellId: 'b', action: 'insert_below', newCode: 'y', status: 'accepted' },
      ],
    });
    expect(diffs.map((d) => d.id)).toEqual(['diff-1', 'diff-2']);
    expect(diffs.map((d) => d.state)).toEqual(['proposed', 'accepted']);
    expect(diffs[1]!.action).toBe('insert_below');
  });
});

describe('mergeDiffMarks（spec §9：本地 edited-staged/user 标记 × bridge 收敛真源）', () => {
  const marks: DiffMarks = {
    d1: { origin: 'user', state: 'edited-staged' },
    gone: { origin: 'user' },
  };

  it('proposed 被 mark 提升为 edited-staged 并标注 origin=user', () => {
    const { diffs } = mergeDiffMarks([makeDiff({ id: 'd1' })], marks);
    expect(diffs[0]!.state).toBe('edited-staged');
    expect(diffs[0]!.origin).toBe('user');
  });

  it('bridge 回 accepted/rejected 时覆盖本地 mark（以通知为准收敛）', () => {
    const { diffs, marks: nextMarks } = mergeDiffMarks(
      [makeDiff({ id: 'd1', state: 'accepted' }), makeDiff({ id: 'd2', state: 'rejected' })],
      { d1: marks.gone!, d2: { origin: 'user', state: 'edited-staged' } },
    );
    expect(diffs.map((d) => d.state)).toEqual(['accepted', 'rejected']);
    expect(diffs[0]!.origin).toBe('agent'); // 终结态不吃 mark
    expect(nextMarks).toEqual({}); // 终结 id 的 mark 被剪除
  });

  it('不在载荷中的 mark 被剪除（防泄漏）', () => {
    const { marks: nextMarks } = mergeDiffMarks([], marks);
    expect(nextMarks).toEqual({});
  });
});

describe('pendingDiffs（审阅队列过滤）', () => {
  it('保留 proposed/edited-staged、滤除 accepted/rejected，维持队列序', () => {
    const queue = pendingDiffs([
      makeDiff({ id: 'd1', state: 'accepted' }),
      makeDiff({ id: 'd2', state: 'edited-staged' }),
      makeDiff({ id: 'd3', state: 'rejected' }),
      makeDiff({ id: 'd4', state: 'proposed' }),
    ]);
    expect(queue.map((d) => d.id)).toEqual(['d2', 'd4']);
  });
});

describe('downstreamCells（DAG 传递下游，拓扑序=文档序）', () => {
  const cells = [
    makeCell({ id: 'a' }),
    makeCell({ id: 'b' }),
    makeCell({ id: 'c' }),
    makeCell({ id: 'd' }), // 无关 cell
  ];
  const edges: DagEdge[] = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'a', to: 'c' },
  ];

  it('多级传递闭包按文档序返回、不含自身与无关 cell', () => {
    expect(downstreamCells('a', edges, cells).map((c) => c.id)).toEqual(['b', 'c']);
    expect(downstreamCells('b', edges, cells).map((c) => c.id)).toEqual(['c']);
    expect(downstreamCells('c', edges, cells)).toEqual([]);
    expect(downstreamCells('d', edges, cells)).toEqual([]);
  });

  it('环不致死循环（seen 集合去重）', () => {
    const cyclic: DagEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ];
    expect(downstreamCells('a', cyclic, cells).map((c) => c.id)).toEqual(['b']);
  });
});

describe('resolveCascadeDecision（P2.4：override ?? decideStalePolicy）', () => {
  it('policy → 交给 stalePolicy 裁决（Owner 冻结实现恒 mark-only）', () => {
    expect(resolveCascadeDecision('policy', ctx)).toBe('mark-only');
  });

  it('auto/mark-only/ask 直通映射，不受 ctx 影响', () => {
    expect(resolveCascadeDecision('auto', ctx)).toBe('auto-cascade');
    expect(resolveCascadeDecision('mark-only', ctx)).toBe('mark-only');
    expect(resolveCascadeDecision('ask', ctx)).toBe('ask');
  });
});

describe('trayKeyAction（Tab/Esc 队列纯逻辑）', () => {
  it('Tab → 采纳队首，不动 Esc 双击窗口', () => {
    const r = trayKeyAction('Tab', { now: 5000, lastEscAt: 4900 });
    expect(r).toEqual({ action: 'accept-head', nextEscAt: 4900 });
  });

  it('首次 Esc → 拒绝队首并武装双击窗口', () => {
    const r = trayKeyAction('Escape', { now: 1000, lastEscAt: null });
    expect(r).toEqual({ action: 'reject-head', nextEscAt: 1000 });
  });

  it('窗口内（≤300ms）第二次 Esc → 全拒并复位窗口', () => {
    const r = trayKeyAction('Escape', {
      now: 1000 + TRAY_ESC_DOUBLE_MS,
      lastEscAt: 1000,
    });
    expect(r).toEqual({ action: 'reject-all', nextEscAt: null });
  });

  it('窗口外第二次 Esc → 仍是拒绝队首（重新武装）', () => {
    const r = trayKeyAction('Escape', {
      now: 1000 + TRAY_ESC_DOUBLE_MS + 1,
      lastEscAt: 1000,
    });
    expect(r).toEqual({ action: 'reject-head', nextEscAt: 1000 + TRAY_ESC_DOUBLE_MS + 1 });
  });

  it('其他键不动作、不重置窗口', () => {
    const r = trayKeyAction('a', { now: 9999, lastEscAt: 1000 });
    expect(r).toEqual({ action: null, nextEscAt: 1000 });
  });
});

describe('chunkRevertChange（hunk 级 × 的 change spec）', () => {
  it('替换型 chunk：B 区间换回 A 文本', () => {
    const c = chunkRevertChange('hello world', { fromA: 0, toA: 5, fromB: 0, toB: 3 });
    expect(c).toEqual({ from: 0, to: 3, insert: 'hello' });
  });

  it('B 侧新增 chunk（fromA=toA）：删除 B 区间', () => {
    const c = chunkRevertChange('abc', { fromA: 3, toA: 3, fromB: 3, toB: 9 });
    expect(c).toEqual({ from: 3, to: 9, insert: '' });
  });

  it('toA 越过 A 文档末尾（merge 契约：末行 chunk）被钳制', () => {
    const c = chunkRevertChange('abc', { fromA: 1, toA: 999, fromB: 1, toB: 5 });
    expect(c).toEqual({ from: 1, to: 5, insert: 'bc' });
  });
});

/* ------------------------------------------------------------------ */
/* store 集成（mock rpc）：乐观更新 → bridge 通知收敛                     */
/* ------------------------------------------------------------------ */

describe('store diff 切片（acceptDiff / rejectAllPending，mock bridge）', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({});
    useNotebook.setState({
      cells: [makeCell({ id: 'a' }), makeCell({ id: 'b', code: 'y = x + 1', refs: ['x'] })],
      dagEdges: [{ from: 'a', to: 'b' }],
      staleSet: [],
      diffs: [],
      diffMarks: {},
      cascadeOverride: 'policy',
      lastRunMs: { a: 120 },
      cascadeAsk: null,
      compileErrors: {},
    });
  });

  it('acceptDiff：乐观置 accepted 离开队列；rpc 后落 newCode/stale（mark-only 不补跑）', async () => {
    useNotebook.setState({ diffs: [makeDiff({ id: 'd1', newCode: 'x = 2' })] });
    rpcMock.mockResolvedValue({
      diffId: 'd1',
      dagEdges: [{ from: 'a', to: 'b' }],
      staleSet: ['b'],
      run: { cellId: 'a', ok: true, durationMs: 10 },
    });

    const p = useNotebook.getState().acceptDiff('d1');
    // 乐观更新在首个 await 前同步生效
    expect(useNotebook.getState().diffs[0]!.state).toBe('accepted');
    expect(pendingDiffs(useNotebook.getState().diffs)).toHaveLength(0);
    await p;

    expect(rpcMock).toHaveBeenCalledWith('diff.accept', { diffId: 'd1' });
    const s = useNotebook.getState();
    expect(s.cells.find((c) => c.id === 'a')!.code).toBe('x = 2'); // update 本地同步
    expect(s.cells.find((c) => c.id === 'b')!.status).toBe('stale'); // staleSet 落地
    expect(rpcMock).toHaveBeenCalledTimes(1); // policy→mark-only：不级联补跑
  });

  it('acceptDiff：auto 档 → 前端按拓扑序补跑 stale 下游', async () => {
    useNotebook.setState({
      diffs: [makeDiff({ id: 'd1', newCode: 'x = 2' })],
      cascadeOverride: 'auto',
    });
    rpcMock.mockResolvedValue({
      diffId: 'd1',
      dagEdges: [{ from: 'a', to: 'b' }],
      staleSet: ['b'],
      run: { cellId: 'a', ok: true, durationMs: 10 },
    });
    await useNotebook.getState().acceptDiff('d1');
    expect(rpcMock).toHaveBeenCalledWith('cell.run', { cellId: 'b', cascade: false });
  });

  it('acceptDiff：bridge 的 diff.updated（accepted）为收敛真源', async () => {
    useNotebook.setState({ diffs: [makeDiff({ id: 'd1' })] });
    rpcMock.mockResolvedValue({ diffId: 'd1', dagEdges: [], staleSet: [] });
    await useNotebook.getState().acceptDiff('d1');
    // 模拟通知到达：normalizeDiffs + mergeDiffMarks（connectBridge 里同款逻辑）
    const merged = mergeDiffMarks(
      normalizeDiffs({
        diffs: [{ diffId: 'd1', targetCellId: 'a', action: 'update', newCode: 'x = 2', status: 'accepted' }],
      }),
      useNotebook.getState().diffMarks,
    );
    useNotebook.setState({ diffs: merged.diffs, diffMarks: merged.marks });
    const s = useNotebook.getState();
    expect(s.diffs[0]!.state).toBe('accepted');
    expect(pendingDiffs(s.diffs)).toHaveLength(0);
  });

  it('rejectAllPending：整批乐观出队 + 每条一发 diff.reject', async () => {
    useNotebook.setState({
      diffs: [
        makeDiff({ id: 'd1' }),
        makeDiff({ id: 'd2', state: 'edited-staged', origin: 'user' }),
        makeDiff({ id: 'd0', state: 'accepted' }), // 已终结的不重发
      ],
    });
    await useNotebook.getState().rejectAllPending();
    expect(pendingDiffs(useNotebook.getState().diffs)).toHaveLength(0);
    const rejectCalls = rpcMock.mock.calls.filter(([m]) => m === 'diff.reject');
    expect(rejectCalls.map(([, p]) => (p as { diffId: string }).diffId).sort()).toEqual([
      'd1',
      'd2',
    ]);
  });
});
