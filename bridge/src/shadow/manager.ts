/**
 * ShadowManager —— ADR-013 影子内核进程管理（S0/S1）。
 *
 * - 每次 run 一个全新的 `python -m novakernel.shadow_server` 进程（不复用：候选代码可能
 *   monkeypatch 模块）；跑完保留到下一次 run / TTL，供 verify 在同一状态上求值。
 * - 最小环境（O3）：不继承凭据类变量与代理；TEMP/HOME/APPDATA 指向本次 scratch；
 *   BLAS 线程上限（否则 OpenBLAS 按核数预留内存，低内存上限下 import 即崩，ADR §12）。
 * - 内存上限（O2）= min(4 GiB, 物理内存 × 40%)，由影子进程在执行用户代码前施加于自身
 *   （Windows Job Object / POSIX RLIMIT_AS）并从 OS 读回；施加失败 → 拒绝运行。
 * - 取消 / 超时：直接终止真实 python 进程（init 报回的 pid；Windows venv 的 python.exe 是
 *   启动器，杀它不等于杀解释器）+ 启动器；scratch 目录在进程退出后删除。
 * - 孤儿防护：NOVALAB_SHADOW_PARENT_PID = bridge pid，影子进程自带看门狗（父进程死即退出）；
 *   启动时清扫已死 bridge 遗留的 scratch 目录（只认 novalab-shadow-<pid>- 前缀且 pid 已不在）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CellSrc {
  id: string;
  code: string;
}

export interface ShadowRunRequest {
  /** 影子状态的归属（notebookId）：同一 key 同时只保留一个进程。 */
  key: string;
  /** 影子进程 cwd（与用户内核相同的 Jupyter 语义：相对路径按 notebook 目录读）。 */
  notebookDir: string;
  base: CellSrc[];
  candidates: { name: string; cells: CellSrc[] }[];
  seed?: number;
  k?: number;
  timeoutMs: number;
}

export type ShadowRunOutcome =
  | { status: 'ok'; result: unknown; pid?: number; memLimit?: unknown }
  | { status: 'timeout' | 'cancelled' | 'crashed' | 'unavailable' | 'limit-unavailable'; detail?: string };

export type ShadowVerifyOutcome =
  | { status: 'ok'; result: unknown }
  | { status: 'not-retained' | 'timeout' | 'crashed' | 'cancelled' };

/** router 依赖的最小接口（单测注入假实现）。 */
export interface ShadowRunner {
  readonly memLimitBytes: number;
  run(req: ShadowRunRequest): Promise<ShadowRunOutcome>;
  verify(key: string, candidate: string, contracts: unknown[], timeoutMs: number): Promise<ShadowVerifyOutcome>;
  /** 取消该 key 的在途运行（并丢弃保留状态）；无在途运行返回 false。 */
  cancel(key: string): boolean;
  /** 丢弃该 key 的保留状态（关闭 notebook）。 */
  release(key: string): void;
  dispose(): void;
}

const GiB = 1024 ** 3;
const SCRATCH_PREFIX = 'novalab-shadow-';
const INIT_TIMEOUT_MS = 30_000;
const DEFAULT_TTL_MS = 120_000;

/** O2：min(4 GiB, 物理内存 × 40%)。 */
export function defaultShadowMemLimit(totalMem: number = os.totalmem()): number {
  return Math.min(4 * GiB, Math.floor(totalMem * 0.4));
}

/** 影子进程环境：白名单构造，不从 process.env 透传任何其它变量（凭据、代理、token）。 */
export function buildShadowEnv(
  scratch: string,
  pyDir: string,
  parentPid: number,
  threadCap: number,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const keep = ['SYSTEMROOT', 'SystemRoot', 'WINDIR', 'PATH', 'Path', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (source[k] !== undefined) env[k] = source[k];
  const t = String(threadCap);
  Object.assign(env, {
    TEMP: scratch, TMP: scratch, TMPDIR: scratch, HOME: scratch, USERPROFILE: scratch,
    APPDATA: scratch, LOCALAPPDATA: scratch, MPLCONFIGDIR: scratch, MPLBACKEND: 'Agg',
    PYTHONHASHSEED: '0', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    PYTHONPATH: pyDir, NOVALAB_SHADOW: '1', NOVALAB_SHADOW_PARENT_PID: String(parentPid),
    OPENBLAS_NUM_THREADS: t, OMP_NUM_THREADS: t, MKL_NUM_THREADS: t, NUMEXPR_NUM_THREADS: t,
  });
  return env;
}

export function shadowPython(pyDir: string): string {
  return process.platform === 'win32'
    ? path.join(pyDir, '.venv', 'Scripts', 'python.exe')
    : path.join(pyDir, '.venv', 'bin', 'python');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 清扫已死 bridge 留下的 scratch（只删 novalab-shadow-<pid>- 且 pid 已退出的目录）。 */
export function sweepStaleScratch(root: string = os.tmpdir(), selfPid: number = process.pid): string[] {
  const removed: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of entries) {
    const m = /^novalab-shadow-(\d+)-/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === selfPid || pidAlive(pid)) continue;
    try {
      rmSync(path.join(root, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* 下次再清 */
    }
  }
  return removed;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

class ShadowProcess {
  readonly child: ChildProcess;
  realPid?: number;
  private seq = 0;
  private buf = '';
  private readonly pending = new Map<number, Pending>();
  readonly exited: Promise<number | null>;
  isExited = false;
  cancelled = false;
  busy = false;
  ttl?: NodeJS.Timeout;

  constructor(python: string, cwd: string, env: NodeJS.ProcessEnv, readonly scratch: string) {
    this.child = spawn(python, ['-m', 'novakernel.shadow_server'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onChunk(chunk));
    this.child.stdin?.on('error', () => {});
    this.exited = new Promise((resolve) => {
      const done = (code: number | null): void => {
        if (this.isExited) return;
        this.isExited = true;
        for (const p of this.pending.values()) p.reject(new Error('shadow process exited'));
        this.pending.clear();
        removeScratch(this.scratch);
        resolve(code);
      };
      this.child.on('exit', done);
      this.child.on('error', () => done(null));
    });
  }

  call(method: string, params: unknown): Promise<unknown> {
    if (this.isExited) return Promise.reject(new Error('shadow process exited'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child.stdin!.write(JSON.stringify({ id, method, params }) + '\n');
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  kill(): void {
    if (this.ttl) clearTimeout(this.ttl);
    if (this.realPid !== undefined) {
      try {
        process.kill(this.realPid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    if (process.platform === 'win32' && this.child.pid !== undefined && this.realPid === undefined) {
      // init 前被杀：真实解释器 pid 未知，按进程树杀（venv 启动器 → python）
      try {
        spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref();
      } catch {
        /* 兜底见下 */
      }
    }
    try {
      this.child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }

  private onChunk(chunk: string): void {
    this.buf += chunk;
    let idx = this.buf.indexOf('\n');
    while (idx >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      idx = this.buf.indexOf('\n');
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { code: number; message: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 协议 fd 已与用户输出隔离；非 JSON 行只可能是内核自身故障
      }
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!p) continue;
      this.pending.delete(msg.id!);
      if (msg.error) p.reject(new Error(`shadow ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  }
}

function removeScratch(dir: string): void {
  // Windows 进程退出后句柄释放可能滞后几毫秒：重试几次
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch {
      /* retry */
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve('timeout'), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export interface ShadowManagerOptions {
  pyDir: string;
  memLimitBytes?: number;
  tmpRoot?: string;
  ttlMs?: number;
  threadCap?: number;
  /** 测试注入：python 可执行文件。 */
  python?: string;
  envSource?: NodeJS.ProcessEnv;
}

export class ShadowManager implements ShadowRunner {
  readonly memLimitBytes: number;
  private readonly procs = new Map<string, ShadowProcess>();
  private readonly tmpRoot: string;
  private readonly ttlMs: number;
  private readonly threadCap: number;
  private readonly python: string;

  constructor(private readonly opts: ShadowManagerOptions) {
    this.memLimitBytes = opts.memLimitBytes ?? defaultShadowMemLimit();
    this.tmpRoot = opts.tmpRoot ?? os.tmpdir();
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.threadCap = opts.threadCap ?? Math.max(1, Math.min(4, os.availableParallelism?.() ?? 4));
    this.python = opts.python ?? shadowPython(opts.pyDir);
    sweepStaleScratch(this.tmpRoot);
  }

  /** 当前存活的影子进程（真实解释器 pid；验收用）。 */
  livePids(): number[] {
    return [...this.procs.values()].filter((p) => !p.isExited && p.realPid !== undefined).map((p) => p.realPid!);
  }

  async run(req: ShadowRunRequest): Promise<ShadowRunOutcome> {
    this.release(req.key);
    if (!existsSync(this.python)) return { status: 'unavailable', detail: 'python environment not prepared' };
    const scratch = mkdtempSync(path.join(this.tmpRoot, `${SCRATCH_PREFIX}${process.pid}-`));
    const env = buildShadowEnv(scratch, this.opts.pyDir, process.pid, this.threadCap, this.opts.envSource);
    const proc = new ShadowProcess(this.python, req.notebookDir, env, scratch);
    this.procs.set(req.key, proc);

    const exitOutcome = proc.exited.then(() => 'exit' as const);
    try {
      const init = await Promise.race([
        withTimeout(
          proc.call('init', { scratchDir: scratch, notebookDir: req.notebookDir, memLimitBytes: this.memLimitBytes }),
          INIT_TIMEOUT_MS,
        ),
        exitOutcome,
      ]);
      if (init === 'timeout' || init === 'exit') return this.finish(req.key, proc, init === 'timeout' ? 'timeout' : 'crashed');
      const info = init as { pid?: number; memLimit?: { mechanism?: string | null; limitBytes?: number | null } };
      if (typeof info.pid === 'number') proc.realPid = info.pid;
      if (!info.memLimit?.mechanism || !info.memLimit.limitBytes) {
        // fail closed：拿不到 OS 级内存上限就不跑用户代码
        this.release(req.key);
        return { status: 'limit-unavailable' };
      }
      if (proc.cancelled) return this.finish(req.key, proc, 'cancelled');
      proc.busy = true;
      const res = await Promise.race([
        withTimeout(
          proc.call('run', {
            base: req.base,
            candidates: req.candidates,
            seed: req.seed ?? 0,
            ...(req.k !== undefined ? { k: req.k } : {}),
          }),
          req.timeoutMs,
        ),
        exitOutcome,
      ]);
      proc.busy = false;
      if (proc.cancelled) return this.finish(req.key, proc, 'cancelled');
      if (res === 'timeout') return this.finish(req.key, proc, 'timeout');
      if (res === 'exit') return this.finish(req.key, proc, 'crashed');
      proc.ttl = setTimeout(() => this.release(req.key), this.ttlMs);
      proc.ttl.unref?.();
      return { status: 'ok', result: res, pid: proc.realPid, memLimit: info.memLimit };
    } catch {
      return this.finish(req.key, proc, proc.cancelled ? 'cancelled' : 'crashed');
    }
  }

  private finish(key: string, proc: ShadowProcess, status: 'timeout' | 'cancelled' | 'crashed'): ShadowRunOutcome {
    proc.kill();
    if (this.procs.get(key) === proc) this.procs.delete(key);
    return { status };
  }

  async verify(key: string, candidate: string, contracts: unknown[], timeoutMs: number): Promise<ShadowVerifyOutcome> {
    const proc = this.procs.get(key);
    if (!proc || proc.isExited || proc.busy) return { status: 'not-retained' };
    try {
      const res = await Promise.race([
        withTimeout(proc.call('verify', { candidate, contracts }), timeoutMs),
        proc.exited.then(() => 'exit' as const),
      ]);
      if (proc.cancelled) return { status: 'cancelled' };
      if (res === 'timeout') {
        this.release(key);
        return { status: 'timeout' };
      }
      if (res === 'exit') return { status: 'crashed' };
      return { status: 'ok', result: res };
    } catch {
      return { status: proc.cancelled ? 'cancelled' : 'crashed' };
    }
  }

  cancel(key: string): boolean {
    const proc = this.procs.get(key);
    if (!proc || proc.isExited) return false;
    proc.cancelled = true;
    proc.kill();
    this.procs.delete(key);
    return true;
  }

  release(key: string): void {
    const proc = this.procs.get(key);
    if (!proc) return;
    this.procs.delete(key);
    proc.kill();
  }

  /** 等待该 key 之前的进程完全退出（验收用：确认清理完成）。 */
  async drain(): Promise<void> {
    await Promise.all([...this.procs.values()].map((p) => p.exited));
  }

  dispose(): void {
    for (const key of [...this.procs.keys()]) this.release(key);
  }
}
