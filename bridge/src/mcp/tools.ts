/**
 * Agent 工具集单一来源（spec §7，P2.6）。
 *
 * 全部工具（六个基础工具 + ADR-013 的 shadow_run / verify）的 zod schema + description + execute 实现都在这里：
 * - MCP stdio server（bridge/src/mcp/server.ts）注册这些 schema 并调 executeAgentTool；
 * - 前端（app 线，经 `@novalab/bridge/mcp-tools` 导入）消费纯 schema + meta（AGENT_TOOL_DEFS），
 *   前端 in-process 工具与 MCP server 共用同一 execute 语义（都落到 router.invoke 的同一批方法）。
 *
 * execute 通过 AgentToolHost 最小接口调 router（RpcRouter.invoke 满足），
 * 不 import router 本体 —— 本模块被 app 侧消费时必须保持零 bridge 运行时依赖（只依赖 zod）。
 *
 * 隐私边界（spec §8）：出进程数据的截断在 router 各 agent.* 出口实施
 * （agent.context 的 schemas 过 PreviewSerializer 4KB 硬截断；agent.cellOutput 只返回
 * traceback 与 MIME 类型键，stdout/stderr/文件路径留在本地 UI/session）。
 * 第二道闸（按工具输出白名单）见 ./output-whitelist，经本模块 re-export 给 app 侧。
 */

import { z } from 'zod';

export {
  REDACTED_TEXT,
  TOOL_OUTPUT_WHITELIST,
  TRACEBACK_CHAR_LIMIT,
  sanitizeToolOutput,
  type ToolOutputGateResult,
} from './output-whitelist';

/** 工具名（spec §7 顺序：4 核心 + 2 只读辅助；ADR-013 追加影子运行与核验）。 */
export const AGENT_TOOL_NAMES = [
  'get_notebook_context',
  'get_cell_output',
  'propose_code_change',
  'execute_cell',
  'list_cells',
  'get_cell_code',
  'shadow_run',
  'verify',
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** in-process 执行宿主的最小接口（RpcRouter 满足；避免与 router 循环依赖）。 */
export interface AgentToolHost {
  invoke(method: string, params?: unknown): Promise<unknown>;
}

// ---------- zod schema（单一来源；app 线与 MCP server 都从这里取） ----------

const cellEdit = z.object({
  targetCellId: z.string().describe('目标 cell id；insert_below 时新 cell 插到它之后'),
  action: z.enum(['update', 'insert_below']).describe('update=改写该 cell；insert_below=在其后插入新 cell'),
  newCode: z.string().describe('改后的完整 cell 源码'),
});

const phase = z.enum(['before', 'after']).optional().describe('改前（before）或改后（after，默认）的影子命名空间');
const target = z.string().describe('变量名');
const columns = z.array(z.string());

/** ADR-013 §4.2 声明式契约（与 py/novakernel/shadow.py _eval_one 一一对应；不接受任意代码）。 */
const contractSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('columns_present'), target, columns: columns.min(1), phase }),
  z.object({ kind: z.literal('dtype'), target, column: z.string().optional(), expect: z.string().describe('如 int64 / float / datetime64 / object'), phase }),
  z.object({
    kind: z.literal('range'),
    target,
    column: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    inclusive: z.boolean().optional(),
    phase,
  }),
  z.object({ kind: z.literal('not_null'), target, columns: columns.optional(), phase }),
  z.object({ kind: z.literal('unique_key'), target, columns: columns.optional(), phase }),
  z.object({
    kind: z.literal('row_count'),
    target,
    op: z.enum(['==', '<=', '>=']).optional(),
    ref: z.union([z.number(), z.object({ target, phase })]).describe('数字，或另一个变量（可指定 before/after）'),
    tolerance: z.number().optional(),
    phase,
  }),
  z.object({
    kind: z.literal('sum_conserved'),
    before: z.object({ target, column: z.string().optional(), by: columns.optional(), phase }),
    after: z.object({ target, column: z.string().optional(), by: columns.optional(), phase }),
    rtol: z.number().optional(),
    atol: z.number().optional(),
  }),
  z.object({
    kind: z.literal('row_sums'),
    target,
    axis: z.union([z.literal(0), z.literal(1)]).optional(),
    expect: z.number().optional(),
    atol: z.number().optional(),
    phase,
  }),
  z.object({
    kind: z.literal('match_rate'),
    left: z.string(),
    right: z.string(),
    on: columns.min(1),
    min: z.number().min(0).max(1),
    phase,
    rightPhase: phase,
  }),
  z.object({ kind: z.literal('equivalent'), targets: columns.min(1).describe('改前改后应当相等的变量'), rtol: z.number().optional() }),
  // ADR-016 技能包契约：类别映射守恒、边际配平残差
  z.object({
    kind: z.literal('mapping_conserved'),
    mapping: z
      .union([z.record(z.string(), z.string()).describe('源类别 → 目标类别'), z.string().describe('命名空间里的 dict / Series 变量名')])
      .describe('类别映射表（键按字符串比较）'),
    before: z.object({ target, column: z.string().describe('源类别列'), value: z.string().optional().describe('要守恒的数值列；省略 = 行数'), phase }),
    after: z.object({ target, column: z.string().describe('目标类别列'), value: z.string().optional(), phase }),
    rtol: z.number().optional(),
    atol: z.number().optional(),
  }),
  z.object({
    kind: z.literal('margins_match'),
    target: target.describe('二维数值表或数组'),
    rows: z.union([z.array(z.number()), z.string()]).optional().describe('行和目标：数字列表，或 Series / 数组变量名（带索引时按标签对齐）'),
    cols: z.union([z.array(z.number()), z.string()]).optional().describe('列和目标'),
    rtol: z.number().optional(),
    atol: z.number().optional().describe('默认 1e-6'),
    phase,
  }),
]);

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
    verificationId: z.string().optional().describe('shadow_run / verify 返回的 verificationId：把核验证据绑定到这条提议'),
    intent: z.enum(['refactor', 'fix', 'feature', 'cleanup']).optional().describe('refactor = 声称行为不变（需要 equivalent 核验）'),
  }),
  execute_cell: z.object({
    cellId: z.string().describe('要执行的 cell id'),
    cascade: z.boolean().optional().describe('true 时按 DAG 级联执行下游 stale cell'),
  }),
  list_cells: z.object({}),
  get_cell_code: z.object({
    cellId: z.string().describe('目标 cell id'),
  }),
  shadow_run: z.object({
    changes: z.array(cellEdit).min(1).max(20).describe('按序应用到当前 notebook 的候选改动'),
    seed: z.number().int().optional().describe('随机种子（默认 0；numpy / random 都会被设定）'),
  }),
  verify: z.object({
    runId: z.string().describe('最近一次 shadow_run 返回的 runId'),
    contracts: z.array(contractSchema).max(64),
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
      '获取指定 cell 最近一次运行的隐私安全摘要 {traceback, mimeKeys}；stdout、stderr 与文件路径不会发送给 Agent',
  },
  propose_code_change: {
    title: '提议代码变更',
    description:
      '提议代码变更 → staged diff，交前端行内审阅（Tab 采纳 / Esc 拒绝）；禁止直接覆盖 cell。' +
      '入队前有编译预检（相对当前 notebook，并叠加全部待审 diff）：多重定义 / DAG 环等会被拒绝并返回 reason（可能附 hint），请据其自纠后重试。' +
      '把定义搬到别的 cell 要两条提议：先 update 原 cell 去掉定义，再提交新位置；第二条返回 dependsOn，需按序采纳。' +
      '返回 conflictsWith 表示与这些待审 diff 不能同时采纳',
  },
  execute_cell: {
    title: '执行 cell',
    description:
      '在用户的 kernel 上执行指定 cell；cascade=true 时按 DAG 级联下游。每次执行都需要用户在 NovaLab 界面点「允许」。' +
      '返回 run 报告 {cellId, ok, cascaded, durationMs, traceback?}；未获批准时返回 {denied, reason, message}——' +
      '此时什么都没执行，不要自动重试，向用户说明原因并询问下一步。',
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
  shadow_run: {
    title: '影子运行',
    description:
      '在独立的影子进程里运行候选改动：按源码重放上游 cell，再运行改后的下游闭包。用户的 kernel、变量和文件都不会被改动；' +
      '影子进程禁止网络、子进程和临时目录外的写入（被拦截的操作计入 blocked）。每轮第一次运行前用户需要在 NovaLab 界面点「允许」。' +
      '返回 schema 级报告 {runId, verificationId, status, after{plan, cells}, vars[{name, before, after, delta}], autoChecks, blocked, nondeterminism, budget}' +
      '——只有类型、形状、列名和聚合统计，没有行数据。未获批准时返回 {denied, reason, message}：此时什么都没运行，本轮不要重试。',
  },
  verify: {
    title: '核验契约',
    description:
      '在最近一次 shadow_run 保留的影子状态上评估声明式契约（columns_present / dtype / range / not_null / unique_key / row_count / ' +
      'sum_conserved / row_sums / match_rate / equivalent / mapping_conserved / margins_match），只返回每条的状态与计数 {runId, verificationId, status, contracts}。' +
      '把 verificationId 传给 propose_code_change，审阅卡片上会显示核验状态。',
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
  opts: { signal?: AbortSignal } = {},
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
        ...(a.verificationId !== undefined ? { verificationId: a.verificationId } : {}),
        ...(a.intent !== undefined ? { intent: a.intent } : {}),
      });
    }
    case 'execute_cell': {
      const a = agentToolSchemas.execute_cell.parse(args);
      // 过渡闸：每次执行都要用户在 NovaLab 界面确认（router agent.executeCell）
      return host.invoke('agent.executeCell', { cellId: a.cellId, cascade: a.cascade ?? false });
    }
    case 'list_cells': {
      agentToolSchemas.list_cells.parse(args);
      return host.invoke('agent.listCells');
    }
    case 'get_cell_code': {
      const a = agentToolSchemas.get_cell_code.parse(args);
      return host.invoke('agent.cellCode', { cellId: a.cellId });
    }
    case 'shadow_run': {
      const a = agentToolSchemas.shadow_run.parse(args);
      // F4：harness 的 abortSignal（用户点 Stop）→ shadow.cancel，影子进程树立即终止
      return withCancel(host, opts.signal, () =>
        host.invoke('shadow.run', { changes: a.changes, ...(a.seed !== undefined ? { seed: a.seed } : {}) }),
      );
    }
    case 'verify': {
      const a = agentToolSchemas.verify.parse(args);
      return withCancel(host, opts.signal, () => host.invoke('shadow.verify', { runId: a.runId, contracts: a.contracts }));
    }
    default: {
      const exhaustive: never = name;
      throw new Error(`unknown agent tool: ${String(exhaustive)}`);
    }
  }
}

/** 运行期间 signal 触发 → 通知 bridge 取消（结果仍以 router 的 cancelled 报告结算）。 */
async function withCancel<T>(host: AgentToolHost, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  if (!signal) return run();
  const onAbort = (): void => {
    host.invoke('shadow.cancel', {}).catch(() => undefined);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await run();
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
