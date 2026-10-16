/**
 * LLM 请求的网络波动防御（Agent 栈 = Vercel AI SDK，ADR-003 / ADR-012 裁决）。
 *
 * 幂等边界：只在 Response 交给 SDK **之前** 重试 —— 此时尚未消费任何模型输出、
 * 未执行任何工具，重放同一请求（同 URL / method / headers / body）对 notebook 无副作用。
 * 流式响应一旦交出，中途断开（`terminated` 等）不在此重试：部分输出与工具调用可能已发生。
 *
 * 唯一重试层：streamText 需设 `maxRetries: 0`，否则 SDK 自带的 2 次重试会与本层相乘。
 * 直连 provider 与经 bridge llm-proxy 两条路径都包这一层；bridge 对配置类错误
 * 标 `x-novalab-retryable: 0`（重试无意义），上游不可达的 502 则照常重试。
 */

export interface RetryPolicy {
  /** 最多重试次数（不含首次请求）。 */
  maxRetries: number;
  /** 首个重试间隔；之后指数翻倍。 */
  initialDelayMs: number;
  /** 指数退避封顶。 */
  maxDelayMs: number;
  /** 服务端 Retry-After 超过此值则不再等待，直接返回该响应。 */
  maxServerDelayMs: number;
  /** 向上抖动比例：实际间隔 ∈ [base, base × (1 + jitter)]，避免并发请求同步重试。 */
  jitter: number;
}

export const LLM_RETRY_POLICY: RetryPolicy = {
  maxRetries: 10,
  initialDelayMs: 500,
  maxDelayMs: 8_000,
  maxServerDelayMs: 60_000,
  jitter: 0.2,
};

export interface RetryInfo {
  /** 第几次重试（1 起）。 */
  attempt: number;
  delayMs: number;
  /** 'network: <message>' 或 'status <code>'；不含 URL / 头 / 请求体。 */
  reason: string;
}

export interface RetryingFetchOptions {
  policy?: RetryPolicy;
  random?: () => number;
  /** 可中止的等待；测试注入以免真实计时。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (info: RetryInfo) => void;
}

/** 408 超时 / 409 锁冲突 / 425 过早 / 429 限流 / 5xx（501 未实现除外，529 = Anthropic 过载）。 */
function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  return status >= 500 && status !== 501;
}

export function retryDelayMs(retryIndex: number, policy: RetryPolicy = LLM_RETRY_POLICY, random: () => number = Math.random): number {
  const base = Math.min(policy.initialDelayMs * 2 ** retryIndex, policy.maxDelayMs);
  return Math.round(base * (1 + random() * policy.jitter));
}

/** Retry-After（秒或 HTTP 日期）/ retry-after-ms；无或无法解析返回 null。 */
function serverDelayMs(res: Response): number | null {
  const ms = res.headers.get('retry-after-ms');
  if (ms !== null) {
    const value = Number.parseFloat(ms);
    if (Number.isFinite(value)) return Math.max(0, value);
  }
  const after = res.headers.get('retry-after');
  if (after !== null) {
    const seconds = Number.parseFloat(after);
    const value = Number.isNaN(seconds) ? Date.parse(after) - Date.now() : seconds * 1000;
    if (Number.isFinite(value)) return Math.max(0, value);
  }
  return null;
}

/** 返回 false = 不重试；否则返回本次等待毫秒数。 */
function retryDecision(res: Response, retryIndex: number, policy: RetryPolicy, random: () => number): number | false {
  if (res.headers.get('x-novalab-retryable') === '0') return false;
  const shouldRetry = res.headers.get('x-should-retry');
  if (shouldRetry === 'false') return false;
  if (shouldRetry !== 'true' && !isRetryableStatus(res.status)) return false;
  const requested = serverDelayMs(res);
  if (requested !== null) return requested > policy.maxServerDelayMs ? false : requested;
  return retryDelayMs(retryIndex, policy, random);
}

/** 只有能原样重放的请求体才允许重试；Request 对象或流式 body 只尝试一次。 */
function isReplayable(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (typeof Request !== 'undefined' && input instanceof Request && input.body !== null) return false;
  const body = init?.body;
  return !(typeof ReadableStream !== 'undefined' && body instanceof ReadableStream);
}

function isAbort(error: unknown, signal?: AbortSignal | null): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && error.name === 'AbortError');
}

function abortError(signal?: AbortSignal | null): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function defaultOnRetry(info: RetryInfo): void {
  console.warn(`[llm] retry ${info.attempt}/${LLM_RETRY_POLICY.maxRetries} in ${info.delayMs} ms (${info.reason})`);
}

export function createRetryingFetch(base: typeof fetch = (input, init) => fetch(input, init), options: RetryingFetchOptions = {}): typeof fetch {
  const policy = options.policy ?? LLM_RETRY_POLICY;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const onRetry = options.onRetry ?? defaultOnRetry;

  return async (input, init) => {
    const signal = init?.signal ?? undefined;
    const replayable = isReplayable(input, init);
    for (let retryIndex = 0; ; retryIndex += 1) {
      const canRetry = replayable && retryIndex < policy.maxRetries;
      let delayMs: number;
      let reason: string;
      try {
        const res = await base(input, init);
        const decision = canRetry ? retryDecision(res, retryIndex, policy, random) : false;
        if (decision === false) return res;
        await res.body?.cancel().catch(() => {});
        delayMs = decision;
        reason = `status ${res.status}`;
      } catch (error) {
        if (!canRetry || isAbort(error, signal)) throw error;
        delayMs = retryDelayMs(retryIndex, policy, random);
        reason = `network: ${error instanceof Error ? error.message : String(error)}`;
      }
      onRetry({ attempt: retryIndex + 1, delayMs, reason });
      await sleep(delayMs, signal);
      // 用户在等待期间停止生成：不再发起新请求
      if (signal?.aborted) throw abortError(signal);
    }
  };
}

/** Agent 全部 LLM 请求共用的重试 fetch。 */
export const llmFetch: typeof fetch = createRetryingFetch();
