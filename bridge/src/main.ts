/**
 * Bridge 入口 —— WS JSON-RPC 服务（ws://127.0.0.1:7788，端口占用自动 +1）
 * + LLM 反向代理（http://127.0.0.1:7789/llm/<providerId>/*，P4 / ADR-008，同 +1 纪律）。
 *
 * 装配：KernelSupervisor（StdioKernelTransport 工厂，spawn uv/py 内核）
 * + RpcRouter（方法路由，含 providers.* 加密凭据存储）+ broadcast（通知发给所有已连接客户端）。
 *
 * `--mcp [notebook.py]`：不起 WS 也不起 LLM 代理，只起 stdio MCP server（spec §6.3，
 * 外部 Agent 接入；stdout 专属 MCP 协议帧 —— 该模式下所有日志走 stderr）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ERR_PARSE, type RpcRequest } from './protocol';
import { RpcRouter } from './router';
import { ProvidersStore } from './providers-store';
import { startLlmProxy, type LlmProxyHandle } from './llm-proxy';
import { MultiSupervisor, StdioKernelTransport } from './supervisor';
import { createChokidarEventSource } from './watch';
import { startMcpServer } from './mcp/server';

const BASE_PORT = 7788;
const MAX_PORT_TRIES = 10;

// bridge/src/main.ts → 仓库根 → py/（内核 spawn 用绝对路径 cwd）
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pyDir = path.join(repoRoot, 'py');

// P3.1 多内核：每 path 一个 novakernel 子进程，保活并存（tab 切换不杀内核）。
const supervisor = new MultiSupervisor({
  transportFactory: () => new StdioKernelTransport(pyDir),
});

let activeWss: WebSocketServer | undefined;
let activeLlmProxy: LlmProxyHandle | undefined;

function broadcast(method: string, params: unknown): void {
  if (!activeWss) return;
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  for (const client of activeWss.clients) {
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
  router.dispose(); // 停 watcher + ui.json 落盘 + 全部会话快照
  supervisor.stopAll();
  activeLlmProxy?.close();
  activeWss?.close();
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
  activeLlmProxy = startLlmProxy({ store: providersStore });
  activeLlmProxy.listening
    .then((port) => {
      console.log(`[bridge] llm-proxy http://127.0.0.1:${port}/llm/<providerId>/`);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `[bridge] llm-proxy 启动失败: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
}
