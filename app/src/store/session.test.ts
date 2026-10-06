/**
 * store/session 单测（P2.8）：只读禁用矩阵、横幅阈值、时间标签、
 * 快照 cell 映射、session.list 归一化、notebook store 写路径护栏、
 * session.started/ended reducer。纯 node 环境（无 DOM/网络；bridge 未连接时
 * rpc reject 是护栏放行测试的预期路径）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Cell } from '../kernel/types';
import { useNotebook } from './notebook';
import {
  SESSION_CELL_LIMIT,
  capabilityMatrix,
  endedLabel,
  normalizeSessionMetas,
  sessionName,
  snapshotToCells,
  truncationBanner,
  truncateHistory,
  useSession,
  viewOnlyFooter,
  type SessionSnapshotCell,
} from './session';

function mkCell(id: string, code = `# ${id}`): Cell {
  return {
    id,
    code,
    execCount: null,
    status: 'idle',
    defs: [],
    refs: [],
    sideEffect: false,
    kind: 'code',
    output: null,
  };
}

function snapCell(id: string, over: Partial<SessionSnapshotCell['output']> = {}): SessionSnapshotCell {
  return {
    id,
    code: `x = 1 # ${id}`,
    execCount: 1,
    defs: ['x'],
    refs: [],
    output: { stdout: '', stderr: '', traceback: null, mimeKeys: [], writes: [], ...over },
  };
}

beforeEach(() => {
  useNotebook.setState({
    cells: [mkCell('a')],
    dagEdges: [],
    staleSet: [],
    compileErrors: {},
    diffs: [],
    kernelState: 'live',
    activeCellId: 'a',
  });
  useSession.setState({
    readOnly: false,
    viewingId: null,
    viewingEndedAt: null,
    historyTotal: 0,
    currentId: null,
    currentStartedAt: null,
    currentEndedAt: null,
    sessions: [],
  });
});

describe('只读禁用矩阵（A-2 #12）', () => {
  it('readOnly=false → 全部能力开启', () => {
    const m = capabilityMatrix(false);
    expect(m).toEqual({
      editorReadOnly: false,
      runDisabled: false,
      replDisabled: false,
      diffDisabled: false,
      restartDisabled: false,
      viewOnly: false,
    });
  });

  it('readOnly=true → 编辑器/运行/REPL/diff/restart 全禁用 + viewOnly', () => {
    const m = capabilityMatrix(true);
    expect(m).toEqual({
      editorReadOnly: true,
      runDisabled: true,
      replDisabled: true,
      diffDisabled: true,
      restartDisabled: true,
      viewOnly: true,
    });
  });

  it('护栏：readOnly 下 setCellCode / runCell 全部 no-op', async () => {
    useSession.setState({ readOnly: true });
    useNotebook.getState().setCellCode('a', 'zzz');
    expect(useNotebook.getState().cells[0]!.code).toBe('# a');
    await useNotebook.getState().runCell('a');
    expect(useNotebook.getState().cells[0]!.status).toBe('idle');
    await useNotebook.getState().runRepl('1+1');
    expect(useNotebook.getState().cells.some((c) => c.id === 'repl')).toBe(false);
  });

  it('护栏：readOnly 下 applyNotebookState（热重载广播）不冲掉历史视图', () => {
    useSession.setState({ readOnly: true });
    useNotebook.getState().applyNotebookState({
      cells: [{ id: 'h1', code: 'reload' }],
      dagEdges: [],
      schemas: [],
      staleSet: [],
      execCounts: {},
    });
    expect(useNotebook.getState().cells.map((c) => c.id)).toEqual(['a']);

    useSession.setState({ readOnly: false });
    useNotebook.getState().applyNotebookState({
      cells: [{ id: 'h1', code: 'reload' }],
      dagEdges: [],
      schemas: [],
      staleSet: [],
      execCounts: {},
    });
    expect(useNotebook.getState().cells.map((c) => c.id)).toEqual(['h1']);
  });

  it('护栏放行：readOnly=false 时 runCell 到达 bridge（未连接 → error 态）', async () => {
    useSession.setState({ readOnly: false });
    await useNotebook.getState().runCell('a');
    // bridge 未连接：rpc reject → runCell catch 置 error（证明未被护栏拦截）
    expect(useNotebook.getState().cells[0]!.status).toBe('error');
  });
});

describe('横幅阈值与截断（A-2 #14）', () => {
  it('total ≤ 500 → 无横幅；> 500 → 原文横幅', () => {
    expect(truncationBanner(SESSION_CELL_LIMIT)).toBeNull();
    expect(truncationBanner(0)).toBeNull();
    expect(truncationBanner(SESSION_CELL_LIMIT + 1)).toBe(
      "First 500 cells shown — full log in the session notebook's .ipynb download",
    );
  });

  it('truncateHistory：501 → shown 500 / truncated / total；≤500 原样', () => {
    const cells = Array.from({ length: 501 }, (_, i) => i);
    const r = truncateHistory(cells);
    expect(r.shown).toHaveLength(500);
    expect(r.shown[0]).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(501);

    const small = truncateHistory([1, 2]);
    expect(small.shown).toEqual([1, 2]);
    expect(small.truncated).toBe(false);
    expect(small.total).toBe(2);
  });
});

describe('时间标签（A-2 #12/#13：名称=startedAt、Ended HH:MM）', () => {
  const d = new Date(2026, 9, 6, 15, 4); // 本地时区构造，测试与 TZ 无关

  it('sessionName = YYYY-MM-DD HH:MM', () => {
    expect(sessionName(d)).toBe('2026-10-06 15:04');
  });

  it('endedLabel = Ended HH:MM', () => {
    expect(endedLabel(d)).toBe('Ended 15:04');
  });

  it('viewOnlyFooter 为 spec 原文', () => {
    expect(viewOnlyFooter(d)).toBe(
      "Python · ended 15:04 — view only; this kernel's namespace no longer exists",
    );
  });
});

describe('快照映射与载荷归一化', () => {
  it('snapshotToCells：execCount/输出摘要/error 态映射', () => {
    const cells = snapshotToCells([
      snapCell('c1', { stdout: 'out\n' }),
      snapCell('c2', { traceback: 'Traceback …' }),
      { ...snapCell('c3'), execCount: 0 },
    ]);
    expect(cells[0]).toMatchObject({ id: 'c1', status: 'idle', execCount: 1 });
    expect(cells[0]!.output).toMatchObject({ stdout: 'out\n', stderr: '', mime: {}, traceback: null });
    expect(cells[1]!.status).toBe('error');
    expect(cells[1]!.output?.traceback?.text).toBe('Traceback …');
    expect(cells[2]!.execCount).toBeNull();
    expect(cells[2]!.output).toBeNull(); // 无任何输出 → null（不渲染 disclosure）
  });

  it('normalizeSessionMetas：坏条目丢弃、endedAt/source 归一', () => {
    const metas = normalizeSessionMetas([
      { id: 's1', startedAt: 'A', cellCount: 3, source: 'local' },
      { id: 's2', startedAt: 'B', endedAt: 'C', cellCount: 4, source: 'agent' },
      { startedAt: 'no-id' },
      null,
      { id: 's3', startedAt: 'D' }, // cellCount/source 缺省
    ]);
    expect(metas).toEqual([
      { id: 's1', startedAt: 'A', cellCount: 3, source: 'local' },
      { id: 's2', startedAt: 'B', endedAt: 'C', cellCount: 4, source: 'agent' },
      { id: 's3', startedAt: 'D', cellCount: 0, source: 'local' },
    ]);
    expect(normalizeSessionMetas('nope')).toEqual([]);
  });

  it('onStarted/onEnded：current 会话与 Ended pill 状态机', () => {
    const s = useSession.getState();
    s.onStarted({ sessionId: 's1', startedAt: '2026-10-06T15:04:00.000Z', notebookPath: 'x.py' });
    expect(useSession.getState().currentId).toBe('s1');
    expect(useSession.getState().currentEndedAt).toBeNull();

    useSession.getState().onEnded({ sessionId: 'other', endedAt: 'X' });
    expect(useSession.getState().currentEndedAt).toBeNull(); // 非当前会话不影响 pill

    useSession.getState().onEnded({ sessionId: 's1', endedAt: '2026-10-06T15:30:00.000Z' });
    expect(useSession.getState().currentEndedAt).toBe('2026-10-06T15:30:00.000Z');

    useSession.getState().onStarted({ sessionId: 's2', startedAt: '2026-10-06T15:31:00.000Z' });
    expect(useSession.getState().currentId).toBe('s2');
    expect(useSession.getState().currentEndedAt).toBeNull(); // 新会话 → 回 live
  });
});
