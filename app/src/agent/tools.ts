import { tool, type JSONValue, type Tool } from 'ai';
import {
  AGENT_TOOL_DEFS,
  executeAgentTool,
  type AgentToolHost,
  type AgentToolName,
} from '@novalab/bridge/mcp-tools';
import { bridge } from '../bridge/client';

/**
 * Agent 工具集的前端形态（spec §7），ai v7 tool() 形态（inputSchema + execute）。
 *
 * schema/description/execute 单一来源：bridge/src/mcp/tools.ts（P2.2 迁移完成，
 * 经 '@novalab/bridge/mcp-tools' 导出——该模块只依赖 zod、零 bridge 运行时依赖）。
 * 前端 in-process 工具与 MCP stdio server 共用同一份 AGENT_TOOL_DEFS 与
 * executeAgentTool；本文件只注入 rpcHost（safeRpc → bridge WS rpc），
 * 六个工具全部在浏览器进程内落地（client-side tools）。
 * 工具名与 schema 均为 spec §7 规范形态（snake_case）。
 *
 * 容错契约（P2.1）：I 线的 bridge agent.* 方法尚未落地时，rpc 返回 JSON-RPC -32601
 * （bridge 客户端把 error.message "method not found: xxx" 包成 Error）。safeRpc 捕获后
 * 返回 {bridgeUpgradeNeeded: true, ...} 作为工具输出——模型可读到并停手，
 * AgentPanel 渲染 "bridge 待升级" 提示条，不崩溃。
 */

/** AgentPanel 与模型共用的升级提示文案。 */
export const BRIDGE_UPGRADE_MESSAGE =
  'bridge 待升级：当前 bridge 未实现该方法（JSON-RPC -32601 method not found）。请告知用户等待 I 线 bridge agent.* 方法上线，勿反复重试。';

/** bridge 客户端把 -32601 的 message 原文包进 Error（code 字段丢失），按文案识别。 */
export function isBridgeMethodMissing(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /method not found|-32601/i.test(msg);
}

/** 所有 rpc 的统一出口：-32601 → 升级提示；其他错误 → toolError（供模型自纠）。 */
export async function safeRpc(method: string, params: unknown = {}): Promise<JSONValue> {
  try {
    return (await bridge.rpc(method, params)) as JSONValue;
  } catch (err) {
    if (isBridgeMethodMissing(err)) {
      return { bridgeUpgradeNeeded: true, method, error: BRIDGE_UPGRADE_MESSAGE };
    }
    return {
      toolError: err instanceof Error ? err.message : String(err),
      method,
    };
  }
}

/**
 * executeAgentTool 的执行宿主：把单一来源的 execute（agent.context / agent.cellOutput /
 * diff.stage / cell.run / agent.listCells / agent.cellCode）接到 safeRpc 上，
 * 与 MCP server 走 router.invoke 的语义一一对应，且继承 -32601 容错。
 * executeAgentTool 内先做 zod 校验（单一来源 schema），再转发到对应 rpc 方法。
 */
const rpcHost: AgentToolHost = {
  invoke: (method, params) => safeRpc(method, params),
};

function buildAgentTools(): Record<AgentToolName, Tool> {
  const tools = {} as Record<AgentToolName, Tool>;
  for (const def of AGENT_TOOL_DEFS) {
    tools[def.name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: (args: unknown) => executeAgentTool(rpcHost, def.name, args),
    });
  }
  return tools;
}

export const agentTools = buildAgentTools();

export type AgentToolSet = typeof agentTools;
