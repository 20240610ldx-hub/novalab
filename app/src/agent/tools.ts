import { z } from 'zod';
import { bridge } from '../bridge/client';

/**
 * Agent 工具集的前端形态（spec §7）。
 * TODO(P2.2): schema 单一来源迁移到 bridge/src/mcp/tools.ts，
 * 本文件改为从 @novalab/bridge 导入，前端 in-process 工具与 MCP server 共用 execute。
 */

export const toolSchemas = {
  getNotebookContext: z.object({}),
  getCellOutput: z.object({ cellId: z.string() }),
  proposeCodeChange: z.object({
    targetCellId: z.string(),
    action: z.enum(['update', 'insert_below']),
    newCode: z.string().describe('符合反应式单赋值规范的 Python 代码'),
    rationale: z.string().optional(),
  }),
  executeCell: z.object({ cellId: z.string(), cascade: z.boolean().optional() }),
  listCells: z.object({}),
  getCellCode: z.object({ cellId: z.string() }),
};

export const agentTools = {
  getNotebookContext: {
    description: '获取依赖拓扑 (DAG)、变量 schema 与当前焦点；不含原始数据',
    parameters: toolSchemas.getNotebookContext,
    execute: async () => bridge.rpc('agent.context'),
  },
  getCellOutput: {
    description: '获取指定 cell 最近一次 stdout/stderr/traceback（截断 8KB）',
    parameters: toolSchemas.getCellOutput,
    execute: async ({ cellId }: z.infer<typeof toolSchemas.getCellOutput>) =>
      bridge.rpc('agent.cellOutput', { cellId }),
  },
  proposeCodeChange: {
    description: '提议代码变更并触发行内 Diff 审阅；禁止直接覆盖（Tab 采纳 / Esc 拒绝）',
    parameters: toolSchemas.proposeCodeChange,
    execute: async (args: z.infer<typeof toolSchemas.proposeCodeChange>) =>
      bridge.rpc('diff.stage', args),
  },
  executeCell: {
    description: '执行指定 cell；内核按 DAG 与 StalePolicy 处理下游级联',
    parameters: toolSchemas.executeCell,
    execute: async ({ cellId, cascade }: z.infer<typeof toolSchemas.executeCell>) =>
      bridge.rpc('cell.run', { cellId, cascade }),
  },
  listCells: {
    description: '列出全部 cell 的 id、执行计数、状态与 defs/refs',
    parameters: toolSchemas.listCells,
    execute: async () => bridge.rpc('agent.listCells'),
  },
  getCellCode: {
    description: '读取指定 cell 的源码原文',
    parameters: toolSchemas.getCellCode,
    execute: async ({ cellId }: z.infer<typeof toolSchemas.getCellCode>) =>
      bridge.rpc('agent.cellCode', { cellId }),
  },
};
