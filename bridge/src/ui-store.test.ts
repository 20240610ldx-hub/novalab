import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UiStore, type NotebookUiState } from './ui-store';
import { KernelSupervisor } from './supervisor';
import { RpcRouter } from './router';
import { FakeKernel } from './testing/fake-kernel';
import type { RpcResponse } from './protocol';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tmpNotebook(name = 'demo.py'): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'novalab-ui-')), name);
}

function readUiFile(nbPath: string): unknown {
  return JSON.parse(readFileSync(UiStore.fileFor(nbPath), 'utf8'));
}

describe('UiStore · 读写与降级', () => {
  it('文件缺失 → get 返回默认空对象，不创建文件、不抛', () => {
    const nb = tmpNotebook();
    const store = new UiStore();
    expect(store.get(nb)).toEqual({ collapsed: {}, activeCellId: null });
    expect(existsSync(UiStore.fileFor(nb))).toBe(false);
  });

  it('set 为 shallow merge，返回合并后完整状态', () => {
    const nb = tmpNotebook();
    const store = new UiStore();
    const r1 = store.set(nb, { collapsed: { a: true } });
    expect(r1).toEqual({ collapsed: { a: true }, activeCellId: null });
    const r2 = store.set(nb, { activeCellId: 'b' });
    expect(r2).toEqual({ collapsed: { a: true }, activeCellId: 'b' }); // 未触及的键保留
    const r3 = store.set(nb, { collapsed: { c: false } });
    expect(r3).toEqual({ collapsed: { c: false }, activeCellId: 'b' }); // 顶层键整体替换
    expect(store.get(nb)).toEqual(r3);
  });

  it('set 清洗非法补丁值（collapsed 只留 boolean，activeCellId 只留 string|null）', () => {
    const nb = tmpNotebook();
    const store = new UiStore();
    const r = store.set(nb, {
      collapsed: { a: true, b: 'yes', c: 1 } as unknown as Record<string, boolean>,
      activeCellId: 42 as unknown as string,
    });
    expect(r).toEqual({ collapsed: { a: true }, activeCellId: null });
  });

  it('同目录多 notebook 共用一个 ui.json，以 notebookPath 为键', async () => {
    const nb1 = tmpNotebook('one.py');
    const nb2 = path.join(path.dirname(nb1), 'two.py');
    const store = new UiStore({ debounceMs: 10 });
    store.set(nb1, { collapsed: { a: true } });
    store.set(nb2, { activeCellId: 'z' });
    store.flush();
    const file = readUiFile(nb1) as Record<string, NotebookUiState>;
    expect(file[nb1]).toEqual({ collapsed: { a: true }, activeCellId: null });
    expect(file[nb2]).toEqual({ collapsed: {}, activeCellId: 'z' });
  });

  it('损坏 JSON / 垃圾形状 → 默认空对象；再 set 会覆盖为合法文件', async () => {
    const nb = tmpNotebook();
    const dir = path.dirname(UiStore.fileFor(nb));
    mkdirSync(dir, { recursive: true });
    writeFileSync(UiStore.fileFor(nb), '{oops not json', 'utf8');
    const store = new UiStore({ debounceMs: 10 });
    expect(store.get(nb)).toEqual({ collapsed: {}, activeCellId: null });

    store.set(nb, { collapsed: { a: true } });
    await sleep(50);
    expect(readUiFile(nb)).toEqual({ [nb]: { collapsed: { a: true }, activeCellId: null } });

    // 合法 JSON 但形状不对（数组 / 垃圾条目）同样降级
    writeFileSync(UiStore.fileFor(nb), '[1,2,3]', 'utf8');
    const s2 = new UiStore();
    expect(s2.get(nb)).toEqual({ collapsed: {}, activeCellId: null });
    writeFileSync(UiStore.fileFor(nb), JSON.stringify({ [nb]: { collapsed: { x: 'no' }, activeCellId: 7 } }), 'utf8');
    const s3 = new UiStore();
    expect(s3.get(nb)).toEqual({ collapsed: {}, activeCellId: null });
  });

  it('写入 debounce：窗口内不落地，静默后一次写出最终合并内容', async () => {
    const nb = tmpNotebook();
    const store = new UiStore({ debounceMs: 40 });
    store.set(nb, { collapsed: { a: true } });
    store.set(nb, { collapsed: { a: true, b: true } });
    store.set(nb, { activeCellId: 'b' });
    expect(existsSync(UiStore.fileFor(nb))).toBe(false); // debounce 未到期
    await sleep(90);
    expect(readUiFile(nb)).toEqual({
      [nb]: { collapsed: { a: true, b: true }, activeCellId: 'b' },
    });
  });

  it('flush 立即写出未决内容', () => {
    const nb = tmpNotebook();
    const store = new UiStore({ debounceMs: 10_000 });
    store.set(nb, { collapsed: { a: false } });
    expect(existsSync(UiStore.fileFor(nb))).toBe(false);
    store.flush();
    expect(readUiFile(nb)).toEqual({ [nb]: { collapsed: { a: false }, activeCellId: null } });
  });
});

describe('RpcRouter · ui.get / ui.set', () => {
  let sup: KernelSupervisor | undefined;
  let router: RpcRouter | undefined;

  afterEach(() => {
    router?.dispose();
    sup?.stop();
    sup = undefined;
    router = undefined;
  });

  function setup(uiStore?: UiStore) {
    sup = new KernelSupervisor({
      transportFactory: () => new FakeKernel(),
      pingIntervalMs: 60_000,
    });
    router = new RpcRouter({
      supervisor: sup,
      broadcast: () => {},
      uiStore: uiStore ?? new UiStore({ debounceMs: 10 }),
    });
    let reqId = 0;
    return (method: string, params?: unknown): Promise<RpcResponse> =>
      router!.handle({ jsonrpc: '2.0', id: ++reqId, method, params });
  }

  it('ui.set → ui.get 往返，ui.json 落盘', async () => {
    const call = setup();
    const nb = tmpNotebook();
    const setRes = await call('ui.set', { path: nb, patch: { collapsed: { a: true }, activeCellId: 'a' } });
    expect(setRes.error).toBeUndefined();
    expect(setRes.result).toEqual({ collapsed: { a: true }, activeCellId: 'a' });

    const getRes = await call('ui.get', { path: nb });
    expect(getRes.result).toEqual({ collapsed: { a: true }, activeCellId: 'a' });

    await sleep(50); // debounce 落地
    expect(readUiFile(nb)).toEqual({ [nb]: { collapsed: { a: true }, activeCellId: 'a' } });
  });

  it('ui.get 未写过的路径 → 默认空对象（无需先 notebook.open）', async () => {
    const call = setup();
    const res = await call('ui.get', { path: tmpNotebook('fresh.py') });
    expect(res.result).toEqual({ collapsed: {}, activeCellId: null });
  });

  it('ui.json 损坏 → ui.get 降级默认值不抛；ui.set 修复文件', async () => {
    const call = setup();
    const nb = tmpNotebook();
    mkdirSync(path.dirname(UiStore.fileFor(nb)), { recursive: true });
    writeFileSync(UiStore.fileFor(nb), '###corrupt###', 'utf8');

    const getRes = await call('ui.get', { path: nb });
    expect(getRes.error).toBeUndefined();
    expect(getRes.result).toEqual({ collapsed: {}, activeCellId: null });

    const setRes = await call('ui.set', { path: nb, patch: { activeCellId: 'c' } });
    expect(setRes.result).toEqual({ collapsed: {}, activeCellId: 'c' });
    await sleep(50);
    expect(readUiFile(nb)).toEqual({ [nb]: { collapsed: {}, activeCellId: 'c' } });
  });

  it('参数校验：缺 path / patch 非对象 → -32602', async () => {
    const call = setup();
    expect((await call('ui.get', {})).error?.code).toBe(-32602);
    expect((await call('ui.set', { path: 'x.py' })).error?.code).toBe(-32602);
    expect((await call('ui.set', { path: 'x.py', patch: 'nope' })).error?.code).toBe(-32602);
  });

  it('dispose 把未决 ui.set 立即落盘', async () => {
    const nb = tmpNotebook();
    const store = new UiStore({ debounceMs: 60_000 });
    const call = setup(store);
    await call('ui.set', { path: nb, patch: { collapsed: { b: true } } });
    expect(existsSync(UiStore.fileFor(nb))).toBe(false);
    router!.dispose();
    expect(readUiFile(nb)).toEqual({ [nb]: { collapsed: { b: true }, activeCellId: null } });
  });
});
