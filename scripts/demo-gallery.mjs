/**
 * L 线：交互状态画廊 —— 真机证据截图（docs/demos/states/*.png）。
 *
 * 用法（仓库根，需先起服务）：
 *   pnpm dev:bridge   # ws://127.0.0.1:7788
 *   pnpm dev:app      # http://localhost:5199 (strictPort)
 *   node scripts/demo-gallery.mjs [--skip-agent] [状态前缀过滤，如 03 11]
 *
 * 产出：每态一张 fullPage png（暗色、viewport 1440x900；主列为内部滚动，
 * 内容溢出时临时增高视口拍全后还原——fullPage 对本布局才有意义）。
 *
 * 幂等性：
 * - demos/gallery-*.py 夹具每次运行重写；
 * - demos/demo.py 的任何编辑（02 态 0.9↔1.9 toggle，与 integration-smoke 同款）
 *   先经 UI cell.save 还原、脚本结束再按启动时快照字节级兜底还原；
 * - demos/.novalab 残留（sessions/ui.json）容忍，不清理；
 * - 09 态新建的 demos/gallery-created.py 允许存在（fs.writeFile 覆盖写）。
 *
 * 前置校验：bridge ping + vite HTTP 200，任一不就绪立即退出并提示。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'bridge', 'package.json'));
const { WebSocket } = require('ws');

const DEMOS = join(root, 'demos');
const STATES_DIR = join(root, 'docs', 'demos', 'states');
const APP_URL = 'http://localhost:5199/';
const BRIDGE_URL = 'ws://127.0.0.1:7788';

const DEMO_PY = join(DEMOS, 'demo.py');
const ERROR_PY = join(DEMOS, 'gallery-error.py');
const WRITE_PY = join(DEMOS, 'gallery-write.py');

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
          n > 20 ? reject(new Error('bridge 未就绪: ' + this.url)) : setTimeout(() => tryConnect(n + 1), 500),
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
  await page.goto(APP_URL + '?path=' + encodeURIComponent(file), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('section[data-cell-id]', { timeout: 40000 });
  const banner = page.locator('text=bridge 未连接');
  if (await banner.count()) throw new Error('前端降级横幅出现：bridge 未连接');
}

/** 主列内部滚动 → 溢出时临时增高视口，fullPage 拍全后还原 1440x900。 */
async function shoot(page, name) {
  const scroller = page.locator('main .flex-1.overflow-y-auto');
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

/* ---------------- 状态实现 ---------------- */

const states = [];
function state(id, name, fn, opts = {}) {
  states.push({ id, name, fn, optional: opts.optional ?? false, keepsPage: opts.keepsPage ?? false });
}

state('01', '01-open-idle', async (ctx) => {
  const page = await ctx.newPage();
  await openNotebook(page, DEMO_PY);
  // sidebar 文件树可见（root = demos/）
  await page.waitForSelector('[role="tree"][aria-label="workspace files"] [role="treeitem"]', {
    timeout: 15000,
  });
  await page.waitForSelector('section[data-cell-id="a1b2c3d4"] .cm-editor', { timeout: 15000 });
  await shoot(page, '01-open-idle');
  await page.close();
});

state('02', '02-stale', async (ctx) => {
  const { bridge } = ctx;
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
  const page = await ctx.newPage();
  await openNotebook(page, DEMO_PY);
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
  await page.waitForSelector('nav + div >> text=demos', { timeout: 5000 }).catch(() => {});
  await shoot(page, '09-sidebar-actions');
  await page.close();
});

state('10', '10-settings', async (ctx) => {
  const page = await ctx.newPage();
  await openNotebook(page, DEMO_PY);
  await page.locator('button[title="设置（provider 管理）"]').click();
  await page.waitForSelector('h2:text-is("设置 · LLM Provider")', { timeout: 10000 });
  // 明文存储警告（STORAGE_WARNING 原文关键句）+ provider 列表/dev 兜底行
  await page.getByText('明文仅存于本机浏览器 localStorage').waitFor({ timeout: 10000 });
  await page.waitForTimeout(300);
  await shoot(page, '10-settings');
  await page.close();
});

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
  // 09 态新建的 notebook：fs.writeFile 不覆盖已存在文件（EXIST），
  // 每次运行前删掉自己的 gallery-created.py 保证真"新建"且截图无报错。
  fs.rmSync(join(DEMOS, 'gallery-created.py'), { force: true });
  const demoOriginal = fs.readFileSync(DEMO_PY, 'utf8');

  const bridge = new BridgeClient(BRIDGE_URL);
  await bridge.connect();
  await bridge.rpc('ping');
  log('bridge 已连接', BRIDGE_URL);

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
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('GALLERY_FATAL:', err);
  process.exit(2);
});
