/**
 * BridgeClient 断线重连状态机（第 6 轮 A15 子包：bridge 死亡 → 桌面重连）。
 * Fake WebSocket + fake discovery fetch；退避等待与时钟注入，不起真实 bridge。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeClient,
  BridgeDisconnectedError,
  RECONNECT_BACKOFF_MS,
  type BridgeStatusEvent,
} from './client';

interface FakeServer {
  token: string;
  /** 已认证后对普通 RPC 自动回 result（false = 挂起，模拟长运行）。 */
  autoReply: boolean;
}

let servers: Map<number, FakeServer>;
let sockets: FakeWebSocket[];

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  readonly port: number;

  constructor(readonly url: string) {
    this.port = Number(new URL(url).port);
    sockets.push(this);
    queueMicrotask(() => {
      if (!servers.has(this.port)) {
        this.onerror?.();
        this.fireClose();
        return;
      }
      this.onopen?.();
    });
  }

  send(data: string): void {
    if (this.closed) throw new Error('socket closed');
    const msg = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(msg);
    const server = servers.get(this.port);
    if (!server) return;
    if (msg.method === 'bridge.auth') {
      const ok = (msg.params as { token?: string }).token === server.token;
      queueMicrotask(() =>
        this.onmessage?.({
          data: JSON.stringify(
            ok
              ? { jsonrpc: '2.0', id: msg.id, result: { ok: true, llmProxyOrigin: `http://127.0.0.1:${this.port + 1}` } }
              : { jsonrpc: '2.0', id: msg.id, error: { code: -32003, message: 'unauthorized' } },
          ),
        }),
      );
      return;
    }
    if (server.autoReply) {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echo: msg.method } }) }));
    }
  }

  close(): void {
    this.fireClose();
  }

  /** 模拟 bridge 进程死亡：服务端断开。 */
  fireClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

function discoveryFetch(input: string | URL): Promise<Response> {
  const port = Number(new URL(String(input)).port);
  const server = servers.get(port);
  if (!server) return Promise.reject(new TypeError('fetch failed'));
  return Promise.resolve(
    new Response(
      JSON.stringify({
        version: 'test',
        wsPort: port,
        wsUrl: `ws://127.0.0.1:${port}/`,
        llmPort: port + 1,
        llmProxyOrigin: `http://127.0.0.1:${port + 1}`,
        token: server.token,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
}

/** 注入时钟：sleep 立即返回但推进 now，记录退避序列。 */
function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
      await Promise.resolve();
    },
  };
}

async function settle(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

function liveSocket(): FakeWebSocket {
  const s = [...sockets].reverse().find((x) => !x.closed);
  if (!s) throw new Error('no live socket');
  return s;
}

beforeEach(() => {
  servers = new Map([[7788, { token: 'gen-1', autoReply: true }]]);
  sockets = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', vi.fn(discoveryFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BridgeClient reconnect state machine', () => {
  it('settles pending RPCs with BridgeDisconnectedError when the bridge dies, then reports reconnecting', async () => {
    const clock = fakeClock();
    const client = new BridgeClient(undefined, { sleep: clock.sleep, now: clock.now, budgetMs: 1_000 });
    const events: BridgeStatusEvent[] = [];
    client.onStatus((e) => events.push(e));
    await client.connect();
    expect(client.getStatus()).toBe('connected');

    servers.get(7788)!.autoReply = false;
    const pending = client.rpc('cell.run', { cellId: 'a' });
    servers.delete(7788); // 进程死亡：端口不再监听
    liveSocket().fireClose();

    await expect(pending).rejects.toBeInstanceOf(BridgeDisconnectedError);
    expect(events.map((e) => e.status).slice(0, 2)).toEqual(['connected', 'reconnecting']);
  });

  it('fails new RPCs immediately while reconnecting without sending or queueing them', async () => {
    const gate: { release?: () => void } = {};
    const client = new BridgeClient(undefined, {
      now: () => 0,
      sleep: () => new Promise<void>((resolve) => { gate.release = resolve; }),
    });
    await client.connect();
    servers.delete(7788);
    const before = sockets.length;
    liveSocket().fireClose();
    await settle();
    expect(client.getStatus()).toBe('reconnecting');

    await expect(client.rpc('cell.save', { cellId: 'a', code: 'x' })).rejects.toBeInstanceOf(BridgeDisconnectedError);
    // 不排队：重连成功后也不会补发
    servers.set(7788, { token: 'gen-2', autoReply: true });
    gate.release?.();
    await settle(200);
    expect(client.getStatus()).toBe('connected');
    const replayed = sockets.slice(before).flatMap((s) => s.sent).filter((m) => m.method === 'cell.save');
    expect(replayed).toHaveLength(0);
  });

  it('re-discovers and re-authenticates against a new bridge instance (new token → new generation)', async () => {
    const clock = fakeClock();
    const client = new BridgeClient(undefined, { sleep: clock.sleep, now: clock.now });
    const events: BridgeStatusEvent[] = [];
    client.onStatus((e) => events.push(e));
    await client.connect();
    expect(client.getGeneration()).toBe(1);

    servers.delete(7788);
    servers.set(7790, { token: 'gen-2', autoReply: true }); // 新进程落到另一端口
    liveSocket().fireClose();
    await settle(400);

    expect(client.getStatus()).toBe('connected');
    expect(client.getGeneration()).toBe(2);
    expect(events.at(-1)).toMatchObject({ status: 'connected', generation: 2, newInstance: true });
    const auth = liveSocket().sent.find((m) => m.method === 'bridge.auth');
    expect((auth?.params as { token: string }).token).toBe('gen-2');
    expect(client.getLlmProxyOrigin()).toBe('http://127.0.0.1:7791');
    await expect(client.rpc('notebook.list')).resolves.toEqual({ echo: 'notebook.list' });
  });

  it('treats a re-auth with the same token as the same instance (generation unchanged)', async () => {
    const clock = fakeClock();
    const client = new BridgeClient(undefined, { sleep: clock.sleep, now: clock.now });
    const events: BridgeStatusEvent[] = [];
    client.onStatus((e) => events.push(e));
    await client.connect();
    liveSocket().fireClose(); // 只断 WS，进程仍在
    await settle(200);
    expect(client.getGeneration()).toBe(1);
    expect(events.at(-1)).toMatchObject({ status: 'connected', generation: 1, newInstance: false });
  });

  it('backs off with the bounded schedule and goes down once the budget is spent', async () => {
    const clock = fakeClock();
    const client = new BridgeClient(undefined, { sleep: clock.sleep, now: clock.now, budgetMs: 20_000 });
    const events: BridgeStatusEvent[] = [];
    client.onStatus((e) => events.push(e));
    await client.connect();
    servers.clear();
    liveSocket().fireClose();
    await settle(2_000);

    expect(client.getStatus()).toBe('down');
    expect(events.at(-1)).toMatchObject({ status: 'down' });
    const cap = RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1]!;
    expect(clock.sleeps.slice(0, RECONNECT_BACKOFF_MS.length)).toEqual(RECONNECT_BACKOFF_MS);
    expect(clock.sleeps.every((ms) => ms <= cap)).toBe(true);
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20_000 + cap);

    // down 后不再自动尝试
    const attempts = sockets.length;
    await settle(200);
    expect(sockets.length).toBe(attempts);
    await expect(client.rpc('notebook.list')).rejects.toBeInstanceOf(BridgeDisconnectedError);
  });

  it('retry() from down resets the budget and reconnects', async () => {
    const clock = fakeClock();
    const client = new BridgeClient(undefined, { sleep: clock.sleep, now: clock.now, budgetMs: 1_000 });
    await client.connect();
    servers.clear();
    liveSocket().fireClose();
    await settle(1_000);
    expect(client.getStatus()).toBe('down');

    servers.set(7788, { token: 'gen-3', autoReply: true });
    await client.retry();
    expect(client.getStatus()).toBe('connected');
    expect(client.getGeneration()).toBe(2);
  });

  it('does not start a reconnect loop when the initial connect fails', async () => {
    servers.clear();
    const clock = fakeClock();
    const client = new BridgeClient(undefined, { sleep: clock.sleep, now: clock.now });
    await expect(client.connect()).rejects.toThrow();
    await settle(100);
    expect(clock.sleeps).toHaveLength(0);
    expect(client.getStatus()).toBe('idle');
  });
});
