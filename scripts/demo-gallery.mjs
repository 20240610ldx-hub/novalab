/**
 * L 线：交互状态画廊 —— 真机证据截图（docs/demos/states/*.png）。
 *
 * 用法（仓库根；dev 服务已在跑就复用，没跑就自起自停）：
 *   node scripts/demo-gallery.mjs [--skip-agent] [状态前缀过滤，如 03 11]
 *   （自起 = pnpm dev:bridge ws://127.0.0.1:7788 + pnpm dev:app
 *     http://localhost:5199 (strictPort)；脚本退出前 taskkill 整树，
 *     复用的既有服务不动。）
 *
 * 产出：每态一张 fullPage png（暗色、viewport 1440x900；主列为内部滚动，
 * 内容溢出时临时增高视口拍全后还原——fullPage 对本布局才有意义）。
 *
 * 幂等性：
 * - demos/gallery-*.py 夹具每次运行重写（含 P3.3 控件夹具 gallery-controls.py）；
 * - demos/demo.py 的任何编辑（02 态 0.9↔1.9 toggle，与 integration-smoke 同款）
 *   先经 UI cell.save 还原、脚本结束再按启动时快照字节级兜底还原；
 * - demos/.novalab 残留（sessions/ui.json、15 态导出 .ipynb 与回转 .py——文件名
 *   含会话 id，逐次运行不冲突）容忍，不清理；
 * - 09 态新建的 demos/gallery-created.py 允许存在（fs.writeFile 覆盖写）；
 * - P3.1 多 tab 语境下 bridge 上下文跨状态存活：每个自开新页的状态先
 *   closeAllTabs（notebook.list → notebook.close）保证单 tab 干净截图。
 *
 * 前置校验：bridge ping + vite HTTP 200，任一不就绪立即退出并提示。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'bridge', 'package.json'));
const { WebSocket } = require('ws');

const DEMOS = join(root, 'demos');
const STATES_DIR = join(root, 'docs', 'demos', 'states');
// Q 线：5199 可能被跨线残留的失响应监听器占住（TCP hang / bind EADDRINUSE 但无
// 健康 HTTP），且多线并发跑本脚本会竞抢同一备用端口——备用端口按 pid 抖动 +
// 空闲扫描选取，保证本 run 独占。
const APP_PORT_DEFAULT = 5199;
let APP_PORT = APP_PORT_DEFAULT;
let APP_URL = `http://127.0.0.1:${APP_PORT}/`;
const BRIDGE_URL = 'ws://127.0.0.1:7788';

/** bind 试探（唯一与 vite bind 同语义的探测）：跨线残留的坏 IPv6 监听器
 * （Get-NetTCPConnection 里 State 为空、netstat 不可见、connect 立即 RST）
 * 只能靠真 bind 暴露。双族皆可 bind 才视为空闲。 */
function tryBind(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen({ port, host }, () => {
      s.close(() => resolve(true));
    });
  });
}

/** 备用端口候选：pid 抖动起点 + 步进扫描，双族 bind 皆成功者中选。 */
async function pickFreeAppPort() {
  const base = 5299 + (process.pid % 4) * 100;
  for (let i = 0; i < 8; i++) {
    const p = base + i * 7;
    if ((await tryBind(p, '::1')) && (await tryBind(p, '127.0.0.1'))) return p;
  }
  return base + 999; // 全占的极端情况：直接试，失败 loudly
}

const DEMO_PY = join(DEMOS, 'demo.py');
const ERROR_PY = join(DEMOS, 'gallery-error.py');
const WRITE_PY = join(DEMOS, 'gallery-write.py');
const CONTROLS_PY = join(DEMOS, 'gallery-controls.py');

const argv = process.argv.slice(2);
const SKIP_AGENT = argv.includes('--skip-agent');
const ONLY = argv.filter((a) => !a.startsWith('--'));

/* ---------------- 夹具（每次重写 → 幂等） ---------------- */

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

const WRITE_FIXTURE = `# /// script
# requires-python = ">=3.11"
# dependencies = ["pandas", "matplotlib"]
# ///
# [novalab] width=compact | app_view=false | kernel_python="3.13"

# %% [cell-id: d1e2f3a4]
import pandas as pd

temps = pd.DataFrame(
    {
        "day": [1, 2, 3, 4, 5],
        "celsius": [18.2, 19.4, 17.8, 20.1, 21.3],
    }
)
temps

# %% [cell-id: d5e6f7a8]
import os
import tempfile

out_csv = os.path.join(tempfile.gettempdir(), "novalab-gallery-temps.csv")
temps.to_csv(out_csv, index=False)
print(f"rows={len(temps)}")

# %% [cell-id: d9e0f1a2]
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

plt.plot(temps["day"], temps["celsius"], marker="o")
plt.title("daily temperature (gallery fixture)")
plt.xlabel("day")
plt.ylabel("celsius")
`;

/* P3.3 控件夹具（14 态）：slider(阈值) + checkbox(normalize) 定义格 +
 * 引用 .value 的下游计算格（control.set → DAG 级联重跑，spec §15.3）。 */
const CONTROLS_FIXTURE = `# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# [novalab] width=compact | app_view=false | kernel_python="3.13"

# %% [cell-id: f1a2b3c4]
from novakernel import ui

threshold = ui.slider(0, 100, value=42, label="阈值")
normalize = ui.checkbox(True)

# %% [cell-id: f5e6f7a8]
scores = [12, 37, 45, 58, 63, 71, 88, 94]
passed = [x for x in scores if x <= threshold.value]
total = sum(passed)
mode = "normalize" if normalize.value else "raw"
print(f"threshold={threshold.value} mode={mode} passed_n={len(passed)} total={total}")
`;

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

/**
 * TCP 探测三态（1.2s 超时）：
 * - 'up'：连接成功（服务在跑）；
 * - 'free'：立即 RST（端口真空闲，可 bind）；
 * - 'hung'：连接挂到超时 = 端口被占但 accept 队列满/进程失响应（跨线残留
 *   僵尸监听器的特征）——此时任何 vite bind 都会 strictPort 冲突，必须换端口。
 */
function probePortState(port, timeoutMs = 1200, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let done = false;
    const finish = (st) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(st);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish('up'));
    s.once('error', () => finish('free'));
    s.once('timeout', () => finish('hung'));
  });
}

/** HTTP 健康探测（TCP LISTEN ≠ 能服务：跨线残留进程可能占端口但不响应）。 */
async function probeHttp(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
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

/** spawn pnpm <args>（shell:true；输出环形缓存，早退时打印尾部供诊断）。 */
function startDevPnpm(args, name) {
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
      console.error(`[gallery] ${name} 早退 code=${code}，输出尾部:\n` + tail.join('\n'));
    }
  });
  startedServers.push({ child, name });
  return child;
}

/** spawn pnpm <script>（默认端口复用路径）。 */
function startDev(script) {
  return startDevPnpm([script], script);
}

/** 备用端口自起 vite：pnpm exec 直传参数（双层 pnpm run 会吞/字面化 `--` 分隔）。 */
function startDevAppOn(port) {
  return startDevPnpm(
    ['--filter', '@novalab/app', 'exec', 'vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    `dev:app@${port}`,
  );
}

/* ---------------- bridge WS 客户端（setup 用） ---------------- */

class BridgeClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const tryConnect = (n) => {
        const s = new WebSocket(this.url);
        s.on('open', () => {
          this.ws = s;
          s.on('message', (raw) => this._dispatch(raw));
          resolve();
        });
        s.on('error', () =>
          n > 60 ? reject(new Error('bridge 未就绪: ' + this.url)) : setTimeout(() => tryConnect(n + 1), 500),
        );
      };
      tryConnect(0);
    });
  }

  _dispatch(raw) {
    const msg = JSON.parse(String(raw));
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) this.notifications.push({ method: msg.method, params: msg.params ?? null });
  }

  rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** 从 mark（notifications.length 快照）之后等待满足 pred 的通知。 */
  async waitNotif(method, pred = () => true, timeoutMs = 20000, mark = 0) {
    const t0 = Date.now();
    for (;;) {
      for (let i = mark; i < this.notifications.length; i++) {
        const n = this.notifications[i];
        if (n.method === method && pred(n.params)) return n;
      }
      if (Date.now() - t0 > timeoutMs) throw new Error(`等待通知超时: ${method}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
  }
}

/* ---------------- 通用 UI 助手 ---------------- */

const log = (...a) => console.log('[gallery]', ...a);

async function openNotebook(page, file) {
  // Q 线 A-3 #23：视图切换持久化于 localStorage（跨页共享 context）——强制
  // notebook 视图再导航，防止前序状态（09 Files 视图）残留导致 cell 选择器落空。
  await page.addInitScript(() => {
    try {
      localStorage.setItem('novalab.view', 'notebook');
      // CI/新鲜 profile 无 onboarded flag → 首启引导模态拦截一切点击（ubuntu CI 14 态超时根因）
      localStorage.setItem('novalab.onboarded', '1');
    } catch {
      /* 忽略 */
    }
  });
  await page.goto(APP_URL + '?path=' + encodeURIComponent(file), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('section[data-cell-id]', { timeout: 40000 });
  const banner = page.locator('text=bridge 未连接');
  if (await banner.count()) throw new Error('前端降级横幅出现：bridge 未连接');
}

/** 主题直达（A-4）：localStorage + html[data-theme]（模态遮罩挡住 toggle 钮时用）。 */
async function setTheme(page, theme) {
  await page.evaluate((t) => {
    try {
      localStorage.setItem('novalab.theme', t);
    } catch {
      /* 忽略 */
    }
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(250);
}

/** A-4 浅色证据：切浅色（优先真点 header toggle 钮）→ 拍 <name>-light → 切回暗色。 */
async function shootLight(page, name) {
  const toggle = page.locator('button[aria-label="toggle theme"]');
  if (await toggle.count()) {
    await toggle.click();
    await page.waitForTimeout(300);
  } else {
    await setTheme(page, 'light');
  }
  await shoot(page, `${name}-light`);
  if (await toggle.count()) {
    await toggle.click();
    await page.waitForTimeout(200);
  } else {
    await setTheme(page, 'dark');
  }
}

/** 主列内部滚动 → 溢出时临时增高视口，fullPage 拍全后还原 1440x900。
 *  选择器限 main 直接子级：SessionModal（15 态）主体同为 .flex-1.overflow-y-auto
 *  且 DOM 上嵌在 main 内，不限定会 strict-mode 冲突。 */
async function shoot(page, name) {
  const scroller = page.locator('main > div.flex-1.overflow-y-auto').first();
  if (await scroller.count()) {
    for (let pass = 0; pass < 2; pass++) {
      const extra = await scroller.evaluate((el) => Math.max(0, el.scrollHeight - el.clientHeight));
      if (extra <= 0) break;
      const vp = page.viewportSize();
      await page.setViewportSize({ width: vp.width, height: vp.height + extra });
      await page.waitForTimeout(450); // 窗口化编辑器随视口重挂载
    }
  }
  const out = join(STATES_DIR, `${name}.png`);
  await page.screenshot({ path: out, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(250);
  log(`📸 ${out}`);
  return out;
}

/** output 披露区按需展开（幂等：aria-expanded=true 时不点）。 */
async function expandOutput(page, cellId) {
  const btn = page.locator(`section[data-cell-id="${cellId}"] button[aria-expanded]`);
  if (!(await btn.count())) return;
  if ((await btn.getAttribute('aria-expanded')) === 'false') {
    await btn.click();
    await page.waitForTimeout(200);
  }
}

/** UI 内改 cell 代码（= 前端 debounce → cell.save rpc → 落盘）。 */
async function editCell(page, cellId, code) {
  const ed = page.locator(`section[data-cell-id="${cellId}"] .cm-content`);
  await ed.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(code);
  await page.waitForTimeout(500); // 300ms debounce + cell.save 往返 + 落盘
}

async function runCellWs(bridge, cellId) {
  const rep = await bridge.rpc('cell.run', { cellId, cascade: false });
  return rep;
}

/* ---------------- P3 多 tab / inspector / 控件助手 ---------------- */

/** 关光 bridge 侧全部已打开 notebook（P3.1 上下文跨状态存活 → 每态干净起点）。 */
async function closeAllTabs(bridge) {
  const list = await bridge.rpc('notebook.list').catch(() => []);
  for (const t of list ?? []) {
    await bridge.rpc('notebook.close', { notebookId: t.notebookId }).catch(() => {});
  }
}

/**
 * 清 stale-live 会话索引（画廊卫生，15 态前置）：bridge 被硬杀（taskkill/崩溃/
 * Ctrl-C）时 index.json 留下未 ended 的 live 条目——它们无 snapshot、UI 打不开，
 * 却会被前端 refreshSessions 的 find(首个 live) 抢成 currentId，export.ipynb 随即
 * 报 unknown sessionId。调用前提：已 closeAllTabs（活着的会话都已正规 ended），
 * 此刻索引中任何无 endedAt 的条目必为死进程残留，剔除安全。
 */
function reconcileStaleSessions(notebookDir) {
  const idx = join(notebookDir, '.novalab', 'sessions', 'index.json');
  if (!fs.existsSync(idx)) return 0;
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(idx, 'utf8'));
  } catch {
    return 0; // 损坏索引 bridge 侧本就宽容为空，不动
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

/** 等 TabBar tab 数 ≥ n（新 tab = 内核 spawn，uv 冷/热启动给足余量）。 */
async function waitTabs(page, n, timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    const c = await page.locator('[role="tab"]').count();
    if (c >= n) return c;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待 TabBar ${n} 个 tab 超时（现 ${c}）`);
    await page.waitForTimeout(300);
  }
}

/** TabBar「+」→ 路径输入 → Enter（= 前端 notebook.open，新内核并行保活）。 */
async function addTab(page, file) {
  await page.locator('button[aria-label="new tab"]').click();
  const input = page.locator('input[placeholder="path/to/notebook.py"]');
  await input.waitFor({ timeout: 5000 });
  await input.fill(file);
  await input.press('Enter');
}

/**
 * 状态栏 ⠿ 把手「双击」展开 inspector（P3.2）。dragStore 判定 = 两次
 * pointerdown 间隔 <350ms 且无真拖动；playwright dblclick 的间隔不受控，
 * 故直接连发两次 dispatchEvent('pointerdown')（同一 tick，确定性 <350ms）。
 */
async function openInspectorViaHandle(page) {
  const handle = page.locator('span[title^="drag to expand variable inspector"]');
  await handle.waitFor({ timeout: 10000 });
  const box = await handle.boundingBox();
  const clientY = box ? box.y + box.height / 2 : 0;
  await handle.dispatchEvent('pointerdown', { clientY });
  await handle.dispatchEvent('pointerdown', { clientY });
  await page.waitForSelector('section[data-testid="inspector"]', { timeout: 10000 });
}

/**
 * UI 事件设 slider 值：先试 playwright fill；range input 不支持时退化为
 * 原生 value setter + bubbling input 事件（React onChange 合成路径）。
 * 两者都走控件 80ms 节流 → control.set → 内核 mutate + DAG 级联。
 */
async function setRangeValue(locator, value) {
  try {
    await locator.fill(String(value));
  } catch {
    await locator.evaluate((el, v) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, String(value));
  }
}

/* ---------------- 状态实现 ---------------- */

const states = [];
function state(id, name, fn, opts = {}) {
  states.push({ id, name, fn, optional: opts.optional ?? false, keepsPage: opts.keepsPage ?? false });
}

state('01', '01-open-idle', async (ctx) => {
  await closeAllTabs(ctx.bridge);
  const page = await ctx.newPage();
  await openNotebook(page, DEMO_PY);
  await page.waitForSelector('section[data-cell-id="a1b2c3d4"] .cm-editor', { timeout: 15000 });
  // A-3 #23：顶栏分段控件 Files ↔ Notebook（rail 已移除，文件树在全幅 Files 视图）
  await page.locator('button[title="Files 视图"]').click();
  await page.waitForSelector('[role="tree"][aria-label="workspace files"] [role="treeitem"]', {
    timeout: 15000,
  });
  await page.locator('button[title="Notebook 视图"]').click();
  await page.waitForSelector('section[data-cell-id="a1b2c3d4"] .cm-editor', { timeout: 15000 });
  // A-3 #19：JetBrains Mono 真正加载（fontsource 打包，document.fonts 断言）
  const fontOk = await page.evaluate(async () => {
    // 冷启动竞态：check 前显式 load + ready（Q 线本地过是暖缓存运气，CI 必红）
    await document.fonts.load('13px "JetBrains Mono"');
    await document.fonts.ready;
    return document.fonts.check('13px "JetBrains Mono"');
  });
  if (!fontOk) throw new Error('JetBrains Mono 未生效（document.fonts.check false）');
  // A-3 #21：代码区复制按钮 → 点击 → clipboard 读回与内核代码一致
  await ctx.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('section[data-cell-id="a1b2c3d4"] .cm-content').hover();
  const copyBtn = page.locator('section[data-cell-id="a1b2c3d4"] button[aria-label="copy code"]');
  await copyBtn.waitFor({ timeout: 5000 });
  await copyBtn.click();
  await page.waitForTimeout(250);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const cellCode = await ctx.bridge.rpc('agent.cellCode', { cellId: 'a1b2c3d4' });
  // CRLF 归一：文件落盘 CRLF / CM6 文档 LF 的换行差异不算读回不一致
  const norm = (s) => String(s).replace(/\r\n/g, '\n');
  if (norm(clip) !== norm(cellCode.code)) {
    throw new Error('复制钮 clipboard 读回不一致: ' + String(clip).slice(0, 60));
  }
  ctx.notes.push('01: #19 JetBrains Mono fonts.check=true；#21 复制钮 clipboard 读回一致');
  await shoot(page, '01-open-idle');
  await shootLight(page, '01-open-idle'); // A-4 浅色证据
  await page.close();
});

state('02', '02-stale', async (ctx) => {
  const { bridge } = ctx;
  await closeAllTabs(bridge);
  const original = fs.readFileSync(DEMO_PY, 'utf8');
  const page = await ctx.newPage();
  await openNotebook(page, DEMO_PY);

  // 先跑全部 cell（run.* 广播 → 前端执行计数/输出就绪）
  for (const id of ['a1b2c3d4', 'b2c3d4e5', 'c3d4e5f6']) {
    const rep = await runCellWs(bridge, id);
    if (!rep.ok) throw new Error(`run ${id} 失败: ${JSON.stringify(rep)}`);
  }
  await page.waitForSelector('section[data-cell-id="c3d4e5f6"] button[aria-expanded]', { timeout: 15000 });
  await expandOutput(page, 'c3d4e5f6');

  // UI 编辑上游 cell（0.9↔1.9 toggle，语义与 integration-smoke 一致）→ cell.save
  const { code } = await bridge.rpc('agent.cellCode', { cellId: 'a1b2c3d4' });
  const edited = code.includes('0.9') ? code.replace('0.9', '1.9') : code.replace('1.9', '0.9');
  if (edited === code) throw new Error('demo.py 缺少可 toggle 的 pop 值（0.9/1.9）');
  await editCell(page, 'a1b2c3d4', edited);

  // 下游两格 stale 灰徽章
  await page.waitForSelector('section[data-cell-id="b2c3d4e5"] span:text-is("stale")', { timeout: 10000 });
  await page.waitForSelector('section[data-cell-id="c3d4e5f6"] span:text-is("stale")', { timeout: 10000 });
  await shoot(page, '02-stale');

  // 还原（UI 通道，保证 bridge 缓存与磁盘一致）
  await editCell(page, 'a1b2c3d4', code);
  const t0 = Date.now();
  for (;;) {
    const cur = fs.readFileSync(DEMO_PY, 'utf8');
    if (cur.includes('0.9') && !cur.includes('1.9')) break;
    if (Date.now() - t0 > 10000) throw new Error('demo.py 还原超时（仍为 toggle 后内容）');
    await new Promise((r) => setTimeout(r, 300));
  }
  ctx.demoOriginal = original;
  await page.close();
});

state('03', '03-error-fixcard', async (ctx) => {
  const { bridge } = ctx;
  await closeAllTabs(bridge);
  const page = await ctx.newPage();
  await openNotebook(page, ERROR_PY);

  const r1 = await runCellWs(bridge, 'e1a2b3c4');
  if (!r1.ok) throw new Error('gallery-error 第一格应成功: ' + JSON.stringify(r1));
  const r2 = await runCellWs(bridge, 'e5d6f7a8');
  if (r2.ok) throw new Error('gallery-error 第二格应抛 KeyError');

  // error (line 3) 徽章 + 编辑器红行 + traceback 面板 + 右侧 FixCard
  await page.waitForSelector('section[data-cell-id="e5d6f7a8"] span:text-is("error (line 3)")', {
    timeout: 15000,
  });
  await page.waitForSelector('section[data-cell-id="e5d6f7a8"] .cm-line.cm-error-line', { timeout: 15000 });
  await page.waitForSelector('section[data-cell-id="e5d6f7a8"] pre:has-text("KeyError")', { timeout: 15000 });
  await page.waitForSelector('aside span:text-is("run.error")', { timeout: 15000 });
  await page.waitForSelector('aside button:has-text("修复（traceback")', { timeout: 15000 });
  await shoot(page, '03-error-fixcard');
  await shootLight(page, '03-error-fixcard'); // A-4 浅色证据（切回暗色后再交给 11）
  ctx.errorPage = page; // 交给紧随其后的 11（agent-stream）复用——必须赶在后续状态
  // 重新 notebook.open 之前：bridge 的 cache 还是 gallery-error.py，Agent 工具
  // （get_cell_output/propose_code_change）才能按 cellId 命中正确 notebook。
});

state(
  '11',
  '11-agent-stream',
  async (ctx) => {
    const page = ctx.errorPage;
    if (!page) throw new Error('依赖 03 态页面（error + FixCard），03 未成功');
    await page.locator('aside button:has-text("修复（traceback")').click();

    // 等待 agent 消息（流式）或降级错误横幅
    await page
      .waitForSelector('div:text-is("agent"), button:text-is("打开设置")', { timeout: 75000 })
      .catch(() => {});
    const failed = await page.locator('button:text-is("打开设置")').count();
    const streaming = await page.locator('div:text-is("agent")').count();
    if (!streaming && failed) {
      const msg = await page
        .locator('p.break-all')
        .first()
        .textContent()
        .catch(() => '');
      // 降级证据固定命名留存（不参与 fail-* 清理）：LLM 离线/被 CORS 拦截时的横幅 UX
      await shoot(page, '11-agent-stream-degraded').catch(() => {});
      throw Object.assign(new Error('LLM 端点不可用（降级跳过）: ' + String(msg).slice(0, 200)), {
        degrade: true,
      });
    }
    if (!streaming) throw Object.assign(new Error('未等到 agent 回复（降级跳过）'), { degrade: true });
    await page.waitForTimeout(2500); // 让工具调用部件/流式文本渲染出来
    await shoot(page, '11-agent-stream');
    await page.close();
    ctx.errorPage = null;
  },
  { optional: true },
);

state('04', '04-diff-staged', async (ctx) => {
  const { bridge } = ctx;
  await closeAllTabs(bridge);
  const page = await ctx.newPage();
  await openNotebook(page, DEMO_PY);

  const newCode = [
    'total = df.groupby("county")["pop"].sum().round(1)',
    'total.name = "pop_total"',
    'total',
  ].join('\n');
  const res = await bridge.rpc('diff.stage', {
    targetCellId: 'b2c3d4e5',
    action: 'update',
    newCode,
    rationale: '画廊演示：聚合结果保留 1 位小数并命名系列',
  });
  if (res.rejected) throw new Error('diff.stage 被编译预检拒绝: ' + JSON.stringify(res.reason));

  // 顶栏 N pending 托盘 + 行内 MergeView 红绿
  await page.waitForSelector('[data-diff-tray] button:has-text("1 pending")', { timeout: 15000 });
  await page.waitForSelector('section[data-cell-id="b2c3d4e5"] .novalab-diff .cm-merge-a', { timeout: 15000 });
  await page.waitForSelector('section[data-cell-id="b2c3d4e5"] .novalab-diff .cm-merge-b', { timeout: 15000 });
  await page.waitForTimeout(900); // merge chunk 测量周期 → 红绿底色
  await shoot(page, '04-diff-staged');

  await bridge.rpc('diff.reject', { diffId: res.diffId });
  await page.close();
});

state('05', '05-ask-dialog', async (ctx) => {
  const { bridge } = ctx;
  await closeAllTabs(bridge);
  const page = await ctx.newPage();
  await openNotebook(page, WRITE_PY);

  // cascade 策略切 ask
  await page.locator('footer select').selectOption('ask');
  // UI 运行有下游的 cell（前端 runCell 才会走 ask 决策）
  await page.locator('section[data-cell-id="d1e2f3a4"] button[title^="Run cell"]').click();

  const dialog = page.locator('[role="dialog"][aria-label="cascade 确认"]');
  await dialog.waitFor({ timeout: 15000 });
  // d5（to_csv）应带 ⚡ side-effect 徽章——已知遗留 bug：bridge normalizeCells
  // 丢弃内核上报的 sideEffect（spec §6.2 契约含该字段），徽章恒不显示。
  // 软等待：出现与否都截图（弹窗本体 = P2.4 ask 档证据），结果记入 notes。
  const badgeShown = await dialog
    .locator('text=⚡ side-effect')
    .first()
    .waitFor({ timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  ctx.notes.push(
    badgeShown
      ? '05: ⚡ side-effect 徽章已显示'
      : '05: ⚡ side-effect 徽章缺失（bridge 丢弃内核 sideEffect 字段，见遗留 L-2）——弹窗本体照常截图',
  );
  await shoot(page, '05-ask-dialog');

  const mark = bridge.notifications.length;
  await dialog.locator('button:text-is("mark only")').click();
  // d1 本体现在才真正运行（ask 决策在 cell.run 之前 await）
  await bridge.waitNotif('run.done', (p) => p?.cellId === 'd1e2f3a4', 20000, mark);
  ctx.writePage = page; // 交给 06 复用
});

state('06', '06-writes-matplotlib', async (ctx) => {
  const { bridge } = ctx;
  const page = ctx.writePage ?? (await ctx.newPage());
  if (!ctx.writePage) {
    await openNotebook(page, WRITE_PY);
    const r1 = await runCellWs(bridge, 'd1e2f3a4');
    if (!r1.ok) throw new Error('temps 定义格失败: ' + JSON.stringify(r1));
  }

  const r2 = await runCellWs(bridge, 'd5e6f7a8');
  if (!r2.ok) throw new Error('to_csv cell 失败: ' + JSON.stringify(r2));
  const r3 = await runCellWs(bridge, 'd9e0f1a2');
  if (!r3.ok) throw new Error('matplotlib cell 失败: ' + JSON.stringify(r3));

  await page.waitForSelector('section[data-cell-id="d5e6f7a8"] button[aria-expanded]', { timeout: 15000 });
  await expandOutput(page, 'd5e6f7a8');
  await expandOutput(page, 'd9e0f1a2');

  // wrote <绝对路径> 通知行 + inline PNG
  await page.locator('section[data-cell-id="d5e6f7a8"]').getByText('wrote ', { exact: false }).first()
    .waitFor({ timeout: 10000 });
  await page.waitForSelector('section[data-cell-id="d9e0f1a2"] img[alt="cell output"]', { timeout: 20000 });
  await shoot(page, '06-writes-matplotlib');
  await page.close();
});

state('07', '07-repl', async (ctx) => {
  const { bridge } = ctx;
  await closeAllTabs(bridge);
  const page = await ctx.newPage();
  await openNotebook(page, DEMO_PY);

  for (const id of ['a1b2c3d4', 'b2c3d4e5', 'c3d4e5f6']) {
    const rep = await runCellWs(bridge, id);
    if (!rep.ok) throw new Error(`run ${id} 失败: ${JSON.stringify(rep)}`);
  }
  await page.waitForSelector('section[data-cell-id="c3d4e5f6"] span:text-is("[1]")', { timeout: 15000 });
  await expandOutput(page, 'c3d4e5f6');

  // REPL：df.shape 回车 → [repl] cell 出现
  const repl = page.locator('footer input[placeholder^="run code"]');
  await repl.fill('df.shape');
  await repl.press('Enter');
  await page.waitForSelector('section[data-cell-id="repl"]', { timeout: 15000 });
  await page.waitForSelector('section[data-cell-id="repl"] span:text-is("[repl]")', { timeout: 15000 });
  await page.waitForTimeout(800);
  await shoot(page, '07-repl');
  ctx.replPage = page; // 交给 08 复用（同一 live 会话）
});

state('08', '08-readonly-session', async (ctx) => {
  const { bridge } = ctx;
  const page = ctx.replPage ?? (await ctx.newPage());
  if (!ctx.replPage) await openNotebook(page, DEMO_PY);

  // kernel.restart = 当前会话 ended + 新会话开启（广播 session.ended/started）
  await bridge.rpc('kernel.restart');
  await page.waitForTimeout(1000);

  // 左 pill 下拉 → 选刚 ended 的会话
  await page.locator('button[title="session switcher — 当前与历史会话"]').click();
  const endedEntry = page.locator('button:has(span:text-is("read-only"))').first();
  await endedEntry.waitFor({ timeout: 10000 });
  await endedEntry.click();

  // 只读视图：footer 原文 + 左 pill read-only 徽章 + 编辑器只读
  await page
    .locator('footer span:has-text("view only; this kernel\'s namespace no longer exists")')
    .waitFor({ timeout: 15000 });
  await page.waitForSelector('header button[title^="session switcher"] span:text-is("read-only")', {
    timeout: 10000,
  });
  await page.waitForSelector('section[data-cell-id="a1b2c3d4"] .cm-content[contenteditable="false"]', {
    timeout: 15000,
  });
  await page.waitForSelector('footer input[placeholder^="view only"]', { timeout: 10000 });
  await shoot(page, '08-readonly-session');
  await page.close();
});

state('09', '09-sidebar-actions', async (ctx) => {
  await closeAllTabs(ctx.bridge);
  const page = await ctx.newPage();
  await openNotebook(page, DEMO_PY);
  // A-3 #23：文件操作在全幅 Files 视图（顶栏分段控件切入；rail sidebar 已移除）
  await page.locator('button[title="Files 视图"]').click();
  await page.waitForSelector('[role="tree"][aria-label="workspace files"] [role="treeitem"]', {
    timeout: 15000,
  });

  // 文件树内新建 notebook（面板头 ＋◈ → 行内 prompt → Enter）
  await page.locator('button[title="新建 notebook（marimo 头模板）"]').click();
  const input = page.locator('input[aria-label="new-notebook"]');
  await input.waitFor({ timeout: 5000 });
  await input.fill('gallery-created.py');
  await input.press('Enter');
  await page.waitForSelector('[role="treeitem"]:has-text("gallery-created.py")', { timeout: 10000 });
  await page.waitForTimeout(400);
  // 面包屑（root 路径分段）同框可见
  await page.locator('main >> text=demos').first().waitFor({ timeout: 5000 }).catch(() => {});
  await shoot(page, '09-sidebar-actions');
  await page.close();
});

state('10', '10-settings', async (ctx) => {
  await closeAllTabs(ctx.bridge);
  const page = await ctx.newPage();
  await openNotebook(page, DEMO_PY);
  await page.locator('button[title="设置（provider 管理）"]').click();
  await page.waitForSelector('h2:text-is("设置 · LLM Provider")', { timeout: 10000 });
  // 存储说明原文（providers.ts STORAGE_WARNING，keychain 迁移后为加密落盘陈述）
  await page.getByText('keys encrypted at rest', { exact: false }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(300);
  await shoot(page, '10-settings');
  await page.close();
});

/* ---------------- P3 新状态（12–15） ---------------- */

state('12', '12-multi-tab', async (ctx) => {
  const { bridge } = ctx;
  await closeAllTabs(bridge);
  const page = await ctx.newPage();
  await openNotebook(page, DEMO_PY);
  await waitTabs(page, 1);

  // 第二个 tab：TabBar + → 路径输入 → notebook.open（demo.py 内核不杀，并行保活）
  await addTab(page, WRITE_PY);
  await waitTabs(page, 2);
  // 每 tab 一枚内核状态点（●，idle 绿）
  const dots = page.locator('[role="tab"] span[aria-hidden="true"]:text-is("●")');
  if ((await dots.count()) < 2) throw new Error('TabBar 内核状态点缺失（<2 枚 ●）');

  // 切到第二 tab → notebook.switch 回灌全量 state → 渲染其 cells
  await page.locator('[role="tab"]:has-text("gallery-write.py")').click();
  await page.waitForSelector('[role="tab"][aria-selected="true"]:has-text("gallery-write.py")', {
    timeout: 30000,
  });
  await page.waitForSelector('section[data-cell-id="d1e2f3a4"] .cm-editor', { timeout: 30000 });
  await page.waitForSelector('section[data-cell-id="d9e0f1a2"] .cm-editor', { timeout: 15000 });
  await shoot(page, '12-multi-tab');
  await page.close();
});

state('13', '13-inspector', async (ctx) => {
  const { bridge } = ctx;
  // 不清 tab：demo.py 若已从 12 态保活则直接聚焦复用（TabBar 双 tab 同框无碍）
  const page = await ctx.newPage();
  await openNotebook(page, DEMO_PY);

  // 跑首两格 → df/total 入命名空间；run.done 后 bridge 自动 introspect →
  // kernel.schemas 广播 → store.schemas（M 线 L-3 通道）
  for (const id of ['a1b2c3d4', 'b2c3d4e5']) {
    const rep = await runCellWs(bridge, id);
    if (!rep.ok) throw new Error(`run ${id} 失败: ${JSON.stringify(rep)}`);
  }
  await page.waitForSelector('section[data-cell-id="b2c3d4e5"] span:text-is("[1]")', { timeout: 15000 });

  // 双击状态栏 ⠿ 把手 → inspector 抽屉展开
  await openInspectorViaHandle(page);
  // 表格含 df / total 行（type/shape/preview 列有实义内容）
  const dfRow = page.locator('[data-testid="inspector-row-df"]');
  await dfRow.waitFor({ timeout: 15000 });
  await page.waitForSelector('[data-testid="inspector-row-total"]', { timeout: 10000 });
  const dfText = (await dfRow.textContent()) ?? '';
  if (!/DataFrame/.test(dfText)) throw new Error('inspector df 行缺 type/shape/preview: ' + dfText);
  const totalText = (await page.locator('[data-testid="inspector-row-total"]').textContent()) ?? '';
  if (!/Series|total/.test(totalText)) throw new Error('inspector total 行内容异常: ' + totalText);
  await shoot(page, '13-inspector');
  await page.close();
});

state('14', '14-controls', async (ctx) => {
  const { bridge } = ctx;
  await closeAllTabs(bridge);
  const page = await ctx.newPage();
  await openNotebook(page, CONTROLS_PY);

  // 运行两格：控件定义格（run.mime control 载荷）+ 下游计算格
  const r1 = await runCellWs(bridge, 'f1a2b3c4');
  if (!r1.ok) throw new Error('控件定义格失败: ' + JSON.stringify(r1));
  const r2 = await runCellWs(bridge, 'f5e6f7a8');
  if (!r2.ok) throw new Error('下游计算格失败: ' + JSON.stringify(r2));
  await page.waitForSelector('section[data-cell-id="f1a2b3c4"] button[aria-expanded]', { timeout: 15000 });
  await expandOutput(page, 'f1a2b3c4');
  await expandOutput(page, 'f5e6f7a8');

  // 控件渲染态：slider(阈值, 42) + checkbox(normalize, 勾选) + 下游 stdout
  const slider = page.locator('input[type="range"][aria-label="阈值"]');
  await slider.waitFor({ timeout: 15000 });
  if ((await slider.inputValue()) !== '42') {
    throw new Error('slider 初值应为 42，实际 ' + (await slider.inputValue()));
  }
  const checkbox = page.locator('input[type="checkbox"][aria-label="normalize"]');
  await checkbox.waitFor({ timeout: 10000 });
  if (!(await checkbox.isChecked())) throw new Error('checkbox 初值应为勾选');
  await page.waitForSelector('section[data-cell-id="f5e6f7a8"] pre:has-text("threshold=42")', {
    timeout: 15000,
  });
  await shoot(page, '14-controls');

  // UI 事件设 slider=77 → control.set（80ms 节流）→ 内核 mutate + 级联重跑下游
  await setRangeValue(slider, 77);
  await page.waitForSelector('section[data-cell-id="f5e6f7a8"] pre:has-text("threshold=77")', {
    timeout: 25000,
  });
  // 无 stale 残留：旧输出已替换、两格均无 stale 徽章
  const staleLeft = await page.locator('section[data-cell-id="f5e6f7a8"] pre:has-text("threshold=42")').count();
  if (staleLeft > 0) throw new Error('级联后旧输出 threshold=42 残留');
  for (const id of ['f1a2b3c4', 'f5e6f7a8']) {
    const stale = await page.locator(`section[data-cell-id="${id}"] span:text-is("stale")`).count();
    if (stale > 0) throw new Error(`级联后 ${id} 仍有 stale 徽章`);
  }
  await shoot(page, '14b-controls-cascade');
  await page.close();
});

state('15', '15-session-modal', async (ctx) => {
  const { bridge } = ctx;
  await closeAllTabs(bridge);
  const page = await ctx.newPage();
  await openNotebook(page, DEMO_PY);
  // live 会话带 cells/outputs（导出走富缓存）
  for (const id of ['a1b2c3d4', 'b2c3d4e5', 'c3d4e5f6']) {
    const rep = await runCellWs(bridge, id);
    if (!rep.ok) throw new Error(`run ${id} 失败: ${JSON.stringify(rep)}`);
  }
  await page.waitForSelector('section[data-cell-id="c3d4e5f6"] span:text-is("[1]")', { timeout: 15000 });

  // SessionBar「⧉ Sessions」入口 → SessionModal
  await page.locator('button[title^="Session notebook —"]').click();
  const dialog = page.locator('[role="dialog"][aria-label="Session notebook"]');
  await dialog.waitFor({ timeout: 10000 });
  const headers = dialog.locator('section button[aria-expanded]');
  await headers.first().waitFor({ timeout: 15000 });

  // 展开一个 ended（只读）会话段 → 只读 cell 精简行（找不到 ended 段则退回首段）
  const nSeg = await headers.count();
  let expandedIdx = -1;
  for (let i = 0; i < nSeg; i++) {
    const h = headers.nth(i);
    if ((await h.locator('span:text-is("live")').count()) > 0) continue;
    await h.click();
    const sec = dialog.locator('section').nth(i);
    await sec.locator('div.border-t').first().waitFor({ timeout: 10000 }).catch(() => {});
    expandedIdx = i;
    break;
  }
  if (expandedIdx < 0) {
    await headers.first().click();
    ctx.notes.push('15: 无 ended 会话段可展开（首段代替）——分组头证据仍有效');
  }
  await page.waitForTimeout(600); // 快照行渲染稳定
  await shoot(page, '15-session-modal');
  // A-4 浅色证据：模态遮罩挡住 header toggle 钮 → DOM 直达主题（拍完即回暗色）
  await setTheme(page, 'light');
  await shoot(page, '15-session-modal-light');
  await setTheme(page, 'dark');

  // footer「.ipynb」导出 → 断言 .novalab/sessions/*.ipynb 落盘（node 侧 fs）
  const status = dialog.locator('footer p[aria-live="polite"]');
  await dialog.locator('footer button:text-is(".ipynb")').click();
  await status
    .filter({ hasText: '已导出' })
    .waitFor({ timeout: 20000 })
    .catch(async () => {
      const txt = (await status.textContent().catch(() => '')) ?? '';
      throw new Error('export.ipynb 未成功，footer 状态: ' + txt);
    });
  const msg = (await status.textContent()) ?? '';
  const m = msg.match(/已导出 (.+?)（(\d+) cells · (\d+) outputs）/);
  if (!m) throw new Error('导出消息格式异常: ' + msg);
  const ipynbPath = m[1];
  if (!fs.existsSync(ipynbPath)) throw new Error('导出 .ipynb 未落盘: ' + ipynbPath);
  if (!ipynbPath.includes(path.join('.novalab', 'sessions'))) {
    throw new Error('导出路径不在 .novalab/sessions: ' + ipynbPath);
  }
  ctx.notes.push(`15: export.ipynb 落盘 ${path.relative(root, ipynbPath)}（${m[2]} cells · ${m[3]} outputs）`);

  // import 回转：同一 .ipynb → 生成 .py（wx 排他）→ 前端自动 openNotebook 新 tab
  await dialog.locator('input[aria-label="import .ipynb 路径"]').fill(ipynbPath);
  await dialog.locator('button:text-is("import .ipynb")').click();
  const pyPath = ipynbPath.replace(/\.ipynb$/, '.py');
  const t0 = Date.now();
  for (;;) {
    if (fs.existsSync(pyPath)) break;
    if (Date.now() - t0 > 20000) throw new Error('import 回转 .py 未落盘: ' + pyPath);
    await new Promise((r) => setTimeout(r, 300));
  }
  const base = pyPath.split(/[\\/]/).pop();
  await page.locator(`[role="tab"]:has-text("${base}")`).waitFor({ timeout: 60000 });

  // 关模态 → 新 tab（选中态）+ 导入 notebook 的 cells 同框 = 15b 证据
  await dialog.locator('button[aria-label="关闭"]').click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  await page.waitForSelector(`[role="tab"][aria-selected="true"]:has-text("${base}")`, { timeout: 15000 });
  await page.waitForSelector('section[data-cell-id] .cm-editor', { timeout: 40000 });
  await page.waitForTimeout(600);
  await shoot(page, '15b-import-done');
  ctx.notes.push(`15b: import.ipynb 回转 ${path.relative(root, pyPath)}（新 tab 打开）`);
  await page.close();
});

/** 并发孪生检测：他线 chromium（跑本共享脚本）= bridge/notebook 上下文必互搅。 */
function chromiumCount() {
  try {
    const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq chromium.exe', '/NH'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return String(out.stdout ?? '')
      .split('\n')
      .filter((l) => l.includes('chromium.exe')).length;
  } catch {
    return 0;
  }
}

/* ---------------- 主流程 ---------------- */

async function main() {
  fs.mkdirSync(STATES_DIR, { recursive: true });
  // 清掉上次运行的失败诊断图（幂等）
  for (const f of fs.readdirSync(STATES_DIR)) {
    if (f.startsWith('fail-')) fs.rmSync(join(STATES_DIR, f));
  }

  // 夹具每次重写
  fs.writeFileSync(ERROR_PY, ERROR_FIXTURE);
  fs.writeFileSync(WRITE_PY, WRITE_FIXTURE);
  fs.writeFileSync(CONTROLS_PY, CONTROLS_FIXTURE);
  // 09 态新建的 notebook：fs.writeFile 不覆盖已存在文件（EXIST），
  // 每次运行前删掉自己的 gallery-created.py 保证真"新建"且截图无报错。
  fs.rmSync(join(DEMOS, 'gallery-created.py'), { force: true });
  const demoOriginal = fs.readFileSync(DEMO_PY, 'utf8');

  // dev 服务：已在跑就复用；没跑就自起（退出前自停，见 killStartedServers）
  const bridgeState = await probePortState(7788);
  if (bridgeState === 'up') {
    log('bridge 已在跑（:7788）→ 复用');
  } else if (bridgeState === 'hung') {
    throw new Error(':7788 被失响应残留占住（TCP hang）——bridge 无法换端口（app 硬编码 ws://127.0.0.1:7788），请等残留退出或人工清理后重跑');
  } else {
    log('bridge 未跑 → 自起 pnpm dev:bridge');
    startDev('dev:bridge');
  }
  // app：只认真 HTTP 200 才复用 :5199（半死监听器/跨线 vite 反复启停让 TCP 状态
  // 不可信）；否则一律备用端口 5299 自起，彻底避开 strictPort 互斥竞态
  const appHttp = await probeHttp(`http://127.0.0.1:${APP_PORT_DEFAULT}/`);
  if (appHttp) {
    log(`app 已在跑（:${APP_PORT_DEFAULT}，HTTP 200）→ 复用`);
  } else {
    APP_PORT = await pickFreeAppPort();
    APP_URL = `http://localhost:${APP_PORT}/`;
    log(`:${APP_PORT_DEFAULT} 无健康 HTTP 服务 → vite 自起于 :${APP_PORT}（pid 抖动空闲端口）`);
    startDevAppOn(APP_PORT);
  }
  await waitForHttp(APP_URL);
  log('vite HTTP 200', APP_URL);

  const bridge = new BridgeClient(BRIDGE_URL);
  await bridge.connect();
  await bridge.rpc('ping');
  log('bridge 已连接', BRIDGE_URL);

  // 并发孪生（他线跑本共享脚本）时 bridge 单实例必互搅（closeAllTabs/kernel.restart
  // 跨 run 生效）——最多等 10min 让其跑完再起跑
  let twinWait = 0;
  while (chromiumCount() > 0 && twinWait < 600000) {
    if (twinWait === 0) log('检测到并发 chromium（他线画廊）——最多等 10min 避互搅');
    await new Promise((r) => setTimeout(r, 20000));
    twinWait += 20000;
  }
  if (twinWait > 0) log(`并发等待结束（${Math.round(twinWait / 1000)}s），起跑`);

  // 起跑线卫生：关掉遗留上下文 + 清 stale-live 索引（见 reconcileStaleSessions 注释）
  await closeAllTabs(bridge);
  reconcileStaleSessions(DEMOS);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    deviceScaleFactor: 1,
  });
  context.setDefaultTimeout(20000);

  const consoleErrors = [];
  const ctx = {
    bridge,
    context,
    demoOriginal,
    notes: [],
    newPage: async () => {
      const page = await context.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
      });
      return page;
    },
  };

  const results = [];
  for (const st of states) {
    if (ONLY.length > 0 && !ONLY.some((f) => st.id === f || st.name.includes(f))) continue;
    try {
      await st.fn(ctx);
      results.push({ ...st, ok: true });
      log(`✔ ${st.name}`);
    } catch (err) {
      results.push({ ...st, ok: false, err: err.message, degrade: !!err.degrade });
      log(`✘ ${st.name}: ${err.message}`);
      // 失败诊断图（best effort）；降级态已在自身流程里拍了稳定命名的证据图
      if (!err.degrade) {
        try {
          const pages = context.pages();
          if (pages.length > 0) {
            await pages[pages.length - 1].screenshot({
              path: join(STATES_DIR, `fail-${st.name}.png`),
              fullPage: true,
            });
          }
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  /* ---- 清理 ---- */
  // 03/11 遗留页面
  try {
    if (ctx.errorPage) await ctx.errorPage.close();
  } catch { /* 忽略 */ }
  // 拒绝所有仍 pending 的 diff（11 态 propose_code_change 可能留下）
  try {
    const lastUpdate = [...bridge.notifications].reverse().find((n) => n.method === 'diff.updated');
    for (const d of lastUpdate?.params?.diffs ?? []) {
      if (d.status === 'proposed') await bridge.rpc('diff.reject', { diffId: d.diffId }).catch(() => {});
    }
  } catch { /* 忽略 */ }
  // 关掉本脚本打开的全部 notebook：会话正规 ended，index.json 不留 stale-live
  // （自起 bridge 随后被 taskkill 硬杀也不产生残留）。必须先于 demo.py 兜底
  // 还原：notebook.close 的 persistToDisk 会让内核 save_file 重写 .py。
  try {
    await closeAllTabs(bridge);
  } catch { /* 忽略 */ }
  // demo.py 字节级兜底还原（02 已经 UI 还原，这里防御中途失败）
  try {
    if (fs.readFileSync(DEMO_PY, 'utf8') !== demoOriginal) {
      fs.writeFileSync(DEMO_PY, demoOriginal);
      log('demo.py 已按启动快照兜底还原');
    }
  } catch { /* 忽略 */ }

  await context.close();
  await browser.close();
  bridge.close();

  /* ---- 清单 ---- */
  const pngs = fs.readdirSync(STATES_DIR).filter((f) => f.endsWith('.png') && !f.startsWith('fail-')).sort();
  const okCount = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok && !r.optional);
  const degraded = results.filter((r) => !r.ok && r.optional);
  console.log('\n==== 画廊清单 ====');
  for (const f of pngs) console.log(`docs/demos/states/${f}`);
  console.log(`\nstates ok=${okCount}/${results.length}`,
    failed.length ? `FAILED: ${failed.map((r) => r.name).join(', ')}` : '',
    degraded.length ? `degraded-skip: ${degraded.map((r) => `${r.name}(${r.err})`).join('; ')}` : '');
  if (ctx.notes.length > 0) {
    console.log('\n==== 运行备注 ====');
    for (const n of ctx.notes) console.log('- ' + n);
  }
  if (consoleErrors.length > 0) {
    const uniq = [...new Set(consoleErrors)].slice(0, 12);
    console.log('\n==== 页面 console 错误（去重前 12 条，供遗留 bug 记录） ====');
    for (const e of uniq) console.log('- ' + e);
  }
  killStartedServers();
  process.exit(failed.length > 0 ? 1 : 0);
}

// 自起服务的兜底回收：正常结束 / 致命错误 / Ctrl-C / 进程退出
process.on('exit', killStartedServers);
process.on('SIGINT', () => {
  killStartedServers();
  process.exit(130);
});

state('16', '16-showcase-operon', async (ctx) => {
  const { bridge } = ctx;
  await closeAllTabs(bridge);
  const page = await ctx.newPage();
  const BUNDLE = join(root, 'demos', 'operon-bundle', 'bounded_confidence.py');
  await openNotebook(page, BUNDLE);
  // 依次跑到 fig1 保存格（imports → shim → 样式 → quick sweep → eps sweep →
  // topo/finite sweep → scaling prints → fit/traj → fig1；curated 单赋值版）
  const seq = ['a1b2c301', 'a1b2c302', 'a1b2c303', 'a1b2c304', 'a1b2c305', 'a1b2c306', 'a1b2c307', 'a1b2c308', 'a1b2c309'];
  for (const id of seq) {
    const rep = await runCellWs(bridge, id);
    if (!rep.ok) throw new Error(`operon run ${id} 失败: ${JSON.stringify(rep).slice(0, 300)}`);
  }
  await expandOutput(page, 'a1b2c309');
  await page.waitForTimeout(800);
  await shoot(page, '16-showcase-operon');
  await page.close();
});

main().catch((err) => {
  console.error('GALLERY_FATAL:', err);
  killStartedServers();
  process.exit(2);
});
