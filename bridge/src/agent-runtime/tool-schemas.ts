/**
 * zod → TypeBox 的单源生成（ADR-012 spike）。
 *
 * pi-agent-core 的 AgentTool.parameters 要 TypeBox schema；NovaLab 的工具 schema 单一来源
 * 是 bridge/src/mcp/tools.ts 的 zod（ADR-003）。这里**不手写第二份**：运行时用 zod v4 的
 * z.toJSONSchema 生成 JSON Schema，再用 Type.Unsafe 包成 TypeBox（TypeBox 1.x 的 schema
 * 本身就是 JSON Schema，pi-ai 的校验器 Compile 直接吃）。
 *
 * 双层校验：pi 先按生成的 JSON Schema 校验（失败 → isError 工具结果，模型可自纠）；
 * execute 内 executeAgentTool 再 zod.parse 一次（权威校验，和 MCP / 前端路径同一语义）。
 * tool-schemas.test.ts 用一组正反样例钉住两层判定一致，防 zod 升级后静默漂移。
 */

import { z } from 'zod';
import { Type, type TSchema } from '@earendil-works/pi-ai';
import { AGENT_TOOL_NAMES, agentToolSchemas, type AgentToolName } from '../mcp/tools';

/** 由 zod 生成的 JSON Schema（去掉 $schema：部分 OpenAI 兼容端点会拒收未知顶层关键字）。 */
export function toolJsonSchema(name: AgentToolName): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(agentToolSchemas[name], {
    target: 'draft-7',
    io: 'input',
  }) as Record<string, unknown>;
  return rest;
}

/** TypeBox 形态（pi AgentTool.parameters）。 */
export function toolTypeBox(name: AgentToolName): TSchema {
  return Type.Unsafe(toolJsonSchema(name));
}

/** 全部六工具的 TypeBox schema（模块加载时生成一次）。 */
export const AGENT_TOOL_TYPEBOX: Record<AgentToolName, TSchema> = Object.fromEntries(
  AGENT_TOOL_NAMES.map((n) => [n, toolTypeBox(n)]),
) as Record<AgentToolName, TSchema>;
