/**
 * FakeKernel —— in-process 假内核（实现 KernelTransport 契约，spec §6.2）。
 *
 * 仅供 vitest 注入 KernelSupervisor，单测不 spawn 真内核。
 * 行为：JSON-lines 请求 → 异步回响应 + run.* 通知；内置极简 defs/refs 分析，
 * set_cells 会像真内核一样返回重算后的 cells/dagEdges/staleSet。
 */

import { EventEmitter } from 'node:events';
import type { KernelTransport } from '../supervisor';
import type {
  CellInfo,
  DagEdge,
  KernelRequest,
  KernelWireMessage,
  NotebookState,
  RunReport,
  SetCellsResult,
  VarSchema,
} from '../protocol';

const PY_KEYWORDS = new Set([
  'import', 'from', 'as', 'def', 'class', 'return', 'if', 'else', 'elif', 'for',
  'while', 'in', 'not', 'and', 'or', 'is', 'None', 'True', 'False', 'print',
  'len', 'range', 'int', 'str', 'float', 'list', 'dict', 'set', 'with', 'try',
  'except', 'finally', 'raise', 'lambda', 'yield', 'del', 'pass', 'break',
  'continue', 'assert', 'global', 'self',
]);

function analyze(code: string): { defs: string[]; refs: string[] } {
  const defs = new Set<string>();
  const assignRe = /^[ \t]*([A-Za-z_]\w*)\s*=(?!=)/gm;
  let m: RegExpExecArray | null;
  while ((m = assignRe.exec(code)) !== null) defs.add(m[1]!);
  const importRe = /^[ \t]*(?:import|from)\s+([A-Za-z_]\w*)/gm;
  while ((m = importRe.exec(code)) !== null) defs.add(m[1]!);
  const defRe = /^[ \t]*(?:def|class)\s+([A-Za-z_]\w*)/gm;
  while ((m = defRe.exec(code)) !== null) defs.add(m[1]!);

  const refs = new Set<string>();
  const identRe = /\b[A-Za-z_]\w*\b/g;
  while ((m = identRe.exec(code)) !== null) {
    const name = m[0]!;
    if (!defs.has(name) && !PY_KEYWORDS.has(name)) refs.add(name);
  }
  return { defs: [...defs], refs: [...refs] };
}

function buildEdges(cells: CellInfo[]): DagEdge[] {
  const edges: DagEdge[] = [];
  for (const c1 of cells) {
    for (const c2 of cells) {
      if (c1.id === c2.id) continue;
      if (c2.refs.some((r) => c1.defs.includes(r))) edges.push({ from: c1.id, to: c2.id });
    }
  }
  return edges;
}

function downstreamClosure(ids: string[], edges: DagEdge[]): string[] {
  const out = new Set<string>();
  const queue = [...ids];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.from === cur && !out.has(e.to)) {
        out.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return [...out];
}

export class FakeKernel extends EventEmitter implements KernelTransport {
  /** 当前 cells（可预置）。 */
  cells: CellInfo[] = [
    { id: 'a', code: 'x = 1', execCount: 0, defs: ['x'], refs: [] },
    { id: 'b', code: 'y = x + 1', execCount: 0, defs: ['y'], refs: ['x'] },
    { id: 'c', code: 'print(y)', execCount: 0, defs: [], refs: ['y'] },
  ];
  staleSet: string[] = [];
  /** 收到的全部请求记录（顺序），供断言。 */
  requests: { method: string; params?: Record<string, unknown> }[] = [];
  /** exec 类请求的模拟耗时（排队/并发测试用）。 */
  execDelayMs = 0;
  /** 脚本化失败：exec 该 cell 时回 run.error + ok:false。 */
  failCell?: { cellId: string; traceback: string };
  /** 脚本化编译错：下一次 set_cells 返回 compileError。 */
  nextCompileError?: { message: string; cellIds: string[] };
  /** 不回 ping（测 supervisor 超时判死）。 */
  ignorePing = false;
  /** 固定 schemas（否则按 defs 生成）。 */
  overrideSchemas?: VarSchema[];
  loadedPath?: string;

  concurrency = 0;
  maxConcurrency = 0;

  private messageCb?: (msg: KernelWireMessage) => void;
  private exitCb?: (code: number | null) => void;
  private alive = true;

  // ---------- KernelTransport ----------

  send(msg: KernelRequest): void {
    if (!this.alive) throw new Error('FakeKernel 已退出');
    this.requests.push({ method: msg.method, params: msg.params });
    const delay = msg.method === 'exec_cell' || msg.method === 'exec_repl' ? this.execDelayMs : 0;
    setTimeout(() => void this.process(msg), delay);
  }

  onMessage(cb: (msg: KernelWireMessage) => void): void {
    this.messageCb = cb;
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }

  kill(): void {
    this.crash(null);
  }

  // ---------- 测试控制面 ----------

  /** 模拟进程崩溃退出。 */
  crash(code: number | null = 1): void {
    if (!this.alive) return;
    this.alive = false;
    this.exitCb?.(code);
  }

  countOf(method: string): number {
    return this.requests.filter((r) => r.method === method).length;
  }

  // ---------- 内核契约实现 ----------

  private async process(msg: KernelRequest): Promise<void> {
    if (!this.alive) return;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    switch (msg.method) {
      case 'ping':
        if (!this.ignorePing) this.respond(msg.id, { pong: true, version: 'fake' });
        return;
      case 'load_file': {
        this.loadedPath = String(params['path'] ?? '');
        this.respond(msg.id, this.stateOf());
        return;
      }
      case 'save_file':
        this.respond(msg.id, { ok: true });
        return;
      case 'set_cells':
        this.respond(msg.id, this.setCells(params));
        return;
      case 'exec_cell': {
        this.concurrency++;
        this.maxConcurrency = Math.max(this.maxConcurrency, this.concurrency);
        try {
          const report = this.execOnce(String(params['cellId'] ?? ''), params['cascade'] === true);
          this.respond(msg.id, report);
        } finally {
          this.concurrency--;
        }
        return;
      }
      case 'exec_repl': {
        this.concurrency++;
        this.maxConcurrency = Math.max(this.maxConcurrency, this.concurrency);
        try {
          const report = this.execOnce('repl', false, String(params['code'] ?? ''));
          this.respond(msg.id, report);
        } finally {
          this.concurrency--;
        }
        return;
      }
      case 'introspect':
        this.respond(msg.id, { schemas: this.schemasOf() });
        return;
      case 'shutdown':
        this.respond(msg.id, { ok: true });
        this.crash(0);
        return;
      default:
        this.respondError(msg.id, -32601, `method not found: ${msg.method}`);
    }
  }

  private setCells(params: Record<string, unknown>): SetCellsResult {
    const incoming = (params['cells'] ?? []) as { id: string; code: string }[];
    const prevCode = new Map(this.cells.map((c) => [c.id, c.code]));
    const prevExec = new Map(this.cells.map((c) => [c.id, c.execCount]));
    const next: CellInfo[] = incoming.map((c) => {
      const { defs, refs } = analyze(c.code);
      return {
        id: c.id,
        code: c.code,
        execCount: prevExec.get(c.id) ?? 0,
        defs,
        refs,
      };
    });
    const changed = next.filter((c) => prevCode.has(c.id) && prevCode.get(c.id) !== c.code).map((c) => c.id);
    this.cells = next;
    const dagEdges = buildEdges(next);
    this.staleSet = downstreamClosure(changed, dagEdges);
    const compileError = this.nextCompileError;
    this.nextCompileError = undefined;
    return {
      cells: next,
      dagEdges,
      staleSet: this.staleSet,
      ...(compileError ? { compileError } : {}),
    };
  }

  private execOnce(cellId: string, cascade: boolean, replCode?: string): RunReport {
    const t0 = Date.now();
    const isRepl = cellId === 'repl';
    const fail = this.failCell && this.failCell.cellId === cellId;
    this.notify('run.started', { cellId });

    if (fail) {
      const traceback = this.failCell!.traceback;
      this.notify('run.error', { cellId, traceback, frames: [] });
      return { cellId, ok: false, cascaded: [], durationMs: Date.now() - t0, traceback };
    }

    let execCount = 0;
    if (!isRepl) {
      const cell = this.cells.find((c) => c.id === cellId);
      if (cell) {
        cell.execCount++;
        execCount = cell.execCount;
      }
    }
    this.notify('run.stdout', {
      cellId,
      text: isRepl ? `repl: ${replCode ?? ''}\n` : `fake output for ${cellId}\n`,
    });

    const cascaded: string[] = [];
    if (cascade && !isRepl) {
      const edges = buildEdges(this.cells);
      for (const id of downstreamClosure([cellId], edges)) {
        const cell = this.cells.find((c) => c.id === id);
        if (!cell) continue;
        cell.execCount++;
        cascaded.push(id);
        this.notify('run.started', { cellId: id });
        this.notify('run.stdout', { cellId: id, text: `fake output for ${id}\n` });
        this.notify('run.done', { cellId: id, execCount: cell.execCount, cascaded: [], durationMs: 0 });
      }
    }
    if (!isRepl) {
      const executed = new Set([cellId, ...cascaded]);
      this.staleSet = this.staleSet.filter((id) => !executed.has(id));
    }
    this.notify('run.done', { cellId, execCount, cascaded, durationMs: Date.now() - t0 });
    return { cellId, ok: true, cascaded, durationMs: Date.now() - t0 };
  }

  private stateOf(): NotebookState {
    const dagEdges = buildEdges(this.cells);
    const execCounts: Record<string, number> = {};
    for (const c of this.cells) execCounts[c.id] = c.execCount;
    return {
      cells: structuredClone(this.cells),
      dagEdges,
      schemas: this.schemasOf(),
      staleSet: [...this.staleSet],
      execCounts,
    };
  }

  private schemasOf(): VarSchema[] {
    if (this.overrideSchemas) return structuredClone(this.overrideSchemas);
    const names = new Set<string>();
    for (const c of this.cells) for (const d of c.defs) names.add(d);
    return [...names].map((name) => ({ name, type: 'fake', preview: `<${name}>` }));
  }

  private respond(id: number, result: unknown): void {
    this.messageCb?.({ id, result });
  }

  private respondError(id: number, code: number, message: string): void {
    this.messageCb?.({ id, error: { code, message } });
  }

  private notify(method: string, params: unknown): void {
    this.messageCb?.({ method, params });
  }
}
