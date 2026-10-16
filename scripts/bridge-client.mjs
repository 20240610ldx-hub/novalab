/** Shared authenticated Bridge client for integration/gallery scripts. */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'bridge', 'package.json'));
const { WebSocket } = require('ws');

const DEFAULT_PORT = 7788;
const MAX_PORT = 7798;
const ORIGIN = 'http://127.0.0.1:5199';
const DEFAULT_RPC_TIMEOUT_MS = 20_000;
const LONG_RUNNING_METHODS = new Set([
  'cell.run', 'kernel.repl', 'diff.accept', 'control.set', 'notebook.open', 'kernel.restart', 'notebook.reload',
]);

function validateTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('timeoutMs 必须是 0 或不超过 2147483647 的正整数毫秒');
  }
  return timeoutMs;
}

export async function discoverBridge(startPort = DEFAULT_PORT) {
  for (let port = startPort; port <= MAX_PORT; port += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/bridge-info`, {
        headers: { Accept: 'application/json', Origin: ORIGIN },
        signal: AbortSignal.timeout(500),
      });
      if (!response.ok) continue;
      const info = await response.json();
      if (
        typeof info?.wsUrl === 'string' &&
        typeof info?.token === 'string' &&
        typeof info?.llmProxyOrigin === 'string'
      ) {
        return info;
      }
    } catch {
      /* Port is unused or an old unauthenticated bridge is still shutting down. */
    }
  }
  throw new Error(`bridge discovery 失败（已探测 ${startPort}-${MAX_PORT}）`);
}

export class BridgeClient {
  constructor(options = {}) {
    this.origin = typeof options === 'string' ? ORIGIN : options.origin ?? ORIGIN;
    this.rpcTimeoutMs = validateTimeout(options.rpcTimeoutMs === undefined ? DEFAULT_RPC_TIMEOUT_MS : options.rpcTimeoutMs);
    // Execution/cascade and packaged kernel bootstrap may both take minutes.
    this.runTimeoutMs = validateTimeout(options.runTimeoutMs === undefined ? 0 : options.runTimeoutMs);
    this.ws = null;
    this.authenticated = false;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
  }

  // Owned-child callers supply verified info; other callers retain discovery.
  async connect(info = undefined) {
    info ??= await discoverBridge();
    if (this.ws) throw new Error('bridge 已连接或正在连接');
    this.info = info;
    await new Promise((resolve, reject) => {
      const s = new WebSocket(info.wsUrl, { headers: { Origin: this.origin } });
      this.ws = s;
      this.authenticated = false;
      const authId = this.nextId++;
      let settled = false;
      const fail = (error) => {
        this._disconnect(s, error);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
        s.terminate();
      };
      const timer = setTimeout(() => fail(new Error('bridge 认证超时')), 3000);
      s.on('open', () => {
        try {
          s.send(JSON.stringify({ jsonrpc: '2.0', id: authId, method: 'bridge.auth', params: { token: info.token } }), (error) => {
            if (error) fail(error);
          });
        } catch (error) {
          fail(error);
        }
      });
      s.on('message', (raw) => {
        if (this.ws !== s) return;
        let msg;
        try {
          msg = JSON.parse(String(raw));
          if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
            throw new Error('消息必须是 JSON 对象');
          }
        } catch {
          fail(new Error('bridge 消息无效：应为非 null、非数组的 JSON 对象'));
          return;
        }
        if (msg.id === authId) {
          if (msg.error) fail(new Error(`${msg.error.code}: ${msg.error.message}`));
          else if (!settled && this.ws === s) {
            settled = true;
            clearTimeout(timer);
            this.authenticated = true;
            resolve();
          }
          return;
        }
        if (this.ws === s && this.authenticated) this._dispatch(msg);
      });
      s.on('error', fail);
      s.on('close', (code) => fail(new Error(`bridge 连接关闭 (${code})`)));
    });
  }

  _settle(id, error, result) {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    if (error) request.reject(error);
    else request.resolve(result);
  }

  _disconnect(socket, error) {
    // A previous socket's late close must not invalidate a newly connected socket.
    if (this.ws !== socket) return;
    this.ws = null;
    this.authenticated = false;
    for (const id of this.pending.keys()) this._settle(id, error);
  }

  _dispatch(msg) {
    if (msg.id !== undefined) {
      this._settle(msg.id, msg.error ? new Error(`${msg.error.code}: ${msg.error.message}`) : null, msg.result);
      return;
    }
    if (msg.method) this.notifications.push({ method: msg.method, params: msg.params ?? null });
  }

  rpc(method, params = {}, options = {}) {
    const socket = this.ws;
    if (!socket || !this.authenticated || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('bridge 未连接'));
    }
    return new Promise((resolve, reject) => {
      const timeoutMs = validateTimeout(options.timeoutMs === undefined
        ? (LONG_RUNNING_METHODS.has(method) ? this.runTimeoutMs : this.rpcTimeoutMs)
        : options.timeoutMs);
      const id = this.nextId++;
      const timer = timeoutMs === 0 ? null : setTimeout(() => {
        this._settle(id, new Error(`bridge RPC 超时: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (error) => {
          if (error) this._settle(id, error);
        });
      } catch (error) {
        this._settle(id, error);
      }
    });
  }

  async waitNotif(method, pred = () => true, timeoutMs = 20_000, mark = 0) {
    const t0 = Date.now();
    for (;;) {
      for (let i = mark; i < this.notifications.length; i += 1) {
        const n = this.notifications[i];
        if (n.method === method && pred(n.params)) return n;
      }
      if (Date.now() - t0 > timeoutMs) throw new Error(`等待通知超时: ${method}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  close() {
    const socket = this.ws;
    if (!socket) return;
    this._disconnect(socket, new Error('bridge 客户端已关闭'));
    try {
      socket.close();
    } catch {
      socket.terminate();
    }
  }
}
