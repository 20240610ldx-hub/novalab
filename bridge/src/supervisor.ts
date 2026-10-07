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
import { readFileSync } from 'node:fs';
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
  /**
   * 子进程 pid（P3.1 内存水位采样用）；无法获知时缺省（FakeKernel）。
   * 生产 StdioKernelTransport 返回 uv 包装进程 pid（python 是其子进程）。
   */
  readonly pid?: number;
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

  get pid(): number | undefined {
    return this.child.pid;
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

  /** 当前传输层子进程 pid（内存水位采样用；无传输时 undefined）。 */
  get pid(): number | undefined {
    return this.transport?.pid;
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

/* ------------------------------------------------------------------ */
/* P3.1 多内核：SupervisorRegistry —— 每 path 一个 KernelSupervisor      */
/* ------------------------------------------------------------------ */

/**
 * 每实例 supervisor 事件（按 path 打标）——router 据此把内核事件路由到对应
 * notebook 上下文。三种事件都携带来源 path；registry 只转发，不解释语义。
 */
export interface KernelStatusEvent {
  path: string;
  params: KernelStatusParams;
}
export interface KernelNotificationEvent {
  path: string;
  method: string;
  params?: unknown;
}
export interface KernelCrashEvent {
  path: string;
  code: number | null;
}

/**
 * supervisor 注册表：按 path 管理 KernelSupervisor 生命周期。
 * - MultiSupervisor（生产 / 多 tab 测试）：每 path 惰性新建并保活一个 supervisor；
 * - SingleSupervisorRegistry（既有单 supervisor 路由测试的兼容包装）：所有 path
 *   复用同一个注入的 supervisor（单 notebook 替换语义）。
 * 事件（'kernel-status' / 'kernel-notification' / 'kernel-crash'）按 path 打标转发。
 */
export interface SupervisorRegistry extends EventEmitter {
  /** 取该 path 的 supervisor，不存在则创建（不 start）。 */
  ensure(path: string): KernelSupervisor;
  get(path: string): KernelSupervisor | undefined;
  /** 已登记的 path 列表。 */
  paths(): string[];
  /** 该 path 内核进程的 RSS（MB）水位；不可采样 → null。 */
  rssMB(path: string): number | null;
  /** 停止并摘除该 path 的 supervisor（关 tab）。 */
  release(path: string): void;
  /** 停止全部（进程退场）。 */
  stopAll(): void;
}

/**
 * 默认 RSS 采样器：仅 Linux 读 /proc/<pid>/status 的 VmRSS（kB→MB 取整）。
 * Windows / macOS 无 /proc → null（协议允许 rssMB=null）；注意生产 pid 是 uv run
 * 包装进程而非 python 本体，故 Linux 上也只是近似水位——精确到 python 需枚举子进程，
 * 超出 P3.1 范围（遗留）。可经 MultiSupervisorOptions.rssSampler 注入替换（单测）。
 */
export function defaultRssSampler(pid: number | undefined): number | null {
  if (pid === undefined || process.platform !== 'linux') return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /VmRSS:\s+(\d+)\s*kB/.exec(status);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

export interface MultiSupervisorOptions {
  /** 每 path 新建 supervisor 时的传输层工厂（生产：StdioKernelTransport）。 */
  transportFactory: () => KernelTransport;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  /** RSS 采样器（默认 defaultRssSampler；单测注入固定值验证 list 形状）。 */
  rssSampler?: (pid: number | undefined) => number | null;
}

/** 多内核注册表：Map<path, KernelSupervisor>，health/restart/rss per instance。 */
export class MultiSupervisor extends EventEmitter implements SupervisorRegistry {
  private readonly sups = new Map<string, KernelSupervisor>();
  private readonly sampler: (pid: number | undefined) => number | null;

  constructor(private readonly opts: MultiSupervisorOptions) {
    super();
    this.sampler = opts.rssSampler ?? defaultRssSampler;
  }

  ensure(path: string): KernelSupervisor {
    const existing = this.sups.get(path);
    if (existing) return existing;
    const sup = new KernelSupervisor({
      transportFactory: this.opts.transportFactory,
      ...(this.opts.pingIntervalMs !== undefined ? { pingIntervalMs: this.opts.pingIntervalMs } : {}),
      ...(this.opts.pingTimeoutMs !== undefined ? { pingTimeoutMs: this.opts.pingTimeoutMs } : {}),
    });
    // 事件按 path 打标转发给 router（每实例独立订阅，一次即可）
    sup.on('status', (params: KernelStatusParams) => this.emit('kernel-status', { path, params }));
    sup.on('notification', (n: { method: string; params?: unknown }) =>
      this.emit('kernel-notification', { path, method: n.method, params: n.params }),
    );
    sup.on('crash', (c: { code: number | null }) => this.emit('kernel-crash', { path, code: c.code }));
    this.sups.set(path, sup);
    return sup;
  }

  get(path: string): KernelSupervisor | undefined {
    return this.sups.get(path);
  }

  paths(): string[] {
    return [...this.sups.keys()];
  }

  rssMB(path: string): number | null {
    const sup = this.sups.get(path);
    if (!sup) return null;
    return this.sampler(sup.pid);
  }

  release(path: string): void {
    const sup = this.sups.get(path);
    if (!sup) return;
    sup.stop();
    this.sups.delete(path);
  }

  stopAll(): void {
    for (const sup of this.sups.values()) sup.stop();
    this.sups.clear();
  }
}

/**
 * 单 supervisor 兼容包装：既有路由单测以 RouterDeps.supervisor 注入一个
 * KernelSupervisor（单 notebook 替换语义）。本包装把它适配成 SupervisorRegistry，
 * 所有 path 复用同一实例，事件按其 loadedPath 打标（start() 会先置 lastPath，
 * 故 restarting/idle 等状态事件都能路由到当前上下文）。
 */
export class SingleSupervisorRegistry extends EventEmitter implements SupervisorRegistry {
  constructor(private readonly sup: KernelSupervisor) {
    super();
    const tag = (): string => this.sup.loadedPath ?? '';
    sup.on('status', (params: KernelStatusParams) => this.emit('kernel-status', { path: tag(), params }));
    sup.on('notification', (n: { method: string; params?: unknown }) =>
      this.emit('kernel-notification', { path: tag(), method: n.method, params: n.params }),
    );
    sup.on('crash', (c: { code: number | null }) => this.emit('kernel-crash', { path: tag(), code: c.code }));
  }

  ensure(_path: string): KernelSupervisor {
    return this.sup;
  }
  get(_path: string): KernelSupervisor | undefined {
    return this.sup;
  }
  paths(): string[] {
    const p = this.sup.loadedPath;
    return p ? [p] : [];
  }
  rssMB(_path: string): number | null {
    return null;
  }
  release(_path: string): void {
    this.sup.stop();
  }
  stopAll(): void {
    this.sup.stop();
  }
}
