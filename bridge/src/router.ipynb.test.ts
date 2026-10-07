/**
 * router.ipynb.test.ts —— P3.4 接线测试：export.ipynb / import.ipynb 经 router 全链路。
 * live 会话导出（富缓存）→ 文件落盘 nbformat 4.5 → import 回转 .py 守恒。
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KernelSupervisor } from './supervisor';
import { RpcRouter } from './router';
import { FakeKernel } from './testing/fake-kernel';
import type { RpcResponse } from './protocol';

function makeRouter() {
  const notes: { method: string; params?: unknown }[] = [];
  const sup = new KernelSupervisor({
    transportFactory: () => new FakeKernel(),
  });
  const router = new RpcRouter({
    supervisor: sup,
    broadcast: (method, params) => notes.push({ method, params }),
  });
  let id = 0;
  const call = async (method: string, params: unknown = {}) =>
    (await router.handle({ jsonrpc: '2.0', id: ++id, method, params })) as RpcResponse;
  return { router, call, sup };
}

describe('export.ipynb / import.ipynb 接线（P3.4）', () => {
  it('live 会话导出 → nbformat 落盘 → import 回转 .py 细胞数守恒', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'novalab-ipynb-'));
    const nb = path.join(dir, 'demo.py');
    const { router, call } = makeRouter();
    const opened = await call('notebook.open', { path: nb });
    expect(opened.error).toBeUndefined();
    const notebookId = (opened.result as { notebookId: string }).notebookId;
    const cellCount = (opened.result as { state: { cells: unknown[] } }).state.cells.length;
    expect(cellCount).toBeGreaterThan(0);

    const exported = await call('export.ipynb', { path: nb });
    expect(exported.error).toBeUndefined();
    const exp = exported.result as { path: string; nbCells: number; nbOutputs: number };
    expect(exp.nbCells).toBe(cellCount);
    expect(existsSync(exp.path)).toBe(true);
    const nbjson = JSON.parse(readFileSync(exp.path, 'utf8')) as Record<string, unknown>;
    expect(nbjson['nbformat']).toBe(4);
    expect(nbjson['nbformat_minor']).toBe(5);
    const meta = nbjson['metadata'] as { novalab?: { notebookPath?: string; sessionId?: string } };
    expect(meta.novalab?.notebookPath).toBe(nb);
    expect(typeof meta.novalab?.sessionId).toBe('string');

    const target = path.join(dir, 'imported.py');
    const imported = await call('import.ipynb', { path: exp.path, targetPath: target });
    expect(imported.error).toBeUndefined();
    const imp = imported.result as { path: string; cells: unknown[]; warnings: unknown[] };
    expect(imp.path).toBe(target);
    expect(imp.cells.length).toBe(cellCount);
    expect(existsSync(target)).toBe(true);
    const py = readFileSync(target, 'utf8');
    expect(py).toContain('# %% [cell-id:');
    void router;
    void notebookId;
  });

  it('未打开 notebook 且无 path → ERR_NO_NOTEBOOK；未知 sessionId → -32602', async () => {
    const { call } = makeRouter();
    const noNb = await call('export.ipynb', {});
    expect(noNb.error?.code).toBe(-32001);
    const dir = mkdtempSync(path.join(tmpdir(), 'novalab-ipynb2-'));
    const nb = path.join(dir, 'x.py');
    await call('notebook.open', { path: nb });
    const badSession = await call('export.ipynb', { path: nb, sessionId: 's-nope' });
    expect(badSession.error?.code).toBe(-32602);
  });
});
