/**
 * Bridge 入口 —— WS JSON-RPC 服务（ws://127.0.0.1:7788，端口占用自动 +1）。
 *
 * 装配：KernelSupervisor（StdioKernelTransport 工厂，spawn uv/py 内核）
 * + RpcRouter（方法路由）+ broadcast（通知发给所有已连接客户端）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ERR_PARSE, type RpcRequest } from './protocol';
import { RpcRouter } from './router';
import { KernelSupervisor, StdioKernelTransport } from './supervisor';

const BASE_PORT = 7788;
const MAX_PORT_TRIES = 10;

// bridge/src/main.ts → 仓库根 → py/（内核 spawn 用绝对路径 cwd）
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pyDir = path.join(repoRoot, 'py');

const supervisor = new KernelSupervisor({
  transportFactory: () => new StdioKernelTransport(pyDir),
});

let activeWss: WebSocketServer | undefined;

function broadcast(method: string, params: unknown): void {
  if (!activeWss) return;
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  for (const client of activeWss.clients) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
}

const router = new RpcRouter({ supervisor, broadcast });

function start(port: number): WebSocketServer {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  activeWss = wss;
  console.log(`[bridge] ws://127.0.0.1:${port}`);

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      let req: RpcRequest;
      try {
        req = JSON.parse(String(raw)) as RpcRequest;
      } catch {
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: ERR_PARSE, message: 'parse error' },
          }),
        );
        return;
      }
      void router.handle(req).then((res) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(res));
      });
    });
    socket.on('error', () => {
      /* 客户端断连噪音忽略 */
    });
  });

  wss.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && port < BASE_PORT + MAX_PORT_TRIES) {
      console.log(`[bridge] port ${port} 占用，尝试 ${port + 1}`);
      activeWss = undefined;
      start(port + 1);
    } else {
      throw err;
    }
  });

  return wss;
}

function shutdown(): void {
  supervisor.stop();
  activeWss?.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start(BASE_PORT);
