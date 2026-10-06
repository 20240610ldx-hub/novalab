/**
 * KernelSupervisor —— spawn / health / restart novakernel 子进程（spec §1/§2, plan P1.3）。
 *
 * - 传输层抽象 KernelTransport：生产用 StdioKernelTransport（spawn
 *   `uv run --directory <repo>/py python -m novakernel.server`），单测注入 FakeKernel。
 * - health：每 pingIntervalMs（默认 5s）发一次 ping；仅在内核 idle 时判定超时
 *   （内核 exec 期间是同步消息循环，无法应答 ping——busy 时跳过检测，防误杀长跑 cell）。
 * - 崩溃检测：进程 exit 或 ping 超时 → state=dead（kernel.status 通知）；
 *   restart() 杀进程重 spawn + load_file 回放。
 * - 并发 run 请求（exec_cell/exec_repl）FIFO 排队，queueDepth 体现在 kernel.status。
 */

import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  ERR_KERNEL,
  isKernelResponse,
  type KernelRequest,
  type KernelState,
  type KernelStatusParams,
  type KernelWireMessage,
  type NotebookState,
} from './protocol';

export interface KernelTransport {
  /** 写一行 JSON 请求到内核 stdin。 */
  send(msg: KernelRequest): void;
  /** 注册 stdout JSON-lines 消息回调（响应 + 无 id 通知）。 */
  onMessage(cb: (msg: KernelWireMessage) => void): void;
  /** 注册进程退出回调。 */
  onExit(cb: (code: number | null) => void): void;
  /** 强杀进程（Windows 下需杀整棵进程树：uv → python）。 */
  kill(): void;
}

export class KernelError extends Error {
  constructor(
    message: string,
    readonly code: number = ERR_KERNEL,
  ) {
    super(message);
    this.name = 'KernelError';
  }
}

/** 生产传输层：spawn `uv run --directory <pyDir> python -m novakernel.server`。 */
export class StdioKernelTransport implements KernelTransport {
  private readonly child: ChildProcess;
  private buf = '';
  private messageCb?: (msg: KernelWireMessage) => void;
  private exitCb?: (code: number | null) => void;
  private exited = false;
  private killed = false;

  constructor(pyDir: string) {
    this.child = spawn('uv', ['run', '--directory', pyDir, 'python', '-m', 'novakernel.server'], {
      cwd: pyDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onChunk(chunk));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (d: string) => process.stderr.write(`[novakernel] ${d}`));
    // 进程垂死时写 stdin 会 EPIPE——忽略，exit 事件兜底。
    this.child.stdin?.on('error', () => {});
    this.child.on('error', (err) => {
      process.stderr.write(`[bridge] kernel spawn 失败: ${err.message}\n`);
      this.fireExit(null);
    });
    this.child.on('exit', (code) => this.fireExit(code));
  }

  send(msg: KernelRequest): void {
    const stdin = this.child.stdin;
    if (!stdin || !stdin.writable) throw new KernelError('kernel stdin 不可写');
    stdin.write(JSON.stringify(msg) + '\n');
  }

  onMessage(cb: (msg: KernelWireMessage) => void): void {
    this.messageCb = cb;
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    const pid = this.child.pid;
    if (process.platform === 'win32' && pid !== undefined) {
      // uv run 会再 spawn python 子进程；Windows 上必须 taskkill /T 杀整棵树。
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        }).unref();
      } catch {
        /* 落入下方 child.kill 兜底 */
      }
    }
    try {
      this.child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }

  private fireExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCb?.(code);
  }

  private onChunk(chunk: string): void {
    this.buf += chunk;
    let idx = this.buf.indexOf('\n');
    while (idx >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      idx = this.buf.indexOf('\n');
      if (!line) continue;
      try {
        this.messageCb?.(JSON.parse(line) as KernelWireMessage);
      } catch {
        process.stderr.write(`[bridge] 内核 stdout 非 JSON 行已忽略: ${line.slice(0, 200)}\n`);
      }
    }
  }
}

export interface SupervisorOptions {
  transportFactory: () => KernelTransport;
  /** health ping 间隔，默认 5000ms。 */
  pingIntervalMs?: number;
  /** ping 应答超时（仅 idle 时判定），默认 5000ms。 */
  pingTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

/** 走 FIFO 队列的方法（内核执行语义要求串行）。 */
const QUEUED_METHODS = new Set(['exec_cell', 'exec_repl']);

export class KernelSupervisor extends EventEmitter {
  private transport?: KernelTransport;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private execQueue: (() => Promise<void>)[] = [];
  private execInFlight = false;
  private _state: KernelState = 'dead';
  private lastPath?: string;
  private pingTimer?: ReturnType<typeof setInterval>;
  private readonly pingIntervalMs: number;
  private readonly pingTimeoutMs: number;

  constructor(private readonly opts: SupervisorOptions) {
    super();
    this.pingIntervalMs = opts.pingIntervalMs ?? 5000;
    this.pingTimeoutMs = opts.pingTimeoutMs ?? 5000;
  }

  get state(): KernelState {
    return this._state;
  }

  get queueDepth(): number {
    return this.execQueue.length;
  }

  get loadedPath(): string | undefined {
    return this.lastPath;
  }

  /** 事件：'status' (KernelStatusParams) / 'notification' ({method, params})。 */

  /** spawn 内核并 load_file；1 文件 = 1 进程，重复 open 会先杀掉旧进程。 */
  async start(path: string): Promise<NotebookState> {
    this.stopTransport();
    this.lastPath = path;
    this.setState('restarting');
    this.spawnTransport();
    try {
      const state = (await this.request('load_file', { path })) as NotebookState;
      this.setState('idle');
      return state;
    } catch (err) {
      this.stopTransport();
      this.setState('dead');
      throw err;
    }
  }

  /** 杀进程重 spawn + load_file 回放（spec §2 崩溃恢复）。 */
  async restart(): Promise<NotebookState> {
    if (!this.lastPath) throw new KernelError('restart 失败：尚无已加载的 notebook');
    return this.start(this.lastPath);
  }

  /** 停止并杀掉内核（进程退场用）。 */
  stop(): void {
    this.stopTransport();
    this.setState('dead');
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (QUEUED_METHODS.has(method)) return this.enqueueExec(method, params);
    return this.sendRequest(method, params);
  }

  // ---------- 内部 ----------

  private setState(s: KernelState): void {
    this._state = s;
    this.emitStatus();
  }

  private emitStatus(): void {
    const params: KernelStatusParams = { state: this._state, queueDepth: this.queueDepth };
    this.emit('status', params);
  }

  private spawnTransport(): void {
    const t = this.opts.transportFactory();
    this.transport = t;
    t.onMessage((msg) => this.onWire(msg));
    t.onExit((code) => {
      if (this.transport === t) this.handleCrash(code);
    });
    this.startPing();
  }

  private stopTransport(): void {
    this.stopPing();
    const t = this.transport;
    this.transport = undefined;
    for (const p of this.pending.values()) {
      p.reject(new KernelError(`内核请求被取消（${p.method}）：进程已停止`));
    }
    this.pending.clear();
    this.execQueue = [];
    this.execInFlight = false;
    t?.kill();
  }

  private handleCrash(code: number | null): void {
    if (!this.transport) return;
    this.stopTransport();
    this.setState('dead');
    this.emit('crash', { code });
  }

  private onWire(msg: KernelWireMessage): void {
    if (isKernelResponse(msg)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return; // 迟到的响应（如已被超时清理的 ping）
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new KernelError(msg.error.message, msg.error.code || ERR_KERNEL));
      } else {
        pending.resolve(msg.result);
      }
    } else {
      this.emit('notification', { method: msg.method, params: msg.params });
    }
  }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const t = this.transport;
    if (!t) return Promise.reject(new KernelError(`内核未运行，无法执行 ${method}`));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        t.send({ id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new KernelError(String(err)));
      }
    });
  }

  private enqueueExec(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      this.execQueue.push(async () => {
        try {
          resolve(await this.sendRequest(method, params));
        } catch (err) {
          reject(err);
        }
      });
      this.emitStatus();
      this.drainQueue();
    });
  }

  private drainQueue(): void {
    if (this.execInFlight) return;
    const next = this.execQueue.shift();
    if (!next) {
      if (this._state === 'busy') this.setState('idle');
      else this.emitStatus();
      return;
    }
    this.execInFlight = true;
    // 内核已死/无传输时不切 busy：任务会立即 reject，state 保持 dead。
    if (this.transport && this._state !== 'dead') this.setState('busy');
    else this.emitStatus();
    void Promise.resolve()
      .then(next)
      .finally(() => {
        this.execInFlight = false;
        this.drainQueue();
      });
  }

  private startPing(): void {
    this.stopPing();
    const timer = setInterval(() => {
      // busy（exec 中）/ restarting / dead 时不做 ping 判定：
      // 内核是同步消息循环，长跑 cell 期间无法应答，ping 超时会误杀。
      if (this._state !== 'idle' || !this.transport) return;
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          process.stderr.write('[bridge] kernel ping 超时，判定死亡\n');
          this.handleCrash(null);
        }
      }, this.pingTimeoutMs);
      timeout.unref?.();
      this.pending.set(id, {
        resolve: () => clearTimeout(timeout),
        reject: () => clearTimeout(timeout),
        method: 'ping',
      });
      try {
        this.transport.send({ id, method: 'ping' });
      } catch {
        clearTimeout(timeout);
      }
    }, this.pingIntervalMs);
    timer.unref?.();
    this.pingTimer = timer;
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }
}
