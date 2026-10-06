import { WebSocketServer } from 'ws';
import type { RpcRequest, RpcResponse } from './protocol';

const BASE_PORT = 7788;

/** P1.3 起扩展：RPC router + KernelSupervisor + SessionLogger + PreviewSerializer。 */
function start(port: number): WebSocketServer {
  const wss = new WebSocketServer({ port });
  console.log(`[bridge] ws://127.0.0.1:${port}`);

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const req = JSON.parse(String(raw)) as RpcRequest;
      const res: RpcResponse = { jsonrpc: '2.0', id: req.id };
      switch (req.method) {
        case 'ping':
          res.result = { pong: Date.now() };
          break;
        default:
          res.error = { code: -32601, message: `method not found: ${req.method}` };
      }
      socket.send(JSON.stringify(res));
    });
  });

  wss.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && port < BASE_PORT + 10) {
      console.log(`[bridge] port ${port} 占用，尝试 ${port + 1}`);
      start(port + 1);
    } else {
      throw err;
    }
  });

  return wss;
}

start(BASE_PORT);
