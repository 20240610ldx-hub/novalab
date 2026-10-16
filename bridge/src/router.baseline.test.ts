/**
 * D4（第 6 轮，Owner 2026-10-16 批准）：内核 load_file / save_file 报告的基线指纹
 * baselineSha256 必须原样透传到前端可见的响应里，前端才能在 bridge 换代后核对
 * "重开时的磁盘"是否仍是旧代最后确认的基线，避免 dirty 草稿覆盖断线期间的外部修改。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RpcRouter } from './router';
import { MultiSupervisor, type KernelTransport } from './supervisor';
import type { KernelRequest, KernelWireMessage, NotebookOpenResult, RpcResponse } from './protocol';

class FingerprintKernel implements KernelTransport {
  loads = 0;
  saves = 0;
  private message?: (message: KernelWireMessage) => void;
  private exit?: (code: number | null) => void;
  send(request: KernelRequest) {
    queueMicrotask(() => {
      let result: unknown = {};
      switch (request.method) {
        case 'load_file':
          this.loads += 1;
          result = {
            cells: [{ id: 'a', code: 'x = 1', defs: ['x'], refs: [], execCount: 0 }],
            dagEdges: [], schemas: [], staleSet: [], execCounts: { a: 0 },
            baselineSha256: `sha-load-${this.loads}`,
          };
          break;
        case 'save_file':
          this.saves += 1;
          result = { ok: true, baselineSha256: `sha-save-${this.saves}` };
          break;
        case 'backup_file': result = { recoveryPath: 'local.recovery.py' }; break;
        case 'set_cells': {
          const cells = request.params!['cells'] as { id: string; code: string }[];
          result = { cells: cells.map((c) => ({ ...c, defs: [], refs: [], execCount: 0 })), dagEdges: [], staleSet: [] };
          break;
        }
        case 'validate_cells': result = {}; break;
        case 'exec_cell': result = { cellId: request.params!['cellId'], ok: true, cascaded: [], durationMs: 1 }; break;
        case 'introspect': result = { schemas: [] }; break;
        case 'ping': result = { pong: true }; break;
      }
      this.message?.({ id: request.id, result });
    });
  }
  onMessage(callback: (message: KernelWireMessage) => void) { this.message = callback; }
  onExit(callback: (code: number | null) => void) { this.exit = callback; }
  kill() { this.exit?.(null); }
}

let multi: MultiSupervisor | undefined;
let router: RpcRouter | undefined;
let id = 0;
function setup() {
  multi = new MultiSupervisor({ transportFactory: () => new FingerprintKernel(), pingIntervalMs: 60_000 });
  router = new RpcRouter({ multi, broadcast: () => {} });
}
async function call(method: string, params?: unknown): Promise<RpcResponse> {
  return router!.handle({ jsonrpc: '2.0', id: ++id, method, params });
}
afterEach(() => {
  router?.dispose();
  multi?.stopAll();
});

describe('baselineSha256 pass-through (D4)', () => {
  it('notebook.open carries the load_file fingerprint', async () => {
    setup();
    const res = await call('notebook.open', { path: '/tmp/novalab-d4/a.py' });
    expect((res.result as NotebookOpenResult).state.baselineSha256).toBe('sha-load-1');
  });

  it('cell.save and diff.accept report the fingerprint of the bytes they just wrote', async () => {
    setup();
    const opened = (await call('notebook.open', { path: '/tmp/novalab-d4/a.py' })).result as NotebookOpenResult;
    const saved = await call('cell.save', { notebookId: opened.notebookId, cellId: 'a', code: 'x = 2' });
    expect(saved.error).toBeUndefined();
    expect((saved.result as { baselineSha256?: string }).baselineSha256).toBe('sha-save-1');

    const staged = await call('diff.stage', { targetCellId: 'a', action: 'update', newCode: 'x = 3' });
    const accepted = await call('diff.accept', { diffId: (staged.result as { diffId: string }).diffId });
    expect(accepted.error).toBeUndefined();
    expect((accepted.result as { baselineSha256?: string }).baselineSha256).toBe('sha-save-2');
  });

  it('switch and reopen of an existing tab report the latest confirmed fingerprint', async () => {
    setup();
    const a = (await call('notebook.open', { path: '/tmp/novalab-d4/a.py' })).result as NotebookOpenResult;
    await call('cell.save', { notebookId: a.notebookId, cellId: 'a', code: 'x = 2' });
    await call('notebook.open', { path: '/tmp/novalab-d4/b.py' });
    const switched = await call('notebook.switch', { notebookId: a.notebookId });
    expect((switched.result as NotebookOpenResult).state.baselineSha256).toBe('sha-save-1');
    const again = await call('notebook.open', { path: '/tmp/novalab-d4/a.py' });
    expect((again.result as NotebookOpenResult).state.baselineSha256).toBe('sha-save-1');
  });

  it('notebook.reload reports the freshly loaded fingerprint', async () => {
    setup();
    const a = (await call('notebook.open', { path: '/tmp/novalab-d4/a.py' })).result as NotebookOpenResult;
    const reloaded = await call('notebook.reload', { notebookId: a.notebookId });
    expect(reloaded.error).toBeUndefined();
    expect((reloaded.result as NotebookOpenResult).state.baselineSha256).toBe('sha-load-2');
  });
});
