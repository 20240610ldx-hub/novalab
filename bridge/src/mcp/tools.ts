/**
 * Agent 工具集单一来源（spec §7，P2.6）。
 *
 * 六个工具的 zod schema + description + execute 实现都在这里：
 * - MCP stdio server（bridge/src/mcp/server.ts）注册这些 schema 并调 executeAgentTool；
 * - 前端（app 线，经 `@novalab/bridge/mcp-tools` 导入）消费纯 schema + meta（AGENT_TOOL_DEFS），
 *   前端 in-process 工具与 MCP server 共用同一 execute 语义（都落到 router.invoke 的同一批方法）。
 *
 * execute 通过 AgentToolHost 最小接口调 router（RpcRouter.invoke 满足），
 * 不 import router 本体 —— 本模块被 app 侧消费时必须保持零 bridge 运行时依赖（只依赖 zod）。
 *
 * 隐私边界（spec §8）：出进程数据的截断在 router 各 agent.* 出口实施
 * （agent.context 的 schemas 过 PreviewSerializer 4KB 硬截断；agent.cellOutput 各字段 8KB）。
 */

import { z } from 'zod';

/** 六工具名（spec §7 顺序：4 核心 + 2 只读辅助）。 */
export const AGENT_TOOL_NAMES = [
  'get_notebook_context',
  'get_cell_output',
  'propose_code_change',
  'execute_cell',
  'list_cells',
  'get_cell_code',
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** in-process 执行宿主的最小接口（RpcRouter 满足；避免与 router 循环依赖）。 */
export interface AgentToolHost {
  invoke(method: string, params?: unknown): Promise<unknown>;
}

// ---------- zod schema（单一来源；app 线与 MCP server 都从这里取） ----------

export const agentToolSchemas = {
  get_notebook_context: z.object({}),
  get_cell_output: z.object({
    cellId: z.string().describe('目标 cell id（来自 list_cells）'),
  }),
  propose_code_change: z.object({
    targetCellId: z.string().describe('目标 cell id；insert_below 时新 cell 插到它之后'),
    action: z.enum(['update', 'insert_below']).describe('update=改写该 cell；insert_below=在其后插入新 cell'),
    newCode: z.string().describe(
      '符合 Reactive Rulebook 的 Python 代码：单赋值、不重定义已有全局名、倾向函数式与新名字',
    ),
    rationale: z.string().optional().describe('一句话变更理由（审阅 UI 展示）'),
  }),
  execute_cell: z.object({
    cellId: z.string().describe('要执行的 cell id'),
    cascade: z.boolean().optional().describe('true 时按 DAG 级联执行下游 stale cell'),
  }),
  list_cells: z.object({}),
  get_cell_code: z.object({
    cellId: z.string().describe('目标 cell id'),
  }),
} satisfies Record<AgentToolName, z.ZodType>;

// ---------- meta（title/description；MCP 注册与 app 工具面板共用） ----------

export const agentToolMeta = {
  get_notebook_context: {
    title: '获取 notebook 上下文',
    description:
      '获取依赖拓扑（dagEdges）、变量 schemas（已按隐私边界截断）与 staleSet；不含原始数据。返回 {dagEdges, schemas, focusCellId, staleSet}',
  },
  get_cell_output: {
    title: '读取 cell 输出',
    description:
      '获取指定 cell 最近一次运行的 {stdout, stderr, traceback, mimeKeys}，各字段截断 8KB',
  },
  propose_code_change: {
    title: '提议代码变更',
    description:
      '提议代码变更 → staged diff，交前端行内审阅（Tab 采纳 / Esc 拒绝）；禁止直接覆盖 cell。' +
      '入队前有编译预检：多重定义 / DAG 环等会被拒绝并返回 reason，请据其自纠后重试',
  },
  execute_cell: {
    title: '执行 cell',
    description:
      '执行指定 cell；cascade=true 时按 DAG 级联下游。返回 run 报告 {cellId, ok, cascaded, durationMs, traceback?}',
  },
  list_cells: {
    title: '列出 cells',
    description:
      '列出全部 cell 的 [{id, execCount, status(idle|ok|stale|error), firstLine, defs, refs}]',
  },
  get_cell_code: {
    title: '读取 cell 源码',
    description: '读取指定 cell 的源码原文 {cellId, code}',
  },
} satisfies Record<AgentToolName, { title: string; description: string }>;

/** app 线消费的纯 schema + meta 列表（无 execute，无 bridge 运行时依赖）。 */
export interface AgentToolDef {
  name: AgentToolName;
  title: string;
  description: string;
  inputSchema: z.ZodType;
}

export const AGENT_TOOL_DEFS: AgentToolDef[] = AGENT_TOOL_NAMES.map((name) => ({
  name,
  title: agentToolMeta[name].title,
  description: agentToolMeta[name].description,
  inputSchema: agentToolSchemas[name] as z.ZodType,
}));

// ---------- execute（in-process：前端工具与 MCP server 共用同一实现） ----------

/**
 * 执行一个 agent 工具：zod 校验参数 → 转发到 router 对应方法。
 * 错误（RpcFault / ZodError）直接抛，由调用方（MCP handler / 前端 agent loop）包装。
 */
export async function executeAgentTool(
  host: AgentToolHost,
  name: AgentToolName,
  args: unknown,
): Promise<unknown> {
  switch (name) {
    case 'get_notebook_context': {
      agentToolSchemas.get_notebook_context.parse(args);
      return host.invoke('agent.context');
    }
    case 'get_cell_output': {
      const a = agentToolSchemas.get_cell_output.parse(args);
      return host.invoke('agent.cellOutput', { cellId: a.cellId });
    }
    case 'propose_code_change': {
      const a = agentToolSchemas.propose_code_change.parse(args);
      return host.invoke('diff.stage', {
        targetCellId: a.targetCellId,
        action: a.action,
        newCode: a.newCode,
        ...(a.rationale !== undefined ? { rationale: a.rationale } : {}),
      });
    }
    case 'execute_cell': {
      const a = agentToolSchemas.execute_cell.parse(args);
      return host.invoke('cell.run', { cellId: a.cellId, cascade: a.cascade ?? false });
    }
    case 'list_cells': {
      agentToolSchemas.list_cells.parse(args);
      return host.invoke('agent.listCells');
    }
    case 'get_cell_code': {
      const a = agentToolSchemas.get_cell_code.parse(args);
      return host.invoke('agent.cellCode', { cellId: a.cellId });
    }
    default: {
      const exhaustive: never = name;
      throw new Error(`unknown agent tool: ${String(exhaustive)}`);
    }
  }
}
