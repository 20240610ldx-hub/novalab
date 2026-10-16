/**
 * 两套循环的驱动（同一 stub 策略、同一 router + OracleKernel 宿主）。
 *
 *  - vercel：复刻 app/src/agent/useAgentChat.ts + tools.ts 的语义 —— streamText +
 *    stopWhen(stepCountIs(10))，工具 = AGENT_TOOL_DEFS 的 zod schema + executeAgentTool，
 *    宿主错误按 safeRpc 包成 {toolError}，审计按 auditToolResult 只记字节（无白名单）。
 *    差异：bench 里宿主是 router.invoke（in-process），app 里是 bridge WS rpc。
 *  - pi：AgentRuntime（beforeToolCall / transformContext / finishTurn），模型 = pi-ai faux provider。
 *
 * Meter 在"模型实际收到的请求"上计量：请求次数、序列化体积 → 估算 token（chars/4，两边同一估算器）、
 * 以及 canary 泄漏（M5 白名单外的 stdout/stderr/mime/路径/超长 preview 尾部）。
 */

import { stepCountIs, streamText, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai';
import { AGENT_TOOL_DEFS, executeAgentTool, type AgentToolHost } from '../../mcp/tools';
import { AgentRuntime } from '../runtime';
import { CANARY_RE } from './fixtures';
import type { Action, Policy, View } from './policy';

export class Meter {
  requests = 0;
  inputChars = 0;
  outputChars = 0;
  readonly leaks = new Set<string>();
  readonly requestTimes: number[] = [];

  /**
   * serialized = 完整请求（泄漏扫描用，保守）；canonical = 只含会发给 provider 的语义内容
   * （system / 工具声明 / 消息文本 / 工具调用名与参数 / 工具结果文本），两边同一口径估 token。
   */
  record(serialized: string, canonical: string): void {
    this.requests++;
    this.inputChars += canonical.length;
    this.requestTimes.push(Date.now());
    for (const m of serialized.matchAll(CANARY_RE)) this.leaks.add(m[0]);
  }

  answer(a: Action): void {
    this.outputChars += JSON.stringify(a).length;
  }

  get inputTokens(): number {
    return Math.ceil(this.inputChars / 4);
  }

  get outputTokens(): number {
    return Math.ceil(this.outputChars / 4);
  }
}

export interface LoopHooks {
  /** 每个工具执行完（结果已产生）时回调，用于插话 / 中止时机。 */
  onToolDone?: (name: string, n: number) => void;
  onToolStart?: (name: string) => void;
}

// ---------- 同口径序列化（token 估算） ----------

type Blk = { type: string; text?: string; name?: string; arguments?: unknown; toolName?: string; input?: unknown; output?: { value: unknown } };

export function canonicalPi(messages: readonly { role: string; [k: string]: unknown }[]): string {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      out.push(m['content']);
      for (const t of (m['toolsAdded'] ?? []) as { name: string; description?: string; parameters: unknown }[]) {
        out.push([t.name, t.description, t.parameters]);
      }
    } else if (m.role === 'toolResult') out.push(textOf(m['content']));
    else {
      const c = m['content'];
      if (typeof c === 'string') out.push(c);
      else for (const b of c as Blk[]) out.push(b.type === 'text' ? b.text : b.type === 'toolCall' ? [b.name, b.arguments] : null);
    }
  }
  return JSON.stringify(out);
}

export function canonicalVercel(
  prompt: readonly { role: string; content: unknown }[],
  tools: readonly { name: string; description?: string; inputSchema: unknown }[],
): string {
  const out: unknown[] = [];
  for (const m of prompt) {
    if (typeof m.content === 'string') out.push(m.content);
    else {
      for (const b of m.content as Blk[]) {
        if (b.type === 'text') out.push(b.text);
        else if (b.type === 'tool-call') out.push([b.toolName, b.input]);
        else if (b.type === 'tool-result') {
          const v = b.output?.value;
          out.push(typeof v === 'string' ? v : JSON.stringify(v));
        }
      }
    }
  }
  for (const t of tools) out.push([t.name, t.description, t.inputSchema]);
  return JSON.stringify(out);
}

// ---------- pi ----------

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
      .join('\n');
  }
  return '';
}

export function viewFromPi(messages: readonly { role: string; [k: string]: unknown }[]): View {
  const v: View = { users: [], results: [], assistantTurns: 0 };
  for (const m of messages) {
    if (m.role === 'user') v.users.push(textOf(m['content']));
    else if (m.role === 'assistant') v.assistantTurns++;
    else if (m.role === 'toolResult') {
      v.results.push({ name: String(m['toolName']), text: textOf(m['content']), isError: m['isError'] === true });
    }
  }
  return v;
}

export interface PiHandle {
  runtime: AgentRuntime;
  meter: Meter;
}

export function createPiLoop(
  host: AgentToolHost,
  policy: Policy,
  systemPrompt: string,
  hooks: LoopHooks = {},
  gate?: ConstructorParameters<typeof AgentRuntime>[0]['gate'],
): PiHandle {
  const meter = new Meter();
  const faux = fauxProvider({ provider: `faux-${Math.random().toString(36).slice(2, 8)}` });
  const models = createModels();
  models.setProvider(faux.provider);
  let callSeq = 0;
  const factory: FauxResponseFactory = (context) => {
    meter.record(JSON.stringify(context), canonicalPi(context.messages as never));
    const a = policy(viewFromPi(context.messages as never));
    meter.answer(a);
    if ('text' in a) return fauxAssistantMessage(fauxText(a.text));
    return fauxAssistantMessage(
      a.calls.map((c) => fauxToolCall(c.name, c.args as never, { id: `call_${++callSeq}` })),
      { stopReason: 'toolUse' },
    );
  };
  faux.setResponses(Array.from({ length: 64 }, () => factory));
  let toolN = 0;
  const runtime = new AgentRuntime({
    host,
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    systemPrompt,
    ...(gate ? { gate } : {}),
    onEvent: (e) => {
      if (e.type === 'tool_execution_start') hooks.onToolStart?.(e.toolName);
      if (e.type === 'tool_execution_end') hooks.onToolDone?.(e.toolName, ++toolN);
    },
  });
  return { runtime, meter };
}

// ---------- vercel ----------

export function viewFromVercel(prompt: readonly { role: string; content: unknown }[]): View {
  const v: View = { users: [], results: [], assistantTurns: 0 };
  for (const m of prompt) {
    if (m.role === 'user') v.users.push(textOf(m.content));
    else if (m.role === 'assistant') v.assistantTurns++;
    else if (m.role === 'tool') {
      for (const part of m.content as { type: string; toolName: string; output: { type: string; value: unknown } }[]) {
        if (part.type !== 'tool-result') continue;
        const o = part.output;
        v.results.push({
          name: part.toolName,
          text: typeof o.value === 'string' ? o.value : JSON.stringify(o.value),
          isError: o.type.startsWith('error'),
        });
      }
    }
  }
  return v;
}

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

function streamOf(a: Action): ReadableStream<never> {
  let seq = 0;
  const parts: unknown[] = [{ type: 'stream-start', warnings: [] }];
  if ('text' in a) {
    parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: a.text }, { type: 'text-end', id: 't' });
    parts.push({ type: 'finish', usage: USAGE, finishReason: { unified: 'stop', raw: 'stop' } });
  } else {
    for (const c of a.calls) {
      parts.push({ type: 'tool-call', toolCallId: `vc_${Date.now()}_${++seq}`, toolName: c.name, input: JSON.stringify(c.args) });
    }
    parts.push({ type: 'finish', usage: USAGE, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } });
  }
  return new ReadableStream({
    start(ctrl) {
      for (const p of parts) ctrl.enqueue(p as never);
      ctrl.close();
    },
  });
}

/** safeRpc 的 in-process 对等物：-32601 → bridgeUpgradeNeeded；其他错误 → {toolError}。 */
function safeHost(host: AgentToolHost): AgentToolHost {
  return {
    async invoke(method, params) {
      try {
        return await host.invoke(method, params);
      } catch (err) {
        return { toolError: err instanceof Error ? err.message : String(err), method };
      }
    },
  };
}

export interface VercelRun {
  meter: Meter;
  audit: { tool: string; bytes: number }[];
  toolCalls: number;
  /** 发起一次 streamText 运行；messages 为完整历史（含新 user 消息）。 */
  run: (
    messages: ModelMessage[],
    signal?: AbortSignal,
  ) => Promise<{ responseMessages: ModelMessage[]; steps: number; usage: { input: number; output: number } }>;
  /** 已完成工具调用的记录（模拟 UI 消息里已落地的 tool part，供中止后续聊重建历史）。 */
  completed: { toolCallId: string; toolName: string; input: unknown; output: unknown }[];
}

export function createVercelLoop(
  host: AgentToolHost,
  policy: Policy,
  systemPrompt: string,
  hooks: LoopHooks = {},
  /** G-1 真实模型：给定时替代 stub（policy 不再使用，meter 只计请求次数以外的 provider usage）。 */
  realModel?: LanguageModel,
): VercelRun {
  const meter = new Meter();
  const audit: { tool: string; bytes: number }[] = [];
  const completed: VercelRun['completed'] = [];
  const rpcHost = safeHost(host);
  let toolCalls = 0;
  let toolN = 0;
  const tools: ToolSet = {};
  for (const def of AGENT_TOOL_DEFS) {
    tools[def.name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (args: unknown, { toolCallId }: { toolCallId: string }) => {
        toolCalls++;
        hooks.onToolStart?.(def.name);
        const result = await executeAgentTool(rpcHost, def.name, args);
        audit.push({ tool: def.name, bytes: Buffer.byteLength(JSON.stringify(result)) });
        completed.push({ toolCallId, toolName: def.name, input: args, output: result });
        hooks.onToolDone?.(def.name, ++toolN);
        return result as never;
      },
      // bridge 与 ai 的 zod 类型解析路径不同（app 里同一写法无需断言）；运行时形态一致
    } as never) as never;
  }
  const model = realModel ?? new MockLanguageModelV4({
    doStream: async (options) => {
      meter.record(
        JSON.stringify({ prompt: options.prompt, tools: options.tools }),
        canonicalVercel(options.prompt as never, (options.tools ?? []) as never),
      );
      const a = policy(viewFromVercel(options.prompt as never));
      meter.answer(a);
      return { stream: streamOf(a) };
    },
  });
  const loop: VercelRun = {
    meter,
    audit,
    completed,
    get toolCalls() {
      return toolCalls;
    },
    async run(messages, signal) {
      const result = streamText({
        model,
        instructions: systemPrompt,
        tools,
        stopWhen: stepCountIs(10),
        messages,
        ...(signal ? { abortSignal: signal } : {}),
      });
      await result.consumeStream();
      const [response, stepList, usage] = await Promise.all([result.response, result.steps, result.totalUsage]);
      return {
        responseMessages: response.messages,
        steps: stepList.length,
        usage: { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 },
      };
    },
  } as VercelRun;
  return loop;
}
