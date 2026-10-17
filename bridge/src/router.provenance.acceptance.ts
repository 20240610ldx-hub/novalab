/** Real stdio kernel: ADR-015 provenance records exactly the data inputs (no interpreter/library noise) and outputs. */
import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { RpcRouter } from './router';
import { KernelSupervisor, StdioKernelTransport } from './supervisor';
import type { RpcResponse } from './protocol';
import { provenanceFileFor, readProvenance, type ProvenanceLookup } from './provenance';
import { sha256Hex } from './run-log';

const pyDir = fileURLToPath(new URL('../../py/', import.meta.url));
const python = path.join(pyDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const SOURCE = [
  '# %% [cell-id: aaaaaaaa]',
  'import matplotlib',
  'matplotlib.use("Agg")',
  'import matplotlib.pyplot as plt',
  'import pandas as pd',
  'survey = pd.read_csv("survey.csv")',
  '',
  '# %% [cell-id: bbbbbbbb]',
  'summary = survey.groupby("city", as_index=False)["pop"].sum()',
  'summary.to_csv("out_summary.csv", index=False)',
  'fig, ax = plt.subplots()',
  'ax.bar(summary["city"], summary["pop"])',
  'fig.savefig("fig1.png")',
  'plt.close(fig)',
  '',
].join('\n');

let supervisor: KernelSupervisor | undefined;
let directory: string | undefined;
let kernelExited: Promise<void> | undefined;

afterEach(async () => {
  supervisor?.stop();
  await kernelExited;
  supervisor = undefined;
  kernelExited = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

it('real kernel: read_csv input and to_csv / savefig outputs are fingerprinted; lookup tracks later edits', async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'novalab-prov-acc-'));
  const notebook = path.join(directory, 'notebook.py');
  writeFileSync(notebook, SOURCE, 'utf8');
  writeFileSync(path.join(directory, 'survey.csv'), 'city,pop\nA,1\nB,2\nA,3\n', 'utf8');
  supervisor = new KernelSupervisor({
    transportFactory: () =>
      new StdioKernelTransport(pyDir, { NOVALAB_PACKAGED: '0', NOVALAB_PY_DIR: pyDir }, {
        spawnImpl: ((command: string, args: readonly string[], options: SpawnOptions) => {
          const child = existsSync(python)
            ? spawn(python, ['-m', 'novakernel.server'], options)
            : spawn(command, args, options);
          kernelExited = new Promise<void>((resolve) => child.once('close', () => resolve()));
          return child;
        }) as typeof spawn,
      }),
    pingIntervalMs: 60_000,
  });
  const router = new RpcRouter({ supervisor, broadcast: () => {} });
  let id = 0;
  const call = (method: string, params?: unknown): Promise<RpcResponse> =>
    router.handle({ jsonrpc: '2.0', id: ++id, method, params });
  expect((await call('notebook.open', { path: notebook })).error).toBeUndefined();
  for (const cellId of ['aaaaaaaa', 'bbbbbbbb']) {
    const run = await call('cell.run', { cellId });
    expect(run.error).toBeUndefined();
    expect((run.result as { ok?: boolean }).ok, JSON.stringify(run.result)).not.toBe(false);
  }

  const summary = path.join(directory, 'out_summary.csv');
  const lookup = async (p: string) => (await call('provenance.lookup', { path: p })).result as ProvenanceLookup;
  const res = await lookup(summary);
  expect(res.producedBy).toMatchObject({ cellId: 'bbbbbbbb' });
  expect(res.current).toBe('same');
  expect(res.recorded!.sha256).toBe(sha256Hex(readFileSync(summary, 'utf8')));
  // b 只用内存里的 survey：没有文件输入
  expect(res.inputs).toEqual([]);

  const records = readProvenance(provenanceFileFor(directory));
  const byCell = Object.fromEntries(records.map((r) => [r.cellId, r]));
  // 只有数据文件：import pandas / matplotlib 读的源码、字体、配置都被过滤
  expect(byCell['aaaaaaaa']!.inputs.map((i) => path.basename(i.path))).toEqual(['survey.csv']);
  expect(byCell['aaaaaaaa']!.outputs).toEqual([]);
  expect(byCell['bbbbbbbb']!.outputs.map((o) => path.basename(o.path)).sort()).toEqual(['fig1.png', 'out_summary.csv']);
  for (const o of byCell['bbbbbbbb']!.outputs) expect(o.sha256).toMatch(/^[0-9a-f]{64}$/);

  writeFileSync(summary, 'hand edited\n', 'utf8');
  expect((await lookup(summary)).current).toBe('modified');
}, 60_000);
