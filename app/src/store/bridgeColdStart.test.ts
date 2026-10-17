/**
 * 桌面冷启动竞态（A15 第 7b 轮真窗口 smoke 暴露）：WebView 先于 bridge 监听加载。
 * - 首次连接失败 → 进入既有有界重连循环（退避 + 预算），bridge 稍后上线即 connected，无需刷新；
 * - 状态监听与通知处理器无论首连成败都只注册一次；
 * - 未订阅过的 idle 状态下 retryBridge 也能驱动 UI；
 * - 预算耗尽 → down（沿用已有「重试连接」按钮），不无限循环（浏览器开发态同样有界）。
 * 用真实 BridgeClient + fake WebSocket/discovery + 注入时钟，不起真实 bridge。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  servers: new Set<number>(),
  now: 0,
  sleeps: [] as number[],
  /** 第 n 次退避等待时的钩子（模拟 bridge 在重连循环中途开始监听）。 */
  onSleep: null as null | ((count: number) => void),
  /** 每个用例新建的 BridgeClient（mock 工厂跨 resetModules 缓存，故经代理转发）。 */
  client: null as null | Record<string | symbol, unknown>,
}));

vi.mock('../bridge/client', async (load) => {
  const real = await load<typeof import('../bridge/client')>();
  const bridge = new Proxy({}, {
    get: (_target, key) => {
      const value = env.client![key];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(env.client) : value;
    },
  });
  return { ...real, bridge };
});

const TOKEN = 'cold-start-token';

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  private readonly port: number;

  constructor(url: string) {
    this.port = Number(new URL(url).port);
    queueMicrotask(() => {
      if (!env.servers.has(this.port)) {
        this.onerror?.();
        this.close();
        return;
      }
      this.onopen?.();
    });
  }

  send(data: string): void {
    const msg = JSON.parse(data) as { id: number; method: string };
    const result = msg.method === 'bridge.auth' ? { ok: true } : msg.method === 'notebook.list' ? [] : {};
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

function discoveryFetch(input: string | URL): Promise<Response> {
  const port = Number(new URL(String(input)).port);
  if (!env.servers.has(port)) return Promise.reject(new TypeError('fetch failed'));
  return Promise.resolve(new Response(JSON.stringify({
    version: 'test', wsPort: port, wsUrl: `ws://127.0.0.1:${port}/`, llmPort: port + 1,
    llmProxyOrigin: `http://127.0.0.1:${port + 1}`, token: TOKEN,
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
}

/** 每个用例拿到全新的 store 模块与 bridge 单例（模块级 connectPromise/订阅标记不跨用例泄漏）。 */
async function load() {
  vi.resetModules();
  const { BridgeClient } = await vi.importActual<typeof import('../bridge/client')>('../bridge/client');
  const bridge = new BridgeClient(undefined, {
    budgetMs: 3_000,
    now: () => env.now,
    sleep: async (ms) => {
      env.sleeps.push(ms);
      env.now += ms;
      env.onSleep?.(env.sleeps.length);
      await Promise.resolve();
    },
  });
  env.client = bridge as unknown as Record<string | symbol, unknown>;
  const onStatus = vi.spyOn(bridge, 'onStatus');
  const onNotification = vi.spyOn(bridge, 'onNotification');
  const connect = vi.spyOn(bridge, 'connect');
  const { useNotebook } = await import('./notebook');
  const statuses: string[] = [];
  useNotebook.subscribe((s, prev) => { if (s.bridgeStatus !== prev.bridgeStatus) statuses.push(s.bridgeStatus); });
  return { bridge, useNotebook, onStatus, onNotification, connect, statuses };
}

beforeEach(() => {
  env.servers.clear();
  env.now = 0;
  env.sleeps.length = 0;
  env.onSleep = null;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', vi.fn(discoveryFetch));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('desktop cold start: the WebView loads before the bridge listens', () => {
  it('reaches connected without a reload once the bridge comes up during the bounded reconnect', async () => {
    const { useNotebook, connect, statuses } = await load();
    env.onSleep = (n) => { if (n === 2) env.servers.add(7788); };

    await useNotebook.getState().connectBridge();

    expect(connect).toHaveBeenCalledTimes(1); // 首连仍是单次尝试，失败后交给重连循环
    expect(useNotebook.getState().bridgeStatus).toBe('connected');
    expect(useNotebook.getState().bridgeConnected).toBe(true);
    expect(statuses).toEqual(['reconnecting', 'connected']);
    expect(env.sleeps).toEqual([250, 500]);
  });

  it('registers the status listener and notification handler exactly once, even after a failed first attempt', async () => {
    const { useNotebook, onStatus, onNotification } = await load();
    env.onSleep = (n) => { if (n === 1) env.servers.add(7788); };

    await useNotebook.getState().connectBridge();
    await useNotebook.getState().connectBridge();
    await useNotebook.getState().retryBridge();

    expect(useNotebook.getState().bridgeStatus).toBe('connected');
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledTimes(1);
  });

  it('registers exactly once on a first-try success too', async () => {
    env.servers.add(7788);
    const { useNotebook, onStatus, onNotification } = await load();

    await useNotebook.getState().connectBridge();
    await useNotebook.getState().connectBridge();

    expect(useNotebook.getState().bridgeStatus).toBe('connected');
    expect(env.sleeps).toEqual([]);
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledTimes(1);
  });

  it('retryBridge from idle subscribes the store and drives it to connected', async () => {
    env.servers.add(7788);
    const { useNotebook, onStatus, onNotification } = await load();
    expect(useNotebook.getState().bridgeStatus).toBe('idle');

    await useNotebook.getState().retryBridge();
    expect(useNotebook.getState().bridgeStatus).toBe('connected');
    expect(useNotebook.getState().bridgeConnected).toBe(true);

    await useNotebook.getState().connectBridge(); // 之后的启动序列不重复订阅
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledTimes(1);
  });

  it('ends in down once the budget is spent (bounded, no endless loop), and the retry button recovers', async () => {
    const { useNotebook, statuses } = await load();

    await useNotebook.getState().connectBridge();

    expect(useNotebook.getState().bridgeStatus).toBe('down');
    expect(useNotebook.getState().bridgeConnected).toBe(false);
    expect(statuses).toEqual(['reconnecting', 'down']);
    expect(env.sleeps).toEqual([250, 500, 1000, 2000]); // 预算 3 s：累计等待越过预算即停
    const slept = env.sleeps.length;

    // App.tsx 的 bridge-down 横幅「重试连接」→ retryBridge：重置预算重新进入循环
    env.servers.add(7788);
    await useNotebook.getState().retryBridge();
    expect(useNotebook.getState().bridgeStatus).toBe('connected');
    expect(env.sleeps.length).toBe(slept + 1);
  });
});
