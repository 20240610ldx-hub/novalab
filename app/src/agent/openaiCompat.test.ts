import { describe, expect, it } from 'vitest';
import { convertPromptToOpenAIMessages, createOpenAICompat, mapFinishReason } from './openaiCompat';

/**
 * 本地 openai-compat provider（LanguageModelV3 最小实现）单测：
 * prompt 映射、finishReason 映射、doGenerate/doStream 的 wire 行为（mock fetch，不触网）。
 */

describe('convertPromptToOpenAIMessages', () => {
  it('system / user text / assistant tool-call / tool result 全链映射', () => {
    const out = convertPromptToOpenAIMessages([
      { role: 'system', content: 'rulebook' },
      { role: 'user', content: [{ type: 'text', text: 'fix it' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'getCellCode', input: { cellId: 'c1' } }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'getCellCode', output: { type: 'json', value: { code: 'x=1' } } }],
      },
    ]) as Array<Record<string, unknown>>;
    expect(out[0]).toEqual({ role: 'system', content: 'rulebook' });
    expect(out[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'fix it' }] });
    expect(out[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 't1', type: 'function', function: { name: 'getCellCode', arguments: '{"cellId":"c1"}' } },
      ],
    });
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 't1', content: '{"code":"x=1"}' });
  });
});

describe('mapFinishReason', () => {
  it('stop / length / tool_calls / content_filter / 未知', () => {
    expect(mapFinishReason('stop', false).unified).toBe('stop');
    expect(mapFinishReason('length', false).unified).toBe('length');
    expect(mapFinishReason('tool_calls', true).unified).toBe('tool-calls');
    expect(mapFinishReason('content_filter', false).unified).toBe('content-filter');
    expect(mapFinishReason('weird', false).unified).toBe('other');
    expect(mapFinishReason(null, true).unified).toBe('tool-calls');
  });
});

function mockFetchOnce(payload: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  };
  return { fetchImpl, calls };
}

describe('doGenerate（非流式）', () => {
  it('POST {baseURL}/chat/completions，映射 content/usage/finishReason', async () => {
    const { fetchImpl, calls } = mockFetchOnce({
      id: 'cmpl-1',
      model: 'deepseek-chat',
      choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    });
    const model = createOpenAICompat({ baseURL: 'https://api.deepseek.com/v1/', apiKey: 'sk', fetch: fetchImpl })('deepseek-chat');
    const m = model as unknown as {
      doGenerate: (o: unknown) => Promise<Record<string, unknown>>;
    };
    const res = await m.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] });
    expect(calls[0]!.url).toBe('https://api.deepseek.com/v1/chat/completions');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.model).toBe('deepseek-chat');
    expect(body.stream).toBe(false);
    const content = res.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'text', text: 'pong' });
    expect(res.finishReason).toEqual({ unified: 'stop', raw: 'stop' });
    const usage = res.usage as { inputTokens: { total: number }; outputTokens: { total: number } };
    expect(usage.inputTokens.total).toBe(3);
    expect(usage.outputTokens.total).toBe(1);
  });

  it('HTTP 错误 → 抛出带状态码与响应摘要的 Error', async () => {
    const fetchImpl = async () =>
      ({ ok: false, status: 401, text: async () => 'invalid api key' }) as unknown as Response;
    const model = createOpenAICompat({ baseURL: 'http://x/v1', apiKey: 'bad', fetch: fetchImpl })('m');
    const m = model as unknown as { doGenerate: (o: unknown) => Promise<unknown> };
    await expect(m.doGenerate({ prompt: [] })).rejects.toThrow(/HTTP 401.*invalid api key/);
  });
});

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(encoder.encode(l));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream, headers: new Headers() } as unknown as Response;
}

describe('doStream（SSE 流式）', () => {
  it('text delta → text-start/delta/end + finish；usage 尾包被吸收', async () => {
    const fetchImpl = async () =>
      sseResponse([
        'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"he"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]);
    const model = createOpenAICompat({ baseURL: 'http://x/v1', fetch: fetchImpl })('m');
    const m = model as unknown as { doStream: (o: unknown) => Promise<{ stream: ReadableStream<Record<string, unknown>> }> };
    const { stream } = await m.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
    const parts: Array<Record<string, unknown>> = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    const types = parts.map((p) => p.type);
    expect(types).toEqual([
      'stream-start',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'response-metadata',
      'finish',
    ]);
    expect(parts.find((p) => p.type === 'text-delta')).toMatchObject({ delta: 'he' });
    const finish = parts.find((p) => p.type === 'finish')!;
    expect(finish.finishReason).toEqual({ unified: 'stop', raw: 'stop' });
    expect((finish.usage as { outputTokens: { total: number } }).outputTokens.total).toBe(2);
  });

  it('流式 tool_calls 分片 → tool-input-start/delta/end + tool-call（拼接 arguments）', async () => {
    const fetchImpl = async () =>
      sseResponse([
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"listCells","arguments":"{\\"a\\":"}}]}}]}\n\n',
        // 注意：第二个 data 行必须是合法 JSON（choice 对象要有自己的闭合 }，finish_reason 在 choice 层）。
        // 此前该 fixture 少写一个 }（…"tool_calls"]… 直接闭了 choices 数组），doStream 的容错解析
        // （JSON.parse 失败 → 跳过该行，SSE 保活/垃圾行的标准容错）会整块丢弃它，
        // 于是第二段 arguments 分片与 finish_reason 都到不了断言——拼接逻辑本身没有问题。
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    const model = createOpenAICompat({ baseURL: 'http://x/v1', fetch: fetchImpl })('m');
    const m = model as unknown as { doStream: (o: unknown) => Promise<{ stream: ReadableStream<Record<string, unknown>> }> };
    const { stream } = await m.doStream({ prompt: [] });
    const parts: Array<Record<string, unknown>> = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    expect(parts.map((p) => p.type)).toEqual([
      'stream-start',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-delta',
      'tool-input-end',
      'tool-call',
      'finish',
    ]);
    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolCallId: 't1',
      toolName: 'listCells',
      input: '{"a":1}',
    });
    expect(parts.find((p) => p.type === 'finish')!.finishReason).toEqual({
      unified: 'tool-calls',
      raw: 'tool_calls',
    });
  });
});
