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
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
  }

  async connect() {
    const info = await discoverBridge();
    this.info = info;
    await new Promise((resolve, reject) => {
      const s = new WebSocket(info.wsUrl, { headers: { Origin: this.origin } });
      const authId = this.nextId++;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new Error('bridge 认证超时'));
        s.close();
      }, 3000);
      s.on('open', () => {
        this.ws = s;
        s.send(JSON.stringify({ jsonrpc: '2.0', id: authId, method: 'bridge.auth', params: { token: info.token } }));
      });
      s.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.id === authId) {
          if (msg.error) fail(new Error(`${msg.error.code}: ${msg.error.message}`));
          else if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        }
        this._dispatch(msg);
      });
      s.on('error', (err) => {
        fail(err);
      });
      s.on('close', () => fail(new Error('bridge 连接关闭')));
    });
  }

  _dispatch(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) this.notifications.push({ method: msg.method, params: msg.params ?? null });
  }

  rpc(method, params = {}) {
    if (!this.ws) return Promise.reject(new Error('bridge 未连接'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
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
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
