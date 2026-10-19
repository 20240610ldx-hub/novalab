import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ProvenanceLog,
  exportPath,
  hashFile,
  lookupProvenance,
  provenanceFileFor,
  readProvenance,
} from './provenance';
import { sha256Hex } from './run-log';

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'novalab-prov-'));
}

const ENTRY = { notebook: 'demo.py', sessionId: 's-1', runId: 'r-1', cellId: 'b', codeSha256: 'c0de' };

describe('结果溯源（ADR-015）', () => {
  it('hashFile：内容 SHA-256 与字节数；超上限只给大小；不存在标 missing', async () => {
    const dir = tmp();
    const f = path.join(dir, 'a.csv');
    writeFileSync(f, 'a,b\n1,2\n');
    expect(await hashFile(f)).toEqual({ sha256: sha256Hex('a,b\n1,2\n'), bytes: 8 });
    expect(await hashFile(f, 4)).toEqual({ sha256: null, bytes: 8, skipped: 'too-large' });
    expect(await hashFile(path.join(dir, 'nope'))).toEqual({ sha256: null, bytes: null, skipped: 'missing' });
  });

  it('一次运行一行：输入 / 输出指纹；先读后写的文件只记为输出并标 inPlace；无读写不记', async () => {
    const dir = tmp();
    const input = path.join(dir, 'in.csv');
    const both = path.join(dir, 'state.json');
    const output = path.join(dir, 'out', 'fig.png');
    writeFileSync(input, 'x');
    writeFileSync(both, '{}');
    const log = new ProvenanceLog(provenanceFileFor(dir), { clock: () => new Date('2026-10-17T10:00:00Z') });
    log.record({ ...ENTRY, runId: 'r-0', reads: [], writes: [] });
    log.record({ ...ENTRY, reads: [input, both], writes: [both, output] });
    await log.whenIdle();
    const recs = readProvenance(log.file);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ v: 1, ts: '2026-10-17T10:00:00.000Z', notebook: 'demo.py', runId: 'r-1', cellId: 'b', codeSha256: 'c0de' });
    expect(recs[0]!.inputs).toEqual([{ path: input, sha256: sha256Hex('x'), bytes: 1 }]);
    expect(recs[0]!.outputs).toEqual([
      { path: both, sha256: sha256Hex('{}'), bytes: 2, inPlace: true },
      { path: output, sha256: null, bytes: null, skipped: 'missing' },
    ]);
  });

  it('lookup：取最近一次写它的运行，并现场比对文件与输入是否变化', async () => {
    const dir = tmp();
    const input = path.join(dir, 'in.csv');
    const out = path.join(dir, 'out.csv');
    writeFileSync(input, 'v1');
    writeFileSync(out, 'first');
    const log = new ProvenanceLog(provenanceFileFor(dir));
    log.record({ ...ENTRY, runId: 'r-1', reads: [input], writes: [out] });
    await log.whenIdle();
    writeFileSync(out, 'second');
    log.record({ ...ENTRY, runId: 'r-2', reads: [input], writes: [out] });
    await log.whenIdle();

    let res = await lookupProvenance(log.file, out);
    expect(res.producedBy).toMatchObject({ runId: 'r-2', cellId: 'b', sessionId: 's-1' });
    expect(res.current).toBe('same');
    expect(res.inputs!.map((i) => i.current)).toEqual(['same']);

    writeFileSync(out, 'hand-edited');
    writeFileSync(input, 'v2');
    res = await lookupProvenance(log.file, out);
    expect(res.current).toBe('modified');
    expect(res.inputs!.map((i) => i.current)).toEqual(['modified']);

    expect(await lookupProvenance(log.file, path.join(dir, 'never.csv'))).toEqual({ path: path.join(dir, 'never.csv'), producedBy: null });
  });

  it('坏行跳过；文件不存在 → []', () => {
    const dir = tmp();
    expect(readProvenance(provenanceFileFor(dir))).toEqual([]);
    const f = path.join(dir, 'p.jsonl');
    writeFileSync(f, '{"broken\n' + JSON.stringify({ v: 1, runId: 'r-1', cellId: 'a', inputs: [], outputs: [] }) + '\n');
    expect(readProvenance(f)).toHaveLength(1);
  });

  it('导出路径：notebook 目录内相对路径，目录外只留文件名', () => {
    const dir = tmp();
    expect(exportPath(path.join(dir, 'out', 'fig.png'), dir)).toBe('out/fig.png');
    expect(exportPath(path.join(path.dirname(dir), 'elsewhere', 'raw.csv'), dir)).toBe('<external>/raw.csv');
  });
});
