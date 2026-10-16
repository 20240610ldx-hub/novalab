/**
 * AgentRuntime —— 用 pi-agent-core 在 bridge（Node）侧跑 NovaLab 六工具（ADR-012 spike）。
 *
 * 与现有前端 Vercel 循环（app/src/agent/useAgentChat.ts）并列，不替换：
 *  - 工具：只有 bridge/src/mcp/tools.ts 的六个（schema 由 tool-schemas.ts 从 zod 单源生成，
 *    execute 复用 executeAgentTool）。明确不引入 pi-coding-agent 的 read/write/edit/bash。
 *  - M4：beforeToolCall → decideToolGate；工具只经 guardHost 触达 router（policy.ts）。
 *  - M5：transformContext → createPrivacyGate，每次 LLM 请求前过输出白名单并审计（privacy.ts）。
 *  - 插话：steer()（当前 turn 的工具跑完后注入）/ followUp()（Agent 本该停下时再续一轮）。
 *  - 步数：finishTurn 在第 maxSteps 次 LLM 调用后结束 run，对齐 stepCountIs(10)。
 *
 * 本模块不接 WS / router.ts：前端如何订阅事件、断线如何续流依赖第六轮 bridge 重连，
 * 属于 Go 之后的集成工作（见 docs/adr-012-agent-harness-proposal.md）。
 */

import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import {
  AGENT_TOOL_DEFS,
  executeAgentTool,
  type AgentToolHost,
  type AgentToolName,
} from '../mcp/tools';
import { AGENT_TOOL_TYPEBOX } from './tool-schemas';
import {
  DEFAULT_GATE_POLICY,
  decideToolGate,
  guardHost,
  type GateState,
  type ToolGatePolicy,
} from './policy';
import { createPrivacyGate, type PrivacyAuditEntry } from './privacy';

export interface AgentRuntimeOptions {
  host: AgentToolHost;
  model: Model<any>;
  streamFn: StreamFn;
  systemPrompt: string;
  /** 每次 run 的 LLM 调用上限（默认 10，对齐现有 stopWhen: stepCountIs(10)）。 */
  maxSteps?: number;
  gate?: Partial<ToolGatePolicy>;
  onEvent?: (event: AgentEvent) => void;
}

export interface RuntimeStats {
  llmCalls: number;
  toolCalls: number;
  blockedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  hitStepLimit: boolean;
}

const WRITE_OR_EXEC: ReadonlySet<AgentToolName> = new Set(['propose_code_change', 'execute_cell']);

function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export class AgentRuntime {
  readonly agent: Agent;
  readonly audit: PrivacyAuditEntry[] = [];
  readonly m4Violations: string[] = [];
  readonly blocked: { tool: string; reason: string }[] = [];
  readonly stats: RuntimeStats = {
    llmCalls: 0,
    toolCalls: 0,
    blockedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    hitStepLimit: false,
  };

  private readonly policy: ToolGatePolicy;
  private readonly gateState: GateState = { proposalsThisRun: 0 };
  private turnsThisRun = 0;

  constructor(opts: AgentRuntimeOptions) {
    this.policy = { ...DEFAULT_GATE_POLICY, ...opts.gate };
    const maxSteps = opts.maxSteps ?? 10;
    const host = guardHost(opts.host, (m) => this.m4Violations.push(m));

    const tools: AgentTool<any>[] = AGENT_TOOL_DEFS.map((def) => ({
      name: def.name,
      label: def.title,
      description: def.description,
      parameters: AGENT_TOOL_TYPEBOX[def.name],
      // staged diff 的入队顺序与内核执行都需要串行：同批含写/执行工具时整批串行
      ...(WRITE_OR_EXEC.has(def.name) ? { executionMode: 'sequential' as const } : {}),
      execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
        this.stats.toolCalls++;
        const result = await abortable(executeAgentTool(host, def.name, params), signal);
        if (def.name === 'propose_code_change' && result && typeof result === 'object' && 'diffId' in result) {
          this.gateState.proposalsThisRun++;
        }
        // details 只留工具名：原始结果不进 transcript 的旁路字段
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: { tool: def.name } };
      },
    }));

    this.agent = new Agent({
      initialState: { systemPrompt: opts.systemPrompt, model: opts.model, tools },
      streamFn: opts.streamFn,
      toolExecution: 'parallel',
      transformContext: createPrivacyGate((e) => this.audit.push(e)),
      beforeToolCall: async ({ toolCall }) => {
        const d = decideToolGate(toolCall.name, this.policy, this.gateState);
        if (!d.block) return undefined;
        this.stats.blockedCalls++;
        this.blocked.push({ tool: toolCall.name, reason: d.reason });
        return { block: true, reason: d.reason };
      },
      finishTurn: ({ message }) => {
        if (message.stopReason === 'error' || message.stopReason === 'aborted') return undefined;
        if (this.turnsThisRun >= maxSteps) {
          this.stats.hitStepLimit = true;
          return { action: 'end' };
        }
        return undefined;
      },
    });

    this.agent.subscribe((event) => {
      if (event.type === 'agent_start') {
        this.turnsThisRun = 0;
        this.gateState.proposalsThisRun = 0;
      } else if (event.type === 'turn_start') {
        this.turnsThisRun++;
        this.stats.llmCalls++;
      } else if (event.type === 'message_end' && event.message.role === 'assistant') {
        const u = event.message.usage;
        this.stats.inputTokens += u.input + u.cacheRead + u.cacheWrite;
        this.stats.outputTokens += u.output;
        this.stats.cost += u.cost.total;
      }
      opts.onEvent?.(event);
    });
  }

  prompt(text: string): Promise<void> {
    return this.agent.prompt(text);
  }

  /** 运行中插话：当前 turn 的工具跑完后、下一次 LLM 请求前注入。 */
  steer(text: string): void {
    this.agent.steer({ role: 'user', content: text, timestamp: Date.now() });
  }

  /** 排队追问：Agent 本该停下时再续一轮（无需前端另发 prompt）。 */
  followUp(text: string): void {
    this.agent.followUp({ role: 'user', content: text, timestamp: Date.now() });
  }

  abort(): void {
    this.agent.abort();
  }

  waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }
}
