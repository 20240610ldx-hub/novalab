/**
 * 结果溯源（ADR-015）：bridge `provenance.lookup` 的前端视图。纯函数，便于单测。
 */

export type ProvenanceCurrent = 'same' | 'modified' | 'missing' | 'unknown';

export interface ProvenanceFileWire {
  path: string;
  sha256: string | null;
  bytes: number | null;
  skipped?: 'too-large' | 'missing' | 'unreadable';
  inPlace?: true;
  current?: ProvenanceCurrent;
}

export interface ProvenanceView {
  path: string;
  producedBy: { cellId: string; runId: string; ts: string; notebook: string } | null;
  recorded?: ProvenanceFileWire;
  current?: ProvenanceCurrent;
  inputs: ProvenanceFileWire[];
}

const CURRENTS = new Set<ProvenanceCurrent>(['same', 'modified', 'missing', 'unknown']);

function asFile(v: unknown): ProvenanceFileWire | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.path !== 'string') return null;
  return {
    path: r.path,
    sha256: typeof r.sha256 === 'string' ? r.sha256 : null,
    bytes: typeof r.bytes === 'number' ? r.bytes : null,
    ...(r.skipped === 'too-large' || r.skipped === 'missing' || r.skipped === 'unreadable' ? { skipped: r.skipped } : {}),
    ...(r.inPlace === true ? { inPlace: true as const } : {}),
    ...(CURRENTS.has(r.current as ProvenanceCurrent) ? { current: r.current as ProvenanceCurrent } : {}),
  };
}

/** `provenance.lookup` 响应 → 视图（形状不对 → 当作"没有记录"，宽容降级）。 */
export function normalizeProvenance(res: unknown, path: string): ProvenanceView {
  const empty: ProvenanceView = { path, producedBy: null, inputs: [] };
  if (typeof res !== 'object' || res === null) return empty;
  const r = res as Record<string, unknown>;
  const pb = r.producedBy as Record<string, unknown> | null | undefined;
  if (!pb || typeof pb.cellId !== 'string' || typeof pb.runId !== 'string' || typeof pb.ts !== 'string') return empty;
  const recorded = asFile(r.recorded);
  return {
    path,
    producedBy: { cellId: pb.cellId, runId: pb.runId, ts: pb.ts, notebook: typeof pb.notebook === 'string' ? pb.notebook : '' },
    ...(recorded ? { recorded } : {}),
    ...(CURRENTS.has(r.current as ProvenanceCurrent) ? { current: r.current as ProvenanceCurrent } : {}),
    inputs: Array.isArray(r.inputs) ? r.inputs.map(asFile).filter((f): f is ProvenanceFileWire => f !== null) : [],
  };
}

/** 短哈希（界面展示用，前 8 位；完整值在 title 里）。 */
export function shortHash(sha: string | null): string {
  return sha ? sha.slice(0, 8) : '—';
}

/** 路径最后一段（Windows / POSIX 分隔符都认）。 */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function formatBytes(n: number | null): string {
  if (n === null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
