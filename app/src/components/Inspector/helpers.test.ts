/**
 * Inspector 纯函数单测（P3.2）：高度 clamp / 拖拽位移→高度 / localStorage 注入 /
 * 搜索过滤 / name-size 排序 / preview 格式化（单行截断 + 展开行完整 preview）。
 * dragStore 控制器经注入 storage 驱动（node 环境无 window：pointerdown 降级张开）。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSPECTOR_HEIGHT,
  DOUBLE_CLICK_MS,
  HEIGHT_STORAGE_KEY,
  MAX_INSPECTOR_HEIGHT,
  MIN_INSPECTOR_HEIGHT,
  clampHeight,
  filterSchemas,
  formatPreview,
  heightFromDrag,
  loadHeight,
  previewFull,
  previewOneLine,
  saveHeight,
  schemaSize,
  shapeOrLen,
  sortSchemas,
  type KvStorage,
} from './helpers';
import { createInspectorController } from './dragStore';
import type { VarSchema } from '../../kernel/types';

function memStorage(): KvStorage & { dump: Record<string, string> } {
  const dump: Record<string, string> = {};
  return {
    dump,
    getItem: (k) => dump[k] ?? null,
    setItem: (k, v) => {
      dump[k] = v;
    },
  };
}

function schema(name: string, over: Partial<VarSchema> = {}): VarSchema {
  return { name, type: 'ndarray', ...over } as VarSchema;
}

/* ------------------------------------------------------------------ */
/* 拖拽高度 clamp（120–480px）                                          */
/* ------------------------------------------------------------------ */

describe('clampHeight / heightFromDrag（拖拽高度 clamp）', () => {
  it('clamp 到 [120, 480]；NaN → MIN', () => {
    expect(clampHeight(50)).toBe(MIN_INSPECTOR_HEIGHT);
    expect(clampHeight(-10)).toBe(MIN_INSPECTOR_HEIGHT);
    expect(clampHeight(999)).toBe(MAX_INSPECTOR_HEIGHT);
    expect(clampHeight(300)).toBe(300);
    expect(clampHeight(Number.NaN)).toBe(MIN_INSPECTOR_HEIGHT);
  });

  it('向上拖增高、向下拖减低（抽屉在 footer 上方）', () => {
    expect(heightFromDrag(240, 500, 440)).toBe(300); // 上拖 60px
    expect(heightFromDrag(240, 500, 560)).toBe(180); // 下拖 60px
  });

  it('拖出界被 clamp；折叠态（startHeight=0）起拖 → 基准 MIN', () => {
    expect(heightFromDrag(140, 500, 0)).toBe(MAX_INSPECTOR_HEIGHT); // 上拖 500px → 超限 clamp
    expect(heightFromDrag(140, 500, 600)).toBe(MIN_INSPECTOR_HEIGHT); // 下拖 100px → 40 → clamp
    expect(heightFromDrag(0, 500, 495)).toBe(125); // 折叠起拖：基准 120 + 5，首移即张开
    expect(heightFromDrag(0, 500, 400)).toBe(220); // 基准 120 + 100
  });
});

describe('loadHeight / saveHeight（localStorage 持久化，注入 storage）', () => {
  it('无存值/垃圾值 → 默认 240；存值 clamp 后生效', () => {
    const st = memStorage();
    expect(loadHeight(st)).toBe(DEFAULT_INSPECTOR_HEIGHT);
    st.dump[HEIGHT_STORAGE_KEY] = 'abc';
    expect(loadHeight(st)).toBe(DEFAULT_INSPECTOR_HEIGHT);
    st.dump[HEIGHT_STORAGE_KEY] = '9999';
    expect(loadHeight(st)).toBe(MAX_INSPECTOR_HEIGHT);
    expect(loadHeight(null)).toBe(DEFAULT_INSPECTOR_HEIGHT);
  });

  it('saveHeight 写回取整值', () => {
    const st = memStorage();
    saveHeight(st, 333.6);
    expect(st.dump[HEIGHT_STORAGE_KEY]).toBe('334');
  });

  it('控制器：双击把手（<350ms 两击且未拖动）= 折叠/展开；单击仅张开(node 降级)', () => {
    const st = memStorage();
    const c = createInspectorController(st);
    expect(c.getSnapshot().open).toBe(false);
    c.handlePointerDown({ clientY: 500 }); // node 无 window → 直接张开
    expect(c.getSnapshot().open).toBe(true);
    c.handlePointerDown({ clientY: 500 }); // 与上击间隔 <350ms → 双击判定：折叠
    expect(c.getSnapshot().open).toBe(false);
  });

  it('控制器：setOpen/setHeight 订阅通知并持久化', () => {
    const st = memStorage();
    const c = createInspectorController(st);
    let notified = 0;
    c.subscribe(() => notified++);
    c.setHeight(800); // clamp 480
    expect(c.getSnapshot()).toEqual({ open: true, height: MAX_INSPECTOR_HEIGHT });
    expect(st.dump[HEIGHT_STORAGE_KEY]).toBe(String(800)); // 原始意图值落盘，加载时 clamp
    c.setOpen(false);
    expect(c.getSnapshot().open).toBe(false);
    expect(notified).toBe(2);
  });

  it('双击间隔超过 DOUBLE_CLICK_MS 不触发折叠', async () => {
    const c = createInspectorController(memStorage());
    c.handlePointerDown({ clientY: 500 });
    await new Promise((r) => setTimeout(r, DOUBLE_CLICK_MS + 30));
    c.handlePointerDown({ clientY: 500 });
    expect(c.getSnapshot().open).toBe(true); // 第二击是新手势（node 降级：保持张开）
  });
});

/* ------------------------------------------------------------------ */
/* 过滤 / 排序 / 展开（表格纯函数）                                      */
/* ------------------------------------------------------------------ */

const ROWS: VarSchema[] = [
  schema('beta', { type: 'DataFrame', shape: [100, 4], len: 100 }),
  schema('Alpha', { type: 'ndarray', shape: [3, 4], len: 3 }),
  schema('gamma', { type: 'set', len: 7 }),
  schema('delta', { type: 'csr_matrix' }), // 无 shape/len → size 0
];

describe('filterSchemas（搜索过滤）', () => {
  it('name 大小写不敏感子串；空 query 返回全部副本（不改原数组）', () => {
    expect(filterSchemas(ROWS, 'ALPH').map((s) => s.name)).toEqual(['Alpha']);
    expect(filterSchemas(ROWS, 'a').map((s) => s.name)).toEqual(['beta', 'Alpha', 'gamma', 'delta']);
    const all = filterSchemas(ROWS, '  ');
    expect(all).toHaveLength(4);
    expect(all).not.toBe(ROWS); // 副本
  });

  it('type 也参与匹配；无命中 → 空', () => {
    expect(filterSchemas(ROWS, 'dataframe').map((s) => s.name)).toEqual(['beta']);
    expect(filterSchemas(ROWS, 'zzz')).toEqual([]);
  });
});

describe('sortSchemas / schemaSize（name-size 排序）', () => {
  it('name 升/降序；原数组不动', () => {
    expect(sortSchemas(ROWS, 'name', 'asc').map((s) => s.name)).toEqual([
      'Alpha', 'beta', 'delta', 'gamma',
    ]);
    expect(sortSchemas(ROWS, 'name', 'desc').map((s) => s.name)).toEqual([
      'gamma', 'delta', 'beta', 'Alpha',
    ]);
    expect(ROWS.map((s) => s.name)[0]).toBe('beta'); // 不改原数组
  });

  it('size = shape 乘积优先，其次 len，缺省 0；同 size 回退 name 升序（与 dir 无关）', () => {
    expect(schemaSize(ROWS[0]!)).toBe(400);
    expect(schemaSize(ROWS[1]!)).toBe(12);
    expect(schemaSize(ROWS[2]!)).toBe(7);
    expect(schemaSize(ROWS[3]!)).toBe(0);
    expect(sortSchemas(ROWS, 'size', 'asc').map((s) => s.name)).toEqual([
      'delta', 'gamma', 'Alpha', 'beta',
    ]);
    expect(sortSchemas(ROWS, 'size', 'desc').map((s) => s.name)).toEqual([
      'beta', 'Alpha', 'gamma', 'delta',
    ]);
  });
});

describe('preview 格式化（单元格单行截断 + 展开行完整 preview）', () => {
  it('formatPreview：字符串原样 / 结构化 JSON / null → 空', () => {
    expect(formatPreview('repr text')).toBe('repr text');
    expect(formatPreview([{ a: 1 }])).toBe('[{"a":1}]');
    expect(formatPreview(null)).toBe('');
    expect(formatPreview(undefined)).toBe('');
  });

  it('previewOneLine：换行压平、超限截断加 …', () => {
    expect(previewOneLine(schema('x', { preview: 'a\n  b' }))).toBe('a b');
    const long = schema('x', { preview: 'y'.repeat(300) });
    const line = previewOneLine(long, 120);
    expect(line).toHaveLength(121); // 120 + …
    expect(line.endsWith('…')).toBe(true);
  });

  it('previewFull：结构化 preview → pretty JSON（head(1) records / flatten 前 8）', () => {
    const s = schema('df', { preview: [{ county: 'a', pop: 1 }] } as never);
    expect(previewFull(s)).toBe('[\n  {\n    "county": "a",\n    "pop": 1\n  }\n]');
  });

  it('previewFull：字符串 preview（repr）原样；无 preview（sparse）→ 结构摘要', () => {
    expect(previewFull(schema('x', { preview: "<set {1, 2}>" }))).toBe('<set {1, 2}>');
    const sparse = { name: 'sp', type: 'csr_matrix', shape: [4, 5], format: 'csr', nnz: 3 } as unknown as VarSchema;
    expect(previewFull(sparse)).toBe('csr_matrix · shape=[4, 5] · format=csr · nnz=3');
  });

  it('shapeOrLen：shape 优先（3×4），其次 len，缺省 —', () => {
    expect(shapeOrLen(schema('a', { shape: [3, 4] }))).toBe('3×4');
    expect(shapeOrLen(schema('b', { len: 7 }))).toBe('7');
    expect(shapeOrLen(schema('c'))).toBe('—');
  });
});
