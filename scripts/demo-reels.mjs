/**
 * D 线：D1/D2 阶段演示录屏（docs/demos/reels/reel-d1-*.webm / reel-d2-*.webm）。
 *
 * 用法（仓库根；dev 服务已在跑就复用，没跑就自起自停，同 demo-gallery；
 * 注意 vite 一律以 --host 127.0.0.1 自起——IPv6 loopback 在受限环境下
 * "bound 但不 accept"，:5199 被此类僵尸 socket 占位时自动落 5299+ 兜底端口）：
 *   node scripts/demo-reels.mjs [--reel d1|d2] [--force-stage]
 *   --reel        只录指定 reel（调试用；矩阵行随之只更新该条）
 *   --force-stage 跳过 LLM 尝试，reel-d2 直接走降级路径（diff.stage rpc → Tab 采纳）
 *
 * 录制：playwright chromium headless，browser.newContext({ recordVideo })，
 * viewport/视频 1440x900、暗色；每条 reel ≤75s（超时即验证失败），操作间隔
 * 300-800ms 保证可视。视频在 context 关闭后经 page.video().path() 取回并
 * rename 到 docs/demos/reels/（临时目录在同目录下，rename 不跨卷）。
 *
 * reel-d1（P1 全链路）：open demos/demo.py → ViewSwitcher 文件视图一眼
 *   （组件未挂载则跳过）→ 首跑三格 → 键入改上游数字（0.9→1.9）→ 下游
 *   stale 灰徽章 → cascade 开关切 auto → Ctrl+Enter 级联转绿 + 输出渲染 →
 *   REPL df.shape → [repl] 回显 → SessionModal .ipynb 导出（断言落盘）。
 *   录毕经 bridge cell.save 还原 demo.py（+ 字节级兜底）。
 *
 * reel-d2（P2 修错闭环）：open demos/gallery-error.py → 运行出错（error
 *   徽章+红行+traceback+FixCard）→ 点修复 → Agent 流式（dev 走 vite /llm
 *   代理，tokenplan 凭据在 app/.env.local，不入库不回显）→ 行内 Diff 红绿
 *   → 焦点回 body 按 Tab 采纳 → 自动重跑转绿 → 托盘归零。
 *   LLM 失败（错误横幅/40s 内未产出 Diff）→ 废弃该 take，降级重录：
 *   bridge rpc diff.stage 直接生成同款审阅 UI → Tab 采纳（报告注明）。
 *
 * 产物：docs/demos/reels/reel-{d1,d2}-<日期>.webm（>100KB 验证）；系统有
 *   ffmpeg 则同时转 .gif（fps 10、宽 960）；feature-matrix.md 的 D1/D2 两行
 *   与计数行由本脚本幂等重写（拆为两行、挂 reel/gif 相对链接）。
 *
 * 幂等性：gallery-error.py 夹具每次重写（与 demo-gallery 同款内容）；
 *   demo.py 编辑先经 UI/bridge 还原再字节级兜底；旧日期的 reel-d1-…/reel-d2-…
 *   文件在新 reel 成功落盘后清理（矩阵链接不悬空）；demos/.novalab 导出残留容忍。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { BridgeClient, discoverBridge } from './bridge-client.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEMOS = join(root, 'demos');
const REELS_DIR = join(root, 'docs', 'demos', 'reels');
const TMP_DIR = join(REELS_DIR, '.tmp');
const MATRIX_MD = join(root, 'docs', 'demos', 'feature-matrix.md');
/** 主端口被"僵尸监听"（TCP 占位但 HTTP 不应答）时自起的兜底端口扫描区间。 */
const APP_PORT_PRIMARY = 5199;
const APP_PORTS_FALLBACK = [5299, 5300, 5301, 5302, 5303];
let APP_URL = `http://localhost:${APP_PORT_PRIMARY}/`;

const DEMO_PY = join(DEMOS, 'demo.py');
const ERROR_PY = join(DEMOS, 'gallery-error.py');

const argv = process.argv.slice(2);
const ONLY_REEL = (() => {
  const i = argv.indexOf('--reel');
  return i >= 0 ? argv[i + 1] : null;
})();
const FORCE_STAGE = argv.includes('--force-stage');

/** 每条 reel 硬上限（任务裁决 ≤75s；壁钟 ≈ 视频时长）。 */
const REEL_CAP_MS = 75_000;
/** LLM 路径：点修复后等行内 Diff 出现的封顶（超时 → 废弃 take 降级重录）。 */
const AGENT_DIFF_CAP_MS = 40_000;
const MIN_BYTES = 100 * 1024;

const log = (...a) => console.log('[reels]', ...a);
const degradeError = (msg) => Object.assign(new Error(msg), { degrade: true });

/* ---------------- 夹具（与 demo-gallery 同款，每次重写 → 幂等） ---------------- */

const ERROR_FIXTURE = `# /// script
# requires-python = ">=3.11"
# dependencies = ["pandas"]
# ///
# [novalab] width=compact | app_view=false | kernel_python="3.13"

# %% [cell-id: e1a2b3c4]
import pandas as pd

survey = pd.DataFrame(
    {
        "city": ["沈阳", "大连", "鞍山"],
        "pop_2024": [9.1, 7.5, 3.4],
    }
)
survey

# %% [cell-id: e5d6f7a8]
row = survey.iloc[0].to_dict()

label = row["county"]
print(label)
`;

/** 降级路径 diff.stage 的修复码（county → city；与 Agent 预期修复同语义）。 */
const FIXED_CODE = ['row = survey.iloc[0].to_dict()', '', 'label = row["city"]', 'print(label)'].join('\n');

/* ---------------- dev 服务：已在跑就复用、没跑就自起自停 ---------------- */

const startedServers = [];

function killStartedServers() {
  for (const { child, name } of startedServers.splice(0)) {
    if (child.exitCode !== null || child.killed) continue;
    log(`停止自起的 ${name}（pid=${child.pid}，taskkill 整树）`);
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      try {
        child.kill('SIGKILL');
      } catch { /* 忽略 */ }
    }
  }
}

/** TCP 探测（双栈：127.0.0.1 与 ::1 任一活着即算端口被占——僵尸 vite 只绑 ::1）。 */
function probePort(port, timeoutMs = 1200) {
  const one = (host) =>
    new Promise((resolve) => {
      const s = net.connect({ host, port });
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        s.destroy();
        resolve(ok);
      };
      s.setTimeout(timeoutMs);
      s.once('connect', () => finish(true));
      s.once('error', () => finish(false));
      s.once('timeout', () => finish(false));
    });
  return one('127.0.0.1').then((ok) => ok || one('::1'));
}

async function waitForHttp(url, timeoutMs = 120000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* vite 未就绪 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('vite 启动超时: ' + url);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** spawn pnpm 命令（shell:true；输出环形缓存，早退时打印尾部供诊断）。 */
function startDev(args, name = args.join(' ')) {
  const child = spawn('pnpm', args, {
    cwd: root,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tail = [];
  const cap = (d) => {
    tail.push(...String(d).split('\n'));
    if (tail.length > 60) tail.splice(0, tail.length - 60);
  };
  child.stdout.on('data', cap);
  child.stderr.on('data', cap);
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[reels] ${name} 早退 code=${code}，输出尾部:\n` + tail.join('\n'));
    }
  });
  startedServers.push({ child, name });
  return child;
}

/** 短超时 HTTP 200 探测（区分"活的 vite"与僵尸 TCP 监听）。 */
async function httpOk(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * app 服务管理（同画廊：在跑复用/没跑自起/退出自停）＋僵尸端口兜底：
 * :5199 可能被"非 Listen 的僵尸 socket"占位（TCP 探测不到、HTTP 死、vite
 * bind 即 EADDRINUSE，strictPort 无法共存）——不动该进程，dev:app 早退即视为
 * 占用信号，在 5299+ 自起第二个 vite（--port 覆盖；/llm 代理与 bridge ws
 * 均端口无关），APP_URL 随之切换。
 */

/** 起一个 vite（pnpm 命令数组）并等 HTTP 就绪；进程早退 → false。 */
async function startViteAndAwait(args, name, url, timeoutMs = 60000) {
  const child = startDev(args, name);
  const exited = await Promise.race([
    waitForHttp(url, timeoutMs).then(() => false, () => true), // 超时也算失败 → 走兜底
    new Promise((r) => {
      if (child.exitCode !== null) return r(true);
      child.once('exit', () => r(true));
    }),
  ]);
  return !exited;
}

async function ensureApp() {
  // 复用检查只认 IPv4：沙箱内 IPv6 loopback（::1）"bound 但不 accept"，
  // vite 默认绑 localhost→::1 —— 对沙箱内 chromium 不可达，等同僵尸。
  // 故一律以 --host 127.0.0.1 自起（早退=端口真被 IPv4 占用 → 换下一端口）。
  const primary = `http://127.0.0.1:${APP_PORT_PRIMARY}/`;
  if (await httpOk(primary, 2500)) {
    APP_URL = primary;
    log(`app 已在跑（:${APP_PORT_PRIMARY}，IPv4 应答）→ 复用`);
    return;
  }
  for (const port of [APP_PORT_PRIMARY, ...APP_PORTS_FALLBACK]) {
    const url = `http://127.0.0.1:${port}/`;
    if (
      await startViteAndAwait(
        [
          '--filter', '@novalab/app', 'exec', 'vite',
          '--host', '127.0.0.1', '--port', String(port), '--strictPort',
        ],
        `vite:${port}`,
        url,
      )
    ) {
      APP_URL = url;
      log('vite HTTP 200', APP_URL, port === APP_PORT_PRIMARY ? '' : '（兜底端口）');
      return;
    }
    log(`:${port} 起不来（占用/僵尸 socket）→ 试下一端口`);
  }
  throw new Error(`app 无法就绪：:${APP_PORT_PRIMARY} 与兜底 ${APP_PORTS_FALLBACK.join('/')} 全部失败`);
}

/* ---------------- 通用 UI / 录制助手 ---------------- */

/** 操作间隔（任务裁决 300-800ms 保证可视）。 */
const pace = (page, ms) => page.waitForTimeout(Math.min(800, Math.max(300, ms)));

async function openNotebook(page, file) {
  // 新鲜 context 无 onboarded flag → 首启引导模态拦截操作（与画廊同因）
  await page.addInitScript(() => {
    try {
      localStorage.setItem('novalab.onboarded', '1');
      localStorage.setItem('novalab.view', 'notebook');
    } catch {
      /* 忽略 */
    }
  });
  await page.goto(APP_URL + '?path=' + encodeURIComponent(file), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('section[data-cell-id]', { timeout: 40000 });
  const banner = page.locator('text=bridge 未连接');
  if (await banner.count()) throw new Error('前端降级横幅出现：bridge 未连接');
}

/** output 披露区按需展开（幂等：aria-expanded=true 时不点）。 */
async function expandOutput(page, cellId) {
  const btn = page.locator(`section[data-cell-id="${cellId}"] button[aria-expanded]`);
  if (!(await btn.count())) return;
  if ((await btn.getAttribute('aria-expanded')) === 'false') {
    await btn.click();
    await page.waitForTimeout(250);
  }
}

/** UI ▶ 运行一格并等执行计数徽章出现（首跑含内核冷启动，给足余量）。 */
async function runViaButton(page, cellId, badge, timeoutMs = 90000) {
  await page.locator(`section[data-cell-id="${cellId}"] button[title^="Run cell"]`).click();
  await page.waitForSelector(`section[data-cell-id="${cellId}"] span:text-is("${badge}")`, { timeout: timeoutMs });
}

/** 轮询等选择器计数归零（stale/error 徽章消失、托盘卸载等）。 */
async function waitGone(page, selector, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    if ((await page.locator(selector).count()) === 0) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待消失超时: ${selector}`);
    await page.waitForTimeout(250);
  }
}

async function closeAllTabs(bridge) {
  const list = await bridge.rpc('notebook.list').catch(() => []);
  for (const t of list ?? []) {
    await bridge.rpc('notebook.close', { notebookId: t.notebookId }).catch(() => {});
  }
}

/** 拒绝所有 pending diff（take 间卫生：LLM 尝试失败可能留下已 stage 的 diff）。 */
async function rejectAllPendingDiffs(bridge) {
  try {
    const last = [...bridge.notifications].reverse().find((n) => n.method === 'diff.updated');
    for (const d of last?.params?.diffs ?? []) {
      if (d.status === 'proposed') await bridge.rpc('diff.reject', { diffId: d.diffId }).catch(() => {});
    }
  } catch { /* 忽略 */ }
}

/** 清 stale-live 会话索引残留（同画廊 reconcileStaleSessions，导出卫生）。 */
function reconcileStaleSessions(notebookDir) {
  const idx = join(notebookDir, '.novalab', 'sessions', 'index.json');
  if (!fs.existsSync(idx)) return 0;
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(idx, 'utf8'));
  } catch {
    return 0;
  }
  if (!Array.isArray(entries)) return 0;
  const kept = entries.filter((m) => m && typeof m === 'object' && typeof m.endedAt === 'string');
  const removed = entries.length - kept.length;
  if (removed > 0) {
    fs.writeFileSync(idx, JSON.stringify(kept, null, 2) + '\n', 'utf8');
    log(`已剔除 ${removed} 条 stale-live 会话索引（硬杀 bridge 残留）`);
  }
  return removed;
}

/**
 * 录一条 take：新建带 recordVideo 的 context → run(page) → 关 page/context →
 * page.video().path() 取回 rename 到 dest。run 抛错 = take 作废（视频删除）。
 */
async function recordTake(browser, dest, run) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(join(TMP_DIR, 'take-'));
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: tmp, size: { width: 1440, height: 900 } },
    colorScheme: 'dark',
    deviceScaleFactor: 1,
  });
  context.setDefaultTimeout(20000);
  const page = await context.newPage();
  const video = page.video();
  const t0 = Date.now();
  let ok = false;
  let runError = null;
  try {
    await run(page);
    ok = true;
  } catch (err) {
    runError = err;
    log(`take 失败（${path.basename(dest)}）: ${err.message}`);
  }
  const durMs = Date.now() - t0;
  try { await page.close(); } catch { /* 忽略 */ }
  try { await context.close(); } catch { /* 忽略 */ }
  let src = null;
  try { src = await video?.path(); } catch { /* 忽略 */ }
  if (!ok || !src) {
    fs.rmSync(tmp, { recursive: true, force: true }); // 连同作废视频一起丢弃
    return { ok: false, durMs, err: runError?.message ?? '视频未产出' };
  }
  fs.mkdirSync(dirname(dest), { recursive: true });
  fs.rmSync(dest, { force: true });
  fs.renameSync(src, dest); // 先移走视频，再清临时目录
  fs.rmSync(tmp, { recursive: true, force: true });
  return { ok: true, file: dest, durMs, bytes: fs.statSync(dest).size };
}

/** 镜头外预热：bridge rpc 走一遍 open + 跑首格 + close。
 *  uv 冷启动/首次 pandas import 曾把 take 内首跑拖过 45s（run6 教训）——
 *  预热后录制 take 里内核 spawn/import 全热，视频时间也省给叙事。 */
async function prewarm(bridge, file, firstCellId) {
  try {
    await bridge.rpc('notebook.open', { path: file });
    await bridge.rpc('cell.run', { cellId: firstCellId, cascade: false });
    log(`预热完成：${path.basename(file)}（${firstCellId} 已跑通）`);
  } catch (err) {
    log(`预热 ${path.basename(file)} 失败（非致命，take 内首跑余量已放宽）: ${err.message}`);
  }
  await closeAllTabs(bridge);
}

/* ---------------- LLM 探活（信息性；失败仍先试 LLM take，40s 封顶） ---------------- */

function readLlmEnv() {
  const envPath = join(root, 'app', '.env.local');
  if (!fs.existsSync(envPath)) return null;
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** 经 vite 同源代理 /llm 探一次最小 messages 请求（凭据不回显、不入库）。 */
async function probeLlm() {
  const env = readLlmEnv();
  const key = env?.VITE_NOVALAB_LLM_API_KEY;
  if (!key) return { ok: false, why: 'app/.env.local 缺 VITE_NOVALAB_LLM_API_KEY' };
  const model = env.VITE_NOVALAB_LLM_MODEL || 'qwen3.8-max';
  try {
    const res = await fetch(APP_URL + 'llm/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(20000),
    });
    return { ok: res.ok, why: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e).slice(0, 120) };
  }
}

/* ---------------- reel-d1：P1 全链路 ---------------- */

async function runD1(page, bridge, notes) {
  await openNotebook(page, DEMO_PY);
  await pace(page, 700);

  // ViewSwitcher（Files | Notebook，Q 线 A-3 #23 已挂载）：切一眼文件视图再切回；
  // 未挂载的旧版则跳过（前向兼容）
  const vs = page.locator('div[role="group"][aria-label="视图切换"]');
  if (await vs.count()) {
    await vs.locator('button[title="Files 视图"]').click();
    await page.waitForSelector('[role="treeitem"]', { timeout: 10000 }).catch(() => {});
    await pace(page, 800);
    await vs.locator('button[title="Notebook 视图"]').click();
    await page.waitForSelector('section[data-cell-id="a1b2c3d4"] .cm-editor', { timeout: 15000 });
    await pace(page, 400);
  } else {
    notes.push('d1: ViewSwitcher 未挂载 → 文件视图一眼跳过');
  }

  // 首跑三格（▶ 按钮），逐格展开输出。注意 execCount 是"每格"计数（各格首跑均 [1]，
  // 见画廊 07/15 态对 c3 等 [1] 的断言），不是会话全局序列。
  await runViaButton(page, 'a1b2c3d4', '[1]');
  await expandOutput(page, 'a1b2c3d4');
  await pace(page, 400);
  await runViaButton(page, 'b2c3d4e5', '[1]');
  await expandOutput(page, 'b2c3d4e5');
  await pace(page, 400);
  await runViaButton(page, 'c3d4e5f6', '[1]');
  await expandOutput(page, 'c3d4e5f6');
  await page.waitForSelector('section[data-cell-id="c3d4e5f6"] pre:has-text("max=10.0")', { timeout: 15000 });
  await pace(page, 600);

  // 键入改上游数字：0.9 → 1.9（真实键盘逐字键入，可视化编辑）
  const { code } = await bridge.rpc('agent.cellCode', { cellId: 'a1b2c3d4' });
  if (!code.includes('0.9')) throw new Error('demo.py 缺 0.9（应未被前次运行还原？）');
  const edited = code.replace('0.9', '1.9');
  d1State.originalCode = code;
  const ed = page.locator('section[data-cell-id="a1b2c3d4"] .cm-content');
  await ed.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(edited, { delay: 5 });
  await page.waitForTimeout(800); // 300ms debounce + cell.save 往返 + staleSet 广播

  // 下游两格 stale 灰徽章
  await page.waitForSelector('section[data-cell-id="b2c3d4e5"] span:text-is("stale")', { timeout: 10000 });
  await page.waitForSelector('section[data-cell-id="c3d4e5f6"] span:text-is("stale")', { timeout: 10000 });
  await pace(page, 800); // 灰徽章停留一眼

  // cascade 开关切 auto（Owner 默认 mark-only；演示级联重跑用 UI 开关）
  await page.locator('footer select').selectOption('auto');
  await pace(page, 400);

  // Ctrl+Enter（焦点回编辑器 = activeCell a1）→ 级联转绿 + 输出刷新
  await ed.click();
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('section[data-cell-id="c3d4e5f6"] pre:has-text("max=11.0")', { timeout: 30000 });
  await waitGone(page, 'section[data-cell-id="b2c3d4e5"] span:text-is("stale")', 10000);
  await waitGone(page, 'section[data-cell-id="c3d4e5f6"] span:text-is("stale")', 10000);
  for (const id of ['a1b2c3d4', 'b2c3d4e5', 'c3d4e5f6']) await expandOutput(page, id);
  await pace(page, 800);

  // REPL：df.shape → [repl] cell 回显
  const repl = page.locator('footer input[placeholder^="run code"]');
  await repl.click();
  await repl.fill('df.shape');
  await pace(page, 350);
  await repl.press('Enter');
  await page.waitForSelector('section[data-cell-id="repl"] span:text-is("[repl]")', { timeout: 15000 });
  await expandOutput(page, 'repl');
  await page
    .waitForSelector('section[data-cell-id="repl"] pre:has-text("(4, 3)")', { timeout: 8000 })
    .catch(() => notes.push('d1: repl 回显未断言到 (4, 3)（[repl] 徽章已出现，不中断）'));
  await pace(page, 700);

  // SessionModal → .ipynb 导出（断言落盘）
  await page.locator('button[title^="Session notebook —"]').click();
  const dialog = page.locator('[role="dialog"][aria-label="Session notebook"]');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.locator('section button[aria-expanded]').first().waitFor({ timeout: 15000 });
  await pace(page, 600);
  const status = dialog.locator('footer p[aria-live="polite"]');
  await dialog.locator('footer button:text-is(".ipynb")').click();
  await status.filter({ hasText: '已导出' }).waitFor({ timeout: 20000 }).catch(async () => {
    const txt = (await status.textContent().catch(() => '')) ?? '';
    throw new Error('export.ipynb 未成功，footer 状态: ' + txt);
  });
  const msg = (await status.textContent()) ?? '';
  const m = msg.match(/已导出 (.+?)（(\d+) cells · (\d+) outputs）/);
  if (!m) throw new Error('导出消息格式异常: ' + msg);
  if (!fs.existsSync(m[1])) throw new Error('导出 .ipynb 未落盘: ' + m[1]);
  notes.push(`d1: export.ipynb 落盘 ${path.relative(root, m[1])}（${m[2]} cells · ${m[3]} outputs）`);
  await pace(page, 800); // 导出成功态停留一眼
  await dialog.locator('button[aria-label="关闭"]').click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  await pace(page, 400);
}

/** d1 编辑前的原 cell 码（录毕经 bridge 还原用）。 */
const d1State = { originalCode: null };

/* ---------------- reel-d2：P2 修错闭环 ---------------- */

/** 点修复后等 Agent 产出行内 Diff；LLM 错误横幅/超时 → degrade 抛错。 */
async function waitAgentDiff(page, cellId, capMs) {
  const t0 = Date.now();
  let sawAgent = false;
  for (;;) {
    if (await page.locator('button:text-is("打开设置")').count()) {
      const msg = await page.locator('p.break-all').first().textContent().catch(() => '');
      throw degradeError('LLM 端点不可用: ' + String(msg).slice(0, 160));
    }
    if (!sawAgent && (await page.locator('aside div:text-is("agent")').count())) sawAgent = true;
    const tray = await page.locator('[data-diff-tray]').count();
    const diffUi = await page
      .locator(
        `section[data-cell-id="${cellId}"] .novalab-diff, section[data-cell-id="${cellId}"] textarea[aria-label="insert below preview"]`,
      )
      .count();
    if (tray > 0 && diffUi > 0) return;
    if (Date.now() - t0 > capMs) {
      throw degradeError(sawAgent ? `agent ${capMs / 1000}s 内未产出行内 Diff` : `agent ${capMs / 1000}s 无回复`);
    }
    await page.waitForTimeout(400);
  }
}

async function runD2(page, bridge, mode, notes) {
  await openNotebook(page, ERROR_PY);
  await pace(page, 600);

  // 首格成功（survey 表）→ 次格 KeyError
  await runViaButton(page, 'e1a2b3c4', '[1]');
  await expandOutput(page, 'e1a2b3c4');
  await pace(page, 500);
  await page.locator('section[data-cell-id="e5d6f7a8"] button[title^="Run cell"]').click();

  // error (line 3) 徽章 + 编辑器红行 + traceback + FixCard 浮现
  await page.waitForSelector('section[data-cell-id="e5d6f7a8"] span:text-is("error (line 3)")', { timeout: 30000 });
  await page.waitForSelector('section[data-cell-id="e5d6f7a8"] .cm-line.cm-error-line', { timeout: 10000 });
  await page.waitForSelector('section[data-cell-id="e5d6f7a8"] pre:has-text("KeyError")', { timeout: 10000 });
  await page.waitForSelector('aside button:has-text("修复（traceback")', { timeout: 15000 });
  await pace(page, 800); // 错误全貌 + FixCard 停留一眼

  if (mode === 'llm') {
    // One-click Fix → Agent 流式 → propose_code_change → 行内 Diff
    await page.locator('aside button:has-text("修复（traceback")').click();
    await waitAgentDiff(page, 'e5d6f7a8', AGENT_DIFF_CAP_MS);
  } else {
    // 降级：bridge rpc diff.stage 直接生成同款审阅 UI（FixCard 仍在画面叙事中）
    const res = await bridge.rpc('diff.stage', {
      targetCellId: 'e5d6f7a8',
      action: 'update',
      newCode: FIXED_CODE,
      rationale: 'KeyError：列名 county 不存在 → 改为 city（LLM 不可用，diff.stage 降级路径）',
    });
    if (res.rejected) throw new Error('diff.stage 被编译预检拒绝: ' + JSON.stringify(res.reason));
    await page.waitForSelector('[data-diff-tray] button:has-text("1 pending")', { timeout: 10000 });
    await page.waitForSelector('section[data-cell-id="e5d6f7a8"] .novalab-diff .cm-merge-a', { timeout: 10000 });
    await page.waitForSelector('section[data-cell-id="e5d6f7a8"] .novalab-diff .cm-merge-b', { timeout: 10000 });
  }
  await page.waitForTimeout(1000); // merge chunk 测量周期 → 红绿底色可见
  await pace(page, 700);

  // Tab 采纳：焦点回 body（托盘全局快捷键仅在无输入焦点时接管，不劫持 CM6）
  await page.evaluate(() => {
    const el = document.activeElement;
    if (el instanceof HTMLElement) el.blur();
  });
  await page.waitForTimeout(350);
  await page.keyboard.press('Tab');

  // 自动重跑转绿：error 徽章消失（accept = cell.save + cell.run）+ 托盘归零
  await page.waitForSelector('[data-diff-tray]', { state: 'detached', timeout: 15000 });
  await waitGone(page, 'section[data-cell-id="e5d6f7a8"] span:text-is("error (line 3)")', 30000);
  await page.waitForTimeout(1200); // run.done 落定后再验一次（防运行中瞬时消失）
  if (await page.locator('section[data-cell-id="e5d6f7a8"] span:text-is("error (line 3)")').count()) {
    throw new Error('采纳后重跑仍出错（error 徽章复现）');
  }
  await expandOutput(page, 'e5d6f7a8');
  await page
    .waitForSelector('section[data-cell-id="e5d6f7a8"] pre:has-text("沈阳")', { timeout: 8000 })
    .catch(() => notes.push('d2: 修复后输出未断言到「沈阳」（转绿徽章已验证，不中断）'));
  await pace(page, 800); // 绿态收尾
}

/* ---------------- ffmpeg 探测 + gif 转换 ---------------- */

function hasFfmpeg() {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function toGif(webm) {
  const gif = webm.replace(/\.webm$/, '.gif');
  const r = spawnSync('ffmpeg', ['-y', '-i', webm, '-vf', 'fps=10,scale=960:-1:flags=lanczos', gif], {
    stdio: 'ignore',
  });
  return r.status === 0 && fs.existsSync(gif) ? gif : null;
}

/* ---------------- feature-matrix.md：D 两行 + 计数行（幂等重写） ---------------- */

function matrixLink(res) {
  const rel = (f) => `reels/${path.basename(f)}`;
  return res.gif ? `[${rel(res.gif)}](${rel(res.gif)})（webm 原件 [${rel(res.file)}](${rel(res.file)})）` : `[${rel(res.file)}](${rel(res.file)})`;
}

function updateMatrix(results, notes) {
  let text = fs.readFileSync(MATRIX_MD, 'utf8');
  const lines = text.split('\n');
  const out = [];
  let inserted = false;
  let removed = 0;
  // --reel 单录时保留另一条已有 D 行（仅认拆分格式 `| D1 `/`| D2 `；旧合并行作废）
  const keptOld = { d1: null, d2: null };
  for (const line of lines) {
    if (/^\| D1 /.test(line)) keptOld.d1 = line;
    if (/^\| D2 /.test(line)) keptOld.d2 = line;
  }
  for (const line of lines) {
    // 旧 D 行（合并式或已拆分）一律移除，由新行/保留行替换
    if (/^\| D1(\/D2)? /.test(line) || /^\| D2 /.test(line)) {
      removed++;
      continue;
    }
    if (/^> 计数：/.test(line)) continue; // 计数行最后统一重算插入
    out.push(line);
    if (!inserted && /^\| P2\.9 /.test(line)) {
      const d1Row = results.d1
        ? `| D1 阶段演示录屏（P1 全链路 reel） | plan D1 | ${results.d1.degraded ? '✅（降级路径）' : '✅'} | ${matrixLink(results.d1)}（${(results.d1.durMs / 1000).toFixed(0)}s · open→首跑→键入改数→stale 灰徽章→cascade 转绿→REPL [repl] 回显→SessionModal .ipynb 导出落盘；node scripts/demo-reels.mjs 产出） |`
        : keptOld.d1;
      const d2Row = results.d2
        ? `| D2 阶段演示录屏（P2 修错闭环 reel） | plan D2 | ${results.d2.degraded ? '✅（LLM 降级：diff.stage→Tab）' : '✅'} | ${matrixLink(results.d2)}（${(results.d2.durMs / 1000).toFixed(0)}s · 运行出错 error 徽章/红行/traceback/FixCard→${results.d2.degraded ? 'bridge rpc diff.stage（LLM 不可用降级）' : '点修复→Agent 流式→propose_code_change'}→行内 Diff 红绿→Tab 采纳→自动重跑转绿→托盘归零） |`
        : keptOld.d2;
      if (d1Row) out.push(d1Row);
      if (d2Row) out.push(d2Row);
      inserted = true;
    }
  }
  if (!inserted) throw new Error('feature-matrix.md 未找到 P2.9 锚点行，拒绝盲改');

  // 计数行重算：主表 = 各表状态列（第 3 格）以 ✅/🟡/⛔ 开头的行
  // （split 用未转义竖线切分——A-3 #23 行证据列含 `Files \| Notebook`）
  let ok = 0, part = 0, block = 0;
  for (const line of out) {
    if (!line.startsWith('|')) continue;
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
    const st = cells[3] ?? '';
    if (st.startsWith('✅')) ok++;
    else if (st.startsWith('🟡')) part++;
    else if (st.startsWith('⛔')) block++;
  }
  const total = ok + part + block;
  const countLine = `> 计数：主表 ${total} 行 = ✅ ${ok} · 🟡 ${part} · ⛔ ${block}。（D 线录屏闭环：D1/D2 拆为两行并 ⛔→✅，产物 docs/demos/reels/，node scripts/demo-reels.mjs 幂等重录）`;
  // 计数行插回原位置（判据行之后）
  const critIdx = out.findIndex((l) => l.startsWith('> 判据：'));
  if (critIdx >= 0) out.splice(critIdx + 1, 0, countLine);
  else out.splice(0, 0, countLine);

  fs.writeFileSync(MATRIX_MD, out.join('\n'), 'utf8');
  notes.push(`matrix: D 行重写（移除旧行 ${removed}）+ 计数行 → 主表 ${total} 行 = ✅${ok} · 🟡${part} · ⛔${block}`);
}

/* ---------------- 主流程 ---------------- */

async function main() {
  fs.mkdirSync(REELS_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const d1Name = `reel-d1-${date}.webm`;
  const d2Name = `reel-d2-${date}.webm`;
  const notes = [];

  // dev 服务：已在跑就复用；没跑就自起（退出前自停）；僵尸端口自动兜底
  const bridgeState = await discoverBridge().catch(() => null);
  if (bridgeState) log(`bridge 已在跑（:${bridgeState.wsPort}）→ 复用`);
  else { log('bridge 未跑 → 自起 pnpm dev:bridge'); startDev(['dev:bridge'], 'dev:bridge'); }
  await ensureApp();

  const bridge = new BridgeClient();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await bridge.connect();
      break;
    } catch (err) {
      if (attempt === 59) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await bridge.rpc('ping');
  log('bridge 已连接', `:${bridge.info.wsPort}`);
  await closeAllTabs(bridge);
  reconcileStaleSessions(DEMOS);
  fs.writeFileSync(ERROR_PY, ERROR_FIXTURE); // 夹具先落盘（预热/d2 take 共用）
  if (!ONLY_REEL || ONLY_REEL === 'd1') await prewarm(bridge, DEMO_PY, 'a1b2c3d4');
  if (!ONLY_REEL || ONLY_REEL === 'd2') await prewarm(bridge, ERROR_PY, 'e1a2b3c4');

  const browser = await chromium.launch({ headless: true });
  const results = {};
  const failures = [];

  try {
    /* ---- reel-d1 ---- */
    if (!ONLY_REEL || ONLY_REEL === 'd1') {
      const demoOriginal = fs.readFileSync(DEMO_PY, 'utf8');
      d1State.originalCode = null;
      const dest = join(REELS_DIR, d1Name);
      const res = await recordTake(browser, dest, (page) => runD1(page, bridge, notes));
      // 录毕还原 demo.py：bridge cell.save 原码 → closeAllTabs 落盘 → 字节级兜底
      try {
        if (d1State.originalCode) {
          await bridge.rpc('cell.save', { cellId: 'a1b2c3d4', code: d1State.originalCode }).catch(() => {});
        }
        await closeAllTabs(bridge);
      } catch { /* 忽略 */ }
      if (fs.readFileSync(DEMO_PY, 'utf8') !== demoOriginal) {
        fs.writeFileSync(DEMO_PY, demoOriginal);
        log('demo.py 已按启动快照兜底还原');
      }
      if (!res.ok) failures.push(`d1 take 失败: ${res.err ?? '未知'}`);
      else {
        results.d1 = res;
        log(`✔ ${d1Name} ${(res.durMs / 1000).toFixed(1)}s ${(res.bytes / 1024).toFixed(0)}KB`);
      }
    }

    /* ---- reel-d2（LLM 优先；失败废弃 take 降级重录） ---- */
    if (!ONLY_REEL || ONLY_REEL === 'd2') {
      const probe = await probeLlm();
      log(`LLM 探活（/llm/v1/messages）：${probe.ok ? 'OK' : '不通'} — ${probe.why}`);
      if (!probe.ok) notes.push(`d2: LLM 探活 ${probe.why}（仍先试 LLM take，失败即降级）`);

      const prepare = async () => {
        await rejectAllPendingDiffs(bridge);
        await closeAllTabs(bridge);
        fs.writeFileSync(ERROR_PY, ERROR_FIXTURE);
      };

      const dest = join(REELS_DIR, d2Name);
      let res = null;
      let mode = FORCE_STAGE ? 'stage' : 'llm';
      if (mode === 'llm') {
        await prepare();
        res = await recordTake(browser, dest, (page) => runD2(page, bridge, 'llm', notes));
        if (!res.ok) {
          notes.push(`d2: LLM 路径 take 失败（${res.err ?? '未知'}）→ 降级重录（手动 diff.stage rpc → Tab 采纳）`);
          res = null;
          mode = 'stage';
        }
      }
      if (!res) {
        await prepare();
        res = await recordTake(browser, dest, (page) => runD2(page, bridge, 'stage', notes));
        if (!res.ok) failures.push(`d2 take 失败（LLM 与降级路径均未录成）: ${res.err ?? '未知'}`);
      }
      if (res?.ok) {
        results.d2 = { ...res, degraded: mode === 'stage' };
        log(`✔ ${d2Name}（${mode}）${(res.durMs / 1000).toFixed(1)}s ${(res.bytes / 1024).toFixed(0)}KB`);
      }
      // 收尾卫生：拒绝残留 diff、正规关闭会话（persist 会把已采纳修复写盘），
      // 之后按夹具重写 gallery-error.py → 工作树相对 HEAD 干净（幂等承诺）
      await rejectAllPendingDiffs(bridge);
      await closeAllTabs(bridge);
      fs.writeFileSync(ERROR_PY, ERROR_FIXTURE);
    }
  } finally {
    await browser.close();
    bridge.close();
  }

  /* ---- gif 转换（有 ffmpeg 才转） ---- */
  const ffmpeg = hasFfmpeg();
  log(ffmpeg ? 'ffmpeg 可用 → 转 gif（fps 10、宽 960）' : 'ffmpeg 不可用 → 跳过 gif（矩阵挂 webm）');
  for (const key of ['d1', 'd2']) {
    const r = results[key];
    if (!r) continue;
    r.gif = ffmpeg ? toGif(r.file) : null;
    if (ffmpeg && !r.gif) notes.push(`${key}: ffmpeg 转换失败 → 矩阵仅挂 webm`);
  }

  /* ---- 旧日期 reel 清理（新文件确认落盘后才删，防矩阵链接悬空） ---- */
  for (const key of ['d1', 'd2']) {
    const r = results[key];
    if (!r) continue;
    for (const f of fs.readdirSync(REELS_DIR)) {
      const full = join(REELS_DIR, f);
      if (!fs.statSync(full).isFile()) continue;
      if (!new RegExp(`^reel-${key}-.+\\.(webm|gif)$`).test(f)) continue;
      if (full === r.file || full === r.gif) continue;
      fs.rmSync(full, { force: true });
      log(`清理旧 reel：${f}`);
    }
  }

  /* ---- 验证 + 矩阵更新 ---- */
  for (const key of ['d1', 'd2']) {
    const r = results[key];
    if (!r) continue;
    if (!fs.existsSync(r.file) || r.bytes <= MIN_BYTES) {
      failures.push(`${key}: reel 文件缺失或 ≤100KB（${r.bytes} bytes）`);
    }
    if (r.durMs > REEL_CAP_MS) {
      failures.push(`${key}: 时长 ${(r.durMs / 1000).toFixed(1)}s 超 75s 上限`);
    }
  }
  if (Object.keys(results).length > 0 && failures.length === 0) {
    updateMatrix(results, notes);
  } else if (Object.keys(results).length > 0) {
    // 部分成功：仍更新成功条目对应的行（矩阵两行按 results 有无生成）
    try { updateMatrix(results, notes); } catch (e) { failures.push('matrix 更新失败: ' + e.message); }
  }

  /* ---- 汇总 ---- */
  console.log('\n==== D 线录屏清单 ====');
  for (const key of ['d1', 'd2']) {
    const r = results[key];
    if (!r) { console.log(`reel-${key}: 未录${failures.length ? '（见失败列表）' : '（--reel 过滤）'}`); continue; }
    console.log(
      `docs/demos/reels/${path.basename(r.file)}  ${(r.durMs / 1000).toFixed(1)}s  ${(r.bytes / 1024).toFixed(0)}KB` +
      (key === 'd2' ? `  mode=${r.degraded ? 'stage(降级)' : 'llm'}` : '') +
      (r.gif ? `  gif=docs/demos/reels/${path.basename(r.gif)}` : ''),
    );
  }
  if (notes.length > 0) {
    console.log('\n==== 运行备注 ====');
    for (const n of notes) console.log('- ' + n);
  }
  if (failures.length > 0) {
    console.log('\n==== 失败 ====');
    for (const f of failures) console.log('- ' + f);
  }
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  killStartedServers();
  process.exit(failures.length > 0 ? 1 : 0);
}

process.on('exit', killStartedServers);
process.on('SIGINT', () => {
  killStartedServers();
  process.exit(130);
});

main().catch((err) => {
  console.error('REELS_FATAL:', err);
  killStartedServers();
  process.exit(2);
});
