/** 前端 ↔ Bridge 的 WS JSON-RPC 2.0 客户端（spec §6.1）。 */

export interface RpcError {
  code: number;
  message: string;
}

type NotificationHandler = (method: string, params: unknown) => void;

export interface BridgeDiscovery {
  version: string;
  wsPort: number;
  wsUrl: string;
  llmPort: number;
  llmProxyOrigin: string;
  token: string;
}

const DEFAULT_BRIDGE_PORT = 7788;
const MAX_BRIDGE_PORT = 7798;
const DISCOVERY_PATH = '/bridge-info';
const DISCOVERY_TIMEOUT_MS = 500;

function isDiscovery(value: unknown): value is BridgeDiscovery {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === 'string' &&
    typeof v.wsPort === 'number' &&
    typeof v.wsUrl === 'string' &&
    typeof v.llmPort === 'number' &&
    typeof v.llmProxyOrigin === 'string' &&
    typeof v.token === 'string' &&
    v.token.length > 0
  );
}

function httpUrlForWebSocket(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  parsed.pathname = DISCOVERY_PATH;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

async function fetchDiscovery(url: string): Promise<BridgeDiscovery> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(httpUrlForWebSocket(url), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`bridge discovery HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!isDiscovery(value)) throw new Error('bridge discovery 响应格式无效');
    return value;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/** 扫描 Bridge 允许的端口范围，解决 bridge 端口自动 +1 后前端仍连旧端口的问题。 */
export async function discoverBridge(startPort = DEFAULT_BRIDGE_PORT): Promise<BridgeDiscovery> {
  const first = Math.max(DEFAULT_BRIDGE_PORT, Math.min(startPort, MAX_BRIDGE_PORT));
  for (let port = first; port <= MAX_BRIDGE_PORT; port += 1) {
    try {
      return await fetchDiscovery(`ws://127.0.0.1:${port}/`);
    } catch {
      /* 端口未监听、CORS 拒绝或旧 bridge 均继续探测下一个候选。 */
    }
  }
  throw new Error(`bridge discovery 失败（已探测 ${first}-${MAX_BRIDGE_PORT}）`);
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private handlers = new Set<NotificationHandler>();
  private llmProxyOrigin: string | null = null;
  private bridgeToken: string | null = null;

  constructor(private url?: string) {}

  async connect(): Promise<void> {
    const discovery = this.url ? await fetchDiscovery(this.url) : await discoverBridge();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(discovery.wsUrl);
      let settled = false;
      const authId = this.nextId++;
      const authTimer = globalThis.setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('bridge 认证超时'));
          ws.close(1008, 'authentication timeout');
        }
      }, DISCOVERY_TIMEOUT_MS * 6);
      ws.onopen = () => {
        this.ws = ws;
        this.llmProxyOrigin = discovery.llmProxyOrigin;
        this.bridgeToken = discovery.token;
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: authId, method: 'bridge.auth', params: { token: discovery.token } }));
      };
      ws.onmessage = (ev) => this.dispatch(JSON.parse(String(ev.data)) as Record<string, unknown>);
      this.pending.set(authId, {
        resolve: (value) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(authTimer);
          const result = value as { llmProxyOrigin?: unknown };
          if (typeof result.llmProxyOrigin === 'string') this.llmProxyOrigin = result.llmProxyOrigin;
          resolve();
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(authTimer);
          reject(error);
        },
      });
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          globalThis.clearTimeout(authTimer);
          reject(new Error(`bridge 连接失败: ${discovery.wsUrl}`));
        }
      };
      ws.onclose = () => {
        this.ws = null;
        this.llmProxyOrigin = null;
        this.bridgeToken = null;
        for (const { reject: r } of this.pending.values()) r(new Error('bridge 连接关闭'));
        this.pending.clear();
        if (!settled) {
          settled = true;
          globalThis.clearTimeout(authTimer);
          reject(new Error('bridge 连接关闭'));
        }
      };
    });
  }

  getLlmProxyOrigin(): string | null {
    return this.llmProxyOrigin;
  }

  /** Headers for the local LLM proxy; the token never enters the model payload. */
  getLlmProxyHeaders(): Record<string, string> {
    return this.bridgeToken ? { 'x-novalab-bridge-token': this.bridgeToken } : {};
  }

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  rpc<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (!this.ws) return Promise.reject(new Error('bridge 未连接'));
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
  }

  private dispatch(msg: Record<string, unknown>) {
    const id = msg.id as number | undefined;
    if (id !== undefined && this.pending.has(id)) {
      const { resolve, reject } = this.pending.get(id)!;
      this.pending.delete(id);
      if (msg.error) reject(new Error((msg.error as RpcError).message));
      else resolve(msg.result);
      return;
    }
    for (const h of this.handlers) h(String(msg.method), msg.params);
  }
}

export const bridge = new BridgeClient();
