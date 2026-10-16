import { describe, expect, it, vi } from 'vitest';
import { LLM_RETRY_POLICY, createRetryingFetch, retryDelayMs } from './retryFetch';

/**
 * LLM 请求的网络波动防御：只在响应交给 SDK 之前重试（尚未消费任何输出、
 * 未执行任何工具），因此重放同一请求是幂等的。sleep / random 注入，测试不等真实时间。
 */

type FetchMock = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

function harness(fetchImpl: FetchMock, extra: { random?: () => number } = {}) {
  const sleeps: number[] = [];
  const retries: Array<{ attempt: number; delayMs: number; reason: string }> = [];
  const wrapped = createRetryingFetch(fetchImpl as unknown as typeof fetch, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: extra.random ?? (() => 0),
    onRetry: (info) => retries.push(info),
  });
  return { wrapped, sleeps, retries };
}

const networkError = () => new TypeError('fetch failed: ECONNRESET');
const ok = () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
const status = (code: number, headers: Record<string, string> = {}) => new Response('{"error":"x"}', { status: code, headers });
const post = { method: 'POST', body: '{"model":"m"}' } satisfies RequestInit;

describe('retryDelayMs', () => {
  it('从 0.5 s 开始指数翻倍，封顶 8 s', () => {
    const delays = Array.from({ length: LLM_RETRY_POLICY.maxRetries }, (_, i) => retryDelayMs(i, LLM_RETRY_POLICY, () => 0));
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 8000]);
  });

  it('抖动只向上（最多 +20%），首个间隔不低于 0.5 s，封顶后也不超过 8 s × 1.2', () => {
    expect(retryDelayMs(0, LLM_RETRY_POLICY, () => 0.999)).toBeGreaterThanOrEqual(500);
    expect(retryDelayMs(0, LLM_RETRY_POLICY, () => 0.999)).toBeLessThanOrEqual(600);
    expect(retryDelayMs(9, LLM_RETRY_POLICY, () => 0.999)).toBeLessThanOrEqual(9600);
  });
});

describe('createRetryingFetch', () => {
  it('网络错误后重试，成功即返回；间隔 0.5 → 1 → 2 s', async () => {
    const fetchImpl: FetchMock = vi.fn()
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce(ok());
    const { wrapped, sleeps, retries } = harness(fetchImpl);
    const res = await wrapped('https://llm.example/v1/chat/completions', post);
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
    expect(retries.map((r) => r.attempt)).toEqual([1, 2, 3]);
  });

  it('每次重放的请求完全相同（同 URL / method / body / headers）', async () => {
    const fetchImpl: FetchMock = vi.fn().mockRejectedValueOnce(networkError()).mockResolvedValueOnce(ok());
    const { wrapped } = harness(fetchImpl);
    await wrapped('https://llm.example/v1/messages', { ...post, headers: { 'x-api-key': 'proxy' } });
    const [first, second] = fetchImpl.mock.calls;
    expect(second).toEqual(first);
  });

  it('网络错误最多重试 10 次（共 11 次尝试），用尽后抛出最后一个错误', async () => {
    const fetchImpl: FetchMock = vi.fn().mockRejectedValue(networkError());
    const { wrapped, sleeps } = harness(fetchImpl);
    await expect(wrapped('https://llm.example/v1/messages', post)).rejects.toThrow('ECONNRESET');
    expect(fetchImpl).toHaveBeenCalledTimes(11);
    expect(sleeps).toHaveLength(10);
  });

  it.each([408, 409, 425, 429, 500, 502, 503, 504, 529])('可重试状态 %i：重试后成功', async (code) => {
    const fetchImpl: FetchMock = vi.fn().mockResolvedValueOnce(status(code)).mockResolvedValueOnce(ok());
    const { wrapped } = harness(fetchImpl);
    expect((await wrapped('https://llm.example/v1/messages', post)).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('可重试状态用尽后返回最后一个响应（不抛），交给 SDK 生成 APICallError', async () => {
    const fetchImpl: FetchMock = vi.fn().mockImplementation(async () => status(503));
    const { wrapped } = harness(fetchImpl);
    const res = await wrapped('https://llm.example/v1/messages', post);
    expect(res.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(11);
  });

  it('被丢弃的可重试响应会 cancel 其 body，不留悬挂连接', async () => {
    const cancel = vi.fn(async () => {});
    const stale = status(503);
    Object.defineProperty(stale, 'body', { value: { cancel } });
    const fetchImpl: FetchMock = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(ok());
    const { wrapped } = harness(fetchImpl);
    await wrapped('https://llm.example/v1/messages', post);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404, 413, 422, 501])('不可重试状态 %i：只请求一次', async (code) => {
    const fetchImpl: FetchMock = vi.fn().mockResolvedValue(status(code));
    const { wrapped } = harness(fetchImpl);
    expect((await wrapped('https://llm.example/v1/messages', post)).status).toBe(code);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('bridge 标记 x-novalab-retryable: 0（配置错误）→ 不重试', async () => {
    const fetchImpl: FetchMock = vi.fn().mockResolvedValue(status(502, { 'x-novalab-retryable': '0' }));
    const { wrapped } = harness(fetchImpl);
    expect((await wrapped('http://127.0.0.1:7789/llm/p/v1/messages', post)).status).toBe(502);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('上游 x-should-retry 优先于状态码判断', async () => {
    const forbid: FetchMock = vi.fn().mockResolvedValue(status(503, { 'x-should-retry': 'false' }));
    expect((await harness(forbid).wrapped('https://llm.example/v1/messages', post)).status).toBe(503);
    expect(forbid).toHaveBeenCalledTimes(1);
    const force: FetchMock = vi.fn().mockResolvedValueOnce(status(400, { 'x-should-retry': 'true' })).mockResolvedValueOnce(ok());
    expect((await harness(force).wrapped('https://llm.example/v1/messages', post)).status).toBe(200);
    expect(force).toHaveBeenCalledTimes(2);
  });

  it('遵守 Retry-After（秒）与 retry-after-ms', async () => {
    const fetchImpl: FetchMock = vi.fn()
      .mockResolvedValueOnce(status(429, { 'retry-after': '3' }))
      .mockResolvedValueOnce(status(429, { 'retry-after-ms': '1500' }))
      .mockResolvedValueOnce(ok());
    const { wrapped, sleeps } = harness(fetchImpl);
    await wrapped('https://llm.example/v1/messages', post);
    expect(sleeps).toEqual([3000, 1500]);
  });

  it('服务端要求的等待超过 60 s → 不再等待，直接返回该响应', async () => {
    const fetchImpl: FetchMock = vi.fn().mockResolvedValue(status(429, { 'retry-after': '120' }));
    const { wrapped, sleeps } = harness(fetchImpl);
    expect((await wrapped('https://llm.example/v1/messages', post)).status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('用户中止（停止生成）：等待中立即结束，不再发起请求', async () => {
    const controller = new AbortController();
    const fetchImpl: FetchMock = vi.fn().mockRejectedValue(networkError());
    const wrapped = createRetryingFetch(fetchImpl as unknown as typeof fetch, {
      random: () => 0,
      sleep: async () => {
        controller.abort();
      },
    });
    await expect(wrapped('https://llm.example/v1/messages', { ...post, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fetch 因中止而拒绝 → 原样抛出，不重试', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl: FetchMock = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const { wrapped } = harness(fetchImpl);
    await expect(wrapped('https://llm.example/v1/messages', { ...post, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('请求体是不可重放的 ReadableStream → 只尝试一次', async () => {
    const fetchImpl: FetchMock = vi.fn().mockRejectedValue(networkError());
    const { wrapped } = harness(fetchImpl);
    const body = new ReadableStream({ start: (c) => c.close() });
    await expect(wrapped('https://llm.example/v1/messages', { method: 'POST', body })).rejects.toThrow('ECONNRESET');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('响应已交给调用方后（流式中途断开）不重试：包装器只返回一次', async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: partial\n\n'));
        c.error(new TypeError('terminated'));
      },
    });
    const fetchImpl: FetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    const { wrapped } = harness(fetchImpl);
    const res = await wrapped('https://llm.example/v1/messages', post);
    await expect(res.text()).rejects.toThrow('terminated');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
