import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ANTHROPIC_VERSION,
  joinUpstream,
  startLlmProxy,
  type LlmProxyHandle,
} from './llm-proxy';
import { ProvidersStore } from './providers-store';
import { machineSecret } from './secret';

/**
 * P4 llm-proxy 单测：本地 echo HTTP server 作上游 ——
 * 头注入（kind → x-api-key / Bearer 映射表）、SSE 流式透传（pipe 不缓冲）、
 * 404 unknown provider、CORS 拒绝外部 origin、上游不可达 502、端口 +1 自愈。
 */

const SECRET = machineSecret({ NOVALAB_SECRET: 'proxy-unit-test' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface EchoRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Upstream {
  port: number;
  requests: EchoRequest[];
  close: () => Promise<void>;
}

/** echo 上游：任意路径回 {method,url,headers,body}；`…/stream` 路径 = SSE 三段分帧。 */
async function startUpstream(): Promise<Upstream> {
  const requests: EchoRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '/';
      if (url.includes('/stream')) {
        // SSE：分三帧、间隔 60ms —— 若代理缓冲，客户端会在结束时一次性收到全部
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('data: one\n\n');
        setTimeout(() => res.write('data: two\n\n'), 60);
        setTimeout(() => {
          res.write('data: three\n\n');
          res.end();
        }, 120);
        return;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url, headers: req.headers, body });
      const payload = JSON.stringify({ method: req.method, url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

let cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

interface SetupResult {
  proxyPort: number;
  upstream: Upstream;
  store: ProvidersStore;
  proxyURL: (providerId: string, rest: string) => string;
}

async function setup(
  seed: Array<{ id: string; kind?: 'anthropic-compat' | 'openai-compat'; apiKey?: string; baseURL?: string }> = [],
  opts: { secret?: Buffer; basePort?: number } = {},
): Promise<SetupResult> {
  const upstream = await startUpstream();
  cleanups.push(() => upstream.close());
  const dir = mkdtempSync(path.join(tmpdir(), 'novalab-proxy-'));
  const store = new ProvidersStore({ dir, secret: opts.secret ?? SECRET });
  for (const s of seed) {
    store.set({
      kind: s.kind ?? 'anthropic-compat',
      name: s.id,
      baseURL: s.baseURL ?? `http://127.0.0.1:${upstream.port}/v1`,
      model: 'test-model',
      id: s.id,
      ...(s.apiKey !== undefined ? { apiKey: s.apiKey } : {}),
    });
  }
  const handle: LlmProxyHandle = startLlmProxy({ store, basePort: opts.basePort ?? 0 });
  cleanups.push(() => handle.close());
  const proxyPort = await handle.listening;
  return {
    proxyPort,
    upstream,
    store,
    proxyURL: (providerId, rest) => `http://127.0.0.1:${proxyPort}/llm/${providerId}/${rest}`,
  };
}

interface EchoResponse {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

async function echoOf(res: Response): Promise<EchoResponse> {
  const json = (await res.json()) as { method: string; url: string; headers: Record<string, string>; body: string };
  return json;
}

/* ---------------- joinUpstream（纯函数：/v1 去重拼接） ---------------- */

describe('joinUpstream', () => {
  it('rest 以 v1/ 开头 → 存储 baseURL 的尾段 /v1 去重', () => {
    expect(joinUpstream('https://h/v1', 'v1/messages')).toBe('https://h/v1/messages');
    expect(joinUpstream('https://h/v1/', 'v1/messages')).toBe('https://h/v1/messages');
    expect(joinUpstream('https://h/api/anthropic/v1', 'v1/messages')).toBe('https://h/api/anthropic/v1/messages');
  });
  it('baseURL 无 /v1 → 直接拼接（/v1 来自 rest）', () => {
    expect(joinUpstream('https://h', 'v1/messages')).toBe('https://h/v1/messages');
  });
  it('rest 不以 v1 开头 → baseURL 原样保留', () => {
    expect(joinUpstream('https://h/v1', 'models')).toBe('https://h/v1/models');
  });
  it('rest 为空 → baseURL 去尾斜杠', () => {
    expect(joinUpstream('https://h/v1/', '')).toBe('https://h/v1');
  });
});

/* ---------------- 转发 + 头注入 ---------------- */

describe('llm-proxy · 转发与头注入（kind 映射表）', () => {
  it('anthropic-compat：注入 x-api-key 真 key + anthropic-version 缺省；剥离客户端占位/浏览器本地头', async () => {
    const ctx = await setup([{ id: 'tp', apiKey: 'sk-real-anthropic' }]);
    const res = await fetch(ctx.proxyURL('tp', 'v1/messages'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'proxy', // 前端占位
        authorization: 'Bearer proxy', // 应被剥离
        cookie: 'session=evil',
        'sec-fetch-mode': 'cors',
        origin: 'http://127.0.0.1:5199',
        referer: 'http://127.0.0.1:5199/',
      },
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'ping' }] }),
    });
    expect(res.status).toBe(200);
    const echo = await echoOf(res);
    expect(echo.method).toBe('POST');
    expect(echo.url).toBe('/v1/messages'); // 无 /v1/v1 重复
    const h = echo.headers;
    expect(h['x-api-key']).toBe('sk-real-anthropic');
    expect(h['anthropic-version']).toBe(DEFAULT_ANTHROPIC_VERSION);
    expect(h['authorization']).toBeUndefined();
    expect(h['cookie']).toBeUndefined();
    expect(h['sec-fetch-mode']).toBeUndefined();
    expect(h['origin']).toBeUndefined();
    expect(h['referer']).toBeUndefined();
    expect(h['content-type']).toBe('application/json');
    expect(JSON.parse(echo.body)).toEqual({ model: 'test-model', messages: [{ role: 'user', content: 'ping' }] });
  });

  it('客户端已带 anthropic-version / anthropic-beta → 透传不覆盖', async () => {
    const ctx = await setup([{ id: 'tp', apiKey: 'sk-1' }]);
    const res = await fetch(ctx.proxyURL('tp', 'v1/messages'), {
      method: 'POST',
      headers: { 'anthropic-version': '2025-01-01', 'anthropic-beta': 'fine-grained-tools' },
      body: '{}',
    });
    const h = (await echoOf(res)).headers;
    expect(h['anthropic-version']).toBe('2025-01-01');
    expect(h['anthropic-beta']).toBe('fine-grained-tools');
  });

  it('openai-compat：注入 authorization Bearer；无 x-api-key', async () => {
    const ctx = await setup([{ id: 'oai', kind: 'openai-compat', apiKey: 'sk-real-openai' }]);
    const res = await fetch(ctx.proxyURL('oai', 'v1/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer proxy', 'x-api-key': 'proxy' },
      body: '{"model":"m"}',
    });
    const echo = await echoOf(res);
    expect(echo.url).toBe('/v1/chat/completions');
    expect(echo.headers['authorization']).toBe('Bearer sk-real-openai');
    expect(echo.headers['x-api-key']).toBeUndefined();
  });

  it('无 key provider（ollama 本地）：只剥离占位头，不注入任何凭据', async () => {
    const ctx = await setup([{ id: 'local', kind: 'openai-compat' }]);
    const res = await fetch(ctx.proxyURL('local', 'v1/chat/completions'), {
      method: 'POST',
      headers: { authorization: 'Bearer proxy' },
      body: '{}',
    });
    const h = (await echoOf(res)).headers;
    expect(h['authorization']).toBeUndefined();
    expect(h['x-api-key']).toBeUndefined();
  });

  it('GET + query 透传（baseURL 无 /v1 的 provider）', async () => {
    const ctx = await setup([{ id: 'tp', apiKey: 'sk-1' }]);
    const res = await fetch(
      `http://127.0.0.1:${ctx.proxyPort}/llm/tp/v1/messages?beta=true&n=2`,
    );
    const echo = await echoOf(res);
    expect(echo.method).toBe('GET');
    expect(echo.url).toBe('/v1/messages?beta=true&n=2');
  });

  it('非 v1 前缀 rest → baseURL 原样拼接', async () => {
    const ctx = await setup([{ id: 'tp' }]);
    const res = await fetch(`http://127.0.0.1:${ctx.proxyPort}/llm/tp/models`);
    expect((await echoOf(res)).url).toBe('/v1/models');
  });
});

/* ---------------- SSE 流式透传 ---------------- */

describe('llm-proxy · SSE 流式透传（pipe 不缓冲）', () => {
  it('text/event-stream 分帧到达：首帧远早于末帧（缓冲则同时到达）', async () => {
    const ctx = await setup([{ id: 'sse', apiKey: 'sk-1' }]);
    const t0 = Date.now();
    const res = await fetch(ctx.proxyURL('sse', 'v1/stream'), { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const arrivals: Array<{ text: string; at: number }> = [];
    let acc = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += new TextDecoder().decode(value, { stream: true });
      arrivals.push({ text: new TextDecoder().decode(value), at: Date.now() - t0 });
    }
    expect(acc).toBe('data: one\n\ndata: two\n\ndata: three\n\n');
    // 上游 0/60/120ms 分三帧写出；透传则首帧应远早于末帧（≥40ms 裕量防抖动）
    expect(arrivals.length).toBeGreaterThanOrEqual(2);
    const span = arrivals[arrivals.length - 1]!.at - arrivals[0]!.at;
    expect(span).toBeGreaterThanOrEqual(40);
    expect(arrivals[0]!.at).toBeLessThan(100); // 首帧未被扣到流结束
  });
});

/* ---------------- 404 / 502 ---------------- */

describe('llm-proxy · 错误路径', () => {
  it('unknown provider → 404 JSON', async () => {
    const ctx = await setup([]);
    const res = await fetch(ctx.proxyURL('nope', 'v1/messages'), { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown provider: nope' });
    expect(ctx.upstream.requests).toHaveLength(0);
  });

  it('非 /llm 路径 → 404', async () => {
    const ctx = await setup([]);
    expect((await fetch(`http://127.0.0.1:${ctx.proxyPort}/`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${ctx.proxyPort}/foo/bar`)).status).toBe(404);
  });

  it('上游不可达 → 502（不崩代理，后续请求正常）', async () => {
    const dead = await startUpstream();
    const deadPort = dead.port;
    await dead.close();
    const ctx = await setup([{ id: 'dead', baseURL: `http://127.0.0.1:${deadPort}/v1` }]);
    const res = await fetch(ctx.proxyURL('dead', 'v1/messages'), { method: 'POST', body: '{}' });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('上游不可达');
    // 代理仍存活
    const ok = await setup([]);
    expect((await fetch(ok.proxyURL('x', 'v1'))).status).toBe(404);
  });

  it('密文解密失败（secret 变化）→ 502，掩码 list 不受影响', async () => {
    const ctx = await setup([{ id: 'tp', apiKey: 'sk-1' }], { secret: SECRET });
    // 用另一把密钥重开同目录存储 → resolveForProxy 抛 → 502
    const dir = path.dirname(ctx.store.file);
    const otherStore = new ProvidersStore({ dir, secret: machineSecret({ NOVALAB_SECRET: 'another' }) });
    const handle = startLlmProxy({ store: otherStore, basePort: 0 });
    cleanups.push(() => handle.close());
    const port = await handle.listening;
    const res = await fetch(`http://127.0.0.1:${port}/llm/tp/v1/messages`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain('解密失败');
  });
});

/* ---------------- CORS ---------------- */

describe('llm-proxy · CORS 白名单', () => {
  const ALLOWED = ['http://127.0.0.1:5199', 'http://localhost:5199', 'tauri://localhost', 'https://tauri.localhost'];

  it.each(ALLOWED)('放行 origin %s（实际请求带 ACAO 头）', async (origin) => {
    const ctx = await setup([{ id: 'tp' }]);
    const res = await fetch(ctx.proxyURL('tp', 'v1/messages'), {
      method: 'POST',
      headers: { origin },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
  });

  it('外部 origin → 403 且不打上游', async () => {
    const ctx = await setup([{ id: 'tp' }]);
    const res = await fetch(ctx.proxyURL('tp', 'v1/messages'), {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain('origin not allowed');
    expect(ctx.upstream.requests).toHaveLength(0);
  });

  it('OPTIONS 预检：白名单 origin → 204 + ACAO/方法/回显请求头；外部 → 403', async () => {
    const ctx = await setup([{ id: 'tp' }]);
    const ok = await fetch(ctx.proxyURL('tp', 'v1/messages'), {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:5199', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-api-key' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5199');
    expect(ok.headers.get('access-control-allow-methods')).toContain('POST');
    expect(ok.headers.get('access-control-allow-headers')).toBe('content-type,x-api-key');

    const bad = await fetch(ctx.proxyURL('tp', 'v1/messages'), {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.example' },
    });
    expect(bad.status).toBe(403);
  });

  it('无 Origin（curl / node 客户端）→ 放行', async () => {
    const ctx = await setup([{ id: 'tp' }]);
    const res = await fetch(ctx.proxyURL('tp', 'v1/messages'), { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

/* ---------------- 端口纪律 ---------------- */

describe('llm-proxy · 端口占用 +1 自愈（与 WS :7788 同纪律）', () => {
  it('basePort 被占 → 自动 +1 监听', async () => {
    const blocker = http.createServer((_req, res) => res.end('x'));
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const busyPort = (blocker.address() as AddressInfo).port;
    cleanups.push(() => {
      blocker.closeAllConnections?.();
      blocker.close();
    });

    const dir = mkdtempSync(path.join(tmpdir(), 'novalab-proxy-port-'));
    const handle = startLlmProxy({ store: new ProvidersStore({ dir, secret: SECRET }), basePort: busyPort });
    cleanups.push(() => handle.close());
    const port = await handle.listening;
    expect(port).toBeGreaterThan(busyPort);
    expect(port).toBeLessThanOrEqual(busyPort + 10);
    await sleep(0);
  });
});
