/**
 * ADR-015：router 在每次运行结束时把读写文件的 SHA-256 记进 `.novalab/provenance.jsonl`，
 * provenance.lookup 回答"这个文件哪来的、改过没有"，导出把指纹写进 cell 元数据。
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KernelSupervisor } from './supervisor';
import { RpcRouter } from './router';
import { FakeKernel } from './testing/fake-kernel';
import type { RpcResponse } from './protocol';
import { provenanceFileFor, readProvenance, type ProvenanceLookup } from './provenance';
import { sha256Hex } from './run-log';

let sup: KernelSupervisor | undefined;
let fakes: FakeKernel[] = [];
let router: RpcRouter;
let reqId = 0;

function setup(): void {
  fakes = [];
  sup = new KernelSupervisor({
    transportFactory: () => {
      const f = new FakeKernel();
      fakes.push(f);
      return f;
    },
    pingIntervalMs: 60_000,
  });
  router = new RpcRouter({ supervisor: sup, broadcast: () => undefined, confirmers: () => 1 });
}

async function call(method: string, params?: unknown): Promise<RpcResponse> {
  return router.handle({ jsonrpc: '2.0', id: ++reqId, method, params });
}

async function open(): Promise<{ nb: string; dir: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'novalab-prov-router-'));
  const nb = path.join(dir, 'demo.py');
  expect((await call('notebook.open', { path: nb })).error).toBeUndefined();
  return { nb, dir };
}

async function lookup(p: string): Promise<ProvenanceLookup> {
  const res = await call('provenance.lookup', { path: p });
  expect(res.error).toBeUndefined();
  return res.result as ProvenanceLookup;
}

afterEach(() => {
  sup?.stop();
  sup = undefined;
});

describe('结果溯源（ADR-015）· router', () => {
  it('运行读写文件 → 一行溯源（runId 与运行日志一致）；lookup 给出产生它的 cell 与现状', async () => {
    setup();
    const { dir } = await open();
    const input = path.join(dir, 'survey.csv');
    const output = path.join(dir, 'out', 'summary.csv');
    writeFileSync(input, 'city,pop\n');
    fakes[0]!.notifyReads = { cellId: 'b', paths: [input] };
    fakes[0]!.notifyWrites = { cellId: 'b', paths: [output] };
    // fake kernel 不真写盘：模拟 cell 写出的文件
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, 'city,total\n');
    await call('cell.run', { cellId: 'b' });

    const res = await lookup(output);
    const runs = (await call('session.runs', { cellId: 'b' })).result as { records: { runId: string; codeSha256: string }[] };
    expect(res.producedBy).toMatchObject({ cellId: 'b', notebook: 'demo.py', runId: runs.records.at(-1)!.runId, codeSha256: runs.records.at(-1)!.codeSha256 });
    expect(res.recorded).toMatchObject({ sha256: sha256Hex('city,total\n'), bytes: 11 });
    expect(res.current).toBe('same');
    expect(res.inputs).toEqual([{ path: input, sha256: sha256Hex('city,pop\n'), bytes: 9, current: 'same' }]);

    writeFileSync(input, 'city,pop\nX,1\n');
    expect((await lookup(output)).inputs![0]!.current).toBe('modified');
    expect((await lookup(path.join(dir, 'unrelated.txt'))).producedBy).toBeNull();
  });

  it('不读写文件的运行不记溯源', async () => {
    setup();
    const { dir } = await open();
    await call('cell.run', { cellId: 'a' });
    await new Promise((r) => setTimeout(r, 20));
    expect(readProvenance(provenanceFileFor(dir))).toEqual([]);
  });

  it('导出 .ipynb：cell 元数据带输入 / 输出指纹，目录外路径只留文件名', async () => {
    setup();
    const { nb, dir } = await open();
    const outside = path.join(mkdtempSync(path.join(tmpdir(), 'novalab-prov-ext-')), 'raw.csv');
    const output = path.join(dir, 'fig.png');
    writeFileSync(outside, 'raw');
    writeFileSync(output, 'png');
    fakes[0]!.notifyReads = { cellId: 'b', paths: [outside] };
    fakes[0]!.notifyWrites = { cellId: 'b', paths: [output] };
    await call('cell.run', { cellId: 'b' });
    const target = path.join(dir, 'out.ipynb');
    expect((await call('export.ipynb', { path: nb, target })).error).toBeUndefined();
    const ipynb = JSON.parse(readFileSync(target, 'utf8')) as { cells: { id: string; metadata: Record<string, unknown> }[] };
    const prov = (ipynb.cells.find((c) => c.id === 'b')!.metadata['novalab'] as { provenance: Record<string, unknown> }).provenance;
    expect(prov).toMatchObject({
      inputs: [{ path: '<external>/raw.csv', sha256: sha256Hex('raw'), bytes: 3 }],
      outputs: [{ path: 'fig.png', sha256: sha256Hex('png'), bytes: 3 }],
    });
    expect(JSON.stringify(ipynb)).not.toContain(path.dirname(outside).replace(/\\/g, '\\\\'));
  });
});
