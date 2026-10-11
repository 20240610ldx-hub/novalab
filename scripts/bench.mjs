/**
 * intent §8 量化指标基准（v0.1.1）：把"冷启动 / cell 附加开销 / 滚动帧率 / bridge 内存"变成可重复的数。
 *
 * 用法（仓库根）：
 *   node scripts/bench.mjs                 # 后端指标：bridge 冷启动、100 cell notebook 打开、cell 附加开销、bridge RSS
 *   node scripts/bench.mjs --ui            # 另测前端：页面到 100 cell 可见、滚动帧率（需 dev 服务已在跑：
 *                                          #   pnpm dev:bridge + vite 于 http://127.0.0.1:5199）
 *   node scripts/bench.mjs --json out.json # 结果另存 JSON
 *   node scripts/bench.mjs --runs 100      # cell 附加开销采样次数（默认 50）
 *
 * 口径与局限（结果表里同样注明）：
 *  - 后端测的是 dev 形态（tsx 即时编译 bridge）；安装版跑 esbuild 单文件 bundle，冷启动只会更快。
 *  - "冷启动"= spawn bridge → 运行清单写出 → WS 连上并通过 bridge.auth → notebook.open(100 cell) 返回；
 *    不含 Tauri 窗口与首帧绘制（--ui 的"页面就绪"单独给出）。
 *  - cell 附加开销 = cell.run 往返墙钟 − 内核上报 durationMs（即 bridge + 协议 + 调度的额外成本）。
 *  - bridge 独立进程起在临时数据目录（运行清单 bridge.json 写在那里，不碰正在跑的 dev bridge）。
 */
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'bridge', 'package.json'));
const { WebSocket } = require('ws');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const RUNS = Number(opt('--runs', '50'));
const JSON_OUT = opt('--json', null);
const APP_URL = opt('--app', 'http://127.0.0.1:5199/');

const TARGETS = {
  coldStartMs: 3000,
  cellOverheadMs: 50,
  scrollFps: 60,
  bridgeRssMB: 150,
};

const log = (...a) => console.log('[bench]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/* ---------------- 夹具：100 cell notebook（临时目录） ---------------- */

const work = fs.mkdtempSync(join(os.tmpdir(), 'novalab-bench-'));
const dataDir = join(work, 'data');
const NB = join(work, 'bench100.py');
const N_CELLS = 100;
{
  const lines = ['# /// script', '# requires-python = ">=3.11"', '# dependencies = []', '# ///', ''];
  for (let i = 0; i < N_CELLS; i++) {
    lines.push(`# %% [cell-id: ${i.toString(16).padStart(8, '0')}]`);
    lines.push(`v${i} = ${i}${i > 0 ? ` + v${i - 1} * 0` : ''}`);
    lines.push('');
  }
  fs.writeFileSync(NB, lines.join('\n'));
}

/* ---------------- 进程内存 ---------------- */

function rssMB(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`],
        { encoding: 'utf8' },
      );
      return Math.round(Number(out.trim()) / 1048576);
    }
    if (process.platform === 'linux') {
      const m = /VmRSS:\s+(\d+)\s+kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
      return m ? Math.round(Number(m[1]) / 1024) : null;
    }
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
    return Math.round(Number(out.trim()) / 1024);
  } catch {
    return null;
  }
}

/* ---------------- 后端基准 ---------------- */

async function backend() {
  const token = crypto.randomBytes(24).toString('base64url');
  const t0 = performance.now();
  const child = spawn(process.execPath, [require.resolve('tsx/cli'), join(root, 'bridge', 'src', 'main.ts')], {
    cwd: join(root, 'bridge'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NOVALAB_DATA_DIR: dataDir, NOVALAB_BRIDGE_TOKEN: token },
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));

  const discovery = join(dataDir, 'bridge.json');
  let info = null;
  while (!info) {
    if (performance.now() - t0 > 60000) throw new Error('bridge 60s 未写出运行清单\n' + stderr);
    try {
      info = JSON.parse(fs.readFileSync(discovery, 'utf8'));
    } catch {
      await sleep(20);
    }
  }
  const bridgeReadyMs = performance.now() - t0;

  // bridge 鉴权（ADR-009）：upgrade 需白名单 Origin；首条消息 bridge.auth {token}
  const ws = await new Promise((resolve, reject) => {
    const s = new WebSocket(info.wsUrl, { headers: { Origin: 'http://127.0.0.1:5199' } });
    s.on('open', () => resolve(s));
    s.on('error', reject);
  });

  let nextId = 1;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });

  const auth = await rpc('bridge.auth', { token });
  if (auth.error || !auth.result?.ok) throw new Error('bridge.auth 失败: ' + JSON.stringify(auth));
  const connectedMs = performance.now() - t0;

  const tOpen = performance.now();
  const opened = await rpc('notebook.open', { path: NB });
  if (opened.error) throw new Error('notebook.open 失败: ' + JSON.stringify(opened.error));
  const openMs = performance.now() - tOpen;
  const coldStartMs = performance.now() - t0;
  const cells = opened.result.state.cells;
  if (cells.length !== N_CELLS) throw new Error(`期望 ${N_CELLS} cells，实际 ${cells.length}`);

  // 预热（首跑含 import/编译缓存）
  for (let i = 0; i < 3; i++) await rpc('cell.run', { cellId: cells[0].id, cascade: false });

  const overheads = [];
  const walls = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    const res = await rpc('cell.run', { cellId: cells[0].id, cascade: false });
    const wall = performance.now() - t;
    if (!res.result?.ok) throw new Error('cell.run 失败: ' + JSON.stringify(res));
    walls.push(wall);
    overheads.push(Math.max(0, wall - (Number(res.result.durationMs) || 0)));
  }

  // 全量跑一遍 100 cell（RSS 取有内容后的水位）
  const tAll = performance.now();
  for (const c of cells) await rpc('cell.run', { cellId: c.id, cascade: false });
  const run100Ms = performance.now() - tAll;
  const bridgeRss = rssMB(info.pid);

  await rpc('notebook.close', { notebookId: opened.result.notebookId }).catch(() => {});
  ws.close();
  child.kill();
  await sleep(300);

  return {
    bridgeReadyMs,
    connectedMs,
    openMs,
    coldStartMs,
    cellOverheadMedianMs: pct(overheads, 50),
    cellOverheadP95Ms: pct(overheads, 95),
    cellWallMedianMs: pct(walls, 50),
    run100Ms,
    bridgeRssMB: bridgeRss,
  };
}

/* ---------------- 前端基准（--ui，复用正在跑的 dev 服务） ---------------- */

async function ui() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('novalab.lang', 'en');
    } catch {
      /* 忽略 */
    }
  });
  const t0 = Date.now();
  await page.goto(APP_URL + '?path=' + encodeURIComponent(NB), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((n) => document.querySelectorAll('section[data-cell-id]').length >= n, N_CELLS, {
    timeout: 60000,
  });
  const pageReadyMs = Date.now() - t0;
  await page.waitForTimeout(800);

  const scroll = await page.evaluate(async () => {
    const el = document.querySelector('main > div.flex-1.overflow-y-auto');
    if (!el) return null;
    const durationMs = 2000;
    const frames = [];
    const start = performance.now();
    let last = start;
    await new Promise((resolve) => {
      const step = (now) => {
        frames.push(now - last);
        last = now;
        const p = (now - start) / durationMs;
        el.scrollTop = (el.scrollHeight - el.clientHeight) * (p <= 0.5 ? p * 2 : (1 - p) * 2);
        if (now - start < durationMs) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    const total = performance.now() - start;
    return {
      fps: (frames.length / total) * 1000,
      longFrames: frames.filter((f) => f > 20).length,
      worstFrameMs: Math.max(...frames),
    };
  });
  await browser.close();
  return { pageReadyMs, ...(scroll ?? {}) };
}

/* ---------------- 主流程 ---------------- */

const fmt = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toFixed(d));
const verdict = (v, target, lowerIsBetter = true) =>
  v === null || v === undefined ? '未测' : (lowerIsBetter ? v <= target : v >= target) ? '✅' : '❌';

try {
  log(`后端：spawn bridge（临时数据目录）· 100 cell notebook · cell 采样 ${RUNS} 次`);
  const be = await backend();
  let fe = null;
  if (flag('--ui')) {
    log(`前端：${APP_URL}（需 dev bridge + vite 在跑）`);
    fe = await ui();
  }

  const rows = [
    ['冷启动（spawn→WS→open 100 cell）', fmt(be.coldStartMs), `< ${TARGETS.coldStartMs}`, verdict(be.coldStartMs, TARGETS.coldStartMs)],
    ['  ├ bridge 就绪（运行清单写出）', fmt(be.bridgeReadyMs), '', ''],
    ['  └ notebook.open（含内核 spawn）', fmt(be.openMs), '', ''],
    ['cell 附加开销 中位数', fmt(be.cellOverheadMedianMs, 1), `< ${TARGETS.cellOverheadMs}`, verdict(be.cellOverheadMedianMs, TARGETS.cellOverheadMs)],
    ['cell 附加开销 p95', fmt(be.cellOverheadP95Ms, 1), `< ${TARGETS.cellOverheadMs}`, verdict(be.cellOverheadP95Ms, TARGETS.cellOverheadMs)],
    ['顺序跑完 100 cell', fmt(be.run100Ms), '', ''],
    ['bridge RSS', fmt(be.bridgeRssMB), `< ${TARGETS.bridgeRssMB} MB`, verdict(be.bridgeRssMB, TARGETS.bridgeRssMB)],
  ];
  if (fe) {
    rows.push(['页面→100 cell 可见（已连 bridge）', fmt(fe.pageReadyMs), '', '']);
    // headless chromium 无 GPU 合成，帧率偏保守：≥60 ✅；55–60 🟡（需真机复核）；<55 ❌
    const fpsVerdict = fe.fps == null ? '未测' : fe.fps >= TARGETS.scrollFps ? '✅' : fe.fps >= 55 ? '🟡 headless 偏低，需真机复核' : '❌';
    rows.push(['100 cell 滚动帧率（headless）', fmt(fe.fps, 1), `≥ ${TARGETS.scrollFps}`, fpsVerdict]);
    rows.push(['  └ 长帧（>20ms）/ 最差帧', `${fe.longFrames ?? '—'} / ${fmt(fe.worstFrameMs)}ms`, '', '']);
  } else {
    rows.push(['100 cell 滚动帧率', '—', `≥ ${TARGETS.scrollFps}`, '未测（加 --ui）']);
  }

  console.log('\n| 指标 | 实测 (ms 除注明) | 目标 | 判定 |\n|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.join(' | ')} |`);
  console.log(
    `\n口径：dev 形态（tsx 即时编译 bridge）；${os.platform()} ${os.arch()} · node ${process.version} · ${os.cpus()[0]?.model ?? ''}`,
  );

  if (JSON_OUT) {
    fs.writeFileSync(
      JSON_OUT,
      JSON.stringify({ at: new Date().toISOString(), platform: `${os.platform()} ${os.arch()}`, runs: RUNS, targets: TARGETS, backend: be, ui: fe }, null, 2),
    );
    log('JSON →', JSON_OUT);
  }
} catch (err) {
  console.error('BENCH_FAIL:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {
    /* 内核进程可能仍占用 .novalab：留给系统临时目录清理 */
  }
}
