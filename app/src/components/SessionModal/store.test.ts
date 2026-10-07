/**
 * SessionModal store 单测（P3.4）：segments selector（会话即 segment、>30min
 * 子段切分）、modal 开关、快照缓存与截断、export/import actions 的成功路径与
 * -32600/-32601 接线 pending 降级。bridge/client 整体 mock（node 环境无 WS）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock 工厂被提升——rpc 句柄必须经 vi.hoisted 提前创建
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../bridge/client', () => ({
  bridge: {
    rpc,
    connect: vi.fn(async () => {}),
    onNotification: vi.fn(() => () => {}),
  },
  BridgeClient: class {},
}));

import { useNotebook } from '../../store/notebook';
import {
  SEGMENT_GAP_MS,
  buildSegments,
  degradeTransfer,
  idleTransfer,
  isWiringPending,
  modalSummary,
  useSession,
  type SessionMeta,
  type SessionSnapshotCell,
} from '../../store/session';

const NB = 'D:/nb/geo.py';

function meta(id: string, startedAt: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return { id, startedAt, cellCount: 0, source: 'local', ...over };
}

function snapCell(i: number): SessionSnapshotCell {
  return {
    id: `c${i}`,
    code: `x${i} = ${i}`,
    execCount: i + 1,
    defs: [],
    refs: [],
    output: { stdout: '', stderr: '', traceback: null, mimeKeys: [], writes: [] },
  };
}

/** 按 method 分发的默认 mock（未命中 → {}，容忍 openNotebook 链路 ui.get/notebook.list）。 */
function mockDispatch(extra: Record<string, (params: unknown) => unknown> = {}): void {
  rpc.mockImplementation(async (method: string, params?: unknown) => {
    const fn = extra[method];
    if (fn) return fn(params);
    if (method === 'notebook.open') {
      return { notebookId: 'nb1', state: { cells: [], dagEdges: [], schemas: [], staleSet: [], execCounts: {} } };
    }
    if (method === 'session.list') return [];
    return {};
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  rpc.mockReset();
  useNotebook.setState({ notebookPath: NB, cells: [] });
  useSession.setState({
    sessions: [],
    currentId: null,
    currentStartedAt: null,
    currentEndedAt: null,
    readOnly: false,
    viewingId: null,
    viewingEndedAt: null,
    historyTotal: 0,
    modalOpen: false,
    snapshotLoading: {},
    snapshotCells: {},
    snapshotTotals: {},
    exportState: idleTransfer,
    importState: idleTransfer,
  });
});

describe('buildSegments（会话即 segment）', () => {
  it('每会话一段、最新在前、live = 无 endedAt、缺 ts → parts=1', () => {
    const segs = buildSegments([
      meta('s1', '2026-10-06T10:00:00Z', { endedAt: '2026-10-06T11:00:00Z', cellCount: 3 }),
      meta('s2', '2026-10-06T12:00:00Z', { cellCount: 5, source: 'agent' }),
    ]);
    expect(segs.map((s) => s.sessionId)).toEqual(['s2', 's1']);
    expect(segs[0]).toMatchObject({ live: true, parts: 1, source: 'agent', cellCount: 5 });
    expect(segs[1]).toMatchObject({ live: false, endedAt: '2026-10-06T11:00:00Z' });
    expect(segs[1]!.partStarts).toEqual(['2026-10-06T10:00:00Z']);
  });

  it('会话内 >30min 间隔 → 子段切分；≤30min 不切；坏 ts 忽略', () => {
    const gap31 = SEGMENT_GAP_MS + 60_000;
    const t0 = Date.parse('2026-10-06T10:00:00Z');
    const ts = [
      new Date(t0).toISOString(),
      new Date(t0 + 10 * 60_000).toISOString(),
      new Date(t0 + 10 * 60_000 + gap31).toISOString(), // 31min 间隔 → 新子段
      'not-a-date', // 忽略
    ];
    const [seg] = buildSegments([meta('s1', '2026-10-06T10:00:00Z')], { s1: ts });
    expect(seg!.parts).toBe(2);
    expect(seg!.partStarts).toEqual([ts[0], ts[2]]);

    const dense = [ts[0]!, ts[1]!]; // 10min 间隔
    const [one] = buildSegments([meta('s1', '2026-10-06T10:00:00Z')], { s1: dense });
    expect(one!.parts).toBe(1);
  });

  it('modalSummary：N sessions · M cells 数据源', () => {
    expect(modalSummary([meta('a', 't1', { cellCount: 3 }), meta('b', 't2', { cellCount: 4 })])).toEqual({
      sessionCount: 2,
      cellCount: 7,
    });
    expect(modalSummary([])).toEqual({ sessionCount: 0, cellCount: 0 });
  });
});

describe('接线 pending 降级判定', () => {
  it('isWiringPending：P3 feature / method not found / -32600|-32601 → true；其余 false', () => {
    expect(isWiringPending(new Error('P3 feature'))).toBe(true);
    expect(isWiringPending(new Error('method not found: import.ipynb'))).toBe(true);
    expect(isWiringPending(new Error('rpc 错误 -32600'))).toBe(true);
    expect(isWiringPending(new Error('bridge 未连接'))).toBe(false);
    expect(isWiringPending('weird')).toBe(false);
  });

  it('degradeTransfer：wiring → pending-wiring 文案；其余 → error 带原 message', () => {
    expect(degradeTransfer(new Error('P3 feature')).status).toBe('pending-wiring');
    expect(degradeTransfer(new Error('P3 feature')).message).toMatch(/接线 pending/);
    const e = degradeTransfer(new Error('磁盘满了'));
    expect(e).toMatchObject({ status: 'error', message: '磁盘满了', path: null });
  });
});

describe('modal 开关与快照缓存', () => {
  it('openModal → modalOpen + session.list 刷新；closeModal 复位', async () => {
    mockDispatch({ 'session.list': () => [meta('s1', '2026-10-06T10:00:00Z', { cellCount: 2 })] });
    useSession.getState().openModal();
    await flush();
    expect(useSession.getState().modalOpen).toBe(true);
    expect(useSession.getState().sessions).toHaveLength(1);
    useSession.getState().closeModal();
    expect(useSession.getState().modalOpen).toBe(false);
  });

  it('loadSnapshot：session.open → 截断缓存（>500 存 shown 500 + total）；重复调用命中缓存', async () => {
    const cells = Array.from({ length: 600 }, (_, i) => snapCell(i));
    mockDispatch({
      'session.open': () => ({ sessionId: 's1', startedAt: 't', endedAt: 't2', cells, readOnly: true }),
    });
    await useSession.getState().loadSnapshot('s1');
    const st = useSession.getState();
    expect(st.snapshotCells['s1']).toHaveLength(500);
    expect(st.snapshotTotals['s1']).toBe(600);
    expect(st.snapshotLoading['s1']).toBe(false);
    await useSession.getState().loadSnapshot('s1'); // 已缓存 → 不再发 rpc
    expect(rpc.mock.calls.filter((c) => c[0] === 'session.open')).toHaveLength(1);
  });

  it('loadSnapshot：rpc 失败 → 空快照不 throw（降级）', async () => {
    mockDispatch({ 'session.open': () => { throw new Error('boom'); } });
    await useSession.getState().loadSnapshot('sX');
    expect(useSession.getState().snapshotCells['sX']).toEqual([]);
    expect(useSession.getState().snapshotLoading['sX']).toBe(false);
  });
});

describe('exportIpynb action', () => {
  it('成功：rpc {path, sessionId} → ok 态 + 产物路径', async () => {
    mockDispatch({
      'export.ipynb': () => ({ path: 'D:/nb/.novalab/s1.ipynb', nbCells: 4, nbOutputs: 6 }),
    });
    useSession.setState({ currentId: 's1' });
    await useSession.getState().exportIpynb();
    const st = useSession.getState().exportState;
    expect(st.status).toBe('ok');
    expect(st.path).toBe('D:/nb/.novalab/s1.ipynb');
    expect(st.message).toMatch(/4 cells · 6 outputs/);
    expect(rpc).toHaveBeenCalledWith('export.ipynb', { path: NB, sessionId: 's1' });
  });

  it('降级：-32600 stub（P3 feature）→ pending-wiring，不 throw', async () => {
    mockDispatch({ 'export.ipynb': () => { throw new Error('P3 feature'); } });
    useSession.setState({ viewingId: 's2' }); // viewingId 优先于 currentId
    await useSession.getState().exportIpynb();
    expect(useSession.getState().exportState.status).toBe('pending-wiring');
    expect(rpc).toHaveBeenCalledWith('export.ipynb', { path: NB, sessionId: 's2' });
  });

  it('无会话/无 notebook → error 态（不发 rpc）', async () => {
    mockDispatch();
    useNotebook.setState({ notebookPath: null });
    await useSession.getState().exportIpynb();
    expect(useSession.getState().exportState.status).toBe('error');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('importNotebook action', () => {
  it('成功：import.ipynb → openNotebook 新 .py + warnings 透出', async () => {
    mockDispatch({
      'import.ipynb': () => ({ path: 'D:/nb/imported.py', cells: [{ id: 'a', code: 'x' }], warnings: ['w1', 'w2'] }),
    });
    const ok = await useSession.getState().importNotebook('D:/downloads/notes.ipynb');
    expect(ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('import.ipynb', { path: 'D:/downloads/notes.ipynb' });
    expect(useNotebook.getState().notebookPath).toBe('D:/nb/imported.py');
    const st = useSession.getState().importState;
    expect(st.status).toBe('ok');
    expect(st.warnings).toEqual(['w1', 'w2']);
  });

  it('targetPath 传入时透传', async () => {
    mockDispatch({ 'import.ipynb': () => ({ path: 'D:/nb/t.py', cells: [], warnings: [] }) });
    await useSession.getState().importNotebook('a.ipynb', 'D:/nb/t.py');
    expect(rpc).toHaveBeenCalledWith('import.ipynb', { path: 'a.ipynb', targetPath: 'D:/nb/t.py' });
  });

  it('降级：method not found（-32601）→ pending-wiring，不打开 notebook', async () => {
    mockDispatch({ 'import.ipynb': () => { throw new Error('method not found: import.ipynb'); } });
    const ok = await useSession.getState().importNotebook('a.ipynb');
    expect(ok).toBe(false);
    expect(useSession.getState().importState.status).toBe('pending-wiring');
    expect(useNotebook.getState().notebookPath).toBe(NB); // 未被替换
  });

  it('空路径 → error 态（不发 rpc）', async () => {
    mockDispatch();
    const ok = await useSession.getState().importNotebook('   ');
    expect(ok).toBe(false);
    expect(useSession.getState().importState.status).toBe('error');
    expect(rpc).not.toHaveBeenCalled();
  });
});
