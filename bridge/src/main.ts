/**
 * Bridge 入口 —— loopback WS JSON-RPC 服务（默认 7788，端口占用自动 +1，
 * /bridge-info 返回实际端口与一次性认证 token）
 * + LLM 反向代理（默认 7789，同 +1 纪律；实际 origin 随 discovery 返回）。
 *
 * 装配：KernelSupervisor（StdioKernelTransport 工厂，spawn uv/py 内核）
 * + RpcRouter（方法路由，含 providers.* 加密凭据存储）+ broadcast（通知发给所有已连接客户端）。
 *
 * `--mcp [notebook.py]`：不起 WS 也不起 LLM 代理，只起 stdio MCP server（spec §6.3，
 * 外部 Agent 接入；stdout 专属 MCP 协议帧 —— 该模式下所有日志走 stderr）。
 */

import http from 'node:http';
import path from 'node:path';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { type RpcRequest } from './protocol';
import { RpcRouter } from './router';
import { ProvidersStore } from './providers-store';
import { isAllowedOrigin, LLM_PROXY_BASE_PORT, startLlmProxy, type LlmProxyHandle } from './llm-proxy';
import { MultiSupervisor, StdioKernelTransport } from './supervisor';
import { createChokidarEventSource } from './watch';
import { startMcpServer } from './mcp/server';

const BASE_PORT = 7788;
const MAX_PORT_TRIES = 10;
const BRIDGE_INFO_PATH = '/bridge-info';
const BRIDGE_WS_PATH = '/';
const AUTH_TIMEOUT_MS = 3_000;

// bridge/src/main.ts → 仓库根 → py/（内核 spawn 用绝对路径 cwd）
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packagedSourcePyDir = process.env.NOVALAB_PY_SOURCE_DIR;
const configuredPyDir = process.env.NOVALAB_PY_DIR;

/** Copy immutable installer resources into the writable per-user runtime area. */
function resolveKernelPyDir(): string {
  const target = configuredPyDir ?? path.join(repoRoot, 'py');
  if (process.env.NOVALAB_PACKAGED === '1' && packagedSourcePyDir && packagedSourcePyDir !== target) {
    const marker = path.join(target, 'pyproject.toml');
    if (!existsSync(marker)) {
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(packagedSourcePyDir, target, { recursive: true, force: false });
    }
  }
  return target;
}

const pyDir = resolveKernelPyDir();

// P3.1 多内核：每 path 一个 novakernel 子进程，保活并存（tab 切换不杀内核）。
const supervisor = new MultiSupervisor({
  transportFactory: () => new StdioKernelTransport(pyDir),
});

let activeWss: WebSocketServer | undefined;
let activeHttpServer: http.Server | undefined;
let activeLlmProxy: LlmProxyHandle | undefined;
let actualBridgePort = BASE_PORT;
let actualLlmPort = LLM_PROXY_BASE_PORT;
let llmProxyReady: Promise<number> = Promise.resolve(LLM_PROXY_BASE_PORT);
const bridgeToken = process.env.NOVALAB_BRIDGE_TOKEN ?? randomBytes(32).toString('base64url');
const authenticatedClients = new Set<WebSocket>();

const dataDir = process.env.NOVALAB_DATA_DIR ?? path.join(repoRoot, '.novalab');
const manifestPath = path.join(dataDir, 'bridge.json');

function writeBridgeManifest(): void {
  mkdirSync(dataDir, { recursive: true });
  const payload = {
    version: '0.1.0',
    pid: process.pid,
    wsPort: actualBridgePort,
    wsUrl: `ws://127.0.0.1:${actualBridgePort}${BRIDGE_WS_PATH}`,
    llmPort: actualLlmPort,
    llmProxyOrigin: `http://127.0.0.1:${actualLlmPort}`,
    token: bridgeToken,
  };
  const tmp = `${manifestPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows has no POSIX mode bits; the file still inherits the app directory ACL. */
  }
  renameSync(tmp, manifestPath);
}

function removeBridgeManifest(): void {
  try {
    const raw = readFileSync(manifestPath, 'utf8');
    const current = JSON.parse(raw) as { pid?: unknown };
    if (current.pid === process.pid) rmSync(manifestPath, { force: true });
  } catch {
    /* Stale or already-removed manifests are harmless. */
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, origin?: string): void {
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function broadcast(method: string, params: unknown): void {
  if (!activeWss) return;
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  for (const client of authenticatedClients) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
}

// P4：providers.* rpc 与 LLM 代理共用同一存储实例（.novalab/providers.json，0600）
const providersStore = new ProvidersStore();

const router = new RpcRouter({
  multi: supervisor,
  broadcast,
  providersStore,
  // P1.8：外部 .py 变更热重载（生产用 chokidar 事件源；单测在 RouterDeps 注入假源）
  watcherFactory: createChokidarEventSource,
});

function start(port: number): void {
  const server = http.createServer((req, res) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const pathname = new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname;
    if (req.method === 'GET' && pathname === BRIDGE_INFO_PATH) {
      if (!isAllowedOrigin(origin)) {
        sendJson(res, 403, { error: 'origin not allowed' });
        return;
      }
      void llmProxyReady.then((llmPort) => {
        actualLlmPort = llmPort;
        writeBridgeManifest();
        sendJson(
          res,
          200,
          {
            version: '0.1.0',
            wsPort: actualBridgePort,
            wsUrl: `ws://127.0.0.1:${actualBridgePort}${BRIDGE_WS_PATH}`,
            llmPort,
            llmProxyOrigin: `http://127.0.0.1:${llmPort}`,
            token: bridgeToken,
          },
          origin,
        );
      });
      return;
    }
    sendJson(res, 404, { error: 'not found' }, isAllowedOrigin(origin) ? origin : undefined);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const pathname = new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname;
    if (pathname !== BRIDGE_WS_PATH || !isAllowedOrigin(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client, req));
  });

  wss.on('connection', (socket) => {
    let authenticated = false;
    const authTimer = setTimeout(() => socket.close(1008, 'authentication required'), AUTH_TIMEOUT_MS);

    socket.on('message', (raw) => {
      let req: RpcRequest;
      try {
        req = JSON.parse(String(raw)) as RpcRequest;
      } catch {
        socket.close(1008, 'invalid authentication');
        return;
      }

      if (!authenticated) {
        if (req.method !== 'bridge.auth') {
          socket.close(1008, 'authentication required');
          return;
        }
        const params = (req.params ?? {}) as Record<string, unknown>;
        if (params['token'] !== bridgeToken) {
          socket.close(1008, 'invalid authentication');
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);
        authenticatedClients.add(socket);
        void llmProxyReady.then((llmPort) => {
          actualLlmPort = llmPort;
          writeBridgeManifest();
          if (socket.readyState === socket.OPEN) {
            socket.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: req.id,
                result: {
                  ok: true,
                  wsPort: actualBridgePort,
                  llmPort,
                  llmProxyOrigin: `http://127.0.0.1:${llmPort}`,
                },
              }),
            );
          }
        });
        return;
      }

      void router.handle(req).then((res) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(res));
      });
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      authenticatedClients.delete(socket);
    });
    socket.on('error', () => {
      /* 客户端断连噪音忽略 */
    });
  });

  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && port < BASE_PORT + MAX_PORT_TRIES) {
      console.log(`[bridge] port ${port} 占用，尝试 ${port + 1}`);
      server.close();
      wss.close();
      start(port + 1);
    } else {
      throw err;
    }
  });

  server.listen(port, '127.0.0.1', () => {
    actualBridgePort = (server.address() as import('node:net').AddressInfo).port;
    activeHttpServer = server;
    activeWss = wss;
    writeBridgeManifest();
    console.log(`[bridge] ws://127.0.0.1:${actualBridgePort}`);
    console.log(`[bridge] discovery http://127.0.0.1:${actualBridgePort}${BRIDGE_INFO_PATH}`);
  });
}

function shutdown(): void {
  router.dispose(); // 停 watcher + ui.json 落盘 + 全部会话快照
  supervisor.stopAll();
  activeLlmProxy?.close();
  for (const client of authenticatedClients) client.close(1001, 'bridge shutdown');
  authenticatedClients.clear();
  activeWss?.close();
  activeHttpServer?.close();
  removeBridgeManifest();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------- 模式分支：--mcp = stdio MCP server（不起 WS）；默认 = WS 服务 ----------

const mcpFlagIdx = process.argv.indexOf('--mcp');
if (mcpFlagIdx >= 0) {
  // 可选位置参数：--mcp 之后第一个非 flag 参数视为要打开的 notebook 路径
  const nbPath = process.argv
    .slice(mcpFlagIdx + 1)
    .find((a) => !a.startsWith('-'));
  void (async () => {
    await startMcpServer(router);
    process.stderr.write('[bridge] MCP stdio server 已启动\n');
    if (nbPath) {
      const res = await router.handle({
        jsonrpc: '2.0',
        id: 0,
        method: 'notebook.open',
        params: { path: nbPath },
      });
      if (res.error) {
        process.stderr.write(`[bridge] notebook.open 失败: ${res.error.message}\n`);
      } else {
        process.stderr.write(`[bridge] notebook 已打开: ${nbPath}\n`);
      }
    }
  })();
} else {
  start(BASE_PORT);
  // P4：LLM 反向代理（默认分支专属；--mcp 分支不起，stdout 是 MCP 协议帧专属）
  activeLlmProxy = startLlmProxy({ store: providersStore, authToken: bridgeToken });
  llmProxyReady = activeLlmProxy.listening
    .then((port) => {
      actualLlmPort = port;
      writeBridgeManifest();
      console.log(`[bridge] llm-proxy http://127.0.0.1:${port}/llm/<providerId>/`);
      return port;
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `[bridge] llm-proxy 启动失败: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return LLM_PROXY_BASE_PORT;
    });
}
