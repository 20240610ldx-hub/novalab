import type { LanguageModel } from 'ai';

/**
 * 极简 OpenAI 兼容 provider（LanguageModelV3，M6 模型解耦的 openai-compat 腿）。
 *
 * 为什么手写：@ai-sdk/openai 未安装且 P2.1 文件所有权禁止改 package.json；
 * ai v7 re-export 的 createGateway 走 gateway 私有协议（POST {baseURL}/language-model），
 * 不兼容 deepseek/ollama 的 /chat/completions，故按 @ai-sdk/provider@4.0.22 的
 * LanguageModelV3 规范实现最小可用子集：文本 + reasoning + 工具调用（流式/非流式）。
 *
 * 覆盖场景：deepseek、ollama(/v1)、vLLM 等 OpenAI 兼容端点。
 * 不覆盖：多模态文件（仅 image data-URL 尽力转换）、provider-defined tools、审批流。
 * P4 装上 @ai-sdk/openai 后本文件可整体替换（接口对齐 createOpenAI({baseURL,apiKey})）。
 */

/* ---------------- 本地结构类型（镜像 @ai-sdk/provider v3 规范，避免未声明依赖） ---------------- */

interface V3TextPart {
  type: 'text';
  text: string;
}
interface V3ReasoningPart {
  type: 'reasoning';
  text: string;
}
interface V3FilePart {
  type: 'file';
  data: Uint8Array | string | URL;
  mediaType: string;
  filename?: string;
}
interface V3ToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: unknown;
}
interface V3ToolResultOutput {
  type: string;
  value?: unknown;
  reason?: string;
}
interface V3ToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: V3ToolResultOutput;
}
interface V3ApprovalResponsePart {
  type: 'tool-approval-response';
  approvalId: string;
  approved: boolean;
  reason?: string;
}
type V3Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: Array<V3TextPart | V3FilePart> }
  | {
      role: 'assistant';
      content: Array<V3TextPart | V3FilePart | V3ReasoningPart | V3ToolCallPart | V3ToolResultPart>;
    }
  | { role: 'tool'; content: Array<V3ToolResultPart | V3ApprovalResponsePart> };
type V3Prompt = V3Message[];

interface V3FunctionTool {
  type: 'function';
  name: string;
  description?: string;
  inputSchema: unknown;
}
interface V3ToolChoice {
  type: 'auto' | 'none' | 'required' | 'tool';
  toolName?: string;
}
interface V3CallOptions {
  prompt: V3Prompt;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  tools?: Array<V3FunctionTool | { type: 'provider' }>;
  toolChoice?: V3ToolChoice;
  abortSignal?: AbortSignal;
  headers?: Record<string, string | undefined>;
  responseFormat?: { type: 'text' } | { type: 'json'; schema?: unknown };
}

type V3Usage = {
  inputTokens: { total: number | undefined; noCache: number | undefined; cacheRead: number | undefined; cacheWrite: number | undefined };
  outputTokens: { total: number | undefined; text: number | undefined; reasoning: number | undefined };
  raw?: Record<string, unknown>;
};
type V3FinishReason = { unified: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'; raw: string | undefined };

type V3StreamPart =
  | { type: 'stream-start'; warnings: unknown[] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'reasoning-end'; id: string }
  | { type: 'tool-input-start'; id: string; toolName: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-input-end'; id: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  | { type: 'response-metadata'; id?: string; timestamp?: Date; modelId?: string }
  | { type: 'finish'; finishReason: V3FinishReason; usage: V3Usage }
  | { type: 'error'; error: unknown };

/* ---------------- OpenAI chat-completions wire 形态 ---------------- */

type OaiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | Array<Record<string, unknown>> }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

function fileToUrl(p: V3FilePart): string {
  if (p.data instanceof URL) return p.data.href;
  if (typeof p.data === 'string') {
    // 规范：string data 即 base64
    return p.data.startsWith('data:') ? p.data : `data:${p.mediaType};base64,${p.data}`;
  }
  let bin = '';
  for (const b of p.data) bin += String.fromCharCode(b);
  return `data:${p.mediaType};base64,${btoa(bin)}`;
}

function toolOutputToText(output: V3ToolResultOutput): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return String(output.value ?? '');
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value ?? null);
    case 'execution-denied':
      return `[execution denied] ${output.reason ?? ''}`;
    default:
      return JSON.stringify(output) ;
  }
}

/** V3 prompt → OpenAI messages（导出供单测；reasoning 历史不回传，OpenAI 协议不收）。 */
export function convertPromptToOpenAIMessages(prompt: V3Prompt): OaiMessage[] {
  const out: OaiMessage[] = [];
  for (const m of prompt) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content });
    } else if (m.role === 'user') {
      out.push({
        role: 'user',
        content: m.content.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'image_url', image_url: { url: fileToUrl(p) } },
        ),
      });
    } else if (m.role === 'assistant') {
      const msg: Extract<OaiMessage, { role: 'assistant' }> = { role: 'assistant', content: null };
      let text = '';
      for (const p of m.content) {
        if (p.type === 'text') text += p.text;
        else if (p.type === 'tool-call') {
          msg.tool_calls ??= [];
          msg.tool_calls.push({
            id: p.toolCallId,
            type: 'function',
            function: {
              name: p.toolName,
              arguments: typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? {}),
            },
          });
        }
      }
      if (text) msg.content = text;
      out.push(msg);
    } else if (m.role === 'tool') {
      for (const p of m.content) {
        if (p.type === 'tool-result') {
          out.push({ role: 'tool', tool_call_id: p.toolCallId, content: toolOutputToText(p.output) });
        } else if (p.type === 'tool-approval-response') {
          out.push({
            role: 'tool',
            tool_call_id: p.approvalId,
            content: p.approved ? '[approved]' : `[denied] ${p.reason ?? ''}`,
          });
        }
      }
    }
  }
  return out;
}

export function mapFinishReason(raw: string | null | undefined, hadToolCalls: boolean): V3FinishReason {
  const unified =
    raw === 'length'
      ? 'length'
      : raw === 'content_filter'
        ? 'content-filter'
        : raw === 'tool_calls' || (hadToolCalls && raw == null)
          ? 'tool-calls'
          : raw === 'stop' || raw == null
            ? hadToolCalls
              ? 'tool-calls'
              : 'stop'
            : 'other';
  return { unified, raw: raw ?? undefined };
}

function mapUsage(u: Record<string, unknown> | undefined | null): V3Usage {
  const details = (u?.completion_details ?? u?.completion_tokens_details ?? {}) as Record<string, unknown>;
  const promptDetails = (u?.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  return {
    inputTokens: {
      total: num(u?.prompt_tokens),
      noCache: undefined,
      cacheRead: num(promptDetails.cached_tokens),
      cacheWrite: undefined,
    },
    outputTokens: {
      total: num(u?.completion_tokens),
      text: undefined,
      reasoning: num(details.reasoning_tokens),
    },
    raw: (u as Record<string, unknown> | undefined) ?? undefined,
  };
}

/* ---------------- model 实现 ---------------- */

export type OpenAICompatFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAICompatProviderSettings {
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** 单测注入点。 */
  fetch?: OpenAICompatFetch;
}

class OpenAICompatChatModel {
  readonly specificationVersion = 'v3' as const;
  readonly provider = 'openai-compat';
  readonly supportedUrls: Record<string, RegExp[]> = { 'image/*': [/^data:/, /^https?:\/\//] };

  private readonly url: string;
  private readonly fetchImpl: OpenAICompatFetch;
  private readonly baseHeaders: Record<string, string>;

  constructor(
    readonly modelId: string,
    settings: OpenAICompatProviderSettings,
  ) {
    this.url = `${settings.baseURL.replace(/\/+$/, '')}/chat/completions`;
    this.fetchImpl = settings.fetch ?? ((u, init) => fetch(u, init));
    this.baseHeaders = {
      'content-type': 'application/json',
      ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
      ...settings.headers,
    };
  }

  private buildBody(options: V3CallOptions, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.modelId,
      messages: convertPromptToOpenAIMessages(options.prompt),
      stream,
    };
    const fnTools = (options.tools ?? []).filter((t): t is V3FunctionTool => t.type === 'function');
    if (fnTools.length > 0) {
      body.tools = fnTools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
      if (options.toolChoice) {
        body.tool_choice =
          options.toolChoice.type === 'tool'
            ? { type: 'function', function: { name: options.toolChoice.toolName } }
            : options.toolChoice.type;
      }
    }
    if (options.temperature != null) body.temperature = options.temperature;
    if (options.topP != null) body.top_p = options.topP;
    if (options.maxOutputTokens != null) body.max_tokens = options.maxOutputTokens;
    if (options.stopSequences?.length) body.stop = options.stopSequences;
    if (options.seed != null) body.seed = options.seed;
    if (options.presencePenalty != null) body.presence_penalty = options.presencePenalty;
    if (options.frequencyPenalty != null) body.frequency_penalty = options.frequencyPenalty;
    if (options.responseFormat?.type === 'json') body.response_format = { type: 'json_object' };
    if (stream) body.stream_options = { include_usage: true };
    return body;
  }

  private async post(body: Record<string, unknown>, options: V3CallOptions): Promise<Response> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        ...this.baseHeaders,
        ...(options.headers ?? {}),
      } as Record<string, string>,
      body: JSON.stringify(body),
      signal: options.abortSignal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`openai-compat HTTP ${res.status}: ${detail.slice(0, 500)}`);
    }
    return res;
  }

  async doGenerate(options: V3CallOptions) {
    const body = this.buildBody(options, false);
    const res = await this.post(body, options);
    const json = (await res.json()) as Record<string, unknown>;
    const choice = ((json.choices as Array<Record<string, unknown>> | undefined) ?? [])[0];
    const message = (choice?.message ?? {}) as Record<string, unknown>;
    const content: Array<Record<string, unknown>> = [];
    const reasoning = message.reasoning_content ?? message.reasoning;
    if (typeof reasoning === 'string' && reasoning) content.push({ type: 'reasoning', text: reasoning });
    if (typeof message.content === 'string' && message.content) {
      content.push({ type: 'text', text: message.content });
    }
    const toolCalls = (message.tool_calls ?? []) as Array<Record<string, unknown>>;
    for (const tc of toolCalls) {
      const fn = (tc.function ?? {}) as Record<string, unknown>;
      content.push({
        type: 'tool-call',
        toolCallId: String(tc.id ?? ''),
        toolName: String(fn.name ?? ''),
        input: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? '{}'),
      });
    }
    return {
      content,
      finishReason: mapFinishReason(choice?.finish_reason as string | null, toolCalls.length > 0),
      usage: mapUsage(json.usage as Record<string, unknown> | undefined),
      warnings: [],
      request: { body },
      response: {
        id: typeof json.id === 'string' ? json.id : undefined,
        modelId: typeof json.model === 'string' ? json.model : undefined,
        timestamp: new Date(),
      },
    };
  }

  async doStream(options: V3CallOptions) {
    const body = this.buildBody(options, true);
    const res = await this.post(body, options);
    if (!res.body) throw new Error('openai-compat: 流式响应缺少 body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let responseId: string | undefined;
    let responseModelId: string | undefined;

    const stream = new ReadableStream<V3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        let buf = '';
        let textId: string | null = null;
        let reasoningId: string | null = null;
        const pendingTools = new Map<number, { id: string; name: string; args: string; started: boolean }>();
        let finishRaw: string | null = null;
        let usage: V3Usage = mapUsage(null);

        const flushTool = (t: { id: string; name: string; args: string; started: boolean }) => {
          if (t.started) controller.enqueue({ type: 'tool-input-end', id: t.id });
          controller.enqueue({ type: 'tool-call', toolCallId: t.id, toolName: t.name, input: t.args || '{}' });
        };

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (data === '[DONE]') continue;
              let chunk: Record<string, unknown>;
              try {
                chunk = JSON.parse(data) as Record<string, unknown>;
              } catch {
                continue;
              }
              if (typeof chunk.id === 'string') responseId = chunk.id;
              if (typeof chunk.model === 'string') responseModelId = chunk.model;
              if (chunk.usage) usage = mapUsage(chunk.usage as Record<string, unknown>);
              const choice = ((chunk.choices as Array<Record<string, unknown>> | undefined) ?? [])[0];
              if (!choice) continue;
              const delta = (choice.delta ?? {}) as Record<string, unknown>;

              const reasoning = delta.reasoning_content ?? delta.reasoning;
              if (typeof reasoning === 'string' && reasoning) {
                if (reasoningId == null) {
                  reasoningId = 'reasoning-0';
                  controller.enqueue({ type: 'reasoning-start', id: reasoningId });
                }
                controller.enqueue({ type: 'reasoning-delta', id: reasoningId, delta: reasoning });
              }
              if (typeof delta.content === 'string' && delta.content) {
                if (textId == null) {
                  textId = 'text-0';
                  controller.enqueue({ type: 'text-start', id: textId });
                }
                controller.enqueue({ type: 'text-delta', id: textId, delta: delta.content });
              }
              const tcs = (delta.tool_calls ?? []) as Array<Record<string, unknown>>;
              for (const tc of tcs) {
                const idx = typeof tc.index === 'number' ? tc.index : 0;
                const fn = (tc.function ?? {}) as Record<string, unknown>;
                let pending = pendingTools.get(idx);
                if (!pending) {
                  pending = { id: String(tc.id ?? `call-${idx}`), name: String(fn.name ?? ''), args: '', started: false };
                  pendingTools.set(idx, pending);
                }
                if (tc.id != null && typeof tc.id === 'string') pending.id = tc.id;
                if (fn.name) pending.name = String(fn.name);
                if (typeof fn.arguments === 'string' && fn.arguments) {
                  if (!pending.started) {
                    pending.started = true;
                    controller.enqueue({ type: 'tool-input-start', id: pending.id, toolName: pending.name });
                  }
                  controller.enqueue({ type: 'tool-input-delta', id: pending.id, delta: fn.arguments });
                  pending.args += fn.arguments;
                }
              }
              if (typeof choice.finish_reason === 'string') finishRaw = choice.finish_reason;
            }
          }
          if (reasoningId != null) controller.enqueue({ type: 'reasoning-end', id: reasoningId });
          if (textId != null) controller.enqueue({ type: 'text-end', id: textId });
          for (const t of pendingTools.values()) flushTool(t);
          if (responseId || responseModelId) {
            controller.enqueue({ type: 'response-metadata', id: responseId, modelId: responseModelId, timestamp: new Date() });
          }
          controller.enqueue({
            type: 'finish',
            finishReason: mapFinishReason(finishRaw, pendingTools.size > 0),
            usage,
          });
          controller.close();
        } catch (err) {
          controller.enqueue({ type: 'error', error: err });
          controller.close();
        }
      },
      cancel() {
        void reader.cancel().catch(() => {});
      },
    });

    return { stream, request: { body } };
  }
}

/** createOpenAI({baseURL,apiKey}) 的对等入口（deepseek / ollama / vLLM 走 OpenAI 兼容协议）。 */
export function createOpenAICompat(settings: OpenAICompatProviderSettings): (modelId: string) => LanguageModel {
  return (modelId: string) => new OpenAICompatChatModel(modelId, settings) as unknown as LanguageModel;
}
