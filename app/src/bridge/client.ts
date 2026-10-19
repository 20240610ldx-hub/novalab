/** 前端 ↔ Bridge 的 WS JSON-RPC 2.0 客户端（spec §6.1）。 */

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Preserve structured failures so callers can distinguish file conflicts from retries. */
export class BridgeRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: RpcError) {
    super(error.message);
    this.name = 'BridgeRpcError';
    this.code = error.code;
    this.data = error.data;
  }
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

/** bridge 连接被关闭（进程死亡/断线）：在途请求结果未知，绝不重试或重放。 */
export class BridgeDisconnectedError extends Error {
  constructor(message = 'bridge 连接已断开') {
    super(message);
    this.name = 'BridgeDisconnectedError';
  }
}

export type BridgeStatus = 'idle' | 'connected' | 'reconnecting' | 'down';

export interface BridgeStatusEvent {
  status: BridgeStatus;
  /** 每认证到一个新的 bridge 实例（token 变化）+1；同一实例重连不变。 */
  generation: number;
  /** status=connected 时：本次是否换了 bridge 实例（旧 notebookId/内核/会话全部失效）。 */
  newInstance: boolean;
}

/** 重连退避（默认值，Owner 未单独确认）：封顶 5 s。 */
export const RECONNECT_BACKOFF_MS: readonly number[] = [250, 500, 1000, 2000, 4000, 5000];
/** 重连总预算（默认 90 s，覆盖 Tauri 侧 60 s 内 3 次重启 + 退避 + 冷启动），耗尽后 down。 */
export const RECONNECT_BUDGET_MS = 90_000;

export interface BridgeClientOptions {
  backoffMs?: readonly number[];
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type StatusListener = (event: BridgeStatusEvent) => void;

export class BridgeClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private handlers = new Set<NotificationHandler>();
  private statusListeners = new Set<StatusListener>();
  private llmProxyOrigin: string | null = null;
  private bridgeToken: string | null = null;
  /** 最近一次认证成功的 token：只在内存中判断是否换了实例，不记录、不外发。 */
  private lastToken: string | null = null;
  private status: BridgeStatus = 'idle';
  private generation = 0;
  private reconnectLoop: Promise<void> | null = null;
  private readonly backoffMs: readonly number[];
  private readonly budgetMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private url?: string, options: BridgeClientOptions = {}) {
    this.backoffMs = options.backoffMs ?? RECONNECT_BACKOFF_MS;
    this.budgetMs = options.budgetMs ?? RECONNECT_BUDGET_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  /** 首次连接：单次尝试（本身不进入自动重连）；冷启动失败由 store.connectBridge 转入 retry() 的有界循环。 */
  async connect(): Promise<void> {
    await this.connectOnce();
    this.markConnected();
  }

  /** down 后用户显式「重试连接」：重置预算重新进入重连循环。 */
  retry(): Promise<void> {
    if (this.status === 'connected') return Promise.resolve();
    return this.startReconnect();
  }

  getStatus(): BridgeStatus {
    return this.status;
  }

  getGeneration(): number {
    return this.generation;
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private emit(status: BridgeStatus, newInstance = false): void {
    this.status = status;
    const event: BridgeStatusEvent = { status, generation: this.generation, newInstance };
    for (const listener of this.statusListeners) listener(event);
  }

  private markConnected(): void {
    const changed = this.bridgeToken !== this.lastToken;
    if (changed) this.generation += 1;
    this.lastToken = this.bridgeToken;
    // 首次连接不算"换实例"：没有可失效的旧 notebookId。
    this.emit('connected', changed && this.generation > 1);
  }

  private startReconnect(): Promise<void> {
    if (this.reconnectLoop) return this.reconnectLoop;
    this.emit('reconnecting');
    this.reconnectLoop = (async () => {
      const deadline = this.now() + this.budgetMs;
      for (let attempt = 0; ; attempt += 1) {
        const delay = this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)] ?? 0;
        await this.sleep(delay);
        try {
          await this.connectOnce();
          this.reconnectLoop = null;
          this.markConnected();
          return;
        } catch {
          /* 每次尝试都重新 discovery + 认证；失败继续退避直到预算耗尽。 */
        }
        if (this.now() >= deadline) {
          this.reconnectLoop = null;
          this.emit('down');
          return;
        }
      }
    })();
    return this.reconnectLoop;
  }

  /** 已认证的连接被关闭：结算全部在途请求，进入有界重连。 */
  private onEstablishedClose(): void {
    this.ws = null;
    this.llmProxyOrigin = null;
    this.bridgeToken = null;
    this.rejectPending(new BridgeDisconnectedError());
    void this.startReconnect();
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const { reject } of pending) reject(error);
  }

  private async connectOnce(): Promise<void> {
    const discovery = this.url ? await fetchDiscovery(this.url) : await discoverBridge();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(discovery.wsUrl);
      let settled = false;
      let established = false;
      const authId = this.nextId++;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        this.pending.delete(authId);
        globalThis.clearTimeout(authTimer);
        reject(error);
      };
      const authTimer = globalThis.setTimeout(() => {
        fail(new Error('bridge 认证超时'));
        ws.close(1008, 'authentication timeout');
      }, DISCOVERY_TIMEOUT_MS * 6);
      ws.onopen = () => {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: authId, method: 'bridge.auth', params: { token: discovery.token } }));
      };
      ws.onmessage = (ev) => {
        // 已被替换的旧 socket 的迟到消息不得结算新连接的请求。
        if (established && this.ws !== ws) return;
        this.dispatch(JSON.parse(String(ev.data)) as Record<string, unknown>);
      };
      this.pending.set(authId, {
        resolve: (value) => {
          if (settled) return;
          settled = true;
          established = true;
          globalThis.clearTimeout(authTimer);
          this.ws = ws;
          this.bridgeToken = discovery.token;
          const result = value as { llmProxyOrigin?: unknown } | null;
          this.llmProxyOrigin =
            typeof result?.llmProxyOrigin === 'string' ? result.llmProxyOrigin : discovery.llmProxyOrigin;
          resolve();
        },
        reject: (error) => {
          fail(error);
          ws.close();
        },
      });
      ws.onerror = () => fail(new Error(`bridge 连接失败: ${discovery.wsUrl}`));
      ws.onclose = () => {
        if (!settled) {
          fail(new Error('bridge 连接关闭'));
          return;
        }
        if (established && this.ws === ws) this.onEstablishedClose();
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

  /** 未连接（含重连中/down）立即失败：不排队、不在新实例上补发。 */
  rpc<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const ws = this.ws;
    if (!ws) {
      return Promise.reject(this.status === 'idle' ? new Error('bridge 未连接') : new BridgeDisconnectedError());
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch {
        this.pending.delete(id);
        reject(new BridgeDisconnectedError());
      }
    });
  }

  private dispatch(msg: Record<string, unknown>) {
    const id = msg.id as number | undefined;
    if (id !== undefined && this.pending.has(id)) {
      const { resolve, reject } = this.pending.get(id)!;
      this.pending.delete(id);
      if (msg.error) reject(new BridgeRpcError(msg.error as RpcError));
      else resolve(msg.result);
      return;
    }
    for (const h of this.handlers) h(String(msg.method), msg.params);
  }
}

export const bridge = new BridgeClient();
