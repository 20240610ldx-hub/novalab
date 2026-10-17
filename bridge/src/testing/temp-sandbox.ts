import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * vitest globalSetup：每次测试运行一个专属临时根目录。
 *
 * 单测与验收大量 mkdtemp(os.tmpdir()/novalab-*) 却不清理，%TEMP% 里积累了上千个目录。
 * 这里在 worker 启动前把 TEMP/TMP/TMPDIR 指向 os.tmpdir()/novalab-vitest-XXXX，
 * 运行结束只删这一个目录——不扫描、不按前缀删别处的 novalab-*（并行的 smoke /
 * 其他会话的临时目录不受影响）。子进程（Python 内核、bridge）继承同一环境。
 */
export default function setup(): () => void {
  const saved = { TEMP: process.env['TEMP'], TMP: process.env['TMP'], TMPDIR: process.env['TMPDIR'] };
  const runDir = mkdtempSync(path.join(tmpdir(), 'novalab-vitest-'));
  process.env['TEMP'] = runDir;
  process.env['TMP'] = runDir;
  process.env['TMPDIR'] = runDir;
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      // Windows：刚退出的内核可能还短暂持有文件句柄
      rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      console.warn(`[temp-sandbox] could not remove ${runDir}: ${(err as Error).message}`);
    }
  };
}
