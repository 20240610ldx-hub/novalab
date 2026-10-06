/**
 * MCP stdio server（spec §6.3 / ADR-003，P2.7-bridge 侧）。
 *
 * 外部 Agent（Claude Code / 任意 MCP 客户端）经 stdio 接入：
 * - tools：六工具（schema/execute 单一来源在 ./tools.ts）；
 * - resources：novalab://notebook/dag（JSON {dagEdges, staleSet}）、novalab://cell/{id}（源码原文）。
 *
 * 安全边界：propose_code_change 只产生 staged diff（前端弹审阅），
 * 不存在特权写入通道 —— 与前端 in-process 工具走同一批 router 方法。
 *
 * 进程入口：main.ts 的 `--mcp` 分支调 startMcpServer(router)（stdout 专属 MCP 协议）。
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  AGENT_TOOL_DEFS,
  agentToolSchemas,
  executeAgentTool,
  type AgentToolHost,
} from './tools';
import type { AgentContext } from '../router';
import type { z } from 'zod';

const SERVER_INFO = { name: 'novalab-bridge', version: '0.0.1' } as const;

function jsonResult(value: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** 构造并注册好六工具 + 两 resource 的 McpServer（未 connect；测试用 InMemoryTransport 直连）。 */
export function createMcpServer(host: AgentToolHost): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {}, resources: {} },
  });

  // ---------- tools（schema + execute 单一来源：./tools.ts） ----------
  for (const def of AGENT_TOOL_DEFS) {
    const schema = agentToolSchemas[def.name] as z.ZodObject<z.ZodRawShape>;
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: schema.shape,
      },
      async (args: Record<string, unknown>) => {
        try {
          // execute 内部再过一遍 zod parse（单一来源校验，MCP 层与 in-process 层行为一致）
          return jsonResult(await executeAgentTool(host, def.name, args));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text' as const, text: `[novalab] ${message}` }],
            isError: true,
          };
        }
      },
    );
  }

  // ---------- resources ----------

  // novalab://notebook/dag —— 依赖图 + stale 集合（JSON）
  server.registerResource(
    'notebook-dag',
    'novalab://notebook/dag',
    {
      title: 'Notebook DAG',
      description: '当前 notebook 的依赖图边 dagEdges 与失效集合 staleSet（JSON）',
      mimeType: 'application/json',
    },
    async (uri) => {
      const ctx = (await host.invoke('agent.context')) as AgentContext;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ dagEdges: ctx.dagEdges, staleSet: ctx.staleSet }),
          },
        ],
      };
    },
  );

  // novalab://cell/{id} —— cell 源码原文
  server.registerResource(
    'cell-code',
    new ResourceTemplate('novalab://cell/{id}', { list: undefined }),
    {
      title: 'Cell 源码',
      description: '指定 cell 的源码原文（text/x-python）',
      mimeType: 'text/x-python',
    },
    async (uri, variables) => {
      const res = (await host.invoke('agent.cellCode', {
        cellId: String(variables['id'] ?? ''),
      })) as { cellId: string; code: string };
      return {
        contents: [{ uri: uri.href, mimeType: 'text/x-python', text: res.code }],
      };
    },
  );

  return server;
}

/**
 * 起 stdio MCP server（main.ts --mcp 分支调用）。
 * 注意：stdio 模式下 stdout 专属协议帧，任何日志都必须走 stderr。
 */
export async function startMcpServer(host: AgentToolHost): Promise<McpServer> {
  const server = createMcpServer(host);
  await server.connect(new StdioServerTransport());
  return server;
}
