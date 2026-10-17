/**
 * M4 写入纪律 —— pi beforeToolCall 闸 + 受限宿主（ADR-012 spike）。
 *
 * 两层，都不依赖模型自觉：
 *  1. guardHost：工具实现只能经它碰 router，且只放行六工具实际需要的 6 个方法。
 *     cell.save / diff.accept / fs.* / kernel.repl 等写入或执行通道在这一层就不存在 ——
 *     "Agent 写入永远 staged"是结构性的，与 MCP 路径"不存在特权写入通道"同一不变量。
 *  2. beforeToolCall（decideToolGate）：工具名白名单（pi 扩展 / skill 注入的任何其他工具一律拦截，
 *     明确不引入 pi-coding-agent 的 read/write/edit/bash）、execute_cell 执行策略、
 *     每轮提议数上限（防 diff 托盘被刷屏）。
 */

import type { AgentToolHost, AgentToolName } from '../mcp/tools';
import { AGENT_TOOL_NAMES } from '../mcp/tools';

/** 六工具 → 允许触达的 router 方法（与 executeAgentTool 的转发表一一对应）。 */
export const TOOL_ROUTER_METHODS: Record<AgentToolName, string> = {
  get_notebook_context: 'agent.context',
  get_cell_output: 'agent.cellOutput',
  propose_code_change: 'diff.stage',
  execute_cell: 'cell.run',
  list_cells: 'agent.listCells',
  get_cell_code: 'agent.cellCode',
  shadow_run: 'shadow.run',
  verify: 'shadow.verify',
};

/** 工具转发之外允许的辅助方法：Stop / abortSignal 取消影子运行（只终止影子进程，不碰用户状态）。 */
const AUX_METHODS = ['shadow.cancel'];

const ALLOWED_METHODS = new Set([...Object.values(TOOL_ROUTER_METHODS), ...AUX_METHODS]);

export class M4Violation extends Error {
  constructor(method: string) {
    super(`M4: agent runtime may not call router method "${method}" (writes are staged-only)`);
    this.name = 'M4Violation';
  }
}

/** 受限宿主：白名单外的 router 方法直接抛 M4Violation（不转发）。 */
export function guardHost(host: AgentToolHost, onViolation?: (method: string) => void): AgentToolHost {
  return {
    invoke(method, params) {
      if (!ALLOWED_METHODS.has(method)) {
        onViolation?.(method);
        return Promise.reject(new M4Violation(method));
      }
      return host.invoke(method, params);
    },
  };
}

export type ExecutePolicy = 'allow' | 'deny';

export interface ToolGatePolicy {
  /** execute_cell：'allow' 与现有 Vercel 路径一致；'deny' = 只读 + 只提议。 */
  execute: ExecutePolicy;
  /** 单次 run 最多入队多少个 staged diff（被预检拒绝的不计）。 */
  maxProposalsPerRun: number;
}

export const DEFAULT_GATE_POLICY: ToolGatePolicy = { execute: 'allow', maxProposalsPerRun: 8 };

export interface GateState {
  proposalsThisRun: number;
}

export type GateDecision = { block: false } | { block: true; reason: string };

const KNOWN = new Set<string>(AGENT_TOOL_NAMES);

/**
 * beforeToolCall 的判定（纯函数，单测直接覆盖）。
 *
 * Owner 决策点：execute_cell 的默认策略。'allow' 保持与当前 Vercel 路径行为一致
 * （Agent 能跑已有 cell，但不能改代码）；'deny' 把 Agent 收紧为纯"读 + 提议"，
 * 运行一律由用户在 Diff 采纳时触发（accept = save + run，mark-only）。
 */
export function decideToolGate(toolName: string, policy: ToolGatePolicy, state: GateState): GateDecision {
  if (!KNOWN.has(toolName)) {
    return { block: true, reason: `tool "${toolName}" is not a NovaLab agent tool; blocked by M4 gate` };
  }
  if (toolName === 'execute_cell' && policy.execute === 'deny') {
    return { block: true, reason: 'execute_cell is disabled by policy; propose a change and let the user run it' };
  }
  if (toolName === 'propose_code_change' && state.proposalsThisRun >= policy.maxProposalsPerRun) {
    return {
      block: true,
      reason: `proposal budget exhausted (${policy.maxProposalsPerRun} staged diffs this run); wait for the user to review`,
    };
  }
  return { block: false };
}
