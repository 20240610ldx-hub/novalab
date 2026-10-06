/** 前端 ↔ Bridge 的 WS JSON-RPC 2.0 客户端（spec §6.1）。 */

export interface RpcError {
  code: number;
  message: string;
}

type NotificationHandler = (method: string, params: unknown) => void;

export class BridgeClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private handlers = new Set<NotificationHandler>();

  constructor(private url = 'ws://127.0.0.1:7788') {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.onopen = () => {
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => reject(new Error(`bridge 连接失败: ${this.url}`));
      ws.onmessage = (ev) => this.dispatch(JSON.parse(String(ev.data)) as Record<string, unknown>);
      ws.onclose = () => {
        this.ws = null;
        for (const { reject: r } of this.pending.values()) r(new Error('bridge 连接关闭'));
        this.pending.clear();
      };
    });
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
