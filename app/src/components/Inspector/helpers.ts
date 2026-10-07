/**
 * Inspector 纯函数助手（P3.2，无 DOM/网络依赖，helpers.test.ts 覆盖）：
 * 高度 clamp / 拖拽位移→高度 / 搜索过滤 / name-size 排序 / preview 格式化。
 * 约定与 sidebar/helpers.ts 一致：localStorage 经 KvStorage 注入以便 node 单测。
 */

import type { VarSchema } from '../../kernel/types';

/** 抽屉高度约束（S3：从状态栏把手拖出，120–480px）。 */
export const MIN_INSPECTOR_HEIGHT = 120;
export const MAX_INSPECTOR_HEIGHT = 480;
export const DEFAULT_INSPECTOR_HEIGHT = 240;
export const HEIGHT_STORAGE_KEY = 'novalab.inspector.height';
/** 把手双击判定窗口（两次 pointerdown 间隔 < 此值且上一击未拖动 → 折叠/展开）。 */
export const DOUBLE_CLICK_MS = 350;
/** 拖动超过此像素数视为真拖拽（抑制"快速两击拖拽"误判为双击）。 */
export const DRAG_SLOP_PX = 2;

export interface KvStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/** 任意数值 → [120, 480] 内的合法高度（NaN/Inf → 默认值语义由调用方处理，这里钳到 MIN）。 */
export function clampHeight(h: number): number {
  if (!Number.isFinite(h)) return MIN_INSPECTOR_HEIGHT;
  return Math.min(MAX_INSPECTOR_HEIGHT, Math.max(MIN_INSPECTOR_HEIGHT, Math.round(h)));
}

/**
 * 拖拽位移 → 新高度。抽屉在 footer 上方：向上拖（startY - currentY > 0）增高。
 * startHeight=0（折叠态起拖）→ 基准取 MIN，首次移动即张开到 ≥120。
 */
export function heightFromDrag(startHeight: number, startY: number, currentY: number): number {
  const base = startHeight > 0 ? startHeight : MIN_INSPECTOR_HEIGHT;
  return clampHeight(base + (startY - currentY));
}

export function loadHeight(storage: KvStorage | null): number {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(HEIGHT_STORAGE_KEY) ?? null;
  } catch {
    return DEFAULT_INSPECTOR_HEIGHT;
  }
  if (raw == null) return DEFAULT_INSPECTOR_HEIGHT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? clampHeight(n) : DEFAULT_INSPECTOR_HEIGHT;
}

export function saveHeight(storage: KvStorage | null, h: number): void {
  try {
    storage?.setItem(HEIGHT_STORAGE_KEY, String(Math.round(h)));
  } catch {
    /* 隐私模式/配额：高度不持久化，不致命 */
  }
}

/* ------------------------------------------------------------------ */
/* 表格：过滤 / 排序 / preview                                          */
/* ------------------------------------------------------------------ */

export type SortKey = 'name' | 'size';
export type SortDir = 'asc' | 'desc';

/** 排序用"大小"：shape 各维乘积优先，其次 len，缺省 0。 */
export function schemaSize(s: VarSchema): number {
  if (s.shape && s.shape.length > 0) return s.shape.reduce((a, b) => a * b, 1);
  return s.len ?? 0;
}

/** 搜索过滤：name / type 大小写不敏感子串；空 query 返回副本（不改原数组）。 */
export function filterSchemas(schemas: readonly VarSchema[], query: string): VarSchema[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...schemas];
  return schemas.filter(
    (s) => s.name.toLowerCase().includes(q) || s.type.toLowerCase().includes(q),
  );
}

/** name 字典序 / size 数值序；size 相同回退 name 升序（与 dir 无关，保证稳定）。 */
export function sortSchemas(
  schemas: readonly VarSchema[],
  key: SortKey,
  dir: SortDir,
): VarSchema[] {
  const mul = dir === 'asc' ? 1 : -1;
  const byName = (a: VarSchema, b: VarSchema) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return [...schemas].sort((a, b) => {
    if (key === 'size') {
      const d = schemaSize(a) - schemaSize(b);
      if (d !== 0) return d * mul;
      return byName(a, b); // tie-break：name 升序（与 dir 无关）
    }
    return byName(a, b) * mul;
  });
}

/** shape-or-len 列：shape（如 3×4）优先，其次 len，缺省 —。 */
export function shapeOrLen(s: VarSchema): string {
  if (s.shape && s.shape.length > 0) return s.shape.join('×');
  if (s.len != null) return String(s.len);
  return '—';
}

/**
 * preview 运行时形态收窄：TS 类型标 string，但 py 端 DataFrame/ndarray 实际发
 * 结构化数组（head(1) records / flatten 前 8）→ 一律 unknown 进来格式化成字符串。
 */
export function formatPreview(preview: unknown): string {
  if (preview == null) return '';
  if (typeof preview === 'string') return preview;
  try {
    return JSON.stringify(preview);
  } catch {
    return String(preview);
  }
}

/** 表格单元：单行截断（换行压平；CSS truncate 之外再给硬上限防超长行）。 */
export function previewOneLine(s: VarSchema, limit = 120): string {
  const one = formatPreview(s.preview).replace(/\s*\n\s*/g, ' ');
  return one.length > limit ? `${one.slice(0, limit)}…` : one;
}

/** 无 preview 的类型（scipy.sparse：format/nnz 在 schema 上）→ 结构摘要兜底。 */
export function schemaSummary(s: VarSchema): string {
  const bits: string[] = [s.type];
  if (s.shape) bits.push(`shape=[${s.shape.join(', ')}]`);
  if (s.len != null) bits.push(`len=${s.len}`);
  if (s.columns?.length) bits.push(`columns=${s.columns.map((c) => c.name).join(', ')}`);
  const extra = s as unknown as Record<string, unknown>;
  if (typeof extra.format === 'string') bits.push(`format=${extra.format}`);
  if (typeof extra.nnz === 'number') bits.push(`nnz=${extra.nnz}`);
  if (typeof extra.crs === 'string') bits.push(`crs=${extra.crs}`);
  return bits.join(' · ');
}

/** 展开行完整 preview：结构化 → pretty JSON；字符串 → 原样（repr/head(1) json）；无 → 摘要。 */
export function previewFull(s: VarSchema): string {
  if (typeof s.preview === 'string') return s.preview || schemaSummary(s);
  if (s.preview != null) {
    try {
      return JSON.stringify(s.preview, null, 2);
    } catch {
      /* fallthrough */
    }
  }
  return schemaSummary(s);
}
