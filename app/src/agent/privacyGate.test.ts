import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  REDACTED_TEXT,
  TRACEBACK_CHAR_LIMIT,
  sanitizeToolOutput,
} from '@novalab/bridge/mcp-tools';

/**
 * M5 第二道闸（ADR-012 D3）：工具 execute 的返回值过按工具白名单后才交给模型。
 * 故障注入：mock bridge rpc 让 agent.* 出口"回归"（多带 stdout / 写文件路径等），
 * 断言 canary 不出现在交给模型的输出里，且 ContextChip 审计记下 droppedKeys/redacted。
 */

vi.mock('../bridge/client', () => ({
  bridge: { rpc: vi.fn() },
}));

import { bridge } from '../bridge/client';
import { agentTools, BRIDGE_UPGRADE_MESSAGE } from './tools';
import { useAgentStore } from '../store/agent';

const rpc = bridge.rpc as unknown as Mock;
const CANARY = 'CANARY_7f3a_secret_row';
const SUFFIX = '…[truncated]';

type ExecutableTool = { execute?: (args: unknown, options: unknown) => Promise<unknown> };

function exec(name: keyof typeof agentTools, args: unknown): Promise<unknown> {
  const t = agentTools[name] as unknown as ExecutableTool;
  return t.execute!(args, {});
}

function lastAudit() {
  const audit = useAgentStore.getState().toolAudit;
  return audit[audit.length - 1]!;
}

beforeEach(() => {
  rpc.mockReset();
  useAgentStore.setState({ toolAudit: [] });
});

describe('白名单外键被丢弃并审计', () => {
  it('agent.cellOutput 回归带出 stdout/writes → 丢弃，canary 不进模型输出', async () => {
    rpc.mockResolvedValue({
      traceback: null,
      mimeKeys: ['text/plain'],
      stdout: `rows: ${CANARY}`,
      writes: ['/home/u/secret.csv'],
    });
    const out = await exec('get_cell_output', { cellId: 'c1' });
    expect(out).toEqual({ traceback: null, mimeKeys: ['text/plain'] });
    expect(JSON.stringify(out)).not.toContain(CANARY);

    const a = lastAudit();
    expect(a.tool).toBe('get_cell_output');
    expect(a.droppedKeys.sort()).toEqual(['stdout', 'writes']);
    expect(a.redacted).toBe(false);
    expect(a.preview).not.toContain(CANARY);
    expect(a.bytes).toBe(JSON.stringify(out).length);
  });

  it('嵌套结构里的多余键（schemas[i] / list_cells[i]）同样丢弃并给出路径', async () => {
    rpc.mockResolvedValue({
      dagEdges: [{ from: 'a', to: 'b', weight: 1 }],
      schemas: [{ name: 'df', type: 'DataFrame', rows: [[CANARY]] }],
      focusCellId: null,
      staleSet: [],
    });
    const ctx = await exec('get_notebook_context', {});
    expect(JSON.stringify(ctx)).not.toContain(CANARY);
    expect(lastAudit().droppedKeys).toEqual(['dagEdges[0].weight', 'schemas[0].rows']);

    rpc.mockResolvedValue([
      { id: 'c1', execCount: 1, status: 'ok', firstLine: 'x = 1', defs: ['x'], refs: [], code: CANARY },
    ]);
    const cells = await exec('list_cells', {});
    expect(JSON.stringify(cells)).not.toContain(CANARY);
    expect(lastAudit().droppedKeys).toEqual(['[0].code']);
  });

  it('合规输出原样通过，审计 droppedKeys 为空', async () => {
    rpc.mockResolvedValue({ cellId: 'c1', ok: true, cascaded: ['c2'], durationMs: 12 });
    const out = await exec('execute_cell', { cellId: 'c1' });
    expect(out).toEqual({ cellId: 'c1', ok: true, cascaded: ['c2'], durationMs: 12 });
    expect(lastAudit()).toMatchObject({ droppedKeys: [], redacted: false });
  });

  it('propose_code_change 两种形状（diffId / rejected）都放行', async () => {
    rpc.mockResolvedValue({ diffId: 'd1', newCode: CANARY });
    expect(await exec('propose_code_change', { targetCellId: 'c1', action: 'update', newCode: 'y = 2' })).toEqual({
      diffId: 'd1',
    });
    const rejected = { rejected: true, reason: { message: 'multiple definitions of x', cellIds: ['a', 'b'] } };
    rpc.mockResolvedValue(rejected);
    expect(await exec('propose_code_change', { targetCellId: 'c1', action: 'update', newCode: 'x = 2' })).toEqual(
      rejected,
    );
  });

  it('execute_cell 未获批准 → {denied, reason, message} 放行（模型据此停下来问用户）', async () => {
    const denied = { denied: true, reason: 'user-declined', message: 'The user declined to run this cell, so nothing was executed.' };
    rpc.mockResolvedValue({ ...denied, code: CANARY });
    expect(await exec('execute_cell', { cellId: 'c1' })).toEqual(denied);
    rpc.mockResolvedValue({ denied: true, reason: 'made-up', message: 'x' });
    expect(await exec('execute_cell', { cellId: 'c1' })).toBe(REDACTED_TEXT);
  });

  it('propose_code_change 的 F2 字段（dependsOn / hint / conflictsWith）放行，其余仍 strip', async () => {
    rpc.mockResolvedValue({ diffId: 'diff-2', dependsOn: ['diff-1'], newCode: CANARY });
    expect(await exec('propose_code_change', { targetCellId: 'a', action: 'insert_below', newCode: 'y = 1' })).toEqual({
      diffId: 'diff-2',
      dependsOn: ['diff-1'],
    });
    const rejected = {
      rejected: true,
      reason: { message: "multiple definitions of 'w' (cells a, b)", cellIds: ['a', 'b'] },
      hint: "'w' is already defined in cell 'b'.",
      conflictsWith: ['diff-1'],
    };
    rpc.mockResolvedValue(rejected);
    expect(await exec('propose_code_change', { targetCellId: 'a', action: 'update', newCode: 'w = 2' })).toEqual(rejected);
    expect(lastAudit()).toMatchObject({ droppedKeys: [], redacted: false });
  });
});

describe('fail closed', () => {
  it('形状不符（缺字段 / 类型错）→ 占位文本 + redacted', async () => {
    rpc.mockResolvedValue({ stdout: CANARY });
    expect(await exec('get_cell_output', { cellId: 'c1' })).toBe(REDACTED_TEXT);
    expect(lastAudit()).toMatchObject({ redacted: true, droppedKeys: [] });
    expect(lastAudit().preview).not.toContain(CANARY);

    rpc.mockResolvedValue({ cellId: 'c1', code: 42 });
    expect(await exec('get_cell_code', { cellId: 'c1' })).toBe(REDACTED_TEXT);
  });

  it('非对象（裸字符串 / null / 数组给对象工具）→ 占位文本', async () => {
    for (const bad of [CANARY, null, 7, [{ traceback: null, mimeKeys: [] }]]) {
      rpc.mockResolvedValue(bad);
      expect(await exec('get_cell_output', { cellId: 'c1' })).toBe(REDACTED_TEXT);
      expect(lastAudit().redacted).toBe(true);
    }
  });

  it('未知工具名 → 占位文本', () => {
    const r = sanitizeToolOutput('read_file', { content: CANARY });
    expect(r).toEqual({ output: REDACTED_TEXT, droppedKeys: [], truncatedFields: [], redacted: true });
  });

  it('safeRpc 的升级提示 / toolError 信封仍可达模型，多余键同样被剥离', async () => {
    rpc.mockRejectedValue(new Error('method not found: agent.cellOutput'));
    expect(await exec('get_cell_output', { cellId: 'c1' })).toEqual({
      bridgeUpgradeNeeded: true,
      method: 'agent.cellOutput',
      error: BRIDGE_UPGRADE_MESSAGE,
    });
    rpc.mockRejectedValue(new Error('kernel busy'));
    expect(await exec('execute_cell', { cellId: 'c1' })).toEqual({ toolError: 'kernel busy', method: 'agent.executeCell' });
    expect(lastAudit().redacted).toBe(false);
  });
});

describe('字符串截断', () => {
  it('一般字符串 4KB、traceback 8KB、源码不截断', async () => {
    rpc.mockResolvedValue({ cellId: 'c1', code: 'x'.repeat(20_000) });
    const code = (await exec('get_cell_code', { cellId: 'c1' })) as { code: string };
    expect(code.code).toHaveLength(20_000);

    rpc.mockResolvedValue({ traceback: 'T'.repeat(TRACEBACK_CHAR_LIMIT + 100), mimeKeys: ['m'.repeat(5000)] });
    const out = (await exec('get_cell_output', { cellId: 'c1' })) as { traceback: string; mimeKeys: string[] };
    expect(out.traceback).toBe('T'.repeat(TRACEBACK_CHAR_LIMIT) + SUFFIX);
    expect(out.mimeKeys[0]).toBe('m'.repeat(4096) + SUFFIX);
  });

  it('第一道闸已截过的字符串不叠加第二个后缀', () => {
    const already = 'T'.repeat(TRACEBACK_CHAR_LIMIT) + SUFFIX;
    const r = sanitizeToolOutput('execute_cell', {
      cellId: 'c1',
      ok: false,
      cascaded: [],
      durationMs: 1,
      traceback: already,
    });
    expect((r.output as { traceback: string }).traceback).toBe(already);
    expect(r.truncatedFields).toEqual([]);
  });

  it('嵌套同名键不享受顶层豁免（preview.code 仍按 4KB 截）', () => {
    const r = sanitizeToolOutput('get_notebook_context', {
      dagEdges: [],
      schemas: [{ name: 'f', type: 'str', preview: { code: 'p'.repeat(9000) } }],
      focusCellId: null,
      staleSet: [],
    });
    const pv = (r.output as { schemas: { preview: { code: string } }[] }).schemas[0]!.preview.code;
    expect(pv).toBe('p'.repeat(4096) + SUFFIX);
    expect(r.truncatedFields).toEqual(['schemas[0].preview.code']);
  });
});
