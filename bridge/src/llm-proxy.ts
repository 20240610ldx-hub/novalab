/**
 * LLM 反向代理（P4 / ADR-008，feature-matrix L-1 尾段）：
 * HTTP server 127.0.0.1:7789（端口占用 +1，与 WS 默认 :7788 同纪律）。
 *
 * 路由：`/llm/:providerId/*rest` → 查 ProvidersStore → 转发到 provider.baseURL：
 * - method / 请求体（pipe 流式）/ 状态码 / 响应体（**SSE 透传，不缓冲**）原样过；
 * - 真 key 只在这里注入上游请求头（按 kind 映射，见 forwardHeaders）；前端 SDK 只带
 *   'proxy' 占位，浏览器进程从头到尾不接触明文 key；
 * - CORS 仅放行本机前端 origin；正式实例还要求 Bridge discovery token，避免同机
 *   其他本地进程直接借代理读取已保存的 provider key。
 *
 * baseURL 拼接：前端 SDK baseURL 统一使用 discovery 返回的
 * `http://127.0.0.1:<port>/llm/<id>/v1`，故 rest 以
 * `v1/` 开头时把存储 baseURL 的尾段 `/v1` 去重（joinUpstream），
 * `https://host/v1` + rest `v1/messages` → `https://host/v1/messages`。
 *
 * 仅 main.ts 默认分支启动（--mcp stdio 分支不起：stdout 是 MCP 协议帧专属，
 * 且外部 Agent 自带凭据，不经本代理）。
 */

import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { URL } from 'node:url';
import type { ProviderKind } from './protocol';
import { ProvidersStore, ProvidersStoreError } from './providers-store';

export const LLM_PROXY_BASE_PORT = 7789;
const MAX_PORT_TRIES = 10;

/**
 * CORS 白名单：vite dev（strictPort 5199，127.0.0.1/localhost 两种写法）+
 * Tauri webview（macOS/Linux 自定义协议 tauri://localhost；Windows WebView2
 * 映射为 http(s)://tauri.localhost）。
 */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'http://127.0.0.1:5199',
  'http://localhost:5199',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
];

/**
 * Browser origins allowed to discover/use the local bridge.
 * Vite demo scripts may move between loopback ports, so local development
 * ports are accepted without widening access beyond localhost.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string> | readonly string[] = DEFAULT_ALLOWED_ORIGINS,
): origin is string {
  if (!origin) return false;
  const exact = allowedOrigins instanceof Set
    ? allowedOrigins.has(origin)
    : (allowedOrigins as readonly string[]).includes(origin);
  if (exact) return true;
  try {
    const parsed = new URL(origin);
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    const port = Number(parsed.port);
    return loopback && Number.isInteger(port) && port >= 5000 && port <= 5999;
  } catch {
    return false;
  }
}

/** anthropic-compat 上游缺省协议版本（客户端已带则透传，不覆盖）。 */
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/** 逐跳/浏览器本地头 + 客户端带来的（占位）凭据头：一律不透传。 */
const STRIP_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'origin',
  'referer',
  'cookie',
  'proxy-authorization',
  'authorization',
  'x-api-key',
  'api-key',
  'x-novalab-bridge-token',
]);

/** 上游响应里不回的逐跳头（其余 content-type/content-encoding 等原样透传）。 */
const STRIP_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

/**
 * 存储 baseURL + rest → 上游完整 URL（不含 query）。
 * rest 以 v1 开头时去掉存储 baseURL 的尾段 /v1（前端代理 baseURL 统一带 /v1，
 * 用户存的 baseURL 也惯以 /v1 结尾，直接拼接会重复）。
 */
export function joinUpstream(baseURL: string, rest: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  const dedupeV1 = rest === 'v1' || rest.startsWith('v1/');
  const root = dedupeV1 ? trimmed.replace(/\/v1$/i, '') : trimmed;
  return rest === '' ? root : `${root}/${rest}`;
}

/**
 * 头映射表（P4 冻结）：
 * | kind             | 注入                                              | 剥离（客户端占位）        |
 * |------------------|---------------------------------------------------|---------------------------|
 * | anthropic-compat | x-api-key: <key>；anthropic-version（缺省 2023-06-01） | authorization / x-api-key / api-key |
 * | openai-compat    | authorization: Bearer <key>                        | 同上                      |
 * 无 key（ollama 本地）→ 只剥离不注入。sec-* / proxy-* 前缀与逐跳头恒剥离。
 */
export function forwardHeaders(
  incoming: http.IncomingHttpHeaders,
  kind: ProviderKind,
  apiKey: string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(key) || key.startsWith('sec-') || key.startsWith('proxy-')) continue;
    out[key] = Array.isArray(v) ? v.join(', ') : v;
  }
  if (kind === 'anthropic-compat') {
    if (apiKey) out['x-api-key'] = apiKey;
    if (!out['anthropic-version']) out['anthropic-version'] = DEFAULT_ANTHROPIC_VERSION;
  } else if (apiKey) {
    out['authorization'] = `Bearer ${apiKey}`;
  }
  return out;
}

function filterResponseHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v as string | string[];
  }
  return out;
}

export interface LlmProxyOptions {
  store: ProvidersStore;
  /** 默认 7789；0 = OS 分配（单测用，跳过 +1 自愈）。 */
  basePort?: number;
  maxPortTries?: number;
  allowedOrigins?: readonly string[];
  /** Bridge discovery token; when set every proxy request must present it. */
  authToken?: string;
}

export interface LlmProxyHandle {
  readonly server: http.Server;
  /** 实际监听端口（EADDRINUSE +1 自愈后 resolve；失败 reject）。 */
  readonly listening: Promise<number>;
  close(): void;
}

const LLM_ROUTE = /^\/llm\/([^/]+)(?:\/(.*))?$/;

export function startLlmProxy(opts: LlmProxyOptions): LlmProxyHandle {
  const basePort = opts.basePort ?? LLM_PROXY_BASE_PORT;
  const maxTries = opts.maxPortTries ?? MAX_PORT_TRIES;
  const allowedOrigins = new Set(opts.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
  const authToken = opts.authToken;
  const { store } = opts;

  const server = http.createServer((req, res) => {
    handleRequest(req, res, store, allowedOrigins, authToken).catch((err: unknown) => {
      process.stderr.write(
        `[bridge] llm-proxy 请求处理异常: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      if (!res.headersSent) json(res, 500, { error: 'internal proxy error' }, undefined);
      else res.destroy();
    });
  });

  const listening = new Promise<number>((resolve, reject) => {
    const attempt = (port: number, tries: number): void => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && basePort !== 0 && tries < maxTries) {
          process.stderr.write(`[bridge] llm-proxy 端口 ${port} 占用，尝试 ${port + 1}\n`);
          attempt(port + 1, tries + 1);
        } else {
          reject(err);
        }
      });
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error');
        server.on('error', () => {
          /* 运行期 server 错误不崩进程 */
        });
        resolve((server.address() as AddressInfo).port);
      });
    };
    attempt(basePort, 0);
  });

  return {
    server,
    listening,
    close: () => {
      server.close();
      server.closeAllConnections?.();
    },
  };
}

/* ---------------- 请求处理 ---------------- */

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: ProvidersStore,
  allowedOrigins: ReadonlySet<string>,
  authToken?: string,
): Promise<void> {
  const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  const cors = isAllowedOrigin(origin, allowedOrigins) ? origin : undefined;
  const originRejected = origin !== undefined && cors === undefined;

  if (req.method === 'OPTIONS') {
    if (originRejected) {
      json(res, 403, { error: `origin not allowed: ${origin}` }, undefined);
      return;
    }
    preflight(res, req, cors);
    return;
  }
  if (originRejected) {
    json(res, 403, { error: `origin not allowed: ${origin}` }, undefined);
    return;
  }
  if (authToken && req.headers['x-novalab-bridge-token'] !== authToken) {
    json(res, 401, { error: 'bridge authentication required' }, cors);
    return;
  }

  const m = LLM_ROUTE.exec(reqUrl.pathname);
  if (!m) {
    json(res, 404, { error: 'not found（期望 /llm/<providerId>/<path>）' }, cors);
    return;
  }
  const providerId = decodeURIComponent(m[1]!);
  const rest = m[2] ?? '';

  let resolved;
  try {
    resolved = store.resolveForProxy(providerId);
  } catch (err) {
    if (err instanceof ProvidersStoreError) {
      json(res, 502, { error: err.message }, cors);
      return;
    }
    throw err;
  }
  if (!resolved) {
    json(res, 404, { error: `unknown provider: ${providerId}` }, cors);
    return;
  }

  let target: URL;
  try {
    target = new URL(joinUpstream(resolved.provider.baseURL, rest) + reqUrl.search);
  } catch {
    json(res, 502, { error: `provider baseURL 非法: ${resolved.provider.baseURL}` }, cors);
    return;
  }

  const headers = forwardHeaders(req.headers, resolved.provider.kind, resolved.apiKey);
  const transport = target.protocol === 'https:' ? https : http;
  const upstreamReq = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port !== '' ? target.port : target.protocol === 'https:' ? 443 : 80,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      const outHeaders = filterResponseHeaders(upstreamRes.headers);
      if (cors) {
        outHeaders['access-control-allow-origin'] = cors;
        outHeaders['vary'] = 'Origin';
      }
      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
      // SSE 流式透传：pipe 不缓冲，上游 chunk 直达浏览器 ReadableStream
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on('error', (err: NodeJS.ErrnoException) => {
    if (!res.headersSent) {
      json(res, 502, { error: `上游不可达: ${err.message}` }, cors);
    } else {
      res.destroy();
    }
  });
  // 客户端断开（停止生成）→ 掐掉上游，不留悬挂 socket / 白烧 token
  res.on('close', () => {
    upstreamReq.destroy();
  });
  // 请求体流式透传（与响应同纪律，不整包缓冲）
  req.pipe(upstreamReq);
}

function preflight(res: http.ServerResponse, req: http.IncomingMessage, cors: string | undefined): void {
  const requestHeaders = req.headers['access-control-request-headers'];
  res.writeHead(204, {
    ...(cors
      ? {
          'access-control-allow-origin': cors,
          'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers':
            typeof requestHeaders === 'string' && requestHeaders !== ''
              ? requestHeaders
              : 'content-type,accept,authorization,x-api-key,x-novalab-bridge-token,anthropic-version,anthropic-beta',
          'access-control-max-age': '86400',
          vary: 'Origin',
        }
      : {}),
    'content-length': '0',
  });
  res.end();
}

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  cors: string | undefined,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    ...(cors ? { 'access-control-allow-origin': cors, vary: 'Origin' } : {}),
  });
  res.end(payload);
}
