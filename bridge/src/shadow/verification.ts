/**
 * ADR-013 §4.4 核验绑定与 Diff 分级（纯函数，router 调用）。
 *
 * - 源码修订 revision = 各 cell 源码按序的 SHA-256（不含 cell id：insert_below 采纳后
 *   得到真实 id，内容与位置不变即视为同一修订）。
 * - 一次影子运行覆盖的多条改动：按序采纳其中前缀后，剩余改动的核验仍有效
 *   （acceptable = base 依次应用 0..n 条改动后的各修订）。
 * - 软约束（O5）：任何状态都照常入队，只标注 verified / unverified / failed / expired / not-required。
 */

import { createHash } from 'node:crypto';
import type { CellSrc } from './manager';
import type { ContractResult, RunFacts } from './report';

import type { DiffVerification } from '../protocol';

export type { DiffVerification };
export type VerificationLevel = DiffVerification['level'];
export type VerificationStatus = DiffVerification['status'];

export interface ShadowEdit {
  targetCellId: string;
  action: 'update' | 'insert_below';
  newCode: string;
}

export interface RunRecord {
  runId: string;
  edits: ShadowEdit[];
  /** base 依次应用前 i 条改动后的修订（i = 0..n）。 */
  revisions: string[];
  facts: RunFacts;
}

export interface VerificationRecord {
  verificationId: string;
  runId: string;
  /** Agent 声明的契约结果（不含 auto）；targets 取自 Agent 输入（equivalent 覆盖面，不出进程）。 */
  contracts: (ContractResult & { targets?: string[] })[];
}

export function revisionOf(cells: readonly { code: string }[]): string {
  const h = createHash('sha256');
  for (const c of cells) {
    h.update(String(c.code.length));
    h.update(':');
    h.update(c.code);
    h.update('\u0000');
  }
  return h.digest('hex');
}

/** 按序应用改动（与 diff.accept 的落地顺序一致：insert_below 紧贴目标之下）。 */
export function applyEdits(cells: readonly CellSrc[], edits: readonly ShadowEdit[]): CellSrc[] {
  const out = cells.map((c) => ({ id: c.id, code: c.code }));
  edits.forEach((e, i) => {
    const idx = out.findIndex((c) => c.id === e.targetCellId);
    if (idx < 0) throw new Error(`unknown targetCellId: ${e.targetCellId}`);
    if (e.action === 'update') out[idx] = { id: out[idx]!.id, code: e.newCode };
    else out.splice(idx + 1, 0, { id: `new-${i + 1}`, code: e.newCode });
  });
  return out;
}

export function prefixRevisions(cells: readonly CellSrc[], edits: readonly ShadowEdit[]): string[] {
  const revs = [revisionOf(cells)];
  for (let i = 1; i <= edits.length; i++) revs.push(revisionOf(applyEdits(cells, edits.slice(0, i))));
  return revs;
}

function normalized(code: string): string {
  return code
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
    .join('\n');
}

/** V0：只增删整行注释、空行或行尾空白（行内注释改动不算，宁严勿松）。 */
export function isCosmetic(oldCode: string, newCode: string): boolean {
  return normalized(oldCode) === normalized(newCode);
}

export function sameEdit(a: ShadowEdit, b: ShadowEdit): boolean {
  return a.targetCellId === b.targetCellId && a.action === b.action && a.newCode === b.newCode;
}

export function classify(opts: {
  edit: ShadowEdit;
  oldCode?: string;
  intent?: string;
  dataful: boolean;
}): VerificationLevel {
  if (opts.edit.action === 'update' && opts.oldCode !== undefined && isCosmetic(opts.oldCode, opts.edit.newCode)) return 'V0';
  if (opts.intent === 'refactor') return 'V3';
  return opts.dataful ? 'V2' : 'V1';
}

export function evaluate(opts: {
  level: VerificationLevel;
  edit: ShadowEdit;
  currentRevision: string;
  run?: RunRecord;
  verification?: VerificationRecord;
}): DiffVerification {
  const { level, run, verification } = opts;
  const out = (status: VerificationStatus, missing: string[] = []): DiffVerification => ({ status, level, missing });
  if (level === 'V0') return out('not-required');
  if (!run || !verification) return out('unverified', ['shadow_run']);
  if (!run.edits.some((e) => sameEdit(e, opts.edit))) return out('unverified', ['shadow_run covering this change']);
  if (!run.revisions.includes(opts.currentRevision)) return out('expired');
  if (!run.facts.closureOk || run.facts.autoFailed.length > 0) return out('failed');
  if (verification.contracts.some((c) => c.status !== 'pass')) return out('failed');
  if (level === 'V2' && verification.contracts.length === 0) return out('unverified', ['contract']);
  if (level === 'V3') {
    const covered = new Set(
      verification.contracts.filter((c) => c.kind === 'equivalent' && c.status === 'pass').flatMap((c) => c.targets ?? []),
    );
    const missing = run.facts.comparable.filter((n) => !covered.has(n)).map((n) => `equivalent:${n}`);
    if (missing.length > 0) return out('unverified', missing);
  }
  return out('verified');
}
