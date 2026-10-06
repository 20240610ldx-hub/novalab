import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AGENT_TOOL_NAMES } from '@novalab/bridge/mcp-tools';

/**
 * P2.2 单一来源迁移的守护测试：
 * 1. agentTools 与 bridge 单一来源（@novalab/bridge/mcp-tools）逐名一致；
 * 2. execute 经 executeAgentTool 落到正确的 bridge rpc 方法（zod 校验在单一来源内）；
 * 3. safeRpc 容错语义保留：-32601（method not found）→ {bridgeUpgradeNeeded}，
 *    其他错误 → {toolError}（供模型自纠），均不抛出。
 */

vi.mock('../bridge/client', () => ({
  bridge: { rpc: vi.fn() },
}));

import { bridge } from '../bridge/client';
import {
  BRIDGE_UPGRADE_MESSAGE,
  agentTools,
  isBridgeMethodMissing,
  safeRpc,
} from './tools';

const rpc = bridge.rpc as unknown as Mock;

type ExecutableTool = {
  execute?: (args: unknown, options: unknown) => Promise<unknown>;
};

function exec(name: string, args: unknown): Promise<unknown> {
  const t = agentTools[name as keyof typeof agentTools] as unknown as ExecutableTool;
  if (!t?.execute) throw new Error(`tool ${name} has no execute`);
  return t.execute(args, {});
}

beforeEach(() => {
  rpc.mockReset();
});

describe('agentTools（单一来源重建）', () => {
  it('工具名与 bridge AGENT_TOOL_NAMES 完全一致（spec §7 六工具）', () => {
    expect(Object.keys(agentTools).sort()).toEqual([...AGENT_TOOL_NAMES].sort());
    expect(Object.keys(agentTools)).toHaveLength(6);
  });

  it('每个工具带 description 与 inputSchema（来自单一来源 meta/schema）', () => {
    for (const name of AGENT_TOOL_NAMES) {
      const t = agentTools[name] as unknown as { description?: string; inputSchema?: unknown };
      expect(t.description, name).toBeTruthy();
      expect(t.inputSchema, name).toBeTruthy();
    }
  });

  it('execute 经 executeAgentTool 转发到对应 rpc 方法', async () => {
    rpc.mockResolvedValue({ cellId: 'c1', code: 'x = 1' });
    const out = await exec('get_cell_code', { cellId: 'c1' });
    expect(rpc).toHaveBeenCalledWith('agent.cellCode', { cellId: 'c1' });
    expect(out).toEqual({ cellId: 'c1', code: 'x = 1' });
  });

  it('propose_code_change → diff.stage（透传 rationale）；execute_cell → cell.run（cascade 默认 false）', async () => {
    rpc.mockResolvedValue({ staged: true });
    await exec('propose_code_change', {
      targetCellId: 'c1',
      action: 'update',
      newCode: 'df_clean = clean_rows(df_raw)',
      rationale: '单赋值',
    });
    expect(rpc).toHaveBeenCalledWith('diff.stage', {
      targetCellId: 'c1',
      action: 'update',
      newCode: 'df_clean = clean_rows(df_raw)',
      rationale: '单赋值',
    });

    rpc.mockClear();
    rpc.mockResolvedValue({ ok: true });
    await exec('execute_cell', { cellId: 'c2' });
    expect(rpc).toHaveBeenCalledWith('cell.run', { cellId: 'c2', cascade: false });
  });

  it('入参不满足单一来源 zod schema → ZodError 抛出（ai 会转为 tool-error 部件）', async () => {
    await expect(exec('get_cell_output', { cellId: 42 })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('safeRpc 容错语义（P2.1 契约保留）', () => {
  it('-32601 method not found → bridgeUpgradeNeeded + BRIDGE_UPGRADE_MESSAGE，不抛', async () => {
    rpc.mockRejectedValue(new Error('method not found: agent.context'));
    const out = (await safeRpc('agent.context')) as Record<string, unknown>;
    expect(out).toEqual({
      bridgeUpgradeNeeded: true,
      method: 'agent.context',
      error: BRIDGE_UPGRADE_MESSAGE,
    });
  });

  it('其他 rpc 错误 → toolError（供模型自纠），不抛', async () => {
    rpc.mockRejectedValue(new Error('kernel busy'));
    const out = (await safeRpc('cell.run', { cellId: 'c1' })) as Record<string, unknown>;
    expect(out).toEqual({ toolError: 'kernel busy', method: 'cell.run' });
  });

  it('execute 路径同样继承容错：-32601 → bridgeUpgradeNeeded 输出', async () => {
    rpc.mockRejectedValue(new Error('method not found: agent.listCells'));
    const out = (await exec('list_cells', {})) as Record<string, unknown>;
    expect(out.bridgeUpgradeNeeded).toBe(true);
    expect(out.error).toBe(BRIDGE_UPGRADE_MESSAGE);
  });

  it('isBridgeMethodMissing 按文案识别（code 字段被 bridge 客户端丢弃）', () => {
    expect(isBridgeMethodMissing(new Error('method not found: x'))).toBe(true);
    expect(isBridgeMethodMissing(new Error('JSON-RPC -32601'))).toBe(true);
    expect(isBridgeMethodMissing(new Error('timeout'))).toBe(false);
    expect(isBridgeMethodMissing('plain string')).toBe(false);
  });
});
