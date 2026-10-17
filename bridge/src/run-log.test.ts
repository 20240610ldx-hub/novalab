import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunLog, readRunLog, runLogFileFor, sha256Hex } from './run-log';

function tmpFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'novalab-runlog-')), 's-1.runs.jsonl');
}

const OUT = { stdoutBytes: 0, stderrBytes: 0, mime: [], writes: [] };

describe('RunLog（ADR-014 追加式运行日志）', () => {
  it('started → finished 落一行；同一代码只在首次内联正文，之后只记哈希', () => {
    const file = tmpFile();
    let now = 1_000;
    const log = new RunLog(file, { clock: () => new Date(now) });
    log.started('a', { code: 'x = 1', actor: 'user', trigger: 'direct' });
    now += 40;
    log.finished('a', { ok: true, attempt: 1, out: OUT });
    log.started('a', { code: 'x = 1', actor: 'agent', trigger: 'direct' });
    log.finished('a', { ok: false, attempt: 2, error: { name: 'KeyError', line: 3 }, out: OUT });
    const { records, truncated } = readRunLog(file);
    expect(truncated).toBe(false);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      v: 1, runId: 'r-1', cellId: 'a', attempt: 1, actor: 'user', trigger: 'direct',
      code: 'x = 1', codeSha256: sha256Hex('x = 1'), ok: true, durationMs: 40,
      ts: new Date(1_000).toISOString(),
    });
    expect(records[1]).toMatchObject({ runId: 'r-2', actor: 'agent', ok: false, error: { name: 'KeyError', line: 3 } });
    expect(records[1]).not.toHaveProperty('code'); // 去重：同哈希不再内联
  });

  it('级联：同一请求里后续 cell 记 trigger=cascade、rootRunId 指向根运行', () => {
    const file = tmpFile();
    const log = new RunLog(file);
    log.started('a', { code: 'x = 1', actor: 'user', trigger: 'direct' });
    log.finished('a', { ok: true, attempt: 1, out: OUT }); // 真实内核：根先 run.done，再跑下游
    log.started('b', { code: 'y = x', actor: 'user', trigger: 'cascade', rootCellId: 'a' });
    log.finished('b', { ok: true, attempt: 1, out: OUT });
    const { records } = readRunLog(file);
    expect(records.map((r) => r.cellId)).toEqual(['a', 'b']); // 按开始顺序返回
    expect(records[1]).toMatchObject({ trigger: 'cascade', rootRunId: records[0]!.runId });
  });

  it('读回按开始顺序排序：根运行晚于下游结束（真实内核级联）时仍排在前面', () => {
    const file = tmpFile();
    const log = new RunLog(file);
    log.started('a', { code: 'x = 1', actor: 'user', trigger: 'direct' });
    log.started('b', { code: 'y = x', actor: 'user', trigger: 'cascade', rootCellId: 'a' });
    log.finished('b', { ok: true, attempt: 1, out: OUT });
    log.finished('a', { ok: true, attempt: 1, out: OUT });
    expect(readRunLog(file).records.map((r) => r.cellId)).toEqual(['a', 'b']);
  });

  it('没有 started 的 finished 被忽略（不凭空造记录）', () => {
    const file = tmpFile();
    const log = new RunLog(file);
    log.finished('zz', { ok: true, attempt: 1, out: OUT });
    expect(readRunLog(file).records).toEqual([]);
  });

  it('代码预算用尽后只记哈希（codeOmitted）；行数上限后写一次 truncated 标记并停止', () => {
    const file = tmpFile();
    const log = new RunLog(file, { maxCodeChars: 10, maxRecords: 3 });
    for (const code of ['aaaaaaaa', 'bbbbbbbb', 'c', 'd', 'e']) {
      log.started('a', { code, actor: 'user', trigger: 'direct' });
      log.finished('a', { ok: true, attempt: 1, out: OUT });
    }
    const { records, truncated } = readRunLog(file);
    expect(truncated).toBe(true);
    expect(records).toHaveLength(3);
    expect(records[0]!.code).toBe('aaaaaaaa');
    expect(records[1]).toMatchObject({ codeOmitted: true, codeSha256: sha256Hex('bbbbbbbb') });
    expect(records[1]).not.toHaveProperty('code');
    // 标记只写一次
    expect(readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('"truncated"'))).toHaveLength(1);
  });

  it('读取宽容：坏行 / 未知版本跳过；文件不存在 → 空', () => {
    const file = tmpFile();
    expect(readRunLog(file)).toEqual({ records: [], truncated: false });
    const log = new RunLog(file);
    log.started('a', { code: 'x', actor: 'user', trigger: 'direct' });
    log.finished('a', { ok: true, attempt: 1, out: OUT });
    appendFileSync(file, '{not json\n{"v":99,"cellId":"q"}\n');
    expect(readRunLog(file).records.map((r) => r.cellId)).toEqual(['a']);
  });

  it('cellId 过滤；文件名由事件流路径推导', () => {
    const file = tmpFile();
    writeFileSync(file, '');
    const log = new RunLog(file);
    for (const id of ['a', 'b', 'a']) {
      log.started(id, { code: id, actor: 'user', trigger: 'direct' });
      log.finished(id, { ok: true, attempt: 1, out: OUT });
    }
    expect(readRunLog(file, { cellId: 'a' }).records).toHaveLength(2);
    expect(runLogFileFor(path.join('x', 'sessions', 's-1.jsonl'))).toBe(path.join('x', 'sessions', 's-1.runs.jsonl'));
  });
});
