/**
 * ADR-012 对比用合成夹具（不含任何 Owner 真实科研数据）。
 *
 * 每个夹具 = 一个小 notebook + 一个"内核判定器"(oracle) + 一份脚本化 stub 模型策略。
 * OracleKernel 在 FakeKernel 上加三件事：
 *  1. exec_cell 时按当前源码问 oracle 该 cell 是否报错（修好了才不报错）；
 *  2. validate_cells 时检查多重定义（真内核的 compileError，FakeKernel 默认不做）；
 *  3. 每次执行都往 stdout / stderr / text/html mime / 写入路径里撒 canary
 *     —— 这些都在 M5 白名单之外，任何一个出现在 LLM 请求里就记一次泄漏。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FakeKernel } from '../../testing/fake-kernel';
import { KernelSupervisor } from '../../supervisor';
import { RpcRouter } from '../../router';
import type { CellInfo, KernelRequest, KernelWireMessage, VarSchema } from '../../protocol';
import type { Policy } from './policy';

export const CANARY_RE = /CANARY-[A-Z]+-[a-z0-9-]+/g;

export interface FixtureCell {
  id: string;
  code: string;
}

export interface Fixture {
  id: string;
  kind: 'N2' | 'N3';
  title: string;
  prompt: string;
  cells: FixtureCell[];
  schemas?: VarSchema[];
  /** cellId → traceback；不在表里 = 该 cell 在当前源码下能跑通。 */
  oracle: (cells: FixtureCell[]) => Record<string, string>;
  /** 采纳全部 staged diff 后的结构判据（N3 用；N2 只看 oracle 全绿）。 */
  accept?: (cells: FixtureCell[]) => boolean;
  /** 开局要先跑一遍让报错进 outputs 缓存的 cell（模拟用户刚运行报错）。 */
  runFirst?: string[];
  policy: Policy;
  /** 预期结果的说明（写进报告，免得把"两边都失败"误读为回归）。 */
  note?: string;
}

// ---------- 极简 defs/refs（与 FakeKernel 同规则；bench 自用） ----------

const KW = new Set(
  'import from as def class return if else elif for while in not and or is None True False print len range int str float list dict set with try except finally raise lambda yield del pass break continue assert global self sum max min'.split(
    ' ',
  ),
);

export function analyze(code: string): { defs: string[]; refs: string[] } {
  const defs = new Set<string>();
  let m: RegExpExecArray | null;
  const assignRe = /^[ \t]*([A-Za-z_]\w*)\s*=(?!=)/gm;
  while ((m = assignRe.exec(code)) !== null) if (!/^[ \t]/.test(m[0])) defs.add(m[1]!);
  const importRe = /^(?:import|from)\s+\w+(?:\s+as\s+(\w+))?/gm;
  while ((m = importRe.exec(code)) !== null) defs.add(m[1] ?? m[0].split(/\s+/)[1]!);
  const defRe = /^(?:def|class)\s+([A-Za-z_]\w*)/gm;
  while ((m = defRe.exec(code)) !== null) defs.add(m[1]!);
  const refs = new Set<string>();
  // 字符串字面量、函数体内的局部名不算全局引用（粗略：去掉引号内容与缩进行）
  const top = code
    .replace(/"[^"]*"|'[^']*'/g, '""')
    .split('\n')
    .filter((l) => !/^[ \t]/.test(l) && !/^(?:import|from)\s/.test(l))
    .map((l) => l.replace(/^(def\s+\w+)\(.*\):/, '$1():')) // 形参不是全局引用
    .join('\n')
    .replace(/([(,]\s*)\w+\s*=(?!=)/g, '$1'); // 关键字实参名不是引用
  const identRe = /(?<![.\w])[A-Za-z_]\w*\b/g;
  while ((m = identRe.exec(top)) !== null) {
    const n = m[0];
    if (!defs.has(n) && !KW.has(n)) refs.add(n);
  }
  // 推导式里的循环变量
  for (const mm of top.matchAll(/\bfor\s+(\w+)\s+in\b/g)) refs.delete(mm[1]!);
  return { defs: [...defs], refs: [...refs] };
}

export function duplicateDefs(cells: FixtureCell[]): { name: string; cellIds: string[] } | null {
  const owner = new Map<string, string[]>();
  for (const c of cells) for (const d of analyze(c.code).defs) owner.set(d, [...(owner.get(d) ?? []), c.id]);
  for (const [name, ids] of owner) if (ids.length > 1) return { name, cellIds: ids };
  return null;
}

// ---------- OracleKernel ----------

export class OracleKernel extends FakeKernel {
  constructor(private readonly fx: Fixture) {
    super();
    this.cells = fx.cells.map((c): CellInfo => ({ ...c, execCount: 0, ...analyze(c.code) }));
    if (fx.schemas) this.overrideSchemas = fx.schemas;
  }

  override send(msg: KernelRequest): void {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (msg.method === 'exec_cell') {
      const cellId = String(params['cellId'] ?? '');
      const tb = this.fx.oracle(this.cells)[cellId];
      this.failCell = tb ? { cellId, traceback: tb } : undefined;
      this.notifyWrites = { cellId, paths: [`/home/owner/CANARY-PATH-${this.fx.id}/out.csv`] };
    } else if (msg.method === 'validate_cells') {
      // 自己应答：FakeKernel 的 nextCompileError 是共享字段，并发 validate 时会被错的请求消费
      // （AI SDK 会并发执行同一条消息里的多个工具调用）。真内核按请求独立计算，无此竞态。
      this.requests.push({ method: msg.method, params });
      const cells = (params['cells'] ?? []) as FixtureCell[];
      const dup = duplicateDefs(cells);
      const result = {
        cells: cells.map((c) => ({ id: c.id, code: c.code, ...analyze(c.code), sideEffect: false })),
        edges: [],
        ...(dup
          ? { compileError: { message: `multiple definitions of '${dup.name}' (cells ${dup.cellIds.join(', ')})`, cellIds: dup.cellIds } }
          : {}),
      };
      setTimeout(() => this.sink?.({ id: msg.id, result }), 0);
      return;
    }
    super.send(msg);
  }

  private sink?: (msg: KernelWireMessage) => void;

  override onMessage(cb: (msg: KernelWireMessage) => void): void {
    this.sink = cb;
    super.onMessage((msg) => {
      if ('method' in msg && msg.method === 'run.stdout') {
        const p = msg.params as { cellId: string; text: string };
        cb({ method: 'run.stdout', params: { ...p, text: `row0 CANARY-STDOUT-${this.fx.id} 42.17\n` } });
        return;
      }
      cb(msg);
      if ('method' in msg && msg.method === 'run.started') {
        const { cellId } = msg.params as { cellId: string };
        cb({ method: 'run.stderr', params: { cellId, text: `warn CANARY-STDERR-${this.fx.id}\n` } });
        cb({
          method: 'run.mime',
          params: { cellId, mime: 'text/html', data: `<table><tr><td>CANARY-MIME-${this.fx.id}</td></tr></table>` },
        });
      }
    });
  }
}

// ---------- notebook 宿主 ----------

export interface Bench {
  router: RpcRouter;
  kernel: OracleKernel;
  /** 最近一次 diff.updated 广播里的队列（前端 diff 托盘看到的同一份）。 */
  diffs: () => { diffId: string; status: string }[];
  stop: () => void;
}

export async function openFixture(fx: Fixture): Promise<Bench> {
  const dir = mkdtempSync(path.join(tmpdir(), `novalab-adr012-${fx.id}-`));
  let kernel: OracleKernel | undefined;
  const sup = new KernelSupervisor({
    transportFactory: () => (kernel = new OracleKernel(fx)),
    pingIntervalMs: 60_000,
  });
  let diffs: { diffId: string; status: string }[] = [];
  const router = new RpcRouter({
    supervisor: sup,
    broadcast: (method, params) => {
      if (method === 'diff.updated') diffs = (params as { diffs: typeof diffs }).diffs;
    },
  });
  await router.invoke('notebook.open', { path: path.join(dir, `${fx.id}.py`) });
  for (const id of fx.runFirst ?? []) await router.invoke('cell.run', { cellId: id, cascade: false });
  return { router, kernel: kernel!, diffs: () => diffs, stop: () => sup.stop() };
}

/** 模拟用户逐个 Tab 采纳 staged diff，然后全量重跑，交给 oracle / accept 判定。 */
export async function acceptAllAndJudge(
  b: Bench,
  fx: Fixture,
): Promise<{ success: boolean; accepted: number; failures: string[] }> {
  const diffs = b.diffs().filter((d) => d.status === 'proposed');
  let accepted = 0;
  for (const d of diffs) {
    await b.router.invoke('diff.accept', { diffId: d.diffId });
    accepted++;
  }
  const cells = b.kernel.cells.map((c) => ({ id: c.id, code: c.code }));
  const failures = Object.keys(fx.oracle(cells));
  const dup = duplicateDefs(cells);
  if (dup) failures.push(`dup:${dup.name}`);
  const structural = fx.accept ? fx.accept(cells) : true;
  return { success: accepted > 0 && failures.length === 0 && structural, accepted, failures };
}
